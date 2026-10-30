'use strict';
/**
 * Engine Care's model (apps/engine_care/model.js): node tests/engine_care.test.js
 * Each test drives a Tracker with a made-up second-by-second drive; no car, no head unit.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../apps/engine_care/model');

const CFG = { coldThreshold: 65, hardTorque: 150, warmTarget: 90, shortCycleH: 1, socReserve: 15, maxKm: 10000, maxMonths: 12, maxHours: 180 };
const T0 = 1.7e12;

/** A drive: a Tracker and a car that sends values the way the real one does (only on change). */
function drive(opts) {
    const st = M.freshState(T0);
    const logs = [], alerts = [];
    const tr = new M.Tracker(st, { cfg: () => Object.assign({}, CFG, opts && opts.cfg), log: { info: (s) => logs.push(s), warn: (s) => logs.push('WARN ' + s) }, onAlert: (s) => alerts.push(s) });
    const car = { now: T0, rpm: 0, rpmT: T0, speed: 0, speedT: T0, oil: null, coolant: 20, torque: 0, torqueT: T0, soc: null, visible: true, live: true };
    const sample = () => ({
        now: car.now, live: car.live, rpm: car.rpm, rpmAge: car.now - car.rpmT, speed: car.speed, speedAge: car.now - car.speedT,
        oil: car.oil, coolant: car.coolant, torque: car.torque, torqueAge: car.now - car.torqueT, soc: car.soc, visible: car.visible,
    });
    const api = {
        tr, st, logs, alerts, car,
        /** sec seconds; each second set(car, i) may change values (only what it sets counts as sent) */
        run(sec, set) {
            for (let i = 0; i < sec; i++) {
                car.now += 1000;
                if (set) set(car, i);
                tr.tick(sample());
            }
            return api;
        },
        engine(rpm) { car.rpm = rpm; car.rpmT = car.now; },
        speed(v) { car.speed = v; car.speedT = car.now; },
        torque(nm) { car.torque = nm; car.torqueT = car.now; },
    };
    tr.tick(sample());
    return api;
}
// one second of driving: a running engine and a moving car both send all the time
const ev = (kmh) => (c, i) => { c.speed = kmh + (i % 2) * 0.02; c.speedT = c.now; };
const ice = (kmh, rpm, nm) => (c, i) => { ev(kmh)(c, i); c.rpm = rpm + (i % 3); c.rpmT = c.now; c.torque = nm || 60; c.torqueT = c.now; };
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

const tests = {
    'EV time counts while rpm stays 0 and is not re-sent'() {
        const d = drive().run(120, ev(50));
        near(d.st.service.evSec, 120, 1, 'EV s');
        near(d.st.service.evMeters, 50 / 3.6 * 120, 30, 'EV m');
        assert.strictEqual(d.st.service.iceSec, 0);
    },
    'a speed gone quiet after driving is not counted, after standing it is 0'() {
        const d = drive().run(30, ev(80)).run(60);              // speed stops coming at 80 km/h
        near(d.st.service.evSec, 30 + 10, 2, 'EV s stops after 10 s of silence');
    },
    'ICE time and distance, start from a known off only'() {
        const d = drive();
        d.car.oil = 30;
        d.run(60, ice(80, 2000));
        near(d.st.service.iceSec, 60, 1, 'ICE s');
        assert.strictEqual(d.st.service.iceStarts, 1);
        assert.strictEqual(d.st.service.coldStarts, 1);
        // an engine already running when the app starts is not a start
        const tr2 = new M.Tracker(M.freshState(T0), { cfg: () => CFG });
        tr2.tick({ now: T0, live: true, rpm: 2000, rpmAge: 0, speed: 50, speedAge: 0, oil: 30, coolant: 30, torque: 50, torqueAge: 0 });
        tr2.tick({ now: T0 + 1000, live: true, rpm: 2001, rpmAge: 0, speed: 50, speedAge: 0, oil: 30, coolant: 30, torque: 50, torqueAge: 0 });
        assert.strictEqual(tr2.state.service.iceStarts, 0);
        assert.strictEqual(tr2.state.service.coldStarts, 0);
    },
    'stale rpm means the engine is off (the car went to sleep with rpm > 0)'() {
        const d = drive();
        d.run(10, ice(50, 1500));
        d.run(20);                                            // nothing more is sent
        near(d.st.service.iceSec, 15, 1, 'ICE stops 5 s after the last rpm');
    },
    'cold hard start: high torque before the oil is warm, once per start'() {
        const d = drive();
        d.car.oil = 40;
        d.run(20, ice(60, 2500, 250));
        assert.strictEqual(d.st.service.coldHardStarts, 1);
        assert(d.alerts[0].includes('65°C'), 'alert names the threshold');
    },
    'no temperature at all: a start is not counted as cold'() {
        const d = drive();
        d.car.coolant = null;
        d.run(20, ice(60, 2000, 250));
        assert.strictEqual(d.st.service.iceStarts, 1);
        assert.strictEqual(d.st.service.coldStarts, 0);
        assert.strictEqual(d.st.service.coldHardStarts, 0);
    },
    'coolant stands in for a missing oil temperature'() {
        const d = drive();
        d.car.coolant = 30;
        d.run(10, ice(60, 2000));
        assert.strictEqual(d.st.service.coldStarts, 1);
    },
    'short cycle: a cold start stopped before the oil is warm'() {
        const d = drive();
        d.car.oil = 30;
        d.run(120, (c, i) => { ice(70, 2000)(c, i); c.oil = 30 + i * 0.3; });   // peaks at ~66 °C
        d.run(20, ev(50));                                                      // engine off
        assert.strictEqual(d.st.service.shortCycles, 1);
        assert.strictEqual(d.st.trip.shortCycles, 1);
        near(d.st.service.shortCycleSec, 125, 3, 'short cycle length');
        // a run that warms the oil fully is not one
        d.run(400, (c, i) => { ice(90, 2200)(c, i); c.oil = Math.min(95, 40 + i * 0.3); });
        d.run(20, ev(50));
        assert.strictEqual(d.st.service.shortCycles, 1);
        assert.strictEqual(d.st.service.coldStarts, 2);
    },
    'battery charge splits engine starts'() {
        const d = drive();
        d.car.oil = 30;
        d.car.soc = 60;
        d.run(10, ice(60, 2000)).run(10, ev(60));               // start 1: charge left, cold
        d.car.soc = 12;
        d.run(10, ice(60, 2000)).run(10, ev(60));               // start 2: at the reserve, cold
        d.car.soc = null;
        d.run(10, ice(60, 2000));                               // start 3: charge not known
        assert.strictEqual(d.st.service.iceStarts, 3);
        assert.strictEqual(d.st.service.startsWithCharge, 1);
        assert.strictEqual(d.st.service.startsLowSoc, 1);
        assert.strictEqual(d.st.service.coldStartsWithCharge, 1);
    },
    'torque check: torque seen with the engine off is remembered'() {
        const d = drive();
        d.run(30, (c, i) => { ev(60)(c, i); c.torque = 80; c.torqueT = c.now; });
        assert.strictEqual(d.st.diag.torqueEvMax, 80);
        near(d.st.diag.torqueEvSec, 30, 1, 'seconds checked');
    },
    'counting with the screen closed is noted'() {
        const d = drive();
        d.car.visible = false;
        d.run(30, ev(40));
        near(d.st.diag.hiddenSec, 30, 1, 'hidden s');
        d.car.visible = true;
        d.run(30, ev(40));
        near(d.st.diag.countedSec, 60, 1, 'counted s');
    },
    'a gap of 15 min without the car starts a new trip, service totals stay'() {
        const d = drive().run(60, ev(50));
        const evSec = d.st.service.evSec;
        d.car.live = false;
        d.run(20 * 60);
        d.car.live = true;
        d.run(5, ev(10));
        assert(d.st.trip.evSec < 10, 'trip restarted');
        assert(d.st.service.evSec >= evSec, 'service kept');
        assert(d.logs.some((l) => /new trip/.test(l)));
    },
    'distance counter: increases only, re-anchors on a restart or another source'() {
        const d = drive();
        d.tr.onOdo('OBD A6', 48000.0);
        d.tr.onOdo('OBD A6', 48010.5);
        near(d.tr.drivenKm().km, 10.5, 0.01, 'A6');
        d.tr.onOdo('OBD 31', 120);                              // another source: re-anchor
        d.tr.onOdo('OBD 31', 125);
        d.tr.onOdo('OBD 31', 0);                                // fault memory cleared
        d.tr.onOdo('OBD 31', 3);
        near(d.tr.drivenKm().km, 18.5, 0.01, 'after re-anchoring');
        d.tr.onOdo('OBD 31', 5000);                             // implausible jump
        near(d.tr.drivenKm().km, 18.5, 0.01, 'jump ignored');
        assert.strictEqual(d.tr.drivenKm().src, 'odometer');
    },
    'distance before the first counter reading is the speed estimate'() {
        const d = drive().run(360, ev(100));                    // 10 km by speed
        assert.strictEqual(d.tr.drivenKm().src, 'speed');
        d.tr.onOdo('OBD A6', 1000);
        d.tr.onOdo('OBD A6', 1005);
        near(d.tr.drivenKm().km, 15, 0.2, 'estimate + counter');
    },
    'reset: archived, counters at 0, the last reading kept'() {
        const d = drive();
        d.car.oil = 30;
        d.run(60, ice(80, 2000));
        d.tr.onOdo('OBD A6', 100); d.tr.onOdo('OBD A6', 112);
        const h = d.tr.resetService(d.car.now);
        assert.strictEqual(h.km, 13);                         // 1.3 km estimated before the first reading + 12
        assert.strictEqual(h.coldStarts, 1);
        assert.strictEqual(d.st.service.iceSec, 0);
        assert.strictEqual(d.st.service.odoLast.km, 112);
        d.tr.onOdo('OBD A6', 120);
        near(d.tr.drivenKm().km, 8, 0.01, 'counts on from the last reading');
    },
    'oil health: whichever comes first, plus wear in engine hours'() {
        const st = M.freshState(T0);
        assert.strictEqual(M.oilHealth(st, CFG, T0).lifePct, 100);
        st.service.odoLast = { src: 'OBD A6', km: 1 }; st.service.odoKm = 5000;
        let h = M.oilHealth(st, CFG, T0);
        assert.strictEqual(h.lifePct, 50); assert.strictEqual(h.limitingFactor, 'km'); assert.strictEqual(h.remKm, 5000);
        st.service.iceSec = 126 * 3600;                          // 70 % of 180 h
        h = M.oilHealth(st, CFG, T0);
        assert.strictEqual(h.lifePct, 30); assert.strictEqual(h.limitingFactor, 'hours');
        st.service.shortCycles = 18;                             // 18 h of wear = 10 %
        h = M.oilHealth(st, CFG, T0);
        assert.strictEqual(h.lifePct, 20); assert.strictEqual(h.level, 'warn');
        assert.strictEqual(M.oilHealth(st, Object.assign({}, CFG, { shortCycleH: 0 }), T0).lifePct, 30, 'wear setting 0');
        h = M.oilHealth(st, CFG, T0 + 400 * 86400000);
        assert.strictEqual(h.lifePct, 0); assert.strictEqual(h.status, 'SERVICE DUE');
    },
    'CBS distance texts'() {
        const cases = [['12.300 km', 12300], ['12 300 km', 12300], ['-1.200 km', -1200], ['−1 200 km', -1200],
            ['7,600 mi', 12231], ['10 000 km', 10000], ['', null], [undefined, null], ['--- km', null]];
        for (const [s, km] of cases) assert.strictEqual(M.parseDistance(s), km, JSON.stringify(s));
    },
    'state: atomic save, backup when the file is cut off, old fields upgraded'() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-care-'));
        const f = path.join(dir, 'state.json');
        const st = M.freshState(T0);
        st.service.iceSec = 42;
        M.saveState(f, st);
        st.service.iceSec = 43;
        M.saveState(f, st);
        assert.strictEqual(M.loadState(f).service.iceSec, 43);
        fs.writeFileSync(f, '{"service":');                     // power lost mid-write
        const logs = [];
        assert.strictEqual(M.loadState(f, { warn: (s) => logs.push(s), info() {} }).service.iceSec, 42);
        assert(logs.some((l) => /backup/.test(l)));
        fs.writeFileSync(f, JSON.stringify({ service: { iceSec: 7, resetCbsKm: 30000 }, trip: { evSec: 3 } }));   // 1.3 state
        const old = M.loadState(f);
        assert.strictEqual(old.service.iceSec, 7);
        assert(!('resetCbsKm' in old.service));
        assert.strictEqual(old.service.shortCycles, 0);
        assert.strictEqual(old.diag.countedSec, 0);
        fs.rmSync(dir, { recursive: true, force: true });
    },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
    try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
