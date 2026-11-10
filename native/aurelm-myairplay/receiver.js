'use strict';
/**
 * receiver.js - the AirPlay receiver, stage 1: uxplay-mgu (native/uxplay-mgu: UxPlay's protocol, its model
 * and version as iOS 27 wants them to mirror during CarPlay, a renderer that only counts), run by the
 * service while a receiver test is on.
 *
 * It runs as nobody (uid 65534) with the service's limits (no core dump, its cgroup), announces itself
 * on the one IPv4 address it is given (UXPLAY_MDNS_IPV4) and listens on tcp and udp 7300-7302. Its
 * renderer reports on stdout as "MGU {json}" lines (renderer/mgu_renderer.c); every other line is kept
 * in a short log. A receiver that exits is started again at most 3 times in a test.
 *
 * Plain Node 8.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const BASE_PORT = 7300;
// stage 2: the frame file the receiver's GPU decoder writes and the app shows (mgu-render takes it: owned by nobody)
const VIDEO_PATH = '/dev/shm/mgu-video-aurelm-myairplay';
const VIDEO_SIZE = '1920x720';
// stage 3: SmartXbar's input for CarLife (unused in Europe), which Moonride plays into; plug converts 44.1 to 48 kHz
const AUDIO_DEVICE = 'plug:smartx:CarLifeMedia_CF_48_STEREO';
const RX_GROUPS = ['video', 'mgu_alsa'];
// stage 4: a video the iPhone hands over (AirPlay's video button), played by the receiver's own player. Its variants
// limited to H.264 (the GPU's), 720p (the screen is 720 high; 1080p through a hotspot stalled: UxPlay's -custom filter
// on YouTube's master playlist)
const HLS_PROFILE = 'AVC:720,720;HEVC:0;VP9:0;AV1:0';
// UxPlay keeps the audio track of this language, or else the one the iPhone's playlist marks default: a code that
// matches no track (zxx: no linguistic content) leaves the choice to the phone (YouTube's own). UxPlay needs one set.
const HLS_LANGUAGE = 'zxx';
// the identity the receiver presents (uxplay-mgu reads MGU_MODEL / MGU_SRCVERS): AppleTV5,4 / 366.0, with which iOS 27
// mirrors during CarPlay (the default), or UxPlay's own AppleTV3,2 / 220.68, the one its AirPlay video support was
// made with (YouTube's video button worked so on a Mac, 2026-11-08)
const IDENTITIES = { carplay: { model: 'AppleTV5,4', srcvers: '366.0' }, classic: { model: 'AppleTV3,2', srcvers: '220.68' } };

/** CPU seconds a process has used (utime + stime, /proc/<pid>/stat), or null */
function cpuSeconds(pid) {
    try {
        const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
        return (Number(f[11]) + Number(f[12])) / 100;   // clock ticks (USER_HZ 100)
    } catch (e) { return null; }
}
/** how often this service's cgroup was held back by its CPU quota (cgroup v1 cpu.stat nr_throttled), or null */
function throttled() {
    try {
        const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => /:cpu[,:]|:cpuacct,cpu:|:cpu,cpuacct:/.test(l));
        if (!line) return null;
        const rel = line.split(':')[2];
        const dirs = ['/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpuacct,cpu'];
        for (let i = 0; i < dirs.length; i++) {
            try {
                const t = fs.readFileSync(dirs[i] + rel + '/cpu.stat', 'utf8').match(/nr_throttled (\d+)/);
                if (t) return Number(t[1]);
            } catch (e) { /* next */ }
        }
    } catch (e) { /* none */ }
    return null;
}

/** the gid of `group` (/etc/group), or null */
function groupGid(group) {
    try {
        const l = fs.readFileSync('/etc/group', 'utf8').split('\n').find((x) => x.split(':')[0] === group);
        return l ? Number(l.split(':')[2]) : null;
    } catch (e) { return null; }
}
const PORTS = [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2];   // uxplay -p 7300: tcp and udp 7300, 7301, 7302
const MAX_RESTARTS = 3;
// lines not worth keeping: UxPlay logs these every second while a client is quiet
// and the connection bookkeeping (each connection's accept, addresses, close): the requests and errors stay visible
const NOISE = /seconds since last client feedback|^\s*$|httpd didn't get response|url = \/feedback,|^Accepted IPv4 client|^Local\s*:|^Remote\s*:|^Connection closed on socket|upgraded to PTTH|getProperty\?playback(Access|Error)Log/;

function freshState() {
    return {
        running: false, pid: null, starts: 0, exit: null, error: null, ip: null, iface: null,
        client: null, video: null, videoRunning: false, audio: null, decoder: null, sound: null, soundRunning: false, cpu: null, hls: null,
        stream: { frames: 0, fps: 0, kbps: 0, idr: 0, sps: 0, audio: 0, shown: 0, decerr: 0, adec: 0, alate: 0, afull: 0, aerr: 0, axrun: 0, adev: -1, at: 0 },
        lines: [],
    };
}

/**
 * opts: { bin, uid (65534; null: this process's), gid (65534; the group video when there is one), home, env (more), videoPath, log, now, onChange }
 * start({ name, deviceid, ip, iface }) / stop() / state()
 */
function createReceiver(opts) {
    const o = Object.assign({ uid: 65534, gid: 65534 }, opts || {});
    const now = o.now || Date.now;
    let st = freshState(), child = null, want = null, stopping = false;

    function keep(line) {
        if (NOISE.test(line)) return;
        // each request of the iPhone, short: "iPhone: POST /play"
        const rq = /httpd request received on socket \d+, connection \d+, method = (\S+), url = (\S+)/.exec(line);
        if (rq) line = 'iPhone: ' + rq[1] + ' ' + rq[2].replace(/^rtsp:\/\/[^/]+/, '').slice(0, 80);
        st.lines.push(new Date(now()).toISOString().slice(11, 19) + ' ' + line.slice(0, 200));
        if (st.lines.length > 80) st.lines.shift();
    }

    /** one "MGU {json}" line from the renderer */
    function event(j) {
        switch (j.ev) {
        case 'client':
            st.client = { model: j.model, name: j.name, at: now() };
            if (o.log) o.log('receiver: ' + (j.name || '?') + ' (' + (j.model || '?') + ') connected');
            break;
        case 'video':
            st.video = { codec: j.codec, w: j.w, h: j.h, sw: j.sw, sh: j.sh, at: now() };
            if (o.log) o.log('receiver: video ' + j.codec + ' ' + j.w + 'x' + j.h);
            break;
        case 'start': st.videoRunning = true; break;
        case 'stop':
            st.videoRunning = false;
            st.stream.fps = 0; st.stream.kbps = 0;
            if (o.log) o.log('receiver: video stopped after ' + (j.frames || 0) + ' frames');
            break;
        case 'audio':
            st.audio = { ct: j.ct, at: now() };
            if (o.log) o.log('receiver: audio stream (type ' + j.ct + ')');
            break;
        case 'stats':
            sampleCpu();
            st.stream = { frames: j.frames, fps: j.fps, kbps: j.kbps, idr: j.idr, sps: j.sps, audio: j.audio, shown: j.shown || 0, decerr: j.decerr || 0,
                adec: j.adec || 0, alate: j.alate || 0, afull: j.afull || 0, aerr: j.aerr || 0, axrun: j.axrun || 0, adev: j.adev != null ? j.adev : -1, at: now() };
            break;
        case 'sound':
            st.sound = j.ok ? { ok: true, device: j.device, ct: j.ct, at: now() } : { ok: false, error: j.error, ct: j.ct, at: now() };
            st.soundRunning = !!j.ok;
            if (o.log) o.log('receiver: sound ' + (j.ok ? 'into ' + j.device + ' (type ' + j.ct + ')' : 'failed: ' + j.error));
            break;
        case 'decoder':
            st.decoder = j.ok ? { ok: true, path: j.path, w: j.w, h: j.h, at: now() } : { ok: false, error: j.error, at: now() };
            if (o.log) o.log('receiver: GPU decoder ' + (j.ok ? 'open, ' + j.w + 'x' + j.h + ' into ' + j.path : 'failed: ' + j.error));
            break;
        case 'hls':
            st.hls = { url: j.url, start: j.start || 0, at: now(), open: null, pos: j.start || 0, dur: 0, paused: false, buffering: false, ended: null, seeks: 0 };
            if (o.log) o.log('receiver: video from the iPhone: ' + j.url + (j.start ? ' from ' + Math.round(j.start) + ' s' : ''));
            break;
        case 'hlsopen':
            if (st.hls) st.hls.open = { w: j.w, h: j.h, vcodec: j.vcodec, acodec: j.acodec, rate: j.rate, ch: j.ch, variants: j.variants, format: j.format };
            if (st.hls) st.hls.dur = j.dur || 0;
            if (o.log) o.log('receiver: video ' + (j.vcodec || 'no picture') + (j.w ? ' ' + j.w + 'x' + j.h : '') + ', sound ' + (j.acodec || 'none') + (j.rate ? ' ' + j.rate + ' Hz' : '') + ', ' + Math.round(j.dur || 0) + ' s');
            break;
        case 'hlspos':
            if (st.hls) Object.assign(st.hls, { pos: j.pos, dur: j.dur || st.hls.dur, paused: !!j.paused, buffering: !!j.buffering, stalls: j.stalls || 0 });
            return;   // each second: no onChange
        case 'hlsseek':
            if (st.hls) st.hls.seeks++;
            if (o.log) o.log('receiver: seek to ' + Math.round(j.to) + ' s' + (j.ok ? '' : ' failed'));
            break;
        case 'hlsend':
            if (st.hls) st.hls.ended = { why: j.why, error: j.error || null, at: now() };
            if (o.log) o.log('receiver: video ' + (j.why === 'end' ? 'ended' : j.why === 'stopped' ? 'stopped' : 'failed: ' + j.error));
            break;
        case 'soundstop':
            // the iPhone's session is over (its last connection closed), stopped from the phone or not
            st.soundRunning = false;
            if (o.log) o.log('receiver: the iPhone ended the session');
            break;
        default: break;
        }
        if (o.onChange) o.onChange();
    }

    // the receiver's CPU use (% of one core) and the quota's throttling since it started, sampled with its stats
    let cpuPrev = null;
    function sampleCpu() {
        if (!st.pid) return;
        const c = cpuSeconds(st.pid), t = now();
        if (c !== null && cpuPrev) {
            const dt = (t - cpuPrev.t) / 1000;
            if (dt >= 0.5) { st.cpu = { pct: Math.round((c - cpuPrev.c) / dt * 100), throttled: throttled(), at: t }; cpuPrev = { c, t }; }
        } else if (c !== null) cpuPrev = { c, t };
    }

    function lines(stream, fn) {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (d) => {
            buf += d;
            if (buf.length > 65536) buf = buf.slice(-65536);
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { fn(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
        });
    }

    function onLine(line) {
        if (line.indexOf('MGU ') === 0) {
            try { event(JSON.parse(line.slice(4))); } catch (e) { keep(line); }
            return;
        }
        keep(line);
    }

    function spawn() {
        const w = want;
        if (!w) return;
        if (!fs.existsSync(o.bin)) { st.error = 'receiver binary missing: ' + o.bin; if (o.log) o.log(st.error); return; }
        const home = o.home || '/tmp';
        try { fs.mkdirSync(home); } catch (e) { /* there */ }
        try { fs.chownSync(home, o.uid, o.gid); } catch (e) { /* not root (tests) */ }
        // LANGUAGE: UxPlay aborts without a language when it takes videos (-hls); set always
        const env = Object.assign({ HOME: home, PATH: '/usr/bin:/bin', LANGUAGE: HLS_LANGUAGE, UXPLAY_MDNS_IPV4: w.ip, UXPLAY_MDNS_NO_IPV6: '1',
            MGU_VIDEO_PATH: o.videoPath || VIDEO_PATH, MGU_VIDEO_SIZE: VIDEO_SIZE,
            // stage 3: the sound into SmartXbar's CarLife input (Moonride's), the app routes it to the speakers
            MGU_AUDIO: 'alsa:' + AUDIO_DEVICE, MGU_ALSA_US: '64000' }, o.env || {});
        // -s: the size the iPhone mirrors for, the centre screen's (landscape fills it; portrait has bars either side)
        const args = ['-n', w.name, '-nh', '-p', String(BASE_PORT), '-m', w.deviceid.toLowerCase(), '-s', '1920x720@60'];
        // stage 4: AirPlay's video button too (the iPhone hands over the video's address; YouTube's HLS); its segments
        // come through the service's proxy (the uid mgu-uplink routes), TLS checked against the tool's CA list
        const ident = IDENTITIES[w.identity] || IDENTITIES.carplay;
        env.MGU_MODEL = ident.model;
        env.MGU_SRCVERS = ident.srcvers;
        if (w.hls) {
            args.push('-hls', '-custom', HLS_PROFILE);
            Object.assign(env, { LANGUAGE: HLS_LANGUAGE, http_proxy: 'http://127.0.0.1:' + (w.proxyPort || 7390), no_proxy: 'localhost,127.0.0.1',
                MGU_CA_FILE: o.caFile || path.join(__dirname, 'cacert.pem') }, o.env || {});
        }
        // stdin: the app's controls for a played video (pause, resume, seek), one a line (renderer/mgu_renderer.c)
        const spawnOpts = { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] };
        // As nobody when the service is root (the car), in the groups video (the GPU's render node) and mgu_alsa (the
        // sound devices, as Moonride). Node gives a spawned process no supplementary groups, so the receiver is started
        // as root and drops to nobody with those groups itself before anything else runs (renderer/mgu_renderer.c,
        // MGU_RUN_AS); it refuses to run if it cannot. uid null: as this process (the tests).
        if (o.uid != null && process.getuid && process.getuid() === 0) {
            env.MGU_RUN_AS = 'nobody';
            env.MGU_GROUPS = RX_GROUPS.join(',');
            const missing = RX_GROUPS.filter((g) => groupGid(g) == null);
            if (missing.length && o.log) o.log('receiver: no group ' + missing.join(', ') + ' on this unit');
        }
        st.starts++;
        st.running = true; st.exit = null; st.error = null; st.ip = w.ip; st.iface = w.iface;
        if (o.log) o.log('receiver: starting "' + w.name + '" on ' + w.iface + ' ' + w.ip + ', tcp/udp ' + PORTS.join(','));
        try {
            child = cp.spawn(o.bin, args, spawnOpts);
        } catch (e) {
            st.running = false; st.error = 'start: ' + e.message; child = null;
            if (o.log) o.log('receiver: ' + st.error);
            return;
        }
        st.pid = child.pid;
        child.stdin.on('error', () => { /* the receiver went */ });
        lines(child.stdout, onLine);
        lines(child.stderr, keep);
        const me = child;
        let ended = false;
        // a receiver that could not start (not executable for its uid, ...) gets 'error' and no 'exit'
        child.on('error', (e) => { st.error = 'start: ' + e.message + (e.code === 'ENOENT' && fs.existsSync(o.bin) ? ' (the binary is there: its program loader is missing)' : ''); if (o.log) o.log('receiver: ' + st.error); if (!me.pid) finish(null, null); });
        child.on('exit', (code, sig) => finish(code, sig));
        function finish(code, sig) {
            if (ended) return;
            ended = true;
            if (child === me) child = null;
            st.running = false; st.pid = null; st.videoRunning = false; st.soundRunning = false; st.stream.fps = 0; st.stream.kbps = 0;
            st.exit = { code, signal: sig, at: now() };
            removeVideo();
            if (stopping || !want) { if (me.onEnded) me.onEnded(); return; }
            if (code === null && sig === null) { st.running = false; if (o.onChange) o.onChange(); return; }   // never started: st.error says why
            st.error = 'the receiver exited (' + (sig || 'code ' + code) + ')';
            if (o.log) o.log('receiver: ' + st.error + (st.starts <= MAX_RESTARTS ? ', starting it again' : ', not again'));
            if (st.starts <= MAX_RESTARTS) setTimeout(spawn, 2000);
            if (o.onChange) o.onChange();
        }
        me.finish = finish;
    }

    function start(w) {
        stopping = false;
        st = freshState();
        want = w;
        spawn();
    }

    /** ends the receiver: SIGTERM, SIGKILL after 3 s */
    function stop() {
        stopping = true;
        want = null;
        const c = child;
        if (!c || !c.pid) { child = null; st.running = false; return Promise.resolve(); }
        return new Promise((res) => {
            const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
            // resolved however it ends; at worst 5 s after the SIGKILL
            const last = setTimeout(() => { if (c.finish) c.finish(null, 'SIGKILL'); res(); }, 8000);
            c.onEnded = () => { clearTimeout(t); clearTimeout(last); res(); };
            try { c.kill('SIGTERM'); } catch (e) { clearTimeout(t); clearTimeout(last); res(); }
        });
    }

    /** the frame file goes with the receiver (it removes it itself at a clean exit; this covers a crash or a kill) */
    function removeVideo() { try { fs.unlinkSync(o.videoPath || VIDEO_PATH); } catch (e) { /* none */ } }

    /** for exit: no receiver left behind, synchronously */
    function killSync() { if (child) { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } } removeVideo(); }

    /** a played video's control (stage 4): 'pause' | 'resume' | 'seek' with `to` seconds; false when no receiver */
    function control(op, to) {
        const c = child;
        if (!c || !c.stdin || !c.stdin.writable) return false;
        let line = null;
        if (op === 'pause' || op === 'resume') line = op;
        else if (op === 'seek' && Number(to) >= 0) line = 'seek ' + Number(to).toFixed(3);
        if (!line) return false;
        try { c.stdin.write(line + '\n'); } catch (e) { return false; }
        if (o.log) o.log('receiver: ' + line + ' (the app)');
        return true;
    }

    return { start, stop, killSync, control, state: () => st };
}

module.exports = { createReceiver, PORTS, BASE_PORT, VIDEO_PATH, AUDIO_DEVICE, HLS_PROFILE, IDENTITIES };
