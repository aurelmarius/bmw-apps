'use strict';
/**
 * aurelm-airplay-probe - can an iPhone find and reach an AirPlay receiver on this head unit?
 *
 * A network test, not a receiver. While a test runs (started from the app, at most `minutes`):
 *
 *   1. the firewall gets accept rules for AirPlay (tcp 7000, 7100) and mDNS (udp 5353) on the
 *      Wi-Fi-side interfaces (nft.js), removed again when the test ends;
 *   2. an mDNS responder announces "BMW iDrive test" as an AirPlay receiver (_airplay._tcp,
 *      _raop._tcp) on those interfaces, answers queries for it, and notes every AirPlay query it
 *      hears (an iPhone asks when Screen Mirroring opens) and every Apple device that answers its
 *      own queries;
 *   3. tcp 7000 and 7100 listen, note who connects and what they ask first (GET /info,
 *      POST /pair-setup, ...), and answer "503": the iPhone then says it could not connect.
 *
 * The verdict: an iPhone that connected to tcp 7000 found the receiver and reached it, which is
 * everything a real receiver needs from the network.
 *
 * Runs as root (systemd, aurelm-airplay-probe.service), started by the app's connection to
 * /run/aurelm-airplay-probe.sock (socket activation; nothing runs at boot), and exits by itself 10
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
const sockgroup = require('./sockgroup');

const VERSION = '0.3.0';
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

/** which process holds udp `port` (from /proc): ['mdnsd (412)', ...] */
function portHolders(port) {
    const want = ':' + ('0000' + port.toString(16).toUpperCase()).slice(-4);
    const inodes = {};
    ['/proc/net/udp', '/proc/net/udp6'].forEach((f) => {
        let t = '';
        try { t = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
        t.split('\n').slice(1).forEach((l) => {
            const c = l.trim().split(/\s+/);
            if (c.length > 9 && c[1].slice(-5) === want) inodes['socket:[' + c[9] + ']'] = true;
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
function verdict(s) {
    if (s.tcp.connections > 0) {
        const c = s.tcp.last || {};
        return { code: 'connected', text: 'PASS: ' + (c.ip || 'a device') + ' found the receiver and connected to it (' + (c.request || 'no request') + ')' };
    }
    if (!s.active) return { code: 'idle', text: 'Not running. Press "Start test".' };
    const used = s.ifaces.filter((i) => i.used);
    if (!used.length) return { code: 'no-iface', text: 'No Wi-Fi network: connect the head unit to the iPhone hotspot (mgu-uplink), or the iPhone to the car Wi-Fi' };
    if (s.mdns.mode === 'failed') return { code: 'mdns-failed', text: 'mDNS port 5353 is taken: ' + (s.mdns.error || '') + (s.mdns.holders.length ? ' (held by ' + s.mdns.holders.join(', ') + ')' : '') };
    if (!s.tcp.listening.length) return { code: 'listening', text: 'AirPlay ports could not be opened: ' + (s.tcp.error || '') };
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
 * opts: { stateDir, port (7000), extraPorts ([7100]), mdnsPort (5353), nft ('nft' | false),
 *         only ([iface names] or null), ignoreSelf (true), loopback (false: our multicast not back to this host), name, log, onChange, onStop, now }
 */
function createProbe(opts) {
    const o = Object.assign({ port: 7000, extraPorts: [7100], mdnsPort: 5353, nft: 'nft', only: null, ignoreSelf: true, name: 'BMW iDrive test' }, opts || {});
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
    let sock = null, servers = [], timers = [], endT = null, sendQ = Promise.resolve();

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
            active: false, startedAt: null, endsAt: null, ifaces: [],
            mdns: { mode: 'off', error: null, holders: [], packets: 0, queries: 0, airplayQueries: 0, answered: 0, announced: 0, lastAirplayQuery: null, peers: [] },
            tcp: { listening: [], error: null, connections: 0, last: null, requests: [] },
            fw: { state: 'off', error: null, chains: [], removed: 0 },
        };
    }

    function status() {
        const s = {
            v: 1, version: VERSION, now: now(), name: id.name, deviceid: id.deviceid,
            active: st.active, startedAt: st.startedAt, endsAt: st.endsAt, ifaces: st.ifaces.length ? st.ifaces : interfaces(o.only),
            mdns: st.mdns, tcp: st.tcp, fw: st.fw, log: lines.slice(-30),
        };
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
            const res = nft.apply(names, { nft: o.nft });
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
            const a = ap.announcement(id, o.port, i.ip, goodbye);
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
        const a = ap.answer(id, o.port, via.ip, p.questions);
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
    function listen(port) {
        return new Promise((res) => {
            const srv = net.createServer((c) => onConnection(c, port));
            srv.on('error', (e) => { st.tcp.error = port + ': ' + (e.code || e.message); log('AirPlay: listen ' + port + ' failed: ' + (e.code || e.message)); res(); });
            srv.listen(port, '0.0.0.0', () => { servers.push(srv); st.tcp.listening.push(port); res(); });
        });
    }

    /* ----- the test ----- */
    function every(ms, f) { const t = setInterval(() => { try { f(); } catch (e) { log(e.message); } }, ms); if (t.unref) t.unref(); timers.push(t); }

    async function start(minutes) {
        const m = Math.max(1, Math.min(60, Number(minutes) || 15));
        if (st.active) { st.endsAt = now() + m * 60000; resetEnd(); log('test extended to ' + m + ' min'); return status(); }
        Object.assign(st, freshState());
        st.active = true; st.startedAt = now(); st.endsAt = now() + m * 60000;
        log('test started (' + m + ' min), receiver "' + id.name + '" ' + id.deviceid);
        if (o.nft) { const n = nft.remove({ nft: o.nft }); if (n) log('firewall: removed ' + n + ' old rules'); }
        st.ifaces = interfaces(o.only);
        log('interfaces: ' + (usedIfaces().map((i) => i.name + '=' + i.ip + ' (' + i.kind + ')').join(', ') || 'none') +
            (st.ifaces.filter((i) => !i.used).length ? '; not used: ' + st.ifaces.filter((i) => !i.used).map((i) => i.name + '=' + i.ip).join(', ') : ''));
        firewall();
        await Promise.all([o.port].concat(o.extraPorts || []).map(listen));
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
    function cleanupSync() { if (o.nft) { try { nft.remove({ nft: o.nft }); } catch (e) { /* best effort */ } } }

    return { start, stop, status, cleanupSync, identity: id };
}

/* ---------------- control socket ---------------- */

/**
 * The control socket: systemd's (socket activation, fd 3) when it handed one over, else a socket of
 * our own at sockPath (a run by hand, the tests). onRequest() is called for every request.
 */
function serveControl(probe, sockPath, log, onRequest) {
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
                const p = m.cmd === 'start' ? probe.start(m.minutes) : m.cmd === 'stop' ? probe.stop('stopped from the app') : Promise.resolve(probe.status());
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
    const stateDir = process.env.PROBE_STATE || '/var/opt/aurelm-airplay-probe/state';
    const sockPath = process.env.PROBE_SOCK || '/run/aurelm-airplay-probe.sock';
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
    serveControl(probe, sockPath, log, () => { lastRequest = Date.now(); });
    log('aurelm-airplay-probe ' + VERSION + ' on node ' + process.version + ', receiver ' + probe.identity.deviceid);
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
