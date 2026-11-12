'use strict';
/**
 * playback.js - the channel that plays: its stream from Tvheadend with a stream profile, the player's state, the
 * profile lowered when the internet is slow. Runs in the TVH client (client.js, uid 13101: the internet); the
 * player itself (tvh-player, started by the root service) gets the stream through `sink`.
 *
 *   const pb = createPlayback({ tvh, log, now, sink, profiles: () => names | null });
 *   pb.play(channel)      { uuid, name, number }: another channel is a new stream and a new player
 *   pb.stop()             ends it
 *   pb.setPrefs({ profile, adaptive })
 *   pb.onPlayer(id, ev)   the player's events (open, decoder, audio, tick, end, error, exit), stream id first
 *   pb.status()           for the app
 *   sink: { start(id), data(id, buf) -> bool (false: wait for drain), end(id), drain(id, fn), ctl(id, line), stop(id) }
 *
 * The stream: /stream/channel/<uuid>?profile=<profile>, MPEG-TS. The server's profiles for the car (mgu-hd, mgu-sd,
 * mgu-low: H.264 progressive, deinterlaced by the server's VAAPI, with AAC) are a ladder, best first: with
 * "lower the quality by itself" on, the stream running dry (the player "buffering") twice within a minute, or for 8 s
 * at once, goes on with the next profile down (a new stream of the same channel); 5 minutes without running dry, one
 * back up, never above the setting; 30 s at least between two steps. A profile the server does not have is passed
 * over.
 *
 * Reconnecting (0.1.6 in the car: through a weak LTE area the stream froze, "Tuning..." and the player was gone: 3
 * tries 2 s apart were over before the signal came back). A stream that breaks, ends, or brings nothing for 10 s (a
 * connection LTE dropped without closing it: 15 s for its first bytes) is opened again for 2 minutes from the break,
 * 1, 2, 4, 8, then every 10 s; with "lower the quality" on, a stream that had played comes back one profile down (the
 * ladder takes it up again after 5 clean minutes). The status says since when (`retrySince`) and the next try
 * (`retryAt`); after 2 minutes, an error with `lost: true` (the app keeps its screen, a press tries again). What
 * trying again does not mend is said at once (refused, no channel or profile); no free tuner (503) and a player that
 * crashed are tried 3 times.
 *
 * 1.0.1 (the car and the server's log, 2026-11-12): what broke HBO HD was the server, not LTE: its transcoder stops a
 * stream when the channel's MP2 sound jumps back in time ("non monotonically increasing dts ... muxer reported
 * errors"), and closes the connection cleanly; and its mgu-sd profile failed at once, every time ("Failed to write
 * mpegts header"), so the reconnection, gone a profile down, never came back. Now: a stream the server ends cleanly
 * is opened again with the same profile (only a network failure takes one down); a profile whose stream ends at once
 * (nothing played, within 8 s) twice is passed over for this channel's playing, said in the status (`badProfiles`),
 * and the stream goes on with the last profile that played.
 */
const LADDER = ['mgu-hd', 'mgu-sd', 'mgu-low'];
const STALL_WINDOW_MS = 60000;
const STALLS = 2;
const STALL_LONG_MS = 8000;
const SWITCH_COOLDOWN_MS = 30000;
const RETRIES = 3;                 // no free tuner (503), the player crashed
const OUTAGE_MS = 120000;          // the connection: tried for this long from the break
const BACKOFF = [1000, 2000, 4000, 8000, 10000];
const DATA_MS = 10000;             // nothing from the server for this long: the connection is gone
const FIRST_DATA_MS = 15000;       // ... before its first bytes (the server tunes and starts transcoding)

/** the kit's fonts have ASCII only: Romanian and other accented letters as ASCII (ș -> s) */
const ASCII = { 'ș': 's', 'ş': 's', 'Ș': 'S', 'Ş': 'S', 'ț': 't', 'ţ': 't', 'Ț': 'T', 'Ţ': 'T', '„': '"', '“': '"', '”': '"', '«': '"', '»': '"',
    '‘': "'", '’': "'", '‚': "'", '–': '-', '—': '-', '…': '...', ' ': ' ', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O',
    'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D' };
function ascii(s) {
    return String(s == null ? '' : s).replace(/[\s\S]/g, (ch) => (ASCII[ch] !== undefined ? ASCII[ch] : ch)).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e]/g, '');
}

/** the ladder this server has, from the setting down; [setting] alone when the profiles are unknown or not mgu-* */
function ladderFor(setting, have) {
    if (!have) return [setting];
    const i = LADDER.indexOf(setting);
    if (i < 0) return [setting];
    return LADDER.slice(i).filter((p) => have.indexOf(p) >= 0);
}

function createPlayback(o) {
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const tvh = o.tvh, sink = o.sink;
    const retryMs = o.retryMs != null ? o.retryMs : null;   // tests: one wait instead of the backoff
    const outageMs = o.outageMs || OUTAGE_MS;
    const dataMs = o.dataMs || DATA_MS, firstDataMs = o.firstDataMs || Math.max(FIRST_DATA_MS, o.dataMs || 0);
    const upAfterMs = o.adaptUpMs || 300000;
    // gain: dB the sound is raised (TV is 10-15 dB quieter than the radio; the player limits the peaks); even: its compressor
    const prefs = { profile: 'mgu-hd', adaptive: true, subs: true, gain: 9, even: false };
    let cur = null, ids = 0;
    const st = { state: 'idle', phase: null, phaseAt: null, error: null, at: now(), retrySince: null, retryAt: null, lost: false };

    function set(state, error) { st.state = state; st.error = error || null; st.at = now(); st.lost = false; if (state !== 'loading') st.phase = null; }
    function recovered(c) { c.outageSince = 0; c.outageStepped = false; c.tries = 0; c.busy = 0; c.crashes = 0; st.retrySince = null; st.retryAt = null; }
    function phase(p) { st.phase = p; st.phaseAt = now(); }

    function ladder() { const l = ladderFor(prefs.profile, o.profiles ? o.profiles() : null); return l.length ? l : [prefs.profile]; }
    /** the ladder without the profiles that failed at once on this playing */
    function usable(c) { const l = ladder(), u = c && c.bad ? l.filter((p) => !c.bad[p]) : l; return u.length ? u : l; }

    /* ---------- the stream ---------- */
    async function open(c, why) {
        const id = ++ids;
        c.id = id; c.stream = null; c.player = { state: 'starting', fields: 0, interlaced: false }; c.played = false;
        c.openedAt = now(); c.answered = false;
        set('loading'); phase('stream');
        log('stream ' + id + ': ' + c.ch.name + ' with ' + c.profile + (why ? ' (' + why + ')' : ''));
        let r;
        try { r = await tvh.stream(c.ch.uuid, c.profile); }
        catch (e) { return broke(c, id, e.message); }
        if (cur !== c || c.id !== id) { try { r.res.resume(); r.abort(); } catch (e) { /* gone */ } return; }
        if (r.status !== 200) {
            r.res.resume(); r.abort();
            const why2 = r.status === 401 || r.status === 403 ? 'the server refused the user (' + r.status + '): the streaming right, or this profile'
                : r.status === 404 ? 'the server has no such channel, or no profile "' + c.profile + '"'
                    : r.status === 503 ? 'no free tuner for this channel (503)' : 'HTTP ' + r.status;
            log('stream ' + id + ': ' + why2);
            if (r.status === 503) return broke(c, id, why2, 'busy');
            if (r.status >= 500) return broke(c, id, why2);
            return fail(c, why2);
        }
        c.stream = r;
        c.bytes = 0; c.answered = true;
        phase('player');
        sink.start(id);
        if (!prefs.subs) sink.ctl(id, 'subs off');
        sink.ctl(id, 'gain ' + prefs.gain);
        if (prefs.even) sink.ctl(id, 'even on');   // the player lays the channel's DVB subtitles over the picture unless told
        const res = r.res;
        c.lastData = now(); c.gotData = false; c.held = false;
        res.on('data', (d) => {
            if (cur !== c || c.id !== id) return;
            c.bytes += d.length;
            c.lastData = now(); c.gotData = true;
            if (!sink.data(id, d)) {
                // held back by the player's pipe, not by the server: the watch below waits
                res.pause(); c.held = true;
                sink.drain(id, () => { if (cur === c && c.id === id) { c.held = false; c.lastData = now(); res.resume(); } });
            }
        });
        // a connection the network dropped without closing it brings nothing: closed and opened again
        c.watch = setInterval(() => {
            if (cur !== c || c.id !== id) return;
            if (c.held) { c.lastData = now(); return; }
            const lim = c.gotData ? dataMs : firstDataMs;
            if (now() - c.lastData >= lim) ended('nothing from the server for ' + Math.round(lim / 1000) + ' s');
        }, Math.min(1000, Math.max(50, Math.round(dataMs / 4))));
        const ended = (what, kind) => {
            if (cur !== c || c.id !== id || c.closing) return;
            sink.end(id);
            broke(c, id, what, kind);
        };
        // the server closed it cleanly: its own doing (a transcoder error), not the network's
        res.on('end', () => ended('the server ended the stream', 'ended'));
        res.on('error', (e) => ended('the stream broke: ' + e.message));
        res.on('aborted', () => ended('the server closed the stream'));
    }
    /** a stream that could not open or broke: opened again for 2 minutes from the break (kind 'busy': no free tuner,
     *  'player': the player crashed, each 3 times), then an error */
    function broke(c, id, why, kind) {
        if (cur !== c || c.id !== id) return;
        const played = c.played;
        const quick = kind === 'ended' && c.answered && !played && now() - (c.openedAt || 0) < 8000;
        close(c);
        const t = now();
        // a profile whose stream the server ends at once, twice: passed over for this playing (the server's profile
        // is broken: 1.0.0 in the car, mgu-sd's "Failed to write mpegts header"), back to the last one that played
        if (quick) {
            c.fails = c.fails || {};
            c.fails[c.profile] = (c.fails[c.profile] || 0) + 1;
            if (c.fails[c.profile] >= 2) {
                c.bad = c.bad || {};
                c.bad[c.profile] = true;
                const u = usable(c), next = c.good && !c.bad[c.good] ? c.good : u[0];
                log('quality: ' + c.profile + ' fails on the server (its stream ends at once): passed over, ' + next + ' instead');
                c.profile = next; c.switchedAt = t; c.cleanSince = t; c.stalls = []; c.stallSince = 0;
            }
        }
        if (!c.outageSince) { c.outageSince = t; c.tries = 0; c.busy = 0; c.crashes = 0; c.outageStepped = false; }
        if (kind === 'busy' && ++c.busy > RETRIES) return fail(c, why);
        if (kind === 'player' && ++c.crashes > RETRIES) return fail(c, why);
        if (t - c.outageSince >= outageMs) {
            log('stream ' + id + ': ' + why + '; given up after ' + Math.round((t - c.outageSince) / 1000) + ' s');
            return fail(c, 'no connection to the server for ' + Math.round((t - c.outageSince) / 60000 * 10) / 10 + ' min (' + why + ')', true);
        }
        // the internet went away under a stream that played: it comes back a profile lower (once a break)
        if (!kind && played && prefs.adaptive && !c.outageStepped) {
            const l = usable(c), i = l.indexOf(c.profile), down = i >= 0 && i + 1 < l.length ? l[i + 1] : null;
            if (down) {
                log('quality: ' + c.profile + ' -> ' + down + ' (the stream broke)');
                c.profile = down; c.switchedAt = t; c.cleanSince = t; c.stalls = []; c.stallSince = 0;
            }
            c.outageStepped = true;
        }
        const wait = retryMs != null ? retryMs : BACKOFF[Math.min(c.tries, BACKOFF.length - 1)];
        c.tries++;
        c.reconnects++;
        log('stream ' + id + ': ' + why + '; again in ' + wait / 1000 + ' s (try ' + c.tries + ', ' + Math.round((t - c.outageSince) / 1000) + ' s since the break)');
        set('loading'); phase('retry'); st.error = why;
        st.retrySince = c.outageSince; st.retryAt = t + wait;
        c.retry = setTimeout(() => { c.retry = null; if (cur === c && !c.closing) open(c, 'again: ' + why); }, wait);
    }
    function fail(c, why, lost) {
        if (cur !== c) return;
        close(c);
        set('error', why);
        st.lost = !!lost; st.retrySince = null; st.retryAt = null;
    }
    /** the stream and its player end (the stream id is left: its bytes still in the pipe are dropped) */
    function close(c) {
        if (c.watch) { clearInterval(c.watch); c.watch = null; }
        if (c.stream) { try { c.stream.abort(); } catch (e) { /* gone */ } c.stream = null; }
        if (c.id) sink.stop(c.id);
        c.id = 0;   // its player's last events (its exit) are no longer ours
    }

    /* ---------- the quality ---------- */
    function adapt(c, state) {
        const t = now();
        if (state === 'buffering' && c.lastState !== 'buffering') { c.stalls.push(t); c.stallSince = t; }
        if (state !== 'buffering') c.stallSince = 0;
        if (state === 'buffering') c.cleanSince = t;
        c.lastState = state;
        c.stalls = c.stalls.filter((x) => t - x < STALL_WINDOW_MS);
        if (!prefs.adaptive || t - c.switchedAt < SWITCH_COOLDOWN_MS) return false;
        const l = usable(c), i = l.indexOf(c.profile);
        const down = i >= 0 && i + 1 < l.length ? l[i + 1] : null, up = i > 0 ? l[i - 1] : null;
        if (down && (c.stalls.length >= STALLS || (c.stallSince && t - c.stallSince >= STALL_LONG_MS))) {
            step(c, down, c.stalls.length >= STALLS ? 'the stream ran dry ' + c.stalls.length + ' times in a minute' : 'the stream ran dry for ' + Math.round((t - c.stallSince) / 1000) + ' s');
            return true;
        }
        if (up && state === 'playing' && t - c.cleanSince >= upAfterMs) { step(c, up, Math.round(upAfterMs / 60000) + ' minutes without running dry'); return true; }
        return false;
    }
    function step(c, profile, why) {
        log('quality: ' + c.profile + ' -> ' + profile + ' (' + why + ')');
        c.profile = profile; c.switchedAt = now(); c.cleanSince = now(); c.stalls = []; c.stallSince = 0;
        close(c);
        open(c, why);
    }
    function setPrefs(p) {
        const profile = p && p.profile ? String(p.profile) : prefs.profile;
        const adaptive = p && p.adaptive !== undefined ? !!p.adaptive : prefs.adaptive;
        const subs = p && p.subs !== undefined ? !!p.subs : prefs.subs;
        const gain = p && p.gain !== undefined && isFinite(Number(p.gain)) ? Math.max(0, Math.min(15, Number(p.gain))) : prefs.gain;
        const even = p && p.even !== undefined ? !!p.even : prefs.even;
        if (gain !== prefs.gain || even !== prefs.even) {
            prefs.gain = gain; prefs.even = even;
            log('sound: +' + gain + ' dB' + (even ? ', even' : ''));
            if (cur && cur.id) { sink.ctl(cur.id, 'gain ' + gain); sink.ctl(cur.id, even ? 'even on' : 'even off'); }
        }
        if (subs !== prefs.subs) {
            prefs.subs = subs;
            log('subtitles ' + (subs ? 'on' : 'off'));
            if (cur && cur.id) sink.ctl(cur.id, subs ? 'subs on' : 'subs off');
        }
        if (profile === prefs.profile && adaptive === prefs.adaptive) return;
        prefs.profile = profile; prefs.adaptive = adaptive;
        log('quality: ' + profile + (adaptive ? ', lower when the internet is slow' : ', fixed'));
        // what plays goes on with the new setting (fixed: the setting itself; adaptive: never above it)
        const c = cur;
        if (!c) return;
        const l = ladder();
        const want = adaptive && l.indexOf(c.profile) >= 0 ? c.profile : l[0];
        if (want !== c.profile) step(c, want, 'the setting');
    }

    /* ---------- what plays ---------- */
    function play(ch) {
        if (!ch || !ch.uuid) return;
        if (cur) { cur.closing = true; if (cur.retry) clearTimeout(cur.retry); close(cur); }
        st.retrySince = null; st.retryAt = null;
        const l = ladder();
        const c = { ch: { uuid: ch.uuid, name: ascii(ch.name), number: ch.number != null ? ch.number : null }, profile: l[0], tries: 0, reconnects: 0,
            stalls: [], stallSince: 0, cleanSince: now(), switchedAt: 0, lastState: null, startedAt: now(), id: 0 };
        cur = c;
        open(c, null);
    }
    function stop() {
        const c = cur;
        cur = null;
        if (c) { c.closing = true; if (c.retry) clearTimeout(c.retry); close(c); log('stopped ' + c.ch.name); }
        st.retrySince = null; st.retryAt = null;
        set('idle');
    }

    function onPlayer(id, ev) {
        const c = cur;
        if (!c || c.id !== id || !ev) return;
        if (ev.ev === 'open') {
            c.player.video = ev.video || null; c.player.audioCodec = ev.audio ? ev.audio.codec : null;
            if (ev.video && ev.video.interlaced) { c.player.interlaced = true; log('stream ' + id + ': interlaced: profile ' + c.profile + ' does not deinterlace'); }
        } else if (ev.ev === 'audio' && ev.ok === false) c.player.audioError = ev.error;
        else if (ev.ev === 'subs') c.player.subs = ev.ok ? { lang: ev.lang || '' } : { error: ev.error };
        else if (ev.ev === 'error') c.player.error = ev.error;
        else if (ev.ev === 'tick') {
            const s = ev.state === 'starting' ? 'loading' : ev.state;
            c.player.state = ev.state; c.player.fields = ev.fields || 0; c.player.buffered = ev.buffered;
            if (ev.fields > 0) c.player.interlaced = true;
            if (s === 'playing' || s === 'buffering') {
                if (st.state !== s) set(s);
                if (s === 'playing') { c.played = true; c.good = c.profile; if (c.fails) c.fails[c.profile] = 0; if (c.outageSince) { log('stream ' + id + ': playing again after ' + Math.round((now() - c.outageSince) / 1000) + ' s'); } recovered(c); }
                adapt(c, s);
            }
        } else if (ev.ev === 'end' || ev.ev === 'exit') {
            // the player went while its stream is still on: a picture or sound it cannot play, or a crash
            if (c.closing) return;
            const why = c.player.error || (ev.ev === 'exit' ? 'the player ended (' + (ev.signal || 'code ' + ev.code) + ')' : 'the player ended');
            if (c.player.error) return fail(c, why);
            if (ev.ev === 'exit') broke(c, id, why, 'player');
        }
    }

    function status() {
        const c = cur;
        return Object.assign({}, st, {
            channel: c ? c.ch : null, profile: c ? c.profile : null, setting: prefs.profile, adaptive: prefs.adaptive, ladder: ladder(),
            lowered: !!(c && c.profile !== ladder()[0]), badProfiles: c && c.bad ? Object.keys(c.bad) : [], reconnects: c ? c.reconnects : 0, since: c ? c.startedAt : null,
            kbytes: c && c.bytes ? Math.round(c.bytes / 1024) : 0,
            video: c && c.player.video ? c.player.video : null, interlaced: !!(c && c.player.interlaced), fields: c ? c.player.fields : 0,
            audioError: c ? c.player.audioError || null : null, buffered: c ? c.player.buffered : null,
            subs: c && c.player.subs ? Object.assign({ on: prefs.subs }, c.player.subs) : null,
            gain: prefs.gain, even: prefs.even,
        });
    }

    return { play, stop, setPrefs, onPlayer, status };
}

module.exports = { createPlayback, LADDER, ladderFor, ascii };
