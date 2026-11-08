'use strict';
/**
 * price_sheet.js - the price editor, a sheet the kit draws over the page (GPU renderer, full-screen
 * layout: ctx.sheet). Its arithmetic is model.js PriceEdit.
 *
 *   Controller: turn = the last decimal up / down (a fast turn: ten at a time), press = Save,
 *               tilt left = Cancel.
 *   Touch:      -/+ buttons (100, 10 and 1 units of the last decimal), a keypad to type the price,
 *               Cancel and Save.
 *
 *   const sh = priceSheet({ edit, title, unit, color, onSave(value) })   -> ctx.sheet(sh)
 */
const { withAlpha } = require('./kit/canvas');
const { fitText } = require('./kit/text-layout');

const TOP = 46, BOTTOM = 512;
const KEYS = [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3'], ['.', '0', 'del']];

/** a light colour (white-ish theme accents): dark text on it */
function light(c) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(c));
    if (!m) return false;
    const n = parseInt(m[1], 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170;
}

function button(r, t, x, y, w, h, label, opts) {
    const o = opts || {}, c = o.color || t.sel || t.accent;
    r.roundRect(x, y, w, h, Math.min(16, h / 2), o.on ? withAlpha(c, 0.9) : withAlpha('#ffffff', o.off ? 0.03 : 0.08));
    if (!o.on) r.strokeRoundRect(x, y, w, h, Math.min(16, h / 2), 1.5, withAlpha(o.color || '#ffffff', o.off ? 0.08 : o.color ? 0.7 : 0.22));
    r.text(label, x + w / 2, y + h / 2 + (o.size || 26) * 0.36, o.size || 26, o.on ? (light(c) ? '#101418' : '#ffffff') : o.off ? withAlpha(t.dim, 0.5) : o.color || t.text,
        { align: 'center', font: o.font || 'bold' });
}

/** the label of a +/- step: "+1", "-0.1", "+0.01" (or "+100" for a currency without decimals) */
const stepLabel = (sign, s, dp) => sign + (dp ? String(Number(s.toFixed(dp))) : String(Math.round(s)));

function priceSheet(opts) {
    const ed = opts.edit;
    let note = '';
    const save = () => {
        const v = ed.value();
        if (v === null) { note = 'Enter a price above 0'; return null; }
        opts.onSave(v);
        return 'close';
    };
    return {
        title: opts.title,
        keepOnBar: false,
        draw(r, t) {
            r.clear(t.bg);
            const targets = [];
            const bottom = BOTTOM + (r.extra || 0), accent = opts.color || t.accent;
            const x = 40, y = TOP + 6, w = 1600 - 80, h = bottom - y - 4;
            r.roundRect(x, y, w, h, 18, withAlpha('#ffffff', 0.05));
            r.roundRect(x, y, 8, h, 4, accent);

            // left: what is edited, the value, the steps, Cancel / Save
            const lx = x + 44;
            r.text(fitText(r, opts.title, 34, 640, { font: 'bold' }), lx, y + 56, 34, t.text, { font: 'bold' });
            r.text(fitText(r, opts.unit, 22, 640), lx, y + 88, 22, accent);
            const txt = ed.text();
            r.roundRect(lx, y + 108, 680, 112, 14, withAlpha('#ffffff', 0.06));
            r.text(fitText(r, txt, 84, 640, { font: 'num' }), lx + 24, y + 196, 84, ed.value() === null ? t.dim : t.text, { font: 'num' });
            r.text(note || (ed.entry !== null ? 'Typing - Save to keep it' : 'Turn the controller to change, press it to save'),
                lx, y + 252, 20, note ? (t.crit || '#ef2b2d') : t.dim);

            const steps = ed.steps(), bw = 104, gap = 11, by = y + 274, bh = 64;
            const row = [...steps.map((s) => ['-', s]), ...steps.slice().reverse().map((s) => ['+', s])];
            row.forEach(([sign, s], i) => {
                const bx = lx + i * (bw + gap);
                button(r, t, bx, by, bw, bh, stepLabel(sign, s, ed.dp), { size: 24, color: sign === '+' ? accent : null });
                targets.push({ x: bx, y: by, w: bw, h: bh, act: () => { note = ''; ed.step(sign === '+' ? 1 : -1, s); return null; } });
            });
            const ay = by + bh + 24, ah = 60;
            button(r, t, lx, ay, 220, ah, 'Cancel');
            targets.push({ x: lx, y: ay, w: 220, h: ah, act: () => 'close' });
            button(r, t, lx + 680 - 260, ay, 260, ah, 'Save', { on: true, color: accent });
            targets.push({ x: lx + 680 - 260, y: ay, w: 260, h: ah, act: save });

            // right: the keypad
            const kx = x + 800, kw = 206, kh = Math.min(92, (h - 48 - 3 * 12) / 4), kg = 12;
            KEYS.forEach((keys, ri) => keys.forEach((k, ci) => {
                const bx = kx + ci * (kw + kg), bry = y + 24 + ri * (kh + kg);
                const off = k === '.' && ed.dp === 0;
                button(r, t, bx, bry, kw, kh, k === 'del' ? 'Delete' : k, { size: k === 'del' ? 26 : 40, font: k === 'del' ? 'bold' : 'num', off });
                if (!off) targets.push({ x: bx, y: bry, w: kw, h: kh, act: () => { note = ''; ed.key(k); return null; } });
            }));
            return targets;
        },
        move(d) { note = ''; ed.turn(d); },
        press() { return save(); },
        back() { return 'close'; },
    };
}

module.exports = { priceSheet, stepLabel };
