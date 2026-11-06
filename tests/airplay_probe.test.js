'use strict';
/**
 * The AirPlay network test service (native/aurelm-airplay-probe): node tests/airplay_probe.test.js
 * DNS codec, the AirPlay records, the firewall rules (against a fake nft), and the probe end to end on
 * the loopback interface: an mDNS query gets the receiver back, a connection to its port is noted.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const DIR = path.join(__dirname, '..', 'native', 'aurelm-airplay-probe');
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
        '\t\toifname "wlan0" udp dport 5353 accept comment "aurelm-airplay-probe" # handle 9',
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

    const res = nft.apply(['wlan0'], { nft: fake });
    assert.ok(res.every((r) => r.ok && r.changed));
    const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
    // the old rule in ip filter output goes, then 2 + 3 + 2 inserts
    assert.ok(lines.indexOf('delete rule ip filter output handle 9') >= 0);
    const inserts = lines.filter((l) => l.indexOf('insert rule') === 0);
    assert.strictEqual(inserts.length, 7);
    assert.ok(inserts.indexOf('insert rule inet mgu_uplink input iifname "wlan0" tcp dport { 7000, 7100 } accept comment "aurelm-airplay-probe"') >= 0);

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
    const base = () => ({ active: true, name: 'X', ifaces: [{ name: 'wlan0', used: true }], mdns: { mode: 'own', holders: [], airplayQueries: 0, peers: [] }, tcp: { listening: [7000], connections: 0 }, fw: { state: 'open' } });
    assert.strictEqual(P.verdict(Object.assign(base(), { active: false })).code, 'idle');
    assert.strictEqual(P.verdict(Object.assign(base(), { ifaces: [] })).code, 'no-iface');
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

test('probe: an mDNS query is answered and a connection is noted (loopback)', async () => {
    const port = await freePort('tcp'), port2 = await freePort('tcp'), mdnsPort = await freePort('udp');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const probe = P.createProbe({ stateDir: tmp, port, extraPorts: [port2], mdnsPort, nft: false, only: ['lo'], ignoreSelf: false, name: 'Test Car' });
    try {
        const s0 = await probe.start(1);
        assert.strictEqual(s0.active, true);
        assert.strictEqual(s0.mdns.mode, 'own');
        assert.deepStrictEqual(s0.tcp.listening.sort(), [port, port2].sort());

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
    }
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
