'use strict';
/**
 * controls.js - the film's controls over the picture: a bar at the bottom with the title, the position, a progress
 * bar and the buttons  -10 s, play / pause, stop, +30 s, aspect (fit, zoom, fill), exit.
 *
 * Shown by a touch on the picture or the iDrive controller (turn, press or push), hidden 5 s after the last one
 * (not while paused), by a touch outside the bar or a push down. On the bar: a touch on a button or on the progress
 * bar (dragged: the target follows the finger, the seek goes when it lifts); the knob moves the focus along the buttons and a press runs the focused one, a push left or
 * right moves it too. The controller's codes are the kit's (kit/runtime/display.js): the knob a 16-bit counter, the
 * press 1 or 2, a push 1/2 north, 4/5 east, 7/8 south, 10/11 west; 15 and 15: no controller behind it.
 *
 *   const ctl = createControls({ now, act, buttons });   // buttons: a subset of the six, in their order; act('back10' | 'playpause' | 'stop' | 'fwd30' | 'aspect' | 'exit' | { seek })
 *   ctl.touch(phase, x, y, placement, info)     // true: taken
 *   ctl.ccu({ knob, press, tilt })               // true: taken (the picture stays)
 *   ctl.visible()  ctl.show()  ctl.hide()
 *   ctl.key(info)                                // changes when the bar must be drawn again
 *   ctl.draw(rec, placement, info)               // info: { title, pos, dur, paused, aspect, seeking }
 *   ctl.height(placement)                        // the bar's height (the subtitles go above it)
 */
const ALL_BUTTONS = ['back10', 'playpause', 'stop', 'fwd30', 'aspect', 'exit'];
const SHOW_MS = 5000;
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const ASPECT_NAME = { fit: 'FIT', zoom: 'ZOOM', fill: 'FILL' };

const hms = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

function createControls(o) {
    const now = o.now || Date.now;
    const act = o.act || (() => {});
    // AirPlay: no stop (the iPhone's own Stop ends a video; ending it from here left YouTube in error)
    const BUTTONS = (o.buttons || ALL_BUTTONS).filter((b) => ALL_BUTTONS.indexOf(b) >= 0);
    let until = 0, focus = 1, last = null, keepOpen = false;

    const visible = () => keepOpen || now() < until;
    function show() { until = now() + SHOW_MS; }
    function hide() { until = 0; keepOpen = false; }

    /** the bar's places on the screen */
    function layout(pl) {
        const H = height(pl), y0 = pl.h - H, pad = Math.round(pl.w * 0.03);
        const bw = Math.round(pl.w * 0.075), bh = Math.round(H * 0.36), gap = Math.round(bw * 0.25);
        const total = BUTTONS.length * bw + (BUTTONS.length - 1) * gap, bx = Math.round((pl.w - total) / 2), by = pl.h - bh - Math.round(H * 0.1);
        return {
            y0, pad, H,
            title: { x: pad, y: y0 + Math.round(H * 0.24) },
            bar: { x: pad, y: y0 + Math.round(H * 0.38), w: pl.w - 2 * pad, h: Math.max(6, Math.round(H * 0.05)) },
            buttons: BUTTONS.map((id, i) => ({ id, x: bx + i * (bw + gap), y: by, w: bw, h: bh })),
        };
    }
    function height(pl) { return Math.round(pl.h * 0.3); }

    // a finger on the progress bar: the target follows it (shown, not sent), the seek goes when it lifts (0.3.5 in
    // the car: only where it came down counted, so a drag of the knob moved a few seconds)
    let scrub = null;   // { t } while a finger drags the progress bar
    const fraction = (x, L) => Math.max(0, Math.min(1, (x - L.bar.x) / L.bar.w));
    function touch(phase, x, y, pl, info) {
        const L = layout(pl);
        if (scrub) {
            if (info && info.dur) scrub.t = fraction(x, L) * info.dur;
            show();
            if (phase === 'up') { const t = scrub.t; scrub = null; act({ seek: t }); }
            return true;
        }
        if (phase !== 'down') return true;   // the picture keeps its touches; a tap acts on its way down
        if (!visible()) { show(); return true; }
        // the progress bar (a generous band around it): the finger drags the target
        if (info && info.dur && y >= L.bar.y - 36 && y <= L.bar.y + L.bar.h + 36 && x >= L.bar.x - 20 && x <= L.bar.x + L.bar.w + 20) {
            scrub = { t: fraction(x, L) * info.dur };
            show();
            return true;
        }
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
        if (tilt === 'S') { hide(); return true; }
        if (tilt === 'E' || tilt === 'W') d = tilt === 'E' ? 1 : -1;
        if (d) focus = Math.max(0, Math.min(BUTTONS.length - 1, focus + d));
        if (press && (BUTTONS[focus] === 'exit' || BUTTONS[focus] === 'stop')) { run(BUTTONS[focus]); return true; }
        if (press) run(BUTTONS[focus]);
        show();
        return true;
    }

    function run(id) {
        if (id === 'exit' || id === 'stop') hide();
        act(id);
    }

    /** the bar's info with a drag's target in place of the position */
    function view(info) {
        return scrub ? Object.assign({}, info, { seeking: scrub.t }) : info;
    }
    function key(info0) {
        if (!visible()) return null;
        const i = view(info0 || {});
        return [focus, Math.floor(i.seeking != null ? i.seeking : i.pos || 0), i.dur, !!i.paused, i.aspect, i.title, i.seeking != null].join('|');
    }

    function draw(rec, pl, info) {
        const i = view(info || {});
        const L = layout(pl);
        rec.gradientRect(0, L.y0 - 40, pl.w, L.H + 40, [[0, 0x00000000], [0.3, 0x000000a8], [1, 0x000000e0]]);
        const fs = Math.round(L.H * 0.13);
        const pos = i.seeking != null ? i.seeking : i.pos || 0;
        rec.text(i.title || '', L.title.x, L.title.y, fs, 0xffffffff, { font: 'bold', literal: true });
        rec.text(hms(pos) + (i.dur ? ' / ' + hms(i.dur) : ''), pl.w - L.pad, L.title.y, fs, i.seeking != null ? 0xffd166ff : 0xffffffff, { align: 'right', font: 'bold', literal: true });
        // progress
        const b = L.bar, f = i.dur ? Math.max(0, Math.min(1, pos / i.dur)) : 0;
        rec.roundRect(b.x, b.y, b.w, b.h, b.h / 2, 0xffffff40);
        if (f > 0) rec.roundRect(b.x, b.y, Math.max(b.h, b.w * f), b.h, b.h / 2, 0x52b54bff);
        rec.circle(b.x + b.w * f, b.y + b.h / 2, b.h * 1.4, 0xffffffff);
        // buttons
        L.buttons.forEach((q, n) => {
            const cx = q.x + q.w / 2, cy = q.y + q.h / 2, s = q.h * 0.28, white = 0xffffffff;
            rec.roundRect(q.x, q.y, q.w, q.h, q.h / 2, n === focus ? 0xffffff38 : 0xffffff14);
            if (n === focus) rec.strokeRoundRect(q.x, q.y, q.w, q.h, q.h / 2, 3, 0x52b54bff);
            const label = (t) => rec.text(t, cx, cy + fs * 0.36, Math.round(fs * 0.95), white, { align: 'center', font: 'bold', literal: true });
            if (q.id === 'back10') label('-10s');
            else if (q.id === 'fwd30') label('+30s');
            else if (q.id === 'aspect') label(ASPECT_NAME[i.aspect] || 'FIT');
            else if (q.id === 'stop') rec.fillRect(cx - s, cy - s, 2 * s, 2 * s, white);
            else if (q.id === 'exit') { rec.line(cx - s, cy - s, cx + s, cy + s, 5, white); rec.line(cx - s, cy + s, cx + s, cy - s, 5, white); }
            else if (q.id === 'playpause') {
                if (i.paused) rec.quad([[cx - s * 0.8, cy - s * 1.1], [cx + s * 1.2, cy], [cx - s * 0.8, cy + s * 1.1], [cx - s * 0.8, cy + s * 1.1]], white);
                else { rec.fillRect(cx - s, cy - s * 1.1, s * 0.7, s * 2.2, white); rec.fillRect(cx + s * 0.3, cy - s * 1.1, s * 0.7, s * 2.2, white); }
            }
        });
    }

    return { touch, ccu, visible, show, hide, key, draw, height, layout,
        keepOpen: (on) => { keepOpen = !!on; }, focus: () => BUTTONS[focus] };
}

/** where the picture goes for an aspect: fit (whole, bars), fill (the screen full, the edges cut), zoom (between) */
function videoRect(mode, fw, fh, pl) {
    if (!fw || !fh) return { x: 0, y: 0, w: pl.w, h: pl.h };
    const fit = Math.min(pl.w / fw, pl.h / fh), fill = Math.max(pl.w / fw, pl.h / fh);
    const k = mode === 'fill' ? fill : mode === 'zoom' ? Math.sqrt(fit * fill) : fit;
    const w = Math.round(fw * k), h = Math.round(fh * k);
    return { x: Math.round((pl.w - w) / 2), y: Math.round((pl.h - h) / 2), w, h };
}

module.exports = { createControls, videoRect, BUTTONS: ALL_BUTTONS, hms };
