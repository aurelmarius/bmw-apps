'use strict';
/**
 * TVH - Tvheadend's channels on the head unit.
 *
 * TVH Player: the screen of the TVH Player service (native/aurelm-tvhplayer, a root tool with its client on mgu-uplink):
 *   "Watch"         plays the channel selected on the TV tab (the last one, the first time) and shows the picture;
 *                   on the one playing, shows its picture again after the controller hid it
 *   "Channel +/-"   the next / previous channel (also with the picture hidden, or while driving: the sound goes on)
 *   "Stop"          ends the channel (the stream, the player, the speakers)
 *   "Sign in"       opens the sign-in page on the car Wi-Fi for 10 minutes; its QR code shows here. The phone (on the
 *                   car Wi-Fi for wireless CarPlay) scans it: the server's address, a Tvheadend user and password.
 *   "Sign out"      forgets the server, the user and the password.
 * The page has two tabs. TV: the channels on the left (logo, number, name, what is on now and how far it is; the one
 * playing marked), the selected channel's programme on the right (from now, 6 entries; the chosen one's time and
 * description below). A touch or a press of the controller on a channel selects it; again, it plays. Status: the
 * steps (service, internet, account, server, playing, picture, sound) and the service's log. "TV / Status" switches.
 * Over the picture (shown while the car is parked; setting "Picture only while parked") a touch or the controller shows the controls (controls.js): CH-,
 * CH+, LIST (every channel: the knob and a press, or a touch, plays one), EPG (the guide: a channel's programme for
 * the next 24 hours with the details of the one chosen; < > the other channels, a press watches one), stop, aspect, exit.
 *
 * The stream comes with one of the server's profiles (setting "Stream profile": mgu-hd, mgu-sd, mgu-low; H.264
 * deinterlaced by the server, AAC); "Lower the quality by itself" goes down that ladder when the stream runs dry.
 * The sound goes to the speakers through source 287, shared with myAirPlay and Emby (car_audio.js: never taken
 * from the other app). Talks to the service over /run/aurelm-tvhplayer.sock (a JSON object per line).
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha, Canvas } = require('./kit/canvas');
const G = require('./kit/gauges');
const record = require('./kit/record');
const Parked = require('./kit/parked');
const qrcode = require('./qrcode');
const { RenderClient } = require('./mgu_render_client');
const { createMirrorView } = require('./mirror_view');
const { createControls, videoRect, hm, when, setZone } = require('./controls');
const { createCarAudio } = require('./car_audio');
const { createLogos, BOX: LOGO } = require('./logos');
const png = require('./kit/png');
const { createClusterCard } = require('./cluster_card');
const { createWheel, IFACE: WHEEL_IFACE, FIELD: WHEEL_FIELD } = require('./wheel');

const W = 1600, H = 520;
const SOCK = process.env.TVH_SOCK || '/run/aurelm-tvhplayer.sock';
// the service version this app is built with: an older one still running is asked once to end, and the socket
// starts the new one at the next request
const SERVICE_VERSION = '1.0.1';
// a channel is on: the picture and the speakers are wanted
const ACTIVE = ['loading', 'playing', 'buffering'];
const channelOn = (pb) => !!(pb && ACTIVE.indexOf(pb.state) >= 0);
/** the service gave up on the connection (2 minutes without the internet): the picture's screen stays, a press tries again */
const lostOf = (pb) => !!(pb && pb.state === 'error' && pb.lost);
/** "0:23" */
const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const PROFILES = ['mgu-hd', 'mgu-sd', 'mgu-low'];
// the quality each profile is made for (README: the server's profiles), as Emby shows its quality; another profile by name
const QUALITY = { 'mgu-hd': '3 Mbit/s', 'mgu-sd': '1.5 Mbit/s', 'mgu-low': '0.7 Mbit/s' };
const quality = (p) => (QUALITY[p] ? QUALITY[p] + ' (' + p + ')' : p || '');
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
const GREEN = '#52b54b', AMBER = '#ffb020', RED = '#ef2b2d', BLUE = '#2f8fd8';

function ask(cmd, extra, timeoutMs) {
    return new Promise((res) => {
        let buf = '', done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch (e) { /* gone */ } res(v); } };
        const c = net.connect(SOCK);
        const t = setTimeout(() => end(null), timeoutMs || 5000);
        c.setEncoding('utf8');
        c.on('connect', () => c.write(JSON.stringify(Object.assign({ cmd }, extra || {})) + '\n'));
        c.on('data', (d) => {
            buf += d;
            const i = buf.indexOf('\n');
            if (i < 0) return;
            try { end(JSON.parse(buf.slice(0, i))); } catch (e) { end(null); }
        });
        c.on('error', () => end(null));
    });
}

function clip(cv, s, size, w, font) {
    s = String(s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s + '...';
}
const ago = (t, now) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const chName = (c) => (c ? (c.number != null ? c.number + '  ' : '') + c.name : '');

/** the channel after / before `uuid` in the list (round) */
function neighbour(list, uuid, d) {
    if (!list.length) return null;
    const i = list.findIndex((c) => c.uuid === uuid);
    return list[((i < 0 ? (d > 0 ? -1 : 0) : i) + d + list.length) % list.length];
}

/** the steps, each { label, state: 'ok'|'wait'|'bad'|'off', detail }, from a status (null: no service) */
function steps(s) {
    if (!s) return [{ label: 'Service', state: 'bad', detail: 'not answering: install "TVH Player service" from the Store, then restart the head unit once' }];
    const c = s.client || {}, up = s.uplink || {};
    const signed = !!s.account;
    const rows = [
        { label: 'Service', state: 'ok', detail: 'version ' + s.version },
        { label: 'Internet', state: up.online ? 'ok' : 'bad', detail: up.online ? 'mgu-uplink on ' + up.iface + ' ' + up.ip : 'offline: mgu-uplink has no connection' },
        { label: 'Account', state: signed ? 'ok' : s.page && s.page.open ? 'wait' : 'off',
            detail: signed ? s.account.user + ' on ' + (s.account.serverName || 'Tvheadend') + ' (' + s.account.server + ')'
                : (s.lastSignIn && s.lastSignIn.error ? s.lastSignIn.error + ' - ' : '') + (s.page && s.page.open ? 'scan the QR code with the iPhone' : 'not signed in: press "Sign in"') },
    ];
    if (!signed) return rows;
    const cs = c.state;
    const prof = c.profiles ? c.profiles.filter((p) => PROFILES.indexOf(p) >= 0) : null;
    rows.push({ label: 'Server', state: cs === 'connected' ? 'ok' : cs === 'connecting' || cs === 'starting' ? 'wait' : 'bad',
        detail: cs === 'connected' ? 'Tvheadend ' + ((c.server && c.server.version) || '') + ', ' + (s.channels ? s.channels.count : 0) + ' channels' +
            (prof ? ', profiles ' + (prof.length ? prof.join(' ') : 'none named mgu-* (create them on the server)') : '')
            : cs === 'connecting' || cs === 'starting' ? 'connecting...' : (c.error || cs || '') + (c.retries ? ' (' + c.retries + ' tries)' : '') });
    // the logos: how many shown, missing (and why), on the way; the channels the server gives one
    const lg = s.logoStats, sl = s.logos || {};
    if (lg && cs === 'connected' && s.channels) {
        const icons = s.channels.icons != null ? s.channels.icons : null;   // the channels with a public logo (http(s))
        const why = lg.why || sl.last;
        rows.push({ label: 'Logos', state: icons === 0 ? 'off' : lg.none && !lg.ok ? 'bad' : lg.loading && !lg.ok ? 'wait' : lg.ok ? 'ok' : 'off',
            detail: icons === 0 ? 'the server gives no channel a public logo' : lg.ok + ' shown, ' + lg.none + ' missing' + (lg.loading ? ', ' + lg.loading + ' loading' : '') +
                (icons != null ? ' (' + icons + ' of ' + s.channels.count + ' channels have one)' : '') + (why && lg.none ? '; last: ' + why : '') });
    }
    const pb = s.playback;
    if (pb && (channelOn(pb) || pb.state === 'error')) playRows(s, rows);
    else rows.push({ label: 'Playing', state: 'off', detail: 'nothing: press "Watch"' });
    // the card on the instrument cluster (cluster_card.js, through cluster-render)
    // skip on the steering wheel (wheel.js)
    const wh = s.wheel;
    if (wh) rows.push({ label: 'Wheel', state: wh.seen ? 'ok' : 'off', detail: !wh.on ? 'off in the settings' : wh.seen ? 'last: ' + wh.last : 'skip < > on the steering wheel changes the channel while one is on' });
    const cl = s.cluster;
    if (cl) rows.push({ label: 'Cluster', state: cl.state === 'shown' ? 'ok' : cl.state === 'error' ? 'bad' : cl.state === 'off' || cl.state === 'missing' ? 'off' : 'wait', detail: cl.detail });
    return rows;
}

/** a channel playing: what, the stream, the picture, the sound */
function playRows(s, rows) {
    const pb = s.playback, pl = s.player || {}, tk = pl.tick || {};
    const STATE = { loading: 'starting', playing: 'playing', buffering: 'buffering (the internet or the server is slow)' };
    const PHASE = { stream: 'asking the server for the stream', player: 'starting the player', retry: 'the stream broke: opening it again' };
    const waited = pb.phaseAt ? Math.max(0, Math.round((s.now - pb.phaseAt) / 1000)) : 0;
    const what = pb.state === 'error' ? pb.error
        : pb.state === 'loading' && pb.retrySince ? 'reconnecting for ' + mmss(s.now - pb.retrySince) + (pb.error ? ' (' + pb.error + ')' : '')
        : pb.state === 'loading' && PHASE[pb.phase] ? PHASE[pb.phase] + (waited >= 3 ? ' (' + waited + ' s)' : '') + (pb.phase === 'retry' && pb.error ? ': ' + pb.error : '')
            : STATE[pb.state];
    const prof = pb.profile ? ', ' + quality(pb.profile) + (pb.lowered ? ' (lowered: slow internet)' : '') : '';
    // a profile the server's transcoder fails with at once (1.0.0: mgu-sd's "Failed to write mpegts header"): passed over
    const bad = pb.badProfiles && pb.badProfiles.length ? '; ' + pb.badProfiles.join(', ') + ' fails on the server (check it in Tvheadend): passed over' : '';
    rows.push({ label: 'Playing', state: pb.state === 'error' ? 'bad' : pb.state === 'playing' ? 'ok' : 'wait',
        detail: chName(pb.channel) + ' - ' + what + prof + (pb.reconnects ? ', ' + pb.reconnects + ' reconnects' : '') + bad });
    const fresh = pb.state !== 'loading' || pb.phase === 'player';
    const d = fresh ? pl.decoder : null, open = fresh && pl.open && pl.open.video;
    const v = s.mirror || {};
    let pic;
    if (!open) pic = { state: pb.state === 'error' ? 'off' : 'wait', detail: fresh && pl.open ? 'no picture in the stream (a radio channel?)' : 'waiting for the stream' };
    else if (d && !d.ok) pic = { state: 'bad', detail: 'GPU decoder: ' + d.error };
    else {
        const il = pb.interlaced ? '; INTERLACED: profile ' + pb.profile + ' does not deinterlace (Tvheadend: its codec profile, Deinterlace)' : '';
        pic = { state: pb.interlaced ? 'wait' : v.shown ? 'ok' : 'wait',
            detail: 'H.264 ' + open.w + 'x' + open.h + (open.fps ? ' ' + Math.round(open.fps) + 'p' : '') + ', ' + (tk.shown || 0) + ' shown' + (tk.late ? ', ' + tk.late + ' late' : '') +
                (tk.buffered != null ? ', ' + tk.buffered.toFixed(1) + ' s buffered' : '') + (v.why ? '; ' + v.why : '') + il +
                // the channel's DVB subtitles (the profile copies them), laid over the picture by the player
                (pb.subs ? (pb.subs.error ? '; subtitles: ' + pb.subs.error : '; subtitles ' + (pb.subs.lang || '?') + (pb.subs.on ? (tk.subs ? ', ' + tk.subs + ' received' : '') : ' (off)')) : '') };
    }
    rows.push(Object.assign({ label: 'Picture' }, pic));
    const a = fresh ? pl.audio : null, ca = s.carAudio || {};
    let snd;
    if (pb.audioError) snd = { state: 'bad', detail: pb.audioError };
    else if (!a) snd = { state: 'wait', detail: fresh && pl.open && pl.running ? 'no sound in the stream yet' : 'waiting for the stream' };
    else if (!a.ok) snd = { state: 'bad', detail: a.error };
    else {
        const n = String(a.codec).toUpperCase() + ' ' + a.channels + 'ch' + (tk.aplayed ? ', ' + tk.aplayed + ' played' : '') + (tk.aunread ? ', ' + tk.aunread + ' unread' : '');
        // the level: raised by the setting, the peaks held under -1 dBFS (the share of samples the limiter lowered)
        const lim = tk.limited && tk.aplayed ? Math.round(tk.limited / (tk.aplayed * 1024) * 1000) / 10 : 0;
        const lvl = pb.gain != null ? '; +' + pb.gain + ' dB' + (pb.even ? ', even volume' : '') + (lim ? ', ' + lim + '% limited' : '') : '';
        if (ca.taken) snd = { state: 'bad', detail: n + lvl + '; the speakers are in use by myAirPlay or Emby: stop it there' };
        else if (ca.error) snd = { state: 'bad', detail: n + '; route: ' + ca.error };
        else snd = { state: ca.connected ? 'ok' : 'wait', detail: n + (ca.connected ? ', on the speakers' : ', connecting the speakers') + lvl };
    }
    rows.push(Object.assign({ label: 'Sound' }, snd));
}

/** the QR code's dark modules for `text`: { n, dark(r, c) } */
function qr(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return { n: q.getModuleCount(), dark: (r, c) => q.isDark(r, c) };
}

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let st = null, busy = null, polling = false, askedExit = false, code = null, codeFor = null;
        let chans = { at: null, channels: [], epg: {} };
        /* ---------- the guide: a channel's programme, asked for when it is drawn, kept 3 minutes ---------- */
        const guides = new Map();   // uuid -> { state, events, error, at }
        function guideOf(uuid) {
            if (!uuid) return null;
            const g = guides.get(uuid);
            if (g && (g.state === 'loading' || Date.now() - g.at < 3 * 60000)) return g;
            const e = { state: 'loading', events: g ? g.events : [], at: Date.now() };
            guides.set(uuid, e);
            ask('epg', { uuid }).then((r) => {
                const done = r && r.events ? { state: 'ok', events: r.events, at: Date.now() } : { state: 'error', events: [], error: r ? r.error : 'no service', at: Date.now() };
                guides.set(uuid, done);
                if (mirror.state().shown) mirror.tick();
            });
            return e;
        }
        // the channels' logos, asked for when a row with them is drawn
        // a logo's first fetch goes over LTE through the service: 20 s for it (5 s gave it up in the car, for 10 minutes)
        // kept by the channel's logo address (a new ?v= is a new logo): iconOf gives it
        const iconOf = (uuid) => { const c = chans.channels.filter((x) => x.uuid === uuid)[0]; return c ? c.icon || '' : ''; };
        const logos = createLogos({ ask: (cmd, x) => ask(cmd, x, 20000), png, log, iconOf, onChange: () => { if (mirror && mirror.state().shown) mirror.tick(); } });

        /* ---------- the last channel, kept for "Watch" ---------- */
        const lastFile = ctx.dataDir ? path.join(ctx.dataDir, 'last-channel.json') : null;
        let lastUuid = null;
        try { lastUuid = JSON.parse(fs.readFileSync(lastFile, 'utf8')).uuid || null; } catch (e) { /* none yet */ }
        function remember(uuid) {
            if (!uuid || uuid === lastUuid) return;
            lastUuid = uuid;
            try { if (lastFile) fs.writeFileSync(lastFile, JSON.stringify({ uuid })); } catch (e) { log.warn('tvh: last channel: ' + e); }
        }

        function prefsNow() {
            const p = ctx.settings.get('profile');
            const g = Number(ctx.settings.get('gain'));
            return { profile: PROFILES.indexOf(p) >= 0 ? p : 'mgu-hd', adaptive: ctx.settings.get('adaptive') !== false, subs: ctx.settings.get('subs') !== false,
                gain: isFinite(g) ? g : 9, even: ctx.settings.get('even') === true };
        }
        async function poll() {
            if (polling) return;
            polling = true;
            try {
                st = await ask('status');
                const want = prefsNow(), have = st && st.prefs;
                if (st && st.version && (!have || have.profile !== want.profile || have.adaptive !== want.adaptive || have.subs !== want.subs || have.gain !== want.gain || have.even !== want.even)) {
                    const r = await ask('prefs', want);
                    if (r) st = r;
                }
                if (st && st.version && older(st.version, SERVICE_VERSION) && !askedExit) {
                    askedExit = true;
                    log.info('tvh: service ' + st.version + ' running, ' + SERVICE_VERSION + ' installed: asking it to end');
                    busy = 'Updating the service...';
                    await ask('exit');
                    await new Promise((r) => setTimeout(r, 1500));
                    st = await ask('status');
                    busy = null;
                }
                // the channel list when it changed (not in every status: a few hundred channels)
                if (st && st.channels && st.channels.at && st.channels.at !== chans.at) {
                    const r = await ask('channels');
                    if (r && r.channels) chans = r;
                }
                if (st && !st.account) chans = { at: null, channels: [], epg: {} };
                const pb = st && st.playback;
                if (pb && pb.channel && channelOn(pb)) remember(pb.channel.uuid);
            } finally { polling = false; }
        }
        async function command(cmd, label, extra) {
            busy = label;
            const r = await ask(cmd, extra);
            busy = null;
            if (r) st = r;
            log.info('tvh: ' + cmd + ' -> ' + (r ? (r.client && r.client.state) : 'no service'));
            return render();
        }
        function playChannel(uuid, why) {
            const ch = chans.channels.filter((c) => c.uuid === uuid)[0];
            if (!ch) return render();
            log.info('tvh: ' + why + ': ' + chName(ch));
            remember(uuid);
            sel = uuid; selAt = Date.now();
            mirror.wantAgain();
            return command('play', 'Tuning ' + chName(ch) + '...', { uuid });
        }
        const playing = () => { const pb = st && st.playback; return channelOn(pb) && pb.channel ? pb.channel.uuid : null; };
        function zap(d) {
            const from = playing() || selected();
            const ch = neighbour(chans.channels, from, d);
            if (ch) return playChannel(ch.uuid, d > 0 ? 'channel +' : 'channel -');
            return render();
        }

        /* ---------- skip on the steering wheel: channel - / + (wheel.js) ---------- */
        const wheel = createWheel({ log, zap: (d) => { zap(d); render(); }, enabled: () => ctx.settings.get('wheel') !== false,
            active: () => channelOn(st && st.playback) || lostOf(st && st.playback) });
        if (ctx.signals && ctx.signals.watch) {
            const h = {}; h[WHEEL_FIELD] = wheel.onSwitch;
            ctx.signals.watch(WHEEL_IFACE, '1', h, log).then((r) => log.info('tvh: steering wheel ' + (r && r.available ? 'watched' : 'not available yet' + (r && r.error ? ': ' + r.error : ''))))
                .catch((e) => log.warn('tvh: steering wheel: ' + e));
        }

        // Sign out, and Sign in while signed in, want a second press within 5 s (a stray press of the controller)
        const confirm = { at: 0, what: null };
        function confirmed(what, ask_) {
            if (confirm.what === what && Date.now() < confirm.at) { confirm.what = null; return true; }
            confirm.what = what; confirm.at = Date.now() + 5000;
            busy = ask_;
            setTimeout(() => { if (busy === ask_) { busy = null; render(); } }, 5000);
            render();
            return false;
        }
        ui.onClick('BTN_SIGNIN', () => {
            if (st && st.account && !(st.page && st.page.open) && !confirmed('signin', 'Signed in: press "Sign in" again to sign in anew')) return;
            return command('signin-open', 'Opening the sign-in page...');
        });
        ui.onClick('BTN_SIGNOUT', () => {
            if (!(st && st.account)) return;
            if (!confirmed('signout', 'Press "Sign out" again to sign out')) return;
            return command('signout', 'Signing out...');
        });
        ui.onClick('BTN_WATCH', () => {
            const want = selected();
            if (playing() && (!want || want === playing())) { mirror.wantAgain(); sync(); return render(); }
            const ch = chans.channels.filter((c) => c.uuid === want)[0] || chans.channels[0];
            if (!ch) { busy = st && st.account ? 'No channels yet' : 'Sign in first'; setTimeout(() => { busy = null; render(); }, 3000); return render(); }
            return playChannel(ch.uuid, 'watch');
        });
        ui.onClick('BTN_CHUP', () => zap(1));
        ui.onClick('BTN_CHDOWN', () => zap(-1));
        ui.onClick('BTN_STOP', () => command('stop', 'Stopping...'));

        /* ---------- the channel: the picture over the screen (parked only), the sound on the speakers ---------- */
        const parked = Parked.watch(ctx, log, { strict: true });
        const mirror = createMirrorView({ RenderClient, Recorder: record.Recorder, kit: record, appId: ctx.spec.id, log,
            hintText: 'Touch the picture or use the iDrive controller for the controls', overlay: () => overlay(),
            onTouch: (phase, x, y, pl) => {
                if (lostOf(st && st.playback)) { if (phase === 'up') tryAgain('a touch'); return; }
                if (pl && controls.touch(phase, x, y, pl, barInfo())) mirror.tick();
            },
            onCcu: (c) => {
                // lost: a press tries again; a push (tilt) leaves the picture as ever
                if (lostOf(st && st.playback)) { const p = c.press && c.press !== lastPress; lastPress = c.press; if (p) tryAgain('the controller'); return !c.tilt; }
                lastPress = c.press;
                const r = controls.ccu(c); mirror.tick(); return r;
            },
            onShown: (on) => pageTouch(!on),
            // another channel: a new player; the picture stays up (black, "Tuning...") meanwhile
            // and while the connection is lost: its message stays, a press tries again
            hold: () => channelOn(st && st.playback) || lostOf(st && st.playback),
            holdText: 'between two channels',
            idleText: 'the player is not running', hiddenText: 'hidden: press "Watch" to show it again',
            statIno: (p) => { const f = fs.statSync(p); return f.isFile() ? f.ino : null; } });
        // while the picture shows, the page underneath claims no touch (Emby 0.3.0 in the car: a touch went to the
        // page's buttons under the picture)
        const disp = ctx.display;
        let pageClaims = true;
        if (disp && typeof disp._claimTabs === 'function') {
            const claimTabs = disp._claimTabs.bind(disp);
            disp._claimTabs = (rects, r) => {
                if (pageClaims) return claimTabs(rects, r);
                disp.tabs = [];
                if (disp.gpu && disp.gpu.claim) disp.gpu.claim([]);
                return undefined;
            };
        }
        // 0.1.0 in the car: the page was drawn OVER the picture (the picture showed only right of the header's tabs, where
        // the page draws nothing). mgu-render stacks each connection's layer when it is put on the screen (its first
        // show, or put back after the HMI set the screen's layers), not at each SHOW (mgu-store native/mgu-render
        // src/main.c, layer_put): the page's layer could come back above the picture's, and a SHOW of the picture does
        // not raise it. So while the picture is up the page's layer is hidden altogether (SHOW off; the picture covers the
        // whole screen anyway): whatever their order, the picture shows, and the controller is the picture's alone.
        if (disp && typeof disp._syncVisible === 'function') {
            const syncVisible = disp._syncVisible.bind(disp);
            disp._syncVisible = () => {
                if (!pageClaims && disp.gpu) { disp.gpu.show(false); return undefined; }
                return syncVisible();
            };
        }
        function pageTouch(on) {
            if (on === pageClaims) return;
            pageClaims = on;
            log.info('tvh: the page ' + (on ? 'shows again' : 'is hidden while the picture shows'));
            try {
                if (!on) {
                    if (disp && disp.gpu && disp.gpu.claim) disp.gpu.claim([]);
                    if (disp && disp.gpu && disp.gpu.show) disp.gpu.show(false);
                } else if (disp) {
                    if (disp._syncVisible) disp._syncVisible();
                    disp.lastWords = null;
                    if (disp._repaint) disp._repaint();
                }
            } catch (e) { log.warn('tvh page: ' + e); }
        }
        const carAudio = createCarAudio(ctx.signals, log, { file: ctx.dataDir ? path.join(ctx.dataDir, 'car-audio.json') : null });
        setZone(() => ctx.settings.get('tz') || 'eet');
        const parkedOnly = () => ctx.settings.get('parkedOnly') !== false;
        /** the player as the mirror view knows a receiver: running, its decoder, pictures shown */
        function rxOf(s) {
            const pb = s && s.playback, pl = s && s.player;
            if (!channelOn(pb) || !pl || !pl.running) return null;
            const d = pl.decoder;
            return { running: true, videoRunning: true, stream: { shown: pl.tick ? pl.tick.shown : 0 },
                decoder: d ? { ok: d.ok, error: d.error, path: d.path || pl.videoPath, w: d.w, h: d.h } : null };
        }

        /* ---------- the controls over the picture ---------- */
        const ASPECTS = ['fit', 'zoom', 'fill'];
        const aspect = () => (ASPECTS.indexOf(ctx.settings.get('aspect')) >= 0 ? ctx.settings.get('aspect') : 'fit');
        let lastPress = 0;
        function tryAgain(by) {
            const pb = st && st.playback;
            if (pb && pb.channel) playChannel(pb.channel.uuid, 'again (' + by + ')');
        }
        const controls = createControls({
            guide: guideOf,
            act: (a) => {
                if (a && a.channel) return playChannel(a.channel, 'from the list');
                if (a === 'chup') return zap(1);
                if (a === 'chdown') return zap(-1);
                if (a === 'stop') { controls.hide(); return command('stop', 'Stopping...'); }
                if (a === 'aspect') { ctx.settings.set('aspect', ASPECTS[(ASPECTS.indexOf(aspect()) + 1) % ASPECTS.length]); return mirror.tick(); }
                if (a === 'exit') return mirror.hide('the controls');
            },
        });
        function barInfo() {
            const pb = (st && st.playback) || {};
            const cur = pb.channel ? pb.channel.uuid : null;
            return {
                title: chName(pb.channel), now: cur ? chans.epg[cur] || null : null, aspect: aspect(),
                profile: pb.profile ? (QUALITY[pb.profile] || pb.profile) + (pb.lowered ? ' (slow)' : '') : '', note: pb.interlaced ? 'interlaced' : pb.state === 'buffering' ? 'buffering' : '',
                current: cur, drawLogo: logos.draw, logoVer: logos.version(),
                channels: chans.channels.map((c) => ({ uuid: c.uuid, n: chName(c), t: chName(c) + (chans.epg[c.uuid] && chans.epg[c.uuid].title ? '  -  ' + chans.epg[c.uuid].title : '') })),
            };
        }
        function overlay() {
            const pl = st && st.player, d = pl && pl.decoder;
            const fw = d && d.ok ? d.w : 0, fh = d && d.ok ? d.h : 0, mode = aspect();
            const info = barInfo();
            const bar = controls.key(info);
            const pb = st && st.playback;
            const lost = lostOf(pb);
            const loading = lost || !!(pb && (pb.state === 'loading' || pb.state === 'buffering') && !(pl && pl.running && pl.tick && pl.tick.shown > 0));
            // reconnecting: since the break, by the second (the key changes each second: the overlay is drawn again)
            const word = lost ? 'No connection to the server. Press to try again'
                : pb && pb.state === 'loading' && pb.retrySince ? 'Reconnecting... ' + mmss(Date.now() - pb.retrySince)
                    : pb && pb.state === 'loading' ? 'Tuning ' + info.title + '...' : 'Buffering...';
            return {
                key: [mode, fw, fh, bar, loading, word].join('#'),
                rect: (p) => videoRect(mode, fw, fh, p),
                draw: (rec, p) => {
                    if (loading) rec.text(word, p.w / 2, p.h / 2, Math.round(p.h * 0.05), 0xffffffb0, { align: 'center', font: 'bold', literal: true });
                    if (bar) controls.draw(rec, p, info);
                },
            };
        }
        setInterval(() => { if (mirror.state().shown) mirror.tick(); }, 200);

        /* ---------- the channel on the instrument cluster: a card over the media widget (cluster_card.js) ---------- */
        const offsetOf = (k) => { const v = Number(ctx.settings.get(k)); return isFinite(v) ? Math.max(-160, Math.min(160, v)) : 0; };
        const card = createClusterCard({ log, ask, png, hm, Canvas,
            enabled: () => ctx.settings.get('cluster') !== false,
            offset: () => ({ dx: offsetOf('clusterX'), dy: offsetOf('clusterY') }),
            hmKey: () => ctx.settings.get('tz') || '',
            info: () => {
                const pb = st && st.playback;
                if (!channelOn(pb) || !pb.channel) return null;
                const uuid = pb.channel.uuid, e = chans.epg[uuid] || {};
                const g = guideOf(uuid), now = Date.now() / 1000;
                const next = g && g.events ? g.events.filter((x) => x.start >= (e.stop || now))[0] || null : null;
                return { uuid, name: chName(pb.channel), title: e.title || '', start: e.start, stop: e.stop, next: next ? { start: next.start, title: next.title } : null };
            } });
        setInterval(() => { try { card.update(); } catch (e) { log.warn('cluster: ' + (e && e.stack || e)); } }, 1000);

        let soundUntil = 0;
        function sync() {
            const pb = st && st.playback;
            mirror.update({ rx: rxOf(st), pageVisible: shown(), driving: parkedOnly() && parked.moving() });
            // the speakers while a channel is on, and between two channels (each a new player); 5 s more after it
            const pl = st && st.player;
            const soundFailed = !!(pl && pl.running && pl.audio && pl.audio.ok === false);
            const on = channelOn(pb) && !soundFailed;
            if (on) soundUntil = Date.now() + 5000;
            carAudio.want(on || Date.now() < soundUntil);
        }
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { card.close(); mirror.close(); carAudio.want(false); ask('stop'); });

        /* ---------- the page: TV (the channels, the selected one's programme) and Status (the diagnosis) ---------- */
        let tab = 0;                 // 0 TV, 1 Status
        let sel = null, selAt = 0;   // the channel whose programme shows (chosen on the page; else the one playing)
        let first = 0, firstFor = null;   // the list's first row, kept so the selected channel shows
        const evSel = { uuid: null, i: 0 };   // the programme's chosen entry (its details below), its index from now
        let evFirst = 0, evLen = 0;           // the programme's first row shown, how many entries it has
        const ROWS = 8, ROW_H = 50, EV_ROWS = 6, EV_ROW_H = 42, EV_X = 808;

        /* ---------- scrolling: a finger dragged on a list, the controller's knob along its rows ---------- */
        // A finger dragged on the page (the kit: cv.scroll and ctx.onScroll) moves the list it is on: the channels on the
        // left, the programme on the right, a row each ROW_H / EV_ROW_H; a drag is no press on a row.
        let scrollAcc = 0, scrollCol = null;
        ctx.onScroll((dy) => {
            if (tab !== 0) return false;
            const d = ctx.display, pl = d && d.place, at = d && d.downAt;
            const k = pl && pl.scale ? pl.scale : 1;
            const col = pl && at && (at.x - pl.ox) / k > EV_X - 30 ? 'ev' : 'ch';
            if (col !== scrollCol) { scrollCol = col; scrollAcc = 0; }
            scrollAcc += dy / k;
            const rowH = col === 'ev' ? EV_ROW_H : ROW_H;
            const steps = scrollAcc > 0 ? Math.floor(scrollAcc / rowH) : Math.ceil(scrollAcc / rowH);
            if (!steps) return true;
            scrollAcc -= steps * rowH;
            if (col === 'ev') {
                const to = Math.max(0, Math.min(evLen - EV_ROWS, evFirst + steps));
                if (to === evFirst) return false;
                evFirst = to;
            } else {
                const to = Math.max(0, Math.min(chans.channels.length - ROWS, first + steps));
                if (to === first) return false;
                first = to;
                firstFor = selected();   // the selected channel may scroll out of sight: the list stays where the finger left it
            }
            render();
            return true;
        });
        const disp0 = ctx.display;
        if (disp0 && typeof disp0._ring === 'function') {
            // the knob goes along the rows, not over the whole page as one place (the kit's ring has one for a page that scrolls)
            const ring0 = disp0._ring.bind(disp0);
            disp0._ring = () => ring0().filter((p) => !p.scroll);
        }
        if (disp0 && typeof disp0._focus === 'function') {
            // 0.1.4 in the car: the knob went along the rows shown and then on to the programme, the rest of the list out of
            // reach but for the arrows. Now the controller on the last row shown (or the first) moves the list a row on, so
            // the next one is always there to turn to; at the list's end it goes on as before.
            const focus0 = disp0._focus.bind(disp0);
            disp0._focus = (p) => { focus0(p); follow(p && p.k); };
        }
        function follow(key) {
            if (tab !== 0 || !key) return;
            let m = /^tgt:ch:(.+)$/.exec(key);
            if (m) {
                const n = chans.channels.length, i = chans.channels.findIndex((c) => c.uuid === m[1]);
                if (i < 0) return;
                const slot = i - first;
                if (slot >= ROWS - 1 && i < n - 1) first = Math.min(n - ROWS, i - ROWS + 2);
                else if (slot <= 0 && i > 0) first = Math.max(0, i - 1);
                else return;
                firstFor = selected();
                render();
                return;
            }
            m = /^tgt:ev:(\d+)$/.exec(key);
            if (m) {
                const i = Number(m[1]), slot = i - evFirst;
                if (slot >= EV_ROWS - 1 && i < evLen - 1) evFirst = Math.min(evLen - EV_ROWS, i - EV_ROWS + 2);
                else if (slot <= 0 && i > 0) evFirst = Math.max(0, i - 1);
                else return;
                render();
            }
        }
        ctx.onTab((i) => { tab = i; return render(); });
        ui.onClick('BTN_PAGE', () => { tab = 1 - tab; return render(); });
        /** the selected channel: chosen on the page in the last 30 s, else the one playing, else the last one */
        function selected() {
            const list = chans.channels, has = (u) => u && list.some((c) => c.uuid === u);
            if (has(sel) && Date.now() - selAt < 30000) return sel;
            const u = playing() || lastUuid;
            return has(u) ? u : has(sel) ? sel : list[0] && list[0].uuid;
        }
        function choose(uuid) {
            if (uuid === selected() && Date.now() - selAt < 30000 && uuid !== playing()) return playChannel(uuid, 'from the page');
            if (uuid === selected() && uuid === playing()) { mirror.wantAgain(); sync(); return render(); }
            sel = uuid; selAt = Date.now();
            return render();
        }
        const pctOf = (e, tnow) => (e && e.start && e.stop && e.stop > e.start ? Math.max(0, Math.min(1, (tnow - e.start) / (e.stop - e.start))) : 0);
        /** `text` in at most `max` lines of `w` px (the label font) */
        function lines(cv, text, size, w, max) {
            const out = [];
            let cur = '';
            String(text || '').split(/\s+/).filter(Boolean).forEach((word) => {
                const next = cur ? cur + ' ' + word : word;
                if (cur && cv.textWidth(next, size, { font: 'label', literal: true }) > w) { out.push(cur); cur = word; } else cur = next;
            });
            if (cur) out.push(cur);
            if (out.length > max) { out.length = max; out[max - 1] = clip(cv, out[max - 1] + ' ' + 'x'.repeat(200), size, w, 'label'); }
            return out;
        }

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const page = st && st.page && st.page.open ? st.page : null;
            const pb = st && st.playback;
            const live = lostOf(pb) ? { text: 'NO CONNECTION', color: 'accent' } : pb && pb.state === 'error' ? { text: 'ERROR', color: 'accent' }
                : pb && pb.state === 'loading' && pb.retrySince ? { text: 'RECONNECTING', color: 'accent' } : pb && pb.state === 'buffering' ? { text: 'BUFFERING' }
                : pb && channelOn(pb) ? { text: pb.state === 'playing' ? 'LIVE ' + (QUALITY[pb.profile] || pb.profile || '') : 'TUNING', color: 'cold' } : null;
            G.frame(cv, t, ['TV', 'Status'], tab, [busy && { text: busy, color: 'accent' }, page && { text: 'SIGN-IN ' + Math.ceil((page.left || 0) / 60) + ' MIN' }, live]);
            if (st) { st.mirror = mirror.state(); st.carAudio = carAudio.state(); st.logoStats = logos.stats(); st.cluster = card.state(); st.wheel = wheel.state(); }
            if (tab === 1) drawStatus(cv, t, page); else drawTv(cv, t, page);
            return ui.image('MAIN_GFX', cv);
        }

        /** Status: the steps, each with its light, and the service's log */
        function drawStatus(cv, t, page) {
            const rows = steps(st);
            const COL = { ok: GREEN, wait: AMBER, bad: RED, off: withAlpha('#ffffff', 0.3) };
            const textW = page ? 860 : 1300, rowH = 46;
            rows.forEach((r, i) => {
                const y = 84 + i * rowH;
                cv.circle(44, y - 8, 10, COL[r.state]);
                cv.text(r.label, 68, y, 24, t.text, { font: 'bold', literal: true });
                cv.text(clip(cv, r.detail || '', 22, textW, 'label'), 250, y, 22, r.state === 'off' ? t.dim : t.text, { literal: true });
            });
            if (page) return drawCode(cv, t, page);
            const n = Math.max(2, Math.floor((500 - (84 + rows.length * rowH)) / 22));
            (st && st.log ? st.log : []).slice(-n).forEach((l, i, a) => cv.text(clip(cv, l, 16, 1520, 'label'), 44, 500 - (a.length - 1 - i) * 22, 16, t.dim, { literal: true }));
        }

        /** TV: the channels on the left, the selected one's programme on the right */
        function drawTv(cv, t, page) {
            const touch = !!(cv.own && cv.target);
            if (touch) cv.scroll = true;   // a finger dragged on the page scrolls the list it is on (ctx.onScroll)
            const list = chans.channels;
            if (!list.length) {
                // nothing to list yet: what is missing, from the steps (the first one not green)
                const rows = steps(st), bad = rows.filter((r) => r.state !== 'ok')[0];
                cv.text(bad ? bad.label : 'Channels', page ? 420 : 800, 220, 30, t.text, { align: 'center', font: 'bold', literal: true });
                cv.text(clip(cv, bad ? bad.detail : 'loading the channels...', 22, page ? 780 : 1400, 'label'), page ? 420 : 800, 262, 22, t.dim, { align: 'center', literal: true });
                if (page) drawCode(cv, t, page);
                return;
            }
            drawChannels(cv, t, touch);
            if (page) return drawCode(cv, t, page);
            drawProgramme(cv, t, touch);
        }

        function arrow(cv, x, y, up, c) {
            cv.quad(up ? [[x - 10, y + 6], [x, y - 6], [x + 10, y + 6], [x + 10, y + 6]] : [[x - 10, y - 6], [x + 10, y - 6], [x, y + 6], [x, y + 6]], c);
        }
        /** the channels: logo, number and name, what is on now and how far it is; the selected one tinted, the one playing marked */
        function drawChannels(cv, t, touch) {
            const x0 = 24, w = 740, top = 52, rowH = ROW_H, rows = ROWS, lw = LOGO.w + 14;
            const list = chans.channels, cur = selected(), on = playing();
            const at = Math.max(0, list.findIndex((c) => c.uuid === cur));
            if (firstFor !== cur) { firstFor = cur; if (at < first || at >= first + rows) first = at - 2; }
            first = Math.max(0, Math.min(first, list.length - rows));
            cv.text('CHANNELS', x0, top + 18, 18, t.dim, { font: 'bold', literal: true });
            if (list.length > rows) {
                cv.text((first + 1) + '-' + Math.min(list.length, first + rows) + ' / ' + list.length, x0 + w - 120, top + 18, 18, t.dim, { align: 'right', literal: true });
                arrow(cv, x0 + w - 80, top + 12, true, first > 0 ? t.text : withAlpha('#ffffff', 0.2));
                arrow(cv, x0 + w - 24, top + 12, false, first + rows < list.length ? t.text : withAlpha('#ffffff', 0.2));
                if (touch) {
                    cv.target(x0 + w - 104, top - 8, 48, 40, () => { first = Math.max(0, first - (rows - 1)); return render(); }, 'up', 8);
                    cv.target(x0 + w - 48, top - 8, 48, 40, () => { first = Math.min(list.length - rows, first + rows - 1); return render(); }, 'down', 8);
                }
            }
            const tnow = Date.now() / 1000;
            list.slice(first, first + rows).forEach((c, k) => {
                const y = top + 34 + k * rowH, isSel = c.uuid === cur, e = chans.epg[c.uuid];
                if (isSel) cv.fillRect(x0 - 8, y, w + 16, rowH - 4, withAlpha(BLUE, 0.28));
                if (c.uuid === on) cv.quad([[x0, y + 13], [x0 + 14, y + 23], [x0, y + 33], [x0, y + 33]], GREEN);
                logos.draw(cv, c.uuid, x0 + 22, y + 5, c.name);
                const nx = x0 + 22 + lw, ny = y + 26;
                cv.text(clip(cv, chName(c), 22, 250, 'label'), nx, ny, 22, t.text, { font: isSel || c.uuid === on ? 'bold' : undefined, literal: true });
                if (e && e.title) {
                    cv.text(clip(cv, e.title, 19, x0 + w - nx - 270, 'label'), x0 + w, ny, 19, t.dim, { align: 'right', literal: true });
                    const f = pctOf(e, tnow);
                    cv.fillRect(nx, y + 36, x0 + w - nx, 3, withAlpha('#ffffff', 0.1));
                    if (f) cv.fillRect(nx, y + 36, Math.round((x0 + w - nx) * f), 3, BLUE);
                }
                if (touch) cv.target(x0 - 8, y, w + 16, rowH - 4, () => choose(c.uuid), 'ch:' + c.uuid, 8);
            });
        }

        /** the selected channel's programme: from now, the chosen entry's details below */
        function drawProgramme(cv, t, touch) {
            const x0 = EV_X, w = 768, top = 52;
            const uuid = selected(), ch = chans.channels.filter((c) => c.uuid === uuid)[0];
            cv.fillRect(x0 - 22, top, 1, 456, withAlpha('#ffffff', 0.12));
            const lw = logos.draw(cv, uuid, x0, top + 2, ch && ch.name) ? LOGO.w + 14 : 0;
            cv.text(clip(cv, chName(ch), 26, w - lw - 230, 'label'), x0 + lw, top + 30, 26, t.text, { font: 'bold', literal: true });
            const watching = uuid === playing();
            const hint = watching ? 'WATCHING' : touch ? 'PRESS AGAIN TO WATCH' : '"WATCH" TO WATCH';
            cv.text(hint, x0 + w, top + 28, 16, watching ? GREEN : BLUE, { align: 'right', font: 'bold', literal: true });
            const g = guideOf(uuid), tnow = Date.now() / 1000;
            const ev = g ? (g.events || []).filter((e) => e.stop > tnow) : [];
            if (!ev.length) {
                cv.text(g && g.state === 'error' ? 'No programme: ' + (g.error || '?') : g && g.state === 'loading' ? 'Loading the programme...' : 'No programme for this channel',
                    x0, top + 100, 20, t.dim, { literal: true });
                return;
            }
            if (evSel.uuid !== uuid) { evSel.uuid = uuid; evSel.i = 0; evFirst = 0; }
            const rows = EV_ROWS, rowH = EV_ROW_H, y0 = top + 52;
            evLen = ev.length;
            evFirst = Math.max(0, Math.min(evFirst, ev.length - rows));
            evSel.i = Math.max(0, Math.min(evSel.i, ev.length - 1));
            const shown = ev.slice(evFirst, evFirst + rows);
            const tw = Math.max.apply(null, shown.map((e) => cv.textWidth(when(e.start, Date.now()), 20, { font: 'bold', literal: true }))) + 20;
            if (ev.length > rows) cv.text((evFirst + 1) + '-' + (evFirst + shown.length) + ' / ' + ev.length, x0 + w, y0 + rows * rowH - 4, 14, t.dim, { align: 'right', literal: true });
            shown.forEach((e, k0) => {
                const k = evFirst + k0, y = y0 + k0 * rowH, now = e.start <= tnow, chosen = k === evSel.i;
                if (chosen) cv.fillRect(x0 - 8, y, w + 16, rowH - 4, withAlpha('#ffffff', 0.07));
                cv.text(when(e.start, Date.now()), x0, y + 26, 20, now ? BLUE : t.dim, { font: 'bold', literal: true });
                cv.text(clip(cv, e.title + (e.subtitle ? ' - ' + e.subtitle : ''), 21, w - tw, 'label'), x0 + tw, y + 26, 21, t.text, { font: now ? 'bold' : undefined, literal: true });
                if (now) {
                    cv.fillRect(x0 + tw, y + 34, w - tw, 3, withAlpha('#ffffff', 0.1));
                    cv.fillRect(x0 + tw, y + 34, Math.round((w - tw) * pctOf(e, tnow)), 3, BLUE);
                }
                if (touch) cv.target(x0 - 8, y, w + 16, rowH - 4, () => { evSel.i = k; return render(); }, 'ev:' + k, 8);
            });
            // the chosen entry: its time, length, and description
            const e = ev[evSel.i], dy = y0 + rows * rowH + 8;
            cv.fillRect(x0, dy - 6, w, 1, withAlpha('#ffffff', 0.12));
            const mins = Math.round((e.stop - e.start) / 60);
            const left = e.start <= tnow ? ', ' + Math.max(1, Math.round((e.stop - tnow) / 60)) + ' min left' : '';
            cv.text(clip(cv, e.title, 20, w - 300, 'label'), x0, dy + 22, 20, t.text, { font: 'bold', literal: true });
            cv.text(when(e.start, Date.now()) + ' - ' + hm(e.stop) + '  (' + mins + ' min' + left + ')', x0 + w, dy + 22, 18, BLUE, { align: 'right', font: 'bold', literal: true });
            const text = [e.episode, e.text].filter(Boolean).join('  -  ') || 'No description';
            lines(cv, text, 18, w, 3).forEach((l, i) => cv.text(l, x0, dy + 48 + i * 23, 18, t.dim, { font: 'label', literal: true }));
        }

        function drawCode(cv, t, page) {
            const x0 = 1150, y0 = 70, box = 380;
            if (!page.url) {
                cv.text('No car Wi-Fi yet:', x0, y0 + 40, 22, t.text, { font: 'bold', literal: true });
                cv.text('connect the iPhone with wireless CarPlay', x0, y0 + 72, 18, t.dim, { literal: true });
                return;
            }
            if (codeFor !== page.url) { code = qr(page.url); codeFor = page.url; }
            const cell = Math.floor(box / (code.n + 8));
            const size = cell * (code.n + 8);
            const ox = x0 + Math.floor((box - size) / 2), oy = y0;
            cv.fillRect(ox, oy, size, size, '#ffffff');
            for (let r = 0; r < code.n; r++) for (let c = 0; c < code.n; c++) {
                if (code.dark(r, c)) cv.fillRect(ox + (c + 4) * cell, oy + (r + 4) * cell, cell, cell, '#000000');
            }
            cv.text('Scan with the iPhone camera', x0 + box / 2, oy + size + 34, 20, t.text, { font: 'bold', align: 'center', literal: true });
            cv.text(clip(cv, page.url, 16, box + 40, 'label'), x0 + box / 2, oy + size + 60, 16, t.dim, { align: 'center', literal: true });
        }

        // while the page shows; in the background only while a channel is on (its sound, the service's watch)
        function shown() { return !ui.isVisible || ui.isVisible('MAIN'); }
        let tick = 0;
        setInterval(() => {
            tick++;
            const on = channelOn(st && st.playback);
            if (shown() || (on && tick % 2 === 0)) poll().catch(() => {});
            sync();
        }, 1000);
        if (ui.onVisible) ui.onVisible(() => sync());
        await poll();
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('TVH Player first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { steps, qr, ask, ACTIVE, channelOn, neighbour, chName };
