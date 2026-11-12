'use strict';
/**
 * controls.js - the channel's controls over the picture: a bar at the bottom with the channel, what is on now and
 * how far it is (from the EPG), and the buttons  CH-, CH+, LIST, EPG, stop, aspect (fit, zoom, fill), exit. LIST opens
 * the channels above the bar (the one playing marked, each with what is on now): a tap on one, or the knob (or a push
 * up / down) and a press, plays it; a finger dragged along it scrolls it (the guide's programme too); a push left /
 * right, a touch outside or 10 s idle closes it.
 *
 * EPG opens the guide over the picture: a channel's programme for the next 24 hours, on the left (now marked, with how
 * far it is), and the chosen one's details on the right (its time, subtitle, description). The knob (or a push up /
 * down) moves along the programme; a push left / right, or a touch on < >, shows the channel before / after (the one
 * playing stays); a press, or a second touch on a programme, plays the guide's channel when it is another one, and
 * closes the guide when it is the one playing. A touch outside, EPG again, or 30 s idle closes it.
 *
 * Emby's controls (apps/aurelm_emby/controls.js, 0.3.9) for live TV: no seek, no pause (a live stream does not
 * wait), the track list became the channel list.
 *
 * Shown by a touch on the picture or the iDrive controller (turn, press or push), hidden 5 s after the last one,
 * by a touch outside the bar or a push down. The controller's codes are the kit's (kit/runtime/display.js): the knob
 * a 16-bit counter, the press 1 or 2, a push 1/2 north, 4/5 east, 7/8 south, 10/11 west; 15 and 15: no controller.
 *
 *   const ctl = createControls({ now, act, guide });   // guide(uuid) -> { state: 'loading'|'ok'|'error', events, error }:
 *                                                // the programme, the app's to fetch (asked for each time it is drawn)
 *                                                // act('chdown' | 'chup' | 'stop' | 'aspect' | 'exit' | { channel: uuid })
 *   ctl.touch(phase, x, y, placement, info)     // true: taken
 *   ctl.ccu({ knob, press, tilt })               // true: taken (the picture stays)
 *   ctl.visible()  ctl.show()  ctl.hide()  ctl.openList()  ctl.openGuide(uuid)  ctl.guide() -> { uuid, focus } | null
 *   ctl.key(info)                                // changes when the bar must be drawn again
 *   ctl.draw(rec, placement, info)               // info: { title, now: { title, start, stop }, aspect, profile, note,
 *                                                //         channels: [{ uuid, t, n (the name alone) }], current: uuid,
 *                                                //         drawLogo(rec, uuid, x, y, label) -> bool (60x36: the logo, or a plate
 *                                                //         with label; false: nothing), logoVer }
 *   ctl.height(placement)
 */
const BUTTONS = ['chdown', 'chup', 'list', 'epg', 'stop', 'aspect', 'exit'];
const SHOW_MS = 5000, MENU_MS = 10000, GUIDE_MS = 30000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const ASPECT_NAME = { fit: 'FIT', zoom: 'ZOOM', fill: 'FILL' };
const ACCENT = 0x2f8fd8ff;
const LOGO = { w: 60, h: 36 };   // logos.js BOX (5:3, the server's logos)

/**
 * The guide's times in the car's time zone. The head unit's Linux keeps UTC (0.1.6 in the car: the guide 2 h behind
 * the car's clock, which the HMI keeps itself), so the zone is a setting: its hours from UTC in winter, and the EU's
 * summer time (the last Sunday of March to the last Sunday of October, at 01:00 UTC) where it has one.
 */
const ZONES = {
    eet: { base: 2, eu: true },     // Romania, Bulgaria, Greece, Finland, the Baltics
    cet: { base: 1, eu: true },     // most of the EU
    wet: { base: 0, eu: true },     // Portugal, UK, Ireland
    utc: { base: 0, eu: false },
};
let zoneOf = () => 'eet';
/** where the zone's key comes from (the app's setting); 'system': the head unit's own */
const setZone = (f) => { zoneOf = f; };
const lastSunday = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0, 1)); return d.getTime() - d.getUTCDay() * 86400000; };
/** seconds the zone is ahead of UTC at `ms` */
function zoneOffset(ms, key) {
    const z = ZONES[key];
    if (!z) return -new Date(ms).getTimezoneOffset() * 60;   // 'system'
    const y = new Date(ms).getUTCFullYear();
    const summer = z.eu && ms >= lastSunday(y, 2) && ms < lastSunday(y, 9);
    return (z.base + (summer ? 1 : 0)) * 3600;
}
/** a Date whose UTC fields are the zone's local time */
const local = (ms) => new Date(ms + zoneOffset(ms, zoneOf()) * 1000);
/** seconds since 1970 -> "21:05" (the car's time) */
const hm = (t) => { const d = local(t * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
/** "21:05", or "Tue 06:00" on another day than `ref` */
const when = (t, ref) => { const d = local(t * 1000), r = local(ref); return (d.toISOString().slice(0, 10) === r.toISOString().slice(0, 10) ? '' : DAYS[d.getUTCDay()] + ' ') + hm(t); };

function createControls(o) {
    const now = o.now || Date.now;
    const act = o.act || (() => {});
    let until = 0, focus = 1, last = null;
    let menu = null;       // { items: [{ i: uuid, t }], focus, first, cur, until } while the channel list is open
    let guide = null;      // { uuid, focus, first, until, follow } while the guide is open
    let lastInfo = {};

    function menuOpen() { if (menu && now() > menu.until) menu = null; return !!menu; }
    function guideOpen() { if (guide && now() > guide.until) guide = null; return !!guide; }
    const visible = () => menuOpen() || guideOpen() || now() < until;
    function show() { until = now() + SHOW_MS; if (menu) menu.until = now() + MENU_MS; if (guide) guide.until = now() + GUIDE_MS; }
    function hide() { until = 0; menu = null; guide = null; }

    /* ---------- the guide ---------- */
    const programme = (uuid) => (o.guide ? o.guide(uuid) : null) || { state: 'loading', events: [] };
    function openGuide(uuid) {
        menu = null;
        guide = { uuid: uuid || lastInfo.current, focus: 0, first: 0, until: now() + GUIDE_MS, follow: true };
        show();
    }
    /** the channel before / after the guide's one, in the list's order (round) */
    function guideChannel(d) {
        const list = lastInfo.channels || [];
        if (!list.length) return;
        const i = list.findIndex((c) => c.uuid === guide.uuid);
        guide = { uuid: list[((i < 0 ? 0 : i) + d + list.length) % list.length].uuid, focus: 0, first: 0, until: now() + GUIDE_MS, follow: true };
    }
    /** the programme's event at focus: the first one still on (it was loading when the guide opened) */
    function guideEvents() {
        const p = programme(guide.uuid);
        const ev = p.events || [];
        if (guide.follow && ev.length) { guide.follow = false; guide.focus = 0; }
        if (guide.focus > ev.length - 1) guide.focus = Math.max(0, ev.length - 1);
        return { p, ev };
    }
    function guidePlay() {
        const g = guide;
        if (g.uuid !== lastInfo.current) { guide = null; show(); act({ channel: g.uuid }); return; }
        guide = null;
        show();
    }
    function guideLayout(pl) {
        const L = layout(pl), x = L.pad, y = Math.round(L.pad / 2), w = pl.w - 2 * L.pad, h = L.y0 - 10 - y;
        const hh = Math.max(48, Math.round(h * 0.13)), pad = Math.round(hh * 0.3), ih = Math.max(36, Math.round(h * 0.095));
        const lw = Math.round(w * 0.46);
        const rows = Math.max(1, Math.floor((h - hh - 2 * pad) / ih));
        return { x, y, w, h, hh, pad, ih, lw, rows,
            prev: { x, y, w: Math.round(w * 0.12), h: hh + pad }, next: { x: x + w - Math.round(w * 0.12), y, w: Math.round(w * 0.12), h: hh + pad },
            row: (k) => ({ x: x + pad, y: y + hh + pad + k * ih, w: lw - pad, h: ih }),
            detail: { x: x + lw + 2 * pad, y: y + hh + pad, w: w - lw - 3 * pad, h: h - hh - 2 * pad } };
    }

    function openList() {
        const items = (lastInfo.channels || []).map((c) => ({ i: c.uuid, t: c.t, n: c.n }));
        if (!items.length) items.push({ i: null, t: 'No channels yet' });
        const at = Math.max(0, items.findIndex((x) => x.i === lastInfo.current));
        menu = { items, focus: at, first: Math.max(0, at - 2), cur: lastInfo.current, until: now() + MENU_MS };
        show();
    }
    function choose(n) {
        const it = menu && menu.items[n];
        menu = null;
        show();
        if (it && it.i != null && it.i !== lastInfo.current) act({ channel: it.i });
    }
    function menuLayout(pl) {
        const L = layout(pl), ih = Math.max(36, Math.round(L.H * 0.21)), pad = Math.round(ih * 0.25);
        const room = Math.max(1, Math.floor((L.y0 - 2 * pad - ih - 20) / ih));
        const rows = Math.min(menu.items.length, room);
        if (menu.focus < menu.first) menu.first = menu.focus;
        if (menu.focus >= menu.first + rows) menu.first = menu.focus - rows + 1;
        if (menu.first > Math.max(0, menu.items.length - rows)) menu.first = Math.max(0, menu.items.length - rows);
        const w = Math.min(Math.round(pl.w * 0.6), 1100), h = (rows + 1) * ih + 2 * pad;
        const b = L.buttons.find((q) => q.id === 'list');
        const x = Math.max(L.pad, Math.min(pl.w - L.pad - w, Math.round(b.x + b.w / 2 - w / 2)));
        const y = L.y0 - 10 - h;
        return { x, y, w, h, ih, pad, rows, row: (k) => ({ x: x + pad, y: y + pad + (k + 1) * ih, w: w - 2 * pad, h: ih }) };
    }

    function layout(pl) {
        const H = height(pl), y0 = pl.h - H, pad = Math.round(pl.w * 0.03);
        const bw = Math.round(pl.w * 0.085), bh = Math.round(H * 0.36), gap = Math.round(bw * 0.25);
        const total = BUTTONS.length * bw + (BUTTONS.length - 1) * gap, bx = Math.round((pl.w - total) / 2), by = pl.h - bh - Math.round(H * 0.1);
        return {
            y0, pad, H,
            title: { x: pad, y: y0 + Math.round(H * 0.24) },
            bar: { x: pad, y: y0 + Math.round(H * 0.38), w: pl.w - 2 * pad, h: Math.max(6, Math.round(H * 0.035)) },
            buttons: BUTTONS.map((id, i) => ({ id, x: bx + i * (bw + gap), y: by, w: bw, h: bh })),
        };
    }
    function height(pl) { return Math.round(pl.h * 0.3); }

    // a finger on the channel list or the guide: a tap (it lifts where it came down) chooses, a drag scrolls the list
    let drag = null;   // { kind: 'menu' | 'guide', y0, lastY, acc, ih, moved, tap }
    function scrollList(kind, n) {
        if (kind === 'menu' && menu) {
            menu.first = Math.max(0, Math.min(menu.items.length - 1, menu.first + n));
            menu.focus = Math.max(0, Math.min(menu.items.length - 1, menu.focus + n));
        } else if (kind === 'guide' && guide) {
            guide.first = Math.max(0, guide.first + n);
            guide.focus = Math.max(0, guide.focus + n);
            guideEvents();   // the focus kept on the programme
        }
    }
    function touch(phase, x, y, pl) {
        if (drag && (phase === 'move' || phase === 'up')) {
            // the list follows the finger from where it came down (once it moved more than a tap does)
            if (!drag.moved && Math.abs(y - drag.y0) > 14) { drag.moved = true; drag.acc = drag.y0 - y; }
            else if (drag.moved) drag.acc += drag.lastY - y;
            if (drag.moved) {
                const n = drag.acc > 0 ? Math.floor(drag.acc / drag.ih) : Math.ceil(drag.acc / drag.ih);
                if (n) { drag.acc -= n * drag.ih; scrollList(drag.kind, n); }
            }
            drag.lastY = y;
            if (phase === 'up') { const d = drag; drag = null; if (!d.moved && d.tap) d.tap(); }
            show();
            return true;
        }
        if (phase !== 'down') return true;   // the picture keeps its touches; a tap acts on its way down (a list's, on its way up)
        if (!visible()) { show(); return true; }
        if (guideOpen()) {
            const G = guideLayout(pl);
            const inside = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
            if (inside({ x: G.x, y: G.y, w: G.w, h: G.h })) {
                show();
                if (inside(G.prev)) { guideChannel(-1); return true; }
                if (inside(G.next)) { guideChannel(1); return true; }
                const { ev } = guideEvents();
                for (let k = 0; k < G.rows; k++) {
                    const r = G.row(k), n = guide.first + k;
                    if (n < ev.length && inside(r)) {
                        drag = { kind: 'guide', y0: y, lastY: y, acc: 0, ih: G.ih, moved: false,
                            tap: () => { if (!guide) return; if (n === guide.focus) guidePlay(); else guide.focus = n; } };   // a second tap on the chosen one: watch
                        return true;
                    }
                }
                drag = { kind: 'guide', y0: y, lastY: y, acc: 0, ih: G.ih, moved: false, tap: null };
                return true;
            }
            guide = null;
            if (y < layout(pl).y0) { show(); return true; }
        }
        if (menuOpen()) {
            const M = menuLayout(pl);
            if (x >= M.x && x <= M.x + M.w && y >= M.y && y <= M.y + M.h) {
                for (let k = 0; k < M.rows; k++) {
                    const r = M.row(k), n = menu.first + k;
                    if (y >= r.y && y < r.y + r.h) { drag = { kind: 'menu', y0: y, lastY: y, acc: 0, ih: M.ih, moved: false, tap: () => { if (menu) choose(n); } }; return true; }
                }
                // the list's title row: a page up; below the last row: a page down (a tap); a drag scrolls
                const step = Math.max(1, M.rows - 1), up = y < M.y + M.pad + M.ih;
                drag = { kind: 'menu', y0: y, lastY: y, acc: 0, ih: M.ih, moved: false,
                    tap: () => { if (menu) menu.focus = Math.max(0, Math.min(menu.items.length - 1, menu.focus + (up ? -step : step))); } };
                show();
                return true;
            }
            menu = null;
            if (y < layout(pl).y0) { show(); return true; }
        }
        const L = layout(pl);
        if (y < L.y0) { hide(); return true; }
        const b = L.buttons.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y - 10 && y <= q.y + q.h + 10);
        if (b) { focus = BUTTONS.indexOf(b.id); if (b.id !== 'exit' && b.id !== 'stop') show(); run(b.id); return true; }
        return true;
    }

    function ccu(c) {
        const k = Number(c.knob), pb = Number(c.press), df = Number(c.tilt);
        const L = last;
        last = { k, pb, df };
        if (pb === 15 && df === 15) return true;   // no controller behind it
        let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
        if (Math.abs(d) > 64) d = 0;                // a counter reset
        const down = (x) => x === 1 || x === 2;
        const press = down(pb) && !(L && down(L.pb));
        const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
        if (!d && !press && !tilt) return true;
        if (!visible()) { focus = 1; show(); return true; }   // the first touch of the controller: the bar, nothing else
        if (guideOpen()) {
            if (tilt === 'E' || tilt === 'W') { guideChannel(tilt === 'E' ? 1 : -1); show(); return true; }
            if (tilt === 'N') d = -1;
            if (tilt === 'S') d = 1;
            const { ev } = guideEvents();
            if (d) guide.focus = Math.max(0, Math.min(Math.max(0, ev.length - 1), guide.focus + d));
            if (press) { guidePlay(); return true; }
            show();
            return true;
        }
        if (menuOpen()) {
            if (tilt === 'E' || tilt === 'W') { menu = null; show(); return true; }
            if (tilt === 'N') d = -1;
            if (tilt === 'S') d = 1;
            if (d) menu.focus = Math.max(0, Math.min(menu.items.length - 1, menu.focus + d));
            if (press) { choose(menu.focus); return true; }
            show();
            return true;
        }
        if (tilt === 'S') { hide(); return true; }
        if (tilt === 'N') { focus = BUTTONS.indexOf('list'); run('list'); return true; }
        if (tilt === 'E' || tilt === 'W') d = tilt === 'E' ? 1 : -1;
        if (d) focus = Math.max(0, Math.min(BUTTONS.length - 1, focus + d));
        if (press && (BUTTONS[focus] === 'exit' || BUTTONS[focus] === 'stop')) { run(BUTTONS[focus]); return true; }
        if (press) run(BUTTONS[focus]);
        show();
        return true;
    }

    function run(id) {
        if (id === 'list') { openList(); return; }
        if (id === 'epg') { if (guideOpen()) { guide = null; show(); } else openGuide(lastInfo.current); return; }
        if (id === 'exit' || id === 'stop') hide();
        act(id);
    }

    function key(info0) {
        if (info0) lastInfo = info0;
        if (!visible()) return null;
        const i = info0 || {};
        const m = menu ? [menu.focus, menu.first, menu.items.length].join(',') : '';
        let g = '';
        if (guideOpen()) { const p = programme(guide.uuid); g = [guide.uuid, guide.focus, guide.first, p.state, (p.events || []).length, p.error].join(','); }
        const n = i.now || {};
        return [focus, i.title, n.title, n.start, Math.floor(now() / 30000), i.aspect, i.profile, i.note, m, g, i.logoVer].join('|');
    }
    function fit(rec, t, w, size) {
        if (!rec.textWidth || rec.textWidth(t, size, { font: 'bold', literal: true }) <= w) return t;
        while (t.length > 1 && rec.textWidth(t + '...', size, { font: 'bold', literal: true }) > w) t = t.slice(0, -1);
        return t + '...';
    }
    function drawMenu(rec, pl) {
        const M = menuLayout(pl), fs = Math.round(M.ih * 0.48);
        rec.roundRect(M.x, M.y, M.w, M.h, M.pad, 0x101418f0);
        rec.strokeRoundRect(M.x, M.y, M.w, M.h, M.pad, 2, 0xffffff30);
        rec.text('CHANNELS', M.x + M.pad * 2, M.y + M.pad + M.ih * 0.68, Math.round(fs * 0.85), 0xffffff90, { font: 'bold', literal: true });
        if (menu.items.length > M.rows) {
            rec.text((menu.first + 1) + '-' + (menu.first + M.rows) + ' / ' + menu.items.length, M.x + M.w - M.pad * 2, M.y + M.pad + M.ih * 0.68,
                Math.round(fs * 0.8), 0xffffff70, { align: 'right', font: 'bold', literal: true });
        }
        for (let k = 0; k < M.rows; k++) {
            const n = menu.first + k, it = menu.items[n], r = M.row(k);
            if (n === menu.focus) {
                rec.roundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 0xffffff26);
                rec.strokeRoundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 3, ACCENT);
            }
            const on = it.i != null && it.i === menu.cur;
            if (on) rec.circle(r.x + r.h * 0.5, r.y + r.h / 2, r.h * 0.13, ACCENT);
            // the channel's logo before its name (a column: the names line up, logo or not)
            const lx = r.x + r.h, logos = !!lastInfo.drawLogo;
            if (logos && it.i != null) lastInfo.drawLogo(rec, it.i, lx, Math.round(r.y + (r.h - LOGO.h) / 2), it.n);
            const tx = logos ? lx + LOGO.w + 14 : lx;
            rec.text(fit(rec, it.t, r.x + r.w - tx - r.h * 0.3, fs), tx, r.y + r.h / 2 + fs * 0.36, fs, on ? 0xffffffff : 0xffffffc8, { font: 'bold', literal: true });
        }
    }

    /** words of `text` in lines of at most `w` px, at most `max` lines (the last one cut with "...") */
    function wrap(rec, text, size, w, max, font) {
        const out = [];
        let cur = '';
        const width = (t) => (rec.textWidth ? rec.textWidth(t, size, { font, literal: true }) : t.length * size * 0.5);
        String(text || '').split(/\s+/).filter(Boolean).forEach((word) => {
            const next = cur ? cur + ' ' + word : word;
            if (cur && width(next) > w) { out.push(cur); cur = word; } else cur = next;
        });
        if (cur) out.push(cur);
        if (out.length > max) {
            out.length = max;
            let l = out[max - 1];
            while (l.length > 1 && width(l + '...') > w) l = l.slice(0, -1);
            out[max - 1] = l + '...';
        }
        return out;
    }
    function drawGuide(rec, pl) {
        const G = guideLayout(pl), t = now() / 1000;
        const { p, ev } = guideEvents();
        if (guide.focus < guide.first) guide.first = guide.focus;
        if (guide.focus >= guide.first + G.rows) guide.first = guide.focus - G.rows + 1;
        rec.roundRect(G.x, G.y, G.w, G.h, G.pad, 0x101418f2);
        rec.strokeRoundRect(G.x, G.y, G.w, G.h, G.pad, 2, 0xffffff30);
        // the header: < the channel (logo, name) >
        const ch = (lastInfo.channels || []).filter((c) => c.uuid === guide.uuid)[0];
        const name = ch ? ch.n || ch.t : '';
        const hs = Math.round(G.hh * 0.5), cy = G.y + G.pad + G.hh / 2;
        const playing = guide.uuid === lastInfo.current;
        rec.text('<', G.prev.x + G.prev.w / 2, cy + hs * 0.36, hs, 0xffffffb0, { align: 'center', font: 'bold', literal: true });
        rec.text('>', G.next.x + G.next.w / 2, cy + hs * 0.36, hs, 0xffffffb0, { align: 'center', font: 'bold', literal: true });
        const logo = !!(lastInfo.drawLogo && lastInfo.drawLogo(rec, guide.uuid, G.prev.x + G.prev.w, Math.round(cy - LOGO.h / 2), ch ? ch.n || ch.t : ''));
        const nx = G.prev.x + G.prev.w + (logo ? LOGO.w + 16 : 0);
        rec.text(fit(rec, name, G.next.x - nx - 300, hs), nx, cy + hs * 0.36, hs, 0xffffffff, { font: 'bold', literal: true });
        rec.text(playing ? 'EPG - PLAYING' : 'EPG - PRESS TO WATCH', G.next.x - 10, cy + hs * 0.36, Math.round(hs * 0.62), playing ? 0xffffff80 : ACCENT,
            { align: 'right', font: 'bold', literal: true });
        rec.fillRect(G.x + G.pad, G.y + G.hh + G.pad / 2, G.w - 2 * G.pad, 2, 0xffffff20);
        const fs = Math.round(G.ih * 0.46);
        if (!ev.length) {
            const why = p.state === 'loading' ? 'Loading the programme...' : p.state === 'error' ? 'No programme: ' + (p.error || '?') : 'No programme for this channel';
            rec.text(why, G.x + G.w / 2, G.y + G.h / 2, fs, 0xffffffa0, { align: 'center', font: 'bold', literal: true });
            return;
        }
        // the programme, on the left; the time column as wide as its widest (a day's name before another day's times)
        const tw = Math.round((rec.textWidth ? Math.max.apply(null, ev.slice(guide.first, guide.first + G.rows).map((e) => rec.textWidth(when(e.start, now()), fs, { font: 'bold', literal: true })))
            : fs * 3) + fs * 1.2);
        for (let k = 0; k < G.rows; k++) {
            const n = guide.first + k, e = ev[n], r = G.row(k);
            if (!e) break;
            const on = e.start <= t && t < e.stop;
            if (n === guide.focus) {
                rec.roundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 0xffffff26);
                rec.strokeRoundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 3, ACCENT);
            }
            rec.text(when(e.start, now()), r.x + r.h * 0.5, r.y + r.h / 2 + fs * 0.36, fs, on ? ACCENT : 0xffffffa0, { font: 'bold', literal: true });
            rec.text(fit(rec, e.title || '?', r.w - tw - r.h, fs), r.x + r.h * 0.5 + tw, r.y + r.h / 2 + fs * 0.36, fs, on ? 0xffffffff : 0xffffffd0, { font: 'bold', literal: true });
            if (on && e.stop > e.start) {
                const f = Math.max(0, Math.min(1, (t - e.start) / (e.stop - e.start))), bx = r.x + r.h * 0.5 + tw, bw = r.w - tw - r.h;
                rec.fillRect(bx, r.y + r.h - 7, bw, 3, 0xffffff26);
                rec.fillRect(bx, r.y + r.h - 7, Math.round(bw * f), 3, ACCENT);
            }
        }
        if (ev.length > G.rows) {
            rec.text((guide.first + 1) + '-' + Math.min(ev.length, guide.first + G.rows) + ' / ' + ev.length, G.x + G.lw, G.y + G.h - G.pad / 2,
                Math.round(fs * 0.7), 0xffffff60, { align: 'right', font: 'bold', literal: true });
        }
        // the one chosen, on the right
        const e = ev[guide.focus], D = G.detail;
        if (!e) return;
        rec.fillRect(D.x - G.pad, D.y, 2, D.h, 0xffffff20);
        const ts = Math.round(fs * 1.25);
        let y = D.y + ts;
        wrap(rec, e.title, ts, D.w, 2, 'bold').forEach((l) => { rec.text(l, D.x, y, ts, 0xffffffff, { font: 'bold', literal: true }); y += Math.round(ts * 1.2); });
        const mins = Math.round((e.stop - e.start) / 60);
        const left = e.start <= t && t < e.stop ? ', ' + Math.max(1, Math.round((e.stop - t) / 60)) + ' min left' : '';
        rec.text(when(e.start, now()) + ' - ' + hm(e.stop) + '  (' + mins + ' min' + left + ')', D.x, y + 4, fs, ACCENT, { font: 'bold', literal: true });
        y += Math.round(fs * 1.7);
        const sub = [e.subtitle, e.episode].filter(Boolean).join('  -  ');
        if (sub) { wrap(rec, sub, fs, D.w, 2, 'bold').forEach((l) => { rec.text(l, D.x, y, fs, 0xffffffc8, { font: 'bold', literal: true }); y += Math.round(fs * 1.3); }); y += 6; }
        const ds = Math.round(fs * 0.9), lines = Math.max(1, Math.floor((D.y + D.h - y) / Math.round(ds * 1.3)));
        wrap(rec, e.text || (sub ? '' : 'No description'), ds, D.w, lines, 'label').forEach((l) => { rec.text(l, D.x, y, ds, 0xffffffb0, { font: 'label', literal: true }); y += Math.round(ds * 1.3); });
    }

    function draw(rec, pl, info) {
        if (info) lastInfo = info;
        const i = info || {};
        const L = layout(pl);
        rec.gradientRect(0, L.y0 - 40, pl.w, L.H + 40, [[0, 0x00000000], [0.3, 0x000000a8], [1, 0x000000e0]]);
        const fs = Math.round(L.H * 0.12);
        const n = i.now || null;
        const right = (n && n.start && n.stop ? hm(n.start) + ' - ' + hm(n.stop) : '') + (i.profile ? '   ' + i.profile : '');
        const rw = right && rec.textWidth ? rec.textWidth(right, fs, { font: 'bold', literal: true }) : 0;
        const left = (i.title || '') + (n && n.title ? '  -  ' + n.title : '') + (i.note ? '  (' + i.note + ')' : '');
        // the channel's logo before its name
        const logo = !!(i.drawLogo && i.current && i.drawLogo(rec, i.current, L.title.x, Math.round(L.title.y - fs * 0.36 - LOGO.h / 2), i.title));
        const tx = L.title.x + (logo ? LOGO.w + 16 : 0);
        rec.text(fit(rec, left, pl.w - L.pad - tx - rw - 30, fs), tx, L.title.y, fs, 0xffffffff, { font: 'bold', literal: true });
        if (right) rec.text(right, pl.w - L.pad, L.title.y, fs, 0xffffffc0, { align: 'right', font: 'bold', literal: true });
        // the programme's progress (not a seek bar: live)
        const b = L.bar, t = now() / 1000;
        const f = n && n.start && n.stop && n.stop > n.start ? Math.max(0, Math.min(1, (t - n.start) / (n.stop - n.start))) : 0;
        rec.roundRect(b.x, b.y, b.w, b.h, b.h / 2, 0xffffff30);
        if (f > 0) rec.roundRect(b.x, b.y, Math.max(b.h, b.w * f), b.h, b.h / 2, ACCENT);
        L.buttons.forEach((q, k) => {
            const cx = q.x + q.w / 2, cy = q.y + q.h / 2, s = q.h * 0.28, white = 0xffffffff;
            rec.roundRect(q.x, q.y, q.w, q.h, q.h / 2, k === focus ? 0xffffff38 : 0xffffff14);
            if (k === focus) rec.strokeRoundRect(q.x, q.y, q.w, q.h, q.h / 2, 3, ACCENT);
            const label = (txt) => {
                let z = Math.round(fs * 1.0);
                while (rec.textWidth && z > 10 && rec.textWidth(txt, z, { font: 'bold', literal: true }) > q.w * 0.84) z--;
                rec.text(txt, cx, cy + z * 0.36, z, white, { align: 'center', font: 'bold', literal: true });
            };
            if (q.id === 'chdown') label('CH -');
            else if (q.id === 'chup') label('CH +');
            else if (q.id === 'list') label('LIST');
            else if (q.id === 'epg') label('EPG');
            else if (q.id === 'aspect') label(ASPECT_NAME[i.aspect] || 'FIT');
            else if (q.id === 'stop') rec.fillRect(cx - s, cy - s, 2 * s, 2 * s, white);
            else if (q.id === 'exit') { rec.line(cx - s, cy - s, cx + s, cy + s, 5, white); rec.line(cx - s, cy + s, cx + s, cy - s, 5, white); }
        });
        if (menuOpen()) drawMenu(rec, pl);
        if (guideOpen()) drawGuide(rec, pl);
    }

    return { touch, ccu, visible, show, hide, openList, openGuide, key, draw, height, layout,
        focus: () => BUTTONS[focus], menu: () => (menuOpen() ? menu : null), menuLayout,
        guide: () => (guideOpen() ? { uuid: guide.uuid, focus: guide.focus, first: guide.first } : null), guideLayout };
}

/** where the picture goes for an aspect: fit (whole, bars), fill (the screen full, the edges cut), zoom (between) */
function videoRect(mode, fw, fh, pl) {
    if (!fw || !fh) return { x: 0, y: 0, w: pl.w, h: pl.h };
    const fit = Math.min(pl.w / fw, pl.h / fh), fill = Math.max(pl.w / fw, pl.h / fh);
    const k = mode === 'fill' ? fill : mode === 'zoom' ? Math.sqrt(fit * fill) : fit;
    const w = Math.round(fw * k), h = Math.round(fh * k);
    return { x: Math.round((pl.w - w) / 2), y: Math.round((pl.h - h) / 2), w, h };
}

module.exports = { createControls, videoRect, BUTTONS, hm, when, setZone, zoneOffset, ZONES };
