'use strict';
/** Lucky Sevens' rules (apps/lucky_sevens/model.js): node tests/lucky_sevens.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, DT, REELS, LINES, PAYS, COINS, SYMBOLS, STRIPS, START_CREDITS, TIMING, FREE_SPINS, FREE_MULT, JP_SEED, JP_RATE, evaluate, windowAt, scatters, outcome, loadState, saveState } = require('../apps/lucky_sevens/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = (g, ms) => { for (let t = 0; t < ms; t += DT) g.step(DT); };
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const L = STRIPS[0].length;
/** an rng that picks these stops for the next spins (5 per spin), after the 5 starting positions */
const rigged = (spins) => { const q = [0, 0, 0, 0, 0].concat(...spins).map((x) => (x + 0.5) / L); const fb = seeded(77); return () => (q.length ? q.shift() : fb()); };
/** stops that show `sym` on row `row` of every reel (and, for others, none of `avoid` in the window) */
function stopsFor(sym, row, avoid) {
    return STRIPS.map((s) => {
        for (let k = 0; k < L; k++) {
            const w = [0, 1, 2].map((r) => s[(k + r) % L]);
            if (w[row] === sym && !(avoid || []).some((a) => w.includes(a) && a !== sym)) return k;
        }
        throw new Error('no stop');
    });
}
/** stops with no WILD in the window, paying nothing */
function blank() {
    for (let t = 0; ; t++) {
        const st = [0, 1, 2, 3, 4].map((i) => (t * 7 + i * 13) % L);
        const o = outcome(st, 1, false, 0);
        if (!o.win && !o.scatter.length) return st;
    }
}
/** stops with exactly three WILDs (reels 1, 3, 5) */
function threeWilds() {
    const wildAt = (i) => STRIPS[i].indexOf('wild');
    const noWild = (i) => { for (let k = 0; k < L; k++) if (![0, 1, 2].some((r) => STRIPS[i][(k + r) % L] === 'wild')) return k; return 0; };
    return [wildAt(0), noWild(1), wildAt(2), noWild(3), wildAt(4)];
}
const settle = (g) => { while (g.spinning) g.step(DT); return g.events.splice(0); };
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

test('the machine pays back about 96 of 100 credits bet, free spins included', () => {
    // the stops are random, so the window: the pay of 300 000 random windows, and how often free spins come
    const rnd = seeded(11), N = 300000;
    let paid = 0, hits = 0, trig = 0;
    for (let i = 0; i < N; i++) {
        const o = outcome([0, 1, 2, 3, 4].map(() => Math.floor(rnd() * L)), 1, false, 0);
        paid += o.win; if (o.win) hits++; if (o.award) trig++;
    }
    const base = paid / (N * LINES.length), p = trig / N;
    const rtp = base * (1 + p * FREE_SPINS / (1 - p * FREE_SPINS) * FREE_MULT);
    assert.ok(rtp > 0.88 && rtp < 1.03, 'return ' + rtp.toFixed(3));
    assert.ok(hits / N > 0.4 && hits / N < 0.65, 'hit rate ' + (hits / N).toFixed(3));
    assert.ok(1 / p > 150 && 1 / p < 400, 'free spins 1 in ' + (1 / p).toFixed(0));
});

test('three WILDs anywhere: ten free spins at the bet that won them, wins paid twice', () => {
    const blk = blank(), cherries = stopsFor('cherry', 1, ['wild']);
    const g = new Game({ credits: 1000, coin: 5, rng: rigged([threeWilds(), cherries, blk]) });
    g.spin();
    assert.strictEqual(g.result.scatter.length, 3);
    const ev = settle(g);
    assert.ok(ev.some((e) => e.type === 'free' && e.award === FREE_SPINS && !e.again));
    assert.strictEqual(g.free.left, FREE_SPINS);
    assert.strictEqual(g.stats.freeRounds, 1);
    assert.ok(!g.betUp() && !g.betDown() && !g.maxBet());      // the bet stays
    const before = g.credits;
    g.spin();
    assert.strictEqual(g.credits, before);                       // nothing paid
    assert.strictEqual(g.free.left, FREE_SPINS - 1);
    assert.ok(g.result.free);
    settle(g);
    const single = outcome(cherries, 5, false, 0).win;
    assert.ok(single > 0);
    assert.strictEqual(g.credits, before + single * FREE_MULT);
    assert.strictEqual(g.free.won, single * FREE_MULT);
});

test('free spins: WILDs again give more; the round ends with what it won', () => {
    const blk = blank();
    const g = new Game({ credits: 1000, rng: rigged([threeWilds(), threeWilds(), ...Array(30).fill(blk)]) });
    g.spin(); settle(g);
    g.spin(); const ev = settle(g);
    assert.ok(ev.some((e) => e.type === 'free' && e.again));
    assert.strictEqual(g.free.left, 2 * FREE_SPINS - 1);
    assert.strictEqual(g.free.total, 2 * FREE_SPINS);
    assert.strictEqual(g.stats.freeRounds, 1);
    let end = null;
    for (let i = 0; i < 30 && !end; i++) { assert.ok(g.spin()); end = settle(g).find((e) => e.type === 'freeEnd'); }
    assert.ok(end, 'no end');
    assert.strictEqual(end.spins, 2 * FREE_SPINS);
    assert.strictEqual(g.free.left, 0);
    assert.strictEqual(g.credits, 1000 - 10 + outcome(threeWilds(), 1, false, 0).win + end.won);   // one paid spin at the smallest bet
});

test('the jackpot grows with every paid bet, not with free spins', () => {
    const g = new Game({ credits: 100000, coin: 50, rng: rigged([blank(), threeWilds(), blank()]) });
    assert.strictEqual(g.jackpot, JP_SEED);
    g.spin(); settle(g);
    assert.strictEqual(g.jackpot, JP_SEED + 500 * JP_RATE);
    g.spin(); settle(g);
    const pot = g.jackpot;
    g.spin(); settle(g);                                         // a free spin
    assert.strictEqual(g.jackpot, pot);
});

test('five sevens (no WILD) win the jackpot: all of it at 50 per line, a share below', () => {
    const sevens = stopsFor('seven', 1, ['wild']);
    const o = outcome(sevens, 50, false, 20000);
    assert.strictEqual(o.jackpotWin, 20000);
    assert.strictEqual(outcome(sevens, 5, false, 20000).jackpotWin, 2000);
    assert.strictEqual(o.level, 'mega');
    const g = new Game({ credits: 1000, coin: 50, jackpot: 30000, rng: rigged([sevens]) });
    g.spin();
    const pot = g.jackpot, line = g.result.win;
    const ev = settle(g);
    assert.ok(ev.some((e) => e.type === 'jackpot' && e.amount === Math.floor(pot)));
    assert.strictEqual(g.credits, 1000 - 500 + line + Math.floor(pot));
    assert.strictEqual(g.jackpot, JP_SEED);                      // back to the seed
    assert.strictEqual(g.stats.jackpots, 1);
    // a smaller bet takes its share; the pot keeps the rest
    const h = new Game({ credits: 1000, coin: 5, jackpot: 30000, rng: rigged([sevens]) });
    h.spin(); settle(h);
    assert.ok(Math.abs(h.jackpot - (30000 + 0.5 - Math.floor(30000.5 / 10))) < 1e-6);
    // a WILD among the sevens pays the line, not the jackpot
    const w = windowAt(sevens).map((c) => c.slice());
    w[2][1] = 'wild';
    assert.ok(evaluate(w).some((x) => x.sym === 'seven' && x.count === 5));
});

test('statistics: spins, bet, won, best win, the longest run of paying spins', () => {
    const pay = stopsFor('cherry', 1, ['wild']), blk = blank();
    const g = new Game({ credits: 1000, rng: rigged([pay, pay, blk, pay, pay, pay, blk]) });
    for (let i = 0; i < 7; i++) { g.spin(); settle(g); }
    const st = g.stats, w = outcome(pay, 1, false, 0).win;
    assert.strictEqual(st.spins, 7);
    assert.strictEqual(st.bet, 70);
    assert.strictEqual(st.won, 5 * w);
    assert.strictEqual(st.bestWin, w);
    assert.strictEqual(st.bestStreak, 3);
    assert.strictEqual(st.streak, 0);
    // kept between drives
    const h = new Game(JSON.parse(JSON.stringify(g.toJSON())));
    assert.deepStrictEqual(h.stats, st);
    assert.strictEqual(h.credits, g.credits);
    assert.strictEqual(h.jackpot, g.jackpot);
});

test('free spins left are kept between drives', () => {
    const g = new Game({ credits: 1000, coin: 2, rng: rigged([threeWilds()]) });
    g.spin(); settle(g);
    const h = new Game(JSON.parse(JSON.stringify(g.toJSON())));
    assert.strictEqual(h.free.left, FREE_SPINS);
    assert.strictEqual(h.coin(), 2);
    assert.ok(h.canSpin());
});

test('many spins in a row: never stuck, credits add up', () => {
    const g = new Game({ rng: seeded(21), credits: 100000 });
    let bets = 0, wins = 0;
    for (let i = 0; i < 300; i++) {
        const free = g.free.left > 0;
        assert.ok(g.spin(), 'spin ' + i);
        if (!free) bets += g.result.bet;
        wins += g.result.win + g.result.jackpotWin;
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
