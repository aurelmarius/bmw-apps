'use strict';
/**
 * volume_popup.js - the car's volume drawn by the app (the HMI shows none on the CarLife source, 287): a see-through
 * panel at the bottom with a speaker (its waves follow the volume; crossed out when muted), the bar and the number
 * (or Mute), as Music Assistant's; and the same as one line for the cluster card. Works on a Canvas and on the GPU
 * recorder (the same calls), at any scale (the page is 1600x520, a film over the screen is the panel's size).
 *
 *   drawPopup(cv, W, H, v, accent, scale, lift)   v = car_volume's popup(): { volume, muted, max }; lift: above a bar
 *   drawLine(cv, cx, y, v, colours)          the cluster card's line in place of the time
 */
const WHITE = [255, 255, 255, 255], GREY = [160, 160, 170, 255];

function speaker(cv, sx, sy, s, col, v, width) {
    cv.fillRect(sx, sy + s * 0.32, s * 0.25, s * 0.36, col);
    cv.quad([[sx + s * 0.25, sy + s * 0.32], [sx + s * 0.55, sy + s * 0.08], [sx + s * 0.55, sy + s * 0.92], [sx + s * 0.25, sy + s * 0.68]], col);
    const level = v.volume == null ? 0 : v.volume / (v.max || 62), my = sy + s / 2;
    if (v.muted) {
        cv.line(sx + s * 0.68, sy + s * 0.32, sx + s * 0.98, sy + s * 0.68, width, col);
        cv.line(sx + s * 0.98, sy + s * 0.32, sx + s * 0.68, sy + s * 0.68, width, col);
    } else {
        if (level > 0) cv.arc(sx + s * 0.55, my, s * 0.19, s * 0.27, 50, 130, col);
        if (level >= 0.35) cv.arc(sx + s * 0.55, my, s * 0.40, s * 0.48, 50, 130, col);
    }
    return level;
}

function drawPopup(cv, W, H, v, accent, scale, lift) {
    const k = scale || 1;
    const pw = 640 * k, ph = 96 * k, px = (W - pw) / 2, py = H - ph - 40 * k - (lift || 0), cy = py + ph / 2;
    cv.roundRect(px - 4 * k, py + 2 * k, pw + 8 * k, ph + 6 * k, 26 * k, [0, 0, 0, 90]);
    cv.roundRect(px, py, pw, ph, 22 * k, [30, 32, 38, 215]);
    if (cv.strokeRoundRect) cv.strokeRoundRect(px, py, pw, ph, 22 * k, Math.max(1, k), [255, 255, 255, 50]);
    const col = v.muted ? GREY : WHITE;
    const level = speaker(cv, px + 28 * k, py + 24 * k, 48 * k, col, v, 4 * k);
    const bx0 = px + 104 * k, bx1 = px + pw - 150 * k;
    cv.roundRect(bx0, cy - 5 * k, bx1 - bx0, 10 * k, 5 * k, [255, 255, 255, 45]);
    if (!v.muted && level > 0) {
        const fx = bx0 + (bx1 - bx0) * Math.min(1, level);
        cv.roundRect(bx0, cy - 5 * k, Math.max(10 * k, fx - bx0), 10 * k, 5 * k, accent);
        cv.circle(fx, cy, 11 * k, WHITE);
    }
    cv.text(v.muted ? 'Mute' : v.volume == null ? '-' : String(Math.round(v.volume)), px + pw - 28 * k, cy + 12 * k, Math.round(34 * k), col, { align: 'right', font: 'bold', literal: true });
}

/** the cluster card's line: c = { text, dim, track, bar } */
function drawLine(cv, cx, y, v, c) {
    const col = v.muted ? c.dim : c.text, s = 30, sx = cx - 150, sy = y - 24, my = sy + s / 2;
    const level = speaker(cv, sx, sy, s, col, v, 3);
    const bx = cx - 100, bw = 168;
    cv.roundRect(bx, my - 3, bw, 6, 3, c.track);
    if (!v.muted && level > 0) cv.roundRect(bx, my - 3, Math.max(6, bw * Math.min(1, level)), 6, 3, c.bar);
    cv.text(v.muted ? 'Mute' : v.volume == null ? '-' : String(Math.round(v.volume)), cx + 152, my + 10, 28, col, { align: 'right', literal: true });
}

module.exports = { drawPopup, drawLine };
