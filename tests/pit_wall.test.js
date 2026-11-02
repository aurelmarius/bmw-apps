'use strict';
/** Pit Wall's rules (apps/pit_wall/model.js): node tests/pit_wall.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, FW, FH, DT, WING, LIGHTS_MS, LAYOUTS, LIVES, layout, loadBest, saveBest } = require('../apps/pit_wall/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
/** no power-ups (rng never below their chances) */
const quiet = () => new Game({ rng: () => 0.999 });
const run = (g, ms) => { for (let t = 0; t < ms; t += DT) g.step(DT); };
/** a ball in flight at (x, y) with velocity (vx, vy) */
const fly = (g, x, y, vx, vy) => { g.balls = [{ x, y, vx, vy, held: false, trail: [] }]; g.launchAt = 0; g.lightsAt = -1e9; return g.balls[0]; };

test('every level lays out panels inside the field, none overlapping', () => {
    for (let n = 1; n <= LAYOUTS.length * 2; n++) {
        const b = layout(n, () => 0.5);
        assert.ok(b.length > 10, 'level ' + n + ': ' + b.length);
        for (const q of b) assert.ok(q.x - q.w / 2 >= 0 && q.x + q.w / 2 <= FW && q.y + q.h / 2 < FH * 0.6);
        const keys = new Set(b.map((q) => q.c + ',' + q.r));
        assert.strictEqual(keys.size, b.length);
    }
});

test('start lights: five come on, the ball goes when they go out', () => {
    const g = quiet();
    assert.strictEqual(g.lights(), 1);
    assert.strictEqual(g.launch(), false);           // not during the lights
    run(g, 1700);
    assert.strictEqual(g.lights(), 5);
    assert.ok(g.balls[0].held);
    run(g, LIGHTS_MS - 1700 + 50);
    assert.strictEqual(g.lights(), -1);
    assert.ok(!g.balls[0].held);
    assert.ok(g.balls[0].vy < 0);
});

test('a held ball rides on the wing and is launched on demand', () => {
    const g = quiet();
    run(g, LIGHTS_MS + 50);
    g.serve(g.t + 10000);
    g.moveTo(200);
    run(g, 500);
    assert.strictEqual(g.balls[0].x, g.wing.x);
    assert.ok(g.launch());
    assert.ok(!g.balls[0].held);
});

test('the wing stays in the field', () => {
    const g = quiet();
    g.moveTo(-100);
    run(g, 1000);
    assert.strictEqual(g.wing.x, WING.w / 2);
    g.nudge(5000);
    run(g, 1000);
    assert.strictEqual(g.wing.x, FW - WING.w / 2);
});

test('walls and the top send the ball back', () => {
    const g = quiet();
    g.bricks = [{ c: 0, r: 0, kind: 'panel', hp: 1, maxHp: 1, x: 5000, y: 5000, w: 1, h: 1 }];
    const b = fly(g, 10, 200, -400, -50);
    g.step(DT);
    assert.ok(b.vx > 0);
    const c = fly(g, 500, 10, 0, -400);
    g.step(DT);
    assert.ok(c.vy > 0);
});

test('the angle off the wing depends on where it hits', () => {
    const g = quiet();
    g.bricks = [{ c: 0, r: 0, kind: 'panel', hp: 1, maxHp: 1, x: 5000, y: 5000, w: 1, h: 1 }];
    const w = g.wing;
    const mid = fly(g, w.x, w.y - 20, 0, 500);
    run(g, 60);
    assert.ok(mid.vy < 0 && Math.abs(mid.vx) < 0.08 * Math.abs(mid.vy));            // nearly straight up
    const edge = fly(g, w.x + w.w / 2 - 2, w.y - 20, 0, 500);
    run(g, 60);
    assert.ok(edge.vy < 0 && edge.vx > Math.abs(edge.vy));
});

test('a panel breaks, scores and turns the ball', () => {
    const g = quiet();
    const low = Math.max(...g.bricks.map((x) => x.r));
    const q = g.bricks.find((x) => x.kind === 'panel' && x.r === low);
    const n = g.bricks.length;
    const b = fly(g, q.x, q.y + 40, 0, -500);
    run(g, 150);
    assert.strictEqual(g.bricks.length, n - 1);
    assert.strictEqual(g.score, 10);
    assert.ok(b.vy > 0);
    assert.ok(g.events.some((e) => e.type === 'break'));
});

test('carbon panels take more hits', () => {
    const g = quiet();
    g.startLevel(3);
    const q = g.bricks.find((x) => x.kind === 'armor');
    assert.strictEqual(q.hp, 2);
    g._hit(q, 1);
    assert.ok(g.bricks.includes(q));
    g._hit(q, 1);
    assert.ok(!g.bricks.includes(q));
    assert.strictEqual(g.score, 50);
});

test('a fuel can takes its neighbours with it', () => {
    const g = quiet();
    g.startLevel(5);
    const f = g.bricks.find((x) => x.kind === 'fuel');
    const around = g.bricks.filter((o) => o !== f && Math.abs(o.c - f.c) <= 1 && Math.abs(o.r - f.r) <= 1);
    assert.ok(around.length > 0);
    g._hit(f, 1);
    assert.ok(around.every((o) => !g.bricks.includes(o)));
    assert.ok(g.events.some((e) => e.type === 'boom'));
});

test('a combo of panels multiplies the score; the wing ends it', () => {
    const g = quiet();
    const ps = g.bricks.filter((x) => x.kind === 'panel').slice(0, 8);
    ps.forEach((q) => g._hit(q, 1));
    // x1 x1 x1 x2 x2 x2 x2 x3
    assert.strictEqual(g.score, 10 * (1 + 1 + 1 + 2 + 2 + 2 + 2 + 3));
    assert.strictEqual(g.mult(), 3);
    fly(g, g.wing.x, g.wing.y - 20, 0, 500);
    run(g, 60);
    assert.strictEqual(g.mult(), 1);
});

test('the ball speeds up with every panel, up to a limit', () => {
    const g = quiet();
    const s0 = g.speed();
    g.cleared = 10;
    assert.strictEqual(g.speed(), s0 + 30);
    g.cleared = 1000;
    assert.strictEqual(g.speed(), 800);
    assert.ok(new Game({ speed: 'relaxed' }).speed() < s0);
});

test('a lost ball costs a life and serves again; no lives: game over', () => {
    const g = quiet();
    fly(g, 500, FH + 30, 0, 300);
    g.step(DT);
    assert.strictEqual(g.lives, LIVES - 1);
    assert.ok(g.balls[0].held);
    g.lives = 1;
    fly(g, 500, FH + 30, 0, 300);
    g.step(DT);
    assert.ok(g.over);
});

test('power-ups: a wider wing, three balls, turbo through panels', () => {
    const g = quiet();
    const w = g.wing;
    g.drops = [{ kind: 'wide', x: w.x, y: w.y, w: 44, h: 20 }];
    g.step(DT); g.step(DT);
    assert.strictEqual(g.wing.w, 230);
    fly(g, 500, 350, 100, -400);
    g._power({ kind: 'split', x: 0, y: 0 });
    assert.strictEqual(g.balls.length, 3);
    g._power({ kind: 'turbo', x: 0, y: 0 });
    const low = Math.max(...g.bricks.map((x) => x.r));
    const q = g.bricks.find((x) => x.kind === 'panel' && x.r === low);
    const b = fly(g, q.x, q.y + 40, 0, -500);
    run(g, 150);
    assert.ok(!g.bricks.includes(q));
    assert.ok(b.vy < 0);                              // went straight through
});

test('a cleared wall pays a bonus and the next level starts with the lights', () => {
    const g = quiet();
    run(g, LIGHTS_MS + 50);
    g.bricks = [];
    g.step(DT);
    assert.strictEqual(g.level, 2);
    assert.strictEqual(g.score, 100);
    assert.strictEqual(g.lights(), 1);
    assert.ok(g.balls[0].held);
});

test('a long rally does not get stuck or leave the field', () => {
    let n = 0;
    const g = new Game({ rng: () => ((n++ * 0.6180339) % 1) });
    for (let t = 0; t < 240000 && !g.over; t += DT) {
        const b = g.balls.find((q) => !q.held) || g.balls[0];
        g.moveTo(b.x + Math.sin(t / 1700) * 50);       // a wing that never misses, hitting all along it
        g.step(DT);
        for (const q of g.balls) assert.ok(q.x >= 0 && q.x <= FW && q.y >= 0, 'ball at ' + q.x + ',' + q.y);
    }
    assert.ok(g.level >= 2, 'level ' + g.level + ', ' + g.bricks.length + ' panels left');
});

test('best scores are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
    const f = path.join(dir, 'best.json');
    assert.deepStrictEqual(loadBest(f), {});
    saveBest(f, { normal: 4200 });
    assert.deepStrictEqual(loadBest(f), { normal: 4200 });
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + e.message); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
