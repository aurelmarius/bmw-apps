'use strict';
/**
 * Track Defender's rules, without drawing or the car (tested in tests/track_defender.test.js).
 *
 *   const g = new Game({ difficulty: 'normal' });
 *   g.moveTo(x) / g.nudge(dx)     // where the car on the track should go (field px)
 *   g.pulse()                     // the special: clears the sky of bullets, hits every drone once
 *   g.step(DT)                    // advance the world DT ms (main.js steps it at 60 Hz)
 *   g.events.splice(0)            // what happened, for the drawing: booms, hits, waves, power-ups
 *
 * The field is FW x FH px, y down. Drones fly in on a curve to their place in a formation that sways
 * and slowly sinks towards the track; from there some dive at the player, fire on the way and come
 * back round from the top. Every fifth wave is one big drone (the boss). The player's car fires by
 * itself; three barriers of blocks stand between it and the drones and crumble under the drones' fire.
 * The game ends with no lives left or when the formation reaches the barriers.
 */
const FW = 1152, FH = 460;
const DT = 1000 / 60;

const PLAYER = { w: 60, h: 26, y: FH - 34, speed: 1100 };
const SHOT = { vy: -950, w: 5, h: 18, cooldown: 240 };
const EBULLET = { vy: 330, r: 5 };
const DRONE = { w: 46, h: 32 };
const SLOT = { dx: 72, dy: 46, cols: 8 };
const BARRIER = { y: FH - 112, cols: 9, rows: 4, bw: 12, bh: 10 };
const LIVES = 3, MAX_LIVES = 5;
const INVULN_MS = 1800;
const PULSE_MS = 15000;
const DOUBLE_MS = 10000;
const WAVE_PAUSE_MS = 1600;
const ENTER_MS = 1000;

const DIFF = {
    easy: { fire: 0.6, dive: 0.6, sink: 0.6, bullet: 0.85 },
    normal: { fire: 1, dive: 1, sink: 1, bullet: 1 },
    hard: { fire: 1.5, dive: 1.4, sink: 1.4, bullet: 1.15 },
};
const POINTS = { drone: 10, heavy: 30 };

const overlap = (a, b) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const bez = (a, c, b, k) => (1 - k) * (1 - k) * a + 2 * (1 - k) * k * c + k * k * b;

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.diff = DIFF[o.difficulty] || DIFF.normal;
        this.reset();
    }

    reset() {
        this.t = 0;
        this.score = 0;
        this.lives = LIVES;
        this.wave = 0;
        this.over = false;
        this.player = { x: FW / 2, tx: FW / 2, y: PLAYER.y, w: PLAYER.w, h: PLAYER.h };
        this.shots = [];
        this.bullets = [];
        this.drops = [];
        this.enemies = [];
        this.barriers = makeBarriers();
        this.double = 0;              // double fire until this time
        this.guard = false;           // a shield that takes one hit
        this.pulseAt = 0;             // the pulse is ready from this time
        this.invuln = 0;              // no hit counts until this time
        this.nextShot = 0;
        this.nextWave = 0;
        this.events = [];
        this.startWave(1);
    }

    /* ---------- the player ---------- */
    moveTo(x) { this.player.tx = clamp(x, PLAYER.w / 2, FW - PLAYER.w / 2); }
    nudge(dx) { this.moveTo(this.player.tx + dx); }
    pulseReady() { return this.t >= this.pulseAt; }
    /** 0..1: how far the pulse has charged */
    pulseCharge() { return this.pulseReady() ? 1 : 1 - (this.pulseAt - this.t) / PULSE_MS; }
    pulse() {
        if (this.over || !this.pulseReady()) return false;
        this.pulseAt = this.t + PULSE_MS;
        this.bullets = [];
        this.events.push({ type: 'pulse', x: this.player.x, y: this.player.y });
        for (const e of this.enemies.slice()) if (e.y > -10) this._hit(e, e.type === 'boss' ? 5 : 1);
        return true;
    }

    /* ---------- waves ---------- */
    startWave(n) {
        this.wave = n;
        this.nextWave = 0;
        this.sinkY = 0;
        if (n % 5 === 0) {
            const hp = 30 + n * 4;
            this.enemies = [{ type: 'boss', hp, maxHp: hp, x: FW / 2, y: -60, w: 200, h: 64, state: 'enter', vx: 150 + n * 6, fireAt: 1800 }];
        } else {
            const rows = Math.min(5, 3 + Math.floor(n / 3)), pattern = n % 3;
            this.enemies = [];
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < SLOT.cols; c++) {
                    const heavy = r === 0 && n >= 2;
                    const left = pattern === 0 || (pattern === 2 && c % 2 === 0);
                    const i = r * SLOT.cols + c;
                    this.enemies.push({
                        type: heavy ? 'heavy' : 'drone', hp: heavy ? 2 : 1, r, c, w: DRONE.w, h: DRONE.h,
                        state: 'enter', k: 0, delay: i * 55,
                        from: { x: left ? -60 : FW + 60, y: -40 }, ctrl: { x: left ? FW * 0.2 : FW * 0.8, y: FH * 0.75 },
                        x: left ? -60 : FW + 60, y: -40,
                    });
                }
            }
        }
        this.events.push({ type: 'wave', wave: n, boss: n % 5 === 0 });
    }

    /** where formation place (r, c) is now: the formation sways side to side and sinks */
    slot(r, c) {
        const width = (SLOT.cols - 1) * SLOT.dx, room = (FW - width) / 2 - 50;
        return { x: FW / 2 - width / 2 + c * SLOT.dx + Math.sin(this.t / 1500) * room, y: 46 + this.sinkY + r * SLOT.dy };
    }

    /* ---------- the world ---------- */
    step(dt) {
        if (this.over) return;
        dt = dt || DT;
        const s = dt / 1000, d = this.diff;
        this.t += dt;

        // the player's car glides to where it was sent and fires by itself
        const p = this.player, room = PLAYER.speed * s;
        p.x += clamp(p.tx - p.x, -room, room);
        if (this.t >= this.nextShot) {
            this.nextShot = this.t + SHOT.cooldown;
            const xs = this.t < this.double ? [p.x - 16, p.x + 16] : [p.x];
            xs.forEach((x) => this.shots.push({ x, y: p.y - 20, w: SHOT.w, h: SHOT.h }));
        }
        this.shots.forEach((b) => { b.y += SHOT.vy * s; });
        this.shots = this.shots.filter((b) => b.y > -20);
        this.bullets.forEach((b) => { b.x += (b.vx || 0) * s; b.y += b.vy * s; });
        this.bullets = this.bullets.filter((b) => b.y < FH + 20 && b.x > -20 && b.x < FW + 20);
        this.drops.forEach((q) => { q.y += 150 * s; });
        this.drops = this.drops.filter((q) => q.y < FH + 20);

        this.sinkY = Math.min(FH, this.sinkY + (3 + this.wave * 0.5) * d.sink * s);
        this._enemies(dt, s);
        this._collide();

        // next wave
        if (!this.enemies.length && !this.over) {
            if (!this.nextWave) {
                this.nextWave = this.t + WAVE_PAUSE_MS;
                this.score += 50 * this.wave;
                this.bullets = [];
                this.events.push({ type: 'cleared', wave: this.wave });
            } else if (this.t >= this.nextWave) this.startWave(this.wave + 1);
        }
    }

    _enemies(dt, s) {
        const d = this.diff, p = this.player;
        const formed = this.enemies.filter((e) => e.state === 'form');
        // a few dive at the player
        const diving = this.enemies.filter((e) => e.state === 'dive').length;
        if (formed.length && diving < 2 + Math.floor(this.wave / 3) && this.rng() < (0.25 + this.wave * 0.05) * d.dive * s) {
            const e = formed[Math.floor(this.rng() * formed.length)];
            e.state = 'dive'; e.fired = false; e.phase = this.rng() * 6;
        }
        // the lowest drone of a column fires now and then
        if (formed.length && this.rng() < (0.6 + this.wave * 0.1) * d.fire * s) {
            const e = formed[Math.floor(this.rng() * formed.length)];
            const low = formed.filter((q) => q.c === e.c).sort((a, b) => b.r - a.r)[0];
            this._fire(low.x, low.y + 16, 0);
        }
        for (const e of this.enemies) {
            if (e.type === 'boss') { this._boss(e, dt, s); continue; }
            if (e.state === 'enter') {
                if (e.delay > 0) { e.delay -= dt; continue; }
                e.k = Math.min(1, e.k + dt / ENTER_MS);
                const to = this.slot(e.r, e.c);
                e.x = bez(e.from.x, e.ctrl.x, to.x, e.k); e.y = bez(e.from.y, e.ctrl.y, to.y, e.k);
                if (e.k >= 1) e.state = 'form';
            } else if (e.state === 'form') {
                const to = this.slot(e.r, e.c);
                e.x = to.x; e.y = to.y;
                if (e.y + e.h / 2 >= BARRIER.y) this._invaded();
            } else if (e.state === 'dive') {
                e.y += 250 * s;
                e.x += clamp(p.x - e.x, -170 * s, 170 * s) + Math.cos(this.t / 220 + e.phase) * 160 * s;
                if (!e.fired && e.y > FH * 0.4) { e.fired = true; this._fire(e.x, e.y + 16, (p.x - e.x) * 0.4); }
                if (e.y > FH + 40) {
                    // back round from the top to its place
                    const to = this.slot(e.r, e.c);
                    Object.assign(e, { state: 'enter', k: 0, delay: 0, from: { x: to.x, y: -40 }, ctrl: { x: to.x, y: 0 }, y: -40 });
                }
            }
        }
    }

    _boss(e, dt, s) {
        const d = this.diff;
        if (e.state === 'enter') {
            e.y += 90 * s;
            if (e.y >= 80) { e.y = 80; e.state = 'form'; }
            return;
        }
        e.x += e.vx * s;
        if (e.x < e.w / 2 + 10 || e.x > FW - e.w / 2 - 10) { e.vx = -e.vx; e.x = clamp(e.x, e.w / 2 + 10, FW - e.w / 2 - 10); }
        e.fireAt -= dt * d.fire;
        if (e.fireAt <= 0) {
            e.fireAt = 1100;
            e.volley = (e.volley || 0) + 1;
            if (e.volley % 2) [-120, 0, 120].forEach((vx) => this._fire(e.x, e.y + 34, vx));
            else this._fire(e.x, e.y + 34, (this.player.x - e.x) * 0.5);
        }
    }

    _fire(x, y, vx) { this.bullets.push({ x, y, vx, vy: EBULLET.vy * this.diff.bullet, w: EBULLET.r * 2, h: EBULLET.r * 2 }); }

    _collide() {
        const p = this.player;
        // the player's shots (they pass the barriers: the car fires all the time, from under them)
        for (const b of this.shots.slice()) {
            const e = this.enemies.find((q) => q.y > -10 && overlap(b, q));
            if (e) { this.shots.splice(this.shots.indexOf(b), 1); this._hit(e, 1); }
        }
        // the drones' bullets
        for (const b of this.bullets.slice()) {
            if (this._barrier(b)) { this.bullets.splice(this.bullets.indexOf(b), 1); continue; }
            if (overlap(b, p)) { this.bullets.splice(this.bullets.indexOf(b), 1); this._hurt(); }
        }
        // drones that fly into the player or through a barrier
        for (const e of this.enemies.slice()) {
            if (e.type === 'boss') continue;
            this._barrier(e, true);
            if (e.state === 'dive' && overlap(e, p)) { this._kill(e); this._hurt(); }
        }
        // power-ups caught
        for (const q of this.drops.slice()) {
            if (!overlap(q, p)) continue;
            this.drops.splice(this.drops.indexOf(q), 1);
            if (q.kind === 'double') this.double = this.t + DOUBLE_MS;
            else if (q.kind === 'guard') this.guard = true;
            else this.lives = Math.min(MAX_LIVES, this.lives + 1);
            this.events.push({ type: 'power', kind: q.kind, x: q.x, y: q.y });
        }
    }

    /** thing hits a barrier block: the block crumbles (all it touches, with all: a drone ploughing through) */
    _barrier(o, all) {
        let hit = false;
        for (const k of this.barriers) {
            if (!k.alive || !overlap(o, k)) continue;
            k.alive = false; hit = true;
            if (!all) break;
        }
        return hit;
    }

    _hit(e, n) {
        e.hp -= n;
        if (e.hp > 0) { this.events.push({ type: 'dent', x: e.x, y: e.y }); return; }
        this._kill(e, true);
    }

    _kill(e, scored) {
        const i = this.enemies.indexOf(e);
        if (i < 0) return;
        this.enemies.splice(i, 1);
        if (scored) {
            const pts = e.type === 'boss' ? 500 + this.wave * 50 : POINTS[e.type] * (e.state === 'dive' ? 2 : 1);
            this.score += pts;
            this.events.push({ type: 'boom', x: e.x, y: e.y, big: e.type === 'boss', kind: e.type, pts });
            const r = this.rng();
            const kind = e.type === 'boss' ? 'life' : r < 0.02 ? 'life' : r < 0.06 ? 'guard' : r < 0.1 ? 'double' : null;
            if (kind) this.drops.push({ kind, x: e.x, y: e.y, w: 28, h: 28 });
        } else this.events.push({ type: 'boom', x: e.x, y: e.y, kind: e.type });
    }

    _hurt() {
        if (this.t < this.invuln || this.over) return;
        if (this.guard) {
            this.guard = false;
            this.invuln = this.t + 600;
            this.events.push({ type: 'guard', x: this.player.x, y: this.player.y });
            return;
        }
        this.lives--;
        this.invuln = this.t + INVULN_MS;
        this.bullets = [];
        this.events.push({ type: 'hit', x: this.player.x, y: this.player.y });
        if (this.lives <= 0) this._end('destroyed');
    }

    _invaded() {
        if (this.over) return;
        this.lives = 0;
        this.events.push({ type: 'hit', x: this.player.x, y: this.player.y });
        this._end('invaded');
    }

    _end(why) {
        this.over = true;
        this.why = why;
        this.events.push({ type: 'over', why });
    }
}

/** three barriers of blocks over the track, their top corners cut */
function makeBarriers() {
    const out = [], W = BARRIER.cols * BARRIER.bw;
    [0.22, 0.5, 0.78].forEach((f) => {
        const x0 = FW * f - W / 2;
        for (let r = 0; r < BARRIER.rows; r++) {
            for (let c = 0; c < BARRIER.cols; c++) {
                if (r === 0 && (c === 0 || c === BARRIER.cols - 1)) continue;
                if (r === BARRIER.rows - 1 && c >= 3 && c <= 5) continue;        // the arch underneath
                out.push({ x: x0 + (c + 0.5) * BARRIER.bw, y: BARRIER.y + (r + 0.5) * BARRIER.bh, w: BARRIER.bw, h: BARRIER.bh, alive: true });
            }
        }
    });
    return out;
}

/** best scores, one per difficulty, in the app's data folder */
function loadBest(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('track_defender: best scores not read: ' + e.message);
        return {};
    }
}
function saveBest(file, best) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(best));
    fs.renameSync(file + '.tmp', file);
}

module.exports = { Game, FW, FH, DT, PLAYER, BARRIER, PULSE_MS, SHOT_MS: SHOT.cooldown, LIVES, loadBest, saveBest };
