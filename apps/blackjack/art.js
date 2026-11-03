'use strict';
/**
 * Blackjack's look: a casino table seen from the player's seat. Felt lit from above, a padded leather
 * rail along its curved edge, the table's printing in gold along the arc, the dealer's chip rack, the
 * shoe and the discard tray; cards with real pips (suits drawn as shapes), court cards in a gold frame,
 * a lattice back; casino chips in perspective with edge spots; a control panel with LCD read-outs.
 *
 * Everything is drawn from rects, rounded rects, gradients, quads, arcs, lines and text
 * (kit/record.js). What doesn't change is drawn once into cached layers (the table, every card face
 * and the back, every chip, the panel, the keys), so a frame is mostly layer blits.
 */
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');

let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const TABLE = { x: 24, y: 46, w: 1116, h: 462 };
const ARC = { cx: TABLE.x + TABLE.w / 2, cy: 508 - 2400, r: 2400, rail: 36 };     // the curved edge: a big circle's bottom
const CARD = { w: 92, h: 128, r: 8 };
const DEALER = { x: ARC.cx, y: 76 };                     // the dealer's cards: centre x, top
const PLAYER_Y = 302;                                    // the player's cards: top of the first one
const SHOE = { x: TABLE.x + TABLE.w - 150, y: 52, w: 116, h: 92 };
const DISCARD = { x: TABLE.x + 40, y: 56, w: 104, h: 84 };
const RACK = { x: ARC.cx - 210, y: 47, w: 420, h: 24 };
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const DEAL_BTN = { x: PANEL.x + 322, y: 446, r: 44 };
const FELTS = {
    green: ['#1c8a4e', '#0b5d33', '#03301a'],
    blue: ['#1d5f9c', '#0b3d6b', '#041d36'],
    red: ['#9c1d2e', '#6b0b1a', '#33040b'],
    black: ['#3a3a42', '#1e1e22', '#0a0a0c'],
};
const RED = '#c8102e', BLACK = '#15151a';

/** the y of the table's curved edge (the rail's outer side) at x */
const edgeY = (x) => ARC.cy + Math.sqrt(ARC.r * ARC.r - (x - ARC.cx) * (x - ARC.cx));

/* ---------- light and material helpers (as Lucky Sevens) ---------- */
function gradAt(stops, t) {
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
    return mix(a[1], b[1], b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))));
}
/** a filled convex polygon as a fan of quads (the recorder draws quads only); opaque ones overlap a little */
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
function ellipse(cx, cy, rx, ry, n) {
    n = n || 32;
    const p = [];
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    return p;
}
function ball(cv, cx, cy, r, stops, lx, ly) {
    lx = lx === undefined ? -0.35 : lx; ly = ly === undefined ? -0.4 : ly;
    const n = Math.max(8, Math.min(24, Math.round(r * 0.6)));
    for (let i = 0; i <= n; i++) { const t = i / n; cv.circle(cx + lx * r * t * 0.9, cy + ly * r * t * 0.9, Math.max(0.6, r * (1 - t)), gradAt(stops, t)); }
}
function glow(cv, cx, cy, r, c, a) { for (let i = 6; i >= 1; i--) cv.circle(cx, cy, r * i / 6, withAlpha(c, a * (1 - i / 7) * 0.4)); }
function outlined(cv, s, x, y, size, fill, edge, ew, o) {
    o = Object.assign({ font: 'bold', align: 'center' }, o || {});
    if (o.shadow !== false) for (let k = 1; k <= 3; k++) cv.text(s, x + k, y + k * 1.3, size, withAlpha('#000000', 0.25), o);
    for (let a = 0; a < 12; a++) cv.text(s, x + Math.cos(a / 12 * 6.283) * ew, y + Math.sin(a / 12 * 6.283) * ew, size, edge, o);
    cv.text(s, x, y, size, fill, o);
}
function moulding(cv, x, y, w, h, r, width, profile) {
    for (let k = 0; k < width; k++) cv.strokeRoundRect(x + k, y + k, w - 2 * k, h - 2 * k, Math.max(2, r - k), 1.6, gradAt(profile, k / (width - 1)));
}
const GOLD = [[0, '#3a2200'], [0.12, '#a8701a'], [0.3, '#ffe9a8'], [0.42, '#f1c45a'], [0.7, '#8a5a0a'], [0.88, '#d9a23b'], [1, '#2a1800']];
const CHROME = [[0, '#22252b'], [0.2, '#8a919c'], [0.4, '#ffffff'], [0.6, '#9aa2ae'], [0.85, '#3b4049'], [1, '#111216']];
const LEATHER = [[0, '#0e0705'], [0.15, '#3a1f12'], [0.4, '#6a3a22'], [0.55, '#8a5634'], [0.7, '#5a3019'], [1, '#120806']];
/* ---------- the table (a cached layer) ---------- */
function drawTable(c, felt) {
    const f = FELTS[felt] || FELTS.green, ox = -TABLE.x, oy = -TABLE.y;
    const pts = [[TABLE.x, TABLE.y], [TABLE.x + TABLE.w, TABLE.y]];
    for (let i = 0; i <= 40; i++) { const x = TABLE.x + TABLE.w - i * TABLE.w / 40; pts.push([x, edgeY(x)]); }
    const P = (k) => pts.map(([x, y]) => [x + ox, y + oy]);
    // the felt: darker toward its edges, lit from above its middle
    poly(c, P(), f[2]);
    for (let k = 1; k <= 36; k++) {
        const s = 1 - k * 0.018, cx = ARC.cx + ox, cy = TABLE.y + 150 + oy;
        poly(c, P().map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s * 0.92]), gradAt([[0, f[2]], [0.45, f[1]], [1, f[0]]], k / 36));
    }
    // the felt's weave: faint lines
    for (let y = 2; y < TABLE.h; y += 4) c.fillRect(0, y, TABLE.w, 1, withAlpha('#000000', 0.035));
    // shadow of the rail on the felt, the rail (padded leather) and its stitching
    const half = Math.asin((TABLE.w / 2 + 40) / ARC.r) * 180 / Math.PI;
    for (let k = 0; k < 10; k++) c.arc(ARC.cx + ox, ARC.cy + oy, ARC.r - ARC.rail - 12 + k, ARC.r - ARC.rail - 11 + k, 180 - half, 180 + half, withAlpha('#000000', 0.03 * k));
    for (let k = 0; k < ARC.rail; k++) c.arc(ARC.cx + ox, ARC.cy + oy, ARC.r - ARC.rail + k, ARC.r - ARC.rail + k + 1.3, 180 - half, 180 + half, gradAt(LEATHER, k / (ARC.rail - 1)));
    c.arc(ARC.cx + ox, ARC.cy + oy, ARC.r - ARC.rail - 3, ARC.r - ARC.rail, 180 - half, 180 + half, '#c9a24a');     // brass edge
    for (let a = 180 - half; a < 180 + half; a += 0.18) c.arc(ARC.cx + ox, ARC.cy + oy, ARC.r - ARC.rail / 2 - 0.8, ARC.r - ARC.rail / 2 + 0.8, a, a + 0.09, withAlpha('#d9b48a', 0.35));
    // the printing: gold lines and texts along the arc
    const gold = '#e8c25a', soft = withAlpha('#f4ead0', 0.7);
    // (from the top: insurance, a line, the dealer's rule, the pay, a line; y at the middle = 508 - d)
    arcTextAt(c, ox, oy, 'INSURANCE PAYS 2 TO 1', ARC.r - 284, 12, withAlpha(gold, 0.8), 3);
    arcLineAt(c, ox, oy, ARC.r - 276, 2, withAlpha(gold, 0.7));
    arcTextAt(c, ox, oy, 'DEALER MUST STAND ON 17 AND DRAW TO 16', ARC.r - 256, 14, soft, 3);
    arcTextAt(c, ox, oy, 'BLACKJACK PAYS 3 TO 2', ARC.r - 226, 23, gold, 5);
    arcLineAt(c, ox, oy, ARC.r - 214, 2, withAlpha(gold, 0.7));
    // the dealer's chip rack: columns of chips seen edge on, in a dark tray
    const rx = RACK.x + ox, ry = RACK.y + oy;
    c.roundRect(rx - 4, ry - 2, RACK.w + 8, RACK.h + 8, 6, withAlpha('#000000', 0.5));
    c.card(rx, ry, RACK.w, RACK.h, 4, [[0, '#1a1a1e'], [1, '#2c2c32']]);
    const cols = ['#d4233a', '#1f5fd1', '#169b4f', '#e07a12', '#1b1b1f', '#7a2bd1', '#d4233a', '#169b4f', '#1f5fd1', '#1b1b1f'];
    for (let i = 0; i < cols.length; i++) {
        const x = rx + 8 + i * 40.5;
        c.roundRect(x, ry + 3, 34, RACK.h - 4, 3, cols[i]);
        for (let k = 0; k < 7; k++) c.fillRect(x + 2 + k * 5, ry + 3, 1, RACK.h - 4, withAlpha(k % 2 ? '#000000' : '#ffffff', 0.25));
        c.gradientRect(x, ry + 3, 34, RACK.h - 4, [[0, withAlpha('#ffffff', 0.25)], [0.5, withAlpha('#ffffff', 0)], [1, withAlpha('#000000', 0.35)]]);
    }
    // the shoe: a dark box, the cards' edges inside, a brass mouth
    const sx = SHOE.x + ox, sy = SHOE.y + oy;
    c.roundRect(sx + 5, sy + 8, SHOE.w, SHOE.h, 10, withAlpha('#000000', 0.5));
    c.card(sx, sy, SHOE.w, SHOE.h, 10, [[0, '#3a3a40'], [0.5, '#1c1c20'], [1, '#0c0c0e']]);
    for (let k = 0; k < 14; k++) c.fillRect(sx + 14 + k * 2.2, sy + 12, 1.4, SHOE.h - 30, k % 2 ? '#e9e4d8' : '#b9b3a6');
    c.card(sx + 48, sy + 10, SHOE.w - 58, SHOE.h - 26, 6, [[0, '#8a1020'], [1, '#4a0610']]);       // the next card's back
    c.roundRect(sx + 44, sy + SHOE.h - 18, SHOE.w - 50, 10, 4, '#c9a24a');
    c.text('SHOE', sx + SHOE.w / 2, sy + SHOE.h + 16, 12, withAlpha('#ffffff', 0.35), { font: 'bold', align: 'center', spacing: 3 });
    // the discard tray
    const dx = DISCARD.x + ox, dy = DISCARD.y + oy;
    c.roundRect(dx + 4, dy + 6, DISCARD.w, DISCARD.h, 8, withAlpha('#000000', 0.4));
    c.card(dx, dy, DISCARD.w, DISCARD.h, 8, [[0, '#26262c'], [1, '#101014']]);
    c.strokeRoundRect(dx + 6, dy + 6, DISCARD.w - 12, DISCARD.h - 12, 5, 1.5, withAlpha('#ffffff', 0.12));
}
function arcLineAt(c, ox, oy, r, width, color) {
    const half = Math.asin((TABLE.w / 2 - 60) / r) * 180 / Math.PI;
    c.arc(ARC.cx + ox, ARC.cy + oy, r - width / 2, r + width / 2, 180 - half, 180 + half, color);
}
function arcTextAt(c, ox, oy, s, r, size, color, spacing) {
    const o = { font: 'bold', literal: true };
    let w = 0;
    for (const ch of s) w += c.textWidth(ch, size, o) + spacing;
    let x0 = ARC.cx - (w - spacing) / 2;
    for (const ch of s) {
        const cw = c.textWidth(ch, size, o), x = x0 + cw / 2, y = ARC.cy + Math.sqrt(r * r - (x - ARC.cx) * (x - ARC.cx));
        c.text(ch, x + ox, y + oy, size, color, { font: 'bold', align: 'center', literal: true });
        x0 += cw + spacing;
    }
}
function tableLayer(felt) { return lay('bj-table|' + felt, TABLE.w, TABLE.h, (c) => drawTable(c, felt)); }

/* ---------- suits and cards ---------- */
function suit(cv, s, cx, cy, size, color) {
    const k = size;
    if (s === 'H') {
        cv.circle(cx - 0.25 * k, cy - 0.12 * k, 0.27 * k, color);
        cv.circle(cx + 0.25 * k, cy - 0.12 * k, 0.27 * k, color);
        poly(cv, [[cx - 0.515 * k, cy - 0.04 * k], [cx + 0.515 * k, cy - 0.04 * k], [cx, cy + 0.56 * k]], color);
    } else if (s === 'D') {
        poly(cv, [[cx, cy - 0.56 * k], [cx + 0.42 * k, cy], [cx, cy + 0.56 * k], [cx - 0.42 * k, cy]], color);
    } else if (s === 'S') {
        cv.circle(cx - 0.25 * k, cy + 0.1 * k, 0.26 * k, color);
        cv.circle(cx + 0.25 * k, cy + 0.1 * k, 0.26 * k, color);
        poly(cv, [[cx - 0.5 * k, cy + 0.04 * k], [cx + 0.5 * k, cy + 0.04 * k], [cx, cy - 0.56 * k]], color);
        poly(cv, [[cx - 0.05 * k, cy + 0.15 * k], [cx + 0.05 * k, cy + 0.15 * k], [cx + 0.18 * k, cy + 0.56 * k], [cx - 0.18 * k, cy + 0.56 * k]], color);
    } else {
        cv.circle(cx, cy - 0.25 * k, 0.23 * k, color);
        cv.circle(cx - 0.26 * k, cy + 0.08 * k, 0.23 * k, color);
        cv.circle(cx + 0.26 * k, cy + 0.08 * k, 0.23 * k, color);
        cv.circle(cx, cy, 0.14 * k, color);
        poly(cv, [[cx - 0.05 * k, cy + 0.05 * k], [cx + 0.05 * k, cy + 0.05 * k], [cx + 0.18 * k, cy + 0.56 * k], [cx - 0.18 * k, cy + 0.56 * k]], color);
    }
}
const suitColor = (s) => (s === 'H' || s === 'D' ? RED : BLACK);
// pip positions on a card (fractions of the pip area), per rank
const PIPS = {
    2: [[0.5, 0], [0.5, 1]], 3: [[0.5, 0], [0.5, 0.5], [0.5, 1]],
    4: [[0, 0], [1, 0], [0, 1], [1, 1]], 5: [[0, 0], [1, 0], [0.5, 0.5], [0, 1], [1, 1]],
    6: [[0, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [1, 1]], 7: [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
    8: [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0.5, 0.75], [0, 1], [1, 1]],
    9: [[0, 0], [1, 0], [0, 1 / 3], [1, 1 / 3], [0.5, 0.5], [0, 2 / 3], [1, 2 / 3], [0, 1], [1, 1]],
    10: [[0, 0], [1, 0], [0.5, 1 / 6], [0, 1 / 3], [1, 1 / 3], [0, 2 / 3], [1, 2 / 3], [0.5, 5 / 6], [0, 1], [1, 1]],
};
function cardBase(c, w, h) {
    c.roundRect(2, 3, w, h, CARD.r, withAlpha('#000000', 0.35));
    c.card(0, 0, w, h, CARD.r, [[0, '#ffffff'], [0.6, '#f7f5ef'], [1, '#e9e5da']]);
    c.strokeRoundRect(0, 0, w, h, CARD.r, 1, withAlpha('#000000', 0.25));
}
function drawFace(c, card) {
    const w = CARD.w, h = CARD.h, col = suitColor(card.s);
    cardBase(c, w, h);
    // the corners: rank and a small suit (the bottom one upright too: text doesn't turn here)
    const rk = card.r, rs = rk === '10' ? 22 : 24;
    c.text(rk, 13, 27, rs, col, { font: 'bold', align: 'center', literal: true });
    suit(c, card.s, 13, 40, 12, col);
    c.text(rk, w - 13, h - 18, rs, col, { font: 'bold', align: 'center', literal: true });
    suit(c, card.s, w - 13, h - 33, 12, col);
    const n = Number(rk);
    if (n >= 2 && n <= 10) {
        const x0 = 32, x1 = w - 32, y0 = 24, y1 = h - 24, ps = n >= 9 ? 17 : 19;
        for (const [fx, fy] of PIPS[n]) suit(c, card.s, x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy, ps, col);
    } else if (rk === 'A') {
        suit(c, card.s, w / 2, h / 2, 46, col);
        if (card.s === 'S') { c.circle(w / 2, h / 2 + 2, 4, '#ffffff'); }
    } else {
        // court cards: a gold frame, the letter with a crown, suits in its corners
        const fx = 22, fy = 22, fw = w - 44, fh = h - 44;
        c.card(fx, fy, fw, fh, 4, [[0, mix(col, '#ffffff', 0.85)], [1, mix(col, '#ffffff', 0.7)]]);
        c.strokeRoundRect(fx, fy, fw, fh, 4, 2, '#c9a24a');
        c.strokeRoundRect(fx + 4, fy + 4, fw - 8, fh - 8, 3, 1, withAlpha('#c9a24a', 0.7));
        // the crown
        const cx = w / 2, cy = fy + 26;
        poly(c, [[cx - 16, cy + 8], [cx + 16, cy + 8], [cx + 18, cy - 8], [cx - 18, cy - 8]], '#e2b33c');
        for (const dx of [-18, 0, 18]) { poly(c, [[cx + dx - 6, cy - 6], [cx + dx + 6, cy - 6], [cx + dx, cy - 18]], '#e2b33c'); c.circle(cx + dx, cy - 18, 3, '#e2b33c'); }
        c.fillRect(cx - 16, cy + 1, 32, 3, mix(col, '#000000', 0.2));
        c.circle(cx, cy - 1, 2.5, '#ffffff');
        c.text(rk, cx, fy + fh - 18, 36, col, { font: 'bold', align: 'center', literal: true });
        suit(c, card.s, fx + 10, fy + fh - 12, 9, col);
        suit(c, card.s, fx + fw - 10, fy + fh - 12, 9, col);
    }
}
function drawBack(c, w, h, colour) {
    const b = colour === 'blue' ? ['#1f4fa8', '#0c2a66'] : ['#a3132a', '#5c0714'];
    c.roundRect(2, 3, w, h, CARD.r, withAlpha('#000000', 0.35));
    c.card(0, 0, w, h, CARD.r, [[0, '#ffffff'], [1, '#ece8de']]);
    c.card(6, 6, w - 12, h - 12, 5, [[0, b[0]], [1, b[1]]]);
    // the lattice
    const iw = w - 12, ih = h - 12;
    for (let k = -ih; k < iw; k += 9) {
        const x0 = Math.max(0, k), y0 = x0 - k, x1 = Math.min(iw, k + ih), y1 = x1 - k;
        c.line(6 + x0, 6 + y0, 6 + x1, 6 + y1, 1, withAlpha('#ffffff', 0.12));
    }
    for (let k = 0; k < w + h; k += 9) {
        const x0 = Math.min(w - 12, k), y0 = Math.max(0, k - (w - 12)), x1 = Math.max(0, k - (h - 12)), y1 = Math.min(h - 12, k);
        c.line(6 + x0, 6 + y0, 6 + x1, 6 + y1, 1, withAlpha('#ffffff', 0.12));
    }
    c.strokeRoundRect(10, 10, w - 20, h - 20, 4, 1.5, withAlpha('#ffffff', 0.5));
    // the emblem
    poly(c, ellipse(w / 2, h / 2, 18, 24), '#e2b33c');
    poly(c, ellipse(w / 2, h / 2, 14, 20), b[1]);
    suit(c, 'S', w / 2, h / 2, 18, '#e2b33c');
    c.roundRect(4, 2, w - 8, 10, 5, withAlpha('#ffffff', 0.08));
}
const cardKey = (card) => card.r + card.s;
function cardLayer(card) { return lay('bj-card|' + cardKey(card), CARD.w + 4, CARD.h + 5, (c) => drawFace(c, card)); }
function backLayer(colour) { return lay('bj-back|' + colour, CARD.w + 4, CARD.h + 5, (c) => drawBack(c, CARD.w, CARD.h, colour)); }
/** a card turning over: k 0..1, the back narrowing to its edge then the face widening (drawn, not cached) */
function drawFlip(cv, card, x, y, k, colour) {
    const w = CARD.w * Math.abs(Math.cos(k * Math.PI)), cx = x + CARD.w / 2;
    if (w < 2) return;
    if (k < 0.5) {
        const b = colour === 'blue' ? ['#1f4fa8', '#0c2a66'] : ['#a3132a', '#5c0714'];
        cv.card(cx - w / 2, y, w, CARD.h, Math.min(CARD.r, w / 2), [[0, '#ffffff'], [1, '#ece8de']]);
        if (w > 14) cv.card(cx - w / 2 + 6 * w / CARD.w, y + 6, w - 12 * w / CARD.w, CARD.h - 12, 4, [[0, b[0]], [1, b[1]]]);
    } else {
        cv.card(cx - w / 2, y, w, CARD.h, Math.min(CARD.r, w / 2), [[0, '#ffffff'], [0.6, '#f7f5ef'], [1, '#e9e5da']]);
        if (w > CARD.w * 0.85) cv.blit(cardLayer(card), x, y);
    }
}

/* ---------- chips ---------- */
const CHIPS = [
    { v: 500, c: '#7a2bd1', e: '#f1e6ff' }, { v: 100, c: '#1b1b1f', e: '#e9e9e9' }, { v: 50, c: '#e07a12', e: '#fff3e0' },
    { v: 25, c: '#169b4f', e: '#e8fff1' }, { v: 10, c: '#1f5fd1', e: '#e6efff' }, { v: 5, c: '#d4233a', e: '#ffe9ec' },
];
const CHIP = { r: 24, t: 0.46, side: 6 };                // radius, ellipse ratio, edge thickness
/** a chip seen from the seat: an ellipse with its edge, spots round the rim, an inlay with its value */
function chipLayer(v) {
    const d = CHIPS.find((q) => q.v === v) || CHIPS[CHIPS.length - 1];
    const W = 2 * CHIP.r + 8, H = 2 * CHIP.r * CHIP.t + CHIP.side + 8;
    return lay('bj-chip|' + v, W, H, (c) => {
        const cx = W / 2, cy = CHIP.r * CHIP.t + 3, R = CHIP.r, t = CHIP.t;
        poly(c, ellipse(cx + 2, cy + CHIP.side + 2, R, R * t), withAlpha('#000000', 0.3));
        for (let k = CHIP.side; k >= 1; k--) poly(c, ellipse(cx, cy + k, R, R * t), mix(d.c, '#000000', 0.45));
        // the edge's spots, on the side
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI;                                  // the front half only
            const x = cx + Math.cos(a) * R * 0.92, y = cy + Math.sin(a) * R * t;
            c.fillRect(x - 3, y + 1, 6, CHIP.side - 1, withAlpha(d.e, 0.85));
        }
        poly(c, ellipse(cx, cy, R, R * t), d.c);
        for (let i = 0; i < 8; i++) {
            const a0 = i / 8 * Math.PI * 2, a1 = a0 + 0.28;
            const P = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r * t];
            c.quad([P(a0, R * 0.98), P(a1, R * 0.98), P(a1, R * 0.74), P(a0, R * 0.74)], d.e);
        }
        poly(c, ellipse(cx, cy, R * 0.66, R * 0.66 * t), mix(d.c, '#ffffff', 0.12));
        poly(c, ellipse(cx, cy, R * 0.6, R * 0.6 * t), d.e);
        c.text(String(v), cx, cy + 5, v >= 100 ? 12 : 13, d.c, { font: 'bold', align: 'center', literal: true });
        poly(c, ellipse(cx - R * 0.3, cy - R * t * 0.45, R * 0.3, R * t * 0.18), withAlpha('#ffffff', 0.25));
    });
}
/** chips making up an amount, largest first (at most `max`) */
function chipsFor(amount, max) {
    const out = [];
    let left = amount;
    for (const d of CHIPS) while (left >= d.v && out.length < (max || 12)) { out.push(d.v); left -= d.v; }
    return out;
}
/** a stack of chips standing at (x, y) = the bottom chip's centre */
function drawStack(cv, amount, x, y) {
    const list = chipsFor(amount, 10);
    list.forEach((v, i) => cv.blit(chipLayer(v), x - CHIP.r - 4, y - CHIP.r * CHIP.t - 3 - i * CHIP.side));
}

/* ---------- labels on the felt ---------- */
/** a hand's total in a dark pill (gold when 21, red when bust) */
function drawTotal(cv, x, y, label, kind) {
    const w = Math.max(44, cv.textWidth(label, 18, { font: 'bold', literal: true }) + 24), h = 28;
    const bg = kind === 'bust' ? '#7a0a14' : kind === 'best' ? '#7a5a0a' : '#0c0f12';
    cv.roundRect(x - w / 2 + 2, y + 3, w, h, h / 2, withAlpha('#000000', 0.45));
    cv.roundRect(x - w / 2, y, w, h, h / 2, withAlpha(bg, 0.92));
    cv.strokeRoundRect(x - w / 2, y, w, h, h / 2, 1.5, kind === 'best' ? '#ffd36e' : withAlpha('#ffffff', 0.35));
    cv.text(label, x, y + 20, 18, kind === 'best' ? '#ffe9a8' : '#ffffff', { font: 'bold', align: 'center', literal: true });
}
/** a result on a hand: WIN, BLACKJACK, PUSH, BUST, LOSE with what it paid */
const RESULT = { win: ['WIN', '#5ff0a6'], blackjack: ['BLACKJACK', '#ffd36e'], push: ['PUSH', '#7fd1ff'], bust: ['BUST', '#ff5a6a'], lose: ['LOSE', '#ff8a8a'] };
function drawResult(cv, x, y, result, amount, a) {
    const [label, col] = RESULT[result];
    const text = amount > 0 && result !== 'push' ? label + '  +' + amount : label;
    const w = cv.textWidth(text, 22, { font: 'bold', literal: true }) + 36, h = 38;
    cv.alpha(a);
    cv.roundRect(x - w / 2 + 3, y + 4, w, h, h / 2, withAlpha('#000000', 0.5));
    cv.card(x - w / 2, y, w, h, h / 2, [[0, '#24242c'], [1, '#0c0c10']]);
    cv.strokeRoundRect(x - w / 2, y, w, h, h / 2, 2, col);
    cv.text(text, x, y + 27, 22, col, { font: 'bold', align: 'center', spacing: 1.5, literal: true });
    cv.alpha(1);
}
function sparkle(cv, x, y, r, c) {
    poly(cv, [[x, y - r], [x + r * 0.22, y], [x, y + r], [x - r * 0.22, y]], c || '#ffffff');
    poly(cv, [[x - r, y], [x, y - r * 0.22], [x + r, y], [x, y + r * 0.22]], c || '#ffffff');
}

/* ---------- the panel ---------- */
const LCD = {
    credit: { x: PANEL.x + 24, y: PANEL.y + 46, w: PANEL.w - 48, label: 'CREDIT', color: '#5ff0a6' },
    bet: { x: PANEL.x + 24, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'BET', color: '#ffd36e' },
    win: { x: PANEL.x + 36 + (PANEL.w - 60) / 2, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'WIN', color: '#ff8ac0' },
};
// the four keys: their labels change with the moment (bet / insurance / play)
const KEYS = [
    { x: PANEL.x + 24, y: PANEL.y + 236, w: 178, h: 50 },
    { x: PANEL.x + 214, y: PANEL.y + 236, w: 178, h: 50 },
    { x: PANEL.x + 24, y: PANEL.y + 298, w: 178, h: 50 },
    { x: PANEL.x + 214, y: PANEL.y + 298, w: 178, h: 50 },
];
function panelLayer() {
    return lay('bj-panel', PANEL.w, PANEL.h, (c) => {
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
        const sx = DEAL_BTN.x + ox, sy = DEAL_BTN.y + oy, r = DEAL_BTN.r;
        c.circle(sx + 4, sy + 7, r + 9, withAlpha('#000000', 0.6));
        ball(c, sx, sy, r + 9, [[0, '#2b2f36'], [0.4, '#8a919c'], [0.8, '#e2e6ec'], [1, '#ffffff']], 0.2, 0.3);
        c.circle(sx, sy, r + 1, '#04140a');
    });
}
/** a key: its label, up / lit (the advice, a choice) / pressed / off (not now) */
function keyLayer(i, label, state) {
    const q = KEYS[i];
    return lay('bj-key|' + i + '|' + label + '|' + state, q.w + 6, q.h + 8, (c) => {
        const down = state === 'down', lit = state === 'lit', off = state === 'off', dy = down ? 3 : 0;
        if (!down) c.roundRect(2, 5, q.w, q.h, 12, withAlpha('#000000', 0.6));
        c.card(0, dy, q.w, q.h, 12, lit ? [[0, '#ffe08a'], [0.5, '#d98c00'], [1, '#8a5a0a']] : off ? [[0, '#2a2c32'], [1, '#16171b']] : [[0, '#5a5f6b'], [0.5, '#2c2f36'], [1, '#1a1c21']]);
        c.roundRect(3, dy + 2, q.w - 6, q.h * 0.36, 8, withAlpha('#ffffff', lit ? 0.3 : off ? 0.04 : 0.12));
        c.text(label, q.w / 2, dy + q.h / 2 + 7, 20, lit ? '#2a1800' : off ? '#5a5d66' : '#e9edf2', { font: 'bold', align: 'center' });
    });
}
/** the round button: DEAL (green), lit or dark, or pressed */
function dealLayer(label, state) {
    const r = DEAL_BTN.r, S = 2 * r + 4;
    return lay('bj-deal|' + label + '|' + state, S, S, (c) => {
        const cx = S / 2, cy = S / 2 + (state === 'down' ? 2 : 0), rr = state === 'down' ? r - 2 : r, dark = state === 'off';
        ball(c, cx, cy, rr, dark ? [[0, '#021006'], [0.5, '#0a2a14'], [1, '#24402c']] : [[0, '#003a14'], [0.35, '#0a8a3a'], [0.75, '#2ad46a'], [1, '#9affc0']]);
        poly(c, ellipse(cx - rr * 0.12, cy - rr * 0.5, rr * 0.55, rr * 0.24), withAlpha('#ffffff', dark ? 0.1 : 0.3));
        poly(c, ellipse(cx - rr * 0.2, cy - rr * 0.55, rr * 0.25, rr * 0.09), withAlpha('#ffffff', dark ? 0.25 : 0.75));
        outlined(c, label, cx, cy + 9, 24, dark ? '#7a9a84' : '#f4fff8', '#003a14', 1.6, { shadow: false });
    });
}
/** the statistics, on dark glass over the felt */
function drawStats(cv, left, right, footer) {
    const x = TABLE.x + 40, y = 70, w = TABLE.w - 80, h = 340;
    cv.roundRect(x, y, w, h, 12, withAlpha('#06030a', 0.93));
    cv.strokeRoundRect(x + 6, y + 6, w - 12, h - 12, 9, 1.5, withAlpha('#ffd36e', 0.35));
    outlined(cv, 'STATISTICS', x + w / 2, y + 46, 30, '#fff3c4', '#a8701a', 1.5, { spacing: 4, shadow: false });
    const col = (rows, cx) => rows.forEach(([k, v, c], i) => {
        const ry = y + 96 + i * 38;
        cv.text(k, cx, ry, 18, withAlpha('#ffffff', 0.6), { font: 'bold', spacing: 1 });
        cv.text(v, cx + 440, ry, 22, c || '#ffffff', { font: 'num', align: 'right', literal: true });
        cv.fillRect(cx, ry + 11, 440, 1, withAlpha('#ffffff', 0.06));
    });
    col(left, x + 40);
    col(right, x + w / 2 + 20);
    cv.text(footer, x + w / 2, y + h - 18, 15, withAlpha('#ffffff', 0.45), { align: 'center' });
}

module.exports = {
    setTextScale, TABLE, ARC, CARD, DEALER, PLAYER_Y, SHOE, DISCARD, PANEL, LCD, KEYS, DEAL_BTN, FELTS, CHIP,
    edgeY, tableLayer, cardLayer, backLayer, drawFlip, chipLayer, chipsFor, drawStack, drawTotal, drawResult, sparkle,
    panelLayer, keyLayer, dealLayer, drawStats, glow, outlined, moulding, GOLD, suit, poly, ellipse, drawFace, drawBack,
};
