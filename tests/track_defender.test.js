'use strict';
/** Track Defender's rules (apps/track_defender/model.js): node tests/track_defender.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, FW, FH, DT, PULSE_MS, LIVES, loadBest, saveBest } = require('../apps/track_defender/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
/** a calm game: no dives, no drone fire (rng never below the chances) */
const calm = () => new Game({ rng: () => 0.999 });
const run = (g, ms) => { for (let t = 0; t < ms; t += DT) g.step(DT); };
const formed = (g) => g.enemies.filter((e) => e.state === 'form').length;

test('wave 1: three rows of eight drones fly into formation', () => {
    const g = calm();
    assert.strictEqual(g.wave, 1);
    assert.strictEqual(g.enemies.length, 24);
    assert.ok(g.enemies.every((e) => e.type === 'drone' && e.state === 'enter'));
    run(g, 2600);
    assert.strictEqual(formed(g), g.enemies.length);
});

test('the car glides to where it is sent, inside the field', () => {
    const g = calm();
    g.moveTo(-500);
    run(g, 1000);
    assert.strictEqual(g.player.x, 30);
    g.nudge(100);
    run(g, 50);
    assert.ok(g.player.x > 30 && g.player.x <= 130);
    g.moveTo(FW + 500);
    run(g, 2000);
    assert.strictEqual(g.player.x, FW - 30);
});

test('fires by itself; a shot takes a drone down and scores', () => {
    const g = calm();
    g.nextShot = Infinity;                            // no shots of its own until the drones are in place
    run(g, 2600);
    const before = g.enemies.length;
    const e = g.enemies.find((q) => q.r === 2);
    g.player.x = g.player.tx = e.x;
    g.shots = [{ x: e.x, y: e.y + 30, w: 5, h: 18 }];
    g.nextShot = Infinity;
    g.step(DT); g.step(DT);
    assert.strictEqual(g.enemies.length, before - 1);
    assert.strictEqual(g.score, 10);
    assert.ok(g.events.some((v) => v.type === 'boom'));
});

test('heavy drones take two hits (from wave 2, top row)', () => {
    const g = calm();
    g.startWave(2);
    const h = g.enemies.filter((e) => e.type === 'heavy');
    assert.strictEqual(h.length, 8);
    assert.ok(h.every((e) => e.r === 0 && e.hp === 2));
    g._hit(h[0], 1);
    assert.ok(g.enemies.includes(h[0]));
    g._hit(h[0], 1);
    assert.ok(!g.enemies.includes(h[0]));
    assert.strictEqual(g.score, 30);
});

test('a bullet on the car costs a life, then a moment of cover', () => {
    const g = calm();
    g.nextShot = Infinity;
    const p = g.player;
    g.bullets = [{ x: p.x, y: p.y, vx: 0, vy: 0, w: 10, h: 10 }];
    g.step(DT);
    assert.strictEqual(g.lives, LIVES - 1);
    g.bullets = [{ x: p.x, y: p.y, vx: 0, vy: 0, w: 10, h: 10 }];
    g.step(DT);
    assert.strictEqual(g.lives, LIVES - 1);
});

test('the guard takes one hit instead of a life', () => {
    const g = calm();
    g.guard = true;
    const p = g.player;
    g.bullets = [{ x: p.x, y: p.y, vx: 0, vy: 0, w: 10, h: 10 }];
    g.step(DT);
    assert.strictEqual(g.lives, LIVES);
    assert.strictEqual(g.guard, false);
});

test('no lives left: game over', () => {
    const g = calm();
    g.lives = 1;
    g._hurt();
    assert.ok(g.over);
    assert.strictEqual(g.why, 'destroyed');
    const t = g.t;
    g.step(DT);
    assert.strictEqual(g.t, t);
});

test('the car\'s own shots pass the barriers', () => {
    const g = calm();
    const k = g.barriers[10];
    g.nextShot = Infinity;
    g.shots = [{ x: k.x, y: k.y, w: 5, h: 18 }];
    g.step(DT);
    assert.strictEqual(k.alive, true);
    assert.strictEqual(g.shots.length, 1);
});

test('barrier blocks stop the drones\' bullets and crumble', () => {
    const g = calm();
    const k = g.barriers[10];
    g.nextShot = Infinity;
    g.bullets = [{ x: k.x, y: k.y, vx: 0, vy: 0, w: 10, h: 10 }];
    g.step(DT);
    assert.strictEqual(k.alive, false);
    assert.strictEqual(g.bullets.length, 0);
    assert.strictEqual(g.lives, LIVES);
});

test('the pulse clears the bullets, hits every drone once, then charges', () => {
    const g = calm();
    g.startWave(2);
    run(g, 2600);
    g.bullets = [{ x: 10, y: 10, vx: 0, vy: 0, w: 10, h: 10 }];
    assert.ok(g.pulse());
    assert.strictEqual(g.bullets.length, 0);
    assert.ok(g.enemies.every((e) => e.type === 'heavy' && e.hp === 1));
    assert.strictEqual(g.pulse(), false);
    assert.ok(g.pulseCharge() < 0.01);
    run(g, PULSE_MS);
    assert.ok(g.pulseReady());
});

test('a cleared wave pays a bonus, then the next comes', () => {
    const g = calm();
    g.enemies = [];
    g.step(DT);
    assert.strictEqual(g.score, 50);
    assert.ok(g.events.some((v) => v.type === 'cleared'));
    run(g, 1700);
    assert.strictEqual(g.wave, 2);
    assert.strictEqual(g.enemies.length, 24);
});

test('every fifth wave is the boss: it comes down, sweeps and fires volleys', () => {
    const g = calm();
    g.startWave(5);
    assert.strictEqual(g.enemies.length, 1);
    const b = g.enemies[0];
    assert.strictEqual(b.type, 'boss');
    let fired = 0;
    const fire = g._fire.bind(g);
    g._fire = (...a) => { fired++; fire(...a); };
    g.nextShot = Infinity;
    const x0 = (run(g, 2000), b.x);
    assert.strictEqual(b.state, 'form');
    run(g, 2500);
    assert.notStrictEqual(b.x, x0);
    assert.ok(fired >= 4, 'fired ' + fired);         // a volley of three, then an aimed one
    g._hit(b, b.hp);
    assert.strictEqual(g.score, 500 + 250);
    assert.ok(g.drops.some((q) => q.kind === 'life'));
});

test('power-ups: double fire for a while, an extra life up to five', () => {
    const g = calm();
    const p = g.player;
    g.drops = [{ kind: 'double', x: p.x, y: p.y, w: 28, h: 28 }];
    g.step(DT);
    g.nextShot = 0; g.shots = [];
    g.step(DT);
    assert.strictEqual(g.shots.length, 2);
    g.lives = 5;
    g.drops = [{ kind: 'life', x: p.x, y: p.y, w: 28, h: 28 }];
    g.step(DT);
    assert.strictEqual(g.lives, 5);
});

test('drones dive and fire when the dice say so', () => {
    let n = 0;
    const g = new Game({ rng: () => ((n++ * 0.37) % 1) * 0.02 });
    run(g, 2600);
    run(g, 3000);
    assert.ok(g.events.some(() => true));
    assert.ok(g.enemies.some((e) => e.state === 'dive') || g.bullets.length > 0 || g.lives < LIVES);
});

test('the formation sinks; at the barriers the track is lost', () => {
    const g = calm();
    run(g, 2600);
    g.sinkY = FH;
    g.step(DT);
    assert.ok(g.over);
    assert.strictEqual(g.why, 'invaded');
});

test('best scores are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-'));
    const f = path.join(dir, 'best.json');
    assert.deepStrictEqual(loadBest(f), {});
    saveBest(f, { normal: 1230 });
    assert.deepStrictEqual(loadBest(f), { normal: 1230 });
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + e.message); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
