'use strict';
/**
 * tvh.js - Tvheadend's HTTP interface, as the signed-in user: the server, its channels, its stream profiles, what
 * is on now (EPG), and a channel's stream. Runs in the client (client.js, uid 13101: the internet).
 *
 *   const t = createTvh({ nx, log, now });
 *   await t.signIn(serverText, user, password) -> account { server, user, password, serverName, serverVersion }
 *   t.use(account)
 *   await t.info()        { name, version, api }
 *   await t.channels()    [{ uuid, name, number, icon, tags }] by number, the ones this user may watch
 *   await t.profiles()    ['mgu-hd', 'pass', ...] the stream profiles (null: the server does not list them)
 *   await t.epgNow()      { <channel uuid>: { title, subtitle, start, stop } } (seconds since 1970)
 *   await t.stream(uuid, profile) -> { status, res, abort } (MPEG-TS from /stream/channel/<uuid>?profile=...)
 *   await t.epg(uuid, hours) a channel's programme from now: [{ id, title, subtitle, summary, description, start, stop }]
 *   await t.logo(icon)    a channel's logo (its icon_public_url: imagecache/<n> on the server, or an address), a PNG
 *
 * Authentication: Tvheadend asks for HTTP Digest (MD5 or SHA-256, "Digest hash type") or Basic, as its
 * "Authentication type" is set. The first request goes without; the server's 401 brings its challenge, which
 * every later request answers (nc counting up). A 401 again (the nonce expired) brings a new one: tried once more.
 * The password is kept (Tvheadend has no access token for its API): in the service's state, 0600, root's.
 *
 * Paths the API marks anonymous (channel/grid, epg) answer an unknown user too, as anonymous: so the sign-in proves
 * the password on /playlist/channels, which needs the streaming right (the one the car needs anyway).
 */
const crypto = require('crypto');

/** "tv.example.com:9981/" -> ['https://tv.example.com:9981', 'http://tv.example.com:9981'] (the ones to try) */
function candidates(text) {
    let s = String(text || '').trim().replace(/\/+$/, '');
    if (!s) return [];
    if (/^https?:\/\//i.test(s)) return [s.replace(/^HTTPS?/i, (m) => m.toLowerCase())];
    if (!/:\d+$/.test(s.split('/')[0])) s = s.replace(/^([^/]+)/, '$1:9981');   // Tvheadend's port when none is given
    return ['https://' + s, 'http://' + s];
}

/** every WWW-Authenticate challenge of an answer: [{ scheme: 'digest'|'basic', realm, nonce, opaque, qop, algorithm }] */
function challenges(rawHeaders) {
    const out = [];
    const raw = rawHeaders || [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
        if (String(raw[i]).toLowerCase() !== 'www-authenticate') continue;
        const v = String(raw[i + 1]);
        const m = /^\s*(\w+)\s*(.*)$/.exec(v);
        if (!m) continue;
        const c = { scheme: m[1].toLowerCase() };
        const re = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
        let p;
        while ((p = re.exec(m[2]))) c[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
        out.push(c);
    }
    return out;
}

/** the challenge to answer: SHA-256 Digest, then MD5 Digest, then Basic */
function pick(list) {
    const dig = list.filter((c) => c.scheme === 'digest' && c.nonce);
    const alg = (c) => String(c.algorithm || 'MD5').toUpperCase();
    return dig.filter((c) => alg(c) === 'SHA-256')[0] || dig.filter((c) => alg(c) === 'MD5')[0] || list.filter((c) => c.scheme === 'basic')[0] || null;
}

/** the Authorization header for one request (ch: the challenge; st: { nc } counted up per nonce) */
function authorization(ch, user, password, method, uri, st, cnonce) {
    if (!ch) return null;
    if (ch.scheme === 'basic') return 'Basic ' + Buffer.from(user + ':' + password, 'utf8').toString('base64');
    const algorithm = String(ch.algorithm || 'MD5').toUpperCase();
    const H = (s) => crypto.createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5').update(s, 'utf8').digest('hex');
    const ha1 = H(user + ':' + ch.realm + ':' + password);
    const ha2 = H(method + ':' + uri);
    const qop = ch.qop && String(ch.qop).split(',').map((q) => q.trim()).indexOf('auth') >= 0 ? 'auth' : null;
    const q = (v) => '"' + String(v).replace(/(["\\])/g, '\\$1') + '"';
    let h = 'Digest username=' + q(user) + ', realm=' + q(ch.realm) + ', nonce=' + q(ch.nonce) + ', uri=' + q(uri);
    if (qop) {
        st.nc = (st.nc || 0) + 1;
        const nc = ('0000000' + st.nc.toString(16)).slice(-8);
        const cn = cnonce || crypto.randomBytes(8).toString('hex');
        h += ', qop=' + qop + ', nc=' + nc + ', cnonce=' + q(cn) + ', response=' + q(H(ha1 + ':' + ch.nonce + ':' + nc + ':' + cn + ':' + qop + ':' + ha2));
    } else h += ', response=' + q(H(ha1 + ':' + ch.nonce + ':' + ha2));
    if (ch.opaque) h += ', opaque=' + q(ch.opaque);
    if (ch.algorithm) h += ', algorithm=' + ch.algorithm;
    return h;
}

/** #EXTM3U from /playlist/channels -> [{ uuid, name, number }] (when the API lists none) */
function parsePlaylist(text) {
    const out = [];
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.indexOf('#EXTINF') !== 0) continue;
        const name = l.slice(l.lastIndexOf(',') + 1).trim();
        const num = /tvg-chno="([^"]*)"/.exec(l);
        let url = '';
        for (let j = i + 1; j < lines.length && !url; j++) if (lines[j] && lines[j][0] !== '#') url = lines[j].trim();
        const id = /tvg-id="([0-9a-f]{32})"/.exec(l) || /\/stream\/channel\/([0-9a-f]{32})/.exec(url);
        if (!id) continue;
        // the logo: Tvheadend writes the channel's own address when its image cache is off (logo= or tvg-logo=)
        const logo = /\b(?:tvg-)?logo="([^"]*)"/.exec(l) || /\blogo=(\S+?)(?:\s|,|$)/.exec(l);
        out.push({ uuid: id[1], name, number: num && num[1] ? Number(num[1]) || null : null, icon: logo ? logo[1] : null, tags: [] });
    }
    return out;
}

/** what a browser sends for a picture: some sites answer other clients differently (or not at all) */
const BROWSER = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    // PNG asked for by name (image/* or image/webp would let a CDN send WebP, which the head unit cannot draw)
    Accept: 'image/png,*/*;q=0.5',
};
/** github.com/<owner>/<repo>/blob/<ref>/<path> (a web page) -> raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> (the file) */
function githubRaw(u) {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+?)(\?.*)?$/i.exec(u);
    return m ? 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] : u;
}
/** "static.wikia.nocookie.net/...Pro_TV_HD.png" (the site and the address's end, for the Status tab) */
function shortUrl(u) {
    const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(u);
    if (!m) return String(u).slice(0, 60);
    const tail = m[2].length > 34 ? '...' + m[2].slice(-34) : m[2];
    return m[1] + tail;
}

const byNumber = (a, b) => (a.number == null) - (b.number == null) || (a.number || 0) - (b.number || 0) || String(a.name).localeCompare(String(b.name));

function createTvh(o) {
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const nx = o.nx;
    let acc = null;
    const auth = { ch: null, st: { nc: 0 }, primed: false };

    function use(account) { acc = account; auth.ch = null; auth.st = { nc: 0 }; auth.primed = false; }
    /** the challenge before the first API call: an anonymous path would answer without one, as anonymous (no
     *  channels, or another user's), so the playlist (the streaming right) is asked first, once */
    async function prime() {
        if (auth.primed || auth.ch || !acc || !acc.user) return;
        auth.primed = true;
        check(await send(acc, 'GET', 'playlist/channels', { maxBytes: 4 * 1024 * 1024 }), 'sign-in');
    }

    function headersFor(a, method, uri) {
        const h = { Accept: 'application/json, */*', 'User-Agent': 'aurelm-tvhplayer (BMW iDrive)' };
        const v = a && a.user ? authorization(auth.ch, a.user, a.password || '', method, uri, auth.st) : null;
        if (v) h.Authorization = v;
        return h;
    }
    /** keeps the server's newest challenge; true when it gave one */
    function learn(r) {
        const ch = pick(challenges(r.rawHeaders));
        if (!ch) return false;
        if (!auth.ch || auth.ch.nonce !== ch.nonce || auth.ch.scheme !== ch.scheme) auth.st = { nc: 0 };
        auth.ch = ch;
        return true;
    }
    /** one request as the user, answering the challenge (a 401 is tried once more with the new one) */
    async function send(a, method, path, opts) {
        const base = (opts && opts.base) || a.server;
        const uri = '/' + path.replace(/^\//, '');
        for (let i = 0; i < 2; i++) {
            const r = await nx.request({ method, url: base + uri, headers: headersFor(a, method, uri), timeoutMs: opts && opts.timeoutMs, maxBytes: opts && opts.maxBytes });
            if (r.status !== 401 || !a.user || !learn(r) || i === 1) return r;
        }
        throw new Error('unreachable');
    }
    function check(r, what) {
        if (r.status === 401 || r.status === 403) { const e = new Error(what + ': the server refused the user (' + r.status + ')'); e.code = 'EAUTH'; throw e; }
        if (r.status < 200 || r.status >= 300) throw new Error(what + ': HTTP ' + r.status);
        return r;
    }
    async function json(path, what) {
        await prime();
        const r = check(await send(acc, 'GET', path), what);
        try { return JSON.parse(r.body.toString('utf8')); } catch (e) { throw new Error(what + ': not JSON (is this Tvheadend?)'); }
    }

    /** signs in: the server answers as Tvheadend, and the user may stream; resolves the account to keep */
    async function signIn(serverText, user, password) {
        const tries = candidates(serverText);
        if (!tries.length) throw new Error('enter the server\'s address');
        if (!user) throw new Error('enter the user name (a Tvheadend user with the streaming right)');
        let lastErr = null;
        for (let i = 0; i < tries.length; i++) {
            const base = tries[i];
            const a = { server: base, user, password: password || '' };
            use(a);
            let info = null;
            try {
                const r = await send(a, 'GET', 'api/serverinfo', { base });
                if (r.status === 200) info = JSON.parse(r.body.toString('utf8'));
                else if (r.status !== 401 && r.status !== 403) throw new Error(base + ': HTTP ' + r.status);
            } catch (e) { lastErr = e.message && e.message.indexOf(base) === 0 ? e : new Error(base + ': ' + e.message); log('sign-in: ' + lastErr.message); continue; }
            if (info && !info.sw_version && !info.api_version) { lastErr = new Error(base + ' is not a Tvheadend server'); continue; }
            // the password, and the streaming right: /playlist/channels needs both
            const r = await send(a, 'GET', 'playlist/channels', { base, maxBytes: 4 * 1024 * 1024 });
            if (r.status === 401 || r.status === 403) throw new Error('wrong user name or password, or the user may not stream (Users > Access entries: Streaming)');
            if (r.status !== 200 || r.body.toString('utf8', 0, 7) !== '#EXTM3U') throw new Error('the server gave no channel list (HTTP ' + r.status + ')');
            if (!info) { try { info = await json('api/serverinfo', 'serverinfo'); } catch (e) { info = {}; } }
            const n = parsePlaylist(r.body.toString('utf8')).length;
            log('signed in to Tvheadend ' + (info.sw_version || '?') + ' at ' + base + ' as ' + user + ': ' + n + ' channels');
            return { server: base, user, password: password || '', serverName: info.name || null, serverVersion: info.sw_version || null, at: now() };
        }
        throw lastErr || new Error('the server does not answer');
    }

    async function info() {
        const j = await json('api/serverinfo', 'serverinfo');
        return { name: j.name || null, version: j.sw_version || null, api: j.api_version || null };
    }

    /** the channels this user may watch, by number: the API's grid, or the playlist when the grid lists none */
    async function channels() {
        let list = [];
        try {
            const j = await json('api/channel/grid?start=0&limit=5000&sort=number&dir=ASC', 'channels');
            list = (j.entries || []).filter((c) => c && c.uuid && c.enabled !== false).map((c) => ({
                uuid: c.uuid, name: String(c.name || c.svcname || '?'), number: c.number != null && c.number !== 0 ? Number(c.number) : null,
                icon: c.icon_public_url || null, tags: c.tags || [],
            }));
        } catch (e) { if (e.code === 'EAUTH') throw e; log('channels from the API: ' + e.message + '; the playlist instead'); }
        if (!list.length) {
            await prime();
            const r = check(await send(acc, 'GET', 'playlist/channels', { maxBytes: 4 * 1024 * 1024 }), 'playlist');
            list = parsePlaylist(r.body.toString('utf8'));
        }
        return list.sort(byNumber);
    }

    /** the stream profiles' names; null when the server does not list them to this user */
    async function profiles() {
        try {
            const j = await json('api/profile/list', 'profiles');
            return (j.entries || []).map((e) => String(e.val || e.name || '')).filter(Boolean);
        } catch (e) { log('profiles: ' + e.message); return null; }
    }

    /** what is on now, per channel */
    async function epgNow() {
        const j = await json('api/epg/events/grid?mode=now&start=0&limit=5000', 'epg');
        const out = {};
        (j.entries || []).forEach((e) => {
            if (!e || !e.channelUuid || out[e.channelUuid]) return;
            out[e.channelUuid] = { title: e.title || '', subtitle: e.subtitle || '', start: e.start || null, stop: e.stop || null };
        });
        return out;
    }

    /** a channel's stream with a profile: { status, res, abort }; a 401 is answered once more with the new challenge */
    async function stream(uuid, profile) {
        await prime();
        const uri = '/stream/channel/' + encodeURIComponent(uuid) + (profile ? '?profile=' + encodeURIComponent(profile) : '');
        for (let i = 0; i < 2; i++) {
            const r = await nx.stream({ url: acc.server + uri, headers: headersFor(acc, 'GET', uri), timeoutMs: 30000 });
            if (r.status === 401 && i === 0 && learn(r)) { r.res.resume(); r.abort(); continue; }
            return r;
        }
        throw new Error('unreachable');
    }

    /** a channel's programme: what is on now and what follows, `hours` ahead (Tvheadend sorts the grid by start) */
    async function epg(uuid, hours) {
        const t = Math.floor(now() / 1000), until = t + (hours || 24) * 3600;
        const j = await json('api/epg/events/grid?channel=' + encodeURIComponent(uuid) + '&start=0&limit=80&sort=start&dir=ASC', 'epg');
        return (j.entries || []).filter((e) => e && (!e.channelUuid || e.channelUuid === uuid) && e.stop > t && e.start < until)
            .sort((a, b) => a.start - b.start).slice(0, 60)
            .map((e) => ({ id: e.eventId || null, title: e.title || '', subtitle: e.subtitle || '', summary: e.summary || '', description: e.description || '',
                start: e.start, stop: e.stop, episode: e.episodeOnscreen || '' }));
    }

    /** a channel's logo as Tvheadend gives it: its imagecache (as the user) or another address; PNG only, 512 KiB at most */
    async function logo(icon) {
        const s = String(icon || '').trim();
        if (!s) throw new Error('no logo');
        let r;
        const own = acc.server + '/';
        let where = 'logo';
        // the server's own image cache (imagecache/<n>, relative or on its address) answers the user; any other address,
        // on whatever host (tvlogo.sandu.casa: public PNGs), is fetched as it is
        const viaServer = !/^https?:\/\//i.test(s) || (s.indexOf(own) === 0 && /^imagecache\/\d+$/.test(s.slice(own.length)));
        if (!viaServer) {
            // another site's logo (the server's image cache off: Tvheadend gives the channel's own address). 0.1.2 in the
            // car: HTTP 404 from it, while the iPhone's apps had the same logos; and with the cache on, Tvheadend's own
            // fetch failed too. So asked for as a browser asks (its User-Agent, images accepted), redirects followed, and a
            // GitHub page's address (github.com/.../blob/...) taken as the picture's (raw.githubusercontent.com).
            let u = githubRaw(s);
            for (let hop = 0; ; hop++) {
                where = 'logo ' + shortUrl(u);
                r = await nx.request({ url: u, headers: BROWSER, maxBytes: 512 * 1024, timeoutMs: 15000 });
                const loc = r.headers && r.headers.location;
                if (r.status >= 300 && r.status < 400 && loc && hop < 3) { u = require('url').resolve(u, loc); continue; }
                break;
            }
        }
        else {
            const p = s.indexOf(own) === 0 ? s.slice(own.length) : s.replace(/^\/+/, '');
            if (!/^imagecache\/\d+$/.test(p)) throw new Error('not a logo the car can fetch: ' + s.slice(0, 60));
            await prime();   // the server's image cache answers the user (another site's logo needs no challenge)
            const get = () => send(acc, 'GET', p, { maxBytes: 512 * 1024, timeoutMs: 15000 });
            r = await get();
            // 0.1.1 in the car: the server's log had /imagecache/<n> -- 403 (a user given, not accepted: Tvheadend answers
            // 403, not 401, on a path anonymous may ask for), while the API answered the same client. Once more, with a
            // challenge asked for anew (as at the start), before giving the logo up.
            if (r.status === 403 && acc.user) {
                log('logo ' + p + ': 403, again with a fresh challenge');
                auth.ch = null; auth.primed = false;
                await prime();
                r = await get();
            }
        }
        check(r, where);
        if (r.body.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error(where + ': not a PNG (' + (r.headers['content-type'] || '?') + ')');
        return r.body;
    }

    return { signIn, use, info, channels, profiles, epgNow, epg, stream, logo, account: () => acc };
}

module.exports = { createTvh, candidates, challenges, pick, authorization, parsePlaylist, githubRaw, shortUrl };
