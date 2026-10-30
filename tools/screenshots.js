#!/usr/bin/env node
'use strict';
/**
 * screenshots.js - the README's screenshots (docs/screenshots/*.png), drawn by the built apps with sample
 * data: a sample state (some months after an oil change) and a car that sends steady values over a fake
 * SOME/IP and answers the diagnostic requests. No head unit needed.
 *
 *   python3 kit/tools/build.py engine_care hybrid_cost && node tools/screenshots.js
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
    for (const app of ['engine_care', 'hybrid_cost', 'price_editor']) {
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
let last = null;
// the app draws on the kit's recorder (as on the car); the recording is played into a canvas for the PNG
const { Recorder, play } = require(path.join(APP, 'kit', 'record'));
const { Canvas: AppCanvas } = require(path.join(APP, 'kit', 'canvas'));
const toCanvas = (r) => { const cv = new AppCanvas(r.w, r.h); play(r.words(), cv); return cv; };
const ctx = {
    ui: { onClick: (n, fn) => { clicks[n] = fn; }, image: (n, r) => { last = toCanvas(r); return Promise.resolve(); }, onVisible() {} },
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
} else {
    fs.writeFileSync(path.join(DATA, 'hybrid_cost_state.json'), JSON.stringify({
        trip: { start: now - 41 * 60000, distanceMeters: 46.3e3, evMeters: 31.8e3, iceMeters: 14.5e3, evSec: 1690, iceSec: 790,
            kwhConsumed: 6.21, fuelLitersConsumed: 0.94, regenKwhHarvested: 0.87 },
        lastLive: now - 60000,
        prices: { EUR: { petrol: 1.69, elec: 0.28 } },
    }));
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
        shot(which + '-' + pages[p], last);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
