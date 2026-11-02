'use strict';
/**
 * Track Defender - an arcade shooter on the central display, parked only: drones come over the
 * track in waves and the M car down on it shoots them out of the sky.
 *
 * Drawn every frame by the GPU renderer (mgu-render: up to 60 fps), with a field of drifting stars,
 * particle explosions and glowing shots. The world is stepped at a fixed 60 Hz (model.js), whatever
 * the frame rate. Without the renderer the frames go to the HMI as images, a few a second: it runs,
 * but slowly - the game says so.
 *
 * Steering:
 *   iDrive controller (held by the app on screen): turn = drive left / right, push left / right = a
 *     longer step, push up = pulse, press or push down = pause. Not playing: press starts / resumes,
 *     push left leaves, a turn lets go of the controller so it moves over the bar and the header.
 *   touchscreen (where the kit runs the screen): the car follows the finger; a tap beside the field
 *     pauses, a tap on the pulse meter fires the pulse.
 *   bar buttons "Left" / "Right" (where the kit doesn't run the screen) and "Pulse".
 * The car fires by itself.
 *
 * The rules are in model.js (tests/track_defender.test.js). The game pauses when the screen goes, a
 * sheet (Settings) opens over it or the car drives off (kit/parked.js), and can't be started while moving.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const { TILT } = require('./kit/display');
const parkedWatch = require('./kit/parked').watch;
const M = require('./model');
const { drawM } = require('./car_art');

const W = 1600, H = 520;
const FX = 24, FY = 48;                                 // the field's top left corner (FW x FH, model.js)
const SIDE = { x: FX + M.FW + 24, y: 44, w: W - 24 - (FX + M.FW + 24), h: 468 };
const PULSE_BOX = { x: SIDE.x + 20, y: 330, w: SIDE.w - 40, h: 70 };
const BLUE = '#81c4ff', DARK_BLUE = '#16588e', RED = '#e7222e', GOLD = '#ffb020', GREEN = '#2fd27a';
const DRONE_C = { drone: '#7fd1ff', heavy: '#c04cdc', boss: '#ef2b2d' };

const KNOB_PX = 42, PUSH_PX = 160, BUTTON_PX = 120;
const STARS = 90;
const BANNER_MS = 1600;
const BEST_FILE = 'track_defender_best.json';
const PARKED_MS = 500;

const LABEL = { ready: 'Start', playing: 'Pause', paused: 'Resume', over: 'Play Again' };
const POWER = { double: ['x2', GOLD, 'DOUBLE FIRE'], guard: ['S', BLUE, 'GUARD'], life: ['+1', GREEN, 'EXTRA LIFE'] };

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;

        const level = () => String(settings.get('difficulty') || 'normal');
        const bestFile = path.join(dataDir, BEST_FILE);
        const best = M.loadBest(bestFile, log);

        let game = new M.Game({ difficulty: level() });
        let state = 'ready';            // ready | playing | paused | over
        let acc = 0, lastT = 0;         // world time not stepped yet, and when the last frame was
        let newBest = false, endAt = 0;
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        // effects, in screen px: particles, rising texts, rings, a banner, the red flash of a hit
        let parts = [], texts = [], rings = [], banner = null, flashAt = 0;
        const stars = Array.from({ length: STARS }, () => ({ x: Math.random() * M.FW, y: Math.random() * M.FH, v: 12 + Math.random() * 50, s: Math.random() < 0.2 ? 2.4 : 1.4 }));
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
            game = new M.Game({ difficulty: level() });
            acc = 0; newBest = false;
            parts = []; texts = []; rings = []; banner = null;
            setState('ready');
        }
        function end() {
            endAt = Date.now();
            const k = level();
            newBest = game.score > (best[k] || 0);
            if (newBest) {
                best[k] = game.score;
                try { M.saveBest(bestFile, best); } catch (e) { log.warn('track_defender: best score not saved: ' + e.message); }
            }
            log.info('track_defender: ' + game.why + ' in wave ' + game.wave + ' with ' + game.score + ' (' + k + ')');
            setState('over');
        }
        const toggle = () => (state === 'playing' ? pause() : play());
        const firePulse = () => { if (state === 'playing' && !game.pulse()) showToast('Pulse charging', 1200); };

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', toggle);
        ui.onClick('BTN_NEW', () => { newGame(); play(); });
        ui.onClick('BTN_LEFT', () => { if (state === 'playing') game.nudge(-BUTTON_PX); });
        ui.onClick('BTN_RIGHT', () => { if (state === 'playing') game.nudge(BUTTON_PX); });
        ui.onClick('BTN_PULSE', firePulse);
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
                if (tilt === 'N') firePulse();
                if (press || tilt === 'S') pause();
                return;
            }
            if (press) play();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (d) { menu = true; syncGrab(); }             // over to the bar and the header
        });
        // the finger: the car follows it over the field; a tap beside the field pauses, on the pulse meter pulses
        let touch0 = null;
        const inBox = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
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
            else if (inBox(x, y, PULSE_BOX)) firePulse();
            else if (!t0.field) pause();
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => { if (k === 'difficulty') newGame(); });
        setInterval(() => {
            if (state === 'playing' && parked.moving()) { pause(); showToast('Paused: parked only', 4000); }
        }, PARKED_MS);

        /* ---------- the clock: the world in fixed steps, as many as the time since the last frame ---------- */
        function advance(now) {
            if (state !== 'playing') { lastT = now; return; }
            if (display && display.sheet) { pause(); return; }
            acc += Math.min(100, now - lastT);                   // a stalled frame: no burst of steps
            lastT = now;
            while (acc >= M.DT) { game.step(M.DT); acc -= M.DT; }
            for (const ev of game.events.splice(0)) effect(ev, now);
            if (game.over && state === 'playing') end();
        }

        function burst(x, y, n, colors, speed) {
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
                parts.push({ x: FX + x, y: FY + y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 450 + Math.random() * 400, age: 0, c: colors[i % colors.length], s: 3 + Math.random() * 4 });
            }
        }
        function effect(ev, now) {
            if (ev.type === 'boom') {
                const c = DRONE_C[ev.kind] || DRONE_C.drone;
                burst(ev.x, ev.y, ev.big ? 90 : 18, [c, '#ffffff', GOLD], ev.big ? 420 : 240);
                if (ev.pts) texts.push({ x: FX + ev.x, y: FY + ev.y, s: '+' + ev.pts, at: now, c: ev.big ? GOLD : '#ffffff' });
            } else if (ev.type === 'dent') burst(ev.x, ev.y, 5, ['#ffffff'], 140);
            else if (ev.type === 'hit') { flashAt = now; burst(ev.x, ev.y, 40, [RED, GOLD, '#ffffff'], 300); } else if (ev.type === 'guard') rings.push({ x: FX + ev.x, y: FY + ev.y, at: now, r: 80, c: BLUE, ms: 400 });
            else if (ev.type === 'pulse') rings.push({ x: FX + ev.x, y: FY + ev.y, at: now, r: 1300, c: BLUE, ms: 650 });
            else if (ev.type === 'power') texts.push({ x: FX + ev.x, y: FY + ev.y, s: POWER[ev.kind][2], at: now, c: POWER[ev.kind][1] });
            else if (ev.type === 'wave') banner = { s: ev.boss ? 'BOSS DRONE' : 'WAVE ' + ev.wave, c: ev.boss ? RED : BLUE, at: now };
            else if (ev.type === 'cleared') banner = { s: 'WAVE CLEARED', sub: '+' + 50 * ev.wave, c: GREEN, at: now };
        }

        /* ---------- drawing ---------- */
        function drawField(cv, t, dt) {
            cv.roundRect(FX - 6, FY - 6, M.FW + 12, M.FH + 12, 12, '#03050a');
            const v = state === 'playing' ? 1 : 0.25;
            for (const s of stars) {
                s.y += s.v * v * dt / 1000;
                if (s.y > M.FH) { s.y -= M.FH; s.x = Math.random() * M.FW; }
                cv.fillRect(FX + s.x, FY + s.y, s.s, s.s, withAlpha('#ffffff', 0.25 + s.v / 120));
            }
            // the track along the bottom: asphalt, M kerb
            const ty = FY + M.FH - 8;
            cv.fillRect(FX, ty - 30, M.FW, 30, withAlpha('#ffffff', 0.04));
            for (let x = 0, i = 0; x < M.FW; x += 32, i++) cv.fillRect(FX + x, ty, 32, 8, [BLUE, DARK_BLUE, RED][i % 3]);
            cv.strokeRoundRect(FX - 6, FY - 6, M.FW + 12, M.FH + 12, 12, 1.5, t.panelEdge);
        }

        function drawBarriers(cv) {
            for (const k of game.barriers) if (k.alive) cv.fillRect(FX + k.x - k.w / 2 + 0.5, FY + k.y - k.h / 2 + 0.5, k.w - 1, k.h - 1, mix(GREEN, '#0b3d24', (k.y - M.BARRIER.y) / 50));
        }

        function drawDrone(cv, e, now) {
            const x = FX + e.x, y = FY + e.y, c = e.type === 'heavy' && e.hp < 2 ? mix(DRONE_C.heavy, '#ffffff', 0.4) : DRONE_C[e.type];
            if (e.type === 'boss') {
                const w = e.w, h = e.h;
                [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
                    cv.line(x, y, x + sx * w * 0.42, y + sy * h * 0.55, 6, '#5a5c64');
                    cv.circle(x + sx * w * 0.42, y + sy * h * 0.55, 22, withAlpha('#ffffff', 0.12 + 0.08 * Math.sin(now / 40 + sx)));
                });
                cv.roundRect(x - w * 0.32, y - h / 2, w * 0.64, h, 14, '#2a2b31');
                cv.roundRect(x - w * 0.32 + 6, y - h / 2 + 6, w * 0.64 - 12, h - 12, 10, c);
                cv.circle(x - 22, y, 9, '#ffffff'); cv.circle(x + 22, y, 9, '#ffffff');
                cv.circle(x - 22, y + 2, 4, '#000000'); cv.circle(x + 22, y + 2, 4, '#000000');
                // its strength, above it
                const q = e.hp / e.maxHp;
                cv.roundRect(x - 90, y - h / 2 - 20, 180, 8, 4, withAlpha('#ffffff', 0.15));
                cv.roundRect(x - 90, y - h / 2 - 20, 180 * q, 8, 4, q > 0.3 ? GOLD : RED);
                return;
            }
            const a = 17;
            for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
                cv.line(x, y, x + sx * a, y + sy * a * 0.7, 3, '#5a5c64');
                cv.circle(x + sx * a, y + sy * a * 0.7, 8, withAlpha(c, 0.25 + 0.15 * Math.sin(now / 30 + sx * 2 + sy)));
            }
            cv.circle(x, y, e.type === 'heavy' ? 13 : 11, c);
            cv.circle(x, y + 1, 4, e.state === 'dive' ? RED : '#04060a');
        }

        function drawCar(cv, now) {
            const p = game.player, x = FX + p.x, y = FY + p.y;
            if (now < flashAt + 1800 && game.t < game.invuln && Math.floor(now / 90) % 2) return;
            if (game.guard) cv.arc(x, y - 8, 46, 50, 0, 360, withAlpha(BLUE, 0.55 + 0.25 * Math.sin(now / 120)));
            const since = game.t - (game.nextShot - M.SHOT_MS);          // ms since the last shot
            drawM(cv, x, y, 1, {
                lean: Math.max(-1, Math.min(1, (p.tx - p.x) / 40)),
                firing: state === 'playing' && since < 70 ? 1 - since / 70 : 0,
                double: game.t < game.double,
                spin: (p.x / 3) % 14,
            });
        }

        function drawShots(cv) {
            const dbl = game.t < game.double;
            for (const b of game.shots) {
                cv.roundRect(FX + b.x - 5, FY + b.y - b.h / 2 - 3, 10, b.h + 6, 5, withAlpha(dbl ? GOLD : BLUE, 0.25));
                cv.roundRect(FX + b.x - b.w / 2, FY + b.y - b.h / 2, b.w, b.h, 2.5, dbl ? '#ffe6a8' : '#e9f2ff');
            }
            for (const b of game.bullets) {
                cv.circle(FX + b.x, FY + b.y, 9, withAlpha(RED, 0.3));
                cv.circle(FX + b.x, FY + b.y, 5, '#ff8a8e');
            }
            for (const q of game.drops) {
                const [label, c] = POWER[q.kind];
                cv.roundRect(FX + q.x - 15, FY + q.y - 15, 30, 30, 8, withAlpha(c, 0.25));
                cv.strokeRoundRect(FX + q.x - 15, FY + q.y - 15, 30, 30, 8, 2, c);
                cv.text(label, FX + q.x, FY + q.y + 7, 18, c, { font: 'bold', align: 'center' });
            }
        }

        function drawEffects(cv, dt, now) {
            parts = parts.filter((q) => (q.age += dt) < q.life);
            for (const q of parts) {
                q.x += q.vx * dt / 1000; q.y += q.vy * dt / 1000; q.vy += 300 * dt / 1000;
                cv.fillRect(q.x - q.s / 2, q.y - q.s / 2, q.s, q.s, withAlpha(q.c, 1 - q.age / q.life));
            }
            texts = texts.filter((q) => now - q.at < 900);
            for (const q of texts) {
                const k = (now - q.at) / 900;
                cv.text(q.s, q.x, q.y - 20 - k * 40, 20, withAlpha(q.c, 1 - k), { font: 'bold', align: 'center' });
            }
            rings = rings.filter((q) => now - q.at < q.ms);
            for (const q of rings) {
                const k = (now - q.at) / q.ms, r = 20 + q.r * k;
                cv.arc(q.x, q.y, r, r + 6 + 10 * (1 - k), 0, 360, withAlpha(q.c, 0.8 * (1 - k)));
            }
            if (now - flashAt < 250) cv.fillRect(FX, FY, M.FW, M.FH, withAlpha(RED, 0.25 * (1 - (now - flashAt) / 250)));
            if (banner && now - banner.at < BANNER_MS && state !== 'over') {
                const k = (now - banner.at) / BANNER_MS, a = k < 0.15 ? k / 0.15 : k > 0.75 ? (1 - k) / 0.25 : 1;
                cv.text(banner.s, FX + M.FW / 2, FY + M.FH / 2 - 20, 58, withAlpha(banner.c, a), { font: 'bold', align: 'center', spacing: 5 });
                if (banner.sub) cv.text(banner.sub, FX + M.FW / 2, FY + M.FH / 2 + 24, 26, withAlpha('#ffffff', a), { font: 'bold', align: 'center' });
            }
        }

        function drawOverlay(cv, t, now, touch) {
            if (state === 'playing') return;
            const moving = parked.moving();
            let title, lines;
            if (moving) {
                title = 'PARKED ONLY';
                lines = ['The drones wait while the car is moving.', 'The game goes on when you stop.'];
            } else if (state === 'ready') {
                title = 'TRACK DEFENDER';
                lines = touch ? ['Press the controller or tap to start', 'Turn to drive  ·  push up: pulse  ·  or drive with a finger'] : ['Press "Start" to play', 'Drive with "Left" and "Right" - smooth only with mgu-render'];
            } else if (state === 'paused') {
                title = 'PAUSED';
                lines = touch ? ['Press or tap to go on', 'Push left to leave  ·  turn for the menu'] : ['Press "Resume" to go on'];
            } else {
                if (now - endAt < 900) return;
                title = game.why === 'invaded' ? 'TRACK OVERRUN' : 'GAME OVER';
                lines = [newBest ? `New best: ${game.score}` : `Score ${game.score}  ·  wave ${game.wave}`, touch ? 'Press or tap to play again' : 'Press "Play Again"'];
            }
            cv.roundRect(FX - 6, FY - 6, M.FW + 12, M.FH + 12, 12, withAlpha(t.bg, 0.6));
            const mx = FX + M.FW / 2, my = FY + M.FH / 2;
            cv.text(title, mx, my - 18, 60, moving ? t.warn : state === 'over' ? RED : t.text, { font: 'bold', align: 'center', spacing: 4 });
            lines.forEach((l, i) => cv.text(l, mx, my + 34 + i * 34, 24, i === 0 && newBest && state === 'over' ? GOLD : t.dim, { align: 'center' }));
        }

        function drawSide(cv, t, now, touch) {
            G.panel(cv, t, SIDE.x, SIDE.y, SIDE.w, SIDE.h, 'Score');
            const x = SIDE.x + 22, b = best[level()] || 0;
            cv.text(String(game.score), x, 150, 64, BLUE, { font: 'num' });
            cv.text('BEST', x, 196, 18, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(String(Math.max(b, game.score)), x, 230, 32, game.score > b ? GOLD : t.text, { font: 'num' });
            cv.text('WAVE', x + 170, 196, 18, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(String(game.wave), x + 170, 230, 32, t.text, { font: 'num' });
            // lives: small cars
            cv.text('LIVES', x, 270, 18, t.dim, { font: 'bold', spacing: 1.5 });
            for (let i = 0; i < Math.max(0, game.lives); i++) {
                drawM(cv, x + 98 + i * 36, 266, 0.42);
            }
            const pw = [game.t < game.double && `DOUBLE ${Math.ceil((game.double - game.t) / 1000)}s`, game.guard && 'GUARD'].filter(Boolean).join('  ·  ');
            if (pw) cv.text(pw, x, 304, 18, GOLD, { font: 'bold' });
            // the pulse meter (a tap on it fires)
            const q = game.pulseCharge(), ready = q >= 1, P = PULSE_BOX;
            cv.roundRect(P.x, P.y, P.w, P.h, 10, withAlpha(BLUE, ready ? 0.18 + 0.08 * Math.sin(now / 160) : 0.08));
            cv.strokeRoundRect(P.x, P.y, P.w, P.h, 10, 1.5, withAlpha(BLUE, ready ? 0.8 : 0.3));
            cv.text(ready ? 'PULSE READY' : 'PULSE CHARGING', P.x + 16, P.y + 28, 19, ready ? BLUE : t.dim, { font: 'bold', spacing: 1 });
            cv.text(touch ? (ready ? 'push up or tap here' : '') : (ready ? 'button "Pulse"' : ''), P.x + P.w - 16, P.y + 28, 16, t.dim, { align: 'right' });
            cv.roundRect(P.x + 16, P.y + 44, P.w - 32, 10, 5, withAlpha('#ffffff', 0.1));
            cv.roundRect(P.x + 16, P.y + 44, (P.w - 32) * q, 10, 5, ready ? BLUE : DARK_BLUE);
            cv.text(level()[0].toUpperCase() + level().slice(1) + '  ·  the car fires by itself', x, 440, 17, t.dim);
            cv.text('Parked only: pauses when the car moves', x, 486, 17, t.dim);
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const touch = !!cv.own || own();
            G.frame(cv, t, ['Track Defender'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            drawField(cv, t, dt);
            cv.clip(FX, FY, M.FW, M.FH);
            drawBarriers(cv);
            // (the clip is the GPU renderer's: drones still flying in from outside are left out for the software path)
            for (const e of game.enemies) if (e.x > -20 && e.x < M.FW + 20 && e.y > -20) drawDrone(cv, e, now);
            drawShots(cv);
            if (!(game.over && game.why === 'destroyed')) drawCar(cv, now);
            drawEffects(cv, dt, now);
            cv.noclip();
            drawOverlay(cv, t, now, touch);
            drawSide(cv, t, now, touch);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Track Defender first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
