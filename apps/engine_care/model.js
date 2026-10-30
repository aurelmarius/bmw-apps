'use strict';
/**
 * model.js - Engine Care's bookkeeping, without signals or drawing, so the same code runs on the
 * car, in the tests (tests/engine_care.test.js) and on recorded drives (tools/replay_engine_care.js).
 *
 *   const st = loadState(file, log)            saved state, else its backup, else a fresh one
 *   saveState(file, st)                         atomic: temporary file, flush, rename (throws on error)
 *   const tr = new Tracker(st, { log, cfg, onAlert })
 *   tr.tick(sample)                             once a second, sample = the car's last values (see tick)
 *   tr.pause()                                  demo data on: the next engine state is a baseline again
 *   tr.onOdo(src, km)                           a distance counter reading from the engine unit
 *   tr.drivenKm()                               { km, src: 'odometer' | 'speed' } since the oil reset
 *   tr.resetService(now)                        oil changed: archive the period, counters to 0
 *   oilHealth(st, cfg, now)                     remaining life, wear, status
 *   parseDistance('-1.200 km')                  CBS distance text -> signed km
 *
 * cfg() returns the settings: coldThreshold, hardTorque, warmTarget (°C), shortCycleH (h), socReserve (%),
 * maxKm, maxMonths, maxHours.
 */
const fs = require('fs');
const path = require('path');

const RPM_ON = 600, RPM_OFF = 300;   // engine start / stop, with hysteresis
const RPM_FRESH_MS = 5000;           // a running engine sends rpm all the time: older = not running
const SPEED_FRESH_MS = 10000;
const MAX_GAP_S = 5;                 // a longer pause between ticks (unit asleep or stalled) isn't counted
const TRIP_GAP_MS = 15 * 60000;      // no data from the car this long: the next drive is a new trip
const ODO_MAX_STEP_KM = 2000;        // a bigger jump between two readings (another source, a cleared counter) re-anchors
const HARD_RPM = 3200;
const HOT_OIL = 115;
const EV_TORQUE_MIN_KMH = 3;         // torque while moving with the engine off: is it the e-motor's too?
// wear, counted in engine hours on top of the hours the engine ran
const COLD_START_H = 0.25;           // every start below the cold threshold
const HARD_START_H = 2.5;            // a cold start put under high load (on top of the cold start)
const HOT_EXTRA = 2;                 // each hour with oil above HOT_OIL counts this many hours more
const KM_PER_MILE = 1.609344;
const DAY_MS = 86400000, MONTH_D = 30.4375;

const isNum = (v) => typeof v === 'number' && isFinite(v);

const freshTrip = (now) => ({
    start: now,
    iceSec: 0, evSec: 0, iceMeters: 0, evMeters: 0,
    iceStarts: 0, coldStarts: 0, coldHardStarts: 0, shortCycles: 0,
});
const freshService = (now) => ({
    resetDate: now,
    odoKm: 0,           // distance from the engine unit since the reset (see onOdo)
    odoBaseKm: 0,       // estimated from speed before the first distance reading
    odoLast: null,      // { src, km }: the last reading, kept across resets
    iceSec: 0, evSec: 0, iceMeters: 0, evMeters: 0,
    iceStarts: 0,
    coldStarts: 0,
    coldHardStarts: 0,
    shortCycles: 0,     // cold starts stopped again before the oil got warm (fuel and water stay in the oil)
    shortCycleSec: 0,
    startsLowSoc: 0,    // engine starts with the battery at its reserve (the car had to)
    startsWithCharge: 0,
    coldStartsWithCharge: 0,
    thermalStressSec: 0,
});
const freshDiag = () => ({
    countedSec: 0,      // time counted (engine or EV) ...
    hiddenSec: 0,       // ... of it while the app's screen was closed: > 0 = the app counts in the background
    torqueEvMax: null,  // highest crankshaft torque seen moving with the engine off (> 0: the signal has the e-motor in it)
    torqueEvSec: 0,
});
const freshState = (now) => ({ service: freshService(now), trip: freshTrip(now), history: [], lastLive: 0, diag: freshDiag() });

/** The saved state, else its backup (a write cut off by the unit shutting down), else a fresh one. */
function loadState(file, log, now) {
    now = now || Date.now();
    for (const f of [file, file + '.bak']) {
        try {
            if (!fs.existsSync(f)) continue;
            const loaded = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (!loaded || !loaded.service) continue;
            const s = freshState(now);
            Object.assign(s.service, loaded.service);
            Object.assign(s.trip, loaded.trip || {});
            Object.assign(s.diag, loaded.diag || {});
            s.history = Array.isArray(loaded.history) ? loaded.history : [];
            s.lastLive = loaded.lastLive || 0;
            delete s.service.resetCbsKm;         // up to 1.3: km taken from the CBS countdown
            if (f !== file && log) log.warn('engine_care state restored from the backup');
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

/**
 * A CBS distance as the cluster formats it ("12.300 km", "12 300 km", "7,600 mi", "-1.200 km" when
 * overdue) -> signed km, or null. Takes the raw text (a Unicode minus counts).
 */
function parseDistance(s) {
    s = String(s === undefined || s === null ? '' : s);
    const m = /([-−–]?)\s*(\d[\d.,\s'  ]*)/.exec(s);
    if (!m) return null;
    const n = parseInt(m[2].replace(/\D/g, ''), 10);
    if (isNaN(n)) return null;
    const km = /\bmi\b|miles|meilen/i.test(s) ? n * KM_PER_MILE : n;
    return Math.round(m[1] ? -km : km);
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
    return v < 3 ? 0 : null;
}

class Tracker {
    /** opts: { log, cfg: () => settings, onAlert(text, ms) } */
    constructor(state, opts) {
        this.state = state;
        this.log = opts.log || { info() {}, warn() {} };
        this.cfg = opts.cfg;
        this.onAlert = opts.onAlert || (() => {});
        this.engineOn = null;            // null = not known yet
        this.coldActive = false;         // a cold start that hasn't been put under load (yet)
        this.cycle = null;               // this engine run: { t, cold, peak }
        this.lastTick = null;
        this.dirty = false;
    }

    pause() { this.engineOn = null; this.coldActive = false; this.cycle = null; this.lastTick = null; }

    /**
     * One tick (about once a second). s = { now, live (the car sent something lately), rpm, rpmAge,
     * speed, speedAge, oil (engine oil °C or null), coolant, torque, torqueAge, soc (% or null), visible }.
     * Ages in ms (Infinity = never sent).
     */
    tick(s) {
        const now = s.now, st = this.state, c = this.cfg();
        let dt = this.lastTick === null ? 0 : (now - this.lastTick) / 1000;
        this.lastTick = now;
        if (dt > MAX_GAP_S || dt < 0) dt = 0;          // the unit slept or stalled: that time isn't known

        if (s.live) {
            if (st.lastLive && now - st.lastLive > TRIP_GAP_MS) this.newTrip(now);
            st.lastLive = now;
        }

        const on = engineState(this.engineOn, s.rpm, s.rpmAge);
        const v = speedNow(s.speed, s.speedAge);
        // the temperature for "cold": the oil's, else the coolant's (the oil lags it, so a cold coolant
        // means cold oil; a warm coolant doesn't prove warm oil), else not known: nothing counts as cold
        const coldT = isNum(s.oil) ? s.oil : isNum(s.coolant) ? s.coolant : null;
        const torque = isNum(s.torque) && s.torqueAge < RPM_FRESH_MS ? s.torque : null;

        // starts from a known "off" only: an engine already running when the app starts isn't a start
        if (on !== null) {
            if (this.engineOn === false && on) this.started(now, coldT, s.soc, c);
            else if (this.engineOn === true && !on) this.stopped(now, c);
            this.engineOn = on;
        }
        if (this.engineOn && this.cycle && isNum(coldT)) this.cycle.peak = isNum(this.cycle.peak) ? Math.max(this.cycle.peak, coldT) : coldT;

        // a cold start put under high load or high rpm before it warmed up
        if (this.engineOn && this.coldActive) {
            if (!isNum(coldT) || coldT >= c.coldThreshold) {
                this.coldActive = false;
            } else if ((isNum(torque) && torque > c.hardTorque) || s.rpm > HARD_RPM) {
                st.service.coldHardStarts++;
                st.trip.coldHardStarts++;
                this.coldActive = false;
                this.dirty = true;
                this.onAlert(`COLD HARD START! High load below ${c.coldThreshold}°C`, 8000);
            }
        }

        // the torque signal checked: does it move while the car drives on the e-motor alone?
        if (this.engineOn === false && v !== null && v > EV_TORQUE_MIN_KMH && isNum(torque)) {
            st.diag.torqueEvMax = isNum(st.diag.torqueEvMax) ? Math.max(st.diag.torqueEvMax, torque) : torque;
            st.diag.torqueEvSec += dt;
        }

        if (dt > 0) {
            const m = v !== null ? (v / 3.6) * dt : 0;
            let counted = false;
            if (this.engineOn === true) {
                st.service.iceSec += dt; st.trip.iceSec += dt;
                st.service.iceMeters += m; st.trip.iceMeters += m;
                if (isNum(s.oil) && s.oil > HOT_OIL) st.service.thermalStressSec += dt;
                counted = true;
            } else if (this.engineOn === false && v !== null && v > 3) {
                st.service.evSec += dt; st.trip.evSec += dt;
                st.service.evMeters += m; st.trip.evMeters += m;
                counted = true;
            }
            if (counted) {
                st.diag.countedSec += dt;
                if (s.visible === false) st.diag.hiddenSec += dt;
                this.dirty = true;
            }
        }
    }

    started(now, coldT, soc, c) {
        const st = this.state;
        st.service.iceStarts++; st.trip.iceStarts++;
        const socKnown = isNum(soc), low = socKnown && soc <= c.socReserve;
        if (socKnown) { if (low) st.service.startsLowSoc++; else st.service.startsWithCharge++; }
        this.cycle = { t: now, cold: false, peak: coldT };
        this.dirty = true;
        if (!isNum(coldT)) { this.log.info('engine start, temperature not known: not counted as cold'); return; }
        if (coldT < c.coldThreshold) {
            st.service.coldStarts++; st.trip.coldStarts++;
            if (socKnown && !low) st.service.coldStartsWithCharge++;
            this.coldActive = true;
            this.cycle.cold = true;
        }
    }

    /** A cold start that stops before the oil reached warmTarget: a short cycle. */
    stopped(now, c) {
        const cy = this.cycle, st = this.state;
        this.cycle = null;
        this.coldActive = false;
        if (!cy || !cy.cold) return;
        if (isNum(cy.peak) && cy.peak >= c.warmTarget) return;
        const sec = (now - cy.t) / 1000;
        st.service.shortCycles++; st.trip.shortCycles++;
        st.service.shortCycleSec += sec;
        this.dirty = true;
        this.log.info(`short engine run: ${Math.round(sec)} s, ${isNum(cy.peak) ? 'peak ' + Math.round(cy.peak) + ' °C' : 'temperature not known'}`);
    }

    newTrip(now) {
        this.log.info('new trip (no data from the car for ' + Math.round((now - this.state.lastLive) / 60000) + ' min)');
        this.state.trip = freshTrip(now);
        this.dirty = true;
    }

    /** A distance counter reading: only its increases count (a counter that restarts, or another source, re-anchors). */
    onOdo(src, km) {
        const s = this.state.service, last = s.odoLast;
        if (!last) {
            s.odoBaseKm = (s.iceMeters + s.evMeters) / 1000;
            this.log.info(`distance from the engine unit (${src}): ${km} km, ${s.odoBaseKm.toFixed(1)} km estimated before it`);
        } else if (last.src === src && km >= last.km && km - last.km <= ODO_MAX_STEP_KM) {
            s.odoKm += km - last.km;
        } else {
            this.log.info(`distance counter re-anchored: ${last.src} ${last.km} -> ${src} ${km}`);
        }
        s.odoLast = { src, km };
        this.dirty = true;
    }

    drivenKm() { return drivenKm(this.state); }

    /** Oil changed: the period goes to the history, its counters start again (the last distance reading stays). */
    resetService(now) {
        const st = this.state, s = st.service;
        const entry = {
            date: new Date(now).toISOString().split('T')[0],
            km: Math.round(drivenKm(st).km),
            iceHours: Number((s.iceSec / 3600).toFixed(1)),
            evHours: Number((s.evSec / 3600).toFixed(1)),
            iceKm: Math.round(s.iceMeters / 1000),
            evKm: Math.round(s.evMeters / 1000),
            coldStarts: s.coldStarts,
            coldHardStarts: s.coldHardStarts,
            shortCycles: s.shortCycles,
        };
        st.history.push(entry);
        st.service = Object.assign(freshService(now), { odoLast: s.odoLast });
        this.coldActive = false;
        this.cycle = this.engineOn ? { t: now, cold: false, peak: null } : null;
        this.dirty = true;
        return entry;
    }
}

/** Distance since the oil reset: { km, src: 'odometer' | 'speed' }. */
function drivenKm(st) {
    const s = st.service;
    if (s.odoLast) return { km: s.odoBaseKm + s.odoKm, src: 'odometer' };
    return { km: (s.iceMeters + s.evMeters) / 1000, src: 'speed' };
}

/**
 * Oil life: whichever of km (all km since the change), months and engine hours comes first, plus
 * wear counted in engine hours (cold starts, cold hard starts, short cycles, hot oil).
 */
function oilHealth(st, c, now) {
    const s = st.service;
    const maxH = c.maxHours, targetKm = c.maxKm, targetMonths = c.maxMonths;
    const iceH = s.iceSec / 3600;
    const driven = drivenKm(st);
    const drivenKmR = Math.round(driven.km);
    const daysSince = Math.max(0, Math.floor((now - (s.resetDate || now)) / DAY_MS));
    const monthsSince = daysSince / MONTH_D;

    const kmRatio = driven.km / targetKm;
    const timeRatio = monthsSince / targetMonths;
    const hoursRatio = iceH / maxH;
    const penaltyH = s.coldStarts * COLD_START_H + s.coldHardStarts * HARD_START_H
        + s.shortCycles * c.shortCycleH + (s.thermalStressSec / 3600) * HOT_EXTRA;
    const baseWear = Math.max(kmRatio, timeRatio, hoursRatio);
    const totalWear = Math.min(1, baseWear + penaltyH / maxH);
    const lifePct = Math.max(0, Math.min(100, Math.round((1 - totalWear) * 100)));

    const remKm = Math.max(0, Math.round(targetKm - driven.km));
    const remDays = Math.max(0, Math.round(targetMonths * MONTH_D - daysSince));
    const remMonths = Math.max(0, Number((targetMonths - monthsSince).toFixed(1)));
    const remHours = Math.max(0, Math.round(maxH - iceH - penaltyH));

    let status = 'HEALTHY', level = 'ok';
    if (lifePct <= 10 || remKm <= 500 || remDays <= 15) { status = 'SERVICE DUE'; level = 'crit'; } else if (lifePct <= 25 || remKm <= 2000 || remDays <= 45) { status = 'DUE SOON'; level = 'warn'; }

    return {
        lifePct, remKm, remDays, remMonths, remHours, daysSince, monthsSince, status, level,
        iceH, penaltyH, effectiveDrivenKm: drivenKmR, drivenSrc: driven.src, targetKm, targetMonths,
        limitingFactor: hoursRatio >= kmRatio && hoursRatio >= timeRatio ? 'hours' : kmRatio >= timeRatio ? 'km' : 'time',
    };
}

module.exports = {
    Tracker, loadState, saveState, freshState, parseDistance, engineState, speedNow, drivenKm, oilHealth, isNum,
    RPM_FRESH_MS, TRIP_GAP_MS, COLD_START_H, HARD_START_H,
};
