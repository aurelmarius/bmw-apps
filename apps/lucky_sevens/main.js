'use strict';
/**
 * Lucky Sevens - a five reel slot machine, drawn by the GPU renderer every frame (mgu-render: up to
 * 60 fps). Play credits only, nothing to buy or win. Parked only.
 *
 * The reels wind up, run and stop one after the other with a bounce; a win lights its paylines one by
 * one, the cells that pay get a gold frame (sevens: light rays), the win counts up into the credits,
 * the marquee bulbs chase while the reels run and flash on a win, and a big win throws coins over the
 * machine. The reels are stepped at a fixed 60 Hz (model.js) whatever the frame rate; without the
 * renderer the frames go to the HMI as images, a few a second (slowly).
 *
 * Steering:
 *   iDrive controller (held by the app on screen): press = spin (while the reels run: stop them now;
 *     while a win counts up: count it at once), turn = bet down / up, push up = autoplay on / off,
 *     push right = max bet, push left = leave, push down = let go of the controller (over to the bar
 *     and the header).
 *   touchscreen (where the kit runs the screen): the panel's keys and the SPIN button; a tap on the
 *     reels spins (or stops them).
 *   bar buttons "Spin", "Bet +" (round to the smallest after the largest) and "Auto".
 *
 * The rules are in model.js (tests/lucky_sevens.test.js), the drawing of things in art.js. Spinning
 * stops when the screen goes, a sheet (Settings) opens over it or the car drives off (kit/parked.js):
 * reels already running finish their spin, autoplay goes off, and no new spin starts while moving.
 * Credits, the bet and the best win are kept in a file between drives.
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
const STATE_FILE = 'lucky_sevens.json';
const PARKED_MS = 500;
const LINE_MS = 1100;                  // each winning line shown this long, in turn
const AUTO_WAIT = { none: 450, win: 1300, big: 3200, mega: 4500 };
const TITLE = 'LUCKY SEVENS';
const GOLD = '#ffd36e', PINK = '#ff8ac0';

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;

        const stateFile = path.join(dataDir, STATE_FILE);
        const saved = M.loadState(stateFile, log);
        const cabinet = () => String(settings.get('cabinet') || 'ruby');
        const reelSpeed = () => String(settings.get('reelSpeed') || 'normal');

        let game = new M.Game({ credits: saved.credits, coin: saved.coin, speed: reelSpeed() });
        let bestWin = Number(saved.bestWin) || 0;
        let auto = false, autoAt = 0;
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        // the win on show: its lines, when it began, how far it has counted
        let show = null;               // { amount, level, wins, at, countMs, jackpot }
        let shown = 0;                 // credits of the win counted so far
        let coins = [], sparks = [];
        let pressed = null, pressedAt = 0;
        const stopAt = [0, 0, 0, 0, 0];   // when each reel stopped (its thump)
        let frameT = Date.now();

        function showToast(msg, ms) { toast = msg; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());
        function save() {
            try { M.saveState(stateFile, { credits: game.credits, coin: game.coin(), bestWin, spins: (Number(saved.spins) || 0) + game.spins }); } catch (e) { log.warn('lucky_sevens: not saved: ' + e.message); }
        }
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        const press = (k) => { pressed = k; pressedAt = Date.now(); };

        /* ---------- actions ---------- */
        function spin() {
            menu = false; syncGrab();
            if (game.spinning) { game.slam(); return; }
            if (show && shown < show.amount) { shown = show.amount; return; }        // count it at once
            if (parked.moving()) { auto = false; showToast('Parked only: the reels turn when the car stands still'); return; }
            if (game.broke()) { game.refill(); showToast('Out of credits: ' + fmt(M.START_CREDITS) + ' new play credits', 3500); save(); return; }
            press('spin');
            if (game.spin()) { show = null; shown = 0; }
        }
        function bet(d) {
            if (game.spinning) return;
            press(d > 0 ? 'betUp' : 'betDown');
            if (d > 0 ? game.betUp() : game.betDown()) save();
        }
        function maxBet() { if (!game.spinning) { press('max'); game.maxBet(); save(); } }
        function toggleAuto() {
            if (!auto && parked.moving()) { showToast('Parked only: the reels turn when the car stands still'); return; }
            auto = !auto;
            press('auto');
            if (auto && !game.spinning) autoAt = Date.now() + 300;
        }

        /* ---------- input ---------- */
        ui.onClick('BTN_SPIN', spin);
        ui.onClick('BTN_BET', () => {
            if (game.spinning) return;
            if (!game.betUp()) while (game.betDown());   // after the largest: back to the smallest
            save();
        });
        ui.onClick('BTN_AUTO', toggleAuto);

        // FrontCCU while held: knob counter, press, push (as display.js reads them)
        let ccu = null;
        if (ctx.controller) ctx.controller.onInput((v) => {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            const L = ccu;
            ccu = { k, pb, df };
            if (pb === 15 && df === 15) return;                  // no controller behind it
            let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
            if (Math.abs(d) > 64) d = 0;                         // a counter reset
            const down = (x) => x === 1 || x === 2;
            const pr = down(pb) && !(L && down(L.pb));
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            if (pr) spin();
            if (d) bet(d);
            if (tilt === 'N') toggleAuto();
            else if (tilt === 'E') maxBet();
            else if (tilt === 'W' && !game.spinning) { auto = false; Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e)); } else if (tilt === 'S') { auto = false; menu = true; syncGrab(); }
        });
        // the finger: the keys, the SPIN button, the reels
        const inRect = (q, x, y) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h;
        let touch0 = null;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) touch0 = { x, y, t: Date.now() };
            if (phase !== 3 || !touch0) return;
            const tap = Math.abs(x - touch0.x) < 30 && Math.abs(y - touch0.y) < 30 && Date.now() - touch0.t < 600;
            touch0 = null;
            if (!tap) return;
            const B = A.BUTTONS;
            if (Math.hypot(x - A.SPIN_BTN.x, y - A.SPIN_BTN.y) < A.SPIN_BTN.r + 12) spin();
            else if (inRect(B.betDown, x, y)) bet(-1);
            else if (inRect(B.betUp, x, y)) bet(1);
            else if (inRect(B.max, x, y)) maxBet();
            else if (inRect(B.auto, x, y)) toggleAuto();
            else if (inRect(A.WIN, x, y)) spin();
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { auto = false; menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => {
            if (k === 'reelSpeed' && !game.spinning) {
                const g = new M.Game({ credits: game.credits, coin: game.coin(), speed: reelSpeed() });
                g.reels.forEach((r, i) => { r.pos = game.reels[i].pos; });
                g.spins = game.spins;
                game = g;
            }
        });
        setInterval(() => {
            if (auto && parked.moving()) { auto = false; showToast('Autoplay off: parked only', 4000); }
        }, PARKED_MS);

        /* ---------- the clock ---------- */
        let acc = 0, lastT = Date.now();
        function advance(now) {
            if (display && display.sheet) auto = false;
            acc += Math.min(100, now - lastT);                   // a stalled frame: no burst of steps
            lastT = now;
            while (acc >= M.DT) { game.step(M.DT); acc -= M.DT; }
            for (const ev of game.events.splice(0)) effect(ev, now);
            if (auto && !game.spinning && now >= autoAt && (!show || shown >= show.amount)) {
                if (game.credits < game.bet() && !game.broke()) game.maxBet();
                if (game.broke() || parked.moving()) { auto = false; if (game.broke()) showToast('Out of credits: autoplay off'); } else spin();
            }
        }
        function effect(ev, now) {
            if (ev.type === 'stop') {
                stopAt[ev.reel] = now;
                const [x] = A.cellCentre(ev.reel, 0);
                for (let i = 0; i < 6; i++) sparks.push({ x: x + (Math.random() - 0.5) * A.REEL_W, y: A.WIN.y + A.WIN.h - 4, vx: (Math.random() - 0.5) * 120, vy: -60 - Math.random() * 90, at: now, ms: 300 });
            } else if (ev.type === 'win') {
                const mult = ev.amount / game.result.bet;
                show = { amount: ev.amount, level: ev.level, wins: ev.wins, at: now, countMs: Math.min(5000, 500 + mult * 90), jackpot: ev.jackpot };
                shown = 0;
                if (ev.amount > bestWin) bestWin = ev.amount;
                if (ev.level === 'big' || ev.level === 'mega') fountain(now, ev.level === 'mega' ? 70 : 36);
            } else if (ev.type === 'done') {
                const r = game.result;
                autoAt = now + AUTO_WAIT[r.level] + (r.win ? Math.min(5000, 500 + r.win / r.bet * 90) : 0);
                save();
                log.info('lucky_sevens: bet ' + r.bet + ', win ' + r.win + ' (' + r.level + '), credits ' + game.credits);
            }
        }
        function fountain(now, n) {
            for (let i = 0; i < n; i++) {
                const x = A.WIN.x + A.WIN.w / 2 + (Math.random() - 0.5) * 300;
                coins.push({ x, y: A.WIN.y + A.WIN.h + 10, vx: (Math.random() - 0.5) * 900, vy: -500 - Math.random() * 520, at: now + i * 25, ph: Math.random() * 8, spin: 10 + Math.random() * 14 });
            }
        }

        /* ---------- drawing ---------- */
        function drawBulbs(cv, now) {
            const L = A.bulbLayer(), n = A.BULBS.length;
            const head = Math.floor(now / 45) % n;
            A.BULBS.forEach(([x, y], i) => {
                let on;
                if (game.spinning) on = (head - i + n) % n < 8 || (head - i + n) % n === n / 2;   // a chase round the machine
                else if (show && now - show.at < 3000) on = Math.floor(now / 140) % 2 === i % 2;     // flashing
                else on = Math.floor(now / 700 + i / 3) % 3 !== 0;                                  // a slow idle walk
                if (on) cv.blit(L, x - 30, y - 30);
            });
        }
        /** the cells that pay on the line on show (or on every winning line, the first moment) */
        function winningCells(now) {
            if (!show || game.spinning) return null;
            const t = now - show.at, n = show.wins.length;
            const all = t < 900 || n === 1;
            const lines = all ? show.wins : [show.wins[Math.floor((t - 900) / LINE_MS) % n]];
            const cells = new Set();
            for (const w of lines) for (let i = 0; i < w.count; i++) cells.add(i + ',' + M.LINES[w.line][i]);
            return { cells, lines };
        }
        function drawReels(cv, now) {
            const cells = winningCells(now);
            cv.clip(A.WIN.x, A.WIN.y, A.WIN.w, A.WIN.h);
            for (let i = 0; i < M.REELS; i++) {
                A.drawDrum(cv, i);
                const r = game.reels[i], v = Math.abs(game.speed(i));
                const frac = r.pos - Math.floor(r.pos);
                // the thump of a reel that just stopped: a few px down and back
                const th = now - stopAt[i] < 160 ? Math.sin((now - stopAt[i]) / 160 * Math.PI) * 4 : 0;
                for (let k = 0; k <= (frac > 0 || th ? 3 : 2); k++) {
                    const name = game.symbolAt(i, k);
                    const y = A.WIN.y + (k - frac) * A.ROW_H + th;
                    const x = A.reelX(i);
                    if (v > 0.012) { cv.blit(A.blurLayer(name), x, y - 30); continue; }
                    const hit = cells && k >= 0 && k <= 2 && frac === 0 && cells.cells.has(i + ',' + k);
                    if (hit && name !== 'cherry' && name !== 'lemon') cv.blit(A.raysLayer(), x, y);
                    else if (hit) A.glow(cv, x + A.REEL_W / 2, y + A.ROW_H / 2, 70, GOLD, 0.5);
                    // a winning symbol breathes: drawn a touch higher and lit for a moment
                    const lift = hit ? Math.max(0, Math.sin(now / 160)) * 3 : 0;
                    cv.blit(A.symbolLayer(name), x, y - 10 - lift);
                }
                A.drawDrumShade(cv, i);
            }
            if (cells) {
                for (const c of cells.cells) { const [i, k] = c.split(',').map(Number); A.drawCellFrame(cv, i, k, GOLD, 0.75 + 0.25 * Math.sin(now / 120)); }
                for (const w of cells.lines) A.drawPayline(cv, M.LINES[w.line], w.line, 1);
            }
            A.drawGlass(cv);
            cv.noclip();
        }
        function drawBanner(cv, now) {
            if (!show || game.spinning) return;
            const k = Math.min(1, (now - show.at) / show.countMs);
            shown = Math.max(shown, Math.round(show.amount * (1 - Math.pow(1 - k, 2))));
            const bw = 400, bx = A.WIN.x + A.WIN.w / 2 - bw / 2, by = A.WIN.y + A.WIN.h - 16;
            const pop = Math.min(1, (now - show.at) / 180);
            const h = 60 * (0.7 + 0.3 * pop);
            const y = by + (60 - h) / 2;
            cv.roundRect(bx + 6, y + 8, bw, h, h / 2, withAlpha('#000000', 0.5));
            cv.card(bx, y, bw, h, h / 2, [[0, '#a8701a'], [1, '#5a3a00']]);
            A.moulding(cv, bx, y, bw, h, h / 2, 6, A.GOLD);
            cv.card(bx + 6, y + 6, bw - 12, h - 12, (h - 12) / 2, [[0, '#8a0c30'], [0.5, '#5a0620'], [1, '#2a0310']]);
            cv.roundRect(bx + 14, y + 8, bw - 28, h * 0.26, h * 0.13, withAlpha('#ffffff', 0.12));
            A.outlined(cv, 'WIN  ' + fmt(shown), bx + bw / 2, y + h / 2 + 12, 34 * (0.7 + 0.3 * pop), '#ffe9a8', '#6a0018', 2, { shadow: false, literal: true });
        }
        function drawBigWin(cv, now) {
            if (!show || (show.level !== 'big' && show.level !== 'mega') || game.spinning) return;
            const t = now - show.at;
            if (t > show.countMs + 1500) return;
            const a = t < 200 ? t / 200 : t > show.countMs + 1000 ? 1 - (t - show.countMs - 1000) / 500 : 1;
            const s = 1 + 0.06 * Math.sin(now / 110);
            const cx = A.WIN.x + A.WIN.w / 2, cy = A.WIN.y + A.WIN.h / 2;
            cv.roundRect(A.WIN.x, A.WIN.y, A.WIN.w, A.WIN.h, 6, withAlpha('#000000', 0.45 * a));
            A.glow(cv, cx, cy, 260, show.jackpot ? '#ff3d7f' : GOLD, 0.6 * a);
            const label = show.jackpot ? 'JACKPOT' : show.level === 'mega' ? 'MEGA WIN' : 'BIG WIN';
            cv.alpha(a);
            A.outlined(cv, label, cx, cy + 8, 78 * s, '#fff3c4', show.jackpot ? '#c2185b' : '#a8701a', 4, { spacing: 4 });
            cv.text(fmt(shown), cx, cy + 62, 40, GOLD, { font: 'num', align: 'center', literal: true });
            cv.alpha(1);
        }
        function drawCoins(cv, dt, now) {
            const s = dt / 1000;
            coins = coins.filter((c) => c.y < H + 40 && now - c.at < 4000);
            for (const c of coins) {
                if (now < c.at) continue;
                c.x += c.vx * s; c.y += c.vy * s; c.vy += 1100 * s; c.ph += c.spin * s;
                cv.blit(A.coinLayer(Math.floor(c.ph) % 8), c.x - A.COIN_R - 3, c.y - A.COIN_R - 3);
            }
            sparks = sparks.filter((p) => now - p.at < p.ms);
            for (const p of sparks) {
                const k = (now - p.at) / p.ms, x = p.x + p.vx * k * p.ms / 1000, y = p.y + p.vy * k * p.ms / 1000;
                cv.line(x, y, x - p.vx * 0.03, y - p.vy * 0.03, 2, withAlpha('#ffe9a8', 0.8 * (1 - k)));
            }
        }
        function drawPanel(cv, now) {
            cv.blit(A.panelLayer(), A.PANEL.x, A.PANEL.y);
            const counting = show && !game.spinning ? show.amount - shown : 0;
            const lcd = (q, v) => {
                A.glow(cv, q.x + q.w - 70, q.y + 29, 56, q.color, 0.12);
                cv.text(v, q.x + q.w - 14, q.y + 44, 38, q.color, { font: 'num', align: 'right', literal: true });
            };
            lcd(A.LCD.credit, fmt(game.credits - counting));
            lcd(A.LCD.bet, fmt(game.bet()));
            lcd(A.LCD.win, show && !game.spinning ? fmt(shown) : '0');
            const P = A.PANEL;
            // the line on show and what it pays, else the lines and the bet per line
            const cells = winningCells(now);
            if (cells && cells.lines.length === 1) {
                const w = cells.lines[0];
                cv.text('LINE ' + (w.line + 1) + '  ·  ' + w.count + ' x ' + w.sym.toUpperCase() + '  ·  ' + fmt(w.pay * game.result.bet / M.LINES.length), P.x + 28, P.y + 220, 15, A.LINE_COLOURS[w.line % A.LINE_COLOURS.length], { font: 'bold', spacing: 1.2, literal: true });
            } else cv.text(M.LINES.length + ' LINES  ·  ' + game.coin() + ' PER LINE', P.x + 28, P.y + 220, 15, withAlpha('#ffffff', 0.55), { font: 'bold', spacing: 1.5, literal: true });
            if (!(cells && cells.lines.length === 1)) cv.text('BEST WIN  ' + fmt(bestWin), P.x + P.w - 28, P.y + 220, 15, withAlpha(GOLD, 0.8), { font: 'bold', align: 'right', spacing: 1.5, literal: true });
            const down = (k) => pressed === k && now - pressedAt < 140;
            for (const k of ['betDown', 'betUp', 'max', 'auto']) {
                const q = A.BUTTONS[k];
                const st = down(k) ? 'down' : k === 'auto' && auto ? 'lit' : 'up';
                cv.blit(A.keyLayer(k, st), q.x, q.y);
            }
            const can = !parked.moving() && (game.spinning || game.credits >= M.COINS[0] * M.LINES.length || game.broke());
            const S = A.SPIN_BTN, ready = can && !game.spinning;
            if (ready) A.glow(cv, S.x, S.y, S.r * 1.6, '#ff2a4a', 0.35 + 0.15 * Math.sin(now / 300));
            cv.blit(A.spinLayer(down('spin') ? 'down' : can ? 'on' : 'off'), S.x - S.r - 2, S.y - S.r - 2);
            if (game.broke()) cv.text('PRESS FOR NEW CREDITS', S.x, S.y + S.r + 28, 13, PINK, { font: 'bold', align: 'center', spacing: 1, literal: true });
        }
        function drawHint(cv, touch) {
            const P = A.PANEL;
            const lines = touch
                ? ['Press: spin  ·  turn: bet', 'Push up: auto  ·  right: max bet']
                : ['Bar: Spin  ·  Bet +  ·  Auto', 'Smooth only with mgu-render'];
            lines.forEach((l, i) => cv.text(l, P.x + 24, P.y + 412 + i * 20, 14, withAlpha('#ffffff', 0.45), { font: 'label' }));
        }
        function drawParked(cv) {
            if (!parked.moving() || game.spinning) return;
            cv.roundRect(A.WIN.x, A.WIN.y, A.WIN.w, A.WIN.h, 6, withAlpha('#000000', 0.6));
            const cx = A.WIN.x + A.WIN.w / 2, cy = A.WIN.y + A.WIN.h / 2;
            cv.text('PARKED ONLY', cx, cy, 56, '#ffb020', { font: 'bold', align: 'center', spacing: 5 });
            cv.text('The reels turn again when the car stands still.', cx, cy + 40, 22, withAlpha('#ffffff', 0.75), { align: 'center' });
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear('#07040a');
            A.setTextScale(cv.textScale);
            const touch = !!cv.own || own();
            // the room: a dark casino floor, lights out of focus
            A.drawRoom(cv, 0, W);
            const col = cabinet();
            cv.blit(A.cabinetLayer(col, TITLE), A.CAB.x, A.CAB.y);
            drawReels(cv, now);
            for (const b of A.bandLayers(col, TITLE)) cv.blit(b.L, 0, b.y);
            drawBulbs(cv, now);
            drawBanner(cv, now);
            drawParked(cv);
            drawPanel(cv, now);
            drawHint(cv, touch);
            drawBigWin(cv, now);
            drawCoins(cv, dt, now);
            G.frame(cv, t, ['Lucky Sevens'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Lucky Sevens first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
