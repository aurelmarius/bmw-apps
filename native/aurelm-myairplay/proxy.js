'use strict';
/**
 * proxy.js - the receiver's way to the internet (stage 4: a video the iPhone hands over, played by the head unit).
 *
 * mgu-uplink routes only the uids a tool lists (component.json "internet": true, "uids": [13102]), never root and
 * never nobody, which the receiver runs as. So the receiver's player (FFmpeg, http_proxy) asks this small proxy,
 * a child of the service running as 13102, on 127.0.0.1 only:
 *
 *   CONNECT host:443   a tunnel (https: the player's TLS goes through it, checked end to end against the CA list)
 *   GET http://...     a plain http request passed on
 *
 * Names are resolved through the uplink's DNS servers (/run/mgu-uplink/lease.json): the unit's own resolver does
 * not resolve internet names. Only ports 80 and 443; nothing listens beyond loopback.
 *
 *   node proxy.js            run by the service (fork, uid 13102): PROXY_PORT, PROXY_LEASE; reports over IPC
 *   createProxy({ port, leasePath, hosts, log }).listen() -> Promise<port>
 *
 * Plain Node 8.
 */
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const http = require('http');
const url = require('url');

const PORT = 7390;
const LEASE = '/run/mgu-uplink/lease.json';
const PORTS = [80, 443];

function createProxy(o) {
    const opts = o || {};
    const log = opts.log || (() => {});
    const leasePath = opts.leasePath || LEASE;
    const ports = opts.ports || PORTS;   /* tests: their own servers' ports */
    // tests: fixed names (host=ip,...), in place of the uplink's DNS
    const fixed = {};
    String(opts.hosts || '').split(',').forEach((h) => { const i = h.indexOf('='); if (i > 0) fixed[h.slice(0, i)] = h.slice(i + 1); });
    const st = { connects: 0, requests: 0, open: 0, bytesIn: 0, bytesOut: 0, errors: 0, lastError: null, hosts: {} };

    function lookup(host, cb) {
        if (net.isIP(host)) return cb(null, host);
        if (fixed[host]) return cb(null, fixed[host]);
        let lease = null;
        try { lease = JSON.parse(fs.readFileSync(leasePath, 'utf8')); } catch (e) { lease = null; }
        const servers = (lease && lease.ip && lease.dns || []).filter((s) => net.isIPv4(s));
        if (!servers.length) return cb(Object.assign(new Error(lease ? 'the uplink has no DNS server' : 'no internet: mgu-uplink is not online'), { code: 'EOFFLINE' }));
        const r = new dns.Resolver();
        r.setServers(servers);
        r.resolve4(host, (err, a) => cb(err || (!a || !a.length ? new Error('no address for ' + host) : null), a && a[0]));
    }
    function fail(e, where) {
        st.errors++;
        st.lastError = (where ? where + ': ' : '') + (e.code || e.message);
        log('proxy: ' + st.lastError);
    }
    function count(host) { st.hosts[host] = (st.hosts[host] || 0) + 1; }

    const server = http.createServer((req, res) => {
        // a plain http request: the absolute address in the request line
        const u = url.parse(req.url);
        const port = Number(u.port) || 80;
        if (u.protocol !== 'http:' || !u.hostname || ports.indexOf(port) < 0) { res.writeHead(400); res.end(); return; }
        st.requests++;
        count(u.hostname);
        lookup(u.hostname, (err, ip) => {
            if (err) { fail(err, u.hostname); res.writeHead(502); res.end(); return; }
            const headers = Object.assign({}, req.headers);
            delete headers['proxy-connection'];
            headers.host = u.host;   /* the server's own name, whatever the client put */
            const up = http.request({ host: ip, port, method: req.method, path: u.path, headers, setHost: false }, (r) => {
                res.writeHead(r.statusCode, r.headers);
                r.on('data', (d) => { st.bytesIn += d.length; });
                r.pipe(res);
            });
            up.setTimeout(20000, () => up.abort());
            up.on('error', (e) => { fail(e, u.hostname); if (!res.headersSent) { res.writeHead(502); } res.end(); });
            req.pipe(up);
        });
    });
    server.on('connect', (req, client, head) => {
        // CONNECT host:port: a tunnel
        const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(req.url || '');
        const port = m ? Number(m[2]) : 0;
        client.on('error', () => {});
        if (!m || ports.indexOf(port) < 0) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        const host = m[1];
        st.connects++;
        count(host);
        lookup(host, (err, ip) => {
            if (err) { fail(err, host); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
            const up = net.connect({ host: ip, port });
            let done = false;
            const end = () => { if (done) return; done = true; st.open--; up.destroy(); client.destroy(); };
            st.open++;
            up.setTimeout(30000, end);
            up.on('connect', () => {
                up.setTimeout(0);
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) up.write(head);
                up.on('data', (d) => { st.bytesIn += d.length; });
                client.on('data', (d) => { st.bytesOut += d.length; });
                up.pipe(client);
                client.pipe(up);
            });
            up.on('error', (e) => { fail(e, host); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); end(); });
            up.on('close', end);
            client.on('close', end);
        });
    });
    server.on('clientError', (e, s) => { try { s.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (x) { /* gone */ } });

    function listen() {
        return new Promise((res, rej) => {
            server.once('error', rej);
            server.listen(opts.port == null ? PORT : opts.port, '127.0.0.1', () => { server.removeListener('error', rej); res(server.address().port); });
        });
    }
    function close() { try { server.close(); } catch (e) { /* closed */ } }
    return { listen, close, stats: () => JSON.parse(JSON.stringify(st)), lookup };
}

if (require.main === module) {
    // the service's child (uid 13102): the stats over IPC every 2 s, gone with the service
    const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the parent is gone */ } };
    const p = createProxy({ port: Number(process.env.PROXY_PORT || PORT), leasePath: process.env.PROXY_LEASE || LEASE,
        hosts: process.env.PROXY_HOSTS || '', log: (line) => send({ ev: 'log', line }) });
    p.listen().then((port) => {
        send({ ev: 'ready', port, uid: process.getuid ? process.getuid() : null });
        setInterval(() => send({ ev: 'stats', stats: p.stats() }), 2000);
    }, (e) => { send({ ev: 'error', error: e.message }); process.exit(1); });
    process.on('disconnect', () => process.exit(0));
}

module.exports = { createProxy, PORT, PORTS };
