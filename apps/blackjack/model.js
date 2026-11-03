'use strict';
/**
 * Blackjack's rules, without drawing or the car (tested in tests/blackjack.test.js).
 *
 *   const g = new Game({ credits: 1000, bet: 25 });
 *   g.deal()                      // pay the bet, deal two cards each (the dealer's second face down)
 *   g.hit() / g.stand() / g.double() / g.split() / g.insure(yes)
 *   g.events.splice(0)            // what happened, in order: cards, splits, the reveal, results
 *
 * Casino rules: six decks in a shoe, shuffled again when the cut card (three quarters in) comes out.
 * The dealer stands on all 17s and peeks for blackjack under an ace or a ten. Blackjack pays 3 to 2;
 * insurance (offered under an ace) costs half the bet and pays 2 to 1. Double on any two cards, also
 * after a split; split pairs (cards of the same rank) up to four hands; split aces take one card each
 * and can't be split again; 21 on a split hand is 21, not blackjack.
 *
 * The rules resolve at once; the events say what happened in order, and main.js deals them out on the
 * table one by one. Credits are play credits, nothing else: a player who can't pay the smallest bet
 * gets START_CREDITS again (refill()).
 */
const START_CREDITS = 1000;
const BETS = [5, 10, 25, 50, 100, 200, 500];
const DECKS = 6, CUT = 0.75;
const MAX_HANDS = 4;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const STATS = { hands: 0, won: 0, lost: 0, pushes: 0, blackjacks: 0, bet: 0, paid: 0, bestWin: 0, streak: 0, bestStreak: 0, doubles: 0, splits: 0 };

const value = (c) => (c.r === 'A' ? 11 : c.r === 'J' || c.r === 'Q' || c.r === 'K' ? 10 : Number(c.r));
/** a hand's total and whether an ace still counts 11 */
function total(cards) {
    let t = 0, aces = 0;
    for (const c of cards) { t += value(c); if (c.r === 'A') aces++; }
    while (t > 21 && aces) { t -= 10; aces--; }
    return { total: t, soft: aces > 0 };
}
const isBlackjack = (cards) => cards.length === 2 && total(cards).total === 21;

class Shoe {
    constructor(rng, decks) {
        this.rng = rng; this.decks = decks || DECKS;
        this.shuffle();
    }
    shuffle() {
        const c = [];
        for (let d = 0; d < this.decks; d++) for (const s of SUITS) for (const r of RANKS) c.push({ r, s });
        for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); const t = c[i]; c[i] = c[j]; c[j] = t; }
        this.cards = c; this.at = 0; this.cut = Math.floor(c.length * CUT);
    }
    draw() { if (this.at >= this.cards.length) this.shuffle(); return this.cards[this.at++]; }
    left() { return this.cards.length - this.at; }
    due() { return this.at >= this.cut; }
}

/**
 * Basic strategy for these rules (six decks, dealer stands on soft 17, double after split): what to do
 * with these cards against the dealer's up card. 'hit' | 'stand' | 'double' | 'split'.
 */
function advice(cards, up, canDouble, canSplit) {
    const d = value(up) === 11 ? 11 : value(up);       // 2..11
    if (canSplit && cards.length === 2 && cards[0].r !== undefined && value(cards[0]) === value(cards[1]) && rankKey(cards[0]) === rankKey(cards[1])) {
        const p = value(cards[0]);
        const split = p === 11 || p === 8 || (p === 9 && d !== 7 && d !== 10 && d !== 11) || ((p === 7 || p === 3 || p === 2) && d <= 7) ||
            (p === 6 && d <= 6) || (p === 4 && (d === 5 || d === 6));
        if (split) return 'split';
    }
    const { total: t, soft } = total(cards);
    const dbl = (x) => (canDouble && cards.length === 2 ? 'double' : x);
    if (soft && t <= 21) {
        if (t >= 20) return 'stand';
        if (t === 19) return d === 6 ? dbl('stand') : 'stand';
        if (t === 18) return d >= 3 && d <= 6 ? dbl('stand') : d <= 8 ? 'stand' : 'hit';
        if (t === 17) return d >= 3 && d <= 6 ? dbl('hit') : 'hit';
        if (t === 15 || t === 16) return d >= 4 && d <= 6 ? dbl('hit') : 'hit';
        return d === 5 || d === 6 ? dbl('hit') : 'hit';   // 13, 14
    }
    if (t >= 17) return 'stand';
    if (t >= 13) return d <= 6 ? 'stand' : 'hit';
    if (t === 12) return d >= 4 && d <= 6 ? 'stand' : 'hit';
    if (t === 11) return dbl('hit');
    if (t === 10) return d <= 9 ? dbl('hit') : 'hit';
    if (t === 9) return d >= 3 && d <= 6 ? dbl('hit') : 'hit';
    return 'hit';
}
const rankKey = (c) => (value(c) === 10 ? 'T' : c.r);   // tens split with tens (never advised anyway)

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.shoe = new Shoe(this.rng, o.decks);
        this.credits = Number.isFinite(o.credits) ? Math.max(0, Math.floor(o.credits)) : START_CREDITS;
        this.betIx = Math.max(0, BETS.indexOf(o.bet));
        this.stats = Object.assign({}, STATS);
        for (const k of Object.keys(STATS)) if (o.stats && Number.isFinite(o.stats[k])) this.stats[k] = o.stats[k];
        this.phase = 'bet';          // bet | insurance | play | done
        this.hands = [];             // { cards, bet, doubled, done, aces (split aces), result, payout }
        this.dealer = [];
        this.active = 0;
        this.insurance = 0; this.insuranceWon = 0;
        this.events = [];
    }
    bet() { return BETS[this.betIx]; }
    betting() { return this.phase === 'bet' || this.phase === 'done'; }
    betUp() { if (!this.betting() || this.betIx >= BETS.length - 1) return false; this.betIx++; return true; }
    betDown() { if (!this.betting() || this.betIx <= 0) return false; this.betIx--; return true; }
    maxBet() { if (!this.betting()) return false; let i = BETS.length - 1; while (i > 0 && BETS[i] > this.credits) i--; this.betIx = i; return true; }
    broke() { return this.betting() && this.credits < BETS[0]; }
    refill() { if (!this.broke()) return false; this.credits = START_CREDITS; this.betIx = 0; this.events.push({ type: 'refill' }); return true; }

    _card(who, hand, down) {
        const c = this.shoe.draw();
        if (who === 'd') this.dealer.push(c); else this.hands[hand].cards.push(c);
        this.events.push({ type: 'card', who, hand, card: c, down: !!down });
        return c;
    }

    deal() {
        if (!this.betting()) return false;
        if (this.credits < this.bet()) {
            if (this.broke()) { this.events.push({ type: 'broke' }); return false; }
            this.maxBet();
        }
        if (this.shoe.due()) { this.shoe.shuffle(); this.events.push({ type: 'shuffle' }); }
        const bet = this.bet();
        this.credits -= bet;
        this.stats.bet += bet;
        this.hands = [{ cards: [], bet, doubled: false, done: false, aces: false, result: null, payout: 0 }];
        this.dealer = [];
        this.active = 0;
        this.insurance = 0; this.insuranceWon = 0;
        this.events.push({ type: 'bet', amount: bet });
        this._card('p', 0); this._card('d'); this._card('p', 0); this._card('d', 0, true);
        const up = this.dealer[0];
        if (up.r === 'A' && !isBlackjack(this.hands[0].cards)) {
            this.phase = 'insurance';
            this.events.push({ type: 'offer', cost: Math.floor(bet / 2) });
            return true;
        }
        this._afterPeek();
        return true;
    }
    /** insurance under an ace: half the bet, pays 2 to 1 if the dealer has blackjack */
    canInsure() { return this.phase === 'insurance' && this.credits >= Math.floor(this.hands[0].bet / 2); }
    insure(yes) {
        if (this.phase !== 'insurance') return false;
        if (yes && this.canInsure()) {
            this.insurance = Math.floor(this.hands[0].bet / 2);
            this.credits -= this.insurance;
            this.stats.bet += this.insurance;
        }
        this.events.push({ type: 'insurance', taken: this.insurance > 0, amount: this.insurance });
        this._afterPeek();
        return true;
    }
    /** the dealer peeks under an ace or a ten: blackjack ends the round at once */
    _afterPeek() {
        const up = value(this.dealer[0]);
        const dbj = isBlackjack(this.dealer), pbj = isBlackjack(this.hands[0].cards);
        if (this.insurance) {
            const pay = dbj ? this.insurance * 3 : 0;
            this.insuranceWon = pay;
            this.credits += pay;
            this.stats.paid += pay;
            this.events.push({ type: 'insured', won: dbj, payout: pay });
        }
        if ((up >= 10 && dbj) || pbj) {
            if (up >= 10 && dbj) this.events.push({ type: 'peek', blackjack: true });
            this._settle();
            return;
        }
        if (up >= 10) this.events.push({ type: 'peek', blackjack: false });
        this.phase = 'play';
        this.events.push({ type: 'active', hand: 0 });
    }

    hand() { return this.hands[this.active]; }
    canHit() { const h = this.phase === 'play' && this.hand(); return !!h && !h.done; }
    canDouble() { const h = this.phase === 'play' && this.hand(); return !!h && !h.done && h.cards.length === 2 && !h.aces && this.credits >= h.bet; }
    canSplit() {
        const h = this.phase === 'play' && this.hand();
        return !!h && !h.done && h.cards.length === 2 && rankKey(h.cards[0]) === rankKey(h.cards[1]) && this.hands.length < MAX_HANDS && this.credits >= h.bet && !h.aces;
    }
    /** what basic strategy does with the hand in play */
    advice() { return this.phase === 'play' ? advice(this.hand().cards, this.dealer[0], this.canDouble(), this.canSplit()) : null; }

    hit() {
        if (!this.canHit()) return false;
        this._card('p', this.active);
        const t = total(this.hand().cards).total;
        if (t >= 21) this._next();
        return true;
    }
    stand() { if (!this.canHit()) return false; this._next(); return true; }
    double() {
        if (!this.canDouble()) return false;
        const h = this.hand();
        this.credits -= h.bet; this.stats.bet += h.bet; this.stats.doubles++;
        h.bet *= 2; h.doubled = true;
        this.events.push({ type: 'double', hand: this.active, bet: h.bet });
        this._card('p', this.active);
        this._next();
        return true;
    }
    split() {
        if (!this.canSplit()) return false;
        const i = this.active, h = this.hand();
        this.credits -= h.bet; this.stats.bet += h.bet; this.stats.splits++;
        const aces = h.cards[0].r === 'A';
        const n = { cards: [h.cards.pop()], bet: h.bet, doubled: false, done: false, aces, result: null, payout: 0 };
        h.aces = aces;
        this.hands.splice(i + 1, 0, n);
        this.events.push({ type: 'split', hand: i });
        this._card('p', i);
        if (aces) {
            // one card each on split aces, then both stand
            this._card('p', i + 1);
            h.done = true; n.done = true;
            this.active = i + 1;
            this._next();
            return true;
        }
        if (total(h.cards).total === 21) this._next();
        return true;
    }

    /** the hand in play is done: on to the next (its second card first, after a split) or the dealer */
    _next() {
        this.hand().done = true;
        while (this.active < this.hands.length - 1) {
            this.active++;
            const h = this.hand();
            if (h.done) continue;
            if (h.cards.length === 1) this._card('p', this.active);
            this.events.push({ type: 'active', hand: this.active });
            if (total(h.cards).total === 21) { h.done = true; continue; }
            return;
        }
        this._dealer();
    }
    _dealer() {
        this.phase = 'dealer';
        this.events.push({ type: 'reveal', card: this.dealer[1] });
        // the dealer draws only if a hand is still standing (not all bust)
        if (this.hands.some((h) => total(h.cards).total <= 21)) {
            while (total(this.dealer).total < 17) this._card('d');
        }
        this._settle(true);
    }
    _settle(revealed) {
        if (!revealed) this.events.push({ type: 'reveal', card: this.dealer[1] });
        const d = total(this.dealer).total, dbj = isBlackjack(this.dealer);
        let net = this.insuranceWon - this.insurance;
        const st = this.stats;
        this.hands.forEach((h, i) => {
            const t = total(h.cards).total, bj = isBlackjack(h.cards) && this.hands.length === 1;
            let r, pay;
            if (t > 21) { r = 'bust'; pay = 0; } else if (bj && !dbj) { r = 'blackjack'; pay = h.bet + Math.floor(h.bet * 3 / 2); } else if (dbj && !bj) { r = 'lose'; pay = 0; } else if (bj && dbj) { r = 'push'; pay = h.bet; } else if (d > 21 || t > d) { r = 'win'; pay = h.bet * 2; } else if (t === d) { r = 'push'; pay = h.bet; } else { r = 'lose'; pay = 0; }
            h.result = r; h.payout = pay;
            this.credits += pay;
            st.paid += pay;
            st.hands++;
            if (r === 'win' || r === 'blackjack') st.won++; else if (r === 'push') st.pushes++; else st.lost++;
            if (r === 'blackjack') st.blackjacks++;
            net += pay - h.bet;
            this.events.push({ type: 'result', hand: i, result: r, payout: pay, bet: h.bet });
        });
        const won = this.hands.some((h) => h.result === 'win' || h.result === 'blackjack');
        const lost = this.hands.every((h) => h.result === 'lose' || h.result === 'bust');
        st.streak = won && net > 0 ? st.streak + 1 : lost ? 0 : st.streak;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
        st.bestWin = Math.max(st.bestWin, net);
        this.phase = 'done';
        this.events.push({ type: 'end', net, dealer: d, dealerBlackjack: dbj, credits: this.credits });
    }

    toJSON() { return { credits: this.credits, bet: this.bet(), stats: this.stats }; }
}

function loadState(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('blackjack: state not read: ' + e.message);
        return {};
    }
}
function saveState(file, st) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(st));
    fs.renameSync(file + '.tmp', file);
}

module.exports = { Game, Shoe, START_CREDITS, BETS, DECKS, MAX_HANDS, RANKS, SUITS, value, total, isBlackjack, advice, loadState, saveState };
