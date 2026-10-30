'use strict';
/**
 * Engine Care's main.js on a made-up head unit: node tests/engine_care_app.test.js
 * Fake clock, fake SOME/IP signals and a fake engine / battery unit answering UDS over TASU.
 * Each scenario runs in its own process (the fakes replace Date.now and the timers).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCENARIOS = ['a6', 'pid31', 'none', 'dmeoil', 'soc', 'demo', 'log'];

if (!process.argv[2]) {
    let failed = 0;
    for (const sc of SCENARIOS) {
        try {
            const out = execFileSync(process.execPath, [__filename, sc], { encoding: 'utf8', timeout: 120000 });
            console.log('ok   ' + sc + (out.trim() ? '  (' + out.trim().split('\n').pop() + ')' : ''));
        } catch (e) {
            failed++;
            console.log('FAIL ' + sc + '\n     ' + String(e.stdout || e.message).trim().split('\n').join('\n     '));
        }
    }
    console.log(failed ? failed + ' failed' : 'all ' + SCENARIOS.length + ' passed');
    process.exit(failed ? 1 : 0);
}

/* ---------- one scenario ---------- */
const mode = process.argv[2];
process.on('unhandledRejection', () => {});        // the test canvas has no fonts: drawing errors don't matter here

// the app as the build lays it out: main.js + model.js + app.json + kit/
const APP = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-care-app-'));
const DATA = path.join(APP, 'data');
fs.mkdirSync(DATA);
for (const f of ['main.js', 'model.js', 'app.json']) fs.copyFileSync(path.join(ROOT, 'apps', 'engine_care', f), path.join(APP, f));
fs.cpSync(path.join(ROOT, 'kit', 'runtime'), path.join(APP, 'kit'), { recursive: true });
fs.writeFileSync(path.join(APP, 'kit', 'mgu.js'), 'module.exports = { run: (app) => { global.__app = app; } };');
process.on('exit', () => fs.rmSync(APP, { recursive: true, force: true }));

// fake clock (setImmediate stays real: it drives the promise chains)
let now = 1.7e12;
Date.now = () => now;
const timers = [];
global.setInterval = (fn, ms) => { const t = { fn, ms, next: now + ms }; timers.push(t); return t; };
global.setTimeout = (fn, ms) => { const t = { fn, ms, next: now + (ms || 0), once: true }; timers.push(t); return t; };
global.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms, every) {
    const end = now + ms;
    while (now < end) {
        now = Math.min(end, now + 50);
        for (const t of timers.slice()) if (t.next <= now) { if (t.once) timers.splice(timers.indexOf(t), 1); else t.next += t.ms; t.fn(); }
        if (now % 1000 === 0) { if (every) every(); await flush(); }
    }
}

const opts = {
    a6: { tasu: true, odoStart: 48211.3 },
    pid31: { tasu: true, a6: false, odoStart: 1234.6 },
    none: { tasu: false },
    dmeoil: { tasu: true, dmeOil: 85 },
    soc: { tasu: true, soc: 64 },
    demo: { tasu: false, demo: 'on' },
    log: { tasu: true, odoStart: 500, soc: 40, logDrive: true },
}[mode];

// the car: integrates its own distance from the speed it sends
const car = { km: opts.odoStart || 0, oil: opts.dmeOil, a6: opts.a6 !== false, pid31Offset: 0, soc: opts.soc };
const H = {};
let respond = null;
const frame = (ecu, uds) => ({ udsResponse: [0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds), errorCode: 'NO_ERROR' });
const refuse = (ecu, sid) => respond(frame(ecu, [0x7F, sid, 0x31]));
const signals = {
    watch: (iface, inst, handlers) => { H[iface] = Object.assign(H[iface] || {}, handlers); return Promise.resolve({ available: true, error: null }); },
    proxy: () => (opts.tasu ? Promise.resolve({}) : Promise.reject(new Error('no TASU in this test'))),
    on: (p, name, fn) => { respond = fn; return Promise.resolve(); },
    onAvailable: (p, fn) => { fn(true); return Promise.resolve(); },
    call: (p, method, q) => {
        const d = Array.from(q.udsData), ecu = q.targetAddress, sid = q.serviceID;
        setImmediate(() => {
            if (ecu === 7 && sid === 0x22 && d[0] === 0xDD && d[1] === 0xBC && typeof car.soc === 'number') {
                const raw = Math.round(car.soc * 10);
                return respond(frame(ecu, [0x62, 0xDD, 0xBC, raw >> 8, raw & 255]));
            }
            if (ecu !== 0x12 || sid !== 0x01) return refuse(ecu, sid);
            const pid = d[0];
            if (pid === 0xA6 && car.a6) { const raw = Math.round(car.km * 10); return respond(frame(ecu, [0x41, 0xA6, (raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255])); }
            if (pid === 0x31) { const raw = Math.floor(car.km - car.pid31Offset); return respond(frame(ecu, [0x41, 0x31, (raw >> 8) & 255, raw & 255])); }
            if (pid === 0x5C && typeof car.oil === 'number') return respond(frame(ecu, [0x41, 0x5C, car.oil + 40]));
            refuse(ecu, sid);
        });
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    },
};
const send = (iface, field, v) => H[iface][field](v);
const rpm = (r) => send('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: r * 4 });
const speed = (k) => send('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: Math.round(k / 0.015625) });
const temps = (cool, oil) => send('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', { temperatureEngineDrive: cool + 48, temperatureEngineOilDrive: oil === null ? 255 : oil + 48 });
const torque = (nm) => send('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', { actualValueTorqueCrankshaft: Math.round((nm + 1023.5) / 0.5) });
const cbs = (way, date) => send('de.bmw.infotainment.KombiInterface_2', 'cbsDataServiceList', [{ cBSIdentifier: 1, cBSColor: 'GREEN', cBSServcieName: 'Engine oil', cBSServiceWay: way, cBSServiceDate: date }]);
async function drive(sec, kmh, rpmNow) {
    let i = 0;
    await advance(sec * 1000, () => {
        car.km += kmh / 3600;
        speed(kmh + ((i++ % 2) ? 0.02 : 0));
        if (rpmNow) { rpm(rpmNow + (i % 3)); torque(60); }
    });
}

const clicks = {}, logs = [];
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const values = {};
spec.settings.forEach((s) => { values[s.key] = s.default; });
values.demo = opts.demo || 'auto';
if (opts.logDrive) values.logDrive = true;
const ctx = {
    ui: { onClick: (n, fn) => { clicks[n] = () => { try { fn(); } catch (e) { /* drawing without fonts */ } }; }, image: () => Promise.resolve(), onVisible() {} },
    settings: { get: (k) => values[k], onChange() {} },
    dataDir: DATA, signals, spec,
    log: { info: (s) => logs.push(s), warn: (s) => logs.push('WARN ' + s) },
    theme: () => ({ bg: '#000', dim: '#888', text: '#fff', accent: '#0af', warn: '#fa0', crit: '#f00', track: '#333' }),
    canvas: (w, h) => { const c = new (require(path.join(APP, 'kit', 'canvas')).Canvas)(w, h); c.text = () => c; c.textWidth = () => 10; return c; },
    loop() {}, hasClients: () => true,
};
require(path.join(APP, 'main.js'));
global.__app.start(ctx);
const stateFile = path.join(DATA, 'engine_care_state.json');
const read = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null);
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const driven = (s) => (s.service.odoLast ? s.service.odoBaseKm + s.service.odoKm : (s.service.iceMeters + s.service.evMeters) / 1000);

(async () => {
    await flush();
    rpm(0); speed(0); temps(30, null); torque(0);
    await advance(5000);

    if (mode === 'demo') {
        await advance(60000);
        const s = read();
        assert(!s || (s.service.iceSec === 0 && s.service.evSec === 0 && s.service.coldStarts === 0), 'demo data must never be saved');
        console.log('nothing saved');
        process.exit(0);
    }
    if (mode === 'dmeoil') {
        // CDS has no oil temperature: after 30 s the engine unit's (85 °C) is used, so this start isn't cold
        await advance(40000, () => speed(0));
        await drive(30, 60, 1800);
        assert(logs.some((l) => /no oil temperature from CDS/.test(l)), 'asked the engine unit');
        assert.strictEqual(read().service.coldStarts, 0, 'DME oil 85 °C: not a cold start (coolant alone says 30 °C)');
        console.log('oil from the engine unit used');
        process.exit(0);
    }
    if (mode === 'log') {
        // the app records the drive; replaying the recording through the model counts the same
        await drive(300, 50);
        await drive(200, 80, 2000);
        rpm(0);
        await drive(100, 30);
        await advance(31000);                               // the log is written every 30 s
        const s = read(), logFile = path.join(DATA, 'engine_care_drive.jsonl');
        const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert(rows.length > 500, 'one line a second');
        assert(rows.some((r) => r.odo), 'distance readings recorded');
        const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'replay_engine_care.js'), logFile], { encoding: 'utf8' });
        const m = /engine (\d+)h (\d+)m .* electric (\d+)h (\d+)m .* distance ([\d.]+) km/.exec(out);
        assert(m, out);
        near(+m[1] * 60 + +m[2], Math.round(s.service.iceSec / 60), 1, 'replayed engine min');
        near(+m[3] * 60 + +m[4], Math.round(s.service.evSec / 60), 1, 'replayed EV min');
        near(+m[5], driven(s), 0.3, 'replayed km');
        assert(/not warmed 1/.test(out) && /charge left 1/.test(out), out);
        console.log('replay matches: ' + out.split('\n')[1]);
        process.exit(0);
    }
    if (mode === 'soc') {
        await drive(60, 40);                                // the charge gets read
        await drive(30, 60, 1800);                          // cold start with 64 % left
        const s = read();
        assert.strictEqual(s.service.startsWithCharge, 1);
        assert.strictEqual(s.service.coldStartsWithCharge, 1);
        console.log('start with 64 % charge split out');
        process.exit(0);
    }

    // CBS texts
    for (const [way, km] of [['12.300 km', 12300], ['-1.200 km', -1200], ['7,600 mi', 12231]]) {
        cbs(way, '09/2027');
        assert(logs.filter((x) => /CBS oil from the cluster/.test(x)).pop().includes('-> ' + km + ' km'), 'CBS ' + way);
    }

    // 10 min EV at 50, 5 min engine at 80 -> 15 km; the engine run started cold and never warmed
    await drive(600, 50);
    await drive(300, 80, 2000);
    rpm(0);
    await drive(70, 0);
    let s = read();
    if (mode === 'none') assert.strictEqual(s.service.odoLast, null, 'no distance source');
    else assert.strictEqual(s.service.odoLast.src, mode === 'a6' ? 'OBD A6' : 'OBD 31');
    near(driven(s), 15, mode === 'pid31' ? 1.5 : 0.3, 'km');
    near(s.service.evSec, 600, 3, 'EV s');
    near(s.service.iceSec, 300, 3, 'ICE s');
    assert.strictEqual(s.service.coldStarts, 1);
    assert.strictEqual(s.service.shortCycles, 1, 'coolant stayed at 30 °C: never warmed');
    const before = driven(s), src = s.service.odoLast ? s.service.odoLast.src : 'speed';

    if (mode === 'pid31') {
        car.pid31Offset = car.km;                           // fault memory cleared: PID 31 back to 0
        await drive(70, 0);
        await drive(360, 100);
        await drive(70, 0);
        assert(logs.some((l) => /re-anchored/.test(l)), 're-anchored');
        near(driven(read()), 25, 2.5, 'km after a counter clear');
    }

    // reset needs two presses; distance then counts from 0
    clicks.BTN_RESET(); await advance(16000);
    assert(read().service.iceSec > 0, 'one press must not reset');
    await advance(6000);
    clicks.BTN_RESET(); await advance(1000); clicks.BTN_RESET(); await advance(2000);
    s = read();
    assert.strictEqual(s.service.iceSec, 0, 'two presses reset');
    assert.strictEqual(s.history.length, 1);
    await drive(360, 100);
    await drive(70, 0);
    near(driven(read()), 10, mode === 'pid31' ? 1.5 : 0.3, 'km after the reset');
    assert(fs.existsSync(stateFile + '.bak'), 'backup kept');
    console.log(`${before.toFixed(1)} km first drive, source ${src}`);
    process.exit(0);
})().catch((e) => { console.log(e.message); console.log(logs.filter((l) => /WARN|distance|DME/.test(l)).slice(-6).join('\n')); process.exit(1); });
