'use strict';
/**
 * Lucky Sevens' rules, without drawing or the car (tested in tests/lucky_sevens.test.js).
 *
 *   const g = new Game({ credits: 1000, coin: 1 });
 *   g.spin()                      // pay the bet, pick where the reels stop, set them spinning
 *   g.step(DT)                    // advance the reels DT ms (main.js steps them at 60 Hz)
 *   g.slam()                      // stop the spinning reels now (one after the other, quickly)
 *   g.events.splice(0)            // what happened, for the drawing: spin, a reel stopped, the win
 *
 * Five reels, three rows, ten paylines. The reels spin downwards; reel.pos is the strip index of the
 * symbol in the top row (a float while spinning). Each reel winds up a little, speeds up, runs, and
 * stops on the stop picked at the spin with a small overshoot (the bounce), one after the other.
 * Wins pay left to right on a line, from the first reel: three or more of a symbol (cherries: two),
 * WILD standing in for any symbol. A line pays its best: the symbol's run or the WILDs' own run.
 *
 * Free spins: three WILDs or more anywhere in the window (a scatter) give FREE_SPINS free spins at the
 * bet that won them, every win paid twice; WILDs again in a free spin give FREE_SPINS more.
 *
 * The progressive jackpot: every paid bet adds JP_RATE of itself to a pot that starts at JP_SEED. Five
 * sevens on a payline (sevens only, no WILD) win it: all of it at the largest bet per line, a share of
 * it at a smaller one (bet per line / largest); what is won leaves the pot, which never drops below
 * JP_SEED. The jackpot comes on top of the line's own pay and isn't doubled in free spins.
 *
 * Statistics are kept with the credits: spins, credits bet and won, the best win, the longest run of
 * spins in a row that paid, free spin rounds, jackpots.
 *
 * Credits are play credits, nothing else: they start at START_CREDITS, and a player who can't pay the
 * smallest bet gets START_CREDITS again (refill()).
 */
const DT = 1000 / 60;
const REELS = 5, ROWS = 3;
const START_CREDITS = 1000;
const COINS = [1, 2, 5, 10, 20, 50];                     // credits per line
const SYMBOLS = ['cherry', 'lemon', 'bell', 'bar', 'diamond', 'seven', 'wild'];

// rows of the payline on reels 1..5 (0 = top)
const LINES = [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
    [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1],
    [1, 2, 1, 0, 1],
];

// pays per line, in coins, for a run of 2..5 from the first reel
const PAYS = {
    cherry: { 2: 2, 3: 5, 4: 16, 5: 45 },
    lemon: { 3: 5, 4: 20, 5: 70 },
    bell: { 3: 9, 4: 28, 5: 90 },
    bar: { 3: 14, 4: 45, 5: 140 },
    diamond: { 3: 23, 4: 75, 5: 280 },
    seven: { 3: 46, 4: 185, 5: 900 },
    wild: { 3: 40, 4: 150, 5: 2000 },
};
const FREE_SPINS = 10, FREE_MULT = 2, SCATTER = 3;      // WILDs anywhere for free spins, how many, wins times
const JP_SEED = 10000, JP_RATE = 0.01;                   // the jackpot's pot: where it starts, the share of a bet it gets
const STATS = { spins: 0, bet: 0, won: 0, bestWin: 0, streak: 0, bestStreak: 0, freeRounds: 0, jackpots: 0, bestJackpot: 0 };
const BIG = 15, MEGA = 50;                               // a win of this many times the bet is a big / mega win

// symbols on each reel's strip (the same mix on every reel, laid out differently)
const MIX = { cherry: 8, lemon: 8, bell: 7, bar: 6, diamond: 5, seven: 4, wild: 1 };

/** a reel strip: the symbols of MIX spread out (a fixed shuffle per reel: the same strips every game) */
function strip(n) {
    const out = [];
    for (const s of SYMBOLS) for (let i = 0; i < MIX[s]; i++) out.push(s);
    let seed = 97 + n * 7919;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = out[i]; out[i] = out[j]; out[j] = t; }
    // no symbol twice in a row on the strip (it looks like a stuck reel)
    for (let k = 0; k < 4; k++) {
        for (let i = 0; i < out.length; i++) {
            const j = (i + 1) % out.length;
            if (out[i] !== out[j]) continue;
            const m = out.findIndex((s, q) => s !== out[i] && out[(q + out.length - 1) % out.length] !== out[i] && out[(q + 1) % out.length] !== out[i]);
            if (m >= 0) { const t = out[j]; out[j] = out[m]; out[m] = t; }
        }
    }
    return out;
}
const STRIPS = Array.from({ length: REELS }, (_, i) => strip(i));
const L = STRIPS[0].length;

const mod = (a, n) => ((a % n) + n) % n;

/** the payline wins of a 5 x 3 window (window[reel][row]), in coins */
function evaluate(win) {
    const out = [];
    LINES.forEach((rows, li) => {
        const syms = rows.map((r, i) => win[i][r]);
        let lead = 0;
        while (lead < REELS && syms[lead] === 'wild') lead++;
        const s = lead < REELS ? syms[lead] : 'wild';
        let n = lead;
        while (n < REELS && (syms[n] === s || syms[n] === 'wild')) n++;
        const pay = (PAYS[s] && PAYS[s][n]) || 0, wildPay = PAYS.wild[lead] || 0;
        if (wildPay > pay) out.push({ line: li, sym: 'wild', count: lead, pay: wildPay });
        else if (pay) out.push({ line: li, sym: s, count: n, pay });
    });
    return out;
}

/* ---------- a reel's motion ---------- */
const WIND = { ms: 110, back: 0.28 };                    // the wind-up: a little up before it goes
const ACCEL_MS = 160, DECEL_MS = 380;
const C1 = 1.7, C3 = C1 + 1;                             // the stop's overshoot (ease out back)
const backOut = (u) => 1 + C3 * Math.pow(u - 1, 3) + C1 * Math.pow(u - 1, 2);
const backOutV = (u) => 3 * C3 * Math.pow(u - 1, 2) + 2 * C1 * (u - 1);
const TIMING = { normal: { first: 900, next: 260, v: 0.024 }, fast: { first: 720, next: 150, v: 0.03 } };

/**
 * A plan: from p0 (after the wind-up, if any) accelerate to v over a ms, run c ms, then stop dd further on
 * over e ms. pos decreases (the strip runs downwards).
 */
function plan(start, p0, wind, v, a, c, e, dd) { return { start, p0, wind, v, a, c, e, dd }; }
function planPos(P, t) {
    let u = t - P.start;
    if (P.wind) {
        if (u < WIND.ms) return P.p0 - WIND.back + WIND.back * Math.sin(Math.PI / 2 * u / WIND.ms);
        u -= WIND.ms;
    }
    if (u < P.a) return P.p0 - P.v * u * u / (2 * P.a);
    const pa = P.p0 - P.v * P.a / 2;
    if (u < P.a + P.c) return pa - P.v * (u - P.a);
    const pc = pa - P.v * P.c;
    if (u < P.a + P.c + P.e) return pc - P.dd * backOut((u - P.a - P.c) / P.e);
    return pc - P.dd;
}
/** symbols per ms (positive: downwards) */
function planSpeed(P, t) {
    let u = t - P.start;
    if (P.wind) { if (u < WIND.ms) return -WIND.back * Math.PI / 2 / WIND.ms * Math.cos(Math.PI / 2 * u / WIND.ms); u -= WIND.ms; }
    if (u < P.a) return P.v * u / P.a;
    if (u < P.a + P.c) return P.v;
    if (u < P.a + P.c + P.e) return P.dd / P.e * backOutV((u - P.a - P.c) / P.e);
    return 0;
}
const planEnd = (P) => P.start + (P.wind ? WIND.ms : 0) + P.a + P.c + P.e;

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.timing = TIMING[o.speed] || TIMING.normal;
        this.credits = Number.isFinite(o.credits) ? Math.max(0, Math.floor(o.credits)) : START_CREDITS;
        this.coinIx = Math.max(0, COINS.indexOf(o.coin));
        this.jackpot = Math.max(JP_SEED, Number(o.jackpot) || 0);
        this.stats = Object.assign({}, STATS);
        for (const k of Object.keys(STATS)) if (o.stats && Number.isFinite(o.stats[k])) this.stats[k] = o.stats[k];
        // free spins: left, at which coin, won so far in the round
        this.free = { left: Math.max(0, Math.floor(Number(o.free && o.free.left) || 0)), coin: COINS.includes(o.free && o.free.coin) ? o.free.coin : COINS[0], won: Number(o.free && o.free.won) || 0, total: 0 };
        this.free.total = this.free.left;
        this.t = 0;
        this.reels = STRIPS.map((s, i) => ({ pos: mod(Math.floor(this.rng() * L), L), stopped: true, plan: null, target: 0, i }));
        this.spinning = false;
        this.result = null;        // the last spin: { stops, window, wins, win, bet, level }
        this.spins = 0;
        this.events = [];
    }
    coin() { return this.free.left > 0 ? this.free.coin : COINS[this.coinIx]; }
    bet() { return this.coin() * LINES.length; }
    inFree() { return this.free.left > 0 || !!(this.result && this.result.free && this.spinning); }
    canSpin() { return !this.spinning && (this.free.left > 0 || this.credits >= this.bet()); }
    /** the bet one step up / down (not while the reels spin or in free spins); stays on the largest the credits pay for */
    betUp() { if (this.spinning || this.free.left || this.coinIx >= COINS.length - 1) return false; this.coinIx++; return true; }
    betDown() { if (this.spinning || this.free.left || this.coinIx <= 0) return false; this.coinIx--; return true; }
    /** what five sevens would win now at this bet */
    jackpotShare() { return Math.floor(this.jackpot * this.coin() / COINS[COINS.length - 1]); }
    /** largest bet the credits pay for (for the "max bet" button) */
    maxBet() {
        if (this.spinning || this.free.left) return false;
        let i = COINS.length - 1;
        while (i > 0 && COINS[i] * LINES.length > this.credits) i--;
        this.coinIx = i;
        return true;
    }
    /** out of credits: start again with START_CREDITS */
    broke() { return !this.spinning && !this.free.left && this.credits < COINS[0] * LINES.length; }
    refill() { if (!this.broke()) return false; this.credits = START_CREDITS; this.coinIx = 0; this.events.push({ type: 'refill' }); return true; }

    spin() {
        if (this.spinning) return false;
        const free = this.free.left > 0;
        if (!free && this.credits < this.bet()) {
            // a bet too big for what's left: the largest one that fits
            if (this.broke()) { this.events.push({ type: 'broke' }); return false; }
            this.maxBet();
        }
        const bet = this.bet(), coin = this.coin();
        if (free) this.free.left--;
        else { this.credits -= bet; this.jackpot = Math.round((this.jackpot + bet * JP_RATE) * 100) / 100; this.stats.bet += bet; }
        this.spins++;
        this.stats.spins++;
        const stops = this.reels.map(() => Math.floor(this.rng() * L));
        this.result = outcome(stops, coin, free, this.jackpot);
        this.result.bet = bet;
        this.result.left = this.free.left;
        const T = this.timing;
        this.reels.forEach((r, i) => {
            const p0 = r.pos, total = T.first + i * T.next;      // when it should stand
            const run = total - WIND.ms;
            // the distance: about what speed v covers in that time, landing on the stop
            const want = T.v * (ACCEL_MS / 2 + (run - ACCEL_MS - DECEL_MS) + DECEL_MS / (C1 + 3));
            let d = mod(p0 - stops[i], L);
            while (d < want - L / 2) d += L;
            // the speed that makes it in exactly that time with this distance
            const v = d / (ACCEL_MS / 2 + (run - ACCEL_MS - DECEL_MS) + DECEL_MS / (C1 + 3));
            const dd = v * DECEL_MS / (C1 + 3);
            r.plan = plan(this.t, p0, true, v, ACCEL_MS, run - ACCEL_MS - DECEL_MS, DECEL_MS, dd);
            r.target = stops[i];
            r.stopped = false;
        });
        this.spinning = true;
        this.events.push({ type: 'spin', bet });
        return true;
    }

    /** stop now: every reel still running goes into its stop at once, a moment after the one before */
    slam() {
        if (!this.spinning) return false;
        let k = 0;
        for (const r of this.reels) {
            if (r.stopped) continue;
            const P = r.plan, u = this.t - P.start - (P.wind ? WIND.ms : 0);
            if (u >= P.a + P.c) continue;                        // already stopping
            const v = Math.max(planSpeed(P, this.t), this.timing.v * 0.6);
            const lag = k++ * 90;                                // they still stop in order
            // the strip jumps (unseen in the blur) to where it reaches its stop after lag ms and a stop
            const dd = v * DECEL_MS / (C1 + 3);
            r.plan = plan(this.t, r.target + v * lag + dd, false, v, 0, lag, DECEL_MS, dd);
        }
        return true;
    }

    step(dt) {
        this.t += dt;
        if (!this.spinning) return;
        let all = true;
        for (const r of this.reels) {
            if (r.stopped) continue;
            if (this.t >= planEnd(r.plan)) {
                r.pos = r.target; r.stopped = true;
                this.events.push({ type: 'stop', reel: r.i, last: this.reels.every((q) => q.stopped) });
            } else { r.pos = mod(planPos(r.plan, this.t), L); all = false; }
        }
        if (!all) return;
        this.spinning = false;
        const res = this.result, st = this.stats, total = res.win + res.jackpotWin;
        this.credits += total;
        st.won += total;
        st.bestWin = Math.max(st.bestWin, total);
        st.streak = total > 0 ? st.streak + 1 : 0;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
        if (res.jackpotWin) {
            this.jackpot = Math.max(JP_SEED, this.jackpot - res.jackpotWin);
            st.jackpots++; st.bestJackpot = Math.max(st.bestJackpot, res.jackpotWin);
            this.events.push({ type: 'jackpot', amount: res.jackpotWin });
        }
        if (res.free) this.free.won += total;
        if (total > 0) this.events.push({ type: 'win', amount: total, level: res.level, wins: res.wins, jackpot: !!res.jackpotWin, free: res.free });
        if (res.award) {
            // a new round (its bet stays), or more spins in this one
            const again = res.free;
            if (!again) { this.free.coin = COINS[this.coinIx]; this.free.won = 0; this.free.total = 0; st.freeRounds++; }
            this.free.left += res.award; this.free.total += res.award;
            this.events.push({ type: 'free', award: res.award, again, scatter: res.scatter });
        } else if (res.free && this.free.left === 0) this.events.push({ type: 'freeEnd', won: this.free.won, spins: this.free.total });
        this.events.push({ type: 'done' });
    }
    /** what to keep between drives */
    toJSON() { return { credits: this.credits, coin: COINS[this.coinIx], jackpot: this.jackpot, stats: this.stats, free: { left: this.free.left, coin: this.free.coin, won: this.free.won } }; }

    /** symbols per ms reel i runs at now (for the motion blur) */
    speed(i) { const r = this.reels[i]; return r.stopped ? 0 : planSpeed(r.plan, this.t); }
    /** the reel's symbol k rows below the top row (k may be -1 or 3: the ones half out of sight) */
    symbolAt(i, k) { return STRIPS[i][mod(Math.floor(this.reels[i].pos) + k, L)]; }
    window() { return windowAt(this.reels.map((r) => Math.round(r.pos))); }
}

function windowAt(stops) { return stops.map((s, i) => [0, 1, 2].map((k) => STRIPS[i][mod(s + k, L)])); }

/** the WILDs in a window: [reel, row] of each */
function scatters(win) { const out = []; win.forEach((col, i) => col.forEach((s, r) => { if (s === 'wild') out.push([i, r]); })); return out; }
/** lines with five sevens and no WILD: the jackpot */
const jackpotLine = (win, w) => w.count === 5 && LINES[w.line].every((r, i) => win[i][r] === 'seven');

/** what a spin on these stops pays: line wins (twice in free spins), the jackpot, free spins */
function outcome(stops, coin, free, pot) {
    const win = windowAt(stops), wins = evaluate(win), sc = scatters(win);
    const amount = wins.reduce((a, w) => a + w.pay, 0) * coin * (free ? FREE_MULT : 1);
    const jp = wins.some((w) => jackpotLine(win, w)) ? Math.floor(pot * coin / COINS[COINS.length - 1]) : 0;
    const bet = coin * LINES.length, total = amount + jp;
    return {
        stops, window: win, wins, win: amount, jackpotWin: jp, free, award: sc.length >= SCATTER ? FREE_SPINS : 0, scatter: sc,
        level: total >= MEGA * bet ? 'mega' : total >= BIG * bet ? 'big' : total > 0 ? 'win' : 'none',
    };
}

function loadState(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('lucky_sevens: state not read: ' + e.message);
        return {};
    }
}
function saveState(file, st) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(st));
    fs.renameSync(file + '.tmp', file);
}

module.exports = {
    Game, DT, REELS, ROWS, LINES, PAYS, COINS, SYMBOLS, STRIPS, START_CREDITS, BIG, MEGA, TIMING,
    FREE_SPINS, FREE_MULT, SCATTER, JP_SEED, JP_RATE,
    evaluate, windowAt, scatters, outcome, loadState, saveState,
};
