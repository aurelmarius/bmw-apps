#!/usr/bin/env node
'use strict';
/**
 * screenshots.js - the README's screenshots (docs/screenshots/*.png), drawn by the built apps with sample
 * data: a sample state (some months after an oil change) and a car that sends steady values over a fake
 * SOME/IP and answers the diagnostic requests. No head unit needed.
 *
 *   python3 kit/tools/build.py engine_care hybrid_cost snake track_defender pit_wall lucky_sevens && node tools/screenshots.js
 *
 * Each app runs in its own process (the fake clock replaces Date.now and the timers).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const DAY = 86400000;

if (!process.argv[2]) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const app of ['engine_care', 'hybrid_cost', 'price_editor', 'snake', 'track_defender', 'pit_wall', 'lucky_sevens']) {
        process.stdout.write(execFileSync(process.execPath, [__filename, app], { encoding: 'utf8' }));
    }
    process.exit(0);
}

const which = process.argv[2];
const stage = path.join(ROOT, 'dist', which === 'price_editor' ? 'hybrid_cost' : which, 'source', 'javascript');
if (!fs.existsSync(stage)) { console.error('build it first: python3 kit/tools/build.py ' + which); process.exit(1); }
const { Canvas } = require(path.join(stage, 'kit', 'canvas'));
const { theme } = require(path.join(stage, 'kit', 'themes'));
const shot = (name, cv) => { fs.writeFileSync(path.join(OUT, name + '.png'), cv.png()); console.log('docs/screenshots/' + name + '.png'); };

/* ---------- the price editor: drawn on its own ---------- */
if (which === 'price_editor') {
    const M = require(path.join(stage, 'model'));
    const { priceSheet } = require(path.join(stage, 'price_sheet'));
    const t = theme('m_tricolour');
    const ed = new M.PriceEdit('EUR', 'petrol', 1.75);
    ['1', '.', '6', '9'].forEach((k) => ed.key(k));
    const cv = new Canvas(1600, 520);
    priceSheet({ edit: ed, title: 'Petrol price', unit: 'EUR per litre  ·  Euro', color: t.accent, onSave() {} }).draw(cv, t);
    shot('hybrid_cost-price-editor', cv);
    process.exit(0);
}

/* ---------- fake clock (setImmediate stays real: it drives the promise chains) ---------- */
let now = Date.UTC(2026, 9, 30, 15, 42);
Date.now = () => now;
const timers = [];
global.setInterval = (fn, ms) => { const t = { fn, ms, next: now + ms }; timers.push(t); return t; };
global.setTimeout = (fn, ms) => { const t = { fn, ms, next: now + (ms || 0), once: true }; timers.push(t); return t; };
global.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
global.clearInterval = global.clearTimeout;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms, every) {
    const end = now + ms;
    while (now < end) {
        now = Math.min(end, now + 50);
        for (const t of timers.slice()) if (t.next <= now) { if (t.once) timers.splice(timers.indexOf(t), 1); else t.next += t.ms; t.fn(); }
        if (now % 1000 === 0) { if (every) every(); await flush(); }
    }
}

/* ---------- the car ---------- */
const H = {};
let respond = null;
const car = { km: 48211.3, oil: 78, soc: 47 };
const frame = (ecu, uds) => ({ udsResponse: [0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds), errorCode: 'NO_ERROR' });
const signals = {
    watch: (iface, inst, handlers) => { H[iface] = Object.assign(H[iface] || {}, handlers); return Promise.resolve({ available: true, error: null }); },
    proxy: () => Promise.resolve({}),
    on: (p, name, fn) => { respond = fn; return Promise.resolve(); },
    onAvailable: (p, fn) => { fn(true); return Promise.resolve(); },
    call: (p, method, q) => {
        const d = Array.from(q.udsData), ecu = q.targetAddress, sid = q.serviceID;
        setImmediate(() => {
            if (ecu === 7 && sid === 0x22 && d[0] === 0xDD && d[1] === 0xBC) { const raw = car.soc * 10; return respond(frame(ecu, [0x62, 0xDD, 0xBC, raw >> 8, raw & 255])); }
            if (ecu === 0x12 && sid === 0x01 && d[0] === 0xA6) { const raw = Math.round(car.km * 10); return respond(frame(ecu, [0x41, 0xA6, (raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255])); }
            respond(frame(ecu, [0x7F, sid, 0x31]));
        });
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    },
};
const send = (iface, field, v) => H[iface] && H[iface][field] && H[iface][field](v);
function drive(kmh, rpm, nm, i) {
    car.km += kmh / 3600;
    send('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: Math.round((kmh + (i % 2) * 0.03) / 0.015625) });
    send('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: Math.round((rpm + (i % 3)) * 4) });
    send('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', { actualValueTorqueCrankshaft: Math.round((nm + (i % 2) + 1023.5) / 0.5) });
    send('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', { longitudinalAccelerationCentreOfGravity: Math.round((0.15 + 65) / 0.002) });
}

/* ---------- the app, as the build lays it out ---------- */
const APP = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-'));
const DATA = path.join(APP, 'data');
fs.cpSync(stage, APP, { recursive: true });
fs.mkdirSync(DATA);
fs.writeFileSync(path.join(APP, 'kit', 'mgu.js'), 'module.exports = { run: (app) => { global.__app = app; } };');
process.on('exit', () => fs.rmSync(APP, { recursive: true, force: true }));

const spec = JSON.parse(fs.readFileSync(path.join(APP, 'kit', 'app-spec.json'), 'utf8'));
const values = {};
spec.settings.forEach((s) => { values[s.key] = s.default; });
Object.assign(values, { demo: 'off', diagPage: true, currency: 'EUR', purePetrolAvg: 7.5 });
const clicks = {};
let last = null, lastRec = null;
// the app draws on the kit's recorder (as on the car); the recording is played into a canvas for the PNG
const { Recorder, play } = require(path.join(APP, 'kit', 'record'));
const { Canvas: AppCanvas } = require(path.join(APP, 'kit', 'canvas'));
const toCanvas = (r) => { const cv = new AppCanvas(r.w, r.h); play(r.words(), cv); return cv; };
// the last frame drawn, played into a canvas only when it is shot (the games draw hundreds before)
Object.defineProperty(global, 'lastFrame', { get: () => (lastRec ? (last = toCanvas(lastRec), lastRec = null, last) : last) });
const ctx = {
    ui: { onClick: (n, fn) => { clicks[n] = fn; }, image: (n, r) => { lastRec = r; return Promise.resolve(); }, onVisible() {}, text: async () => {} },
    settings: { get: (k) => values[k], set: (k, v) => { values[k] = v; }, onChange() {} },
    dataDir: DATA, signals, spec,
    log: { info() {}, warn() {}, error() {} },
    theme: () => theme(values.theme),
    canvas: (w, h) => { const r = new Recorder(w, h, { textScale: 1 }); r.reset(); return r; },
    loop: (n, fps, fn) => { ctx.draw = fn; }, hasClients: () => true,
};

/* ---------- sample states: some months after an oil change ---------- */
const H_ = 3600;
if (which === 'engine_care') {
    fs.writeFileSync(path.join(DATA, 'engine_care_state.json'), JSON.stringify({
        service: {
            resetDate: now - 96 * DAY, odoKm: 3842.5, odoBaseKm: 0, odoLast: { src: 'OBD A6', km: 48211.3 },
            iceSec: 27.4 * H_, evSec: 56.9 * H_, iceMeters: 1468e3, evMeters: 2375e3,
            iceStarts: 214, coldStarts: 46, coldHardStarts: 2, shortCycles: 8, shortCycleSec: 0.7 * H_,
            startsLowSoc: 131, startsWithCharge: 83, coldStartsWithCharge: 17, thermalStressSec: 0,
        },
        trip: { start: now - 38 * 60000, iceSec: 0.21 * H_, evSec: 0.38 * H_, iceMeters: 18.4e3, evMeters: 21.9e3, iceStarts: 3, coldStarts: 1, coldHardStarts: 0, shortCycles: 1 },
        history: [{ date: '2026-06-10', km: 9870, iceHours: 71.2, evHours: 121.5, iceKm: 4012, evKm: 5858, coldStarts: 158, coldHardStarts: 9, shortCycles: 37 }],
        lastLive: now - 60000,
        diag: { countedSec: 84.3 * H_, hiddenSec: 71.9 * H_, torqueEvMax: 4, torqueEvSec: 33 * H_ },
    }));
} else if (which === 'hybrid_cost') {
    fs.writeFileSync(path.join(DATA, 'hybrid_cost_state.json'), JSON.stringify({
        trip: { start: now - 41 * 60000, distanceMeters: 46.3e3, evMeters: 31.8e3, iceMeters: 14.5e3, evSec: 1690, iceSec: 790,
            kwhConsumed: 6.21, fuelLitersConsumed: 0.94, regenKwhHarvested: 0.87 },
        lastLive: now - 60000,
        prices: { EUR: { petrol: 1.69, elec: 0.28 } },
    }));
}

/* ---------- Pit Wall: a seeded game, the wing under the ball, caught in a combo ---------- */
if (which === 'pit_wall') {
    let seed = 5;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'pit_wall_best.json'), JSON.stringify({ normal: 9850 }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        clicks.BTN_PLAY();
        // up to level 4, then a frame just after a panel broke in a combo of x3 or more (or after 20 minutes)
        for (let i = 0; i < 75000; i++) {
            now += 16;
            const b = g.balls.find((q) => !q.held) || g.balls[0];
            g.moveTo(b.x + Math.sin(now / 1900) * g.wing.w * 0.3);
            const before = g.score;
            await ctx.draw();
            if (g.over) clicks.BTN_NEW();
            if (g.level >= 4 && g.mult() >= 3 && g.score > before && g.bricks.length < 45) break;
        }
        for (let k = 0; k < 5; k++) { now += 16; await ctx.draw(); }
        shot('pit_wall-game', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Lucky Sevens: seeded spins, the reels caught running, then a win on several lines ---------- */
if (which === 'lucky_sevens') {
    let seed = 7;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'lucky_sevens.json'), JSON.stringify({
        credits: 48320, coin: 5, jackpot: 24870.5,
        stats: { spins: 1284, bet: 412650, won: 398420, bestWin: 12500, streak: 0, bestStreak: 9, freeRounds: 6, jackpots: 0, bestJackpot: 0 },
    }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms) => { for (let t = 0; t < ms; t += 16) { now += 16; await ctx.draw(); } };
        // the reels running: the last ones still a blur
        clicks.BTN_SPIN();
        await frames(1150);
        shot('lucky_sevens-spin', lastFrame);
        // spins until one pays three sevens or more and on other lines too; its first moment: every line lit
        for (let i = 0; i < 3000; i++) {
            while (g.spinning) await frames(16);
            const r = g.result;
            if (r.wins.length >= 2 && r.level === 'win' && r.wins.some((w) => w.sym === 'seven' && w.count >= 3)) break;
            await frames(1500);
            g.credits = Math.max(g.credits, 5000);
            clicks.BTN_SPIN();
        }
        await frames(450);
        shot('lucky_sevens-win', lastFrame);
        // on to free spins: three WILDs, their announcement
        for (let i = 0; i < 5000; i++) {
            await frames(1500);
            g.credits = Math.max(g.credits, 5000);
            if (g.free.left) g.free.left = 0;
            clicks.BTN_SPIN();
            while (g.spinning) await frames(16);
            if (g.result.award && !g.result.free) break;
        }
        // the announcement comes after the win on show has counted (main.js: countMs + 500)
        const r = g.result, mult = (r.win + r.jackpotWin) / r.bet;
        await frames((r.win ? Math.min(5000, 500 + mult * 90) + 500 : 250) + 900);
        shot('lucky_sevens-free', lastFrame);
        // the statistics
        await frames(8000);
        while (g.spinning || g.free.left) { await frames(500); if (!g.spinning) g.free.left = 0; }
        clicks.BTN_STATS();
        await frames(200);
        shot('lucky_sevens-stats', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Track Defender: a seeded game, the car under the nearest drone ---------- */
if (which === 'track_defender') {
    let seed = 11;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'track_defender_best.json'), JSON.stringify({ normal: 2140 }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        for (;;) {
            clicks.BTN_NEW();
            // into wave 3, then a moment just after a drone went down (its particles in the air)
            let scored = false;
            while (!g.over && (g.wave < 3 || g.enemies.length > 26 || !scored)) {
                now += 16;
                const e = g.enemies.filter((q) => q.state !== 'enter').sort((a, b) => b.y - a.y)[0];
                if (e) g.moveTo(e.x);
                const before = g.score;
                await ctx.draw();
                scored = g.score > before;
                if (now % 160000 < 16) process.stderr.write('wave ' + g.wave + ' score ' + g.score + ' lives ' + g.lives + '\n');
            }
            for (let k = 0; k < 6 && !g.over; k++) { now += 16; await ctx.draw(); }
            if (!g.over) break;
        }
        shot('track_defender-game', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Snake: a seeded game played by a simple autopilot ---------- */
if (which === 'snake') {
    let seed = 7;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'snake_best.json'), JSON.stringify({ 'normal/wrap': 31 }));
    // the game the app plays, to steer it
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    M.Game.stepMs = Game.stepMs;
    const wrapD = (a, b, n) => { const d = ((b - a) % n + n) % n; return d > n / 2 ? d - n : d; };
    const free = (d) => {
        const [dx, dy] = M.DIRS[d], h = g.snake[0];
        const x = (h.x + dx + g.cols) % g.cols, y = (h.y + dy + g.rows) % g.rows;
        return !g.snake.slice(0, -1).some((c) => c.x === x && c.y === y);
    };
    function steer() {
        if (g.queue.length) return;
        const h = g.snake[0], dx = wrapD(h.x, g.food.x, g.cols), dy = wrapD(h.y, g.food.y, g.rows);
        const want = [dx > 0 ? 'E' : dx < 0 ? 'W' : null, dy > 0 ? 'S' : dy < 0 ? 'N' : null, g.dir, 'N', 'E', 'S', 'W'].filter(Boolean);
        const d = want.find((x) => x !== { N: 'S', S: 'N', E: 'W', W: 'E' }[g.dir] && free(x));
        if (d && d !== g.dir) g.turn(d);
    }
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        // frames 16 ms apart until the snake is long, then one caught between two steps; a crash plays again
        for (;;) {
            clicks.BTN_NEW();
            while (g.score < 20 && !g.over) { now += 16; steer(); await ctx.draw(); }
            for (let k = 0; k < 4 && !g.over; k++) { now += 16; steer(); await ctx.draw(); }
            if (!g.over) break;
        }
        shot('snake-game', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

(async () => {
    require(path.join(APP, 'app.js'));
    global.__app.start(ctx);
    await flush();
    send('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', { temperatureEngineDrive: 86 + 48, temperatureEngineOilDrive: car.oil + 48 });
    send('de.bmw.infotainment.KombiInterface_2', 'cbsDataServiceList', [{ cBSIdentifier: 1, cBSColor: 'GREEN', cBSServcieName: 'Engine oil', cBSServiceWay: '18.400 km', cBSServiceDate: '04/2027' }]);
    // ~2 minutes on the road: the engine running at 74 km/h, the battery and the distance read
    let i = 0;
    await advance(130000, () => drive(74, 2150, 128, i++));
    const pages = which === 'engine_care' ? ['oil-health', 'trip', 'diagnostics'] : ['live-cost', 'trip-prices'];
    for (let p = 0; p < pages.length; p++) {
        if (p) clicks.BTN_PAGE();
        await advance(1000, () => drive(74, 2150, 128, i++));
        await ctx.draw();
        shot(which + '-' + pages[p], lastFrame);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
