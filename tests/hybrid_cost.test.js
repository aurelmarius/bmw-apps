'use strict';
/**
 * Hybrid Cost's model (apps/hybrid_cost/model.js): node tests/hybrid_cost.test.js
 * Each test drives a Tracker with a made-up second-by-second drive; no car, no head unit.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../apps/hybrid_cost/model');

const CFG = { petrolPrice: 7.5, elecPrice: 0.8, purePetrolAvg: 8.5, monthlyKm: 1200 };
const T0 = 1.7e12;

/** A drive: a Tracker and a car that sends values the way the real one does (only on change). */
function drive() {
    const st = M.freshState(T0);
    const logs = [];
    const tr = new M.Tracker(st, { log: { info: (s) => logs.push(s), warn: (s) => logs.push('WARN ' + s) } });
    const car = { now: T0, rpm: 0, rpmT: T0, speed: 0, speedT: T0, torque: 0, torqueT: T0, gLong: 0, gLongT: T0, live: true };
    const sample = () => ({
        now: car.now, live: car.live, rpm: car.rpm, rpmAge: car.now - car.rpmT, speed: car.speed, speedAge: car.now - car.speedT,
        torque: car.torque, torqueAge: car.now - car.torqueT, gLong: car.gLong, gLongAge: car.now - car.gLongT,
    });
    const api = {
        tr, st, logs, car,
        /** sec seconds; each second set(car, i) may change values (only what it sets counts as sent) */
        run(sec, set) {
            for (let i = 0; i < sec; i++) {
                car.now += 1000;
                if (set) set(car, i);
                tr.tick(sample());
            }
            return api;
        },
        /** the clock stops (unit asleep) for ms */
        sleep(ms) { car.now += ms; return api; },
    };
    tr.tick(sample());
    return api;
}
// one second of driving: a running engine and a moving car both send all the time
const ev = (kmh, nm) => (c, i) => { c.speed = kmh + (i % 2) * 0.02; c.speedT = c.now; if (nm !== undefined) { c.torque = nm; c.torqueT = c.now; } };
const ice = (kmh, rpm, nm) => (c, i) => { ev(kmh)(c, i); c.rpm = rpm + (i % 3); c.rpmT = c.now; c.torque = nm || 140; c.torqueT = c.now; };
const brake = (kmh, g) => (c, i) => { ev(kmh)(c, i); c.gLong = g + (i % 2) * 0.001; c.gLongT = c.now; };
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

const tests = {
    'EV distance and energy count on the 1 s clock while rpm stays 0 and is not re-sent'() {
        const d = drive().run(360, ev(60, 100));                    // 6 min at 60 km/h = 6 km
        const t = d.st.trip;
        near(t.evMeters, 6000, 30, 'EV m');
        near(t.evSec, 360, 1, 'EV s');
        near(t.kwhConsumed, 6 * M.EV_KWH100 / 100, 0.02, 'kWh');  // torque = reference: base consumption
        assert.strictEqual(t.iceMeters, 0);
        assert.strictEqual(t.fuelLitersConsumed, 0);
    },
    'the count does not depend on how often the car sends'() {
        // the speed is sent once and then stays the same (constant cruise): still counted for 10 s
        const d = drive();
        d.car.speed = 72; d.car.speedT = d.car.now;
        d.run(9);
        near(d.st.trip.evMeters, 9 * 20, 1, 'm from one sample');
    },
    'ICE distance and fuel, scaled by torque'() {
        const d = drive().run(360, ice(100, 2000, 140));            // 10 km at reference torque
        near(d.st.trip.iceMeters, 10000, 40, 'ICE m');
        near(d.st.trip.fuelLitersConsumed, 10 * M.ICE_L100 / 100, 0.01, 'L');
        const d2 = drive().run(360, ice(100, 2000, 280));
        near(d2.st.trip.fuelLitersConsumed, 2 * 10 * M.ICE_L100 / 100, 0.02, 'L at double torque');
    },
    'rpm older than 5 s means the engine is off'() {
        const d = drive().run(30, ice(50, 1500));
        assert.strictEqual(d.tr.engineOn, true);
        // rpm stops coming (engine stopped, signal quiet at its last value), the car rolls on
        d.run(30, ev(50));
        assert.strictEqual(d.tr.engineOn, false);
        near(d.st.trip.iceSec, 30 + 5, 2, 'ICE s stops 5 s after the last rpm');
        assert(d.st.trip.evSec > 20, 'then EV');
    },
    'a speed gone quiet after driving is not counted, after standing it is 0'() {
        const d = drive().run(30, ev(80)).run(60);                  // speed stops coming at 80 km/h
        near(d.st.trip.evSec, 30 + 10, 2, 'EV s stops after 10 s of silence');
        assert.strictEqual(d.tr.speed, null);
        const s = drive().run(5, ev(1)).run(60);
        assert.strictEqual(s.tr.speed, 0);
    },
    'regen only while braking, and the acceleration has to be fresh'() {
        const d = drive().run(60, brake(50, -0.2));
        const kwh = d.st.trip.regenKwhHarvested;
        near(kwh, Math.min(45, 0.2 * 1.8 * 50) * 60 / 3600, 0.005, 'kWh');
        d.run(60, ev(50));                                         // g stays at -0.2 but isn't re-sent
        near(d.st.trip.regenKwhHarvested, kwh + 18 * 4 / 3600, 0.002, 'stops when the last g is 5 s old');
    },
    'a pause of the clock (unit asleep) is not counted'() {
        const d = drive().run(10, ev(60));
        const m = d.st.trip.evMeters;
        d.sleep(120000).run(1, ev(60));
        near(d.st.trip.evMeters, m, 1, 'nothing for the gap');
    },
    'a new trip after 15 min without data, not before'() {
        const d = drive().run(60, ev(50));
        d.car.live = false;
        d.run(60 * 10);                                             // 10 min quiet
        d.car.live = true;
        d.run(10, ev(50));
        assert(d.st.trip.evMeters > 800, 'same trip after 10 min');
        d.car.live = false;
        d.sleep(16 * 60000);
        d.car.live = true;
        d.run(10, ev(50));
        assert(d.st.trip.evMeters < 200, 'new trip after 16 min: ' + d.st.trip.evMeters);
        assert(d.logs.some((l) => /new trip/.test(l)));
    },
    'pause (demo on) restarts the clock and the engine state'() {
        const d = drive().run(20, ice(50, 1500));
        d.tr.pause();
        assert.strictEqual(d.tr.engineOn, null);
        const m = d.st.trip.iceMeters;
        d.sleep(3000).run(1, ice(50, 1500));
        near(d.st.trip.iceMeters, m, 0.001, 'first tick after pause counts nothing');
    },
    'resetTrip zeroes the counters'() {
        const d = drive().run(60, ice(80, 2000));
        d.tr.resetTrip(d.car.now);
        assert.strictEqual(d.st.trip.distanceMeters, 0);
        assert.strictEqual(d.st.trip.fuelLitersConsumed, 0);
        assert.strictEqual(d.st.trip.start, d.car.now);
    },
    'tripCost uses the settings'() {
        const trip = Object.assign(M.freshState(T0).trip, { distanceMeters: 100000, evMeters: 50000, iceMeters: 50000, kwhConsumed: 10, fuelLitersConsumed: 3, regenKwhHarvested: 1 });
        const c = M.tripCost(trip, CFG);
        near(c.total, 3 * 7.5 + 10 * 0.8, 1e-9, 'total');
        near(c.petrolCar, 8.5 * 7.5, 1e-9, 'petrol car 100 km');
        near(c.saved, 8.5 * 7.5 - 30.5, 1e-9, 'saved');
        near(c.monthlyPetrol, 12 * 8.5 * 7.5, 1e-9, 'monthly petrol');
        near(c.monthly, 1200 * 30.5 / 100, 1e-9, 'monthly');
        const c2 = M.tripCost(trip, Object.assign({}, CFG, { purePetrolAvg: 10, monthlyKm: 500 }));
        near(c2.monthlyPetrol, 5 * 10 * 7.5, 1e-9, 'monthly petrol from the settings');
        assert.strictEqual(M.tripCost(M.freshState(T0).trip, CFG).monthly, null);
    },
    'liveCost: electric cheaper in town, petrol on the motorway'() {
        assert(M.liveCost(50, CFG).electricCheaper);
        assert(!M.liveCost(M.EV_MAX_KMH + 10, CFG).electricCheaper);
        assert(!M.liveCost(50, Object.assign({}, CFG, { elecPrice: 4 })).electricCheaper);
        assert(M.liveCost(null, CFG).elec100 > 0);
    },
    'state saved atomically, the backup used when the file is cut off'() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
        const f = path.join(dir, 'state.json');
        const st = M.freshState(T0);
        st.trip.evMeters = 42;
        M.saveState(f, st);
        st.trip.evMeters = 43;
        M.saveState(f, st);
        assert(fs.existsSync(f + '.bak'));
        assert(!fs.existsSync(f + '.tmp'));
        assert.strictEqual(M.loadState(f).trip.evMeters, 43);
        fs.writeFileSync(f, '{"trip":');                           // power lost mid-write
        const logs = [];
        assert.strictEqual(M.loadState(f, { warn: (s) => logs.push(s), info() {} }).trip.evMeters, 42);
        assert(logs.some((l) => /backup/.test(l)));
        fs.writeFileSync(f, JSON.stringify({ trip: { evMeters: 7 } }));   // fields added later get their 0
        const old = M.loadState(f);
        assert.strictEqual(old.trip.evMeters, 7);
        assert.strictEqual(old.trip.regenKwhHarvested, 0);
        fs.rmSync(dir, { recursive: true, force: true });
        assert.strictEqual(M.loadState(f).trip.distanceMeters, 0);  // nothing there: fresh
    },
    'prices are kept per currency, typical ones until set'() {
        const st = M.freshState(T0);
        assert.strictEqual(M.price(st, 'EUR', 'petrol'), 1.75);
        assert.strictEqual(M.price(st, 'RON', 'elec'), 0.8);
        M.setPrice(st, 'RON', 'petrol', 7.4949);
        M.setPrice(st, 'EUR', 'petrol', 1.689);
        assert.strictEqual(M.price(st, 'RON', 'petrol'), 7.49);
        assert.strictEqual(M.price(st, 'EUR', 'petrol'), 1.69);
        assert.strictEqual(M.price(st, 'RON', 'elec'), 0.8, 'the other price untouched');
        assert.strictEqual(M.setPrice(st, 'EUR', 'elec', 0), null, '0 is not a price');
        assert.strictEqual(M.setPrice(st, 'EUR', 'elec', 'abc'), null);
        assert.strictEqual(M.setPrice(st, 'EUR', 'elec', 99), 1.5, 'at most 5x typical');
        assert.strictEqual(M.setPrice(st, 'HUF', 'petrol', 612.7), 613, 'no decimals in forint');
        assert.strictEqual(M.price(st, 'XYZ', 'petrol'), 1.75, 'an unknown currency counts as EUR');
    },
    'prices survive a save and load'() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-cost-'));
        const f = path.join(dir, 'state.json');
        const st = M.freshState(T0);
        M.setPrice(st, 'EUR', 'elec', 0.27);
        M.saveState(f, st);
        assert.strictEqual(M.price(M.loadState(f), 'EUR', 'elec'), 0.27);
        fs.rmSync(dir, { recursive: true, force: true });
    },
    'old settings prices are taken over once, only where they fit the currency'() {
        const st = M.freshState(T0);
        assert.strictEqual(M.seedPrices(st, 'RON', { petrol: 7.2, elec: 0.95 }), 2);
        assert.strictEqual(M.price(st, 'RON', 'petrol'), 7.2);
        assert.strictEqual(M.seedPrices(st, 'RON', { petrol: 9, elec: 1 }), 0, 'set prices are not overwritten');
        const eu = M.freshState(T0);
        assert.strictEqual(M.seedPrices(eu, 'EUR', { petrol: 7.5, elec: 0.8 }), 1, 'RON-sized petrol price not taken for EUR');
        assert.strictEqual(M.price(eu, 'EUR', 'petrol'), 1.75);
        assert.strictEqual(M.price(eu, 'EUR', 'elec'), 0.8);
        assert.strictEqual(M.seedPrices(M.freshState(T0), 'EUR', {}), 0);
    },
    'button cycling: round prices around the typical one, wrapping'() {
        for (const cur of Object.keys(M.CURRENCIES)) {
            for (const kind of ['petrol', 'elec']) {
                const list = M.priceList(cur, kind), typ = M.CURRENCIES[cur][kind];
                assert(list.length >= 8, cur + ' ' + kind + ' list too short');
                assert(list[0] <= typ * 0.7 && list[list.length - 1] >= typ * 1.3, cur + ' ' + kind + ' range');
                assert(list.every((v, i) => i === 0 || v > list[i - 1]), cur + ' ' + kind + ' ascending');
            }
        }
        const st = M.freshState(T0);
        assert.strictEqual(M.nextPrice(st, 'RON', 'petrol'), 7.75);
        M.setPrice(st, 'RON', 'petrol', 10.5);
        assert.strictEqual(M.nextPrice(st, 'RON', 'petrol'), M.priceList('RON', 'petrol')[0], 'wraps round');
    },
    'price editor: controller, steps and keypad'() {
        const e = new M.PriceEdit('RON', 'petrol', 7.5);
        e.turn(1); assert.strictEqual(e.text(), '7.51');
        e.turn(-2); assert.strictEqual(e.text(), '7.49');
        e.turn(3); assert.strictEqual(e.text(), '7.79', 'a fast turn moves ten at a time');
        e.step(-1, 1); assert.strictEqual(e.text(), '6.79');
        assert.deepStrictEqual(e.steps(), [1, 0.1, 0.01]);
        for (const k of ['8', '.', '1', '9', '9']) e.key(k);          // a third decimal is refused
        assert.strictEqual(e.text(), '8.19'); assert.strictEqual(e.value(), 8.19);
        e.key('del'); assert.strictEqual(e.text(), '8.1');
        e.turn(1); assert.strictEqual(e.text(), '8.11', 'turning goes on from the typed value');
        e.key('del'); e.key('del'); e.key('del'); e.key('del');
        assert.strictEqual(e.value(), null, 'nothing typed: not a price');
        const z = new M.PriceEdit('EUR', 'elec', 0.3);
        z.key('0'); z.key('0'); assert.strictEqual(z.text(), '0', 'no leading zeros');
        z.key('.'); z.key('2'); z.key('5'); assert.strictEqual(z.value(), 0.25);
        z.step(-100, 0.01); assert.strictEqual(z.value(), 0.01, 'never below the smallest price');
        const h = new M.PriceEdit('HUF', 'petrol', 600);
        assert.deepStrictEqual(h.steps(), [100, 10, 1]);
        h.key('.'); h.key('6'); h.key('2'); h.key('5'); assert.strictEqual(h.value(), 625, 'no decimal point in forint');
    },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
    try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
