'use strict';
/**
 * Pit Wall's look: a night race seen from the pit wall. Floodlights over a grandstand full of
 * camera flashes, glossy advertising panels (made-up sponsors: colour, gloss and a logo bar),
 * carbon panels with a metal rim that crack, fuel cans in hazard stripes, the ball with its light
 * trail, the M front wing that catches it, the start lights, the power-up capsules.
 *
 * Everything is drawn from rects, rounded rects, gradients, quads, arcs and lines (kit/record.js),
 * so the GPU renderer draws it every frame and the software path can still play it.
 */
const { withAlpha, mix } = require('./kit/canvas');

/** panel colours: [top, bottom, logo] */
const PALETTES = [
    ['#6cbcff', '#1660c4', '#e9f4ff'],      // M blue
    ['#ff6a6f', '#b80f19', '#ffe3e4'],      // race red
    ['#ffd36e', '#d98c00', '#3a2400'],      // gold
    ['#5ff0a6', '#0f8f52', '#e6fff1'],      // green
    ['#c99bff', '#6a33c4', '#f3eaff'],      // violet
    ['#f7f9fc', '#8e98a6', '#1b2330'],      // silver
];
const M_STRIPES = ['#81c4ff', '#16588e', '#e7222e'];
const POWER = {
    wide: { label: 'DRS', c: ['#7fd1ff', '#1c6fd1'] },
    split: { label: 'x3', c: ['#ffd36e', '#d98c00'] },
    turbo: { label: 'TURBO', c: ['#ff9a4d', '#d6300f'] },
    slow: { label: 'SLOW', c: ['#c99bff', '#6a33c4'] },
    life: { label: '+1', c: ['#5ff0a6', '#0f8f52'] },
};

// the crowd: fixed dots (no Math.random: the same stand every frame)
const CROWD = [];
for (let i = 0; i < 220; i++) {
    const h = Math.sin(i * 12.9898) * 43758.5453, f = h - Math.floor(h);
    const g = Math.sin(i * 78.233) * 12345.678, e = g - Math.floor(g);
    CROWD.push({ x: f, y: e, c: ['#ff6a6f', '#6cbcff', '#ffd36e', '#f7f9fc', '#5ff0a6'][i % 5], ph: i * 0.37 });
}

/** the scene behind the wall: sky, floodlights and their beams, the grandstand, the track */
function drawScene(cv, ox, oy, W, H, now) {
    cv.gradientRect(ox, oy, W, H, [[0, '#0d1528'], [0.55, '#070b16'], [1, '#04060a']]);
    // the grandstand: tiers, people, camera flashes
    const top = 24, bottom = 290;
    for (let k = 0; k < 6; k++) cv.fillRect(ox, oy + top + k * 44, W, 2, withAlpha('#ffffff', 0.035));
    for (const p of CROWD) {
        const flash = Math.sin(now / 900 + p.ph * 7) > 0.995;
        cv.fillRect(ox + p.x * W, oy + top + p.y * (bottom - top), flash ? 4 : 2.5, flash ? 4 : 2.5, flash ? '#ffffff' : withAlpha(p.c, 0.28));
    }
    // floodlights: a warm glow and a beam each
    for (const f of [0.12, 0.37, 0.63, 0.88]) {
        // (the glow's lower half only: nothing spills over the header, also where the clip isn't kept)
        const x = ox + f * W, y = oy + 6;
        cv.quad([[x - 10, y], [x + 10, y], [x + 150, y + H * 0.85], [x - 150, y + H * 0.85]], withAlpha('#fff4d6', 0.025));
        cv.arc(x, y, 0, 80, 90, 270, withAlpha('#fff4d6', 0.04));
        cv.arc(x, y, 0, 40, 90, 270, withAlpha('#fff4d6', 0.08));
        cv.arc(x, y, 0, 14, 90, 270, withAlpha('#fff8e6', 0.5));
        cv.roundRect(x - 22, y - 5, 44, 6, 3, '#d9dde4');
    }
    // the track under the wing: asphalt, a lane line, the M kerb
    const ty = oy + H - 22;
    cv.gradientRect(ox, ty - 40, W, 40, [[0, withAlpha('#ffffff', 0)], [1, withAlpha('#ffffff', 0.05)]]);
    for (let x = 0; x < W; x += 60) cv.fillRect(ox + x, ty - 6, 30, 2, withAlpha('#ffffff', 0.12));
    for (let x = 0, i = 0; x < W; x += 32, i++) cv.fillRect(ox + x, oy + H - 8, 32, 8, M_STRIPES[i % 3]);
}

/** one panel at its place; flash 0..1 right after a hit */
function drawPanel(cv, q, ox, oy, now, flash) {
    const x = ox + q.x - q.w / 2, y = oy + q.y - q.h / 2, w = q.w, h = q.h;
    cv.roundRect(x + 3, y + 4, w, h, 5, withAlpha('#000000', 0.45));                 // shadow on the stand
    if (q.kind === 'armor') {
        cv.card(x, y, w, h, 5, [[0, '#5a606b'], [0.45, '#33373f'], [1, '#1c1f24']]);
        for (let k = 0; k < 5; k++) cv.line(x + 8 + k * 12, y + h - 3, x + 8 + k * 12 + h - 6, y + 3, 1.5, withAlpha('#ffffff', 0.1));   // weave
        // a steel bar riveted across: armoured
        cv.roundRect(x + 6, y + h / 2 - 3, w - 12, 6, 3, withAlpha('#c9d0da', 0.55));
        for (const rx of [x + 9, x + w - 9]) cv.circle(rx, y + h / 2, 2.6, '#e9edf2');
        cv.strokeRoundRect(x + 1, y + 1, w - 2, h - 2, 5, 2, mix('#7d8694', '#d9dde4', 0.5 + 0.5 * Math.sin(now / 500 + q.c)));
        if (q.hp < q.maxHp) {
            // cracks
            cv.line(x + w * 0.3, y + 2, x + w * 0.45, y + h * 0.6, 1.5, withAlpha('#ffffff', 0.6));
            cv.line(x + w * 0.45, y + h * 0.6, x + w * 0.38, y + h - 2, 1.5, withAlpha('#ffffff', 0.6));
            if (q.hp < q.maxHp - 1) cv.line(x + w * 0.62, y + 3, x + w * 0.75, y + h - 3, 1.5, withAlpha('#ffffff', 0.6));
        }
    } else if (q.kind === 'fuel') {
        const glow = 0.5 + 0.5 * Math.sin(now / 160 + q.c);
        cv.roundRect(x - 4, y - 4, w + 8, h + 8, 8, withAlpha('#ff6a1a', 0.12 + 0.12 * glow));
        cv.card(x, y, w, h, 5, [[0, '#ff7a2e'], [1, '#b8280c']]);
        for (let k = 0; k < 5; k++) {
            const sx = x + 8 + k * 14;
            cv.quad([[sx, y + h - 4], [sx + 6, y + h - 4], [sx + 14, y + 4], [sx + 8, y + 4]], k % 2 ? '#1a1a1a' : '#ffd000');
        }
        cv.roundRect(x + w / 2 - 9, y + h / 2 - 6, 18, 12, 3, '#1a1a1a');
        cv.text('!', x + w / 2, y + h / 2 + 5, 14, '#ffd000', { font: 'bold', align: 'center' });
    } else {
        const p = PALETTES[q.hue % PALETTES.length];
        cv.card(x, y, w, h, 5, [[0, p[0]], [1, p[1]]]);
        cv.roundRect(x + 2, y + 2, w - 4, h * 0.42, 4, withAlpha('#ffffff', 0.22));      // gloss
        // a made-up sponsor: a mark and a word bar
        cv.circle(x + 14, y + h / 2 + 1, 5, p[2]);
        cv.roundRect(x + 24, y + h / 2 - 2, w - 36 - (q.c % 3) * 6, 5, 2.5, withAlpha(p[2], 0.85));
        cv.fillRect(x, y + h - 2, w, 2, withAlpha('#000000', 0.25));
    }
    if (flash > 0) cv.roundRect(x, y, w, h, 5, withAlpha('#ffffff', 0.7 * flash));
}

/** the ball and its light trail; turbo burns orange */
function drawBall(cv, b, ox, oy, turbo, now) {
    const tr = b.trail || [];
    for (let i = tr.length - 1; i >= 1; i--) {
        const k = 1 - i / tr.length;
        cv.circle(ox + tr[i].x, oy + tr[i].y, (turbo ? 9 : 6) * k + 1, withAlpha(turbo ? (i % 2 ? '#ffb020' : '#ff4d1a') : '#7fd1ff', (turbo ? 0.5 : 0.35) * k));
    }
    const x = ox + b.x, y = oy + b.y;
    cv.circle(x, y, 22, withAlpha(turbo ? '#ff6a1a' : '#7fd1ff', 0.12));
    cv.circle(x, y, 13, withAlpha(turbo ? '#ffb020' : '#bfe6ff', 0.3));
    cv.circle(x, y, 8, turbo ? '#fff1c9' : '#ffffff');
    cv.circle(x - 2.5, y - 2.5, 2.5, withAlpha('#ffffff', 0.9));
    if (turbo) cv.arc(x, y, 9, 11, (now / 3) % 360, (now / 3) % 360 + 120, '#ffd000');
}

/**
 * The M front wing, centred at (x, y), w wide: the main plane in carbon, a flap in M blue that
 * opens with DRS (wide), endplates, the nose in white with the stripes. hit 0..1 lights it up.
 */
function drawWing(cv, x, y, w, now, o) {
    o = o || {};
    const hw = w / 2, drs = !!o.drs, small = w < 80;
    if (!small) cv.roundRect(x - hw - 10, y + 6, w + 20, 14, 7, withAlpha(drs ? '#7fd1ff' : '#000000', drs ? 0.25 + 0.1 * Math.sin(now / 120) : 0.45));
    // main plane
    cv.quad([[x - hw, y + 6], [x + hw, y + 6], [x + hw - 6, y - 2], [x - hw + 6, y - 2]], '#20242b');
    if (!small) cv.fillRect(x - hw + 6, y - 2, w - 12, 1.5, withAlpha('#ffffff', 0.25));
    // the flap (lifted and lit with DRS)
    const fy = drs ? y - 10 : y - 6;
    cv.quad([[x - hw + 8, fy + 4], [x + hw - 8, fy + 4], [x + hw - 14, fy - 2], [x - hw + 14, fy - 2]], drs ? '#7fd1ff' : '#1c6fd1');
    if (drs && !small) for (const m of [-1, 1]) cv.line(x + m * hw * 0.5, y - 2, x + m * hw * 0.5, fy + 2, 2, '#9aa3ad');
    // endplates
    const ep = small ? 4 : 6;
    for (const m of [-1, 1]) {
        cv.roundRect(x + m * hw - (m > 0 ? ep : 0), y - 16, ep, 24, 2, '#f4f7fb');
        cv.fillRect(x + m * hw - (m > 0 ? ep : 0), y - 16, ep, 5, '#e7222e');
    }
    // the nose with the M stripes (narrower on a small wing)
    const nb = Math.min(16, w * 0.11), nt = nb * 0.62, sw = Math.min(2.5, w * 0.017);
    cv.quad([[x - nb, y + 8], [x + nb, y + 8], [x + nt, y - 14], [x - nt, y - 14]], '#f4f7fb');
    M_STRIPES.forEach((c, i) => cv.fillRect(x - sw * 1.8 + i * sw * 1.2, y - 14, sw, 22, c));
    if (o.hit > 0 && !small) cv.roundRect(x - hw - 4, y - 18, w + 8, 30, 10, withAlpha('#bfe6ff', 0.35 * o.hit));
}

/** the start lights over the field: n of five lit (0..5) */
function drawLights(cv, cx, y, n, now) {
    cv.roundRect(cx - 170, y, 340, 64, 12, '#0c0e12');
    cv.strokeRoundRect(cx - 170, y, 340, 64, 12, 2, '#2a2d33');
    for (let i = 0; i < 5; i++) {
        const lx = cx - 128 + i * 64, on = i < n;
        for (const ly of [y + 20, y + 44]) {
            if (on) cv.circle(lx, ly, 18, withAlpha('#ff1f1f', 0.22));
            cv.circle(lx, ly, 10, on ? '#ff2a2a' : '#25171a');
            if (on) cv.circle(lx - 3, ly - 3, 3, withAlpha('#ffffff', 0.7));
        }
    }
}

/** a power-up capsule, centred at (x, y), its shine sweeping across */
function drawPill(cv, x, y, kind, now) {
    const p = POWER[kind];
    cv.roundRect(x - 28, y - 14, 56, 28, 14, withAlpha(p.c[0], 0.25));
    cv.card(x - 24, y - 11, 48, 22, 11, [[0, p.c[0]], [1, p.c[1]]]);
    const s = ((now / 6) % 80) - 30;
    if (s > -22 && s < 18) cv.fillRect(x + s, y - 9, 4, 18, withAlpha('#ffffff', 0.35));
    cv.text(p.label, x, y + 6, p.label.length > 3 ? 13 : 16, '#ffffff', { font: 'bold', align: 'center' });
}

module.exports = { PALETTES, POWER, M_STRIPES, drawScene, drawPanel, drawBall, drawWing, drawLights, drawPill };
