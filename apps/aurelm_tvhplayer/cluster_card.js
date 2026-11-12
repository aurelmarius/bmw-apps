'use strict';
/**
 * cluster_card.js - the channel playing on the instrument cluster: its logo, its name, the programme on now with its
 * times and how far it is, and what follows; over the media widget in the right dial, while a channel is on.
 *
 * Why a card of our own: the cluster's media widget shows what BMW's mediaapp fills in; nothing else gives it a title
 * (Iterio's mediabridge 1.0.10 found no way: "only mediaapp fills the widget's metadata"). TVH's sound comes in by the
 * CarLife input, so the widget says CarLife's "Not connected." (0.1.8 in the car). So the card is drawn over it, through
 * cluster-render (robertnisipeanu/idrive-apps, the Store; Waze on cluster installs it): an image layer on its `panel`
 * target (1920x720, the whole cluster, over the gauges and under the telltales), transparent around the card.
 *
 * Its place (PLACE): the media widget in a 2020s G-series cluster with the map in the middle (a photo of the car,
 * 2026-11-11: the cover at about 1320-1460 x 195-330, its three lines to y 490, from 1210 to 1630 at the widest);
 * the settings move it by up to 160 px. Drawn as BMW's widget is: the logo in the cover's place, the lines centred
 * under it, on a dark field that fades out into the dial (no frame). The client is the one cluster-render installs beside itself
 * (/var/opt/cluster-render/current/cluster_render_client.js, MPL-2.0, Node 8), so it speaks the service's protocol.
 *
 *   const card = createClusterCard({ log, ask, png, Canvas (the kit's), info, enabled, offset, hm });
 *   card.update()     called each second: shows, hides, draws again when what it shows changes (at most every 5 s)
 *   card.state()      { state: 'off'|'missing'|'waiting'|'shown'|..., detail }  (the Status tab's "Cluster" row)
 *   card.render(i)    the card's RGBA (CARD.w x CARD.h) for an info i (tests)
 */
const fs = require('fs');

const CLIENT = '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCKET = '/dev/shm/cluster-render/render.sock';
const CARD = { w: 520, h: 420 };
const PLACE = { x: 1130, y: 140 };      // panel pixels (1920x720): centred on the right dial's media widget (1390, 345)
const LOGO = { w: 190, h: 114 };        // in the cover's place; the server's logos are 5:3
const MIN_MS = 5000;

// as BMW's widget: no frame, the lines centred under the cover, white and a softer white; behind them a dark field
// that fades out to the dial (an ellipse, opaque inside FADE_IN of its radius: it hides the widget underneath)
const FIELD = [10, 12, 16], FADE_IN = 0.7;
const TEXT = [255, 255, 255, 255], SOFT = [255, 255, 255, 205], DIM = [255, 255, 255, 150], BLUE = [64, 160, 235, 255], TRACK = [255, 255, 255, 46];

function clip(cv, s, size, w, font) {
    s = String(s || '');
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s.trim() + '...';
}

/** the dark field: opaque in the middle, smoothly transparent at the ellipse's edge */
function field(cv) {
    const rx = CARD.w / 2 - 2, ry = CARD.h / 2 - 2, cx = CARD.w / 2, cy = CARD.h / 2, d = cv.d;
    for (let y = 0; y < CARD.h; y++) {
        for (let x = 0; x < CARD.w; x++) {
            const ex = (x + 0.5 - cx) / rx, ey = (y + 0.5 - cy) / ry, r = Math.sqrt(ex * ex + ey * ey);
            if (r >= 1) continue;
            const t = r <= FADE_IN ? 1 : 1 - (r - FADE_IN) / (1 - FADE_IN), a = t * t * (3 - 2 * t);
            const i = (y * CARD.w + x) * 4;
            d[i] = FIELD[0]; d[i + 1] = FIELD[1]; d[i + 2] = FIELD[2]; d[i + 3] = Math.round(a * 255);
        }
    }
}

/** the card: i = { name, title, start, stop, next: { start, title } | null, logo: { w, h, d } | null, now (ms) } */
function render(i, hm, Canvas) {
    const cv = new Canvas(CARD.w, CARD.h).clear([0, 0, 0, 0]);
    field(cv);
    const cx = CARD.w / 2, w = 360, top = 52;
    if (i.logo) cv.blit(i.logo, Math.round(cx - i.logo.w / 2), top + Math.round((LOGO.h - i.logo.h) / 2));
    else {
        cv.roundRect(cx - LOGO.w / 2, top, LOGO.w, LOGO.h, 12, [44, 50, 58, 255]);
        cv.text(clip(cv, String(i.name).replace(/^\d+\s+/, ''), 30, LOGO.w - 16, 'bold'), cx, top + LOGO.h / 2 + 11, 30, TEXT, { align: 'center', font: 'bold', literal: true });
    }
    let y = top + LOGO.h + 50;
    cv.text(clip(cv, i.name, 34, w, 'label'), cx, y, 34, TEXT, { align: 'center', literal: true });
    y += 42;
    if (i.title) {
        cv.text(clip(cv, i.title, 30, w, 'label'), cx, y, 30, SOFT, { align: 'center', literal: true });
        y += 40;
        if (i.start && i.stop && i.stop > i.start) {
            const left = Math.max(0, Math.round((i.stop * 1000 - i.now) / 60000));
            cv.text(hm(i.start) + ' - ' + hm(i.stop) + (left ? '  (' + left + ' min)' : ''), cx, y, 26, TEXT, { align: 'center', literal: true });
            y += 16;
            const bw = 240, f = Math.max(0, Math.min(1, (i.now / 1000 - i.start) / (i.stop - i.start)));
            cv.roundRect(cx - bw / 2, y, bw, 4, 2, TRACK);
            if (f > 0) cv.roundRect(cx - bw / 2, y, Math.max(4, bw * f), 4, 2, BLUE);
            y += 34;
        }
        if (i.next && i.next.title) cv.text(clip(cv, hm(i.next.start) + '  ' + i.next.title, 22, 300, 'label'), cx, y, 22, DIM, { align: 'center', literal: true });
    } else cv.text('No programme', cx, y, 28, DIM, { align: 'center', literal: true });
    return cv;
}

function createClusterCard(o) {
    const log = o.log || { info() {}, warn() {} };
    const CLIENT_PATH = o.clientPath || CLIENT, SOCKET_PATH = o.socketPath || SOCKET;
    let cr = null, layer = null, loadError = null;
    let st = { state: 'off', detail: 'off in the settings' };
    let key = null, drawnAt = 0, shownWant = false, place = null;
    const logos = new Map();   // uuid -> { state, img }

    function client() {
        if (cr) return cr;
        if (!fs.existsSync(SOCKET_PATH) && !fs.existsSync(CLIENT_PATH)) { st = { state: 'missing', detail: 'cluster-render is not installed (the Store: robertnisipeanu/idrive-apps)' }; return null; }
        let mod;
        try { mod = require(CLIENT_PATH); } catch (e) {
            if (loadError !== e.message) { loadError = e.message; log.warn('cluster: ' + e.message); }
            st = { state: 'missing', detail: 'cluster-render\'s client: ' + e.message };
            return null;
        }
        cr = new mod.ClusterRender('aurelm_tvhplayer');
        cr.on('layer', (ref, s, reason) => {
            if (ref !== layer) return;
            st = { state: s, detail: s === 'shown' ? 'on the cluster' : s + (reason ? ': ' + reason : '') };
            log.info('cluster: card ' + s + (reason ? ' (' + reason + ')' : ''));
        });
        cr.on('target', (name, s, holder, reason) => { if (name === 'panel' && s !== 'shown') log.info('cluster: panel ' + s + (holder ? ' (held by ' + holder + ')' : '') + (reason ? ': ' + reason : '')); });
        cr.on('refused', (op, ref, reason) => { st = { state: 'error', detail: 'refused (' + op + '): ' + reason }; log.warn('cluster: ' + op + ' refused: ' + reason); });
        cr.on('disconnected', () => { if (layer) st = { state: 'waiting', detail: 'cluster-render restarting' }; });
        cr.connect();
        return cr;
    }

    /** the channel's logo, fitted to LOGO (asked for once; a failure tried again after 10 minutes) */
    function logoOf(uuid) {
        const e = logos.get(uuid);
        if (e && (e.state !== 'none' || Date.now() - e.at < 600000)) return e.img || null;
        logos.set(uuid, { state: 'loading', at: Date.now() });
        o.ask('logo', { uuid }, 20000).then((r) => {
            if (!r || !r.png) { logos.set(uuid, { state: 'none', at: Date.now() }); return; }
            o.png.decodeAsync(Buffer.from(r.png, 'base64'), (err, img) => {
                if (err) { logos.set(uuid, { state: 'none', at: Date.now() }); return; }
                const k = Math.min(LOGO.w / img.w, LOGO.h / img.h, 1);
                const f = k >= 1 ? img : o.png.fit(img, Math.max(1, Math.round(Math.max(img.w, img.h) * k)));
                logos.set(uuid, { state: 'ok', img: { w: f.w, h: f.h, d: f.data } });
                key = null;
            });
        }, () => logos.set(uuid, { state: 'none', at: Date.now() }));
        return null;
    }

    function hide(why) {
        if (layer && shownWant) { cr.set(layer, { visible: 0 }); shownWant = false; log.info('cluster: card hidden (' + why + ')'); }
        key = null;
    }

    function update() {
        if (!o.enabled()) { hide('the setting'); st = { state: 'off', detail: 'off in the settings' }; return; }
        const i = o.info();
        if (!i) { hide('nothing playing'); st = { state: 'off', detail: 'nothing playing (cluster-render is asked once a channel plays)' }; return; }
        const c = client();
        if (!c) return;
        const off = o.offset ? o.offset() : { dx: 0, dy: 0 };
        const x = PLACE.x + (off.dx || 0), y = PLACE.y + (off.dy || 0);
        if (!layer) {
            layer = c.image({ target: 'panel', klass: 'overlay', x, y, w: CARD.w, h: CARD.h, iw: CARD.w, ih: CARD.h, visible: 0 });
            place = x + ',' + y;
            st = { state: 'waiting', detail: 'asking cluster-render for the panel' };
        } else if (place !== x + ',' + y) { c.set(layer, { x, y }); place = x + ',' + y; }
        i.logo = logoOf(i.uuid);
        i.now = Date.now();
        // what is drawn changes with the programme, the logo and the minute (the progress)
        const k = [i.uuid, i.name, i.title, i.start, i.stop, i.next ? i.next.start + i.next.title : '', i.logo ? i.logo.w : 0, Math.floor(i.now / 60000), o.hmKey ? o.hmKey() : ''].join('|');
        if (k !== key && Date.now() - drawnAt >= MIN_MS) {
            const cv = render(i, o.hm, o.Canvas);
            c.pixels(layer, null, Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length));
            key = k; drawnAt = Date.now();
        }
        if (!shownWant) { c.set(layer, { visible: 1 }); shownWant = true; log.info('cluster: card for ' + i.name + ' at ' + x + ',' + y); }
    }

    function close() { if (cr) { try { cr.close(); } catch (e) { /* gone */ } } cr = null; layer = null; }

    return { update, state: () => st, close, render: (i) => render(i, o.hm, o.Canvas) };
}

module.exports = { createClusterCard, render, CARD, PLACE, LOGO };
