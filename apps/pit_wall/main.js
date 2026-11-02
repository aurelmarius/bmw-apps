'use strict';
/**
 * Pit Wall - break the advertising panels off the pit wall with the ball, catching it on the M front
 * wing. A night race scene, drawn by the GPU renderer every frame (mgu-render: up to 60 fps). Parked only.
 *
 * Panels shatter into shards, the ball draws a light trail (a fire trail in turbo), fuel cans go off
 * with a flash and shake the screen, a combo of panels in a row lights up its multiplier, and each
 * level starts with the start lights. The world is stepped at a fixed 60 Hz (model.js) whatever the
 * frame rate; without the renderer the frames go to the HMI as images, a few a second (slowly).
 *
 * Steering:
 *   iDrive controller (held by the app on screen): turn = move the wing, push left / right = a longer
 *     step, press or push up = launch the ball (waiting on the wing), press or push down = pause.
 *     Not playing: press starts / resumes, push left leaves, a turn lets go of the controller so it
 *     moves over the bar and the header.
 *   touchscreen (where the kit runs the screen): the wing follows the finger; a tap launches, a tap
 *     beside the field pauses.
 *   bar buttons "Left" / "Right" (where the kit doesn't run the screen) and "Launch".
 *
 * The rules are in model.js (tests/pit_wall.test.js), the drawing of things in art.js. The game
 * pauses when the screen goes, a sheet (Settings) opens over it or the car drives off (kit/parked.js),
 * and can't be started while moving.
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
const FX = 24, FY = 48;                                 // the field's top left corner (FW x FH, model.js)
const SIDE = { x: FX + M.FW + 24, y: 44, w: W - 24 - (FX + M.FW + 24), h: 468 };
const BLUE = '#7fd1ff', RED = '#e7222e', GOLD = '#ffb020', GREEN = '#5ff0a6';
const LEVEL_NAMES = ['Main Straight', 'The Wedge', 'Three Stripes', 'Chicane', 'Diamond', 'The Circuit'];

const KNOB_PX = 40, PUSH_PX = 150, BUTTON_PX = 120;
const BANNER_MS = 1800, FLASH_MS = 160;
const BEST_FILE = 'pit_wall_best.json';
const PARKED_MS = 500;

const LABEL = { ready: 'Start', playing: 'Pause', paused: 'Resume', over: 'Play Again' };
const POWER_TEXT = { wide: 'DRS OPEN', split: 'SPLIT x3', turbo: 'TURBO', slow: 'SLOW BALL', life: 'EXTRA LIFE' };

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;

        const speed = () => String(settings.get('speed') || 'normal');
        const bestFile = path.join(dataDir, BEST_FILE);
        const best = M.loadBest(bestFile, log);

        let game = new M.Game({ speed: speed() });
        let state = 'ready';            // ready | playing | paused | over
        let acc = 0, lastT = 0;
        let newBest = false, endAt = 0;
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        // effects, in screen px: shards and sparks, rising texts, rings, a banner, flashes, the shake
        let parts = [], texts = [], rings = [], banner = null;
        let shake = 0, wingHit = 0, lostAt = 0, goAt = 0, lastLights = -1;
        const flashes = new Map();       // panel -> when it was hit
        let frameT = Date.now();

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
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        function play() {
            if (parked.moving()) { showToast('Parked only: the game starts when the car stands still'); return; }
            if (state === 'over') newGame();
            if (state === 'playing') return;
            lastT = Date.now();
            setState('playing');
        }
        function pause() { if (state === 'playing') setState('paused'); }
        function newGame() {
            game = new M.Game({ speed: speed() });
            acc = 0; newBest = false;
            parts = []; texts = []; rings = []; banner = null; flashes.clear();
            setState('ready');
        }
        function end() {
            endAt = Date.now();
            const k = speed();
            newBest = game.score > (best[k] || 0);
            if (newBest) {
                best[k] = game.score;
                try { M.saveBest(bestFile, best); } catch (e) { log.warn('pit_wall: best score not saved: ' + e.message); }
            }
            log.info('pit_wall: over in level ' + game.level + ' with ' + game.score + ' (' + k + ')');
            setState('over');
        }
        const toggle = () => (state === 'playing' ? pause() : play());
        const held = () => game.balls.some((b) => b.held);
        /** press: launch a ball waiting on the wing, else pause */
        const pressPlaying = () => { if (held() && game.lights() < 0) game.launch(); else if (!held()) pause(); };

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', toggle);
        ui.onClick('BTN_NEW', () => { newGame(); play(); });
        ui.onClick('BTN_LEFT', () => { if (state === 'playing') game.nudge(-BUTTON_PX); });
        ui.onClick('BTN_RIGHT', () => { if (state === 'playing') game.nudge(BUTTON_PX); });
        ui.onClick('BTN_LAUNCH', () => { if (state === 'playing') game.launch(); else play(); });
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
                if (d) game.nudge(d * KNOB_PX);
                if (tilt === 'E' || tilt === 'W') game.nudge(tilt === 'E' ? PUSH_PX : -PUSH_PX);
                if (tilt === 'N') game.launch();
                if (tilt === 'S') pause();
                if (press) pressPlaying();
                return;
            }
            if (press) play();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (d) { menu = true; syncGrab(); }             // over to the bar and the header
        });
        // the finger: the wing follows it; a tap launches, a tap beside the field pauses
        let touch0 = null;
        const onField = (x, y) => x >= FX && x < FX + M.FW && y >= FY && y < FY + M.FH;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) touch0 = { x, y, t: Date.now(), field: onField(x, y) };
            if (!touch0) return;
            if (state === 'playing' && touch0.field) game.moveTo(x - FX);
            if (phase !== 3) return;
            const tap = Math.abs(x - touch0.x) < 30 && Math.abs(y - touch0.y) < 30 && Date.now() - touch0.t < 400;
            const t0 = touch0;
            touch0 = null;
            if (!tap) return;
            if (state !== 'playing') play();
            else if (t0.field) game.launch();
            else pause();
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => { if (k === 'speed') newGame(); });
        setInterval(() => {
            if (state === 'playing' && parked.moving()) { pause(); showToast('Paused: parked only', 4000); }
        }, PARKED_MS);

        /* ---------- the clock: the world in fixed steps ---------- */
        function advance(now) {
            if (state !== 'playing') { lastT = now; return; }
            if (display && display.sheet) { pause(); return; }
            acc += Math.min(100, now - lastT);                   // a stalled frame: no burst of steps
            lastT = now;
            while (acc >= M.DT) { game.step(M.DT); acc -= M.DT; }
            for (const ev of game.events.splice(0)) effect(ev, now);
            const n = game.lights();
            if (lastLights > 0 && n < 0) goAt = now;             // lights out
            lastLights = n;
            if (game.over && state === 'playing') end();
        }

        function burst(x, y, n, colors, speedPx, o) {
            o = o || {};
            for (let i = 0; i < n; i++) {
                const a = (o.up ? -Math.PI / 2 + (Math.random() - 0.5) * 2.2 : Math.random() * Math.PI * 2), v = speedPx * (0.3 + Math.random());
                parts.push({
                    x: FX + x + (o.w ? (Math.random() - 0.5) * o.w : 0), y: FY + y + (o.h ? (Math.random() - 0.5) * o.h : 0),
                    vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: (o.life || 600) * (0.6 + Math.random() * 0.6), age: 0,
                    c: colors[i % colors.length], s: (o.size || 6) * (0.5 + Math.random()), rot: Math.random() * 6, spin: (Math.random() - 0.5) * 14, spark: !!o.spark,
                });
            }
        }
        function effect(ev, now) {
            if (ev.type === 'break') {
                const p = ev.kind === 'armor' ? ['#3a3e46', '#9aa3ad', '#d9dde4'] : ev.kind === 'fuel' ? ['#ff7a2e', '#ffd000', '#1a1a1a'] : A.PALETTES[ev.hue % A.PALETTES.length];
                burst(ev.x, ev.y, ev.kind === 'armor' ? 16 : 12, [p[0], p[1], '#ffffff'], 260, { w: ev.w, h: ev.h, life: 750, size: 9 });
                texts.push({ x: FX + ev.x, y: FY + ev.y, s: '+' + ev.pts, at: now, c: ev.mult > 1 ? GOLD : '#ffffff', big: ev.mult > 1 });
                if (ev.kind === 'armor') shake = Math.max(shake, 3);
            } else if (ev.type === 'dent') {
                const q = game.bricks.find((b) => b.x === ev.x && b.y === ev.y);
                if (q) flashes.set(q, now);
                burst(ev.x, ev.y, 8, ['#ffffff', '#d9dde4'], 220, { spark: true, life: 300 });
            } else if (ev.type === 'boom') {
                rings.push({ x: FX + ev.x, y: FY + ev.y, at: now, r: 160, c: '#ffb020', ms: 450, fill: true });
                burst(ev.x, ev.y, 50, ['#ffd000', '#ff7a2e', '#ff3b1f', '#ffffff'], 420, { life: 800, size: 7 });
                shake = Math.max(shake, 12);
            } else if (ev.type === 'wing') {
                wingHit = now;
                burst(ev.x, ev.y + 8, 10, [BLUE, '#ffffff'], 260, { up: true, spark: true, life: 350 });
            } else if (ev.type === 'wall') burst(ev.x, ev.y, 5, ['#ffffff'], 180, { spark: true, life: 220 });
            else if (ev.type === 'launch') rings.push({ x: FX + ev.x, y: FY + ev.y, at: now, r: 60, c: BLUE, ms: 350 });
            else if (ev.type === 'lost') { lostAt = now; shake = Math.max(shake, 7); burst(ev.x, M.FH - 10, 24, [RED, '#ffffff'], 300, { up: true, spark: true, life: 500 }); } else if (ev.type === 'power') texts.push({ x: FX + ev.x, y: FY + ev.y, s: POWER_TEXT[ev.kind], at: now, c: A.POWER[ev.kind].c[0], big: true });
            else if (ev.type === 'level') banner = { s: 'LEVEL ' + ev.level, sub: LEVEL_NAMES[(ev.level - 1) % LEVEL_NAMES.length], c: BLUE, at: now };
            else if (ev.type === 'cleared') { texts.push({ x: FX + M.FW / 2, y: FY + 330, s: 'WALL CLEARED  +' + ev.bonus, at: now, c: GREEN, big: true }); flashes.clear(); }
        }

        /* ---------- drawing ---------- */
        function drawEffects(cv, ox, oy, dt, now) {
            parts = parts.filter((q) => (q.age += dt) < q.life);
            const s = dt / 1000;
            for (const q of parts) {
                q.x += q.vx * s; q.y += q.vy * s; q.vy += (q.spark ? 500 : 700) * s; q.rot += q.spin * s;
                const a = 1 - q.age / q.life, x = q.x + ox - FX, y = q.y + oy - FY;
                if (q.spark) { cv.line(x, y, x - q.vx * 0.03, y - q.vy * 0.03, 2, withAlpha(q.c, a)); continue; }
                const c = Math.cos(q.rot) * q.s / 2, sn = Math.sin(q.rot) * q.s / 2;
                cv.quad([[x - c + sn, y - sn - c], [x + c + sn, y + sn - c], [x + c - sn, y + sn + c * 0.6], [x - c - sn, y - sn + c * 0.6]], withAlpha(q.c, a));
            }
            rings = rings.filter((q) => now - q.at < q.ms);
            for (const q of rings) {
                const k = (now - q.at) / q.ms, r = 10 + q.r * k;
                if (q.fill) cv.circle(q.x + ox - FX, q.y + oy - FY, r, withAlpha('#fff1c9', 0.35 * (1 - k)));
                cv.arc(q.x + ox - FX, q.y + oy - FY, r, r + 4 + 8 * (1 - k), 0, 360, withAlpha(q.c, 0.8 * (1 - k)));
            }
            texts = texts.filter((q) => now - q.at < 1000);
            for (const q of texts) {
                const k = (now - q.at) / 1000;
                cv.text(q.s, q.x + ox - FX, q.y + oy - FY - 18 - k * 40, q.big ? 26 : 20, withAlpha(q.c, 1 - k * k), { font: 'bold', align: 'center' });
            }
            if (now - lostAt < 400) cv.gradientRect(ox, oy + M.FH - 120, M.FW, 120, [[0, withAlpha(RED, 0)], [1, withAlpha(RED, 0.35 * (1 - (now - lostAt) / 400))]]);
        }

        function drawField(cv, t, dt, now) {
            // the shake: a few px, dying away
            shake = Math.max(0, shake - dt * 0.04);
            const ox = FX + (shake ? (Math.random() - 0.5) * shake : 0), oy = FY + (shake ? (Math.random() - 0.5) * shake : 0);
            cv.clip(FX, FY, M.FW, M.FH);
            A.drawScene(cv, ox, oy, M.FW, M.FH, now);
            for (const q of game.bricks) {
                const f = flashes.get(q), k = f ? 1 - (now - f) / FLASH_MS : 0;
                A.drawPanel(cv, q, ox, oy, now, k > 0 ? k : 0);
            }
            for (const q of game.drops) A.drawPill(cv, ox + q.x, oy + q.y, q.kind, now);
            const turbo = game.t < game.until.turbo;
            for (const b of game.balls) A.drawBall(cv, b, ox, oy, turbo, now);
            const w = game.wing;
            A.drawWing(cv, ox + w.x, oy + w.y, w.w, now, { drs: game.t < game.until.wide, hit: Math.max(0, 1 - (now - wingHit) / 200) });
            drawEffects(cv, ox, oy, dt, now);
            cv.noclip();
            cv.strokeRoundRect(FX - 4, FY - 4, M.FW + 8, M.FH + 8, 10, 1.5, t.panelEdge);
            // the start lights, then GO
            const n = game.lights();
            if (n >= 0 && state !== 'over') A.drawLights(cv, FX + M.FW / 2, FY + 282, n, now);
            if (n < 0 && now - goAt < 700 && state === 'playing') {
                const k = (now - goAt) / 700;
                cv.text('GO!', FX + M.FW / 2, FY + 336, 64 + 30 * k, withAlpha(GREEN, 1 - k), { font: 'bold', align: 'center', spacing: 6 });
            }
            if (banner && now - banner.at < BANNER_MS && state !== 'over') {
                const k = (now - banner.at) / BANNER_MS, a = k < 0.15 ? k / 0.15 : k > 0.7 ? (1 - k) / 0.3 : 1;
                cv.text(banner.s, FX + M.FW / 2, FY + 380, 30, withAlpha(banner.c, a), { font: 'bold', align: 'center', spacing: 4 });
                if (banner.sub) cv.text(banner.sub.toUpperCase(), FX + M.FW / 2, FY + 402, 16, withAlpha('#ffffff', 0.8 * a), { font: 'bold', align: 'center', spacing: 3 });
            }
            // the combo, top right of the field
            const m = game.mult();
            if (m > 1 && state === 'playing') {
                const pulse = 1 + 0.08 * Math.sin(now / 90);
                cv.text('COMBO x' + m, FX + M.FW - 20, FY + 34, 30 * pulse, m >= 4 ? RED : GOLD, { font: 'bold', align: 'right', spacing: 2 });
            }
        }

        function drawOverlay(cv, t, now, touch) {
            if (state === 'playing') return;
            const moving = parked.moving();
            let title, lines;
            if (moving) {
                title = 'PARKED ONLY';
                lines = ['The wall waits while the car is moving.', 'The game goes on when you stop.'];
            } else if (state === 'ready') {
                title = 'PIT WALL';
                lines = touch ? ['Press the controller or tap to start', 'Turn to move the wing  ·  or slide it with a finger'] : ['Press "Start" to play', 'Move with "Left" and "Right" - smooth only with mgu-render'];
            } else if (state === 'paused') {
                title = 'PAUSED';
                lines = touch ? ['Press or tap to go on', 'Push left to leave  ·  turn for the menu'] : ['Press "Resume" to go on'];
            } else {
                if (now - endAt < 700) return;
                title = 'GAME OVER';
                lines = [newBest ? `New best: ${game.score}` : `Score ${game.score}  ·  level ${game.level}`, touch ? 'Press or tap to play again' : 'Press "Play Again"'];
            }
            cv.roundRect(FX - 4, FY - 4, M.FW + 8, M.FH + 8, 10, withAlpha(t.bg, 0.62));
            const mx = FX + M.FW / 2, my = FY + M.FH / 2;
            cv.text(title, mx, my - 18, 64, moving ? t.warn : state === 'over' ? RED : t.text, { font: 'bold', align: 'center', spacing: 5 });
            lines.forEach((l, i) => cv.text(l, mx, my + 34 + i * 34, 24, i === 0 && newBest && state === 'over' ? GOLD : t.dim, { align: 'center' }));
        }

        function drawSide(cv, t, now, touch) {
            G.panel(cv, t, SIDE.x, SIDE.y, SIDE.w, SIDE.h, 'Score');
            const x = SIDE.x + 22, b = best[speed()] || 0;
            cv.text(String(game.score), x, 150, 64, BLUE, { font: 'num' });
            cv.text('BEST', x, 196, 18, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(String(Math.max(b, game.score)), x, 230, 32, game.score > b ? GOLD : t.text, { font: 'num' });
            cv.text('LEVEL', x + 170, 196, 18, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(String(game.level), x + 170, 230, 32, t.text, { font: 'num' });
            cv.text('LIVES', x, 274, 18, t.dim, { font: 'bold', spacing: 1.5 });
            for (let i = 0; i < Math.max(0, game.lives); i++) A.drawWing(cv, x + 112 + i * 60, 270, 50, now);
            // the combo meter: five pips
            cv.text('COMBO', x, 314, 18, t.dim, { font: 'bold', spacing: 1.5 });
            const m = game.mult();
            for (let i = 0; i < 5; i++) cv.roundRect(x + 90 + i * 40, 300, 32, 16, 8, i < m ? (i >= 3 ? RED : GOLD) : withAlpha('#ffffff', 0.08));
            // what's on: DRS, turbo, slow with the time left
            let y = 350;
            for (const k of ['wide', 'turbo', 'slow']) {
                const left = game.until[k] - game.t;
                if (left <= 0) continue;
                const p = A.POWER[k], full = { wide: 12000, turbo: 7000, slow: 9000 }[k];
                cv.text(p.label, x, y + 12, 16, p.c[0], { font: 'bold' });
                cv.roundRect(x + 70, y + 2, SIDE.w - 114, 10, 5, withAlpha('#ffffff', 0.08));
                cv.roundRect(x + 70, y + 2, (SIDE.w - 114) * Math.min(1, left / full), 10, 5, p.c[0]);
                y += 26;
            }
            cv.text(touch ? 'Turn or slide: wing  ·  press: launch' : '"Left" / "Right" move the wing', x, 450, 17, t.dim);
            cv.text('Parked only: pauses when the car moves', x, 486, 17, t.dim);
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const touch = !!cv.own || own();
            G.frame(cv, t, ['Pit Wall'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            drawField(cv, t, state === 'playing' ? dt : 0, now);
            drawOverlay(cv, t, now, touch);
            drawSide(cv, t, now, touch);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Pit Wall first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
