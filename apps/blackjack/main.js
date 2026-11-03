'use strict';
/**
 * Blackjack - a casino blackjack table, drawn by the GPU renderer every frame (mgu-render: up to
 * 60 fps). Play credits only, nothing to buy or win. Parked only.
 *
 * The rules resolve at once in model.js (tests/blackjack.test.js); what happened comes out as events
 * (cards, splits, doubles, the reveal, results) that this file deals out on the table one by one: the
 * cards fly from the shoe and settle in a fan, the dealer's hole card turns over, chips slide to the
 * bet and back (or to the dealer's rack), the cards of a finished round go to the discard tray. The
 * table, the cards, the chips and the panel are cached layers (art.js).
 *
 * Steering:
 *   iDrive controller (held by the app on screen):
 *     betting: press = deal, turn = bet, push up = max bet, push down = statistics, push left = leave
 *     playing: turn = choose HIT / STAND / DOUBLE / SPLIT, press = do it; push up = hit, push down =
 *       stand, push right = double, push left = split
 *     insurance: turn = choose, press = do it (push up = insure, push down = no)
 *     while cards are dealt: press = deal them out at once. On the statistics: press or push down
 *       closes them, a turn lets go of the controller (over to the bar and the header).
 *   touchscreen (where the kit runs the screen): the panel's keys and the DEAL button.
 *   bar buttons: the first two follow the moment ("Deal" / "Hit" / "Insure", "Stats" / "Stand" /
 *     "No"), "Double", "Split", "Bet +".
 *
 * With the strategy hint on, the key basic strategy plays lights up. No new hand starts while the car
 * moves (kit/parked.js), and a hand in play waits. Credits, the bet and the statistics are kept in a
 * file between drives.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { TILT } = require('./kit/display');
const parkedWatch = require('./kit/parked').watch;
const M = require('./model');
const A = require('./art');

const W = 1600, H = 520;
const STATE_FILE = 'blackjack.json';
const GOLD = '#ffd36e';
const DELAY = {
    normal: { card: 380, reveal: 560, result: 320, split: 320, double: 220, bet: 260, clear: 380, end: 200 },
    fast: { card: 230, reveal: 320, result: 200, split: 220, double: 150, bet: 160, clear: 260, end: 120 },
};
const MESSAGE_MS = 2400;

const fmt = (n) => (n < 0 ? '-' : '') + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;
        const stateFile = path.join(dataDir, STATE_FILE);
        const game = new M.Game(M.loadState(stateFile, log));
        const S = (k, d) => String(settings.get(k) || d);
        const speed = () => DELAY[S('dealSpeed', 'normal')] || DELAY.normal;

        let visible = false, menu = false, stats = false;
        let toast = null, toastUntil = 0;
        let pressed = null, pressedAt = 0;
        let focus = 0;                 // the key the controller is on (playing, insurance)
        let frameT = Date.now();

        // what the table shows: it follows the model through the queued events
        const view = {
            dealer: [], hands: [], active: 0, credits: game.credits, offer: false, end: null, endAt: 0, lastWin: 0,
            message: null,             // { text, color, at, big }
        };
        let queue = [];                // [{ ev, at }]
        let discards = [], stacks = [];

        function showToast(msg, ms) { toast = msg; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());
        function save() { try { M.saveState(stateFile, game.toJSON()); } catch (e) { log.warn('blackjack: not saved: ' + e.message); } }
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        const press = (k) => { pressed = k; pressedAt = Date.now(); };
        const busy = () => queue.length > 0;
        /** the moment, as the player sees it */
        function moment() {
            if (busy()) return 'dealing';
            if (game.phase === 'insurance') return 'insurance';
            if (game.phase === 'play') return 'play';
            return 'bet';
        }

        /* ---------- positions ---------- */
        const handX = (i, n) => { const sp = Math.min(260, (A.TABLE.w - 200) / n); return A.ARC.cx + (i - (n - 1) / 2) * sp; };
        const cardPos = (i, j, len, n) => {
            const fan = n > 2 ? 24 : n > 1 ? 28 : 34;
            return [handX(i, n) - A.CARD.w / 2 + (j - (len - 1) / 2) * fan + 10, A.PLAYER_Y - j * 6];
        };
        const dealerPos = (j, len) => [A.DEALER.x - A.CARD.w / 2 + (j - (len - 1) / 2) * 62, A.DEALER.y];
        const shoeMouth = () => [A.SHOE.x + 30, A.SHOE.y + 20];
        const stackPos = (i, n) => [handX(i, n) - A.CARD.w / 2 - 50, 420];

        /* ---------- the events, dealt out ---------- */
        function schedule(evs, now) {
            let t = Math.max(now, queue.length ? queue[queue.length - 1].at : now);
            const d = speed();
            for (const ev of evs) { queue.push({ ev, at: t }); t += d[ev.type] || 0; }
        }
        function newCard(c, down) { const [x, y] = shoeMouth(); return { c, down, x, y, flipAt: 0 }; }
        function apply(ev, now) {
            const n = view.hands.length;
            switch (ev.type) {
            case 'bet':
                view.hands = [{ cards: [], bet: ev.amount, result: null }];
                view.dealer = []; view.active = 0; view.end = null; view.message = null;
                view.credits -= ev.amount;
                stacks.push({ hand: 0, kind: 'bet', amount: ev.amount, x: A.PANEL.x - 40, y: 470 });
                break;
            case 'card':
                if (ev.who === 'd') view.dealer.push(newCard(ev.card, ev.down));
                else view.hands[ev.hand].cards.push(newCard(ev.card, false));
                break;
            case 'split': {
                const h = view.hands[ev.hand], c = h.cards.pop();
                view.hands.splice(ev.hand + 1, 0, { cards: [c], bet: h.bet, result: null });
                view.credits -= h.bet;
                stacks.forEach((s) => { if (s.hand > ev.hand) s.hand++; });
                const [x, y] = stackPos(ev.hand, n);
                stacks.push({ hand: ev.hand + 1, kind: 'bet', amount: h.bet, x, y });
                break;
            }
            case 'double': {
                const h = view.hands[ev.hand];
                view.credits -= ev.bet - h.bet;
                h.bet = ev.bet; h.doubled = true;
                const s = stacks.find((q) => q.hand === ev.hand && q.kind === 'bet');
                if (s) s.amount = ev.bet;
                break;
            }
            case 'offer': view.offer = true; focus = 1; break;
            case 'insurance':
                view.offer = false;
                if (ev.taken) { view.credits -= ev.amount; view.message = { text: 'INSURED  ' + ev.amount, color: '#7fd1ff', at: now }; }
                break;
            case 'insured':
                if (ev.won) { view.credits += ev.payout; view.message = { text: 'INSURANCE PAYS  +' + ev.payout, color: '#5ff0a6', at: now }; }
                break;
            case 'peek': if (!ev.blackjack) view.message = { text: 'NO BLACKJACK', color: '#ffffff', at: now, small: true }; break;
            case 'active': view.active = ev.hand; focus = 0; break;
            case 'reveal': if (view.dealer[1]) { view.dealer[1].down = false; view.dealer[1].flipAt = now; } break;
            case 'result': {
                const h = view.hands[ev.hand];
                h.result = ev.result; h.payout = ev.payout; h.resultAt = now;
                view.credits += ev.payout;
                if (ev.payout > ev.bet) stacks.push({ hand: ev.hand, kind: 'pay', amount: ev.payout - ev.bet, x: A.ARC.cx, y: 60, from: now });
                const s = stacks.find((q) => q.hand === ev.hand && q.kind === 'bet');
                if (s && ev.payout === 0) { s.leave = [A.ARC.cx + (Math.random() - 0.5) * 200, 58]; s.leaveAt = now + 450; }
                break;
            }
            case 'end': {
                view.end = ev; view.endAt = now;
                view.lastWin = ev.net > 0 ? ev.net : 0;
                const res = game.hands.map((h) => h.result);
                const d = M.total(game.dealer).total;
                let text, color = GOLD, big = false;
                if (res.length === 1 && res[0] === 'blackjack') { text = 'BLACKJACK!'; big = true; } else if (ev.dealerBlackjack) { text = 'DEALER HAS BLACKJACK'; color = '#ff8a8a'; } else if (ev.net > 0) { text = (d > 21 ? 'DEALER BUSTS  ·  ' : '') + 'YOU WIN  +' + fmt(ev.net); color = '#5ff0a6'; big = ev.net >= 2 * game.hands[0].bet; } else if (ev.net === 0) { text = 'PUSH'; color = '#7fd1ff'; } else { text = res.every((r) => r === 'bust') ? 'BUST' : 'DEALER WINS'; color = '#ff8a8a'; }
                view.message = { text, color, at: now, big };
                // the chips go home: winnings and bets back to the player, the rest is already with the dealer
                for (const s of stacks) if (!s.leave) { s.leave = [A.PANEL.x - 20, H + 30]; s.leaveAt = now + 1300; }
                save();
                log.info('blackjack: ' + game.hands.map((h) => M.total(h.cards).total + ' ' + h.result).join(', ') + ' vs ' + d + ', net ' + ev.net + ', credits ' + game.credits);
                break;
            }
            case 'shuffle': view.message = { text: 'NEW SHOE  ·  SHUFFLED', color: '#ffffff', at: now, small: true }; break;
            default:
            }
        }
        function pump(now) {
            while (queue.length && queue[0].at <= now) apply(queue.shift().ev, now);
            if (!queue.length) view.credits = game.credits;      // in step with the model once all is dealt
        }
        /** everything dealt out now (a press while the cards fly) */
        function flush(now) { for (const q of queue) q.at = now; pump(now); }

        /* ---------- actions ---------- */
        function deal() {
            menu = false; syncGrab();
            if (stats) { stats = false; return; }
            if (busy()) { flush(Date.now()); return; }
            if (moment() !== 'bet') return;
            if (parked.moving()) { showToast('Parked only: the next hand is dealt when the car stands still'); return; }
            if (game.broke()) { game.refill(); view.credits = game.credits; showToast('Out of credits: ' + fmt(M.START_CREDITS) + ' new play credits', 3500); save(); game.events.length = 0; return; }
            press('deal');
            const now = Date.now();
            // the last round's cards to the discard tray first
            const had = view.dealer.length > 0;
            for (const c of view.dealer.concat(...view.hands.map((h) => h.cards))) { c.leave = true; discards.push(c); }
            view.dealer = []; view.hands = []; view.end = null; view.message = null;
            stacks = stacks.filter((s) => s.leave);
            if (!game.deal()) { game.events.length = 0; return; }
            schedule(game.events.splice(0), now + (had ? speed().clear : 0));
        }
        function act(name) {
            menu = false; syncGrab();
            if (busy()) { flush(Date.now()); return; }
            if (parked.moving()) { showToast('Parked only: the hand goes on when the car stands still'); return; }
            const m = moment();
            if (m === 'insurance') {
                if (name === 'insure' || name === 'no') { press(name); game.insure(name === 'insure'); }
            } else if (m === 'play') {
                const ok = { hit: () => game.hit(), stand: () => game.stand(), double: () => game.double(), split: () => game.split() }[name];
                if (ok && ok()) press(name);
            } else return;
            schedule(game.events.splice(0), Date.now());
        }
        function bet(d) { if (moment() !== 'bet') return; press(d > 0 ? 'betUp' : 'betDown'); if (d > 0 ? game.betUp() : game.betDown()) save(); }
        function maxBet() { if (moment() !== 'bet') return; press('max'); game.maxBet(); save(); }
        function toggleStats() { if (moment() !== 'bet' && !stats) return; press('stats'); stats = !stats; menu = false; syncGrab(); }

        /** the four keys for the moment: [label, action, enabled] */
        function keys() {
            const m = moment();
            if (m === 'insurance') return [['INSURE', 'insure', game.canInsure()], ['NO THANKS', 'no', true], ['DOUBLE', null, false], ['SPLIT', null, false]];
            if (m === 'play' || (m === 'dealing' && game.phase !== 'done')) {
                const live = m === 'play';
                return [['HIT', 'hit', live && game.canHit()], ['STAND', 'stand', live && game.canHit()], ['DOUBLE', 'double', live && game.canDouble()], ['SPLIT', 'split', live && game.canSplit()]];
            }
            const b = m === 'bet';
            return [['BET -', 'betDown', b], ['BET +', 'betUp', b], ['MAX BET', 'max', b], ['STATS', 'stats', b]];
        }
        function runKey(a) {
            if (!a) return;
            if (a === 'betDown') bet(-1); else if (a === 'betUp') bet(1); else if (a === 'max') maxBet(); else if (a === 'stats') toggleStats(); else act(a);
        }
        const hintOn = () => S('hints', 'on') === 'on';
        const advised = () => (moment() === 'play' && hintOn() ? game.advice() : null);

        /* ---------- input ---------- */
        ui.onClick('BTN_MAIN', () => { const m = moment(); if (m === 'insurance') act('insure'); else if (m === 'play' || m === 'dealing') act('hit'); else deal(); });
        ui.onClick('BTN_STAND', () => { const m = moment(); if (m === 'insurance') act('no'); else if (m === 'play' || m === 'dealing') act('stand'); else toggleStats(); });
        ui.onClick('BTN_DOUBLE', () => act('double'));
        ui.onClick('BTN_SPLIT', () => act('split'));
        ui.onClick('BTN_BET', () => { if (moment() !== 'bet') return; if (!game.betUp()) while (game.betDown()); save(); });
        let lastLabels = '';
        function syncLabels() {
            const m = moment(), l = m === 'insurance' ? ['Insure', 'No'] : m === 'bet' ? ['Deal', 'Stats'] : ['Hit', 'Stand'];
            if (l.join() === lastLabels) return;
            lastLabels = l.join();
            Promise.resolve(ui.text('BTN_MAIN', l[0])).catch(() => {});
            Promise.resolve(ui.text('BTN_STAND', l[1])).catch(() => {});
        }

        let ccu = null;
        if (ctx.controller) ctx.controller.onInput((v) => {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            const L = ccu;
            ccu = { k, pb, df };
            if (pb === 15 && df === 15) return;                  // no controller behind it
            let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
            if (Math.abs(d) > 64) d = 0;
            const down = (x) => x === 1 || x === 2;
            const pr = down(pb) && !(L && down(L.pb));
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            const leave = () => Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            if (stats) {
                if (pr || tilt === 'S') { stats = false; return; }
                if (d) { stats = false; menu = true; syncGrab(); }
                if (tilt === 'W') leave();
                return;
            }
            const m = moment();
            if (m === 'dealing') { if (pr) flush(Date.now()); return; }
            if (m === 'bet') {
                if (pr) deal();
                if (d) bet(d);
                if (tilt === 'N') maxBet(); else if (tilt === 'S') toggleStats(); else if (tilt === 'W') leave();
                return;
            }
            const ks = keys();
            if (d) {
                // the controller's ring moves over the keys that can be pressed now
                const on = ks.map((q, i) => (q[2] ? i : -1)).filter((i) => i >= 0);
                if (on.length) { let at = on.indexOf(focus); if (at < 0) at = 0; focus = on[(at + (d > 0 ? 1 : -1) + on.length * 8) % on.length]; }
            }
            if (pr && ks[focus] && ks[focus][2]) runKey(ks[focus][1]);
            if (m === 'insurance') { if (tilt === 'N') act('insure'); else if (tilt === 'S') act('no'); return; }
            if (tilt === 'N') act('hit'); else if (tilt === 'S') act('stand'); else if (tilt === 'E') act('double'); else if (tilt === 'W') act('split');
        });
        const inRect = (q, x, y) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h;
        let touch0 = null;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) touch0 = { x, y, t: Date.now() };
            if (phase !== 3 || !touch0) return;
            const tap = Math.abs(x - touch0.x) < 30 && Math.abs(y - touch0.y) < 30 && Date.now() - touch0.t < 600;
            touch0 = null;
            if (!tap) return;
            const ks = keys();
            const ki = A.KEYS.findIndex((q) => inRect(q, x, y));
            if (stats && !(ki === 3 && ks[3][1] === 'stats')) { stats = false; return; }
            if (Math.hypot(x - A.DEAL_BTN.x, y - A.DEAL_BTN.y) < A.DEAL_BTN.r + 12) deal();
            else if (ki >= 0 && ks[ki][2]) { focus = ki; runKey(ks[ki][1]); } else if (busy()) flush(Date.now());
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) menu = false;
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();

        /* ---------- drawing ---------- */
        function ease(o, tx, ty, dt, k) { const f = 1 - Math.exp(-dt / (k || 70)); o.x += (tx - o.x) * f; o.y += (ty - o.y) * f; }
        function drawCard(cv, o, now, back) {
            const k = o.flipAt ? (now - o.flipAt) / 300 : 1;
            if (k < 1) A.drawFlip(cv, o.c, Math.round(o.x), Math.round(o.y), k, back);
            else cv.blit(o.down ? A.backLayer(back) : A.cardLayer(o.c), o.x, o.y);
        }
        function drawTable(cv, now, dt) {
            const back = S('cardBack', 'red');
            cv.blit(A.tableLayer(S('felt', 'green')), A.TABLE.x, A.TABLE.y);
            // cards on their way to the discard tray
            discards = discards.filter((o) => Math.hypot(o.x - A.DISCARD.x - 6, o.y - A.DISCARD.y - 2) > 6);
            for (const o of discards) { ease(o, A.DISCARD.x + 6, A.DISCARD.y + 2, dt, 60); cv.blit(A.backLayer(back), o.x, o.y); }
            // the dealer's cards and total
            view.dealer.forEach((o, j) => { const [x, y] = dealerPos(j, view.dealer.length); ease(o, x, y, dt); drawCard(cv, o, now, back); });
            if (view.dealer.length) {
                const shown = view.dealer.filter((o) => !o.down).map((o) => o.c), t = M.total(shown);
                const [x0] = dealerPos(0, view.dealer.length);
                A.drawTotal(cv, x0 - 52, A.DEALER.y + 46, label(shown, t), t.total > 21 ? 'bust' : t.total === 21 ? 'best' : '');
            }
            // the hands: a glow under the one in play, cards, the total, the result
            const n = view.hands.length;
            view.hands.forEach((h, i) => {
                const hx = handX(i, n);
                if (n > 1 && i === view.active && !view.end) A.glow(cv, hx + 10, A.PLAYER_Y + 64, 120, GOLD, 0.35 + 0.1 * Math.sin(now / 250));
                h.cards.forEach((o, j) => { const [x, y] = cardPos(i, j, h.cards.length, n); ease(o, x, y, dt); drawCard(cv, o, now, back); });
                if (h.cards.length) {
                    const cs = h.cards.map((o) => o.c), t = M.total(cs);
                    const [sx] = stackPos(i, n);
                    A.drawTotal(cv, sx, A.PLAYER_Y + 6, label(cs, t, n === 1), t.total > 21 ? 'bust' : t.total === 21 ? 'best' : '');
                    if (h.doubled) cv.text('x2', sx, A.PLAYER_Y + 56, 16, GOLD, { font: 'bold', align: 'center', literal: true });
                }
                if (h.result) A.drawResult(cv, hx + 10, A.PLAYER_Y + 44, h.result, h.payout, Math.min(1, (now - h.resultAt) / 200));
            });
            // the chips: bets at their hands, winnings coming from the dealer's rack, stacks going home
            stacks = stacks.filter((s) => !(s.leave && now >= s.leaveAt && Math.hypot(s.x - s.leave[0], s.y - s.leave[1]) < 8));
            for (const s of stacks) {
                let tx, ty;
                if (s.leave && now >= s.leaveAt) [tx, ty] = s.leave;
                else { [tx, ty] = stackPos(Math.min(s.hand, n - 1), n); if (s.kind === 'pay') tx += 52; }
                ease(s, tx, ty, dt, 110);
                A.drawStack(cv, s.amount, s.x, s.y);
            }
        }
        /** "17", "SOFT 17", "BLACKJACK", "BUST 24" */
        function label(cards, t, single) {
            if (cards.length === 2 && t.total === 21 && single !== false) return 'BLACKJACK';
            if (t.total > 21) return 'BUST ' + t.total;
            return (t.soft && t.total < 21 ? 'SOFT ' : '') + t.total;
        }
        function drawMessage(cv, now) {
            const m = view.message;
            let text = null, color, big = false, a = 1;
            if (m && now - m.at < MESSAGE_MS) {
                const t = now - m.at;
                a = t < 150 ? t / 150 : t > MESSAGE_MS - 300 ? (MESSAGE_MS - t) / 300 : 1;
                ({ text, color } = m); big = m.big;
            } else if (moment() === 'insurance' && !busy()) { text = 'INSURANCE?  ' + Math.floor(game.hands[0].bet / 2) + ' CREDITS'; color = '#7fd1ff'; } else if (moment() === 'bet' && !view.dealer.length && !stats) {
                text = 'PLACE YOUR BET  ·  ' + fmt(game.bet()); color = GOLD;
            }
            if (!text) return;
            const cx = A.ARC.cx, cy = 246, size = big ? 34 : 24;
            const w = cv.textWidth(text, size, { font: 'bold', literal: true, spacing: 2 }) + 64, h = big ? 56 : 44;
            cv.alpha(a);
            if (big) { A.glow(cv, cx, cy, 220, color, 0.5); for (let i = 0; i < 8; i++) { const ang = i / 8 * Math.PI * 2 + now / 700; A.sparkle(cv, cx + Math.cos(ang) * (w / 2 + 30), cy + Math.sin(ang) * 40, 9 + 3 * Math.sin(now / 120 + i), '#fff3c4'); } }
            cv.roundRect(cx - w / 2 + 4, cy - h / 2 + 5, w, h, h / 2, withAlpha('#000000', 0.5));
            cv.card(cx - w / 2, cy - h / 2, w, h, h / 2, [[0, '#24242c'], [1, '#0a0a0e']]);
            cv.strokeRoundRect(cx - w / 2, cy - h / 2, w, h, h / 2, 2, color);
            cv.text(text, cx, cy + size * 0.36, size, color, { font: 'bold', align: 'center', spacing: 2, literal: true });
            cv.alpha(1);
        }
        function drawPanel(cv, now) {
            cv.blit(A.panelLayer(), A.PANEL.x, A.PANEL.y);
            const lcd = (q, v, c) => {
                A.glow(cv, q.x + q.w - 70, q.y + 29, 56, c || q.color, 0.12);
                cv.text(v, q.x + q.w - 14, q.y + 44, 38, c || q.color, { font: 'num', align: 'right', literal: true });
            };
            lcd(A.LCD.credit, fmt(view.credits));
            lcd(A.LCD.bet, fmt(view.hands.length ? view.hands.reduce((a, h) => a + h.bet, 0) : game.bet()));
            lcd(A.LCD.win, fmt(view.end ? view.lastWin : 0));
            // what's going on, in a line
            const P = A.PANEL, m = moment();
            let info = '6 DECKS  ·  BLACKJACK PAYS 3 TO 2', ic = withAlpha('#ffffff', 0.55);
            if (m === 'play') {
                const h = game.hand(), t = M.total(h.cards), up = M.total([game.dealer[0]]).total;
                info = (game.hands.length > 1 ? 'HAND ' + (game.active + 1) + '  ·  ' : '') + label(h.cards, t, game.hands.length === 1) + '  vs  ' + (up === 11 ? 'ACE' : up);
                const adv = advised();
                if (adv) { info += '  ·  TIP: ' + adv.toUpperCase(); ic = GOLD; }
            } else if (m === 'bet') info = 'BEST WIN  ' + fmt(game.stats.bestWin) + '  ·  STREAK  ' + game.stats.streak;
            cv.text(info, P.x + 28, P.y + 218, 15, ic, { font: 'bold', spacing: 1.2, literal: true });
            const down = (k) => pressed === k && now - pressedAt < 140;
            const adv = advised(), ctl = own() || !!(ctx.controller);
            keys().forEach(([lab, a, on], i) => {
                const q = A.KEYS[i];
                const st = down(a) ? 'down' : !on ? 'off' : a === adv || (a === 'stats' && stats) ? 'lit' : 'up';
                cv.blit(A.keyLayer(i, lab, st), q.x, q.y);
                if (ctl && i === focus && on && (m === 'play' || m === 'insurance')) cv.strokeRoundRect(q.x - 4, q.y - 4, q.w + 8, q.h + 8, 15, 3, withAlpha('#ffffff', 0.85));
            });
            const D = A.DEAL_BTN, can = m === 'bet' && !parked.moving();
            if (can) A.glow(cv, D.x, D.y, D.r * 1.6, '#2ad46a', 0.3 + 0.12 * Math.sin(now / 300));
            cv.blit(A.dealLayer('DEAL', down('deal') ? 'down' : can ? 'on' : 'off'), D.x - D.r - 2, D.y - D.r - 2);
            if (game.broke() && m === 'bet') cv.text('DEAL FOR NEW CREDITS', D.x, D.y + D.r + 4, 11, '#ff8ac0', { font: 'bold', align: 'center', literal: true });
        }
        function drawHint(cv, touch) {
            const P = A.PANEL, m = moment();
            const lines = !touch ? ['Bar: Deal / Hit · Stand', 'Double · Split · Bet +']
                : m === 'play' ? ['Turn: choose · press: do it', 'Up: hit · down: stand', 'Right: double · left: split']
                    : m === 'insurance' ? ['Turn: choose · press: do it', 'Up: insure · down: no']
                        : ['Press: deal · turn: bet', 'Up: max bet · down: statistics'];
            lines.forEach((l, i) => cv.text(l, P.x + 24, P.y + 386 + i * 18, 13, withAlpha('#ffffff', 0.45), { font: 'label' }));
        }
        function drawStatsPage(cv) {
            if (!stats) return;
            const st = game.stats, decided = st.won + st.lost;
            A.drawStats(cv, [
                ['HANDS PLAYED', fmt(st.hands)],
                ['WON', fmt(st.won), '#5ff0a6'],
                ['LOST', fmt(st.lost), '#ff8a8a'],
                ['PUSHES', fmt(st.pushes)],
                ['BLACKJACKS', fmt(st.blackjacks), GOLD],
            ], [
                ['WIN RATE', decided ? (st.won / decided * 100).toFixed(1) + ' %' : '-'],
                ['BEST WIN', fmt(st.bestWin), GOLD],
                ['LONGEST WINNING STREAK', fmt(st.bestStreak), GOLD],
                ['DOUBLES  ·  SPLITS', fmt(st.doubles) + '  ·  ' + fmt(st.splits)],
                ['PAID BACK', st.bet ? (st.paid / st.bet * 100).toFixed(1) + ' %' : '-'],
            ], 'Six decks  ·  dealer stands on 17  ·  blackjack pays 3 to 2  ·  insurance pays 2 to 1  ·  double after split');
        }
        function drawParked(cv) {
            if (!parked.moving()) return;
            const cx = A.ARC.cx;
            cv.roundRect(A.TABLE.x + 60, 160, A.TABLE.w - 120, 130, 16, withAlpha('#000000', 0.7));
            cv.text('PARKED ONLY', cx, 222, 52, '#ffb020', { font: 'bold', align: 'center', spacing: 5 });
            cv.text('The cards are dealt again when the car stands still.', cx, 262, 21, withAlpha('#ffffff', 0.75), { align: 'center' });
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            pump(now);
            syncLabels();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear('#07040a');
            A.setTextScale(cv.textScale);
            const touch = !!cv.own || own();
            cv.gradientRect(0, 40, W, H - 40, [[0, '#14100c'], [0.6, '#0a0806'], [1, '#040302']]);
            drawTable(cv, now, dt);
            drawMessage(cv, now);
            drawParked(cv);
            drawPanel(cv, now);
            drawHint(cv, touch);
            drawStatsPage(cv);
            G.frame(cv, t, ['Blackjack'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Blackjack first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
