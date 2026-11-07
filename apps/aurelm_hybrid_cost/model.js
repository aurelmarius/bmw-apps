'use strict';
/**
 * model.js - Hybrid Cost's bookkeeping, without signals or drawing, so the same code runs on the
 * car and in the tests (tests/hybrid_cost.test.js).
 *
 *   const st = loadState(file, log)            saved state, else its backup, else a fresh one
 *   saveState(file, st)                         atomic: temporary file, flush, rename (throws on error)
 *   const tr = new Tracker(st, { log })
 *   tr.tick(sample)                             once a second, sample = the car's last values (see tick)
 *   tr.pause()                                  demo data on: the next tick starts the clock again
 *   tr.resetTrip(now)                           counters to 0
 *   tripCost(trip, c)                           money spent, petrol-car equivalent, saved, averages
 *   liveCost(speed, c)                          estimated cost / 100 km at this speed, electric vs petrol
 *
 * Prices are kept per currency in the state (st.prices), so switching currency never mixes them:
 *   price(st, cur, kind)                        kind 'petrol' (per litre) or 'elec' (per kWh); the currency's
 *                                               typical price until one is set
 *   setPrice(st, cur, kind, v)                  rounded to the currency's decimals, kept within its range
 *   nextPrice(st, cur, kind)                    the next of a list around the typical price (button cycling)
 *   seedPrices(st, cur, { petrol, elec })       prices set in the settings up to 1.1, taken over once if plausible
 *   new PriceEdit(cur, kind, value)             the price editor's arithmetic: turn / step / type a number
 *
 * c = { petrolPrice, elecPrice, purePetrolAvg, monthlyKm } (prices of the current currency).
 */
const fs = require('fs');
const path = require('path');

const RPM_ON = 600, RPM_OFF = 300;   // engine start / stop, with hysteresis
const RPM_FRESH_MS = 5000;           // a running engine sends rpm all the time: older = not running
const SPEED_FRESH_MS = 10000;
const ACCEL_FRESH_MS = 5000;         // braking changes the acceleration all the time: older = not braking
const MAX_GAP_S = 5;                 // a longer pause between ticks (unit asleep or stalled) isn't counted
const TRIP_GAP_MS = 15 * 60000;      // no data from the car this long: the next drive is a new trip
const EV_MIN_KMH = 3;                // slower with the engine off: standing, nothing counted
// consumption estimates (the car sends no fuel flow or battery current on these signals)
const ICE_L100 = 6.5;                // petrol at cruise, scaled by torque / ICE_REF_NM (at least ICE_MIN_LOAD)
const ICE_REF_NM = 140, ICE_MIN_LOAD = 0.6;
const EV_KWH100 = 17.5;              // electric, scaled by torque / EV_REF_NM (at least EV_MIN_LOAD)
const EV_REF_NM = 100, EV_MIN_LOAD = 0.5;
const REGEN_G = -0.05;               // deceleration from which the e-motor recovers energy
const REGEN_MIN_KMH = 5, REGEN_MAX_KW = 45;
const EV_MAX_KMH = 118;              // faster: running on petrol saves the battery for the city

const isNum = (v) => typeof v === 'number' && isFinite(v);

const freshTrip = (now) => ({
    start: now,
    distanceMeters: 0, evMeters: 0, iceMeters: 0,
    evSec: 0, iceSec: 0,
    kwhConsumed: 0, fuelLitersConsumed: 0, regenKwhHarvested: 0,
});
const freshState = (now) => ({ trip: freshTrip(now), lastLive: 0, prices: {} });

/**
 * Currencies: typical prices (petrol per litre, electricity per kWh; 2025/26 levels), decimals shown
 * and typed. The highest price allowed is 5x the typical one.
 */
const CURRENCIES = {
    RON: { name: 'Romanian leu', petrol: 7.5, elec: 0.8, dp: 2 },
    EUR: { name: 'Euro', petrol: 1.75, elec: 0.3, dp: 2 },
    USD: { name: 'US dollar', petrol: 1.0, elec: 0.17, dp: 2 },
    GBP: { name: 'Pound sterling', petrol: 1.4, elec: 0.25, dp: 2 },
    CHF: { name: 'Swiss franc', petrol: 1.85, elec: 0.3, dp: 2 },
    PLN: { name: 'Polish zloty', petrol: 6.3, elec: 1.1, dp: 2 },
    HUF: { name: 'Hungarian forint', petrol: 600, elec: 90, dp: 0 },
    CZK: { name: 'Czech koruna', petrol: 38, elec: 7, dp: 2 },
    SEK: { name: 'Swedish krona', petrol: 18.5, elec: 2.5, dp: 2 },
    NOK: { name: 'Norwegian krone', petrol: 21, elec: 2, dp: 2 },
    DKK: { name: 'Danish krone', petrol: 13.5, elec: 2.5, dp: 2 },
};
const KINDS = { petrol: 'L', elec: 'kWh' };
const currency = (cur) => CURRENCIES[cur] || CURRENCIES.EUR;
/** the smallest step of a price: one unit of its last decimal (0.01, or 1 for HUF) */
const fineStep = (cur) => Math.pow(10, -currency(cur).dp);
const maxPrice = (cur, kind) => currency(cur)[kind] * 5;
const roundTo = (v, dp) => Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp);
/** v rounded to the currency's decimals and kept within (0, 5x typical]; null for anything not a positive number */
function cleanPrice(cur, kind, v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return null;
    return Math.min(maxPrice(cur, kind), Math.max(fineStep(cur), roundTo(v, currency(cur).dp)));
}
function price(st, cur, kind) {
    const p = st.prices && st.prices[cur] && st.prices[cur][kind];
    return isNum(p) && p > 0 ? p : currency(cur)[kind];
}
function setPrice(st, cur, kind, v) {
    const p = cleanPrice(cur, kind, v);
    if (p === null) return null;
    st.prices = st.prices || {};
    st.prices[cur] = Object.assign({}, st.prices[cur], { [kind]: p });
    return p;
}
/** a round step near x: 1, 2, 2.5 or 5 times a power of ten, that the currency's decimals can show */
function niceStep(x, dp) {
    const p = Math.pow(10, Math.floor(Math.log10(x))), unit = Math.pow(10, dp);
    return [1, 2, 2.5, 5, 10].map((m) => m * p).filter((v) => Math.abs(v * unit - Math.round(v * unit)) < 1e-6)
        .reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best), 10 * p);
}
/** prices from about 60 % to 140 % of the typical one, in round steps of about 4 % */
function priceList(cur, kind) {
    const base = currency(cur)[kind], dp = currency(cur).dp;
    const step = Math.max(fineStep(cur), niceStep(base * 0.04, dp));
    const first = Math.max(step, Math.round(base * 0.6 / step) * step);
    const out = [];
    for (let v = first; v <= base * 1.4 + 1e-9; v += step) {
        const r = roundTo(v, dp);
        if (out.indexOf(r) < 0) out.push(r);
    }
    return out;
}
/** the next price of priceList above the current one, wrapping round (bar buttons without the editor) */
function nextPrice(st, cur, kind) {
    const list = priceList(cur, kind), now = price(st, cur, kind);
    const i = list.findIndex((v) => v > now + 1e-9);
    return setPrice(st, cur, kind, i >= 0 ? list[i] : list[0]);
}
/** prices set in the settings up to 1.1 (one set, whatever the currency): kept where they fit the currency */
function seedPrices(st, cur, legacy) {
    let n = 0;
    for (const kind of Object.keys(KINDS)) {
        const v = legacy && Number(legacy[kind]);
        if (st.prices && st.prices[cur] && isNum(st.prices[cur][kind])) continue;
        const typ = currency(cur)[kind];
        if (isNum(v) && v >= typ * 0.3 && v <= typ * 3 && setPrice(st, cur, kind, v) !== null) n++;
    }
    return n;
}

/**
 * The price editor's arithmetic, apart from its drawing (price_sheet.js): the controller or the
 * +/- buttons step the value, the keypad types one. value(): what Save would store (null: not a price).
 */
class PriceEdit {
    constructor(cur, kind, value) {
        this.cur = cur; this.kind = kind;
        this.dp = currency(cur).dp;
        this.v = cleanPrice(cur, kind, value) || currency(cur)[kind];
        this.entry = null;          // typed text, while typing
    }
    /** steps of the +/- buttons: one, ten and a hundred units of the last decimal */
    steps() { const f = fineStep(this.cur); return [f * 100, f * 10, f]; }
    /** n steps of size (a fast controller turn: d clicks at once moves ten times as far) */
    step(n, size) {
        const base = this.entry !== null ? this.value() : this.v;
        this.entry = null;
        const raw = (base === null ? this.v : base) + n * size;
        const next = cleanPrice(this.cur, this.kind, raw > 0 ? raw : fineStep(this.cur));   // below 0: the smallest price
        if (next !== null) this.v = next;
    }
    turn(d) { this.step(d, fineStep(this.cur) * (Math.abs(d) >= 3 ? 10 : 1)); }
    key(k) {
        let e = this.entry === null ? '' : this.entry;
        if (k === 'del') { e = (this.entry === null ? this.text() : e).slice(0, -1); this.entry = e; return; }
        if (k === '.') {
            if (this.dp === 0 || e.indexOf('.') >= 0) return;
            this.entry = (e || '0') + '.';
            return;
        }
        if (!/^\d$/.test(k)) return;
        const dot = e.indexOf('.');
        if (dot >= 0 && e.length - dot - 1 >= this.dp) return;       // no more decimals than the currency has
        if (e.replace('.', '').length >= 7) return;
        this.entry = (e === '0' ? '' : e) + k;
    }
    /** what the editor shows */
    text() { return this.entry !== null ? this.entry : this.v.toFixed(this.dp); }
    value() { return this.entry !== null ? cleanPrice(this.cur, this.kind, this.entry) : this.v; }
}

/** The saved state, else its backup (a write cut off by the unit shutting down), else a fresh one. */
function loadState(file, log, now) {
    now = now || Date.now();
    for (const f of [file, file + '.bak']) {
        try {
            if (!fs.existsSync(f)) continue;
            const loaded = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (!loaded || !loaded.trip) continue;
            const s = freshState(now);
            Object.assign(s.trip, loaded.trip);
            s.lastLive = loaded.lastLive || 0;
            if (loaded.prices && typeof loaded.prices === 'object') s.prices = loaded.prices;
            if (f !== file && log) log.warn('hybrid_cost state restored from the backup');
            return s;
        } catch (e) {
            if (log) log.warn('Could not load ' + path.basename(f) + ': ' + e.message);
        }
    }
    return freshState(now);
}

/**
 * Atomic save: the new state goes to a temporary file (flushed to disk), the previous one becomes
 * the backup, then the new one takes its name. The unit can lose power at any moment; at worst the
 * backup is one save old.
 */
function saveState(file, state) {
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(file)) fs.renameSync(file, file + '.bak');
    fs.renameSync(tmp, file);
}

/** Engine running: true / false, null = no rpm yet. prev = the last state (hysteresis); old rpm = not running (asleep). */
function engineState(prev, rpm, ageMs) {
    if (!isNum(rpm)) return null;
    const fresh = ageMs < RPM_FRESH_MS;
    return prev === true ? fresh && rpm >= RPM_OFF : fresh && rpm > RPM_ON;
}

/** km/h, or null: a speed gone quiet after standing still is still 0, after driving it's not known. */
function speedNow(v, ageMs) {
    if (!isNum(v)) return null;
    if (ageMs < SPEED_FRESH_MS) return v;
    return v < EV_MIN_KMH ? 0 : null;
}

class Tracker {
    /** opts: { log } */
    constructor(state, opts) {
        this.state = state;
        this.log = (opts && opts.log) || { info() {}, warn() {} };
        this.engineOn = null;            // null = not known yet
        this.speed = null;               // km/h as last ticked, null = not known
        this.torque = null;              // Nm, null = not known / stale
        this.lastTick = null;
        this.dirty = false;
    }

    pause() { this.engineOn = null; this.lastTick = null; }

    /**
     * One tick (about once a second). s = { now, live (the car sent something lately), rpm, rpmAge,
     * speed, speedAge, torque, torqueAge, gLong (g), gLongAge }. Ages in ms (Infinity = never sent).
     */
    tick(s) {
        const now = s.now, st = this.state;
        let dt = this.lastTick === null ? 0 : (now - this.lastTick) / 1000;
        this.lastTick = now;
        if (dt > MAX_GAP_S || dt < 0) dt = 0;          // the unit slept or stalled: that time isn't known

        if (s.live) {
            if (st.lastLive && now - st.lastLive > TRIP_GAP_MS) this.newTrip(now);
            st.lastLive = now;
        }

        const on = engineState(this.engineOn, s.rpm, s.rpmAge);
        if (on !== null) this.engineOn = on;
        const v = speedNow(s.speed, s.speedAge);
        this.speed = v;
        this.torque = isNum(s.torque) && s.torqueAge < RPM_FRESH_MS ? s.torque : null;
        const g = isNum(s.gLong) && s.gLongAge < ACCEL_FRESH_MS ? s.gLong : null;
        if (dt <= 0 || v === null) return;

        const tr = st.trip, m = (v / 3.6) * dt, km = m / 1000;
        if (this.engineOn === true) {
            const load = this.torque === null ? 1 : Math.max(ICE_MIN_LOAD, this.torque / ICE_REF_NM);
            tr.iceSec += dt; tr.iceMeters += m; tr.distanceMeters += m;
            tr.fuelLitersConsumed += (ICE_L100 / 100) * km * load;
            this.dirty = true;
        } else if (this.engineOn === false && v > EV_MIN_KMH) {
            const load = this.torque === null ? 1 : Math.max(EV_MIN_LOAD, this.torque / EV_REF_NM);
            tr.evSec += dt; tr.evMeters += m; tr.distanceMeters += m;
            tr.kwhConsumed += (EV_KWH100 / 100) * km * load;
            this.dirty = true;
        }
        if (g !== null && g < REGEN_G && v > REGEN_MIN_KMH) {
            const kw = Math.min(REGEN_MAX_KW, Math.abs(g) * 1.8 * v);
            tr.regenKwhHarvested += (kw * dt) / 3600;
            this.dirty = true;
        }
    }

    newTrip(now) {
        this.log.info('new trip (no data from the car for ' + Math.round((now - this.state.lastLive) / 60000) + ' min)');
        this.state.trip = freshTrip(now);
        this.dirty = true;
    }

    resetTrip(now) {
        this.state.trip = freshTrip(now);
        this.dirty = true;
    }
}

/** What the trip cost, what a petrol car (c.purePetrolAvg L/100 km) would have, and the monthly projection. */
function tripCost(tr, c) {
    const fuel = tr.fuelLitersConsumed * c.petrolPrice;
    const elec = tr.kwhConsumed * c.elecPrice;
    const total = fuel + elec;
    const km = tr.distanceMeters / 1000;
    const petrolCar = (km / 100) * c.purePetrolAvg * c.petrolPrice;
    const perKm = km > 0.1 ? total / km : null;
    const monthlyPetrol = c.monthlyKm * (c.purePetrolAvg / 100) * c.petrolPrice;
    const monthly = perKm === null ? null : c.monthlyKm * perKm;
    return {
        fuel, elec, total, km, petrolCar,
        saved: Math.max(0, petrolCar - total),
        regen: tr.regenKwhHarvested * c.elecPrice,
        avgKwh100: tr.evMeters > 100 ? tr.kwhConsumed / (tr.evMeters / 1000) * 100 : null,
        avgFuel100: tr.iceMeters > 100 ? tr.fuelLitersConsumed / (tr.iceMeters / 1000) * 100 : null,
        monthly, monthlyPetrol,
        monthlySaved: monthly === null ? null : Math.max(0, monthlyPetrol - monthly),
    };
}

/** Estimated running cost / 100 km at this speed (aero grows with v²), electric vs petrol. */
function liveCost(speed, c) {
    const v = Math.max(20, isNum(speed) ? speed : 0);
    const kwh100 = Math.min(32, Math.max(13, 14.0 + Math.pow(v / 100, 2) * 8.5));
    const fuel100 = Math.min(14, Math.max(4.8, 5.0 + Math.pow(v / 120, 2) * 2.8));
    const elec100 = kwh100 * c.elecPrice;
    const petrol100 = fuel100 * c.petrolPrice;
    return { kwh100, fuel100, elec100, petrol100, electricCheaper: elec100 < petrol100 && v < EV_MAX_KMH };
}

module.exports = {
    Tracker, loadState, saveState, freshState, engineState, speedNow, tripCost, liveCost, isNum,
    CURRENCIES, KINDS, currency, price, setPrice, nextPrice, priceList, seedPrices, PriceEdit,
    RPM_FRESH_MS, TRIP_GAP_MS, EV_MAX_KMH, ICE_L100, EV_KWH100,
};
