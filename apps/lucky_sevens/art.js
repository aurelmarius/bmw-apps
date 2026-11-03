'use strict';
/**
 * Lucky Sevens' look: a casino slot machine. A lacquered cabinet in a gold moulding with marquee
 * bulbs, five reels behind curved glass in a chrome bezel, glossy symbols lit from the top left (an
 * extruded 7 with a gold rim, cherries, a lemon, a bell, a BAR plate, a cut diamond, a WILD star),
 * gold coins, and a control panel with LCD read-outs and a domed SPIN button.
 *
 * Everything is drawn from rects, rounded rects, gradients, convex polygons, arcs, lines and text
 * (kit/record.js). The parts that don't change are drawn once into cached layers (the cabinet, every
 * symbol and its motion-blurred copy, a lit bulb, a coin, the panel), so a frame is mostly layer blits:
 * the GPU renderer draws it at 60 fps and the software path can still play it.
 */
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');

// device px per page px (the display's textScale): layers with text are drawn at the size they're shown
let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const CAB = { x: 24, y: 46, w: 1116, h: 462 };
const ROW_H = 100, REEL_W = 195, GAP = 10;
const WIN = { x: CAB.x + 50, y: CAB.y + 88, w: 5 * REEL_W + 4 * GAP, h: 3 * ROW_H };
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const TITLE_PLATE = { x: CAB.x + 110, y: CAB.y + 28, w: 400 };
const JP_PLATE = { x: CAB.x + CAB.w - 110 - 400, y: CAB.y + 28, w: 400 };
const SPIN_BTN = { x: PANEL.x + 290, y: 420, r: 66 };
const reelX = (i) => WIN.x + i * (REEL_W + GAP);
const cellCentre = (i, row) => [reelX(i) + REEL_W / 2, WIN.y + row * ROW_H + ROW_H / 2];

/** cabinet lacquer: [top, middle, bottom, title glow] */
const CABINETS = {
    ruby: ['#5a0f1c', '#2c0710', '#14030a', '#ff3d7f'],
    sapphire: ['#0f2a5a', '#071530', '#030a16', '#36a8ff'],
    emerald: ['#0d4a32', '#06281b', '#03140d', '#3dffa8'],
    onyx: ['#2a2a30', '#141418', '#08080a', '#ffd36e'],
};

/* ---------- light and material helpers ---------- */
/**
 * A filled convex polygon. The recorder draws quads only (anti-aliased edge by edge), so a polygon is
 * a fan of quads around its centre; an opaque one has its quads grown by a little under a px, so they
 * overlap and no seam shows between them (a translucent one keeps them edge to edge: an overlap
 * would show darker).
 */
function poly(cv, pts, c) {
    if (cv.convex) return cv.convex(pts, c);
    const n = pts.length;
    if (n === 4) return cv.quad(pts, c);
    if (n === 3) return cv.quad([pts[0], pts[1], [(pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2], pts[2]], c);
    const opaque = typeof c === 'string' ? c.length === 7 || c.length === 4 : !(c.length > 3 && c[3] < 255);
    const cx = pts.reduce((a, p) => a + p[0], 0) / n, cy = pts.reduce((a, p) => a + p[1], 0) / n;
    for (let i = 0; i < n; i += 2) {
        const q = [[cx, cy], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]];
        if (opaque) {
            const mx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, my = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
            for (const v of q) { const dx = v[0] - mx, dy = v[1] - my, l = Math.hypot(dx, dy) || 1; v[0] += dx / l * 0.7; v[1] += dy / l * 0.7; }
        }
        cv.quad(q, c);
    }
    return cv;
}
function gradAt(stops, t) {
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
    return mix(a[1], b[1], b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))));
}
/** a sphere: concentric circles, their centres drawn toward the light (top left) */
function ball(cv, cx, cy, r, stops, lx, ly) {
    lx = lx === undefined ? -0.35 : lx; ly = ly === undefined ? -0.4 : ly;
    const n = Math.max(8, Math.min(24, Math.round(r * 0.6)));
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        cv.circle(cx + lx * r * t * 0.9, cy + ly * r * t * 0.9, Math.max(0.6, r * (1 - t)), gradAt(stops, t));
    }
}
function ellipse(cx, cy, rx, ry, rot, n) {
    rot = rot || 0; n = n || 32;
    const p = [], c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, x = Math.cos(a) * rx, y = Math.sin(a) * ry; p.push([cx + x * c - y * s, cy + x * s + y * c]); }
    return p;
}
function glow(cv, cx, cy, r, c, a) { for (let i = 6; i >= 1; i--) cv.circle(cx, cy, r * i / 6, withAlpha(c, a * (1 - i / 7) * 0.4)); }
function outlined(cv, s, x, y, size, fill, edge, ew, o) {
    o = Object.assign({ font: 'bold', align: 'center' }, o || {});
    if (o.shadow !== false) for (let k = 1; k <= 3; k++) cv.text(s, x + k, y + k * 1.3, size, withAlpha('#000000', 0.2), o);
    for (let a = 0; a < 12; a++) cv.text(s, x + Math.cos(a / 12 * 6.283) * ew, y + Math.sin(a / 12 * 6.283) * ew, size, edge, o);
    cv.text(s, x, y, size, fill, o);
}
/** a moulded frame: outlines whose colours follow a bevel's cross-section */
function moulding(cv, x, y, w, h, r, width, profile) {
    for (let k = 0; k < width; k++) cv.strokeRoundRect(x + k, y + k, w - 2 * k, h - 2 * k, Math.max(2, r - k), 1.6, gradAt(profile, k / (width - 1)));
}
const GOLD = [[0, '#3a2200'], [0.12, '#a8701a'], [0.3, '#ffe9a8'], [0.42, '#f1c45a'], [0.7, '#8a5a0a'], [0.88, '#d9a23b'], [1, '#2a1800']];
const CHROME = [[0, '#22252b'], [0.2, '#8a919c'], [0.4, '#ffffff'], [0.6, '#9aa2ae'], [0.85, '#3b4049'], [1, '#111216']];
const goldCard = (cv, x, y, w, h, r) => cv.card(x, y, w, h, r, [[0, '#fff3c4'], [0.2, '#f1c45a'], [0.5, '#a8701a'], [0.55, '#7a4c0c'], [0.8, '#d9a23b'], [1, '#ffe39a']]);

/* ---------- the symbols (centre cx, cy, size s) ---------- */
function sevenPieces(cx, cy, s) {
    const P = (pts) => pts.map(([x, y]) => [cx + x * s, cy + y * s]);
    return [
        P([[-0.32, -0.44], [0.34, -0.44], [0.34, -0.26], [-0.32, -0.26]]),
        P([[0.1, -0.27], [0.34, -0.27], [0.02, 0.44], [-0.22, 0.44]]),
        P([[-0.32, -0.44], [-0.18, -0.44], [-0.18, -0.16], [-0.32, -0.2]]),
    ];
}
function shrink(pts, d) {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return pts.map(([x, y]) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x - dx / l * d, y - dy / l * d]; });
}
const SYM = {
    seven(cv, cx, cy, s) {
        cx -= s * 0.04; cy -= s * 0.04;
        const pcs = sevenPieces(cx, cy, s);
        for (const p of pcs) poly(cv, p.map(([x, y]) => [x + 8, y + 11]), withAlpha('#000000', 0.25));
        for (let k = 8; k >= 1; k--) for (const p of pcs) poly(cv, p.map(([x, y]) => [x + k * 0.8, y + k]), mix('#3a0006', '#7a0010', 1 - k / 8));
        for (const p of pcs) poly(cv, p, '#f1c45a');
        for (const p of pcs) poly(cv, shrink(p, 2), '#8a5a0a');
        const body = [[0, '#6a0010'], [0.5, '#d0101e'], [1, '#ff5a5f']];
        for (let k = 0; k <= 7; k++) for (const p of pcs) poly(cv, shrink(p, 3.5 + k * 0.8).map(([x, y]) => [x - k * 0.22, y - k * 0.3]), gradAt(body, k / 7));
        const b = pcs[0];
        poly(cv, [[b[0][0] + 6, b[0][1] + 5], [b[1][0] - 6, b[1][1] + 5], [b[1][0] - 8, b[0][1] + 9], [b[0][0] + 8, b[0][1] + 9]], withAlpha('#ffffff', 0.6));
        const st = pcs[1];
        cv.line(st[1][0] - 8, st[1][1] + 5, st[2][0] + 9, st[2][1] - 10, 2.5, withAlpha('#ffffff', 0.35));
    },
    cherry(cv, cx, cy, s) {
        cv.line(cx - s * 0.2, cy + s * 0.05, cx + s * 0.08, cy - s * 0.4, s * 0.05, '#4a7a1c');
        cv.line(cx + s * 0.2, cy + s * 0.12, cx + s * 0.08, cy - s * 0.4, s * 0.05, '#3f6a17');
        poly(cv, ellipse(cx + s * 0.22, cy - s * 0.4, s * 0.2, s * 0.08, -0.5), '#3e9a2a');
        cv.line(cx + s * 0.08, cy - s * 0.4, cx + s * 0.36, cy - s * 0.46, 1.5, withAlpha('#c8ff9a', 0.6));
        for (const [x, y] of [[cx - s * 0.2, cy + s * 0.18], [cx + s * 0.2, cy + s * 0.25]]) {
            cv.circle(x + 3, y + 5, s * 0.25, withAlpha('#000000', 0.3));
            ball(cv, x, y, s * 0.25, [[0, '#3d0005'], [0.45, '#a3000f'], [0.85, '#ff2d3b'], [1, '#ff8a8f']]);
            poly(cv, ellipse(x - s * 0.08, y - s * 0.1, s * 0.07, s * 0.04, -0.7, 16), withAlpha('#ffffff', 0.85));
        }
    },
    lemon(cv, cx, cy, s) {
        poly(cv, ellipse(cx + 4, cy + 6, s * 0.42, s * 0.3, -0.25), withAlpha('#000000', 0.3));
        for (let i = 0; i <= 12; i++) {
            const t = i / 12;
            poly(cv, ellipse(cx - s * 0.1 * t, cy - s * 0.1 * t, s * 0.42 * (1 - t * 0.85), s * 0.3 * (1 - t * 0.85), -0.25),
                gradAt([[0, '#b07800'], [0.4, '#f2c300'], [0.8, '#ffe85a'], [1, '#fffbd0']], t));
        }
        for (let i = 0; i < 30; i++) { const h = Math.sin(i * 12.9898) * 43758.5453, g = Math.sin(i * 78.233) * 12345.678; cv.circle(cx + (h - Math.floor(h) - 0.5) * s * 0.6, cy + (g - Math.floor(g) - 0.5) * s * 0.36, 1.1, withAlpha('#8a5a00', 0.25)); }
        poly(cv, ellipse(cx - s * 0.14, cy - s * 0.12, s * 0.1, s * 0.04, -0.4, 16), withAlpha('#ffffff', 0.7));
        poly(cv, ellipse(cx + s * 0.36, cy - s * 0.2, s * 0.14, s * 0.06, -0.8), '#3e9a2a');
        cv.line(cx + s * 0.28, cy - s * 0.12, cx + s * 0.44, cy - s * 0.28, 1.5, withAlpha('#c8ff9a', 0.6));
    },
    bell(cv, cx, cy, s) {
        cy += s * 0.04;
        const prof = [];
        for (let i = 0; i <= 16; i++) { const t = i / 16; prof.push([s * (0.2 + 0.04 * t + 0.2 * Math.pow(t, 5)), -s * 0.3 + t * s * 0.58]); }
        const body = (f, off) => prof.map(([x, y]) => [cx + off - x * f, cy + y]).concat(prof.map(([x, y]) => [cx + off + x * f, cy + y]).reverse());
        poly(cv, body(1, 0).map(([x, y]) => [x + 4, y + 6]), withAlpha('#000000', 0.3));
        cv.circle(cx + 4, cy - s * 0.3 + 6, s * 0.2, withAlpha('#000000', 0.3));
        poly(cv, body(1, 0), '#8a5a0a');
        ball(cv, cx, cy - s * 0.3, s * 0.2, [[0, '#8a5a0a'], [0.5, '#e0a62a'], [1, '#fff1b0']], -0.5, -0.3);
        for (let k = 1; k <= 8; k++) poly(cv, body(1 - k / 10, -s * 0.06 * k / 8), gradAt([[0, '#8a5a0a'], [0.5, '#e0a62a'], [1, '#fff1b0']], k / 8));
        cv.card(cx - s * 0.45, cy + s * 0.24, s * 0.9, s * 0.1, s * 0.05, [[0, '#ffe08a'], [1, '#7a4c0c']]);
        ball(cv, cx, cy + s * 0.4, s * 0.08, [[0, '#5a3a00'], [1, '#ffe08a']]);
        ball(cv, cx, cy - s * 0.52, s * 0.06, [[0, '#5a3a00'], [1, '#ffe08a']]);
        cv.quad([[cx - s * 0.14, cy - s * 0.3], [cx - s * 0.08, cy - s * 0.3], [cx - s * 0.14, cy + s * 0.2], [cx - s * 0.22, cy + s * 0.2]], withAlpha('#ffffff', 0.45));
    },
    bar(cv, cx, cy, s) {
        cv.roundRect(cx - s * 0.48 + 4, cy - s * 0.22 + 6, s * 0.96, s * 0.44, 8, withAlpha('#000000', 0.35));
        goldCard(cv, cx - s * 0.48, cy - s * 0.22, s * 0.96, s * 0.44, 8);
        cv.card(cx - s * 0.44, cy - s * 0.18, s * 0.88, s * 0.36, 6, [[0, '#262626'], [0.5, '#0a0a0a'], [1, '#1c1c1c']]);
        outlined(cv, 'BAR', cx, cy + s * 0.12, s * 0.32, '#fff6dc', '#b0001a', 1.5, { shadow: false, literal: true });
        cv.roundRect(cx - s * 0.42, cy - s * 0.17, s * 0.84, s * 0.08, 4, withAlpha('#ffffff', 0.12));
    },
    diamond(cv, cx, cy, s) {
        cy -= s * 0.04;
        const m = cy - s * 0.04, b = cy + s * 0.42, L = cx - s * 0.42, R = cx + s * 0.42;
        glow(cv, cx, cy, s * 0.6, '#36d1ff', 0.3);
        const c0 = [cx - s * 0.24, cy - s * 0.32], c1 = [cx + s * 0.24, cy - s * 0.32];
        poly(cv, [[L, m], c0, c1, [R, m]], '#7fe0ff');
        poly(cv, [c0, [cx, c0[1]], [cx - s * 0.12, m]], '#c9f3ff');
        poly(cv, [[cx, c0[1]], c1, [cx + s * 0.12, m]], '#9ae8ff');
        poly(cv, [[L, m], c0, [cx - s * 0.12, m]], '#4fc4f0');
        poly(cv, [[R, m], c1, [cx + s * 0.12, m]], '#2a9fd8');
        poly(cv, [[L, m], [cx - s * 0.12, m], [cx, b]], '#1b7fc4');
        poly(cv, [[cx - s * 0.12, m], [cx + s * 0.12, m], [cx, b]], '#5fd0ff');
        poly(cv, [[cx + s * 0.12, m], [R, m], [cx, b]], '#0e5a9a');
        cv.line(cx - s * 0.18, cy - s * 0.27, cx - s * 0.04, cy - s * 0.27, 2, withAlpha('#ffffff', 0.9));
        sparkle(cv, cx + s * 0.22, cy - s * 0.3, 12);
    },
    wild(cv, cx, cy, s) {
        cy -= s * 0.08;
        glow(cv, cx, cy, s * 0.6, '#ffb84d', 0.4);
        const pts = [];
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? s * 0.17 : s * 0.4; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
        for (let i = 0; i < 10; i++) {
            const a = pts[i], b = pts[(i + 1) % 10];
            poly(cv, [[cx, cy], a, b], i % 2 ? '#d98c00' : '#ffd84d');
            poly(cv, [[cx, cy], a, b].map(([x, y]) => [cx + (x - cx) * 0.6, cy + (y - cy) * 0.6]), i % 2 ? '#ffb020' : '#fff1a8');
        }
        outlined(cv, 'WILD', cx, cy + s * 0.56, s * 0.22, '#ffffff', '#b0001a', 1.5, { shadow: false, literal: true });
    },
};
function sparkle(cv, x, y, r) {
    poly(cv, [[x, y - r], [x + r * 0.22, y], [x, y + r], [x - r * 0.22, y]], '#ffffff');
    poly(cv, [[x - r, y], [x, y - r * 0.22], [x + r, y], [x, y + r * 0.22]], '#ffffff');
}

/* ---------- cached layers ---------- */
const SYM_S = 84;
/** one symbol, centred in a REEL_W x ROW_H cell (a little room around for its shadow) */
function symbolLayer(name) {
    return lay('ls-sym|' + name, REEL_W, ROW_H + 20, (c) => SYM[name](c, REEL_W / 2, ROW_H / 2 + 10, SYM_S));
}
/** the same symbol smeared along the reel: drawn while the reel runs fast */
function blurLayer(name) {
    return lay('ls-blur|' + name, REEL_W, ROW_H + 60, (c) => {
        for (let k = -5; k <= 5; k++) { c.alpha(0.13); SYM[name](c, REEL_W / 2, ROW_H / 2 + 30 + k * 4.5, SYM_S); }
        c.alpha(1);
    });
}
function bulbLayer() {
    return lay('ls-bulb', 60, 60, (c) => { glow(c, 30, 30, 28, '#ffc04d', 0.9); ball(c, 30, 30, 6.5, [[0, '#a86a00'], [0.6, '#ffd36e'], [1, '#ffffff']]); });
}
const COIN_R = 15;
/** a gold coin turning: phase 0..7 (seen face on .. edge on .. face on) */
function coinLayer(phase) {
    return lay('ls-coin|' + phase, 2 * COIN_R + 8, 2 * COIN_R + 8, (c) => coin(c, COIN_R + 3, COIN_R + 3, COIN_R, Math.max(0.12, Math.abs(Math.cos(phase / 8 * Math.PI)))));
}
function coin(cv, x, y, r, tilt) {
    poly(cv, ellipse(x + 2, y + 3, r, r * tilt, 0, 24), withAlpha('#000000', 0.3));
    poly(cv, ellipse(x + 1, y + 2, r, r * tilt, 0, 24), '#7a4c0c');
    poly(cv, ellipse(x, y, r, r * tilt, 0, 24), '#d9a23b');
    poly(cv, ellipse(x, y, r * 0.78, r * 0.78 * tilt, 0, 24), '#b07a1a');
    poly(cv, ellipse(x - r * 0.06, y - r * 0.06 * tilt, r * 0.7, r * 0.7 * tilt, 0, 24), '#ffd36e');
    if (tilt > 0.4) for (let i = 0; i < 5; i++) {
        const a1 = -Math.PI / 2 + i * 2 * Math.PI / 5, a2 = a1 + Math.PI / 5, a0 = a1 - Math.PI / 5;
        const P = (a, rr) => [x + Math.cos(a) * rr * r, y + Math.sin(a) * rr * r * tilt];
        poly(cv, [[x, y], P(a0, 0.18), P(a1, 0.45)], '#a8701a');
        poly(cv, [[x, y], P(a1, 0.45), P(a2, 0.18)], '#fff0b8');
    }
    cv.circle(x - r * 0.4, y - r * 0.35 * tilt, r * 0.13, withAlpha('#ffffff', 0.9));
}

/* the bulbs around the cabinet: positions in page px */
const BULBS = [];
{
    const top = CAB.y + 8, bottom = CAB.y + CAB.h - 8, n = 24;
    for (let i = 0; i <= n; i++) BULBS.push([CAB.x + 44 + i * (CAB.w - 88) / n, top]);
    for (let i = 1; i < 8; i++) BULBS.push([CAB.x + CAB.w - 8, top + i * (bottom - top) / 8]);
    for (let i = n; i >= 0; i--) BULBS.push([CAB.x + 44 + i * (CAB.w - 88) / n, bottom]);
    for (let i = 7; i >= 1; i--) BULBS.push([CAB.x + 8, top + i * (bottom - top) / 8]);
}

/** the cabinet, drawn at (ox, oy) = where CAB's corner lands */
function drawCabinet(c, ox, oy, colour, title) {
    const p = CABINETS[colour] || CABINETS.ruby, w = CAB.w, h = CAB.h;
    c.roundRect(ox + 8, oy + 12, w - 8, h - 12, 26, withAlpha('#000000', 0.55));
    c.card(ox, oy, w, h, 26, [[0, p[0]], [0.5, p[1]], [1, p[2]]]);
    c.roundRect(ox + 6, oy + 3, w - 12, 50, 22, withAlpha('#ffffff', 0.07));
    c.card(ox + 22, oy + 22, w - 44, h - 44, 16, [[0, mix(p[1], '#000000', 0.2)], [1, mix(p[2], '#000000', 0.5)]]);
    moulding(c, ox + 12, oy + 12, w - 24, h - 24, 22, 11, GOLD);
    c.strokeRoundRect(ox + 23, oy + 23, w - 46, h - 46, 15, 5, withAlpha('#000000', 0.45));
    for (const [bx, by] of BULBS) {
        const x = bx - CAB.x + ox, y = by - CAB.y + oy;
        c.circle(x + 1, y + 2, 8.5, withAlpha('#000000', 0.5));
        ball(c, x, y, 8, [[0, '#3b4049'], [0.6, '#c3c9d2'], [1, '#ffffff']]);
        ball(c, x, y, 5.5, [[0, '#3a2600'], [1, '#8a6a2a']]);
    }
    // the title plate, and the jackpot's plate beside it (its number is drawn every frame: JP_PLATE)
    const tx = TITLE_PLATE.x - CAB.x + ox + TITLE_PLATE.w / 2, ty = TITLE_PLATE.y - CAB.y + oy;
    glow(c, tx, ty + 23, 170, p[3], 0.35);
    c.card(tx - TITLE_PLATE.w / 2, ty, TITLE_PLATE.w, 48, 24, [[0, '#14030b'], [1, '#2e0614']]);
    moulding(c, tx - TITLE_PLATE.w / 2, ty, TITLE_PLATE.w, 48, 24, 4, GOLD);
    outlined(c, title, tx, ty + 36, 32, '#fff6dc', p[3], 2.2, { literal: true, spacing: 3 });
    const jx = JP_PLATE.x - CAB.x + ox, jy = JP_PLATE.y - CAB.y + oy;
    glow(c, jx + JP_PLATE.w / 2, jy + 23, 160, '#ff3d7f', 0.25);
    c.card(jx, jy, JP_PLATE.w, 48, 24, [[0, '#050608'], [1, '#14080e']]);
    moulding(c, jx, jy, JP_PLATE.w, 48, 24, 4, GOLD);
    c.text('JACKPOT', jx + 26, jy + 31, 17, '#ffd36e', { font: 'bold', spacing: 2 });
    c.text('88888888', jx + JP_PLATE.w - 24, jy + 37, 30, withAlpha('#ff3d7f', 0.05), { font: 'num', align: 'right', literal: true });
    // the reel window's chrome bezel and its dark well
    const wx = WIN.x - CAB.x + ox, wy = WIN.y - CAB.y + oy;
    moulding(c, wx - 14, wy - 14, WIN.w + 28, WIN.h + 28, 18, 11, CHROME);
    c.roundRect(wx - 3, wy - 3, WIN.w + 6, WIN.h + 6, 8, '#050205');
}
/** the cabinet behind everything */
function cabinetLayer(colour, title) {
    return lay('ls-cab|' + colour + '|' + title, CAB.w, CAB.h, (c) => drawCabinet(c, 0, 0, colour, title));
}
/** the room behind the machine: a dark casino floor (page px, drawn with its top at oy) */
function drawRoom(c, oy, w) { c.gradientRect(0, 40 + oy, w, 480, [[0, '#1a0b22'], [0.5, '#0c0612'], [1, '#050307']]); }
/**
 * The page above and below the reel window (the room and the cabinet), drawn again over the reels: it
 * hides the symbols half out of the window also where clip() isn't kept (the software path).
 */
const PAGE_H = 520;
function bandLayers(colour, title) {
    const top = WIN.y - 3, bottom = WIN.y + WIN.h + 3;
    const draw = (c, y0) => { c.fillRect(0, -y0, CAB.w + 2 * CAB.x, 40, '#07040a'); drawRoom(c, -y0, CAB.w + 2 * CAB.x); drawCabinet(c, CAB.x, CAB.y - y0, colour, title); };
    return [
        { L: lay('ls-band-top|' + colour + '|' + title, CAB.w + 2 * CAB.x, top, (c) => draw(c, 0)), y: 0 },
        { L: lay('ls-band-bottom|' + colour + '|' + title, CAB.w + 2 * CAB.x, PAGE_H - bottom, (c) => draw(c, bottom)), y: bottom },
    ];
}

/* ---------- the reels ---------- */
/** the drum behind the symbols: paper white, darker toward its top and bottom */
function drawDrum(cv, i) {
    cv.card(reelX(i), WIN.y, REEL_W, WIN.h, 4, [[0, '#2a2a30'], [0.12, '#b9bcc4'], [0.3, '#f4f4f0'], [0.5, '#ffffff'], [0.7, '#f4f4f0'], [0.88, '#b9bcc4'], [1, '#2a2a30']]);
}
/** what curves the drum: shading over the symbols at its top and bottom, its edges, the divider */
function drawDrumShade(cv, i) {
    const x = reelX(i);
    cv.gradientRect(x, WIN.y, REEL_W, WIN.h * 0.26, [[0, withAlpha('#000000', 0.72)], [1, withAlpha('#000000', 0)]]);
    cv.gradientRect(x, WIN.y + WIN.h * 0.74, REEL_W, WIN.h * 0.26, [[0, withAlpha('#000000', 0)], [1, withAlpha('#000000', 0.72)]]);
    cv.fillRect(x, WIN.y, 3, WIN.h, withAlpha('#000000', 0.22));
    cv.fillRect(x + REEL_W - 3, WIN.y, 3, WIN.h, withAlpha('#000000', 0.22));
    if (i < 4) {
        cv.card(x + REEL_W, WIN.y - 2, GAP, WIN.h + 4, 2, [[0, '#2b2f36'], [0.5, '#c3c9d2'], [1, '#2b2f36']]);
        cv.fillRect(x + REEL_W + GAP / 2 - 0.5, WIN.y, 1, WIN.h, withAlpha('#ffffff', 0.55));
    }
}
/** the glass over the window: a soft wide reflection, a narrow one, light along the top edge */
function drawGlass(cv) {
    const { x, y, w, h } = WIN;
    cv.quad([[x, y], [x + w * 0.42, y], [x + w * 0.22, y + h], [x, y + h]], withAlpha('#ffffff', 0.045));
    cv.quad([[x + w * 0.47, y], [x + w * 0.52, y], [x + w * 0.32, y + h], [x + w * 0.27, y + h]], withAlpha('#ffffff', 0.05));
    cv.gradientRect(x, y, w, 12, [[0, withAlpha('#ffffff', 0.2)], [1, withAlpha('#ffffff', 0)]]);
}
/** behind a winning symbol: light rays and a warm glow */
function raysLayer() {
    return lay('ls-rays', REEL_W, ROW_H, (c) => {
        const cx = REEL_W / 2, cy = ROW_H / 2;
        for (let i = 0; i < 18; i++) {
            const a = i / 18 * Math.PI * 2, b = a + 0.09, R = 120;
            poly(c, [[cx, cy], [cx + Math.cos(a) * R, cy + Math.sin(a) * R * 0.7], [cx + Math.cos(b) * R, cy + Math.sin(b) * R * 0.7]], withAlpha('#ffc04d', 0.24));
        }
        glow(c, cx, cy, 60, '#ffd36e', 0.55);
    });
}
/** a winning cell's frame: a soft gold halo and a bright edge */
function drawCellFrame(cv, i, row, color, a) {
    const x = reelX(i) + 5, y = WIN.y + row * ROW_H + 4, w = REEL_W - 10, h = ROW_H - 8;
    for (let k = 5; k >= 1; k--) cv.strokeRoundRect(x - k, y - k, w + 2 * k, h + 2 * k, 12, 2, withAlpha(color, 0.07 * (6 - k) * a));
    cv.strokeRoundRect(x, y, w, h, 12, 3, withAlpha('#fff3c4', a));
}
/** a payline through the window, with its number at both ends */
const LINE_COLOURS = ['#ff3d7f', '#36d1ff', '#5ff0a6', '#ffb84d', '#c99bff', '#ff6a2a', '#7fd1ff', '#ffd36e', '#ff8ac0', '#9cff57'];
function drawPayline(cv, rows, n, a) {
    const c = LINE_COLOURS[n % LINE_COLOURS.length];
    const pts = [[WIN.x - 12, WIN.y + rows[0] * ROW_H + ROW_H / 2]];
    rows.forEach((r, i) => pts.push(cellCentre(i, r)));
    pts.push([WIN.x + WIN.w + 12, WIN.y + rows[4] * ROW_H + ROW_H / 2]);
    cv.polyline(pts, 9, withAlpha(c, 0.18 * a));
    cv.polyline(pts, 4, withAlpha(c, 0.5 * a));
    cv.polyline(pts, 1.5, withAlpha('#ffffff', 0.8 * a));
    for (const [x, y] of [pts[0], pts[pts.length - 1]]) {
        cv.circle(x, y, 13, withAlpha(c, a));
        cv.text(String(n + 1), x, y + 6, 17, withAlpha('#000000', 0.85 * a), { font: 'bold', align: 'center', literal: true });
    }
}

/* ---------- the panel ---------- */
const LCD = {
    credit: { x: PANEL.x + 24, y: PANEL.y + 46, w: PANEL.w - 48, label: 'CREDIT', color: '#5ff0a6' },
    bet: { x: PANEL.x + 24, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'BET', color: '#ffd36e' },
    win: { x: PANEL.x + 36 + (PANEL.w - 60) / 2, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'WIN', color: '#ff8ac0' },
};
const BUTTONS = {
    betDown: { x: PANEL.x + 24, y: PANEL.y + 238, w: 114, h: 46, label: 'BET -' },
    betUp: { x: PANEL.x + 151, y: PANEL.y + 238, w: 114, h: 46, label: 'BET +' },
    max: { x: PANEL.x + 278, y: PANEL.y + 238, w: 114, h: 46, label: 'MAX BET' },
    auto: { x: PANEL.x + 24, y: PANEL.y + 300, w: 150, h: 46, label: 'AUTO' },
    stats: { x: PANEL.x + 24, y: PANEL.y + 356, w: 150, h: 46, label: 'STATS' },
};
function panelLayer() {
    return lay('ls-panel', PANEL.w, PANEL.h, (c) => {
        const ox = -PANEL.x, oy = -PANEL.y, w = PANEL.w, h = PANEL.h;
        c.card(0, 0, w, h, 22, [[0, '#24242c'], [0.5, '#121218'], [1, '#08080b']]);
        for (let i = 0; i < 88; i++) c.fillRect(8, 12 + i * 5, w - 16, 1, withAlpha(i % 3 ? '#ffffff' : '#000000', 0.018));
        moulding(c, 0, 0, w, h, 22, 8, CHROME);
        for (const k of Object.keys(LCD)) {
            const q = LCD[k], x = q.x + ox, y = q.y + oy;
            c.text(q.label, x + 4, y - 9, 16, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2 });
            moulding(c, x - 4, y - 4, q.w + 8, 66, 13, 4, CHROME);
            c.card(x, y, q.w, 58, 10, [[0, '#050608'], [1, '#101318']]);
            c.gradientRect(x + 4, y + 3, q.w - 8, 14, [[0, withAlpha('#ffffff', 0.07)], [1, withAlpha('#ffffff', 0)]]);
            c.text('8888888', x + q.w - 14, y + 44, 38, withAlpha(q.color, 0.035), { font: 'num', align: 'right', literal: true });
        }
        // the spin button's chrome ring and its well
        const sx = SPIN_BTN.x + ox, sy = SPIN_BTN.y + oy, r = SPIN_BTN.r;
        c.circle(sx + 4, sy + 8, r + 10, withAlpha('#000000', 0.6));
        ball(c, sx, sy, r + 10, [[0, '#2b2f36'], [0.4, '#8a919c'], [0.8, '#e2e6ec'], [1, '#ffffff']], 0.2, 0.3);
        c.circle(sx, sy, r + 1, '#1a0004');
    });
}
/** a panel key: up, lit (AUTO on) or pressed */
function keyLayer(id, state) {
    const q = BUTTONS[id];
    return lay('ls-key|' + id + '|' + state, q.w + 6, q.h + 8, (c) => {
        const down = state === 'down', lit = state === 'lit', dy = down ? 3 : 0;
        if (!down) c.roundRect(2, 5, q.w, q.h, 12, withAlpha('#000000', 0.6));
        c.card(0, dy, q.w, q.h, 12, lit ? [[0, '#ffe08a'], [0.5, '#d98c00'], [1, '#8a5a0a']] : [[0, '#5a5f6b'], [0.5, '#2c2f36'], [1, '#1a1c21']]);
        c.roundRect(3, dy + 2, q.w - 6, q.h * 0.36, 8, withAlpha('#ffffff', lit ? 0.3 : 0.12));
        c.text(q.label, q.w / 2, dy + q.h / 2 + 7, id === 'max' ? 17 : 20, lit ? '#2a1800' : '#e9edf2', { font: 'bold', align: 'center' });
    });
}
/* ---------- free spins, statistics ---------- */
/** the reel window's frame lit while free spins run: a pulse of pink and gold */
function drawFreeFrame(cv, now) {
    const k = 0.5 + 0.5 * Math.sin(now / 220);
    for (let i = 6; i >= 1; i--) cv.strokeRoundRect(WIN.x - 6 - i * 2, WIN.y - 6 - i * 2, WIN.w + 12 + i * 4, WIN.h + 12 + i * 4, 14 + i * 2, 2, withAlpha(mix('#ff3d7f', '#ffd36e', k), 0.09 * (7 - i)));
}
/** a ribbon on the window's bottom edge: what's on (free spins left, the multiplier) */
function drawRibbon(cv, text, color, now) {
    const w = 460, x = WIN.x + WIN.w / 2 - w / 2, y = WIN.y + WIN.h - 10, h = 44;
    cv.roundRect(x + 5, y + 7, w, h, h / 2, withAlpha('#000000', 0.5));
    cv.card(x, y, w, h, h / 2, [[0, '#a8701a'], [1, '#5a3a00']]);
    moulding(cv, x, y, w, h, h / 2, 5, GOLD);
    cv.card(x + 5, y + 5, w - 10, h - 10, (h - 10) / 2, [[0, '#3a0a4a'], [1, '#14031c']]);
    cv.text(text, x + w / 2, y + h / 2 + 8, 22, color, { font: 'bold', align: 'center', spacing: 2, literal: true });
}
/** a big announcement over the window: a title, a line under it, stars around */
function drawAnnounce(cv, title, sub, color, edge, a, now) {
    const cx = WIN.x + WIN.w / 2, cy = WIN.y + WIN.h / 2;
    cv.roundRect(WIN.x, WIN.y, WIN.w, WIN.h, 6, withAlpha('#000000', 0.55 * a));
    glow(cv, cx, cy, 280, color, 0.55 * a);
    cv.alpha(a);
    for (let i = 0; i < 10; i++) {
        const ang = i / 10 * Math.PI * 2 + now / 900, r = 230 + 20 * Math.sin(now / 200 + i);
        sparkle(cv, cx + Math.cos(ang) * r * 1.6, cy + Math.sin(ang) * r * 0.45, 10 + 4 * Math.sin(now / 150 + i * 2));
    }
    const s = 1 + 0.05 * Math.sin(now / 110);
    outlined(cv, title, cx, cy + 10, 70 * s, '#fff3c4', edge, 4, { spacing: 4, literal: true });
    if (sub) cv.text(sub, cx, cy + 60, 30, color, { font: 'bold', align: 'center', spacing: 2, literal: true });
    cv.alpha(1);
}
/** the statistics, on dark glass over the window: rows [label, value] in two columns, a footer */
function drawStats(cv, left, right, footer) {
    const { x, y, w, h } = WIN;
    cv.roundRect(x, y, w, h, 8, withAlpha('#06030a', 0.93));
    cv.strokeRoundRect(x + 6, y + 6, w - 12, h - 12, 8, 1.5, withAlpha('#ffd36e', 0.35));
    outlined(cv, 'STATISTICS', x + w / 2, y + 44, 30, '#fff3c4', '#a8701a', 1.5, { spacing: 4, shadow: false });
    const col = (rows, cx) => rows.forEach(([k, v, c], i) => {
        const ry = y + 92 + i * 34;
        cv.text(k, cx, ry, 18, withAlpha('#ffffff', 0.6), { font: 'bold', spacing: 1 });
        cv.text(v, cx + 430, ry, 22, c || '#ffffff', { font: 'num', align: 'right', literal: true });
        cv.fillRect(cx, ry + 10, 430, 1, withAlpha('#ffffff', 0.06));
    });
    col(left, x + 40);
    col(right, x + w / 2 + 25);
    cv.text(footer, x + w / 2, y + h - 18, 15, withAlpha('#ffffff', 0.45), { align: 'center' });
}

/** the domed SPIN button: lit (it can spin), dark (it can't: no credits, driving) or pressed */
function spinLayer(state) {
    const r = SPIN_BTN.r, S = 2 * r + 4;
    return lay('ls-spin|' + state, S, S, (c) => {
        const cx = S / 2, cy = S / 2 + (state === 'down' ? 2 : 0), rr = state === 'down' ? r - 2 : r;
        const dark = state === 'off';
        ball(c, cx, cy, rr, dark ? [[0, '#200004'], [0.5, '#4a0a12'], [1, '#6a2a30']] : [[0, '#4a0008'], [0.35, '#b0001a'], [0.75, '#ff2a3a'], [1, '#ff8a92']]);
        poly(c, ellipse(cx - rr * 0.12, cy - rr * 0.5, rr * 0.55, rr * 0.24), withAlpha('#ffffff', dark ? 0.12 : 0.3));
        poly(c, ellipse(cx - rr * 0.2, cy - rr * 0.55, rr * 0.25, rr * 0.09, -0.15), withAlpha('#ffffff', dark ? 0.3 : 0.75));
        outlined(c, 'SPIN', cx, cy + 12, 34, dark ? '#a08a8c' : '#fff6f6', '#5a0010', 2, { shadow: false });
    });
}

module.exports = {
    setTextScale, drawRoom,
    CAB, WIN, ROW_H, REEL_W, GAP, PANEL, LCD, BUTTONS, SPIN_BTN, BULBS, CABINETS, COIN_R, LINE_COLOURS,
    reelX, cellCentre, symbolLayer, blurLayer, bulbLayer, coinLayer, cabinetLayer, bandLayers, raysLayer, panelLayer, keyLayer, spinLayer,
    TITLE_PLATE, JP_PLATE, drawFreeFrame, drawRibbon, drawAnnounce, drawStats,
    drawDrum, drawDrumShade, drawGlass, drawCellFrame, drawPayline, outlined, glow, goldCard, moulding, GOLD, SYM, sparkle,
};
