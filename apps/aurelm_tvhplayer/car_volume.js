'use strict';
/**
 * car_volume.js - the car's volume and mute, for a volume popup in the app.
 *
 * On the CarLife source (287) the HMI shows no volume popup of its own, so the app draws one. The audio manager
 * (org.genivi.am.commandinterface.CommandControl) tells every change: the broadcast `volumeChanged` (sinkID, volume)
 * and `sinkMuteStateChanged` (sinkID, muteState); `getListMainSinks` gives where it starts. Only the car's main volume
 * counts: sink 1 (seen in the car: the knob changes sink 1; 1024, where 287 is routed, stays at 0).
 * The names of the fields are read loosely (anything with "sink", "vol", "mute"),
 * and the last event is kept as it came, for the Status page: the car decides what they look like.
 *
 *   const vol = createCarVolume(signals, log, { onChange: render });
 *   vol.popup()   // null, or { volume, muted, max } while it should show: 2 s after a change, all the time while muted
 *   vol.state()   // for the Status page
 */
const AM = 'org.genivi.am.commandinterface.CommandControl';
const SHOW_MS = 2000;
const MAX = 62;

const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
    if (v && typeof v === 'object' && v.value != null) return num(v.value);
    return null;
};
const field = (o, re) => {
    if (!o || typeof o !== 'object') return undefined;
    for (const k of Object.keys(o)) if (re.test(k)) return o[k];
    return undefined;
};
/** { sink, volume } from a volumeChanged payload (or a main sink of the list) */
function parseVolume(v) {
    if (typeof v === 'number') return { sink: null, volume: v };
    return { sink: num(field(v, /sink/i)), volume: num(field(v, /vol/i)) };
}
/** true / false / null (unknown) from a muteState: MS_MUTED (1) or MS_UNMUTED (2), or a boolean */
function parseMute(v) {
    let x = v && typeof v === 'object' && !Array.isArray(v) ? field(v, /mute/i) : v;
    if (x && typeof x === 'object' && x.value != null) x = x.value;
    if (typeof x === 'boolean') return x;
    if (x == null) return null;
    const s = String(x).toUpperCase();
    if (/UNMUTE/.test(s) || s === '2') return false;
    if (/MUTE/.test(s) || s === '1') return true;
    return null;
}
/** the sinks of a getListMainSinks answer (the first array in it) */
function sinksOf(r) {
    if (Array.isArray(r)) return r;
    if (r && typeof r === 'object') for (const k of Object.keys(r)) if (Array.isArray(r[k])) return r[k];
    return [];
}
const short = (v) => { let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } return s && s.length > 160 ? s.slice(0, 157) + '...' : s; };

function createCarVolume(signals, log, o) {
    o = o || {};
    const SINK = o.sink || 1;
    const now = o.now || Date.now;
    const st = { volume: null, muted: null, changes: 0, maxSeen: null, at: 0, last: null, other: null, error: null, ready: false };
    const changed = () => { try { if (o.onChange) o.onChange(); } catch (e) { /* drawing */ } };

    function onVolume(v) {
        const r = parseVolume(v);
        if (r.sink != null && r.sink !== SINK) { st.other = 'sink ' + r.sink + ': ' + short(v); return; }
        st.last = 'volume ' + short(v);
        if (r.volume == null) return;
        const before = st.volume;
        st.volume = r.volume;
        st.maxSeen = st.maxSeen == null ? r.volume : Math.max(st.maxSeen, r.volume);
        if (before !== r.volume) { st.changes++; st.at = now(); changed(); }
    }
    function onMute(v) {
        const sink = num(field(v, /sink/i));
        if (sink != null && sink !== SINK) { st.other = 'sink ' + sink + ': ' + short(v); return; }
        st.last = 'mute ' + short(v);
        const m = parseMute(v);
        if (m == null || m === st.muted) return;
        st.muted = m;
        st.changes++;
        if (!m) st.at = now();   // unmuted: the volume shows for 2 s, then goes
        changed();
    }
    /** where it starts (no popup for it, unless muted) */
    function fromSinks(r) {
        const s = sinksOf(r).filter((x) => num(field(x, /sink.?id/i)) === SINK)[0];
        if (!s) return false;
        const v = parseVolume(s).volume, m = parseMute(field(s, /mute/i));
        if (v != null) { st.volume = v; st.maxSeen = st.maxSeen == null ? v : Math.max(st.maxSeen, v); }
        if (m != null) st.muted = m;
        changed();
        return true;
    }

    async function start() {
        if (!signals || !signals.proxy || !signals.on) { st.error = 'no SOME/IP here'; return; }
        try {
            const p = await signals.proxy(AM, '1');
            await new Promise((res) => { const t = setTimeout(res, 5000); if (signals.onAvailable) signals.onAvailable(p, (a) => { if (a) { clearTimeout(t); res(); } }); else res(); });
            await signals.on(p, 'volumeChanged', onVolume, log);
            await signals.on(p, 'sinkMuteStateChanged', onMute, log);
            st.ready = true;
            try {
                const r = await signals.call(p, 'getListMainSinks', {});
                if (!fromSinks(r)) st.last = 'sinks ' + short(r);
                log.info('car volume: ' + (st.volume != null ? st.volume + (st.muted ? ' (muted)' : '') : 'not in the list of sinks: ' + short(r)));
            } catch (e) { log.warn('car volume: getListMainSinks: ' + e); }
        } catch (e) {
            st.error = String(e && e.message || e);
            log.warn('car volume: ' + st.error);
        }
    }
    start();

    /** the bar's end: the car's main volume goes from 0 to 62 (seen in the car); more if more is ever seen */
    function max() {
        return Math.max(MAX, st.maxSeen || 0);
    }
    return {
        popup() {
            if (st.muted) return { volume: st.volume, muted: true, max: max() };
            if (st.volume != null && st.at && now() - st.at < SHOW_MS) return { volume: st.volume, muted: false, max: max() };
            return null;
        },
        state() { return Object.assign({ sink: SINK, max: max() }, st); },
        // tests
        _onVolume: onVolume, _onMute: onMute, _fromSinks: fromSinks,
    };
}

module.exports = { createCarVolume, parseVolume, parseMute, AM };
