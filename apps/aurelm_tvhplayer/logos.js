'use strict';
/**
 * logos.js - the channels' logos, small, for the page's list and the controls over the picture.
 *
 * The server's logos (tvlogo.sandu.casa, 2026-11-11): a public PNG per channel, RGBA, 400x240 (5:3), on a plate of
 * its own with rounded corners (transparent outside it), sized and padded alike; its address (with ?v=<hash>, changed
 * when the logo changes) is the channel's icon in Tvheadend. The service fetches it once and keeps it on the head unit
 * for as long as that address stays (its disk, so the list has its logos without the internet too); this module asks
 * for the ones it is about to draw ({"cmd":"logo","uuid"}), two at a time, decodes them with the kit's png.js
 * (bounded: a picture from outside), fits them into BOX (60x36: 5:3) and keeps them as runs of one colour along each
 * row: no background or padding is added, and what is transparent (the plate's corners) is left undrawn.
 *
 * Why runs and not a pixel image: mgu-render's own dialect (mgu-render/1, which the app needs for touch and the
 * controller) takes no pixel images (kit/runtime/renderd.js: "pixel images need the upstream dialect"). Rectangles
 * every renderer draws: a logo of flat colours is a few hundred of them, its colours rounded to 32 levels.
 *
 *   const logos = createLogos({ ask, png, log, onChange, iconOf });   // iconOf(uuid): the channel's icon address now
 *   logos.draw(rec, uuid, x, y, label) draws the logo in its BOX at x, y; none (yet), a plate with `label` (the
 *                                      channel's name) when given; false: nothing drawn
 *   logos.version()               changes each time a logo arrives (a frame's key)
 *   logos.state(uuid)             'ok' | 'loading' | 'none' (failed) | 'nologo' (the server gives none) | undefined
 *   logos.stats()                 { ok, loading, none, nologo, why }: how many, and the last reason one is missing (the Status tab)
 *
 * A logo is kept by the channel and its address: another address (a new ?v=) is fetched anew.
 */
const BOX = { w: 60, h: 36 };
const BACK = [0x1e, 0x23, 0x29];     // what a half-transparent edge pixel is laid over (the plate's dark colour)
const PARALLEL = 2;
const RETRY_MS = 10 * 60 * 1000;
const RETRY_LOST_MS = 60 * 1000;   // the service did not answer in time (the first fetch over LTE): again sooner

const hex = (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;

/** RGBA (straight alpha) of w x h -> runs [x, y, len, colour], colours rounded to 32 levels a channel; pixels mostly
 *  transparent (the plate's corners) are left out, the edge's half-transparent ones laid over BACK */
function toRuns(img) {
    const { w, h, data } = img;
    const runs = [];
    const q = (v) => Math.min(255, Math.round(v / 8) * 8);
    for (let y = 0; y < h; y++) {
        let start = 0, cur = null;
        for (let x = 0; x <= w; x++) {
            let c = null;
            if (x < w) {
                const i = (y * w + x) * 4, a = data[i + 3] / 255;
                if (a >= 0.35) c = hex(q(data[i] * a + BACK[0] * (1 - a)), q(data[i + 1] * a + BACK[1] * (1 - a)), q(data[i + 2] * a + BACK[2] * (1 - a)));
            }
            if (c !== cur) {
                if (cur !== null) runs.push([start, y, x - start, cur]);
                start = x; cur = c;
            }
        }
    }
    return runs;
}

/** runs -> rectangles [x, y, w, h, colour]: the same run (x, length, colour) on the rows below grows one rectangle down.
 *  0.1.3 in the car: a rectangle a row high each showed the page's background between the rows as thin lines (the page
 *  is scaled, 1.164, so rows fall between the screen's pixels and the renderer covers their edges in part). Fewer,
 *  taller rectangles, each drawn a pixel wider and taller than it is (the next one drawn over the overlap), leave no
 *  gap: a coverage model of the renderer at 1, 1.164 and 1.5 left none with 1 (0.5 left 169 of 1080 pixels part-covered). */
function toRects(runs) {
    const open = new Map();   // 'x,len,colour' -> the rectangle growing down, while the row above had the same run
    const rects = [];
    let row = -1, seen = new Set();
    const closeRow = () => { open.forEach((r, k) => { if (!seen.has(k)) open.delete(k); }); seen = new Set(); };
    for (let i = 0; i < runs.length; i++) {
        const [x, y, len, c] = runs[i];
        if (y !== row) { if (row >= 0) closeRow(); if (y !== row + 1) open.clear(); row = y; }
        const k = x + ',' + len + ',' + c;
        const r = open.get(k);
        if (r && r[1] + r[3] === y) r[3]++;
        else { const n = [x, y, len, 1, c]; rects.push(n); open.set(k, n); }
        seen.add(k);
    }
    return rects;
}
const OVERLAP = 1;

/** a decoded picture fitted into the box (never up) */
function fitBox(png, img) {
    const k = Math.min(BOX.w / img.w, BOX.h / img.h, 1);
    return k >= 1 ? img : png.fit(img, Math.max(1, Math.round(Math.max(img.w, img.h) * k)));
}

function createLogos(o) {
    const log = o.log || { info() {}, warn() {} };
    const png = o.png;
    const iconOf = o.iconOf || (() => '');
    const map = new Map();   // uuid + '|' + icon -> { state, runs, w, h, at }
    const queue = [];
    let running = 0, ver = 0;
    const keyOf = (uuid) => uuid + '|' + (iconOf(uuid) || '');

    function pump() {
        while (running < PARALLEL && queue.length) {
            const q = queue.shift();
            running++;
            load(q.uuid, q.key).then(() => { running--; pump(); }, () => { running--; pump(); });
        }
    }
    let lastWhy = null;   // the last reason a logo is missing
    function done(key, e) {
        if (e.state === 'none' && e.why) lastWhy = e.why;
        map.set(key, e);
        ver++;
        if (o.onChange) { try { o.onChange(key); } catch (x) { /* the app's */ } }
    }
    async function load(uuid, key) {
        const r = await o.ask('logo', { uuid });
        // a channel the server gives no public logo (none, or imagecache/<n>): its plate, not a failure
        if (r && r.quiet) return done(key, { state: 'nologo', at: Date.now() });
        if (!r || !r.png) {
            const why = r ? r.why || 'none' : 'no answer from the service in time';
            log.info('tvh logo ' + uuid.slice(0, 6) + ': ' + why);
            return done(key, { state: 'none', at: Date.now(), why, retry: r ? RETRY_MS : RETRY_LOST_MS });
        }
        const buf = Buffer.from(r.png, 'base64');
        await new Promise((res) => png.decodeAsync(buf, (err, img) => {
            if (err) { log.info('tvh logo ' + uuid.slice(0, 6) + ': ' + err.message); done(key, { state: 'none', at: Date.now(), why: err.message, retry: RETRY_MS }); return res(); }
            const f = fitBox(png, img);
            done(key, { state: 'ok', rects: toRects(toRuns(f)), w: f.w, h: f.h, at: Date.now() });
            res();
        }));
    }
    function want(uuid) {
        const key = keyOf(uuid);
        const e = map.get(key);
        if (e && (e.state !== 'none' || Date.now() - e.at < (e.retry || RETRY_MS))) return e;
        map.set(key, { state: 'loading', at: Date.now() });
        queue.push({ uuid, key });
        pump();
        return map.get(key);
    }
    /** a plate with the channel's name, where it has no logo (or not yet) */
    function placeholder(rec, x, y, label) {
        rec.roundRect(x, y, BOX.w, BOX.h, 6, 0x2a3038ff);
        let t = String(label).replace(/^\d+\s+/, '').trim();
        let size = 13;
        const fits = () => !rec.textWidth || rec.textWidth(t, size, { font: 'bold', literal: true }) <= BOX.w - 6;
        while (!fits() && size > 9) size--;
        while (!fits() && t.length > 1) t = t.slice(0, -1);
        rec.text(t, x + BOX.w / 2, y + BOX.h / 2 + size * 0.36, size, 0xffffffc0, { align: 'center', font: 'bold', literal: true });
    }
    /** the logo at x, y (in its BOX); without one, the plate with `label`; false: nothing drawn */
    function draw(rec, uuid, x, y, label) {
        if (!uuid) return false;
        const e = want(uuid);
        if (!e || e.state !== 'ok') {
            if (label == null || label === '') return false;
            placeholder(rec, x, y, label);
            return true;
        }
        const ox = x + Math.floor((BOX.w - e.w) / 2), oy = y + Math.floor((BOX.h - e.h) / 2);
        for (let i = 0; i < e.rects.length; i++) { const r = e.rects[i]; rec.fillRect(ox + r[0], oy + r[1], r[2] + OVERLAP, r[3] + OVERLAP, r[4]); }
        return true;
    }
    function stats() {
        const n = { ok: 0, loading: 0, none: 0, nologo: 0, why: lastWhy };
        map.forEach((e) => { n[e.state] = (n[e.state] || 0) + 1; });
        return n;
    }
    return { draw, version: () => ver, state: (uuid) => (map.get(keyOf(uuid)) || {}).state, want, stats };
}

module.exports = { createLogos, toRuns, toRects, fitBox, BOX, BACK };
