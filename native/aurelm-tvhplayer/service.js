'use strict';
/**
 * service.js - Tvheadend on the head unit, for the app "TVH Player" (apps/aurelm_tvhplayer). Root, the unit's /usr/bin/node.
 *
 * Started by the app's first connection to /run/aurelm-tvhplayer.sock (socket activation), never at boot; ends 10 minutes
 * after the app's last request while nothing plays.
 *
 *   client.js     the Tvheadend client, a child running as the tool's internet uid (mgu-uplink routes it, never
 *                 root): the server's API, the channels and what is on now, the channel that plays (playback.js)
 *                 and its stream
 *   tvh-player    the channel (player.js): started here as root for its frame file, it runs as nobody with the
 *                 groups video and mgu_alsa; the stream comes from the client through this process
 *   sign-in page  while the app asks for it (10 minutes): an HTTP page on the car Wi-Fi (the phone, which is on
 *                 it for wireless CarPlay, opens it from the QR code), and one accept rule per chain for its port
 *                 on the car Wi-Fi's interfaces (nft.js); both go when it closes
 *   state         /var/opt/aurelm-tvhplayer/state: account.json (server, user, password: Tvheadend has no token; 0600,
 *                 root's), prefs.json (the app's profile settings), logos/<channel uuid>.png (fetched once, a week)
 *
 * Control: one JSON object per line: {"cmd":"status"}, {"cmd":"signin-open"}, {"cmd":"signin-close"},
 * {"cmd":"signout"}, {"cmd":"play","uuid":...}, {"cmd":"stop"}, {"cmd":"prefs","profile":...,"adaptive":...},
 * {"cmd":"refresh"}, {"cmd":"exit"}; the reply is the status.
 * {"cmd":"channels"}: the channels and what is on now instead ({ at, channels: [{ uuid, name, number }], epg }).
 * {"cmd":"epg","uuid":...}: a channel's programme for the next 24 hours instead ({ uuid, events: [{ start, stop, title,
 * subtitle, episode, text }] } or { uuid, error }); kept 3 minutes.
 * {"cmd":"logo","uuid":...}: a channel's logo instead ({ uuid, png: base64 } or { uuid, none: true, why, quiet: the server
 * gives it no public logo }); fetched once per address (the logo's ?v=), kept in state/logos (<uuid>.png, <uuid>.url) for as
 * long as that address stays; one not to be had is asked again after 30 minutes.
 *
 * The app's watch: while a channel plays, the app asks every second or two; 90 s without a request (the app was
 * closed, or crashed) and the channel stops, so the internet is not used for a picture and a sound nobody gets.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');
const { fork } = require('child_process');
const nftm = require('./nft');
const pagem = require('./page');
const { createPlayer } = require('./player');

const VERSION = '1.0.1';
const PAGE_PORT = 8492;   // Emby's page is 8490, TVH (bmw-test-apps) 8491: all may be open at once
const PAGE_MINUTES = 10;
const IDLE_MS = 10 * 60 * 1000;
const WATCH_MS = 90 * 1000;
const NET_UID = 13103;    // component.json "uids": the only uid of this tool mgu-uplink routes
const LOG_LINES = 40;
const PLAYING = ['loading', 'playing', 'buffering'];
const LOGO_NONE_MS = 30 * 60 * 1000;

function createService(opts) {
    const o = Object.assign({
        stateDir: process.env.TVH_STATE || '/var/opt/aurelm-tvhplayer/state',
        nft: process.env.TVH_NFT === 'off' ? null : (process.env.TVH_NFT || 'nft'),
        uid: process.env.TVH_UID === '' ? null : Number(process.env.TVH_UID || NET_UID),
        pagePort: Number(process.env.TVH_PAGE_PORT || PAGE_PORT),
        pageIfaces: process.env.TVH_PAGE_IFACES ? process.env.TVH_PAGE_IFACES.split(',') : null,
        leasePath: process.env.TVH_LEASE || '/run/mgu-uplink/lease.json',
        now: Date.now,
        childEnv: {},
        playerBin: process.env.TVH_PLAYER || path.join(__dirname, 'tvh-player'),
        playerEnv: {},
        videoPath: undefined,
        watchMs: WATCH_MS,
    }, opts || {});
    const now = o.now;
    const lines = [];
    function log(s) {
        const t = new Date(now()).toISOString().slice(11, 19);
        lines.push(t + ' ' + s);
        if (lines.length > LOG_LINES) lines.shift();
        console.log(s);
    }

    /* ---------- state ---------- */
    try { fs.mkdirSync(o.stateDir, 0o700); } catch (e) { /* there */ }
    try { fs.chmodSync(o.stateDir, 0o700); } catch (e) { /* not ours to change */ }
    const file = (n) => path.join(o.stateDir, n);
    const readJson = (n) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return null; } };
    function writeJson(n, v) {
        const tmp = file(n + '.tmp');
        fs.writeFileSync(tmp, JSON.stringify(v, null, 1), { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file(n));
    }
    let account = readJson('account.json');
    if (account && (!account.server || !account.user)) account = null;
    let prefs = readJson('prefs.json') || null;

    const st = { version: VERSION, client: { state: account ? 'starting' : 'signed-out' }, page: { open: false }, lastSignIn: null, error: null, playback: null };
    let chans = { at: null, channels: [], epg: {} };

    /* ---------- a channel's programme (the guide), kept 3 minutes ---------- */
    const epgKept = {}, epgWait = {};
    function epg(uuid) {
        if (!/^[0-9a-f]{32}$/.test(uuid)) return Promise.resolve({ uuid, error: 'not a channel' });
        const k = epgKept[uuid];
        if (k && now() - k.at < 3 * 60000) return Promise.resolve({ uuid, events: k.events });
        startChild();
        if (!child || !account) return Promise.resolve({ uuid, error: 'not signed in' });
        return new Promise((res) => {
            const id = crypto.randomBytes(6).toString('hex');
            const t = setTimeout(() => { if (epgWait[id]) { delete epgWait[id]; res({ uuid, error: 'the server did not answer in time' }); } }, 20000);
            epgWait[id] = (m) => {
                clearTimeout(t);
                if (!m.ok) { log('epg: ' + m.error); return res({ uuid, error: m.error }); }
                epgKept[uuid] = { at: now(), events: m.events };
                res({ uuid, events: m.events });
            };
            toChild({ op: 'epg', id, uuid });
        });
    }

    /* ---------- the channels' logos (state/logos/<uuid>.png) ---------- */
    const logoDir = file('logos');
    const logoNone = {}, logoWait = {};
    // how the logos went (the app's Status tab shows it): fetched, not had (and why, the last time), each new reason logged
    const logoStats = { fetched: 0, failed: 0, last: null };
    function logoFailed(name, why) {
        logoStats.failed++;
        if (logoStats.last !== why) log('logo ' + name + ': ' + why + (logoStats.failed > 1 ? ' (' + logoStats.failed + ' logos so far)' : ''));
        logoStats.last = why;
    }
    /** a channel's logo: kept by its address (the server's ?v= changes with the logo), for as long as that address stays,
     *  on the disk (the list has its logos without the internet too); a channel without a public logo (no icon, or the
     *  server's imagecache/<n>, which asks for a user: the image cache is to stay off) is no failure (quiet) */
    function logo(uuid) {
        if (!/^[0-9a-f]{32}$/.test(uuid)) return Promise.resolve({ uuid, none: true, why: 'not a channel' });
        const ch = chans.channels.filter((c) => c.uuid === uuid)[0];
        if (!ch) return Promise.resolve({ uuid, none: true, why: 'not a channel of the list' });
        const icon = String(ch.icon || '');
        if (!/^https?:\/\//i.test(icon)) return Promise.resolve({ uuid, none: true, quiet: true, why: icon ? 'no public logo (' + icon.slice(0, 40) + ')' : 'no logo' });
        const f = path.join(logoDir, uuid + '.png'), fu = path.join(logoDir, uuid + '.url');
        const kept = () => { try { return fs.readFileSync(f).toString('base64'); } catch (e) { return null; } };
        let keptUrl = null;
        try { keptUrl = fs.readFileSync(fu, 'utf8'); } catch (e) { /* none kept */ }
        if (keptUrl === icon) { const png = kept(); if (png) return Promise.resolve({ uuid, png }); }
        const key = uuid + '|' + icon;
        // not to be had now: the one kept for an earlier address (better than none), else none for a while
        const none = (why) => {
            const old = kept();
            if (old) return { uuid, png: old, stale: true };
            logoNone[key] = { until: now() + LOGO_NONE_MS, why };
            return { uuid, none: true, why };
        };
        if (logoNone[key] && logoNone[key].until > now()) return Promise.resolve(none(logoNone[key].why));
        startChild();
        if (!child) return Promise.resolve({ uuid, none: true, why: 'no client' });
        return new Promise((res) => {
            const id = crypto.randomBytes(6).toString('hex');
            const t = setTimeout(() => { if (logoWait[id]) { delete logoWait[id]; res(none('the server did not answer in time')); } }, 20000);
            logoWait[id] = (m) => {
                clearTimeout(t);
                if (!m.ok) { logoFailed(ch.name, m.error); return res(none(m.error)); }
                if (!logoStats.fetched++) log('logo ' + ch.name + ': fetched (' + Math.round(m.png.length * 0.75 / 1024) + ' KiB)');
                try { fs.mkdirSync(logoDir, 0o700); } catch (e) { /* there */ }
                try {
                    fs.writeFileSync(f, Buffer.from(m.png, 'base64'), { mode: 0o600 });
                    fs.writeFileSync(fu, icon, { mode: 0o600 });
                } catch (e) { log('logo: ' + e.message); }
                res({ uuid, png: m.png });
            };
            toChild({ op: 'logo', id, icon });
        });
    }

    /* ---------- the player (root: its frame file; it runs as nobody) ---------- */
    const player = createPlayer({ bin: o.playerBin, uid: o.uid, env: o.playerEnv, videoPath: o.videoPath, log,
        onEvent: (id, ev) => toChild({ op: 'player', id, ev }) });

    /* ---------- the client (internet uid) ---------- */
    let child = null, childStarts = 0, signinWait = {};
    function startChild() {
        if (child) return;
        childStarts++;
        const env = Object.assign({ PATH: process.env.PATH || '/usr/bin:/bin', TVH_LEASE: o.leasePath }, o.childEnv);
        // fd 4: the channel's stream, from the client to the player (player.js)
        const fopts = { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'] };
        if (o.uid !== null) { fopts.uid = o.uid; fopts.gid = o.uid; }
        let c;
        try { c = fork(path.join(__dirname, 'client.js'), [], fopts); }
        catch (e) { st.error = 'the Tvheadend client did not start: ' + e.message; log(st.error); return; }
        child = c;
        if (c.stdio[4]) player.attach(c.stdio[4]);
        if (prefs) setTimeout(() => toChild({ op: 'prefs', prefs }), 0);
        c.on('message', onChild);
        c.on('error', (e) => log('client: ' + e.message));
        c.on('exit', (code, sig) => {
            if (child !== c) return;
            child = null;
            Object.keys(signinWait).forEach((id) => { signinWait[id]({ ok: false, error: 'the Tvheadend client ended' }); delete signinWait[id]; });
            player.stopAll();
            st.playback = null;
            if (stopping) return;
            log('client ended (' + (sig || code) + ')' + (childStarts < 20 ? ', starting it again in 5 s' : ''));
            st.client = { state: 'error', error: 'the Tvheadend client ended' };
            if (childStarts < 20) setTimeout(() => { startChild(); if (account) toChild({ op: 'run', account }); }, 5000);
        });
    }
    const toChild = (m) => { if (child && child.connected) child.send(m); };
    function onChild(m) {
        if (!m) return;
        if (m.ev === 'log') log(m.line);
        else if (m.ev === 'status') st.client = m.status;
        else if (m.ev === 'ready') log('client running as uid ' + m.uid);
        else if (m.ev === 'playback') st.playback = m.status;
        else if (m.ev === 'channels') chans = { at: m.at, channels: m.channels || [], epg: m.epg || {} };
        else if (m.ev === 'player-start') player.start(m.id);
        else if (m.ev === 'player-ctl') player.ctl(m.id, m.line);
        else if (m.ev === 'player-stop') player.stop(m.id);
        else if (m.ev === 'signed-out') st.client = { state: 'signed-out' };
        else if (m.ev === 'signin' && signinWait[m.id]) { signinWait[m.id](m); delete signinWait[m.id]; }
        else if (m.ev === 'logo' && logoWait[m.id]) { logoWait[m.id](m); delete logoWait[m.id]; }
        else if (m.ev === 'epg' && epgWait[m.id]) { epgWait[m.id](m); delete epgWait[m.id]; }
    }
    function signIn(server, user, password) {
        return new Promise((res) => {
            startChild();
            if (!child) return res({ ok: false, error: st.error || 'the Tvheadend client did not start' });
            const id = crypto.randomBytes(6).toString('hex');
            const t = setTimeout(() => { if (signinWait[id]) { delete signinWait[id]; res({ ok: false, error: 'the server did not answer in time' }); } }, 45000);
            signinWait[id] = (r) => { clearTimeout(t); res(r); };
            toChild({ op: 'signin', id, server, user, password });
        });
    }

    /* ---------- the sign-in page ---------- */
    let pageSrv = null, pageToken = null, pageTimer = null, fwTimer = null;
    /** the car Wi-Fi: the interfaces the phone reaches us on (wireless CarPlay), with their IPv4 address */
    function carWifi() {
        const all = os.networkInterfaces();
        const out = [];
        Object.keys(all).forEach((name) => (all[name] || []).forEach((a) => {
            if (a.family !== 'IPv4' || a.internal) return;
            const want = o.pageIfaces ? o.pageIfaces.indexOf(name) >= 0
                : /^(wlan|uap|ap|wl)/.test(name) && name !== 'vethuplink' || /^172\.16\.222\./.test(a.address);
            if (want) out.push({ name, ip: a.address });
        }));
        out.sort((a, b) => (b.name === 'wlan_bridge') - (a.name === 'wlan_bridge'));
        return out;
    }
    function firewall() {
        if (!o.nft) return;
        const names = carWifi().map((i) => i.name);
        try {
            const r = nftm.apply(names, o.pagePort, { nft: o.nft });
            const bad = r.filter((x) => !x.ok);
            st.page.firewall = bad.length ? 'failed: ' + bad[0].chain + ': ' + bad[0].error : r.length + ' chains open for tcp ' + o.pagePort;
            if (r.some((x) => x.changed)) log('firewall: ' + st.page.firewall + ' on ' + (names.join(', ') || 'no interface'));
        } catch (e) { st.page.firewall = 'failed: ' + e.message; }
    }
    function pageUrl() {
        const ifs = carWifi();
        return ifs.length ? 'http://' + ifs[0].ip + ':' + o.pagePort + '/' + pageToken : null;
    }
    function openPage() {
        bump();
        if (pageSrv) { st.page.until = now() + PAGE_MINUTES * 60000; armPageTimer(); return Promise.resolve(); }
        pageToken = crypto.randomBytes(6).toString('hex');
        return new Promise((res) => {
            const srv = http.createServer(onPage);
            srv.on('error', (e) => { st.page = { open: false, error: 'the sign-in page did not open: ' + e.message }; log(st.page.error); pageSrv = null; res(); });
            srv.listen(o.pagePort, '0.0.0.0', () => {
                pageSrv = srv;
                st.page = { open: true, until: now() + PAGE_MINUTES * 60000, url: pageUrl(), error: null };
                firewall();
                fwTimer = setInterval(() => { firewall(); st.page.url = pageUrl(); }, 5000);
                armPageTimer();
                log('sign-in page open: ' + (st.page.url || 'no car Wi-Fi yet (connect the iPhone with wireless CarPlay)'));
                res();
            });
        });
    }
    function armPageTimer() { clearTimeout(pageTimer); pageTimer = setTimeout(() => closePage('10 minutes passed'), Math.max(1000, st.page.until - now())); }
    function closePage(why) {
        clearTimeout(pageTimer); clearInterval(fwTimer);
        if (pageSrv) { try { pageSrv.close(); } catch (e) { /* closed */ } pageSrv = null; log('sign-in page closed' + (why ? ' (' + why + ')' : '')); }
        if (o.nft) { try { nftm.remove({ nft: o.nft }); } catch (e) { /* best effort */ } }
        st.page = { open: false };
        pageToken = null;
    }
    function onPage(req, res) {
        const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); };
        const p = (req.url || '').split('?')[0];
        if (!pageToken || p !== '/' + pageToken) return send(404, pagem.closed());
        const action = '/' + pageToken;
        const last = account ? account.server : (st.lastSignIn && st.lastSignIn.server);
        if (req.method === 'GET') return send(200, pagem.form({ action, server: last, user: account ? account.user : '' }));
        if (req.method !== 'POST') return send(405, pagem.closed());
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { body += d; if (body.length > 8192) req.destroy(); });
        req.on('end', () => {
            const f = qs.parse(body);
            const server = String(f.server || '').trim(), user = String(f.user || '').trim();
            log('sign-in: ' + user + ' at ' + server);
            signIn(server, user, String(f.password || '')).then((r) => {
                st.lastSignIn = { at: now(), ok: r.ok, server, error: r.ok ? null : r.error };
                if (!r.ok) { log('sign-in failed: ' + r.error); return send(200, pagem.form({ action, server, user, error: r.error })); }
                account = r.account;
                writeJson('account.json', account);
                toChild({ op: 'run', account });
                send(200, pagem.done({ serverName: account.serverName, server: account.server, user: account.user, version: account.serverVersion }));
                setTimeout(() => closePage('signed in'), 2000);
            });
        });
    }

    /* ---------- control ---------- */
    let lastReq = now(), idleTimer = null, stopping = false;
    function bump() { lastReq = now(); }
    function uplink() {
        try { const l = JSON.parse(fs.readFileSync(o.leasePath, 'utf8')); return l && l.ip ? { online: true, iface: l.interface, ip: l.ip, dns: l.dns || [] } : { online: false }; }
        catch (e) { return { online: false }; }
    }
    const playing = () => !!(st.playback && PLAYING.indexOf(st.playback.state) >= 0);
    function status() {
        return Object.assign({}, st, {
            now: now(), uplink: uplink(), player: player.state(), prefs,
            account: account ? { server: account.server, user: account.user, serverName: account.serverName, serverVersion: account.serverVersion } : null,
            channels: { at: chans.at, count: chans.channels.length, icons: chans.channels.filter((c) => /^https?:\/\//i.test(c.icon || '')).length },
            logos: logoStats,
            page: Object.assign({}, st.page, st.page.open ? { url: pageUrl(), left: Math.max(0, Math.round((st.page.until - now()) / 1000)) } : {}),
            log: lines.slice(-14),
        });
    }
    async function command(m) {
        bump();
        const cmd = m && m.cmd;
        if (cmd === 'signin-open') await openPage();
        else if (cmd === 'signin-close') closePage('closed from the app');
        else if (cmd === 'signout') {
            if (account) {
                log('signing out ' + account.user);
                toChild({ op: 'signout' });
                account = null;
                try { fs.unlinkSync(file('account.json')); } catch (e) { /* none */ }
                Object.keys(epgKept).forEach((k) => { delete epgKept[k]; });
                // another server's channels have other logos
                try { fs.readdirSync(logoDir).forEach((n) => fs.unlinkSync(path.join(logoDir, n))); } catch (e) { /* none */ }
                st.playback = null;
                chans = { at: null, channels: [], epg: {} };
                st.client = { state: 'signed-out' };
            }
        } else if (cmd === 'channels') {
            return { at: chans.at, channels: chans.channels, epg: chans.epg };
        } else if (cmd === 'epg') {
            return epg(String(m.uuid || ''));
        } else if (cmd === 'logo') {
            return logo(String(m.uuid || ''));
        } else if (cmd === 'play' && m.uuid) {
            const ch = chans.channels.filter((c) => c.uuid === String(m.uuid))[0] || { uuid: String(m.uuid), name: String(m.name || '?'), number: null };
            log('play ' + (ch.number != null ? ch.number + ' ' : '') + ch.name);
            toChild({ op: 'play', channel: ch });
        } else if (cmd === 'stop') {
            toChild({ op: 'playback-stop' });
        } else if (cmd === 'refresh') {
            toChild({ op: 'refresh' });
        } else if (cmd === 'prefs') {
            const g = Number(m.gain);
            const p = { profile: String(m.profile || 'mgu-hd'), adaptive: m.adaptive !== false, subs: m.subs !== false,
                gain: isFinite(g) ? Math.max(0, Math.min(15, g)) : 9, even: m.even === true };
            if (!prefs || p.profile !== prefs.profile || p.adaptive !== prefs.adaptive || p.subs !== prefs.subs || p.gain !== prefs.gain || p.even !== prefs.even) {
                prefs = p;
                try { writeJson('prefs.json', prefs); } catch (e) { log('prefs: ' + e.message); }
                toChild({ op: 'prefs', prefs });
            }
        } else if (cmd === 'exit') { setTimeout(() => stop(0), 100); }
        return status();
    }
    function serve(server) {
        server.on('connection', (c) => {
            let buf = '';
            c.setEncoding('utf8');
            c.on('error', () => {});
            c.on('data', (d) => {
                buf += d;
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i); buf = buf.slice(i + 1);
                    let m = null;
                    try { m = JSON.parse(line); } catch (e) { m = { cmd: 'status' }; }
                    command(m).then((s) => { try { c.write(JSON.stringify(s) + '\n'); } catch (e) { /* gone */ } })
                        .catch((e) => { try { c.write(JSON.stringify({ version: VERSION, error: e.message }) + '\n'); } catch (x) { /* gone */ } });
                }
                if (buf.length > 65536) c.destroy();
            });
        });
    }

    function start() {
        if (o.nft) { const n = nftm.remove({ nft: o.nft }); if (n) log('firewall: removed ' + n + ' old rules'); }
        log('aurelm-tvhplayer ' + VERSION);
        startChild();
        if (account) toChild({ op: 'run', account });
        idleTimer = setInterval(() => {
            // a channel nobody asks about (the app closed or crashed): stopped
            if (playing() && now() - lastReq > o.watchMs) { log('the app has not asked for ' + Math.round(o.watchMs / 1000) + ' s: stopping the channel'); toChild({ op: 'playback-stop' }); }
            if (!playing() && !pageSrv && now() - lastReq > IDLE_MS) { log('idle: ending'); stop(0); }
        }, Math.min(30000, Math.max(1000, Math.round(o.watchMs / 3))));
    }
    function stop(code) {
        if (stopping) return;
        stopping = true;
        clearInterval(idleTimer);
        closePage();
        player.killSync();
        if (child) { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } }
        if (o.exit !== false) setTimeout(() => process.exit(code || 0), 200);
    }
    return { start, stop, serve, command, status, signIn, carWifi };
}

if (require.main === module) {
    const svc = createService();
    const server = net.createServer();
    svc.serve(server);
    // systemd passes the socket as fd 3 (LISTEN_FDS); outside it, TVH_SOCK
    if (process.env.LISTEN_FDS && Number(process.env.LISTEN_FDS) >= 1) server.listen({ fd: 3 });
    else {
        const p = process.env.TVH_SOCK || '/run/aurelm-tvhplayer.sock';
        try { fs.unlinkSync(p); } catch (e) { /* none */ }
        server.listen(p);
    }
    try { const g = require('./sockgroup').apply(process.env.TVH_SOCK || '/run/aurelm-tvhplayer.sock'); console.log('control socket: ' + (g === null ? 'root only' : 'group ' + g)); }
    catch (e) { console.log('control socket mode: ' + e.message); }
    svc.start();
    process.on('SIGTERM', () => svc.stop(0));
    process.on('SIGINT', () => svc.stop(0));
}

module.exports = { createService, VERSION, PAGE_PORT, NET_UID };
