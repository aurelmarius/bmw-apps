'use strict';
/**
 * Snake - the classic game on the central display, parked only.
 *
 * Drawn every frame by the GPU renderer (mgu-render: up to 60 fps): the snake slides from cell to
 * cell between two steps of the game, so it moves smoothly at any speed. Without the renderer the
 * frames go to the HMI as images, a few a second: still playable with the bar buttons.
 *
 * Steering:
 *   iDrive controller (held by the app on screen): push = go that way, turn = turn left / right,
 *     press = start, pause, resume. Not playing: push left leaves, a turn lets go of the controller
 *     so it moves over the button bar and the header (Settings) as in any other app.
 *   touchscreen (where the kit runs the screen): swipe = go that way, tap on the board = turn
 *     towards the tap, tap beside it = pause / resume.
 *   bar buttons "Turn Left" / "Turn Right": where the kit doesn't run the screen (hidden there).
 *
 * The rules are in model.js (tests/snake.test.js). The game pauses when the screen goes, a sheet
 * (Settings) opens over it or the car drives off (kit/parked.js), and can't be started while moving.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const { TILT } = require('./kit/display');
const parkedWatch = require('./kit/parked').watch;
const M = require('./model');

const W = 1600, H = 520;
const COLS = 34, ROWS = 15, CELL = 30;
const BX = 28, BY = 54;                                // the board's top left corner
const BW = COLS * CELL, BH = ROWS * CELL;
const SIDE = { x: BX + BW + 24, y: 44, w: W - 24 - (BX + BW + 24), h: 468 };
const SNAKE = '#2fd27a', SNAKE_TAIL = '#127a45', DEAD = '#ef2b2d', FOOD = '#ef2b2d', GOLD = '#ffb020';

const DEATH_MS = 900;                                  // the snake flashes this long after a crash
const EAT_MS = 320;                                    // ring where the food was eaten
const BEST_FILE = 'snake_best.json';
const PARKED_MS = 500;

const LABEL = { ready: 'Start', playing: 'Pause', paused: 'Resume', over: 'Play Again' };

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;

        const mode = () => ({ speed: String(settings.get('speed') || 'normal'), walls: String(settings.get('walls') || 'wrap') });
        const bestKey = () => mode().speed + '/' + mode().walls;
        const bestFile = path.join(dataDir, BEST_FILE);
        const best = M.loadBest(bestFile, log);

        let game = new M.Game({ cols: COLS, rows: ROWS, walls: mode().walls });
        let state = 'ready';            // ready | playing | paused | over
        let lastStep = 0;               // when the last step was taken (playing)
        let frac = 0;                   // how far into the next step (kept over a pause)
        let endAt = 0, newBest = false;
        let eatFx = null;               // { x, y, at }
        let visible = false, menu = false;   // menu: the controller let go to move over the bar
        let toast = null, toastUntil = 0;

        function showToast(msg, ms) { toast = msg; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());

        /* ---------- state ---------- */
        function setState(s) {
            if (s === state) return;
            state = s;
            menu = false;
            Promise.resolve(ui.text('BTN_PLAY', LABEL[s])).catch(() => {});
            syncGrab();
        }
        /** the controller is the game's while its screen shows, unless the user turned to the bar */
        function syncGrab() {
            if (ctx.controller) ctx.controller.grab(visible && !menu);
        }
        function play() {
            if (parked.moving()) { showToast('Parked only: the game starts when the car stands still'); return; }
            if (state === 'over') newGame();
            if (state === 'playing') return;
            lastStep = Date.now() - frac * M.Game.stepMs(mode().speed, game.score);
            setState('playing');
        }
        function pause() {
            if (state !== 'playing') return;
            frac = Math.min(1, (Date.now() - lastStep) / M.Game.stepMs(mode().speed, game.score));
            setState('paused');
        }
        function newGame() {
            game = new M.Game({ cols: COLS, rows: ROWS, walls: mode().walls });
            frac = 0; newBest = false; eatFx = null;
            setState('ready');
        }
        function end(ev, now) {
            endAt = now;
            const k = bestKey();
            newBest = game.score > (best[k] || 0);
            if (newBest) {
                best[k] = game.score;
                try { M.saveBest(bestFile, best); } catch (e) { log.warn('snake: best score not saved: ' + e.message); }
            }
            log.info('snake: ' + ev + ' with ' + game.score + ' (' + k + ')');
            setState('over');
        }
        const toggle = () => (state === 'playing' ? pause() : play());

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', toggle);
        ui.onClick('BTN_NEW', () => { newGame(); play(); });
        ui.onClick('BTN_LEFT', () => { if (state === 'playing') game.turnBy(-1); });
        ui.onClick('BTN_RIGHT', () => { if (state === 'playing') game.turnBy(1); });
        if (ctx.hideButton) { ctx.hideButton('BTN_LEFT'); ctx.hideButton('BTN_RIGHT'); }

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
            const press = down(pb) && !(L && down(L.pb));
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            if (state === 'playing') {
                if (tilt) game.turn(tilt);
                if (d) game.turnBy(d);
                if (press) pause();
                return;
            }
            if (press) play();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (d) { menu = true; syncGrab(); }             // over to the bar and the header
        });
        // a tap on the board turns towards it (across the way the snake goes); beside it pauses / resumes
        if (ctx.onTap) ctx.onTap((x, y) => {
            const onBoard = x >= BX && x < BX + BW && y >= BY && y < BY + BH;
            if (state !== 'playing' || !onBoard) { toggle(); return; }
            const h = game.snake[0], dx = x - (BX + (h.x + 0.5) * CELL), dy = y - (BY + (h.y + 0.5) * CELL);
            const across = game.dir === 'E' || game.dir === 'W' ? (dy < 0 ? 'N' : 'S') : (dx < 0 ? 'W' : 'E');
            game.turn(across);
        });
        if (ctx.onSwipe) ctx.onSwipe((dx, dy) => {
            if (state !== 'playing') return;
            game.turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N'));
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => {
            if (k === 'walls') newGame();
        });
        setInterval(() => {
            if (state === 'playing' && parked.moving()) { pause(); showToast('Paused: parked only', 4000); }
        }, PARKED_MS);

        /* ---------- the clock: steps taken as the frames come ---------- */
        function advance(now) {
            if (state !== 'playing') return;
            if (display && display.sheet) { pause(); return; }
            let ms = M.Game.stepMs(mode().speed, game.score);
            if (now - lastStep > ms * 3) lastStep = now - ms;   // a stalled frame: no burst of steps
            while (now - lastStep >= ms) {
                lastStep += ms;
                const ev = game.step();
                if (ev === 'eat') { eatFx = { x: game.snake[0].x, y: game.snake[0].y, at: now }; ms = M.Game.stepMs(mode().speed, game.score); }
                if (ev === 'dead' || ev === 'won') { end(ev, now); return; }
            }
            frac = Math.min(1, (now - lastStep) / ms);
        }

        /* ---------- drawing ---------- */
        const cx = (x) => BX + (x + 0.5) * CELL, cy = (y) => BY + (y + 0.5) * CELL;

        function drawBoard(cv, t) {
            cv.roundRect(BX - 6, BY - 6, BW + 12, BH + 12, 12, t.panelBottom);
            for (let y = 0; y < ROWS; y++) for (let x = (y % 2); x < COLS; x += 2) cv.fillRect(BX + x * CELL, BY + y * CELL, CELL, CELL, withAlpha('#ffffff', 0.025));
            if (game.walls === 'solid') cv.strokeRoundRect(BX - 6, BY - 6, BW + 12, BH + 12, 12, 4, withAlpha(t.crit, 0.7));
            else cv.strokeRoundRect(BX - 6, BY - 6, BW + 12, BH + 12, 12, 1.5, t.panelEdge);
        }

        function drawSnake(cv, now) {
            const s = game.snake, p = game.prev, n = s.length, k = state === 'playing' ? frac : state === 'paused' ? frac : 1;
            const flash = state === 'over' && !game.won && now - endAt < DEATH_MS && Math.floor((now - endAt) / 150) % 2 === 0;
            // where each segment is now: from its cell before the step to its cell (a wrap jumps)
            const pos = s.map((c, i) => {
                const f = p[i] || c, far = Math.abs(c.x - f.x) + Math.abs(c.y - f.y) > 1;
                return far ? { x: cx(c.x), y: cy(c.y) } : { x: cx(f.x + (c.x - f.x) * k), y: cy(f.y + (c.y - f.y) * k) };
            });
            const col = (i) => (flash ? DEAD : mix(SNAKE, SNAKE_TAIL, n > 1 ? i / (n - 1) : 0));
            for (let i = n - 1; i > 0; i--) {
                const a = pos[i], b = pos[i - 1];
                if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= CELL * 1.5) cv.line(a.x, a.y, b.x, b.y, CELL - 8, col(i));
            }
            for (let i = n - 1; i >= 0; i--) {
                const q = pos[i], sz = i === 0 ? CELL - 2 : CELL - 6;
                cv.roundRect(q.x - sz / 2, q.y - sz / 2, sz, sz, i === 0 ? 9 : 7, col(i));
            }
            // eyes, looking the way the snake goes
            const h = pos[0], [dx, dy] = M.DIRS[game.dir], ex = -dy * 7, ey = dx * 7;
            for (const sgn of [1, -1]) {
                cv.circle(h.x + dx * 5 + ex * sgn, h.y + dy * 5 + ey * sgn, 4.5, '#ffffff');
                cv.circle(h.x + dx * 7 + ex * sgn, h.y + dy * 7 + ey * sgn, 2.2, '#04060a');
            }
        }

        function drawFood(cv, now) {
            if (game.food) {
                const r = CELL * 0.3 + Math.sin(now / 180) * 2;
                cv.circle(cx(game.food.x), cy(game.food.y), r + 6, withAlpha(FOOD, 0.18));
                cv.circle(cx(game.food.x), cy(game.food.y), r, FOOD);
                cv.circle(cx(game.food.x) - r * 0.35, cy(game.food.y) - r * 0.35, r * 0.28, withAlpha('#ffffff', 0.6));
            }
            if (eatFx && now - eatFx.at < EAT_MS) {
                const q = (now - eatFx.at) / EAT_MS;
                cv.arc(cx(eatFx.x), cy(eatFx.y), CELL * (0.4 + q), CELL * (0.4 + q) + 3, 0, 360, withAlpha(GOLD, 1 - q));
            }
        }

        function drawOverlay(cv, t, now, touch) {
            if (state === 'playing') return;
            const moving = parked.moving();
            let title, lines;
            if (moving) {
                title = 'PARKED ONLY';
                lines = ['Snake waits while the car is moving.', 'It goes on when you stop.'];
            } else if (state === 'ready') {
                title = 'SNAKE';
                lines = [touch ? 'Press the controller or tap to start' : 'Press "Start" to play', touch ? 'Push or turn the controller, or swipe, to steer' : 'Steer with "Turn Left" and "Turn Right"'];
            } else if (state === 'paused') {
                title = 'PAUSED';
                lines = touch ? ['Press or tap to go on', 'Push left to leave  ·  turn for the menu'] : ['Press "Resume" to go on'];
            } else {
                if (now - endAt < DEATH_MS / 2) return;
                title = game.won ? 'BOARD FULL!' : 'GAME OVER';
                lines = [newBest ? `New best: ${game.score}` : `Score ${game.score}`, touch ? 'Press or tap to play again' : 'Press "Play Again"'];
            }
            cv.roundRect(BX - 6, BY - 6, BW + 12, BH + 12, 12, withAlpha(t.bg, 0.62));
            const mx = BX + BW / 2, my = BY + BH / 2;
            cv.text(title, mx, my - 18, 64, moving ? t.warn : state === 'over' && !game.won ? DEAD : t.text, { font: 'bold', align: 'center', spacing: 4 });
            lines.forEach((l, i) => cv.text(l, mx, my + 34 + i * 34, 24, i === 0 && newBest && state === 'over' ? GOLD : t.dim, { align: 'center' }));
        }

        function drawSide(cv, t, touch) {
            G.panel(cv, t, SIDE.x, SIDE.y, SIDE.w, SIDE.h, 'Score');
            const x = SIDE.x + 24, m = mode(), b = best[bestKey()] || 0;
            cv.text(String(game.score), x, 152, 76, SNAKE, { font: 'num' });
            cv.text(`length ${game.snake.length}`, x + 6 + cv.textWidth(String(game.score), 76, { font: 'num' }), 152, 22, t.dim);
            cv.text('BEST', x, 202, 20, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(String(Math.max(b, game.score)), x, 240, 36, game.score > b ? GOLD : t.text, { font: 'num' });
            cv.text(`${m.speed[0].toUpperCase() + m.speed.slice(1)}  ·  ${m.walls === 'solid' ? 'solid walls' : 'wrap around'}`, x + 120, 240, 20, t.dim);
            cv.fillRect(x, 268, SIDE.w - 48, 1.5, withAlpha('#ffffff', 0.15));
            cv.text('CONTROLS', x, 302, 20, t.dim, { font: 'bold', spacing: 1.5 });
            const help = touch
                ? ['Push the controller: go that way', 'Turn it: turn left / right', 'Press: pause  ·  swipe or tap to steer']
                : ['"Turn Left" / "Turn Right" steer', 'Faster with the GPU renderer', '(mgu-render from the Store)'];
            help.forEach((l, i) => cv.text(l, x, 336 + i * 30, 20, t.text));
            cv.text('Parked only: pauses when the car moves', x, 486, 18, t.dim);
        }

        function render() {
            const now = Date.now();
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const touch = !!cv.own || own();
            G.frame(cv, t, ['Snake'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            drawBoard(cv, t);
            drawFood(cv, now);
            drawSnake(cv, now);
            drawOverlay(cv, t, now, touch);
            drawSide(cv, t, touch);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Snake first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
