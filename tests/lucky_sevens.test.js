'use strict';
/** Lucky Sevens' rules (apps/lucky_sevens/model.js): node tests/lucky_sevens.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, DT, REELS, LINES, PAYS, COINS, SYMBOLS, STRIPS, START_CREDITS, TIMING, evaluate, windowAt, loadState, saveState } = require('../apps/lucky_sevens/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = (g, ms) => { for (let t = 0; t < ms; t += DT) g.step(DT); };
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
/** a window with `fill` everywhere, then the given cells: [reel, row, symbol] */
const grid = (fill, cells) => { const w = Array.from({ length: REELS }, () => [fill, fill, fill]); for (const [i, r, s] of cells || []) w[i][r] = s; return w; };
/** a filler that pays nothing next to anything: every reel a different symbol */
const none = () => [['lemon', 'bell', 'bar'], ['bar', 'lemon', 'bell'], ['bell', 'bar', 'lemon'], ['diamond', 'diamond', 'diamond'], ['seven', 'seven', 'seven']];

test('every reel strip has the same mix of symbols, never one twice in a row', () => {
    const count = (s) => { const c = {}; for (const x of s) c[x] = (c[x] || 0) + 1; return c; };
    for (const s of STRIPS) {
        assert.deepStrictEqual(count(s), count(STRIPS[0]));
        for (const x of s) assert.ok(SYMBOLS.includes(x));
        for (let i = 0; i < s.length; i++) assert.notStrictEqual(s[i], s[(i + 1) % s.length], 'twice at ' + i);
    }
    assert.ok(STRIPS.some((s, i) => i > 0 && s.join() !== STRIPS[0].join()), 'the reels are laid out differently');
});

test('a payline pays a run from the first reel, three or more', () => {
    const w = none();
    [0, 1, 2].forEach((i) => { w[i][1] = 'bell'; });
    w[3][1] = 'bar';
    const wins = evaluate(w);
    assert.deepStrictEqual(wins.filter((x) => x.line === 0), [{ line: 0, sym: 'bell', count: 3, pay: PAYS.bell[3] }]);
    // the same three, but not from the first reel: nothing
    const v = none();
    [1, 2, 3].forEach((i) => { v[i][1] = 'bell'; });
    v[0][1] = 'bar';
    assert.ok(!evaluate(v).some((x) => x.line === 0));
});

test('cherries pay from two', () => {
    const w = none();
    w[0][1] = 'cherry'; w[1][1] = 'cherry';
    assert.ok(evaluate(w).some((x) => x.line === 0 && x.sym === 'cherry' && x.count === 2 && x.pay === PAYS.cherry[2]));
});

test('WILD stands in for any symbol, also leading the line', () => {
    const w = none();
    w[0][1] = 'wild'; w[1][1] = 'seven'; w[2][1] = 'wild'; w[3][1] = 'seven'; w[4][1] = 'bar';
    const x = evaluate(w).find((q) => q.line === 0);
    assert.deepStrictEqual(x, { line: 0, sym: 'seven', count: 4, pay: PAYS.seven[4] });
});

test('a line pays its best: the WILDs\' own run when it is worth more', () => {
    const w = none();
    w[0][1] = 'wild'; w[1][1] = 'wild'; w[2][1] = 'wild'; w[3][1] = 'lemon'; w[4][1] = 'bar';
    // wild x3 (40) beats lemon x4 (22)
    assert.deepStrictEqual(evaluate(w).find((q) => q.line === 0), { line: 0, sym: 'wild', count: 3, pay: PAYS.wild[3] });
    assert.deepStrictEqual(evaluate(grid('wild')).map((q) => q.pay), LINES.map(() => PAYS.wild[5]));
});

test('every payline is read on its own rows', () => {
    // a V of sevens: line 4 (0,1,2,1,0) pays five, the middle line only one in a row
    const w = none();
    LINES[3].forEach((r, i) => { w[i][r] = 'seven'; });
    const wins = evaluate(w);
    assert.ok(wins.some((x) => x.line === 3 && x.sym === 'seven' && x.count === 5 && x.pay === PAYS.seven[5]));
});

test('a spin pays the bet, the reels stop one after the other on the stops picked', () => {
    const g = new Game({ rng: seeded(3), credits: 1000, coin: 2 });
    assert.strictEqual(g.bet(), 2 * LINES.length);
    assert.ok(g.spin());
    assert.strictEqual(g.credits, 1000 - g.bet());
    assert.strictEqual(g.spin(), false);                     // not while spinning
    const order = [];
    for (let t = 0; t < 4000 && g.spinning; t += DT) { g.step(DT); for (const e of g.events.splice(0)) if (e.type === 'stop') order.push([e.reel, Math.round(g.t)]); }
    assert.ok(!g.spinning);
    assert.deepStrictEqual(order.map((x) => x[0]), [0, 1, 2, 3, 4]);
    for (let i = 1; i < 5; i++) assert.ok(order[i][1] - order[i - 1][1] >= TIMING.normal.next - DT * 2);
    assert.deepStrictEqual(g.reels.map((r) => r.pos), g.result.stops);
    assert.deepStrictEqual(g.window(), g.result.window);
    assert.strictEqual(g.credits, 1000 - g.bet() + g.result.win);
});

test('a win is paid when the last reel stops, in coins of the bet per line', () => {
    let s = 1, found = null;
    for (; s < 400 && !found; s++) { const g = new Game({ rng: seeded(s), credits: 1000, coin: 5 }); g.spin(); if (g.result.win > 0) found = g; }
    assert.ok(found, 'a winning spin');
    const g = found, before = g.credits;
    assert.strictEqual(g.result.win, g.result.wins.reduce((a, w) => a + w.pay, 0) * 5);
    run(g, 200);
    assert.strictEqual(g.credits, before);                    // not yet
    run(g, 4000);
    assert.strictEqual(g.credits, before + g.result.win);
    assert.ok(g.events.some((e) => e.type === 'win' && e.amount === g.result.win));
});

test('a stopping reel runs a little past its stop and comes back (the bounce)', () => {
    const g = new Game({ rng: seeded(9) });
    g.spin();
    const r = g.reels[0], P = r.plan, end = P.start + 110 + P.a + P.c + P.e;
    // the end of the stop: the strip has gone past the stop and moves back to it
    const L = STRIPS[0].length, d = (x) => ((x - r.target) % L + L) % L;
    let back = false;
    for (let t = end - P.e * 0.3; t < end; t += 5) {
        g.t = t; g.step(0);
        if (d(r.pos) > L / 2) back = true;                    // beyond the stop (pos below the target)
    }
    assert.ok(back, 'no overshoot');
});

test('slam stops the reels much sooner, still in order and on their stops', () => {
    const a = new Game({ rng: seeded(5) }), b = new Game({ rng: seeded(5) });
    a.spin(); b.spin();
    run(a, 200); run(b, 200);
    assert.ok(b.slam());
    let ta = 0, tb = 0;
    while (a.spinning) { a.step(DT); ta += DT; }
    const order = [];
    while (b.spinning) { b.step(DT); tb += DT; for (const e of b.events.splice(0)) if (e.type === 'stop') order.push(e.reel); }
    assert.ok(tb < ta - 400, 'slam ' + tb + ' vs ' + ta);
    assert.deepStrictEqual(order, [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(b.reels.map((r) => r.pos), b.result.stops);
    assert.deepStrictEqual(b.result.stops, a.result.stops);
});

test('fast reels stand sooner', () => {
    const a = new Game({ rng: seeded(2) }), b = new Game({ rng: seeded(2), speed: 'fast' });
    a.spin(); b.spin();
    let ta = 0, tb = 0;
    while (a.spinning) { a.step(DT); ta += DT; }
    while (b.spinning) { b.step(DT); tb += DT; }
    assert.ok(tb < ta - 300);
});

test('the bet: up and down within the coins, not while spinning; max bet fits the credits', () => {
    const g = new Game({ credits: 700 });
    assert.strictEqual(g.coin(), COINS[0]);
    assert.ok(!g.betDown());
    while (g.betUp());
    assert.strictEqual(g.coin(), COINS[COINS.length - 1]);
    g.maxBet();
    assert.ok(g.bet() <= 700);
    assert.strictEqual(g.coin(), 50);                         // 50 x 10 = 500 fits, the next would not
    g.spin();
    assert.ok(!g.betUp() && !g.betDown());
});

test('a bet larger than the credits spins the largest that fits', () => {
    const g = new Game({ credits: 120, coin: 50, rng: seeded(4) });
    assert.ok(g.spin());
    assert.strictEqual(g.result.bet, 100);
    assert.strictEqual(g.credits, 20);
});

test('out of credits: no spin, a refill gives the starting credits', () => {
    const g = new Game({ credits: 5 });
    assert.ok(g.broke());
    assert.strictEqual(g.spin(), false);
    assert.ok(g.events.some((e) => e.type === 'broke'));
    assert.ok(g.refill());
    assert.strictEqual(g.credits, START_CREDITS);
    assert.ok(!g.refill());
});

test('the machine pays back about 96 of 100 credits bet', () => {
    // the stops are random, so the window: the pay of 300 000 random windows
    const rnd = seeded(11), L = STRIPS[0].length, N = 300000;
    let paid = 0, hits = 0;
    for (let i = 0; i < N; i++) {
        const c = evaluate(windowAt([0, 1, 2, 3, 4].map(() => Math.floor(rnd() * L)))).reduce((a, w) => a + w.pay, 0);
        paid += c; if (c) hits++;
    }
    const rtp = paid / (N * LINES.length);
    assert.ok(rtp > 0.88 && rtp < 1.04, 'return ' + rtp.toFixed(3));
    assert.ok(hits / N > 0.4 && hits / N < 0.65, 'hit rate ' + (hits / N).toFixed(3));
});

test('many spins in a row: never stuck, credits add up', () => {
    const g = new Game({ rng: seeded(21), credits: 100000 });
    let bets = 0, wins = 0;
    for (let i = 0; i < 300; i++) {
        assert.ok(g.spin(), 'spin ' + i);
        bets += g.result.bet; wins += g.result.win;
        if (i % 3 === 0) { run(g, 300); g.slam(); }
        run(g, 3000);
        assert.ok(!g.spinning, 'still spinning after ' + i);
        assert.deepStrictEqual(g.window(), g.result.window);
    }
    assert.strictEqual(g.credits, 100000 - bets + wins);
});

test('credits, bet and best win are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
    const f = path.join(dir, 'state.json');
    assert.deepStrictEqual(loadState(f), {});
    saveState(f, { credits: 4200, coin: 5, bestWin: 900 });
    const st = loadState(f);
    assert.deepStrictEqual(st, { credits: 4200, coin: 5, bestWin: 900 });
    const g = new Game({ credits: st.credits, coin: st.coin });
    assert.strictEqual(g.credits, 4200);
    assert.strictEqual(g.bet(), 50);
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
