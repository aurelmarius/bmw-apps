'use strict';
/** Snake's rules (apps/snake/model.js): node tests/snake.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, loadBest, saveBest } = require('../apps/snake/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const at = (g) => g.snake.map((c) => c.x + ',' + c.y).join(' ');
/** a game with the food where we want it (rng picks the free cell) */
const game = (o) => new Game(Object.assign({ cols: 10, rows: 6, rng: () => 0.999 }, o));

test('starts heading east, three long, food on a free cell', () => {
    const g = game();
    assert.strictEqual(g.dir, 'E');
    assert.strictEqual(at(g), '3,3 2,3 1,3');
    assert.ok(g.food && !g.snake.some((c) => c.x === g.food.x && c.y === g.food.y));
});

test('moves one cell a step, the tail follows', () => {
    const g = game();
    g.food = { x: 9, y: 0 };
    assert.strictEqual(g.step(), 'move');
    assert.strictEqual(at(g), '4,3 3,3 2,3');
    assert.strictEqual(at({ snake: g.prev }), '3,3 2,3 1,3');
});

test('turns: not back into the neck, not twice the same, at most two queued', () => {
    const g = game();
    assert.strictEqual(g.turn('W'), false);
    assert.strictEqual(g.turn('E'), false);
    assert.strictEqual(g.turn('N'), true);
    assert.strictEqual(g.turn('S'), false);           // back against the queued turn
    assert.strictEqual(g.turn('W'), true);
    assert.strictEqual(g.turn('S'), false);           // queue full
    g.food = { x: 9, y: 5 };
    g.step(); g.step();
    assert.strictEqual(at(g), '2,2 3,2 3,3');
});

test('relative turns from the way it will be going', () => {
    const g = game();
    assert.ok(g.turnBy(1));                           // E -> S
    assert.ok(g.turnBy(1));                           // S -> W
    assert.deepStrictEqual(g.queue, ['S', 'W']);
    const h = game();
    h.turnBy(-1);
    assert.deepStrictEqual(h.queue, ['N']);
});

test('eats, grows and scores', () => {
    const g = game();
    g.food = { x: 4, y: 3 };
    assert.strictEqual(g.step(), 'eat');
    assert.strictEqual(g.score, 1);
    assert.strictEqual(at(g), '4,3 3,3 2,3 1,3');
    assert.ok(g.food && !g.snake.some((c) => c.x === g.food.x && c.y === g.food.y));
});

test('wraps around the edges', () => {
    const g = game();
    g.food = { x: 0, y: 0 };
    g.snake = [{ x: 9, y: 3 }, { x: 8, y: 3 }, { x: 7, y: 3 }];
    assert.strictEqual(g.step(), 'move');
    assert.strictEqual(g.snake[0].x, 0);
});

test('solid walls end the game', () => {
    const g = game({ walls: 'solid' });
    g.food = { x: 0, y: 0 };
    g.snake = [{ x: 9, y: 3 }, { x: 8, y: 3 }, { x: 7, y: 3 }];
    assert.strictEqual(g.step(), 'dead');
    assert.ok(g.over);
    assert.strictEqual(g.turn('N'), false);
    assert.strictEqual(g.step(), 'dead');
});

test('running into itself ends the game, but its own tail moves away in time', () => {
    const g = game();
    g.food = { x: 9, y: 5 };
    // a ring of four: the head goes where the tail leaves
    g.snake = [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 2, y: 3 }];
    g.dir = 'S';
    assert.strictEqual(g.step(), 'move');
    // five long: the cell it turns into is still taken
    const h = game();
    h.food = { x: 9, y: 5 };
    h.snake = [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }];
    h.dir = 'S';
    assert.strictEqual(h.step(), 'dead');
});

test('a full board is a win', () => {
    const g = new Game({ cols: 2, rows: 2, rng: () => 0 });
    g.snake = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
    g.dir = 'E';
    g.food = { x: 1, y: 0 };
    assert.strictEqual(g.step(), 'won');
    assert.ok(g.over && g.won);
});

test('speeds up with every food, down to a floor', () => {
    assert.strictEqual(Game.stepMs('normal', 0), 130);
    assert.strictEqual(Game.stepMs('normal', 5), 115);
    assert.strictEqual(Game.stepMs('normal', 500), 78);
    assert.strictEqual(Game.stepMs('nonsense', 0), 130);
    assert.ok(Game.stepMs('fast', 0) < Game.stepMs('slow', 0));
});

test('best scores are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-'));
    const f = path.join(dir, 'best.json');
    assert.deepStrictEqual(loadBest(f), {});
    saveBest(f, { 'normal/wrap': 12 });
    assert.deepStrictEqual(loadBest(f), { 'normal/wrap': 12 });
    fs.writeFileSync(f, '{broken');
    assert.deepStrictEqual(loadBest(f, { warn() {} }), {});
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + e.message); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
