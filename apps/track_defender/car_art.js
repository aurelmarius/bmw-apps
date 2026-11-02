'use strict';
/**
 * The player's M car, seen from behind as it drives up the track: wide shoulders, a low glasshouse,
 * L-shaped tail lights, a diffuser with four exhausts, the M stripes over roof and boot lid - and a
 * gun on the roof. Drawn from quads, gradients and rounded rects at any scale (the lives in the
 * side panel are small ones), so it looks the same on the GPU and the software path.
 *
 *   drawM(cv, x, y, s, { lean, firing, double, spin })
 *     x, y   the car's centre (the model's player position); s the scale (1: 66 px wide)
 *     lean   -1..1: the body rolls towards where the car is heading
 *     firing 0..1: muzzle flash on the roof gun
 *     double the two extra guns on the spoiler (double fire)
 *     spin   tyre tread phase (moves while the car does)
 */
const { withAlpha } = require('./kit/canvas');

const PAINT = ['#ffffff', '#dfe4ea', '#a9b1bc'];     // Alpine white, lit from above
const GLASS = '#18202c', TRIM = '#232830', TYRE = '#0c0e11';
const STRIPES = ['#81c4ff', '#16588e', '#e7222e'];
const LIGHT = '#e3121d', GOLD = '#ffb020';

function drawM(cv, x, y, s, o) {
    o = o || {};
    const l = (o.lean || 0) * 2.5;
    const X = (v) => x + v * s, Y = (v) => y + v * s;
    const q = (pts, c) => cv.quad(pts.map(([a, b]) => [X(a), Y(b)]), c);
    const rr = (a, b, w, h, r, c) => cv.roundRect(X(a), Y(b), w * s, h * s, r * s, c);
    const small = s < 0.6;

    // shadow on the track
    rr(-35, 14, 70, 8, 4, withAlpha('#000000', 0.45));
    // tyres, tread moving as it drives
    for (const tx of [-31, 18]) {
        rr(tx, 3, 13, 16, 3, TYRE);
        if (!small) for (let k = 0; k < 3; k++) cv.fillRect(X(tx + 2), Y(5 + ((k * 5 + (o.spin || 0)) % 14)), 9 * s, 1.5 * s, withAlpha('#ffffff', 0.12));
    }
    // body: bumper and rear quarters, boot lid, shoulders
    cv.card(X(-34), Y(-5), 68 * s, 19 * s, 7 * s, [[0, PAINT[0]], [0.55, PAINT[1]], [1, PAINT[2]]]);
    q([[-33, -4], [33, -4], [27, -13], [-27, -13]], PAINT[1]);
    q([[-27 + l, -13], [27 + l, -13], [25 + l, -15], [-25 + l, -15]], PAINT[0]);
    // glasshouse: body-coloured C-pillars, the rear window set in, a low roof
    const r = l * 1.6;
    q([[-23 + l, -15], [23 + l, -15], [13 + r, -26], [-13 + r, -26]], PAINT[1]);
    q([[-19 + l, -15.5], [19 + l, -15.5], [11 + r, -24.5], [-11 + r, -24.5]], GLASS);
    if (!small) {
        q([[-15 + l, -16], [-8 + l, -16], [-6 + r, -24], [-9 + r, -24]], withAlpha('#ffffff', 0.1));
        cv.fillRect(X(-6 + r), Y(-24), 12 * s, 1.2 * s, LIGHT);                     // third brake light
    }
    rr(-14 + r, -28, 28, 3.5, 1.75, PAINT[0]);
    // M stripes over the roof and the boot lid
    STRIPES.forEach((c, i) => {
        const sx = -3.75 + i * 2.5;
        cv.fillRect(X(sx + r), Y(-28), 2 * s, 3.5 * s, c);
        cv.fillRect(X(sx + l), Y(-15), 2 * s, 11 * s, c);
    });
    // spoiler lip on the boot
    rr(-24 + l, -16.5, 48, 2.5, 1.25, TRIM);
    // L-shaped tail lights: smoked lens, the lit L, a soft glow
    for (const m of [-1, 1]) {
        const at = (a, b) => [m * a, b];
        if (!small) cv.roundRect(X(m > 0 ? 14 : -36), Y(-14), 22 * s, 13 * s, 6 * s, withAlpha(LIGHT, 0.07));
        q([at(33.5, -11), at(17, -12), at(17, -6.5), at(33, -3.5)], '#4a0a10');
        q([at(32.5, -10), at(18, -11), at(18, -9), at(32.5, -7.8)], LIGHT);
        q([at(32.5, -10), at(30.5, -10.2), at(30.5, -4.2), at(32.5, -4)], LIGHT);
    }
    // number plate, diffuser, four exhausts
    rr(-9, 0, 18, 5.5, 1, '#f4f7fb');
    cv.fillRect(X(-9), Y(0), 2.2 * s, 5.5 * s, '#1f4fbf');
    rr(-22, 7, 44, 7, 3, TRIM);
    if (!small) for (const ex of [-17, -11, 11, 17]) { cv.circle(X(ex), Y(11), 3 * s, '#4a505a'); cv.circle(X(ex), Y(11), 1.8 * s, '#08090b'); }
    if (small) return;
    // the roof gun (and the spoiler's two for double fire)
    const gx = r;
    rr(gx - 4, -32, 8, 4.5, 2, TRIM);
    cv.line(X(gx), Y(-31), X(gx), Y(-41), 3.5 * s, '#9aa3ad');
    if (o.double) for (const m of [-1, 1]) { cv.line(X(m * 21 + l), Y(-16.5), X(m * 21 + l), Y(-25), 2.5 * s, '#9aa3ad'); cv.circle(X(m * 21 + l), Y(-25), 1.8 * s, GOLD); }
    if (o.firing > 0) {
        cv.circle(X(gx), Y(-43), 7 * s * o.firing, withAlpha(GOLD, 0.35 * o.firing));
        cv.circle(X(gx), Y(-43), 3.5 * s * o.firing, withAlpha('#fff3c4', o.firing));
    }
}

module.exports = { drawM };
