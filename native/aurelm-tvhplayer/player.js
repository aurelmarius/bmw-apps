'use strict';
/**
 * player.js - tvh-player (native/tvh-player) for the service: one process per stream (another channel or profile is a new one).
 * aurelm-tvhplayer's copy of aurelm-emby's player.js: its own binary, frame file and prebuffer.
 *
 * Started by the service, as root, so it can take the groups below; it then
 * becomes nobody with the groups video (the GPU's render node) and mgu_alsa (the sound devices) itself, before it
 * reads the stream (MGU_RUN_AS, MGU_GROUPS), and refuses to run as root. Nobody, as AirPlay Test's receiver: the
 * smartx sound plugin refused uid 13101 (0.2.0 in the car: snd_pcm_open "Operation not permitted", the picture
 * fine), and the player needs no internet (the client fetches the stream).
 * Its frame file (owned by nobody, which mgu-render takes) is made in the film's own shape; the app places it. It has the service's
 * limits (its cgroup, LimitCORE=1: no core dump). The stream comes from the TVH client (client.js) on its fd 4,
 * in frames (stream id, length); this module hands the current stream's bytes to the player's stdin, with the
 * pipe's backpressure, and drops a stream that was left. Control goes to the player's fd 3; its "MGU {json}" lines
 * come back as events.
 *
 *   const pl = createPlayer({ bin, uid, groups, videoPath, env, log, onEvent(id, ev) });
 *   pl.attach(readable)     the client's fd 4
 *   pl.start(id) / pl.ctl(id, line) / pl.stop(id) / pl.stopAll() -> Promise
 *   pl.state()              { id, pid, running, decoder, audio, open, last tick, exits }
 *
 * Plain Node 8.
 */
const fs = require('fs');
const cp = require('child_process');

const VIDEO_PATH = '/dev/shm/mgu-video-aurelm-tvhplayer';
const VIDEO_SIZE = '1920x1080';   // the largest picture: the channel's shape fitted into it, the app places it (fit, zoom, fill)
const PREBUFFER_MS = '1500';      // live: queued before the picture starts, and after the stream ran dry
const AUDIO_DEVICE = 'plug:smartx:CarLifeMedia_CF_48_STEREO';
const GROUPS = ['video', 'mgu_alsa'];
const RUN_AS = 'nobody';   // as AirPlay Test's receiver, whose sound the smartx plugin takes
const END = 0xffffffff;

function createPlayer(o) {
    const log = o.log || (() => {});
    const onEvent = o.onEvent || (() => {});
    const videoPath = o.videoPath || VIDEO_PATH;
    let cur = null;               // { id, child, ended, paused (the source) }
    const st = { id: null, pid: null, running: false, open: null, decoder: null, audio: null, error: null, exits: 0, stderr: [] };
    let src = null;               // the client's stream pipe
    let buf = Buffer.alloc(0);    // a frame not yet whole
    let want = 0;                 // bytes of the current frame still to come (in body)
    let frameId = 0;

    function emit(id, ev) { try { onEvent(id, ev); } catch (e) { log('player event: ' + e.message); } }

    /* ---------- the stream ---------- */
    function attach(readable) {
        src = readable;
        src.on('data', onData);
        src.on('error', (e) => log('stream pipe: ' + e.message));
    }
    function onData(d) {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        while (buf.length) {
            if (want === 0) {
                if (buf.length < 8) return;
                frameId = buf.readUInt32LE(0);
                const len = buf.readUInt32LE(4);
                buf = buf.slice(8);
                if (len === END) {
                    const c = cur;
                    if (c && c.id === frameId && !c.ended) { c.ended = true; if (c.child) { try { c.child.stdin.end(); } catch (e) { /* gone */ } } }
                    continue;
                }
                want = len;
                if (want === 0) continue;
            }
            const n = Math.min(want, buf.length);
            const part = buf.slice(0, n);
            buf = buf.slice(n);
            want -= n;
            // only the current stream's bytes reach a player; a stream that was left is read and dropped
            const c = cur;
            if (!c || c.id !== frameId || c.ended || c.done) continue;
            if (!c.child) {
                // the player starts once the one before it is gone (it holds the sound device): kept until then
                c.pending.push(part);
                c.pendingBytes += n;
                if (c.pendingBytes > 8 * 1024 * 1024 && !c.paused) { c.paused = true; src.pause(); }
            } else if (!c.child.stdin.write(part) && !c.paused) {
                c.paused = true;
                src.pause();
                c.child.stdin.once('drain', () => { c.paused = false; if (cur === c) src.resume(); });
            }
        }
    }

    /* ---------- the process ---------- */
    function lines(stream, fn) {
        let b = '';
        stream.setEncoding('utf8');
        stream.on('data', (d) => {
            b += d;
            let i;
            while ((i = b.indexOf('\n')) >= 0) { fn(b.slice(0, i)); b = b.slice(i + 1); }
            if (b.length > 65536) b = '';
        });
    }
    function start(id) {
        const old = cur;
        const c = { id, child: null, ended: false, paused: false, done: false, pending: [], pendingBytes: 0, lines: [] };
        cur = c;
        Object.assign(st, { id, pid: null, running: false, open: null, decoder: null, audio: null, error: null, tick: null, end: null });
        (old ? kill(old) : Promise.resolve()).then(() => { if (cur === c) spawn(c); });
    }
    function failed(c, msg) {
        st.error = msg;
        log('player ' + c.id + ': ' + msg);
        c.done = true;
        if (cur === c) { cur = null; if (c.paused && src) src.resume(); }
        emit(c.id, { ev: 'error', error: msg });
        emit(c.id, { ev: 'exit', code: null, signal: null });
    }
    function spawn(c) {
        const id = c.id;
        if (!fs.existsSync(o.bin)) return failed(c, 'the player is missing: ' + o.bin);
        const env = Object.assign({ HOME: '/tmp', PATH: '/usr/bin:/bin', MGU_VIDEO_PATH: videoPath, MGU_VIDEO_SIZE: VIDEO_SIZE,
            MGU_AUDIO: 'alsa:' + AUDIO_DEVICE, MGU_ALSA_US: '64000', MGU_PREBUFFER_MS: PREBUFFER_MS }, o.env || {});
        // as root (the car): the player drops to nobody with the groups itself (Node gives a child no
        // supplementary groups); uid null: as this process (the tests)
        if (o.uid != null && process.getuid && process.getuid() === 0) {
            env.MGU_RUN_AS = o.runAs || RUN_AS;
            env.MGU_GROUPS = (o.groups || GROUPS).join(',');
        }
        let child;
        try { child = cp.spawn(o.bin, [], { env, cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }); }
        catch (e) { return failed(c, 'the player did not start: ' + e.message); }
        c.child = child;
        Object.assign(st, { pid: child.pid, running: true });
        log('player ' + id + ': started (pid ' + child.pid + ')');
        // what came while the one before was ending
        c.pending.forEach((b) => child.stdin.write(b));
        c.pending = []; c.pendingBytes = 0;
        if (c.ended) child.stdin.end();
        c.lines.forEach((l) => child.stdio[3].write(l));
        c.lines = [];
        if (c.paused) { c.paused = false; if (src) src.resume(); }
        child.stdin.on('error', () => { /* the player went: its exit says so */ });
        child.stdio[3].on('error', () => {});
        lines(child.stdout, (l) => {
            if (l.indexOf('MGU ') !== 0) return;
            let ev;
            try { ev = JSON.parse(l.slice(4)); } catch (e) { return; }
            if (cur === c) {
                if (ev.ev === 'open') st.open = ev;
                else if (ev.ev === 'decoder') st.decoder = ev;
                else if (ev.ev === 'audio') st.audio = ev;
                else if (ev.ev === 'tick') st.tick = ev;
                else if (ev.ev === 'error') st.error = ev.error;
                else if (ev.ev === 'end') st.end = ev;
                if (ev.ev !== 'tick') log('player ' + id + ': ' + l.slice(4));
            }
            emit(id, ev);
        });
        lines(child.stderr, (l) => { st.stderr.push(l); if (st.stderr.length > 8) st.stderr.shift(); log('player ' + id + ': ' + l); });
        child.on('error', (e) => { if (!child.pid) finish(null, null, e.message); });
        child.on('exit', (code, sig) => finish(code, sig));
        function finish(code, sig, err) {
            if (c.done) return;
            c.done = true;
            if (cur === c) {
                cur = null;
                st.running = false; st.pid = null; st.exits++;
                if (err) st.error = 'the player did not start: ' + err;
                removeVideo();
                if (c.paused && src) src.resume();
            }
            if (c.onEnded) c.onEnded();
            log('player ' + id + ': ended (' + (sig || 'code ' + code) + ')');
            emit(id, { ev: 'exit', code, signal: sig });
        }
        c.finish = finish;
    }

    /** ends a player: quit on its control pipe, SIGTERM, SIGKILL after 6 s (in the car 3 s were not always enough:
     *  a player killed with its sound device open may leave the input busy) */
    function kill(c) {
        if (cur === c) { cur = null; st.running = false; if (c.paused && src) src.resume(); }
        if (c.done) return Promise.resolve();
        if (!c.child) { c.done = true; return Promise.resolve(); }   // not started yet: never will be
        return new Promise((res) => {
            c.onEnded = res;
            try { c.child.stdio[3].write('quit\n'); } catch (e) { /* gone */ }
            try { c.child.stdin.destroy(); } catch (e) { /* gone */ }
            try { c.child.kill('SIGTERM'); } catch (e) { /* gone */ }
            const t = setTimeout(() => { log('player ' + c.id + ': not ended after 6 s: SIGKILL'); try { c.child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 6000);
            const last = setTimeout(() => { if (c.finish) c.finish(null, 'SIGKILL'); }, 11000);
            const was = c.onEnded;
            c.onEnded = () => { clearTimeout(t); clearTimeout(last); removeVideo(); was(); };
        });
    }
    function ctl(id, line) {
        if (!cur || cur.id !== id || cur.done) return;
        const l = String(line).replace(/\n/g, ' ') + '\n';
        if (!cur.child) { cur.lines.push(l); return; }   // sent once it starts
        try { cur.child.stdio[3].write(l); } catch (e) { /* gone */ }
    }
    function stop(id) { if (cur && cur.id === id) return kill(cur); return Promise.resolve(); }
    function stopAll() { return cur ? kill(cur) : Promise.resolve(); }

    /** the frame file goes with the player (owned by nobody: the player itself cannot remove it) */
    function removeVideo() { if (!cur) { try { fs.unlinkSync(videoPath); } catch (e) { /* none */ } } }
    /** for exit: no player left behind, synchronously */
    function killSync() { if (cur && cur.child) { try { cur.child.kill('SIGKILL'); } catch (e) { /* gone */ } } cur = null; try { fs.unlinkSync(videoPath); } catch (e) { /* none */ } }

    function state() {
        return { id: st.id, running: st.running, pid: st.pid, open: st.open, decoder: st.decoder, audio: st.audio, tick: st.tick || null, end: st.end || null,
            error: st.error, exits: st.exits, videoPath, stderr: st.stderr.slice(-3) };
    }
    return { attach, start, ctl, stop, stopAll, killSync, state };
}

module.exports = { createPlayer, VIDEO_PATH, AUDIO_DEVICE, GROUPS };
