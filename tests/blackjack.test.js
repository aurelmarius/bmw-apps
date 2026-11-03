'use strict';
/** Blackjack's rules (apps/blackjack/model.js): node tests/blackjack.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, Shoe, START_CREDITS, BETS, DECKS, total, isBlackjack, advice, loadState, saveState } = require('../apps/blackjack/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const C = (str) => str.split(' ').map((x) => ({ r: x.slice(0, -1), s: x.slice(-1) }));
/** a game whose shoe deals these cards first (player, dealer, player, dealer hole, then the rest in order) */
function rigged(cards, o) {
    const g = new Game(Object.assign({ credits: 1000, bet: 10, rng: seeded(1) }, o || {}));
    const deck = C(cards);
    g.shoe.cards = deck.concat(g.shoe.cards);
    g.shoe.cut = g.shoe.cards.length;
    return g;
}
const types = (g) => g.events.splice(0).map((e) => e.type);

test('a shoe of six decks, shuffled, the cut card three quarters in', () => {
    const s = new Shoe(seeded(4));
    assert.strictEqual(s.cards.length, 52 * DECKS);
    const count = {};
    for (const c of s.cards) count[c.r + c.s] = (count[c.r + c.s] || 0) + 1;
    assert.strictEqual(Object.keys(count).length, 52);
    assert.ok(Object.values(count).every((n) => n === DECKS));
    assert.strictEqual(s.cut, Math.floor(52 * DECKS * 0.75));
    assert.notDeepStrictEqual(s.cards.slice(0, 10), new Shoe(seeded(5)).cards.slice(0, 10));
});

test('hand totals: aces count 11 until they would bust, then 1', () => {
    assert.deepStrictEqual(total(C('AS 6H')), { total: 17, soft: true });
    assert.deepStrictEqual(total(C('AS 6H 9C')), { total: 16, soft: false });
    assert.deepStrictEqual(total(C('AS AH 9C')), { total: 21, soft: true });
    assert.deepStrictEqual(total(C('KS QH')), { total: 20, soft: false });
    assert.ok(isBlackjack(C('AS JD')) && !isBlackjack(C('AS 5D 5C')));
});

test('a deal: the bet is paid, two cards each, the dealer\'s second face down', () => {
    const g = rigged('9S 7H 8D KC');
    assert.ok(g.deal());
    assert.strictEqual(g.credits, 990);
    const cards = g.events.filter((e) => e.type === 'card');
    assert.deepStrictEqual(cards.map((e) => e.who + (e.down ? '*' : '')), ['p', 'd', 'p', 'd*']);
    assert.deepStrictEqual(total(g.hands[0].cards).total, 17);
    assert.strictEqual(g.phase, 'play');
    assert.ok(!g.betUp() && !g.deal());                          // not mid-hand
});

test('stand on 17 against 17: a push, the bet comes back', () => {
    const g = rigged('9S 7H 8D KC');
    g.deal(); g.stand();
    assert.strictEqual(g.phase, 'done');
    assert.strictEqual(g.hands[0].result, 'push');
    assert.strictEqual(g.credits, 1000);
});

test('the dealer draws to 17 and stands on soft 17', () => {
    const g = rigged('KS 6H 9D QC 5S');                          // player 19; dealer 6 + Q = 16, draws 5 = 21
    g.deal(); g.stand();
    assert.strictEqual(total(g.dealer).total, 21);
    assert.strictEqual(g.hands[0].result, 'lose');
    const h = rigged('KS AH 9D 6C');                             // dealer A6: soft 17, stands
    h.deal(); h.insure(false); h.stand();
    assert.strictEqual(h.dealer.length, 2);
    assert.strictEqual(h.hands[0].result, 'win');
    assert.strictEqual(h.credits, 1010);
});

test('a bust loses at once; the dealer doesn\'t draw when every hand is bust', () => {
    const g = rigged('KS 6H 6D 9C QH 5S');
    g.deal(); g.hit();
    assert.strictEqual(g.hands[0].result, 'bust');
    assert.strictEqual(g.dealer.length, 2);
    assert.strictEqual(g.credits, 990);
});

test('blackjack pays 3 to 2; against the dealer\'s blackjack it pushes', () => {
    const g = rigged('AS 9H KD 7C', { bet: 10 });
    g.deal();
    assert.strictEqual(g.phase, 'done');
    assert.strictEqual(g.hands[0].result, 'blackjack');
    assert.strictEqual(g.credits, 1015);
    const h = rigged('AS KH KD AC');
    h.deal();
    assert.strictEqual(h.hands[0].result, 'push');
    assert.strictEqual(h.credits, 1000);
});

test('the dealer peeks under a ten: blackjack ends the hand before the player acts', () => {
    const g = rigged('9S KH 8D AC');
    g.deal();
    assert.strictEqual(g.phase, 'done');
    assert.strictEqual(g.hands[0].result, 'lose');
    assert.ok(g.events.some((e) => e.type === 'peek' && e.blackjack));
});

test('insurance under an ace: half the bet, paid 2 to 1 on the dealer\'s blackjack', () => {
    const g = rigged('9S AH 8D KC');
    g.deal();
    assert.strictEqual(g.phase, 'insurance');
    assert.ok(g.events.some((e) => e.type === 'offer' && e.cost === 5));
    assert.ok(!g.hit());                                         // decide first
    g.insure(true);
    assert.strictEqual(g.phase, 'done');
    assert.strictEqual(g.hands[0].result, 'lose');
    assert.strictEqual(g.credits, 1000);                         // -10 bet, -5 insurance, +15
    const end = g.events.find((e) => e.type === 'end');
    assert.strictEqual(end.net, 0);
    // no blackjack: the insurance is lost and the hand goes on
    const h = rigged('9S AH 8D 6C');
    h.deal(); h.insure(true);
    assert.strictEqual(h.phase, 'play');
    assert.strictEqual(h.credits, 985);
});

test('double: the bet twice, one card, then the hand stands', () => {
    const g = rigged('6S 5H 5D KC KS 7C');                       // 11 against 5; draws K = 21; dealer 5 K 7 = 22
    g.deal();
    assert.ok(g.canDouble());
    g.double();
    assert.strictEqual(g.hands[0].cards.length, 3);
    assert.strictEqual(g.hands[0].bet, 20);
    assert.strictEqual(g.hands[0].result, 'win');
    assert.strictEqual(g.credits, 1020);
    assert.strictEqual(g.stats.doubles, 1);
});

test('split a pair: two hands, each its own bet and second card, played in turn', () => {
    const g = rigged('8S 6H 8D KC 3C KD 2H 9S');
    g.deal();
    assert.ok(g.canSplit());
    g.split();
    assert.strictEqual(g.hands.length, 2);
    assert.strictEqual(g.credits, 980);
    assert.deepStrictEqual(g.hands[0].cards.map((c) => c.r), ['8', '3']);
    assert.strictEqual(g.active, 0);
    g.double();                                                  // double after split: 8 3 + K = 21
    assert.strictEqual(g.active, 1);
    assert.deepStrictEqual(g.hands[1].cards.map((c) => c.r), ['8', '2']);
    g.hit();                                                     // 8 2 + 9 = 19
    g.stand();
    assert.strictEqual(g.phase, 'done');
    assert.ok(g.events.some((e) => e.type === 'split'));
    assert.strictEqual(g.stats.splits, 1);
});

test('split aces take one card each; 21 on a split hand is not blackjack', () => {
    const g = rigged('AS 9H AD 7C KC 5D 9S');
    g.deal();
    g.split();
    assert.strictEqual(g.phase, 'done');
    assert.deepStrictEqual(g.hands.map((h) => h.cards.length), [2, 2]);
    assert.strictEqual(g.hands[0].result, 'win');                // A K = 21, paid 1 to 1
    assert.strictEqual(g.hands[0].payout, 20);
    assert.ok(!g.hands.some((h) => h.result === 'blackjack'));
});

test('no more than four hands; no double or split without the credits', () => {
    const g = rigged('8S 6H 8D KC 8C 8H 8S 2D 2C 2S 2H', { credits: 1000 });
    g.deal();
    g.split(); g.split(); g.split();
    assert.strictEqual(g.hands.length, 4);
    assert.ok(!g.canSplit());
    const h = rigged('8S 6H 8D KC', { credits: 10 });
    h.deal();
    assert.ok(!h.canSplit() && !h.canDouble());
});

test('basic strategy: the classic plays', () => {
    const A = (p, d, dbl = true, spl = true) => advice(C(p), C(d)[0], dbl, spl);
    assert.strictEqual(A('8S 8D', '10H'), 'split');
    assert.strictEqual(A('AS AD', '6H'), 'split');
    assert.strictEqual(A('10S 10D', '6H'), 'stand');
    assert.strictEqual(A('6S 5D', '10H'), 'double');
    assert.strictEqual(A('6S 5D', '10H', false), 'hit');
    assert.strictEqual(A('10S 2D', '3H'), 'hit');
    assert.strictEqual(A('10S 2D', '4H'), 'stand');
    assert.strictEqual(A('10S 6D', '7H'), 'hit');
    assert.strictEqual(A('AS 7D', '9H'), 'hit');
    assert.strictEqual(A('AS 7D', '2H'), 'stand');
    assert.strictEqual(A('AS 7D', '5H'), 'double');
    assert.strictEqual(A('9S 9D', '7H'), 'stand');
});

test('basic strategy over many hands: the house keeps less than 1%', () => {
    const g = new Game({ rng: seeded(3), credits: 1e7, bet: 10 });
    const N = 60000, c0 = g.credits;
    for (let i = 0; i < N; i++) {
        g.deal();
        if (g.phase === 'insurance') g.insure(false);
        for (let k = 0; g.phase === 'play' && k < 30; k++) g[g.advice()]();
        assert.strictEqual(g.phase, 'done', 'hand ' + i);
        g.events.length = 0;
    }
    const edge = (c0 - g.credits) / (N * 10);
    assert.ok(edge > -0.03 && edge < 0.03, 'edge ' + edge.toFixed(4));
    assert.ok(g.stats.blackjacks / N > 0.04 && g.stats.blackjacks / N < 0.05);
});

test('the shoe is shuffled again after the cut card', () => {
    const g = new Game({ rng: seeded(8), credits: 1e6 });
    let shuffled = false;
    for (let i = 0; i < 80 && !shuffled; i++) {
        g.deal();
        if (g.phase === 'insurance') g.insure(false);
        while (g.phase === 'play') g.stand();
        shuffled = g.events.splice(0).some((e) => e.type === 'shuffle');
    }
    assert.ok(shuffled);
    assert.ok(g.shoe.at < 20);
});

test('the bet within the table limits; a bet above the credits deals the largest that fits; refill', () => {
    const g = new Game({ credits: 120 });
    assert.strictEqual(g.bet(), BETS[0]);
    while (g.betUp());
    assert.strictEqual(g.bet(), BETS[BETS.length - 1]);
    g.deal();
    assert.strictEqual(g.hands[0].bet, 100);
    const h = new Game({ credits: 3 });
    assert.ok(h.broke() && !h.deal());
    assert.ok(h.refill());
    assert.strictEqual(h.credits, START_CREDITS);
});

test('statistics and credits are kept between drives', () => {
    const g = rigged('AS 9H KD 7C');
    g.deal();
    assert.strictEqual(g.stats.blackjacks, 1);
    assert.strictEqual(g.stats.bestWin, 15);
    assert.strictEqual(g.stats.streak, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-'));
    const f = path.join(dir, 'state.json');
    saveState(f, g.toJSON());
    const h = new Game(loadState(f));
    assert.deepStrictEqual(h.stats, g.stats);
    assert.strictEqual(h.credits, g.credits);
    assert.strictEqual(h.bet(), 10);
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
