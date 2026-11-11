'use strict';
/**
 * aurelm-myairplay - can an iPhone find and reach an AirPlay receiver on this head unit?
 *
 * A network test, not a receiver. While a test runs (started from the app, at most `minutes`):
 *
 *   1. the firewall gets accept rules for AirPlay (the receiver's tcp port) and mDNS (udp 5353) on the
 *      Wi-Fi-side interfaces (nft.js), removed again when the test ends;
 *   2. an mDNS responder announces "BMW iDrive test" as an AirPlay receiver (_airplay._tcp,
 *      _raop._tcp) on those interfaces, answers queries for it, and notes every AirPlay query it
 *      hears (an iPhone asks when Screen Mirroring opens) and every Apple device that answers its
 *      own queries;
 *   3. the receiver's tcp port (7300; the next free one of 7350, 7400, 47000 when taken: the car's own
 *      CarPlay receiver holds 7000, AirPlay's usual port) listens, notes who connects and what they ask first (GET /info,
 *      POST /pair-setup, ...), and answer "503": the iPhone then says it could not connect.
 *
 * The verdict: an iPhone that connected to that port found the receiver and reached it, which is
 * everything a real receiver needs from the network.
 *
 * Runs as root (systemd, aurelm-myairplay.service), started by the app's connection to
 * /run/aurelm-myairplay.sock (socket activation; nothing runs at boot), and exits by itself 10
 * minutes after the last test and request. The unit's own Node (/usr/bin/node: 8.9.4 on 2019 head units):
 * plain JavaScript, no modules. One JSON object per line: {"cmd":"status"|"start"|"stop", "minutes": n};
 * the reply is the status.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const dns = require('./dns');
const ap = require('./airplay');
const nft = require('./nft');
const rxm = require('./receiver');
const sockgroup = require('./sockgroup');
const { fork } = require('child_process');

const VERSION = '1.0.1';
const MDNS_GROUP = '224.0.0.251';
const QUERY_NAMES = ['_airplay._tcp.local', '_raop._tcp.local', '_companion-link._tcp.local', '_apple-mobdev2._tcp.local'];

/* ---------------- interfaces ---------------- */

function ipInt(ip) { return String(ip).split('.').reduce((a, b) => ((a << 8) >>> 0) + Number(b), 0) >>> 0; }
function sameSubnet(a, b, mask) { const m = ipInt(mask); return ((ipInt(a) & m) >>> 0) === ((ipInt(b) & m) >>> 0); }

/** what an interface is likely to be, from its name and address */
function classify(name, ip) {
    if (/^172\.20\.10\./.test(ip)) return 'iphone-hotspot';
    if (/^172\.16\.222\./.test(ip)) return 'car-wifi';
    if (name === 'vethuplink') return 'uplink';
    if (/^(wlan|p2p|wfd|uap|mlan|wl|br|bridge)/i.test(name)) return 'wifi';
    return 'other';
}

/** IPv4 interfaces: [{ name, ip, mask, kind, used }]; `only`: these names are used, whatever they are */
function interfaces(only, raw) {
    const all = raw || os.networkInterfaces();
    const out = [];
    Object.keys(all).sort().forEach((name) => (all[name] || []).forEach((a) => {
        if (!(a.family === 'IPv4' || a.family === 4)) return;
        const kind = a.internal ? 'loopback' : classify(name, a.address);
        const used = only ? only.indexOf(name) >= 0 : kind !== 'other' && kind !== 'loopback';
        out.push({ name, ip: a.address, mask: a.netmask, kind, used });
    }));
    return out;
}

/** which process holds `port` (from /proc; tcp: listening sockets only): ['mdnsd (412)', ...] */
function portHolders(port, proto) {
    const tcp = proto === 'tcp';
    const want = ':' + ('0000' + port.toString(16).toUpperCase()).slice(-4);
    const inodes = {};
    (tcp ? ['/proc/net/tcp', '/proc/net/tcp6'] : ['/proc/net/udp', '/proc/net/udp6']).forEach((f) => {
        let t = '';
        try { t = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
        t.split('\n').slice(1).forEach((l) => {
            const c = l.trim().split(/\s+/);
            if (c.length > 9 && c[1].slice(-5) === want && (!tcp || c[3] === '0A')) inodes['socket:[' + c[9] + ']'] = true;
        });
    });
    if (!Object.keys(inodes).length) return [];
    const out = [];
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch (e) { return ['?']; }
    pids.forEach((pid) => {
        let fds = [];
        try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch (e) { return; }
        for (let i = 0; i < fds.length; i++) {
            let l = '';
            try { l = fs.readlinkSync('/proc/' + pid + '/fd/' + fds[i]); } catch (e) { continue; }
            if (inodes[l]) {
                let comm = '?';
                try { comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim(); } catch (e) { /* gone */ }
                out.push(comm + ' (' + pid + ')');
                break;
            }
        }
    });
    return out;
}

/* ---------------- the verdict ---------------- */

/**
 * { code, text } from a status. Codes, best last:
 *   idle, no-iface, mdns-failed, firewall-failed, listening, waiting, heard-phone, asked, connected
 */
/** the receiver test's verdict: rx-video (PASS), rx-audio-only, rx-connected, rx-waiting, rx-failed */
function rxVerdict(s) {
    const r = s.rx || {};
    const v = r.video, c = r.client, fresh = r.stream && r.stream.fps > 0;
    // stage 4: a video sent with the AirPlay button, played by the head unit
    const h = r.hls;
    if (h && h.ended && h.ended.why === 'error') return { code: 'rx-hls-failed', text: 'The video sent with the AirPlay button could not be played: ' + h.ended.error };
    if (h && h.open && r.decoder && !r.decoder.ok) return { code: 'rx-decoder-failed', text: 'The video plays, but the GPU decoder failed: ' + r.decoder.error };
    if (h && h.open) {
        const o = h.open;
        return { code: 'rx-hls', text: 'PASS: the head unit plays the video the iPhone sent' + (o.w ? ' (' + o.w + 'x' + o.h + ')' : '') +
            (h.ended ? ', ' + (h.ended.why === 'end' ? 'to its end' : 'stopped') : '') };
    }
    if (h) return { code: 'rx-hls-opening', text: 'The iPhone sent a video: opening it from the internet' };
    if (v && r.stream && r.stream.frames > 0 && r.decoder && !r.decoder.ok) {
        return { code: 'rx-decoder-failed', text: 'The picture reaches the head unit, but the GPU decoder failed: ' + r.decoder.error };
    }
    if (v && r.stream && r.stream.frames > 0) {
        return { code: 'rx-video', text: 'PASS: ' + ((c && c.name) || 'the iPhone') + ' mirrors ' + v.w + 'x' + v.h + (fresh ? ' at ' + r.stream.fps + ' fps' : '') + ': the picture reaches the head unit' };
    }
    if (!s.active) return { code: 'idle', text: 'Not running. Press "Start receiver" (or "Start test" for the network test).' };
    if (!s.ifaces.filter((i) => i.used).length) return { code: 'no-iface', text: 'No Wi-Fi network: connect the iPhone with wireless CarPlay, or the head unit to the iPhone hotspot' };
    if (r.error && !r.running) return { code: 'rx-failed', text: 'The receiver stopped: ' + r.error };
    if (s.fw.state === 'failed') return { code: 'firewall-failed', text: 'Firewall rules failed: ' + (s.fw.error || '') };
    if (c && r.audio) return { code: 'rx-audio-only', text: ((c && c.name) || 'The iPhone') + ' connected but sends sound only, no picture (the CarPlay restriction?)' };
    if (c) return { code: 'rx-connected', text: ((c && c.name) || 'The iPhone') + ' connected, waiting for the picture' };
    return { code: 'rx-waiting', text: 'Receiver "' + (r.name || 'BMW iDrive') + '" on ' + (r.iface || '?') + '. On the iPhone: Control Center > Screen Mirroring > ' + (r.name || 'BMW iDrive') };
}

function verdict(s) {
    if (s.mode === 'receiver') return rxVerdict(s);
    if (s.tcp.connections > 0) {
        const c = s.tcp.last || {};
        return { code: 'connected', text: 'PASS: ' + (c.ip || 'a device') + ' found the receiver and connected to it (' + (c.request || 'no request') + ')' };
    }
    if (!s.active) return { code: 'idle', text: 'Not running. Press "Start test".' };
    const used = s.ifaces.filter((i) => i.used);
    if (!used.length) return { code: 'no-iface', text: 'No Wi-Fi network: connect the head unit to the iPhone hotspot (mgu-uplink), or the iPhone to the car Wi-Fi' };
    if (s.mdns.mode === 'failed') return { code: 'mdns-failed', text: 'mDNS port 5353 is taken: ' + (s.mdns.error || '') + (s.mdns.holders.length ? ' (held by ' + s.mdns.holders.join(', ') + ')' : '') };
    if (!s.tcp.port) return { code: 'listening', text: 'No AirPlay port could be opened: ' + (s.tcp.error || '') };
    if (s.fw.state === 'failed') return { code: 'firewall-failed', text: 'Firewall rules failed: ' + (s.fw.error || '') };
    if (s.mdns.airplayQueries > 0) {
        const q = s.mdns.lastAirplayQuery || {};
        return { code: 'asked', text: (q.ip || 'A device') + ' looked for AirPlay receivers and got our answer. Tap "' + s.name + '" in Screen Mirroring' };
    }
    if (s.mdns.peers.length) return { code: 'heard-phone', text: 'mDNS works (' + s.mdns.peers.length + ' device(s) heard). Open Control Center > Screen Mirroring on the iPhone' };
    return { code: 'waiting', text: 'Announcing. Open Control Center > Screen Mirroring on the iPhone' };
}

/* ---------------- the probe ---------------- */

/**
 * opts: { stateDir, ports ([7300, 7350, 7400, 47000]: the first free one is the receiver's), mdnsPort (5353), nft ('nft' | false),
 *         only ([iface names] or null), ignoreSelf (true), loopback (false: our multicast not back to this host), name, log, onChange, onStop, now }
 */
function createProbe(opts) {
    const o = Object.assign({ ports: [7300, 7350, 7400, 47000], mdnsPort: 5353, nft: 'nft', only: null, ignoreSelf: true, name: 'BMW iDrive test',
        rxBin: path.join(__dirname, 'uxplay-mgu'), rxName: 'BMW iDrive', rxUid: 65534,
        // stage 4: the proxy the receiver's player reaches the internet through (proxy.js), as the uid mgu-uplink routes
        proxyUid: 13102, proxyPort: 7390, proxyEnv: {} }, opts || {});
    const now = o.now || Date.now;
    const lines = [];
    const log = (s) => {
        const l = new Date(now()).toISOString().slice(11, 19) + ' ' + s;
        lines.push(l);
        if (lines.length > 60) lines.shift();
        if (o.log) o.log(s);
    };

    const id = loadIdentity();
    const st = freshState();
    const rx = rxm.createReceiver({ bin: o.rxBin, uid: o.rxUid, gid: o.rxUid, home: o.stateDir ? path.join(o.stateDir, 'rx') : null, env: o.rxEnv, videoPath: o.rxVideoPath,
        log, now, onChange: () => { if (o.onChange) o.onChange(); } });
    let sock = null, servers = [], timers = [], endT = null, sendQ = Promise.resolve();

    /* ----- stage 4: the proxy (a child as the internet uid) while the receiver takes videos ----- */
    let proxy = null;
    const px = { state: 'off', error: null, stats: null, starts: 0 };
    function startProxy() {
        if (proxy || o.proxyPort == null) return;
        px.starts++;
        const env = Object.assign({ PATH: '/usr/bin:/bin', PROXY_PORT: String(o.proxyPort) }, o.proxyEnv || {});
        const fo = { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] };
        if (o.proxyUid != null && process.getuid && process.getuid() === 0) { fo.uid = o.proxyUid; fo.gid = o.proxyUid; }
        let c;
        try { c = fork(path.join(__dirname, 'proxy.js'), [], fo); } catch (e) { px.state = 'failed'; px.error = e.message; log('proxy: ' + e.message); return; }
        proxy = c;
        px.state = 'starting'; px.error = null;
        c.on('message', (m) => {
            if (!m) return;
            if (m.ev === 'ready') { px.state = 'on'; log('proxy: on 127.0.0.1:' + m.port + ' as uid ' + m.uid); }
            else if (m.ev === 'stats') px.stats = m.stats;
            else if (m.ev === 'log') log(m.line);
            else if (m.ev === 'error') { px.state = 'failed'; px.error = m.error; log('proxy: ' + m.error); }
        });
        c.on('error', (e) => log('proxy: ' + e.message));
        c.on('exit', (code, sig) => {
            if (proxy !== c) return;
            proxy = null;
            if (!st.active || !st.hls) { px.state = 'off'; return; }
            px.state = 'failed'; px.error = px.error || 'ended (' + (sig || code) + ')';
            log('proxy: ended (' + (sig || code) + ')' + (px.starts < 5 ? ', starting it again' : ''));
            if (px.starts < 5) setTimeout(() => { if (st.active && st.hls) startProxy(); }, 3000);
        });
    }
    function stopProxy() {
        const c = proxy;
        proxy = null;
        px.state = 'off';
        if (c) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } }
    }

    function loadIdentity() {
        const f = o.stateDir && path.join(o.stateDir, 'identity.json');
        if (f) {
            try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && j.deviceid && j.pk && j.pi) { j.name = o.name; return j; } } catch (e) { /* new one */ }
        }
        const j = ap.newIdentity(o.name);
        if (f) { try { fs.mkdirSync(o.stateDir, { recursive: true }); } catch (e) { /* node 8: no recursive */ } try { fs.writeFileSync(f, JSON.stringify(j, null, 2)); } catch (e) { /* kept in memory */ } }
        return j;
    }

    function freshState() {
        return {
            active: false, mode: 'probe', hls: false, identity: 'carplay', net: 'car', startedAt: null, endsAt: null, ifaces: [],
            mdns: { mode: 'off', error: null, holders: [], packets: 0, queries: 0, airplayQueries: 0, answered: 0, announced: 0, lastAirplayQuery: null, peers: [] },
            tcp: { port: null, listening: [], busy: [], error: null, connections: 0, last: null, requests: [] },
            fw: { state: 'off', error: null, chains: [], removed: 0 },
        };
    }

    function status() {
        const s = {
            v: 1, version: VERSION, now: now(), name: id.name, deviceid: id.deviceid,
            active: st.active, startedAt: st.startedAt, endsAt: st.endsAt, ifaces: st.ifaces.length ? st.ifaces : interfaces(o.only),
            mdns: st.mdns, tcp: st.tcp, fw: st.fw, log: lines.slice(-30), mode: st.mode,
        };
        if (st.mode === 'receiver') {
            const r = rx.state();
            s.rx = { name: rxName(), running: r.running, pid: r.pid, starts: r.starts, error: r.error, exit: r.exit, ip: r.ip, iface: r.iface,
                client: r.client, video: r.video, videoRunning: r.videoRunning, audio: r.audio, stream: r.stream, ports: rxm.PORTS, lines: r.lines.slice(-25),
                decoder: r.decoder, videoPath: o.rxVideoPath || rxm.VIDEO_PATH, sound: r.sound, soundRunning: r.soundRunning, cpu: r.cpu,
                hlsOn: st.hls, identity: st.identity, net: st.net, hls: r.hls, proxy: st.hls ? { state: px.state, error: px.error, stats: px.stats } : null };
        }
        s.verdict = verdict(s);
        return s;
    }

    /* ----- interfaces and firewall ----- */
    const usedIfaces = () => st.ifaces.filter((i) => i.used);
    function ifaceFor(ip) {
        const u = usedIfaces();
        return u.find((i) => sameSubnet(i.ip, ip, i.mask)) || null;
    }
    function rescan() {
        const before = usedIfaces().map((i) => i.name + '=' + i.ip).join(',');
        st.ifaces = interfaces(o.only);
        const after = usedIfaces().map((i) => i.name + '=' + i.ip).join(',');
        if (after !== before && st.mode === 'receiver') {
            log('interfaces: ' + (after || 'none'));
            firewall();
            const t = rxTarget(), r = rx.state();
            if (t && (!r.ip || r.ip !== t.ip)) { rx.stop().then(() => { if (st.active) rx.start(t); }); }
            return;
        }
        if (after !== before) {
            log('interfaces: ' + (after || 'none') + (st.ifaces.filter((i) => !i.used).length ? '; not used: ' + st.ifaces.filter((i) => !i.used).map((i) => i.name + '=' + i.ip).join(',') : ''));
            joinGroups();
            firewall();
            announce(false);
        }
    }
    function firewall() {
        if (!o.nft) { st.fw.state = 'skipped'; return; }
        const names = usedIfaces().map((i) => i.name).filter((n, i, a) => a.indexOf(n) === i);
        try {
            const res = st.mode === 'receiver'
                ? nft.apply(names, { nft: o.nft, tcpPorts: rxm.PORTS, udpPorts: rxm.PORTS, uid: o.rxUid != null ? o.rxUid : 0 })
                : nft.apply(names, { nft: o.nft, tcpPorts: st.tcp.listening });
            st.fw.chains = res.map((r) => ({ chain: r.chain, ok: r.ok, rules: r.rules, error: r.error }));
            const bad = res.filter((r) => !r.ok);
            st.fw.state = bad.length ? 'failed' : res.length ? 'open' : 'no-chains';
            st.fw.error = bad.length ? bad[0].chain + ': ' + bad[0].error : null;
            if (res.some((r) => r.changed)) log('firewall: ' + res.filter((r) => r.changed).map((r) => r.chain + (r.ok ? ' +' + r.rules : ' FAILED ' + r.error)).join('; '));
        } catch (e) {
            st.fw.state = 'failed';
            st.fw.error = String(e.stderr || e.message || e).trim().split('\n')[0];
            log('firewall: ' + st.fw.error);
        }
    }

    /* ----- mDNS ----- */
    const joined = {};
    function joinGroups() {
        if (!sock || st.mdns.mode !== 'own') return;
        usedIfaces().forEach((i) => {
            if (joined[i.ip]) return;
            try { sock.addMembership(MDNS_GROUP, i.ip); joined[i.ip] = true; log('mDNS: joined ' + MDNS_GROUP + ' on ' + i.name); } catch (e) { log('mDNS: join on ' + i.name + ' failed: ' + e.message); joined[i.ip] = 'failed'; }
        });
    }
    /** sends one at a time: the multicast interface is the socket's, set right before its send */
    function send(buf, port, addr, viaIp) {
        sendQ = sendQ.then(() => new Promise((res) => {
            if (!sock) return res();
            try { if (viaIp) sock.setMulticastInterface(viaIp); } catch (e) { /* unicast still goes */ }
            try { sock.send(buf, 0, buf.length, port, addr, (err) => { if (err) log('mDNS send to ' + addr + ': ' + err.message); res(); }); } catch (e) { log('mDNS send: ' + e.message); res(); }
        }));
        return sendQ;
    }
    function announce(goodbye) {
        if (!sock || st.mdns.mode !== 'own') return Promise.resolve();
        return Promise.all(usedIfaces().map((i) => {
            const a = ap.announcement(id, st.tcp.port, i.ip, goodbye);
            st.mdns.announced++;
            return send(dns.encodeResponse(a), o.mdnsPort, MDNS_GROUP, i.ip);
        }));
    }
    function query() {
        if (!sock || st.mdns.mode !== 'own') return;
        const q = dns.encodeQuery(QUERY_NAMES);
        usedIfaces().forEach((i) => send(q, o.mdnsPort, MDNS_GROUP, i.ip));
    }
    function notePeer(ip, iface, names) {
        let p = st.mdns.peers.find((x) => x.ip === ip);
        if (!p) { p = { ip, iface: iface ? iface.name : null, names: [], at: 0 }; st.mdns.peers.push(p); log('mDNS: heard ' + ip + (iface ? ' on ' + iface.name : '')); }
        p.at = now();
        names.forEach((n) => { if (p.names.indexOf(n) < 0 && p.names.length < 8) p.names.push(n); });
        if (st.mdns.peers.length > 20) st.mdns.peers.shift();
    }
    const ownIps = () => interfaces(null).map((i) => i.ip);
    function onPacket(msg, rinfo) {
        if (o.ignoreSelf && ownIps().indexOf(rinfo.address) >= 0) return;
        st.mdns.packets++;
        let p;
        try { p = dns.decode(msg); } catch (e) { return; }
        const iface = ifaceFor(rinfo.address);
        if (p.qr) {
            const names = p.records.filter((r) => r.type === dns.T.PTR && r.data && !/\.arpa$/.test(r.name)).map((r) => r.data);
            notePeer(rinfo.address, iface, names);
            return;
        }
        if (!p.questions.length) return;
        st.mdns.queries++;
        notePeer(rinfo.address, iface, []);
        if (p.questions.some(ap.isAirplayQuestion)) {
            st.mdns.airplayQueries++;
            const first = !st.mdns.lastAirplayQuery || st.mdns.lastAirplayQuery.ip !== rinfo.address;
            st.mdns.lastAirplayQuery = { ip: rinfo.address, iface: iface ? iface.name : null, at: now(), names: p.questions.map((q) => q.name).slice(0, 6) };
            if (first) log('mDNS: AirPlay query from ' + rinfo.address + (iface ? ' on ' + iface.name : ' (no interface of ours)'));
        }
        const via = iface || usedIfaces()[0];
        if (!via) return;
        const a = ap.answer(id, st.tcp.port, via.ip, p.questions);
        if (!a) return;
        st.mdns.answered++;
        if (rinfo.port !== o.mdnsPort) {
            // legacy unicast (RFC 6762 6.7): the id and question back, short TTLs, to the sender's port
            const cap = (r) => Object.assign({}, r, { ttl: Math.min(r.ttl, 10), flush: false });
            send(dns.encodeResponse({ id: p.id, questions: p.questions, answers: a.answers.map(cap), additionals: a.additionals.map(cap) }), rinfo.port, rinfo.address);
            return;
        }
        const buf = dns.encodeResponse(a);
        if (p.questions.some((q) => q.qu)) send(buf, o.mdnsPort, rinfo.address);
        send(buf, o.mdnsPort, MDNS_GROUP, via.ip);
    }
    function startMdns() {
        st.mdns.holders = portHolders(o.mdnsPort);
        if (st.mdns.holders.length) log('mDNS: port ' + o.mdnsPort + ' is also open in ' + st.mdns.holders.join(', '));
        return new Promise((res) => {
            const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            let done = false;
            s.on('error', (e) => {
                if (!done) { done = true; st.mdns.mode = 'failed'; st.mdns.error = e.code || e.message; log('mDNS: bind ' + o.mdnsPort + ' failed: ' + (e.code || e.message)); try { s.close(); } catch (x) { /* closed */ } return res(); }
                log('mDNS socket: ' + e.message);
            });
            s.on('message', (m, r) => { try { onPacket(m, r); } catch (e) { log('mDNS packet: ' + e.message); } });
            s.bind(o.mdnsPort, () => {
                done = true;
                sock = s;
                st.mdns.mode = 'own';
                try { s.setMulticastTTL(255); } catch (e) { /* default */ }
                try { s.setMulticastLoopback(!!o.loopback); } catch (e) { /* default */ }
                log('mDNS: listening on ' + o.mdnsPort);
                joinGroups();
                res();
            });
        });
    }

    /* ----- AirPlay ports ----- */
    function onConnection(c, port) {
        const ip = String(c.remoteAddress || '').replace(/^::ffff:/, '');
        const iface = ifaceFor(ip);
        st.tcp.connections++;
        const rec = { ip, port, iface: iface ? iface.name : null, at: now(), request: null, agent: null };
        st.tcp.last = rec;
        log('AirPlay: ' + ip + ' connected to ' + port + (iface ? ' on ' + iface.name : ''));
        let buf = Buffer.alloc(0);
        const finish = () => {
            const text = buf.toString('latin1');
            const head = text.split('\r\n\r\n')[0].split('\r\n');
            rec.request = (head[0] || '').slice(0, 80) || '(nothing sent)';
            const ua = head.find((l) => /^user-agent:/i.test(l));
            rec.agent = ua ? ua.slice(11).trim().slice(0, 60) : null;
            if (st.tcp.requests.length < 10) st.tcp.requests.push(rec);
            log('AirPlay: ' + ip + ' asked: ' + rec.request + (rec.agent ? ' (' + rec.agent + ')' : ''));
            const proto = /RTSP\/1\.0\s*$/.test(head[0] || '') ? 'RTSP/1.0' : 'HTTP/1.1';
            const cseq = head.find((l) => /^cseq:/i.test(l));
            try { c.end(proto + ' 503 Service Unavailable\r\n' + (cseq ? cseq + '\r\n' : '') + 'Content-Length: 0\r\nServer: AirTunes/' + '220.68\r\n\r\n'); } catch (e) { /* closed */ }
        };
        const t = setTimeout(() => { c.removeAllListeners('data'); finish(); }, 3000);
        c.on('data', (d) => {
            buf = Buffer.concat([buf, d]).slice(0, 4096);
            if (buf.indexOf('\r\n\r\n') >= 0) { clearTimeout(t); c.removeAllListeners('data'); finish(); }
        });
        c.on('error', () => { /* the phone went */ });
        c.on('close', () => clearTimeout(t));
    }
    /** listens on `port`: true, or false (taken: who holds it goes into tcp.busy and the log) */
    function listen(port) {
        return new Promise((res) => {
            const srv = net.createServer((c) => onConnection(c, port));
            srv.on('error', (e) => {
                const holders = e.code === 'EADDRINUSE' ? portHolders(port, 'tcp') : [];
                st.tcp.busy.push({ port, error: e.code || e.message, holders });
                st.tcp.error = port + ': ' + (e.code || e.message) + (holders.length ? ' (' + holders.join(', ') + ')' : '');
                log('AirPlay: port ' + port + ' ' + (e.code || e.message) + (holders.length ? ', held by ' + holders.join(', ') : ''));
                res(false);
            });
            srv.listen(port, '0.0.0.0', () => { servers.push(srv); st.tcp.listening.push(port); res(true); });
        });
    }
    /** the receiver's port: the first of o.ports that is free */
    async function choosePort() {
        for (let i = 0; i < o.ports.length; i++) {
            if (await listen(o.ports[i])) { st.tcp.port = o.ports[i]; log('AirPlay: receiver on tcp ' + o.ports[i]); return; }
        }
    }

    /* ----- the receiver test ----- */
    /** where the receiver announces itself: the car's Wi-Fi first, then the iPhone's hotspot */
    /** the receiver's name and id: the classic identity is another receiver to the iPhone (iOS keeps what it learnt per id) */
    function who() {
        const classic = st.identity === 'classic';
        const dev = classic ? id.deviceid.replace(/[0-9a-f]{2}$/i, (b) => ('0' + (parseInt(b, 16) ^ 1).toString(16)).slice(-2).toUpperCase()) : id.deviceid;
        return { name: rxName(), deviceid: dev, hls: st.hls, identity: st.identity, proxyPort: o.proxyPort };
    }
    function rxName() { return st.identity === 'classic' ? o.rxName + ' Video' : o.rxName; }
    function rxTarget() {
        const u = usedIfaces();
        // the app's setting "AirPlay network": the car's Wi-Fi first (wireless CarPlay's), or the iPhone's hotspot first
        // (the unit on it through mgu-uplink: CarPlay can be off, and iOS does not end a video for it)
        const order = st.net === 'hotspot' ? ['iphone-hotspot', 'uplink', 'car-wifi', 'wifi'] : ['car-wifi', 'iphone-hotspot', 'uplink', 'wifi'];
        for (let k = 0; k < order.length; k++) {
            const i = u.find((x) => x.kind === order[k]);
            if (i) return Object.assign({ ip: i.ip, iface: i.name }, who());
        }
        // an interface given by name (PROBE_IFACES, the tests): whatever its kind
        return u.length ? Object.assign({ ip: u[0].ip, iface: u[0].name }, who()) : null;
    }
    async function startReceiver() {
        firewall();
        if (st.hls) startProxy();
        const t = rxTarget();
        if (t) rx.start(t); else log('receiver: no Wi-Fi interface to announce on');
        every(3000, rescan);
        if (o.nft) every(5000, firewall);
        if (o.onChange) every(1000, o.onChange);
    }

    /* ----- the test ----- */
    function every(ms, f) { const t = setInterval(() => { try { f(); } catch (e) { log(e.message); } }, ms); if (t.unref) t.unref(); timers.push(t); }

    async function start(minutes, mode, hls, identity, net) {
        const m = Math.max(1, Math.min(60, Number(minutes) || 15));
        const md = mode === 'receiver' ? 'receiver' : 'probe';
        const wantHls = md === 'receiver' && !!hls;
        const wantId = identity === 'classic' ? 'classic' : 'carplay';
        const wantNet = net === 'hotspot' ? 'hotspot' : 'car';
        if (st.active && st.mode !== md) await stop('switching to the ' + (md === 'receiver' ? 'receiver' : 'network') + ' test');
        // the video button switched on or off in the app: the receiver starts again with it
        if (st.active && md === 'receiver' && (st.hls !== wantHls || st.identity !== wantId || st.net !== wantNet)) await stop('the receiver settings changed');
        if (st.active) { st.endsAt = now() + m * 60000; resetEnd(); log('test extended to ' + m + ' min'); return status(); }
        Object.assign(st, freshState());
        st.mode = md;
        st.hls = wantHls;
        st.identity = wantId;
        st.net = wantNet;
        st.active = true; st.startedAt = now(); st.endsAt = now() + m * 60000;
        if (md === 'receiver') {
            log('receiver test started (' + m + ' min), "' + o.rxName + '" ' + id.deviceid + (st.hls ? ', with the video button' : '') + (st.identity !== 'carplay' ? ', identity ' + st.identity : '') + (st.net !== 'car' ? ', on the iPhone hotspot first' : ''));
            if (o.nft) { const n = nft.remove({ nft: o.nft }); if (n) log('firewall: removed ' + n + ' old rules'); }
            st.ifaces = interfaces(o.only);
            log('interfaces: ' + (usedIfaces().map((i) => i.name + '=' + i.ip + ' (' + i.kind + ')').join(', ') || 'none'));
            await startReceiver();
            resetEnd();
            return status();
        }
        log('test started (' + m + ' min), receiver "' + id.name + '" ' + id.deviceid);
        if (o.nft) { const n = nft.remove({ nft: o.nft }); if (n) log('firewall: removed ' + n + ' old rules'); }
        st.ifaces = interfaces(o.only);
        log('interfaces: ' + (usedIfaces().map((i) => i.name + '=' + i.ip + ' (' + i.kind + ')').join(', ') || 'none') +
            (st.ifaces.filter((i) => !i.used).length ? '; not used: ' + st.ifaces.filter((i) => !i.used).map((i) => i.name + '=' + i.ip).join(', ') : ''));
        // AirPlay's usual port: who holds it on this unit (the car's own CarPlay receiver, found on the car)
        const h7000 = portHolders(7000, 'tcp');
        if (h7000.length) log('AirPlay: tcp 7000 is held by ' + h7000.join(', '));
        await choosePort();
        firewall();   // after the port is known: the rules open the one the receiver listens on
        await startMdns();
        resetEnd();
        // announce three times a second apart, then every 30 s; ask who is there every 10 s
        [0, 1000, 3000].forEach((d) => { const t = setTimeout(() => announce(false), d); timers.push(t); });
        every(30000, () => announce(false));
        every(10000, query);
        query();
        every(3000, rescan);
        if (o.nft) every(5000, firewall);
        if (o.onChange) every(1000, o.onChange);
        return status();
    }
    function resetEnd() {
        if (endT) clearTimeout(endT);
        endT = setTimeout(() => stop('time is up'), Math.max(0, st.endsAt - now()));
    }
    async function stop(why) {
        if (!st.active) return status();
        st.active = false;
        if (endT) { clearTimeout(endT); endT = null; }
        timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
        timers = [];
        if (st.mode === 'receiver') await rx.stop();
        stopProxy();
        try { await announce(true); } catch (e) { /* goodbye is best effort */ }
        await sendQ;
        if (sock) { try { sock.close(); } catch (e) { /* closed */ } sock = null; }
        Object.keys(joined).forEach((k) => delete joined[k]);
        servers.forEach((s) => { try { s.close(); } catch (e) { /* closed */ } });
        servers = [];
        st.tcp.listening = [];
        if (st.mdns.mode === 'own') st.mdns.mode = 'off';
        if (o.nft) { st.fw.removed = nft.remove({ nft: o.nft }); st.fw.state = 'closed'; }
        log('test stopped: ' + (why || 'asked') + (o.nft ? ', firewall rules removed: ' + st.fw.removed : ''));
        if (o.onStop) o.onStop();
        return status();
    }
    /** for exit: the firewall as the unit had it, synchronously */
    /** ends the iPhone's mirroring session: the receiver is started again (the phone sees it go and stops) */
    async function endSession(why) {
        if (!st.active || st.mode !== 'receiver') return status();
        const r = rx.state();
        if (!r.client) return status();
        log('receiver: ending the iPhone\'s session (' + (why || 'asked') + ')');
        await rx.stop();
        const t = rxTarget();
        if (st.active && t) rx.start(t);
        return status();
    }
    /** the app's controls for a played video: pause, resume, seek (the receiver's player; the iPhone follows) */
    function video(op, to) {
        if (st.active && st.mode === 'receiver') rx.control(op, to);
        return status();
    }
    function cleanupSync() { rx.killSync(); stopProxy(); if (o.nft) { try { nft.remove({ nft: o.nft }); } catch (e) { /* best effort */ } } }

    return { start, stop, status, endSession, video, cleanupSync, identity: id };
}

/* ---------------- control socket ---------------- */

/**
 * The control socket: systemd's (socket activation, fd 3) when it handed one over, else a socket of
 * our own at sockPath (a run by hand, the tests). onRequest() is called for every request.
 */
function serveControl(probe, sockPath, log, onRequest, onExit) {
    const srv = net.createServer((c) => {
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d) => {
            buf += d;
            if (buf.length > 4096) { c.destroy(); return; }
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                let m = {};
                try { m = JSON.parse(line || '{}'); } catch (e) { m = {}; }
                if (onRequest) onRequest(m);
                // exit: the app found an older version running (its files were updated under it); the reply
                // goes first, then the service ends and the socket starts the new one at the next request
                if (m.cmd === 'exit' && onExit) {
                    try { c.end(JSON.stringify(Object.assign(probe.status(), { exiting: true })) + '\n'); } catch (e) { /* gone */ }
                    onExit();
                    return;
                }
                const p = m.cmd === 'end-session' ? probe.endSession(m.why) : m.cmd === 'video' ? probe.video(m.op, m.to) : m.cmd === 'start' ? probe.start(m.minutes, m.mode, m.hls, m.identity, m.net) : m.cmd === 'stop' ? probe.stop('stopped from the app') : Promise.resolve(probe.status());
                Promise.resolve(p).then((s) => { try { c.write(JSON.stringify(s) + '\n'); } catch (e) { /* gone */ } }, (e) => { try { c.write(JSON.stringify({ error: String(e.message || e) }) + '\n'); } catch (x) { /* gone */ } });
            }
        });
        c.on('error', () => { /* client went */ });
    });
    // the app's own group, never tm_oap_app (every app has that): sockgroup.js
    const ownGroup = () => {
        try { const g = sockgroup.apply(sockPath); log('control socket ' + sockPath + ': ' + (g === null ? 'root only (the app is not installed)' : 'group ' + g)); } catch (e) { log('control socket mode: ' + e.message); }
    };
    if (process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid) {
        srv.listen({ fd: 3 }, () => { log('control socket from systemd'); ownGroup(); });
        return srv;
    }
    try { fs.unlinkSync(sockPath); } catch (e) { /* none */ }
    srv.listen(sockPath, ownGroup);
    return srv;
}

/* ---------------- main ---------------- */

const IDLE_EXIT_MS = 10 * 60000;   // no test and no request this long: exit (the socket starts it again)
const REPORT_MS = 30000;           // the running test's report on disk this often (and at its end)

function main() {
    const stateDir = process.env.PROBE_STATE || '/var/opt/aurelm-myairplay/state';
    const sockPath = process.env.PROBE_SOCK || '/run/aurelm-myairplay.sock';
    const log = (s) => console.log(s);
    let lastReport = 0, lastRequest = Date.now();
    const report = (force) => {
        if (!force && Date.now() - lastReport < REPORT_MS) return;
        lastReport = Date.now();
        try { fs.writeFileSync(path.join(stateDir, 'last-report.json'), JSON.stringify(probe.status(), null, 1)); } catch (e) { /* no state dir */ }
    };
    const probe = createProbe({
        stateDir, log, onChange: () => report(false), onStop: () => report(true),
        nft: process.env.PROBE_NFT === 'off' ? false : (process.env.PROBE_NFT || 'nft'),
        only: process.env.PROBE_IFACES ? process.env.PROBE_IFACES.split(',') : null,
        name: process.env.PROBE_NAME || 'BMW iDrive test',
    });
    // what an earlier run in this boot left in the firewall goes first (a reboot clears it anyway)
    probe.cleanupSync();
    let exiting = false;
    serveControl(probe, sockPath, log, () => { lastRequest = Date.now(); }, () => { if (!exiting) { exiting = true; setTimeout(() => bye('asked by the app (a newer version is installed)', 0), 200); } });
    log('aurelm-myairplay ' + VERSION + ' on node ' + process.version + ', receiver ' + probe.identity.deviceid);
    const bye = (why, code) => {
        log('exit: ' + why);
        const t = setTimeout(() => { probe.cleanupSync(); process.exit(code); }, 4000);
        probe.stop(why).then(() => { clearTimeout(t); probe.cleanupSync(); process.exit(code); }, () => { probe.cleanupSync(); process.exit(code); });
    };
    setInterval(() => {
        const s = probe.status();
        if (!s.active && Date.now() - lastRequest > IDLE_EXIT_MS) bye('idle', 0);
    }, 30000);
    process.on('SIGTERM', () => bye('SIGTERM', 0));
    process.on('SIGINT', () => bye('SIGINT', 0));
    process.on('uncaughtException', (e) => { log('fatal: ' + (e.stack || e)); probe.cleanupSync(); process.exit(1); });
}

if (require.main === module) main();

module.exports = { createProbe, verdict, interfaces, classify, portHolders, sameSubnet, VERSION };
