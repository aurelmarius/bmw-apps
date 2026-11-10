'use strict';
/**
 * The AirPlay network test service (native/aurelm-myairplay): node tests/myairplay_service.test.js
 * DNS codec, the AirPlay records, the firewall rules (against a fake nft), and the probe end to end on
 * the loopback interface: an mDNS query gets the receiver back, a connection to its port is noted.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const DIR = path.join(__dirname, '..', 'native', 'aurelm-myairplay');
const dns = require(path.join(DIR, 'dns'));
const ap = require(path.join(DIR, 'airplay'));
const nft = require(path.join(DIR, 'nft'));
const P = require(path.join(DIR, 'probe'));

const tests = [];
const test = (name, f) => tests.push({ name, f });

test('dns: a response decodes to what was encoded', () => {
    const id = ap.newIdentity('Car');
    const a = ap.announcement(id, 7000, '172.20.10.2', false);
    const p = dns.decode(dns.encodeResponse(a));
    assert.strictEqual(p.qr, true);
    assert.strictEqual(p.answers.length, a.answers.length);
    const ptr = p.answers.filter((r) => r.type === dns.T.PTR).map((r) => r.data);
    assert.deepStrictEqual(ptr, ['Car._airplay._tcp.local', id.deviceid.replace(/:/g, '') + '@Car._raop._tcp.local']);
    const srv = p.answers.find((r) => r.type === dns.T.SRV);
    assert.strictEqual(srv.data.port, 7000);
    assert.strictEqual(p.answers.find((r) => r.type === dns.T.A).data, '172.20.10.2');
});

test('dns: compressed names are read', () => {
    // header, question "a.b.local" PTR, answer name = pointer to offset 12
    const q = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]), dns.nameBytes('a.b.local'), Buffer.from([0, 12, 0, 1]),
        Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 10, 0, 2, 0xc0, 14])]);
    const p = dns.decode(q);
    assert.strictEqual(p.questions[0].name, 'a.b.local');
    assert.strictEqual(p.answers[0].name, 'a.b.local');
    assert.strictEqual(p.answers[0].data, 'b.local');
});

test('airplay: a query for _airplay._tcp gets PTR, SRV, TXT and A', () => {
    const id = ap.newIdentity('Car');
    const a = ap.answer(id, 7000, '10.0.0.5', [{ name: '_airplay._tcp.local', type: dns.T.PTR }]);
    assert.strictEqual(a.answers.length, 1);
    assert.deepStrictEqual(a.additionals.map((r) => r.type).sort(), [dns.T.A, dns.T.TXT, dns.T.SRV].sort());
    assert.ok(a.additionals.find((r) => r.type === dns.T.TXT).data.indexOf('deviceid=' + id.deviceid) >= 0);
    assert.strictEqual(ap.answer(id, 7000, '10.0.0.5', [{ name: '_googlecast._tcp.local', type: dns.T.PTR }]), null);
    assert.ok(ap.isAirplayQuestion({ name: '_RAOP._tcp.local.' }));
});

test('nft: rules go at the top of every IPv4 input and output chain, and come out again', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-'));
    const calls = path.join(tmp, 'calls');
    const listing = path.join(tmp, 'ruleset');
    fs.writeFileSync(listing, [
        'table ip filter { # handle 1',
        '\tchain input { # handle 1',
        '\t\ttype filter hook input priority 0; policy accept;',
        '\t\tiifname "wlan0" tcp dport 22 accept # handle 5',
        '\t}',
        '\tchain output { # handle 2',
        '\t\ttype filter hook output priority 0; policy accept;',
        '\t\toifname "wlan0" udp dport 5353 accept comment "aurelm-myairplay" # handle 9',
        '\t}',
        '\tchain logblocked { # handle 3',
        '\t}',
        '}',
        'table ip6 filter { # handle 2',
        '\tchain input { # handle 1',
        '\t\ttype filter hook input priority 0; policy accept;',
        '\t}',
        '}',
        'table inet mgu_uplink { # handle 3',
        '\tchain input { # handle 1',
        '\t\ttype filter hook input priority 0; policy accept;',
        '\t\tiifname "vethuplink" counter drop # handle 4',
        '\t}',
        '\tchain forward { # handle 2',
        '\t\ttype filter hook forward priority 0; policy accept;',
        '\t}',
        '}',
    ].join('\n'));
    const fake = path.join(tmp, 'nft');
    fs.writeFileSync(fake, '#!/bin/sh\necho "$@" >> ' + calls + '\nif [ "$1" = "-a" ]; then cat ' + listing + '; fi\n');
    fs.chmodSync(fake, 0o755);

    const chains = nft.targets(nft.parse(fs.readFileSync(listing, 'utf8')));
    assert.deepStrictEqual(chains.map((c) => c.family + ' ' + c.table + ' ' + c.chain), ['ip filter input', 'ip filter output', 'inet mgu_uplink input']);

    const res = nft.apply(['wlan0'], { nft: fake, tcpPorts: [7300] });
    assert.ok(res.every((r) => r.ok && r.changed));
    const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
    // the old rule in ip filter output goes, then 2 + 3 + 2 inserts
    assert.ok(lines.indexOf('delete rule ip filter output handle 9') >= 0);
    const inserts = lines.filter((l) => l.indexOf('insert rule') === 0);
    assert.strictEqual(inserts.length, 7);
    assert.ok(inserts.indexOf('insert rule inet mgu_uplink input iifname "wlan0" tcp dport { 7300 } accept comment "aurelm-myairplay"') >= 0);
    // no receiver port (none was free): mDNS only
    assert.deepStrictEqual(nft.rulesFor('input', 'wlan0', []), ['iifname "wlan0" udp dport 5353 accept']);
    // mDNS out only from this service (root)
    assert.ok(inserts.indexOf('insert rule ip filter output oifname "wlan0" meta skuid 0 udp dport 5353 accept comment "aurelm-myairplay"') >= 0);

    fs.writeFileSync(calls, '');
    assert.strictEqual(nft.remove({ nft: fake }), 1);
    assert.ok(fs.readFileSync(calls, 'utf8').indexOf('delete rule ip filter output handle 9') >= 0);
});

test('probe: interfaces are classified, only Wi-Fi-side ones used', () => {
    const raw = {
        lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
        eth0: [{ family: 'IPv4', address: '160.48.199.99', netmask: '255.255.255.0', internal: false }],
        vethuplink: [{ family: 4, address: '172.20.10.3', netmask: '255.255.255.240', internal: false }],
        wlan_bridge: [{ family: 'IPv4', address: '172.16.222.97', netmask: '255.255.255.0', internal: false }],
    };
    const i = P.interfaces(null, raw);
    assert.deepStrictEqual(i.filter((x) => x.used).map((x) => x.name + ':' + x.kind), ['vethuplink:iphone-hotspot', 'wlan_bridge:car-wifi']);
    assert.ok(P.sameSubnet('172.20.10.1', '172.20.10.3', '255.255.255.240'));
    assert.ok(!P.sameSubnet('172.20.10.17', '172.20.10.3', '255.255.255.240'));
});

test('probe: the verdict', () => {
    const base = () => ({ active: true, name: 'X', ifaces: [{ name: 'wlan0', used: true }], mdns: { mode: 'own', holders: [], airplayQueries: 0, peers: [] }, tcp: { port: 7300, listening: [7300], connections: 0 }, fw: { state: 'open' } });
    assert.strictEqual(P.verdict(Object.assign(base(), { active: false })).code, 'idle');
    assert.strictEqual(P.verdict(Object.assign(base(), { ifaces: [] })).code, 'no-iface');
    assert.strictEqual(P.verdict(Object.assign(base(), { tcp: { port: null, listening: [], connections: 0, error: '47000: EADDRINUSE' } })).code, 'listening');
    assert.strictEqual(P.verdict(base()).code, 'waiting');
    const s = base(); s.mdns.peers = [{ ip: '1.2.3.4' }];
    assert.strictEqual(P.verdict(s).code, 'heard-phone');
    s.mdns.airplayQueries = 2; s.mdns.lastAirplayQuery = { ip: '1.2.3.4' };
    assert.strictEqual(P.verdict(s).code, 'asked');
    s.tcp.connections = 1; s.tcp.last = { ip: '1.2.3.4', request: 'GET /info RTSP/1.0' };
    assert.strictEqual(P.verdict(s).code, 'connected');
    const f = base(); f.mdns.mode = 'failed'; f.mdns.error = 'EADDRINUSE'; f.mdns.holders = ['mdnsd (1)'];
    assert.ok(/mdnsd/.test(P.verdict(f).text));
});

/* ---- end to end on lo ---- */
function freePort(type) {
    return new Promise((res) => {
        if (type === 'udp') { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); return; }
        const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

test('probe: a taken port is passed over, an mDNS query is answered, a connection is noted (loopback)', async () => {
    const taken = await freePort('tcp'), port = await freePort('tcp'), mdnsPort = await freePort('udp');
    // the first port is held (as the car's CarPlay holds 7000): the next one is the receiver's
    const holder = await new Promise((res) => { const h = net.createServer().listen(taken, '0.0.0.0', () => res(h)); });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const probe = P.createProbe({ stateDir: tmp, ports: [taken, port], mdnsPort, nft: false, only: ['lo'], ignoreSelf: false, name: 'Test Car' });
    try {
        const s0 = await probe.start(1);
        assert.strictEqual(s0.active, true);
        assert.strictEqual(s0.mdns.mode, 'own');
        assert.strictEqual(s0.tcp.port, port);
        assert.deepStrictEqual(s0.tcp.listening, [port]);
        assert.strictEqual(s0.tcp.busy[0].port, taken);
        assert.strictEqual(s0.tcp.busy[0].error, 'EADDRINUSE');
        assert.ok(s0.tcp.busy[0].holders.some((h) => /node/.test(h)), JSON.stringify(s0.tcp.busy));

        // a legacy unicast query (from a port that is not mdnsPort) is answered to that port
        const reply = await new Promise((res, rej) => {
            const c = dgram.createSocket('udp4');
            const t = setTimeout(() => { c.close(); rej(new Error('no mDNS answer')); }, 3000);
            c.on('message', (m) => { const p = dns.decode(m); if (p.qr && p.id === 0x1234) { clearTimeout(t); c.close(); res(p); } });
            c.bind(0, '127.0.0.1', () => {
                const q = dns.encodeQuery(['_airplay._tcp.local']);
                q.writeUInt16BE(0x1234, 0);
                c.send(q, mdnsPort, '127.0.0.1');
            });
        });
        assert.strictEqual(reply.questions[0].name, '_airplay._tcp.local');
        assert.strictEqual(reply.answers[0].data, 'Test Car._airplay._tcp.local');
        assert.ok(reply.records.find((r) => r.type === dns.T.SRV && r.data.port === port));
        assert.strictEqual(probe.status().verdict.code, 'asked');

        // what an iPhone sends first
        const answer = await new Promise((res, rej) => {
            const c = net.connect(port, '127.0.0.1', () => c.write('GET /info RTSP/1.0\r\nCSeq: 3\r\nUser-Agent: AirPlay/880.3\r\n\r\n'));
            let b = '';
            c.on('data', (d) => { b += d; });
            c.on('end', () => res(b));
            c.on('error', rej);
        });
        assert.ok(/^RTSP\/1\.0 503/.test(answer), answer);
        assert.ok(/CSeq: 3/.test(answer));
        const s = probe.status();
        assert.strictEqual(s.verdict.code, 'connected');
        assert.strictEqual(s.tcp.last.request, 'GET /info RTSP/1.0');
        assert.strictEqual(s.tcp.last.agent, 'AirPlay/880.3');

        const s2 = await probe.stop('test');
        assert.strictEqual(s2.active, false);
        assert.deepStrictEqual(s2.tcp.listening, []);
        // the identity is kept for the next run
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'identity.json'), 'utf8')).deviceid, probe.identity.deviceid);
    } finally {
        await probe.stop('finally');
        holder.close();
    }
});

function spawnService() {
    const { spawn } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
    const sock = path.join(tmp, 'ctl.sock');
    const env = Object.assign({}, process.env, { PROBE_SOCK: sock, PROBE_STATE: tmp, PROBE_NFT: 'off' });
    const svc = spawn(process.execPath, [path.join(DIR, 'probe.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const r = { svc, sock, out: '' };
    r.exited = new Promise((res) => svc.on('exit', (c) => res(c)));
    svc.stdout.on('data', (d) => { r.out += d; });
    svc.stderr.on('data', (d) => { r.out += d; });
    return r;
}

test('service: started as systemd would (control socket, check.js), stopped with SIGTERM', async () => {
    const { spawnSync } = require('child_process');
    const s = spawnService();
    try {
        const r = spawnSync(process.execPath, [path.join(DIR, 'check.js'), s.sock], { encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr + s.out);
        assert.ok(/answers: idle/.test(r.stdout), r.stdout);
        // root only while the app is not installed (no /var/opt/public/oap here)
        assert.strictEqual(fs.statSync(s.sock).mode & 0o777, 0o600);
    } finally {
        s.svc.kill('SIGTERM');
        assert.strictEqual(await s.exited, 0, s.out);
    }
    assert.ok(/exit: SIGTERM/.test(s.out), s.out);
});

test('service: the app asks an older version to end: it answers, then exits 0', async () => {
    const { spawnSync } = require('child_process');
    const s = spawnService();
    try {
        assert.strictEqual(spawnSync(process.execPath, [path.join(DIR, 'check.js'), s.sock], { encoding: 'utf8', timeout: 20000 }).status, 0, s.out);
        const ex = await new Promise((res, rej) => {
            const c = net.connect(s.sock, () => c.write('{"cmd":"exit"}\n'));
            let b = ''; c.setEncoding('utf8'); c.on('data', (d) => { b += d; }); c.on('end', () => res(b)); c.on('error', rej);
        });
        assert.strictEqual(JSON.parse(ex.split('\n')[0]).exiting, true);
        assert.strictEqual(await s.exited, 0, s.out);
        assert.ok(/exit: asked by the app/.test(s.out), s.out);
    } finally {
        if (s.svc.exitCode === null) s.svc.kill('SIGKILL');
    }
});

test('cleanup: never fails, also without nft', () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(DIR, 'cleanup.js')], { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: '/nonexistent' }) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('sockgroup: the socket gets the app\'s own group, root only without the app', () => {
    const sg = require(path.join(DIR, 'sockgroup'));
    const oap = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-'));
    const sock = path.join(oap, 's.sock');
    fs.writeFileSync(sock, '');
    const app = (uid, name) => {
        fs.mkdirSync(path.join(oap, 'oap_' + uid));
        fs.mkdirSync(path.join(oap, 'oap_' + uid, 'source'));
        fs.writeFileSync(path.join(oap, 'oap_' + uid, 'source', 'package.json'), JSON.stringify({ name }));
        if (process.getuid && process.getuid() === 0) fs.chownSync(path.join(oap, 'oap_' + uid), uid, uid);
    };
    app(12300, 'some_other_app');
    assert.strictEqual(sg.apply(sock, oap), null);
    assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o600);
    app(12345, 'aurelm_myairplay');
    const want = fs.statSync(path.join(oap, 'oap_12345')).gid;
    if (want === 0) return;   // not root here: no folder of another group to find
    assert.strictEqual(sg.apply(sock, oap), 12345);
    assert.strictEqual(fs.statSync(sock).gid, 12345);
    assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o660);
});

/* ---- the receiver test (stage 1) ---- */
function fakeReceiver(dir) {
    // prints what uxplay-mgu's renderer prints for an iPhone that mirrors, and its arguments and env
    const f = path.join(dir, 'fake-uxplay');
    fs.writeFileSync(f, '#!' + process.execPath + '\n' + [
        "const out = (j) => process.stdout.write('MGU ' + JSON.stringify(j) + '\\n');",
        "console.log('args ' + process.argv.slice(2).join(' ') + ' ip ' + process.env.UXPLAY_MDNS_IPV4 + ' v6off ' + process.env.UXPLAY_MDNS_NO_IPV6);",
        "console.log('*** ERROR:   3 seconds since last client feedback request (expected every two seconds); client may be offline');",
        "setTimeout(() => out({ ev: 'client', model: 'iPhone18,2', name: 'Test \"iPhone' }), 100);",
        "setTimeout(() => out({ ev: 'video', codec: 'h264', w: 498, h: 1080, sw: 498, sh: 1080 }), 200);",
        "setTimeout(() => out({ ev: 'start' }), 250);",
        "setTimeout(() => out({ ev: 'decoder', ok: true, path: process.env.MGU_VIDEO_PATH, w: 1920, h: 720 }), 300);",
        "setTimeout(() => { out({ ev: 'audio', ct: 8 }); out({ ev: 'sound', ok: true, device: process.env.MGU_AUDIO.slice(5), ct: 8 }); }, 320);",
        "setTimeout(() => { require('fs').writeFileSync(process.env.MGU_VIDEO_PATH, 'MGVF'); out({ ev: 'stats', frames: 60, fps: 30, kbps: 4200, idr: 1, sps: 1, audio: 10, shown: 58, decerr: 0 }); }, 400);",
        "setTimeout(() => out({ ev: 'soundstop' }), 1400);",
        "process.on('SIGTERM', () => { out({ ev: 'stop', frames: 60 }); process.exit(0); });",
        "setInterval(() => {}, 1000);",
    ].join('\n'));
    fs.chmodSync(f, 0o755);
    return f;
}

test('receiver: started with its address and ports, its reports read, stopped', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-'));
    fs.chmodSync(tmp, 0o755);   // run as root, the receiver runs as nobody: it must reach its binary
    const videoPath = path.join(tmp, 'mgu-video-test');
    const probe = P.createProbe({ stateDir: tmp, nft: false, only: ['lo'], rxBin: fakeReceiver(tmp), rxName: 'BMW iDrive', rxUid: null, rxVideoPath: videoPath });
    try {
        const s0 = await probe.start(1, 'receiver');
        assert.strictEqual(s0.mode, 'receiver');
        assert.strictEqual(s0.rx.running, true);
        assert.strictEqual(s0.rx.iface, 'lo');
        await new Promise((r) => setTimeout(r, 900));
        const s = probe.status();
        assert.strictEqual(s.rx.client.model, 'iPhone18,2');
        assert.strictEqual(s.rx.video.w, 498);
        assert.strictEqual(s.rx.stream.fps, 30);
        // stage 2: the GPU decoder and its frame file
        assert.deepStrictEqual([s.rx.decoder.ok, s.rx.decoder.w, s.rx.decoder.h, s.rx.decoder.path], [true, 1920, 720, videoPath]);
        assert.strictEqual(s.rx.stream.shown, 58);
        // stage 3: the sound into SmartXbar's CarLife input
        assert.deepStrictEqual([s.rx.sound.ok, s.rx.sound.device, s.rx.sound.ct], [true, 'plug:smartx:CarLifeMedia_CF_48_STEREO', 8]);
        assert.strictEqual(s.rx.soundRunning, true);
        // the iPhone ends the session (stopped on the phone): the sound is no longer running
        await new Promise((r) => setTimeout(r, 700));
        assert.strictEqual(probe.status().rx.soundRunning, false);
        assert.ok(probe.status().log.some((l) => /the iPhone ended the session/.test(l)));
        assert.ok(fs.existsSync(videoPath));
        assert.strictEqual(s.verdict.code, 'rx-video');
        assert.ok(/PASS: Test .iPhone mirrors 498x1080 at 30 fps/.test(s.verdict.text), s.verdict.text);
        const args = s.rx.lines.find((l) => / args /.test(l));
        assert.ok(/-n BMW iDrive -nh -p 7300 -m [0-9a-f:]{17} -s 1920x720@60 ip 127\.0\.0\.1 v6off 1/.test(args), args);
        // UxPlay's per-second complaint is not kept
        assert.ok(!s.rx.lines.some((l) => /client feedback/.test(l)));
        const s2 = await probe.stop('test');
        assert.strictEqual(s2.active, false);
        // what the receiver got stays on the page after the test; its frame file does not
        assert.strictEqual(s2.rx.running, false);
        assert.ok(!fs.existsSync(videoPath), 'the frame file is left');
        assert.strictEqual(s2.verdict.code, 'rx-video');
    } finally { await probe.stop('finally'); }
});

test('receiver: end-session starts the receiver again (the iPhone stops mirroring), only with a client', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rxend-'));
    const probe = P.createProbe({ stateDir: tmp, nft: false, only: ['lo'], rxBin: fakeReceiver(tmp), rxUid: null, rxVideoPath: path.join(tmp, 'v') });
    try {
        await probe.start(1, 'receiver');
        await new Promise((r) => setTimeout(r, 600));
        const pid = probe.status().rx.pid;
        assert.ok(probe.status().rx.client);
        const s = await probe.endSession('test');
        assert.strictEqual(s.rx.running, true);
        assert.notStrictEqual(s.rx.pid, pid);
        assert.strictEqual(s.rx.client, null);
        assert.ok(s.log.some((l) => /ending the iPhone's session \(test\)/.test(l)));
        // without a client: nothing to end
        const pid2 = s.rx.pid;
        assert.strictEqual((await probe.endSession('again')).rx.pid, pid2);
    } finally { await probe.stop('finally'); }
});

test('receiver: one that cannot start is reported, and the test still stops', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rxbad-'));
    const bad = path.join(tmp, 'not-executable');
    fs.writeFileSync(bad, 'nothing');
    const probe = P.createProbe({ stateDir: tmp, nft: false, only: ['lo'], rxBin: bad });
    await probe.start(1, 'receiver');
    await new Promise((r) => setTimeout(r, 300));
    const s = probe.status();
    assert.strictEqual(s.rx.running, false);
    assert.ok(/start: /.test(s.rx.error), s.rx.error);
    assert.strictEqual(s.verdict.code, 'rx-failed');
    const t0 = Date.now();
    await probe.stop('test');
    assert.ok(Date.now() - t0 < 2000);
});

test('receiver: the verdict while waiting, with sound only, and when it failed', () => {
    const base = (rx) => ({ active: true, mode: 'receiver', ifaces: [{ name: 'wlan_bridge', used: true }], fw: { state: 'open' }, mdns: {}, tcp: {}, rx });
    assert.strictEqual(P.verdict(base({ running: true, name: 'BMW iDrive', iface: 'wlan_bridge', stream: {} })).code, 'rx-waiting');
    assert.strictEqual(P.verdict(base({ running: true, client: { name: 'X' }, stream: {} })).code, 'rx-connected');
    assert.strictEqual(P.verdict(base({ running: true, client: { name: 'X' }, audio: { ct: 8 }, stream: { frames: 0 } })).code, 'rx-audio-only');
    assert.strictEqual(P.verdict(base({ running: false, error: 'the receiver exited (code 1)', stream: {} })).code, 'rx-failed');
    assert.strictEqual(P.verdict(base({ running: true, client: { name: 'X' }, video: { w: 1, h: 1 }, stream: { frames: 9 }, decoder: { ok: false, error: 'decoder: x' } })).code, 'rx-decoder-failed');
});

test('nft: the receiver test opens tcp and udp 7300-7302, out only for its uid', () => {
    const r = nft.rulesFor('output', 'wlan_bridge', [7300, 7301, 7302], { udpPorts: [7300, 7301, 7302], uid: 65534 });
    assert.deepStrictEqual(r, [
        'oifname "wlan_bridge" tcp sport { 7300, 7301, 7302 } accept',
        'oifname "wlan_bridge" meta skuid 65534 udp sport { 7300, 7301, 7302 } accept',
        'oifname "wlan_bridge" meta skuid 65534 udp dport 5353 accept',
        'oifname "wlan_bridge" meta skuid 65534 udp sport 5353 accept',
    ]);
    assert.strictEqual(nft.rulesFor('input', 'wlan_bridge', [7300], { udpPorts: [7300] }).length, 3);
});

const REAL = path.join(__dirname, '..', 'native', 'uxplay-mgu', 'build', 'uxplay-mgu');
test('receiver: uxplay-mgu asks for the head unit\'s loader, /lib/ld-linux-x86-64.so.2 (skipped when not built)', () => {
    if (!fs.existsSync(REAL)) { console.log('     (uxplay-mgu not built: skipped)'); return; }
    // the unit has no /lib64: a binary that asks for /lib64/ld-linux-x86-64.so.2 does not start there (ENOENT, 0.6.0)
    const b = fs.readFileSync(REAL);
    assert.ok(b.indexOf('/lib/ld-linux-x86-64.so.2\0') >= 0, 'interpreter is not /lib/ld-linux-x86-64.so.2');
    assert.strictEqual(b.indexOf('/lib64/ld-linux-x86-64.so.2'), -1);
});

test('receiver: the real uxplay-mgu runs, listens on 7301 and ends with the test (skipped when not built, or without /lib/ld-linux-x86-64.so.2)', async () => {
    if (!fs.existsSync(REAL)) { console.log('     (uxplay-mgu not built: skipped)'); return; }
    if (!fs.existsSync('/lib/ld-linux-x86-64.so.2')) { console.log('     (no /lib/ld-linux-x86-64.so.2 here, as on the unit: skipped; build.sh runs it in ubuntu:18.04)'); return; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rxreal-'));
    fs.chmodSync(tmp, 0o755);
    // the unit's video libraries: their link-only stubs (build/stub), enough to start; nothing is decoded here
    const probe = P.createProbe({ stateDir: tmp, nft: false, only: ['lo'], rxBin: REAL, rxName: 'BMW iDrive test rx', rxUid: null,
        rxEnv: { LD_LIBRARY_PATH: path.join(path.dirname(REAL), 'stub') }, rxVideoPath: path.join(tmp, 'mgu-video-test') });
    try {
        await probe.start(1, 'receiver');
        await new Promise((r) => setTimeout(r, 1500));
        const s = probe.status();
        assert.strictEqual(s.rx.running, true, JSON.stringify(s.rx));
        await new Promise((res, rej) => { const c = net.connect(7301, '127.0.0.1', () => { c.destroy(); res(); }); c.on('error', rej); });
        const pid = s.rx.pid;
        await probe.stop('test');
        assert.throws(() => process.kill(pid, 0));   // gone
    } finally { await probe.stop('finally'); }
});

/* ---- stage 4: AirPlay's video button (the iPhone hands over an address), and the proxy ---- */
function fakeVideoReceiver(dir) {
    // what uxplay-mgu prints for YouTube through the video button: its arguments and environment, then the player's events
    const f = path.join(dir, 'fake-uxplay-hls');
    fs.writeFileSync(f, '#!' + process.execPath + '\n' + [
        "const out = (j) => process.stdout.write('MGU ' + JSON.stringify(j) + '\\n');",
        "console.log('args ' + process.argv.slice(2).join(' '));",
        "console.log('id ' + process.env.MGU_MODEL + ' ' + process.env.MGU_SRCVERS);",
        "console.log('env LANGUAGE=' + process.env.LANGUAGE + ' http_proxy=' + process.env.http_proxy + ' no_proxy=' + process.env.no_proxy + ' ca=' + process.env.MGU_CA_FILE);",
        "setTimeout(() => out({ ev: 'client', model: 'iPhone18,2', name: 'Test iPhone' }), 100);",
        "setTimeout(() => out({ ev: 'hls', url: 'http://localhost:7300/master.m3u8', start: 12.5 }), 150);",
        "setTimeout(() => out({ ev: 'hlsopen', w: 1920, h: 1080, vcodec: 'h264', acodec: 'aac', rate: 44100, ch: 2, dur: 212.4, variants: 4, format: 'hls' }), 200);",
        "setTimeout(() => { out({ ev: 'sound', ok: true, device: 'plug:smartx:CarLifeMedia_CF_48_STEREO', ct: 0 }); out({ ev: 'start' }); }, 220);",
        "setTimeout(() => out({ ev: 'decoder', ok: true, path: process.env.MGU_VIDEO_PATH, w: 1920, h: 720 }), 260);",
        "setTimeout(() => out({ ev: 'hlspos', pos: 13.7, dur: 212.4, paused: true, buffering: false }), 300);",
        "setTimeout(() => out({ ev: 'hlsseek', to: 60, ok: true }), 320);",
        "setTimeout(() => out({ ev: 'stats', frames: 90, fps: 30, kbps: 3800, idr: 2, sps: 2, audio: 120, shown: 88, decerr: 0 }), 340);",
        "let inb = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { inb += d; let i; while ((i = inb.indexOf('\\n')) >= 0) { console.log('stdin ' + inb.slice(0, i)); inb = inb.slice(i + 1); } });",
        "process.on('SIGTERM', () => { out({ ev: 'hlsend', why: 'stopped' }); out({ ev: 'soundstop' }); out({ ev: 'stop', frames: 0 }); process.exit(0); });",
        "setInterval(() => {}, 1000);",
    ].join('\n'));
    fs.chmodSync(f, 0o755);
    return f;
}

test('receiver with the video button: -hls and the H.264 filter, the proxy for its internet, the video reported', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rxhls-'));
    fs.chmodSync(tmp, 0o755);
    const port = await freePort();
    const probe = P.createProbe({ stateDir: tmp, nft: false, only: ['lo'], rxBin: fakeVideoReceiver(tmp), rxUid: null, rxVideoPath: path.join(tmp, 'v'),
        proxyUid: null, proxyPort: port });
    try {
        let s = await probe.start(1, 'receiver', true);
        assert.strictEqual(s.rx.hlsOn, true);
        await new Promise((r) => setTimeout(r, 900));
        s = probe.status();
        const args = s.rx.lines.find((l) => / args /.test(l));
        assert.ok(/ -hls -custom AVC:720,720;HEVC:0;VP9:0;AV1:0$/.test(args), args);
        const env = s.rx.lines.find((l) => / env /.test(l));
        assert.ok(new RegExp('LANGUAGE=zxx http_proxy=http://127\\.0\\.0\\.1:' + port + ' no_proxy=localhost,127\\.0\\.0\\.1 ca=.*aurelm-myairplay/cacert\\.pem$').test(env), env);
        // the proxy runs (a child, as the internet uid on the car)
        assert.strictEqual(s.rx.proxy.state, 'on');
        await new Promise((res, rej) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); res(); }); c.on('error', rej); });
        // the video's progress
        assert.strictEqual(s.rx.hls.url, 'http://localhost:7300/master.m3u8');
        assert.deepStrictEqual([s.rx.hls.open.w, s.rx.hls.open.h, s.rx.hls.open.acodec, s.rx.hls.dur], [1920, 1080, 'aac', 212.4]);
        assert.deepStrictEqual([s.rx.hls.pos, s.rx.hls.paused, s.rx.hls.seeks], [13.7, true, 1]);
        assert.strictEqual(s.rx.videoRunning, true);
        assert.strictEqual(s.rx.soundRunning, true);
        assert.strictEqual(s.rx.stream.shown, 88);
        assert.strictEqual(s.verdict.code, 'rx-hls');
        // the app's controls reach the receiver's player, one a line on its stdin
        probe.video('pause'); probe.video('seek', 61.5); probe.video('bogus');
        await new Promise((r) => setTimeout(r, 200));
        const got = probe.status().rx.lines.filter((l) => / stdin /.test(l)).map((l) => l.replace(/^.* stdin /, ''));
        assert.deepStrictEqual(got, ['pause', 'seek 61.500']);
        assert.ok(/PASS: the head unit plays the video the iPhone sent \(1920x1080\)/.test(s.verdict.text), s.verdict.text);
        // the setting switched off: the receiver starts again without it, and the proxy goes
        s = await probe.start(1, 'receiver', false);
        assert.strictEqual(s.rx.hlsOn, false);
        assert.strictEqual(s.rx.proxy, null);
        await new Promise((r) => setTimeout(r, 400));
        await new Promise((res) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); res('open'); }); c.on('error', () => res('closed')); }).then((v) => assert.strictEqual(v, 'closed'));
        const args2 = probe.status().rx.lines.find((l) => / args /.test(l));
        assert.ok(args2 && args2.indexOf('-hls') < 0, args2);
    } finally { await probe.stop('finally'); }
});

test('receiver identity: AppleTV5,4 by default; the classic one is another receiver (name, id) as AppleTV3,2', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rxid-'));
    fs.chmodSync(tmp, 0o755);
    const probe = P.createProbe({ stateDir: tmp, nft: false, only: ['lo'], rxBin: fakeVideoReceiver(tmp), rxUid: null, rxVideoPath: path.join(tmp, 'v'), proxyUid: null, proxyPort: await freePort() });
    const idLine = () => probe.status().rx.lines.find((l) => / id /.test(l));
    const argsLine = () => probe.status().rx.lines.find((l) => / args /.test(l));
    try {
        let s = await probe.start(1, 'receiver', false);
        await new Promise((r) => setTimeout(r, 400));
        assert.ok(/ id AppleTV5,4 366\.0$/.test(idLine()), idLine());
        const dev1 = / -m (\S+)/.exec(argsLine())[1];
        assert.ok(/-n BMW iDrive -nh/.test(argsLine()));
        s = await probe.start(1, 'receiver', false, 'classic');
        assert.strictEqual(s.rx.identity, 'classic');
        assert.strictEqual(s.rx.name, 'BMW iDrive Video');
        await new Promise((r) => setTimeout(r, 400));
        assert.ok(/ id AppleTV3,2 220\.68$/.test(idLine()), idLine());
        assert.ok(/-n BMW iDrive Video -nh/.test(argsLine()), argsLine());
        const dev2 = / -m (\S+)/.exec(argsLine())[1];
        assert.notStrictEqual(dev1, dev2);
        assert.strictEqual(dev1.slice(0, 15), dev2.slice(0, 15));
        // the iPhone's requests, short, in the receiver's lines
        assert.ok(probe.status().log.some((l) => /identity classic/.test(l)));
    } finally { await probe.stop('finally'); }
});

test('AirPlay network: the car Wi-Fi first by default, the iPhone hotspot first when set', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rxnet-'));
    const probe = P.createProbe({ stateDir: tmp, nft: false, only: ['lo'], rxUid: null, proxyUid: null });
    // the order is the probe's; checked through its source (the interfaces of this machine are not a car's)
    assert.ok(/st\.net === 'hotspot' \? \['iphone-hotspot', 'uplink', 'car-wifi', 'wifi'\] : \['car-wifi', 'iphone-hotspot', 'uplink', 'wifi'\]/.test(fs.readFileSync(require.resolve('../native/aurelm-myairplay/probe.js'), 'utf8')));
    assert.ok(probe);
});

test('proxy: CONNECT tunnels to the allowed ports only, plain http passed on, names through the uplink', async () => {
    const { createProxy } = require(path.join(__dirname, '..', 'native', 'aurelm-myairplay', 'proxy'));
    const http = require('http');
    // a "server on the internet": echoes over raw tcp, and answers http
    const echo = net.createServer((c) => c.pipe(c)).listen(0, '127.0.0.1');
    const web = http.createServer((req, res) => res.end('hello ' + req.url + ' ' + req.headers.host)).listen(0, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 50));
    const ep = echo.address().port, wp = web.address().port;
    const p = createProxy({ port: 0, ports: [ep, wp], hosts: 'video.example=127.0.0.1', leasePath: '/nonexistent' });
    const pp = await p.listen();
    const connect = (target) => new Promise((res) => {
        const c = net.connect(pp, '127.0.0.1', () => c.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'));
        let buf = '';
        c.on('data', (d) => {
            buf += d;
            if (/^HTTP\/1\.1 200/.test(buf) && buf.indexOf('\r\n\r\n') > 0 && buf.indexOf('ping') < 0) c.write('ping');
            if (buf.indexOf('ping') > 0 || /^HTTP\/1\.1 [45]/.test(buf)) { c.destroy(); res(buf); }
        });
        c.on('error', () => res(buf));
    });
    try {
        assert.ok(/^HTTP\/1\.1 200[\s\S]*ping$/.test(await connect('video.example:' + ep)));
        assert.ok(/^HTTP\/1\.1 403/.test(await connect('video.example:22')));
        // a name the uplink would resolve, but it is offline here
        assert.ok(/^HTTP\/1\.1 502/.test(await connect('elsewhere.example:' + ep)));
        const body = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: pp, path: 'http://video.example:' + wp + '/seg1.ts' }, (r) => { let t = ''; r.on('data', (d) => { t += d; }); r.on('end', () => res(t)); }).on('error', rej));
        assert.strictEqual(body, 'hello /seg1.ts video.example:' + wp);
        const st = p.stats();
        assert.strictEqual(st.connects, 2);
        assert.strictEqual(st.requests, 1);
        assert.ok(/EOFFLINE/.test(st.lastError), st.lastError);
    } finally { p.close(); echo.close(); web.close(); }
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
