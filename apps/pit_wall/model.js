'use strict';
/**
 * Pit Wall's rules, without drawing or the car (tested in tests/pit_wall.test.js).
 *
 *   const g = new Game({ speed: 'normal' });
 *   g.moveTo(x) / g.nudge(dx)     // where the wing (the paddle) should go (field px)
 *   g.launch()                    // send off a ball waiting on the wing
 *   g.step(DT)                    // advance the world DT ms (main.js steps it at 60 Hz, 2 physics sub-steps each)
 *   g.events.splice(0)            // what happened, for the drawing: hits, breaks, power-ups, lost balls
 *
 * The field is FW x FH px, y down. A level is a wall of advertising panels (1 hit), carbon panels
 * (2-3 hits) and fuel cans (they go off and take their neighbours with them). A level starts with
 * the start lights: five red lights come on one by one and the ball goes when they go out. The ball
 * leaves the wing at an angle that depends on where it hits; it speeds up with every panel. Panels
 * broken in a row without touching the wing build a combo (score x2 .. x5). Power-ups drop from
 * broken panels: DRS (a wider wing), split (three balls), turbo (the ball goes through panels),
 * slow and an extra life.
 */
const FW = 1152, FH = 460;
const DT = 1000 / 60;
const SUB = 2;                                          // physics sub-steps per step

const WING = { w: 150, wide: 230, h: 16, y: FH - 34, speed: 1700 };
const BALL = { r: 8 };
const GRID = { cols: 14, rows: 7, w: 72, h: 24, gap: 6, top: 54 };
const SPEEDS = { relaxed: 0.8, normal: 1, fast: 1.2 };
const BASE_SPEED = 470, PER_LEVEL = 15, PER_HIT = 3, MAX_SPEED = 800;
const MAX_ANGLE = 62;                                   // degrees from straight up at the wing's ends
const MIN_ANGLE = 4;                                    // never quite straight up (it would bounce in one column forever)
const LIGHTS_MS = 2600;                                 // 5 lights, 400 ms each, then a moment and out
const SERVE_MS = 3000;                                  // a ball on the wing goes by itself after this
const LIVES = 3, MAX_LIVES = 5;
const POWER_MS = { wide: 12000, turbo: 7000, slow: 9000 };
const POINTS = { panel: 10, armor: 25, fuel: 15 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- levels: which kind of panel stands at (c, r), or nothing ---------- */
const LAYOUTS = [
    // the full wall
    (c, r) => (r >= 1 && r <= 5 ? 'panel' : null),
    // a wedge, widest at the bottom
    (c, r) => (Math.abs(c - 6.5) <= r + 0.5 ? (r === 0 ? 'armor' : 'panel') : null),
    // three bands, carbon between them
    (c, r) => (r === 0 ? null : c % 5 === 4 ? 'armor' : 'panel'),
    // a checkerboard with fuel cans in the middle
    (c, r) => ((c + r) % 2 === 0 ? ((c === 6 || c === 7) && r === 3 ? 'fuel' : 'panel') : r % 3 === 0 ? 'armor' : null),
    // a diamond around a core of fuel cans
    (c, r) => { const d = Math.abs(c - 6.5) / 1.6 + Math.abs(r - 3); return d <= 1 ? 'fuel' : d <= 3.6 ? (d > 3 ? 'armor' : 'panel') : null; },
    // the circuit: a carbon frame, panels inside, fuel cans in the corners
    (c, r) => {
        if (r === 0 || r === 6) return c >= 1 && c <= 12 ? 'armor' : null;
        if (c === 1 || c === 12) return 'armor';
        if (c < 1 || c > 12) return null;
        return (c === 2 || c === 11) && (r === 1 || r === 5) ? 'fuel' : 'panel';
    },
];

function layout(n, rng) {
    const f = LAYOUTS[(n - 1) % LAYOUTS.length], round = Math.floor((n - 1) / LAYOUTS.length);
    const x0 = (FW - (GRID.cols * (GRID.w + GRID.gap) - GRID.gap)) / 2;
    const out = [];
    for (let r = 0; r < GRID.rows; r++) {
        for (let c = 0; c < GRID.cols; c++) {
            let kind = f(c, r);
            if (!kind) continue;
            // later rounds: more carbon
            if (kind === 'panel' && round > 0 && rng() < 0.12 * round) kind = 'armor';
            const hp = kind === 'armor' ? 2 + (round > 1 ? 1 : 0) : 1;
            out.push({ c, r, kind, hp, maxHp: hp, x: x0 + c * (GRID.w + GRID.gap) + GRID.w / 2, y: GRID.top + r * (GRID.h + GRID.gap) + GRID.h / 2, w: GRID.w, h: GRID.h, hue: (r + Math.floor(c / 2)) % 6 });
        }
    }
    return out;
}

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.speedK = SPEEDS[o.speed] || 1;
        this.reset();
    }

    reset() {
        this.t = 0;
        this.score = 0;
        this.lives = LIVES;
        this.over = false;
        this.wing = { x: FW / 2, tx: FW / 2, y: WING.y, w: WING.w, h: WING.h, vx: 0 };
        this.drops = [];
        this.until = { wide: 0, turbo: 0, slow: 0 };
        this.events = [];
        this.startLevel(1);
    }

    startLevel(n) {
        this.level = n;
        this.bricks = layout(n, this.rng);
        this.drops = [];
        this.until = { wide: 0, turbo: 0, slow: 0 };
        this.combo = 0;
        this.cleared = 0;
        this.lightsAt = this.t;                 // the start lights run from here
        this.serve(this.t + LIGHTS_MS);
        this.events.push({ type: 'level', level: n });
    }

    /** a ball on the wing; it goes by itself at `at` (or when launched) */
    serve(at) {
        this.balls = [{ x: this.wing.x, y: this.wing.y - this.wing.h / 2 - BALL.r - 1, vx: 0, vy: 0, held: true, trail: [] }];
        this.launchAt = at || this.t + SERVE_MS;
        this.combo = 0;
    }

    /* ---------- the player ---------- */
    moveTo(x) { this.wing.tx = clamp(x, this.wing.w / 2, FW - this.wing.w / 2); }
    nudge(dx) { this.moveTo(this.wing.tx + dx); }
    /** the start lights: how many are on (0..5), or -1 when they are out */
    lights() {
        const k = this.t - this.lightsAt;
        return k < 0 || k >= LIGHTS_MS ? -1 : Math.min(5, Math.floor(k / 400) + 1);
    }
    launch() {
        if (this.over || this.lights() >= 0) return false;   // not before the lights go out
        const b = this.balls.find((q) => q.held);
        if (!b) return false;
        b.held = false;
        // off at a small angle the way the wing moves (straight up when still)
        const a = clamp(this.wing.vx / 40, -20, 20) || (this.rng() < 0.5 ? -8 : 8);
        this._aim(b, a);
        this.launchAt = 0;
        this.events.push({ type: 'launch', x: b.x, y: b.y });
        return true;
    }

    speed() {
        const s = (BASE_SPEED + (this.level - 1) * PER_LEVEL + this.cleared * PER_HIT) * this.speedK;
        return Math.min(MAX_SPEED * this.speedK, s) * (this.t < this.until.slow ? 0.7 : 1);
    }
    _aim(b, deg) {
        const a = deg * Math.PI / 180, v = this.speed();
        b.vx = Math.sin(a) * v; b.vy = -Math.cos(a) * v;
    }

    /* ---------- the world ---------- */
    step(dt) {
        if (this.over) return;
        dt = dt || DT;
        this.t += dt;
        const w = this.wing;
        w.w = this.t < this.until.wide ? WING.wide : WING.w;
        w.tx = clamp(w.tx, w.w / 2, FW - w.w / 2);
        const room = WING.speed * dt / 1000, x0 = w.x;
        w.x += clamp(w.tx - w.x, -room, room);
        w.vx = (w.x - x0) / (dt / 1000);

        for (const b of this.balls) if (b.held) { b.x = w.x; b.y = w.y - w.h / 2 - BALL.r - 1; }
        if (this.launchAt && this.t >= this.launchAt) this.launch();

        const h = dt / 1000 / SUB;
        for (let k = 0; k < SUB; k++) for (const b of this.balls.slice()) if (!b.held) this._move(b, h);
        for (const b of this.balls) { b.trail.unshift({ x: b.x, y: b.y }); if (b.trail.length > 12) b.trail.pop(); }

        // power-ups fall; the wing catches them
        this.drops.forEach((q) => { q.y += 170 * dt / 1000; });
        for (const q of this.drops.slice()) {
            if (q.y > FH + 20) { this.drops.splice(this.drops.indexOf(q), 1); continue; }
            if (Math.abs(q.x - w.x) * 2 < w.w + q.w && Math.abs(q.y - w.y) * 2 < w.h + q.h) { this.drops.splice(this.drops.indexOf(q), 1); this._power(q); }
        }

        // balls gone past the wing
        const lost = this.balls.filter((b) => b.y - BALL.r > FH);
        if (lost.length) {
            this.balls = this.balls.filter((b) => !lost.includes(b));
            if (!this.balls.length) {
                this.lives--;
                this.events.push({ type: 'lost', x: lost[0].x });
                this.until = { wide: 0, turbo: 0, slow: 0 };
                this.drops = [];
                if (this.lives <= 0) { this.over = true; this.events.push({ type: 'over' }); return; }
                this.serve();
            }
        }
        if (!this.bricks.length) {
            this.score += 100 * this.level;
            this.events.push({ type: 'cleared', level: this.level, bonus: 100 * this.level });
            this.startLevel(this.level + 1);
        }
    }

    _move(b, h) {
        const w = this.wing, r = BALL.r;
        b.x += b.vx * h; b.y += b.vy * h;
        // walls and the top
        if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx); this.events.push({ type: 'wall', x: b.x, y: b.y }); }
        if (b.x > FW - r) { b.x = FW - r; b.vx = -Math.abs(b.vx); this.events.push({ type: 'wall', x: b.x, y: b.y }); }
        if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy); this.events.push({ type: 'wall', x: b.x, y: b.y }); }
        // the wing: the angle comes from where it hits (the middle straight up, the ends at MAX_ANGLE)
        if (b.vy > 0 && b.y + r >= w.y - w.h / 2 && b.y - r <= w.y + w.h / 2 && Math.abs(b.x - w.x) <= w.w / 2 + r) {
            const k = clamp((b.x - w.x) / (w.w / 2), -1, 1);
            const a = k * MAX_ANGLE;
            this._aim(b, Math.abs(a) < MIN_ANGLE ? (a < 0 || (a === 0 && this.rng() < 0.5) ? -MIN_ANGLE : MIN_ANGLE) : a);
            b.y = w.y - w.h / 2 - r;
            this.combo = 0;
            this.events.push({ type: 'wing', x: b.x, y: b.y, k });
            return;
        }
        // panels: the nearest one the ball touches; bounce off the side it came through
        const turbo = this.t < this.until.turbo;
        for (const q of this.bricks) {
            const nx = clamp(b.x, q.x - q.w / 2, q.x + q.w / 2), ny = clamp(b.y, q.y - q.h / 2, q.y + q.h / 2);
            const dx = b.x - nx, dy = b.y - ny;
            if (dx * dx + dy * dy > r * r) continue;
            if (!turbo) {
                const px = q.w / 2 + r - Math.abs(b.x - q.x), py = q.h / 2 + r - Math.abs(b.y - q.y);
                if (px < py) { b.vx = Math.sign(b.x - q.x) * Math.abs(b.vx); b.x += Math.sign(b.x - q.x) * px; } else { b.vy = Math.sign(b.y - q.y) * Math.abs(b.vy); b.y += Math.sign(b.y - q.y) * py; }
            }
            this._hit(q, turbo ? q.hp : 1);
            // the ball keeps its direction, at the speed it has now
            const v = Math.hypot(b.vx, b.vy), s = this.speed();
            if (v > 0) { b.vx *= s / v; b.vy *= s / v; }
            break;
        }
    }

    _hit(q, n) {
        if (!this.bricks.includes(q)) return;
        q.hp -= n;
        if (q.hp > 0) { this.events.push({ type: 'dent', x: q.x, y: q.y, kind: q.kind, hp: q.hp }); return; }
        this._break(q);
    }

    _break(q) {
        const i = this.bricks.indexOf(q);
        if (i < 0) return;
        this.bricks.splice(i, 1);
        this.combo++;
        this.cleared++;
        const mult = this.mult();
        const pts = (q.kind === 'armor' ? POINTS.armor * q.maxHp : POINTS[q.kind]) * mult;
        this.score += pts;
        this.events.push({ type: 'break', x: q.x, y: q.y, w: q.w, h: q.h, kind: q.kind, hue: q.hue, pts, mult });
        // power-ups
        const r = this.rng();
        const kind = r < 0.015 ? 'life' : r < 0.045 ? 'split' : r < 0.075 ? 'wide' : r < 0.1 ? 'turbo' : r < 0.12 ? 'slow' : null;
        if (kind) this.drops.push({ kind, x: q.x, y: q.y, w: 44, h: 20 });
        // a fuel can goes off: the panels around it are hit too
        if (q.kind === 'fuel') {
            this.events.push({ type: 'boom', x: q.x, y: q.y });
            for (const o of this.bricks.slice()) if (Math.abs(o.c - q.c) <= 1 && Math.abs(o.r - q.r) <= 1) this._hit(o, o.kind === 'armor' ? o.hp : 1);
        }
    }

    /** score multiplier from the combo: x1, then x2 from 4 panels in a row, up to x5 */
    mult() { return Math.min(5, 1 + Math.floor(this.combo / 4)); }

    _power(q) {
        if (q.kind === 'life') this.lives = Math.min(MAX_LIVES, this.lives + 1);
        else if (q.kind === 'split') {
            const src = this.balls.find((b) => !b.held) || this.balls[0];
            if (src && !src.held) {
                for (const a of [-25, 25]) {
                    const b = { x: src.x, y: src.y, vx: 0, vy: 0, held: false, trail: [] };
                    const base = Math.atan2(src.vx, -src.vy) * 180 / Math.PI;
                    this._aim(b, clamp(base + a, -75, 75));
                    this.balls.push(b);
                }
            }
        } else this.until[q.kind] = this.t + POWER_MS[q.kind];
        this.events.push({ type: 'power', kind: q.kind, x: q.x, y: q.y });
    }
}

/** best scores, one per ball speed, in the app's data folder */
function loadBest(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('pit_wall: best scores not read: ' + e.message);
        return {};
    }
}
function saveBest(file, best) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(best));
    fs.renameSync(file + '.tmp', file);
}

module.exports = { Game, FW, FH, DT, WING, BALL, GRID, LIGHTS_MS, LAYOUTS, LIVES, layout, loadBest, saveBest };
