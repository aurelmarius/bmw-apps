'use strict';
/**
 * client.js - the Tvheadend client, a child of service.js running as the tool's internet uid (component.json
 * "uids": mgu-uplink routes it, never root). It holds no file of its own: the account comes from the parent over
 * IPC, and everything it learns goes back the same way.
 *
 *   parent -> { op: 'run', account } | { op: 'signin', id, server, user, password } | { op: 'signout' } | { op: 'stop' }
 *             | { op: 'play', channel } | { op: 'playback-stop' } | { op: 'prefs', prefs } | { op: 'refresh' }
 *             | { op: 'player', id, ev } (the player's events) | { op: 'logo', id, icon } | { op: 'epg', id, uuid }
 *   child  -> { ev: 'status', status } | { ev: 'signin', id, ok, account | error } | { ev: 'channels', channels, epg, at }
 *             | { ev: 'playback', status } | { ev: 'player-start', id } | { ev: 'player-ctl', id, line } | { ev: 'player-stop', id }
 *             | { ev: 'signed-out', why } | { ev: 'log', line } | { ev: 'ready', uid } | { ev: 'logo', id, ok, png (base64) | error }
 *             | { ev: 'epg', id, ok, events | error }
 *
 * The channel's stream goes to the parent on fd 4 (the parent hands it to tvh-player's stdin), in frames: a stream
 * id (u32 LE), a length (u32 LE; 0xffffffff: that stream ended), the bytes. A stream left (another channel) can still
 * have bytes in the pipe: the parent drops what is not the current stream's.
 *
 * Connected: the server's info, the channels (again every 10 minutes), the profiles, and what is on now (again
 * every minute, and at the turn of the programme). A failure is tried again after 5 s, doubling to a minute.
 */
const net = require('net');
const { createNet } = require('./netx');
const { createTvh } = require('./tvh');
const { createPlayback, ascii } = require('./playback');

const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the parent is gone */ } };
const log = (line) => send({ ev: 'log', line });

const nx = createNet({ leasePath: process.env.TVH_LEASE || undefined, systemDns: process.env.TVH_SYSTEM_DNS === '1' });
const tvh = createTvh({ nx, log });

/* ---------- the stream to the parent (fd 4) ---------- */
let pipe = null;
try { pipe = new net.Socket({ fd: 4, readable: false, writable: true }); pipe.on('error', (e) => log('stream pipe: ' + e.message)); }
catch (e) { log('no stream pipe: ' + e.message); }
function frame(id, len) { const h = Buffer.alloc(8); h.writeUInt32LE(id >>> 0, 0); h.writeUInt32LE(len >>> 0, 4); return h; }
const sink = {
    start(id) { send({ ev: 'player-start', id }); },
    data(id, buf) { if (!pipe) return true; pipe.write(frame(id, buf.length)); return pipe.write(buf); },
    end(id) { if (pipe) pipe.write(frame(id, 0xffffffff)); },
    drain(id, fn) { if (pipe) pipe.once('drain', fn); else fn(); },
    ctl(id, line) { send({ ev: 'player-ctl', id, line }); },
    stop(id) { send({ ev: 'player-stop', id }); },
};

/* ---------- the server ---------- */
const CHANNELS_MS = 10 * 60000, EPG_MS = 60000;
const RETRY_MIN = Number(process.env.TVH_RETRY_MS) || 5000;
const st = { state: 'signed-out', error: null, server: null, profiles: null, channels: 0, epgAt: null, since: Date.now(), retries: 0 };
let running = false, timer = null, backoff = RETRY_MIN, channelsAt = 0, chans = [], epg = {};

const pb = createPlayback({ tvh, log, sink, profiles: () => st.profiles, retryMs: process.env.TVH_STREAM_RETRY_MS != null ? Number(process.env.TVH_STREAM_RETRY_MS) : undefined,
    adaptUpMs: Number(process.env.TVH_ADAPT_UP_MS) || undefined, outageMs: Number(process.env.TVH_OUTAGE_MS) || undefined,
    dataMs: Number(process.env.TVH_STREAM_DATA_MS) || undefined });

function status() { send({ ev: 'status', status: JSON.parse(JSON.stringify(st)) }); }
function setState(state, error) { st.state = state; st.error = error || null; st.since = Date.now(); status(); }
let lastSent = '';
function playbackStatus() {
    const j = JSON.stringify(pb.status());
    if (j !== lastSent) { lastSent = j; send({ ev: 'playback', status: JSON.parse(j) }); }
}
setInterval(playbackStatus, 1000);

function publish() {
    send({ ev: 'channels', at: Date.now(), channels: chans, epg });
}
/** the next refresh: the next minute, or the end of the first programme on now, whichever comes first */
function nextIn() {
    const t = Date.now() / 1000;
    let soon = t + EPG_MS / 1000;
    Object.keys(epg).forEach((k) => { const e = epg[k]; if (e.stop && e.stop > t && e.stop < soon) soon = e.stop + 5; });
    return Math.max(5000, Math.round((soon - t) * 1000));
}
async function refresh(force) {
    clearTimeout(timer);
    if (!running) return;
    try {
        if (st.state !== 'connected') setState('connecting');
        if (!st.server || force) st.server = await tvh.info();
        if (force || !chans.length || Date.now() - channelsAt > CHANNELS_MS) {
            const list = await tvh.channels();
            chans = list.map((c) => ({ uuid: c.uuid, name: ascii(c.name), number: c.number, icon: c.icon }));
            channelsAt = Date.now();
            st.channels = chans.length;
            const p = await tvh.profiles();
            if (p) st.profiles = p;
            log(chans.length + ' channels; profiles: ' + (st.profiles ? st.profiles.join(', ') : 'not listed'));
        }
        try {
            const e = await tvh.epgNow();
            epg = {};
            Object.keys(e).forEach((k) => { epg[k] = { title: ascii(e[k].title), subtitle: ascii(e[k].subtitle), start: e[k].start, stop: e[k].stop }; });
            st.epgAt = Date.now();
        } catch (e) { if (e.code === 'EAUTH') throw e; log('epg: ' + e.message); }
        backoff = RETRY_MIN;
        st.retries = 0;
        if (st.state !== 'connected') setState('connected'); else status();
        publish();
        timer = setTimeout(() => refresh(false), nextIn());
    } catch (e) {
        if (!running) return;
        st.retries++;
        setState('error', e.message);
        log('server: ' + e.message + ' (again in ' + Math.round(backoff / 1000) + ' s)');
        timer = setTimeout(() => refresh(true), backoff);
        backoff = Math.min(60000, backoff * 2);
    }
}
function run(account) {
    tvh.use(account);
    running = true;
    st.server = null; chans = []; epg = {}; channelsAt = 0;
    refresh(true);
}
function stop() { running = false; clearTimeout(timer); pb.stop(); }

process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'run') run(m.account);
    else if (m.op === 'stop') stop();
    else if (m.op === 'refresh') refresh(true);
    else if (m.op === 'player') { pb.onPlayer(m.id, m.ev); if (m.ev && m.ev.ev !== 'tick') playbackStatus(); }
    else if (m.op === 'play') { pb.play(m.channel); playbackStatus(); }
    else if (m.op === 'playback-stop') { pb.stop(); playbackStatus(); }
    else if (m.op === 'prefs') { pb.setPrefs(m.prefs); playbackStatus(); }
    else if (m.op === 'epg') {
        tvh.epg(m.uuid, 24).then((list) => send({ ev: 'epg', id: m.id, ok: true, events: list.map((e) => ({ id: e.id, start: e.start, stop: e.stop,
            title: ascii(e.title), subtitle: ascii(e.subtitle), episode: ascii(e.episode),
            text: ascii(e.description || e.summary).slice(0, 1200) })) }))
            .catch((e) => send({ ev: 'epg', id: m.id, ok: false, error: e.message }));
    }
    else if (m.op === 'logo') {
        tvh.logo(m.icon).then((b) => send({ ev: 'logo', id: m.id, ok: true, png: b.toString('base64') }))
            .catch((e) => send({ ev: 'logo', id: m.id, ok: false, error: e.message }));
    }
    else if (m.op === 'signout') { stop(); tvh.use(null); setState('signed-out'); send({ ev: 'signed-out', why: 'signed out' }); }
    else if (m.op === 'signin') {
        tvh.signIn(m.server, m.user, m.password)
            .then((account) => send({ ev: 'signin', id: m.id, ok: true, account }))
            .catch((e) => send({ ev: 'signin', id: m.id, ok: false, error: e.message }));
    }
});
// the parent went: so do we
process.on('disconnect', () => { stop(); process.exit(0); });
send({ ev: 'ready', uid: process.getuid ? process.getuid() : null });
