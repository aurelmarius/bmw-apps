'use strict';
/**
 * Engine Care - PHEV B48 True Engine Health & CBS Oil Degradation Monitor
 * Built specifically for BMW G20 330e PHEV architecture:
 *   - Tracks actual ICE runtime hours vs EV glide hours
 *   - Detects Cold Hard Starts (electric overtaking kick-downs when engine oil < 65°C)
 *   - Computes Real Oil Degradation Index (%) based on operating hours & thermal stress
 *   - Interactive Service Reset & History Logging
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');

const W = 1600, H = 520;
const GREEN = '#2fd27a';
const BLUE = '#2a8cff';
const YELLOW = '#ffb020';
const RED = '#ef2b2d';

const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const COLORS = { DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 };

const TICK_MS = 1000;                // runtime / distance are added up on this clock
const MAX_GAP_S = 5;                 // a longer pause between ticks (unit asleep or stalled) isn't counted
const RPM_ON = 600, RPM_OFF = 300;   // engine start / stop, with hysteresis
const RPM_FRESH_MS = 5000;           // a running engine sends rpm all the time: older = not running
const SPEED_FRESH_MS = 10000;
const LIVE_MS = 60000;               // the car counts as there while it sent anything this recently
const TRIP_GAP_MS = 15 * 60000;      // no data from the car this long: the next drive is a new trip
const CONFIRM_MS = 5000;             // "Reset Oil Service" needs a second press within this
// engine oil temperature from the engine unit (DME) when CDS sends none - as Car Vitals;
// app.json config.dme overrides
const DME = {
    ecu: 0x12,
    oil: [
        { obd: '5C', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 170 },
        { did: 'F45C', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 170 },
    ],
    // distance driven: OBD PID A6 odometer (0.1 km), else PID 31 distance since the fault memory
    // was cleared (1 km; back to 0 after a clear - only its increases are used, see onOdo)
    odo: [
        { obd: 'A6', bytes: 4, at: 0, factor: 0.1, offset: 0, min: 1, max: 2000000 },
        { did: 'F4A6', bytes: 4, at: 0, factor: 0.1, offset: 0, min: 1, max: 2000000 },
        { obd: '31', bytes: 2, at: 0, factor: 1, offset: 0, min: 0, max: 65535 },
        { did: 'F431', bytes: 2, at: 0, factor: 1, offset: 0, min: 0, max: 65535 },
    ],
};
const OIL_WAIT_MS = 30000;           // no CDS oil temperature this long after the car answered: ask the DME
const OIL_POLL_MS = 15000;
const OIL_FRESH_MS = 60000;
const ODO_POLL_MS = 60000;
const ODO_MAX_STEP_KM = 2000;        // a bigger jump between two readings (another source, a cleared counter) re-anchors
const KM_PER_MILE = 1.609344;

/**
 * A CBS distance as the cluster formats it ("12.300 km", "12 300 km", "7,600 mi", "-1.200 km" when
 * overdue) -> signed km, or null. Takes the raw text: txt() would drop a Unicode minus.
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

function find(v, key, str) {
    if (!v || typeof v !== 'object') return null;
    if (key in v && (!str || typeof v[key] === 'string')) return v;
    for (const k of Object.keys(v)) { const r = find(v[k], key, str); if (r) return r; }
    return null;
}
const colour = (c) => (typeof c === 'number' ? c : COLORS[String(c)] !== undefined ? COLORS[String(c)] : 0);
const txt = (s) => String(s === undefined || s === null ? '' : s).replace(/[^\x20-\x7e]/g, (ch) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' }[ch] || '')).trim();

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, signals, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque']);
        const dme = Object.assign({}, DME, (ctx.spec.config && ctx.spec.config.dme) || {});

        const saveFile = path.join(dataDir, 'engine_care_state.json');

        // Initial default state - starts fresh on install
        const freshTrip = () => ({
            start: Date.now(),
            iceSec: 0,
            evSec: 0,
            iceMeters: 0,
            evMeters: 0,
            coldStarts: 0,
            coldHardStarts: 0,
        });
        const freshState = () => ({
            service: {
                resetDate: Date.now(),
                odoKm: 0,           // distance from the engine unit since the reset (see onOdo)
                odoBaseKm: 0,       // estimated from speed before the first distance reading
                odoLast: null,      // { src, km }: the last reading, kept across resets
                iceSec: 0,
                evSec: 0,
                iceMeters: 0,
                evMeters: 0,
                coldStarts: 0,
                coldHardStarts: 0,
                thermalStressSec: 0,
            },
            trip: freshTrip(),
            history: [],
            lastLive: 0,        // when the car last sent data: a long gap starts a new trip
        });

        /** The saved state, else its backup (a write cut off by the unit shutting down), else a fresh one. */
        function loadState() {
            for (const f of [saveFile, saveFile + '.bak']) {
                try {
                    if (!fs.existsSync(f)) continue;
                    const loaded = JSON.parse(fs.readFileSync(f, 'utf8'));
                    if (!loaded || !loaded.service) continue;
                    const s = freshState();
                    Object.assign(s.service, loaded.service);
                    Object.assign(s.trip, loaded.trip || {});
                    s.history = Array.isArray(loaded.history) ? loaded.history : [];
                    s.lastLive = loaded.lastLive || 0;
                    delete s.service.resetCbsKm;         // up to 1.3: km taken from the CBS countdown
                    if (f !== saveFile) log.warn('engine_care state restored from the backup');
                    return s;
                } catch (e) {
                    log.warn('Could not load ' + path.basename(f) + ': ' + e.message);
                }
            }
            return freshState();
        }
        let state = loadState();

        /**
         * Atomic save: the new state goes to a temporary file (flushed to disk), the previous one
         * becomes the backup, then the new one takes its name. The unit can lose power at any moment;
         * at worst the backup is one save old.
         */
        let dirty = false, lastSave = 0;
        function saveState() {
            const tmp = saveFile + '.tmp';
            try {
                const fd = fs.openSync(tmp, 'w');
                try { fs.writeSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                if (fs.existsSync(saveFile)) fs.renameSync(saveFile, saveFile + '.bak');
                fs.renameSync(tmp, saveFile);
                dirty = false; lastSave = Date.now();
            } catch (e) {
                log.warn('Could not save engine_care state: ' + e.message);
            }
        }
        process.on('exit', () => { if (dirty) saveState(); });

        /* ---------- BMW CBS (instrument cluster) ----------
         * Shown as the car says it, never used as a distance: BMW's oil countdown is condition based
         * (fuel burnt, cold starts, driving style) and doesn't go down 1 km per km driven. */
        let cbsOil = {
            available: false,
            fromList: false,        // the service list had an oil item (the summary is only a fallback)
            name: 'Engine oil',
            way: '',
            km: null,               // signed km left (< 0 = overdue), null = no distance
            date: '',
            color: GREEN,
        };
        function setCbs(way, date, col) {
            cbsOil.available = true;
            cbsOil.way = txt(way);
            cbsOil.km = parseDistance(way);
            cbsOil.date = txt(date);
            const c = colour(col);
            cbsOil.color = c === 1 || (cbsOil.km !== null && cbsOil.km < 0) ? RED : (c === 2 || c === 4) ? YELLOW : GREEN;
        }

        if (signals && typeof signals.watch === 'function') {
            signals.watch(KOMBI, '1', {
                cbsDataServiceList: (v) => {
                    const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
                    for (const e of arr) {
                        const s = find(e, 'cBSIdentifier') || {};
                        if (s.cBSIdentifier === 1) { // 1 = Engine oil
                            cbsOil.fromList = true;
                            cbsOil.name = txt(s.cBSServcieName || s.cBSServiceName) || 'Engine oil';
                            setCbs(s.cBSServiceWay, s.cBSServiceDate, s.cBSColor);
                            log.info(`CBS oil from the cluster: ${JSON.stringify(s.cBSServiceWay)} -> ${cbsOil.km} km, date: ${cbsOil.date}`);
                            break;
                        }
                    }
                },
                cbsDataSBA: (v) => {
                    if (!v || cbsOil.fromList) return;
                    const s = find(v, 'cBSDataSBAText') || v;
                    // the next service, in the car's language ("Engine oil", "Motoroel", "Ulei de motor")
                    if (/oil|motor|oel/i.test(txt(s.cBSDataSBAText))) setCbs(s.cBSDataSBADistance, s.cBSDataSBADate, s.cBSDataSBAColor);
                },
            }, log, { pollMs: 60000 });             // some clusters don't notify these: read them every minute
        }

        /* ---------- Engine oil temperature ----------
         * From CDS (statusEngineTemperature); some cars send none there (invalid 255), then from the
         * engine unit (OBD PID 5C / DID F45C over the diagnostic link, as Car Vitals does). */
        let rd = null, dmeQueue = Promise.resolve(), firstLive = 0;
        /** One request to the engine unit at a time, over one diagnostic link: { v, src } (v null = no answer). */
        function dmeRead(name, list) {
            const run = async () => {
                if (!rd) {
                    const link = new Diag(signals, log);
                    link.quiet = true;
                    await link.init();
                    rd = new DidReader(link, { ecu: dme.ecu });
                }
                const v = await rd.value(name, list);
                return { v, src: v === null ? null : DidReader.label(list[rd.pick[name] || 0]) };
            };
            const p = dmeQueue.then(run, run);
            dmeQueue = p.catch(() => {});
            return p;
        }

        let dmeOil = null;               // { value, t }
        let oilBusy = false, oilAskT = 0;
        const cdsOil = () => (G.isNum(car.live.oil) ? car.live.oil : null);
        function pollDmeOil() {
            const now = Date.now();
            if (oilBusy || now - oilAskT < OIL_POLL_MS || cdsOil() !== null) return;
            if (!firstLive || now - firstLive < OIL_WAIT_MS || now - car.lastCar > LIVE_MS) return;
            if (!oilAskT) log.info('no oil temperature from CDS: reading it from the engine unit');
            oilAskT = now; oilBusy = true;
            dmeRead('oil', dme.oil).then(({ v }) => { if (v !== null) dmeOil = { value: v, t: Date.now() }; })
                .catch((e) => log.warn('DME oil: ' + e)).then(() => { oilBusy = false; });
        }

        /* ---------- Distance driven ----------
         * From the engine unit's distance counter (OBD A6 odometer, or PID 31), read once a minute; only
         * its increases are added up, so a counter that restarts or a change of source loses nothing
         * already counted. Before the first reading (and when the unit never answers) the distance is
         * estimated from the speed. */
        let odoBusy = false, odoAskT = 0, odoFails = 0;
        function pollOdo() {
            const now = Date.now();
            if (odoBusy || now - odoAskT < ODO_POLL_MS * Math.min(10, 1 + odoFails)) return;
            if (!firstLive || now - car.lastCar > LIVE_MS) return;
            odoAskT = now; odoBusy = true;
            dmeRead('odo', dme.odo).then(({ v, src }) => {
                if (v === null) { if (++odoFails === 3) log.warn('no distance from the engine unit: estimating it from the speed'); return; }
                odoFails = 0;
                onOdo(src, v);
            }).catch((e) => log.warn('DME distance: ' + e)).then(() => { odoBusy = false; });
        }
        function onOdo(src, km) {
            const s = state.service, last = s.odoLast;
            if (!last) {
                s.odoBaseKm = (s.iceMeters + s.evMeters) / 1000;
                log.info(`distance from the engine unit (${src}): ${km} km, ${s.odoBaseKm.toFixed(1)} km estimated before it`);
            } else if (last.src === src && km >= last.km && km - last.km <= ODO_MAX_STEP_KM) {
                s.odoKm += km - last.km;
            } else {
                log.info(`distance counter re-anchored: ${last.src} ${last.km} -> ${src} ${km}`);
            }
            s.odoLast = { src, km };
            dirty = true;
        }
        /** Distance since the oil reset: { km, src: 'odometer' | 'speed' }. */
        function drivenKm() {
            const s = state.service;
            if (s.odoLast) return { km: s.odoBaseKm + s.odoKm, src: 'odometer' };
            return { km: (s.iceMeters + s.evMeters) / 1000, src: 'speed' };
        }
        /**
         * { oil, cold, src }: oil = engine oil temperature or null; cold = the temperature the cold
         * checks use - the oil's, else the coolant's (the oil lags it, so a cold coolant means cold oil;
         * a warm coolant doesn't prove warm oil), else null (not known: nothing is counted as cold).
         */
        function temps() {
            const c = cdsOil();
            if (c !== null) return { oil: c, cold: c, src: 'oil' };
            if (dmeOil && Date.now() - dmeOil.t < OIL_FRESH_MS) return { oil: dmeOil.value, cold: dmeOil.value, src: 'oil (DME)' };
            const k = G.isNum(car.live.coolant) ? car.live.coolant : null;
            return { oil: null, cold: k, src: k === null ? null : 'coolant' };
        }

        /* ---------- Telemetry Tracking ----------
         * Runtime and distance are added up on a fixed 1 s clock from the last values the car sent.
         * The signals are only sent when they change: adding up per signal sample lost the time between
         * samples (EV gliding at a steady speed, the engine standing still at 0 rpm). */
        let engineOn = null;             // null = not known yet (no rpm, or just back from demo data)
        let coldStartActive = false;
        let alertMessage = null;
        let alertUntil = 0;
        let resetArmed = 0;
        let activeTab = 0; // 0 = Lifetime CBS, 1 = Trip Telemetry

        /** Engine running: true / false, null = no rpm from the car yet. Old rpm = not running (asleep). */
        function readEngine() {
            const rpm = car.live.rpm;
            if (!G.isNum(rpm)) return null;
            const fresh = car.age('rpm') < RPM_FRESH_MS;
            return engineOn === true ? fresh && rpm >= RPM_OFF : fresh && rpm > RPM_ON;
        }
        /** km/h, or null: a speed gone quiet after standing still is still 0, after driving it's not known. */
        function readSpeed() {
            const v = car.live.speed;
            if (!G.isNum(v)) return null;
            if (car.age('speed') < SPEED_FRESH_MS) return v;
            return v < 3 ? 0 : null;
        }

        function resetTrip() {
            log.info('new trip (no data from the car for ' + Math.round((Date.now() - state.lastLive) / 60000) + ' min)');
            state.trip = freshTrip();
            dirty = true;
        }

        let lastTick = Date.now();
        function tick() {
            const now = Date.now();
            let dt = (now - lastTick) / 1000;
            lastTick = now;
            if (dt > MAX_GAP_S) dt = 0;          // the unit slept or stalled: that time isn't known

            // demo data is shown, never counted; afterwards the first engine state is a baseline, not a start
            if (car.data().demo) { engineOn = null; coldStartActive = false; return; }
            if (!car.lastCar) return;            // nothing from the car yet
            if (now - car.lastCar < LIVE_MS) {
                if (state.lastLive && now - state.lastLive > TRIP_GAP_MS) resetTrip();
                state.lastLive = now;
                if (!firstLive) firstLive = now;
            }

            const on = readEngine(), v = readSpeed(), tp = temps();
            const coldThreshold = Number(settings.get('coldThreshold') || 65);
            const hardTorque = Number(settings.get('hardTorque') || 150);

            // Detect engine start transition (from a known "off" only: an engine already running when the app starts isn't a start)
            if (on !== null) {
                if (engineOn === false && on) {
                    if (!G.isNum(tp.cold)) {
                        log.info('engine start, temperature not known: not counted');
                    } else if (tp.cold < coldThreshold) {
                        state.service.coldStarts++;
                        state.trip.coldStarts++;
                        coldStartActive = true;
                        dirty = true;
                    }
                }
                engineOn = on;
            }
            if (!engineOn) coldStartActive = false;

            // Check for Cold Hard Start Abuse (high torque or high RPM while the engine is still cold)
            if (engineOn && coldStartActive) {
                if (!G.isNum(tp.cold) || tp.cold >= coldThreshold) {
                    coldStartActive = false;
                } else {
                    const torque = car.age('torque') < RPM_FRESH_MS ? car.live.torque : null;
                    if ((G.isNum(torque) && torque > hardTorque) || car.live.rpm > 3200) {
                        state.service.coldHardStarts++;
                        state.trip.coldHardStarts++;
                        coldStartActive = false;
                        dirty = true;
                        alertMessage = `COLD HARD START! High load below ${coldThreshold}°C`;
                        alertUntil = now + 8000;
                    }
                }
            }

            // Accumulate operating hours and distance
            if (dt > 0) {
                const m = v !== null ? (v / 3.6) * dt : 0;
                if (engineOn === true) {
                    state.service.iceSec += dt;
                    state.trip.iceSec += dt;
                    state.service.iceMeters += m;
                    state.trip.iceMeters += m;
                    if (G.isNum(tp.oil) && tp.oil > 115) state.service.thermalStressSec += dt;
                    dirty = true;
                } else if (engineOn === false && v !== null && v > 3) {
                    state.service.evSec += dt;
                    state.trip.evSec += dt;
                    state.service.evMeters += m;
                    state.trip.evMeters += m;
                    dirty = true;
                }
            }

            // Save every 15s while something changed
            if (dirty && now - lastSave > 15000) saveState();
            pollDmeOil();
            pollOdo();
        }
        setInterval(tick, TICK_MS);

        /* ---------- Actions ---------- */
        ui.onClick('BTN_PAGE', () => {
            activeTab = (activeTab + 1) % 2;
            resetArmed = 0;
            render();
        });

        // first press arms the reset, a second one within 5 s does it
        ui.onClick('BTN_RESET', () => {
            if (Date.now() - resetArmed > CONFIRM_MS) {
                resetArmed = Date.now();
                alertMessage = 'Press "Reset Oil Service" again to confirm (5 s)';
                alertUntil = resetArmed + CONFIRM_MS;
                render();
                return;
            }
            resetArmed = 0;
            // Archive current service
            state.history.push({
                date: new Date().toISOString().split('T')[0],
                km: Math.round(drivenKm().km),
                iceHours: Number((state.service.iceSec / 3600).toFixed(1)),
                evHours: Number((state.service.evSec / 3600).toFixed(1)),
                iceKm: Math.round(state.service.iceMeters / 1000),
                evKm: Math.round(state.service.evMeters / 1000),
                coldHardStarts: state.service.coldHardStarts,
            });

            // Reset service counters (the last distance reading stays: the next one counts from it)
            state.service.resetDate = Date.now();
            state.service.odoKm = 0;
            state.service.odoBaseKm = 0;
            state.service.iceSec = 0;
            state.service.evSec = 0;
            state.service.iceMeters = 0;
            state.service.evMeters = 0;
            state.service.coldStarts = 0;
            state.service.coldHardStarts = 0;
            state.service.thermalStressSec = 0;
            saveState();

            alertMessage = 'OIL SERVICE RESET COMPLETE';
            alertUntil = Date.now() + 5000;
            render();
        });

        /* ---------- Helpers ---------- */
        function fmtHours(sec) {
            const totalMin = Math.round(sec / 60);
            const hrs = Math.floor(totalMin / 60);
            const mins = totalMin % 60;
            return `${hrs}h ${mins < 10 ? '0' : ''}${mins}m`;
        }

        function calculateOilHealth() {
            const maxH = Number(settings.get('maxHours') || 180);
            const targetKm = Number(settings.get('maxKm') || 10000);
            const targetMonths = Number(settings.get('maxMonths') || 12);

            const iceH = state.service.iceSec / 3600;
            const iceKm = state.service.iceMeters / 1000;

            // Driven distance towards the km target: all km since the reset (the odometer, as a workshop
            // counts an oil interval); the engine's own use is in the hours target
            const driven = drivenKm();
            const effectiveDrivenKm = Math.round(driven.km);

            // Elapsed calendar time
            const resetTime = state.service.resetDate || Date.now();
            const daysSince = Math.max(0, Math.floor((Date.now() - resetTime) / 86400000));
            const monthsSince = daysSince / 30.4375;

            // Wear factors based on "whichever comes first"
            const kmRatio = effectiveDrivenKm / targetKm;
            const timeRatio = monthsSince / targetMonths;
            const hoursRatio = iceH / maxH;

            // Cold hard start abuse & thermal stress penalties
            const coldPenalty = (state.service.coldHardStarts * 2.5) / maxH;
            const thermalPenalty = ((state.service.thermalStressSec / 3600) * 2) / maxH;

            const baseWear = Math.max(kmRatio, timeRatio, hoursRatio);
            const totalWear = Math.min(1.0, baseWear + coldPenalty + thermalPenalty);
            const lifePct = Math.max(0, Math.min(100, Math.round((1 - totalWear) * 100)));

            const remKm = Math.max(0, Math.round(targetKm - effectiveDrivenKm));
            const remDays = Math.max(0, Math.round((targetMonths * 30.4375) - daysSince));
            const remMonths = Math.max(0, Number((targetMonths - monthsSince).toFixed(1)));
            const remHours = Math.max(0, Math.round(maxH * Math.max(0, 1 - hoursRatio)));

            let status = 'HEALTHY';
            let color = GREEN;
            if (lifePct <= 10 || remKm <= 500 || remDays <= 15) {
                status = 'SERVICE DUE';
                color = RED;
            } else if (lifePct <= 25 || remKm <= 2000 || remDays <= 45) {
                status = 'DUE SOON';
                color = YELLOW;
            }

            return {
                lifePct,
                remKm,
                remDays,
                remMonths,
                remHours,
                daysSince,
                monthsSince,
                status,
                color,
                iceH,
                iceKm,
                effectiveDrivenKm,
                drivenSrc: driven.src,
                targetKm,
                targetMonths,
                limitingFactor: hoursRatio >= kmRatio && hoursRatio >= timeRatio ? 'hours' : kmRatio >= timeRatio ? 'km' : 'time',
            };
        }

        /* ---------- Rendering ---------- */
        function render() {
            const t = ctx.theme();
            const d = car.data();
            const cv = ctx.canvas(W, H).clear(t.bg);

            const oilCalc = calculateOilHealth();

            // Top Header Tabs
            const badges = [
                d.demo && { text: 'DEMO' },
                alertMessage && Date.now() < alertUntil && { text: alertMessage, color: 'warn' },
            ];
            G.frame(cv, t, ['Oil Health & CBS', 'PHEV Trip Split'], activeTab, badges);

            if (activeTab === 0) {
                renderLifetimeTab(cv, t, d, oilCalc);
            } else {
                renderTripTab(cv, t, d);
            }

            return ui.image('MAIN_GFX', cv);
        }

        function renderLifetimeTab(cv, t, d, c) {
            // Panel 1 (Left): Optimal Oil Care (10k km / 12 mo)
            G.panel(cv, t, 24, 44, 490, 468, 'Recommended Oil Care');

            // Big Health Percentage
            cv.text(String(c.lifePct), 48, 175, 110, c.color, { font: 'num' });
            cv.text('%', 52 + cv.textWidth(String(c.lifePct), 110, { font: 'num' }), 175, 42, t.dim, { font: 'bold' });
            cv.text(c.status, 480, 115, 24, c.color, { font: 'bold', align: 'right' });

            // Service status sublabels
            cv.text('Remaining to recommended change:', 48, 218, 18, t.dim);
            cv.text(`${c.remKm.toLocaleString()} km  ·  ${c.remMonths} mo (${c.remDays}d)`, 48, 250, 24, c.remKm <= 1000 || c.remDays <= 30 ? RED : t.text, { font: 'bold' });

            // Degradation progress bar
            G.bar(cv, t, 48, 276, 442, 65, {
                label: `Oil Life (${c.targetKm / 1000}k km / ${c.targetMonths} mo limit)`,
                value: c.lifePct,
                max: 100,
                unit: '%',
                color: c.lifePct > 25 ? 'accent' : c.lifePct > 10 ? 'warn' : 'crit',
            });

            // BMW Native CBS Box
            cv.roundRect(48, 355, 442, 85, 8, withAlpha(cbsOil.available ? cbsOil.color : t.dim, 0.12));
            cv.strokeRoundRect(48, 355, 442, 85, 8, 1.5, withAlpha(cbsOil.available ? cbsOil.color : t.dim, 0.4));
            cv.text('BMW CBS - INSTRUMENT CLUSTER', 64, 376, 17, t.dim, { font: 'bold', spacing: 1 });
            if (cbsOil.available && (cbsOil.way || cbsOil.date)) {
                const wayStr = cbsOil.km !== null && cbsOil.km < 0 ? `OVERDUE ${(-cbsOil.km).toLocaleString()} km`
                    : cbsOil.km !== null ? `${cbsOil.km.toLocaleString()} km` : cbsOil.way;
                const dateStr = cbsOil.date ? `Due ${cbsOil.date}` : '';
                const fullStr = [wayStr, dateStr].filter(Boolean).join('  ·  ');
                cv.text(fullStr, 64, 406, 22, cbsOil.color, { font: 'bold' });
                // BMW's condition-based countdown next to this app's target
                const diff = cbsOil.km !== null ? cbsOil.km - c.remKm : null;
                const cmp = diff === null ? 'BMW gives a date only'
                    : diff > 500 ? `BMW allows ${diff.toLocaleString()} km more than your target`
                        : diff < -500 ? `BMW wants it ${(-diff).toLocaleString()} km sooner than your target`
                            : 'BMW and your target agree';
                cv.text(cmp, 64, 428, 15, diff !== null && diff < -500 ? RED : t.warn);
            } else {
                cv.text('Waiting for the instrument cluster...', 64, 406, 20, t.dim);
            }

            const kmNote = c.drivenSrc === 'speed' ? ' km driven, est. from speed' : ' km driven';
            cv.text(`Oil reset: ${c.daysSince}d ago (${c.effectiveDrivenKm.toLocaleString()}${kmNote})`, 48, 468, 17, t.dim);
            cv.text(`Target: ${c.targetKm.toLocaleString()} km / ${c.targetMonths} mo`, 48, 492, 17, t.dim);
            cv.text('Reset Oil Service', 480, 492, 18, t.accent, { align: 'right' });

            // Panel 2 (Center): PHEV Runtime & Distance Split
            G.panel(cv, t, 538, 44, 524, 468, 'PHEV Runtime Split');

            const totalSec = state.service.iceSec + state.service.evSec;
            const evRatio = totalSec > 0 ? Math.round((state.service.evSec / totalSec) * 100) : 50;
            const iceRatio = 100 - evRatio;

            // Runtime Breakdown Cards
            cv.text('ICE RUNTIME (B48)', 562, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(fmtHours(state.service.iceSec), 562, 150, 42, t.text, { font: 'bold' });

            cv.text('ELECTRIC GLIDE', 830, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(fmtHours(state.service.evSec), 830, 150, 42, BLUE, { font: 'bold' });

            // Split Bar
            const barY = 175;
            const barW = 476;
            const evBarW = Math.round((evRatio / 100) * barW);
            cv.fillRect(562, barY, barW, 20, withAlpha(t.track, 0.8));
            if (evBarW > 0) cv.fillRect(562, barY, evBarW, 20, BLUE);
            if (barW - evBarW > 0) cv.fillRect(562 + evBarW, barY, barW - evBarW, 20, t.accent);

            cv.text(`${evRatio}% EV Mode`, 562, barY + 44, 22, BLUE, { font: 'bold' });
            cv.text(`${iceRatio}% Petrol Engine`, 562 + barW, barY + 44, 22, t.text, { font: 'bold', align: 'right' });

            // Distance Breakdown
            const iceKm = Math.round(state.service.iceMeters / 1000);
            const evKm = Math.round(state.service.evMeters / 1000);
            const totalKm = Math.round(drivenKm().km);

            cv.fillRect(562, 255, barW, 1.5, withAlpha('#ffffff', 0.15));

            cv.text('ICE Km:', 562, 295, 22, t.dim);
            cv.text(`${iceKm.toLocaleString()} km`, 720, 295, 24, t.text, { font: 'bold', align: 'right' });

            cv.text('EV Km:', 820, 295, 22, t.dim);
            cv.text(`${evKm.toLocaleString()} km`, 562 + barW, 295, 24, BLUE, { font: 'bold', align: 'right' });

            cv.text('Total since oil reset:', 562, 345, 22, t.dim);
            cv.text(`${totalKm.toLocaleString()} km`, 562 + barW, 345, 26, t.text, { font: 'bold', align: 'right' });

            // Savings badge note
            cv.fillRect(562, 385, barW, 68, withAlpha(BLUE, 0.12));
            cv.strokeRoundRect(562, 385, barW, 68, 6, 1.5, withAlpha(BLUE, 0.4));
            cv.text(`${evRatio}% pure electric driving saved`, 578, 415, 22, BLUE, { font: 'bold' });
            cv.text(`${evKm.toLocaleString()} km of wear on your B48 petrol engine!`, 578, 442, 20, t.text);

            // Panel 3 (Right): Cold Starts & Engine Thermals
            G.panel(cv, t, 1086, 44, 490, 468, 'Cold Starts & Thermals');

            // Cold start stats
            cv.text('COLD STARTS', 1110, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(String(state.service.coldStarts), 1110, 150, 42, t.text, { font: 'num' });

            cv.text('HARD ABUSES', 1330, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            const hardColor = state.service.coldHardStarts > 5 ? RED : state.service.coldHardStarts > 0 ? YELLOW : GREEN;
            cv.text(String(state.service.coldHardStarts), 1330, 150, 42, hardColor, { font: 'num' });

            // Abuse Rating Badge
            const abuseRating = state.service.coldHardStarts === 0 ? 'NO ABUSE (EXCELLENT)'
                : state.service.coldHardStarts <= 3 ? 'LOW WEAR'
                : state.service.coldHardStarts <= 7 ? 'MODERATE ABUSE' : 'HIGH WEAR!';
            cv.text(`Rating: ${abuseRating}`, 1110, 190, 20, hardColor, { font: 'bold' });

            cv.fillRect(1110, 215, 442, 1.5, withAlpha('#ffffff', 0.15));

            // Real-Time Engine Sensors
            // live: the tracker's own view (fresh rpm, oil from CDS or the DME); demo: the simulated values
            const isRunning = d.demo ? d.rpm > 400 : engineOn === true;
            const oil = d.demo ? d.oil : temps().oil;
            const oilSrc = d.demo ? 'oil' : temps().src;
            cv.text('ENGINE STATE:', 1110, 255, 22, t.dim);
            const stateText = isRunning ? `RUNNING (${Math.round(d.rpm)} rpm)` : engineOn === null && !d.demo ? 'WAITING FOR DATA' : 'OFF (EV GLIDE)';
            cv.text(stateText, 1552, 255, 22, isRunning ? t.text : engineOn === null && !d.demo ? t.dim : GREEN, { font: 'bold', align: 'right' });

            cv.text(oilSrc === 'oil (DME)' ? 'ENGINE OIL TEMP (DME):' : 'ENGINE OIL TEMP:', 1110, 305, 22, t.dim);
            const oilColor = G.isNum(oil) ? (oil >= 75 ? GREEN : oil >= 50 ? YELLOW : BLUE) : t.dim;
            cv.text(G.isNum(oil) ? `${Math.round(oil)} °C` : oilSrc === 'coolant' ? 'n/a (using coolant)' : '--', 1552, 305, 24, oilColor, { font: 'bold', align: 'right' });

            cv.text('COOLANT TEMP:', 1110, 355, 22, t.dim);
            const coolColor = G.isNum(d.coolant) ? (d.coolant >= 80 ? GREEN : YELLOW) : t.dim;
            cv.text(G.isNum(d.coolant) ? `${Math.round(d.coolant)} °C` : '--', 1552, 355, 24, coolColor, { font: 'bold', align: 'right' });

            cv.text('CURRENT TORQUE:', 1110, 405, 22, t.dim);
            cv.text(G.isNum(d.torque) ? `${Math.round(d.torque)} Nm` : '--', 1552, 405, 24, t.text, { font: 'bold', align: 'right' });

            // Thermal status message
            const warm = G.isNum(oil) && oil >= 75;
            const warmMsg = warm ? 'Engine oil at operating temp (OK)' : `Engine warming up (keep load < ${Number(settings.get('hardTorque') || 150)} Nm)`;
            cv.text(warmMsg, 1110, 480, 20, warm ? GREEN : YELLOW);
        }

        function renderTripTab(cv, t, d) {
            // Tab 1: Current Trip Session
            G.panel(cv, t, 24, 44, 760, 468, 'Current Trip Telemetry');

            const tripTotalSec = state.trip.iceSec + state.trip.evSec;
            const tripEvPct = tripTotalSec > 0 ? Math.round((state.trip.evSec / tripTotalSec) * 100) : 0;
            const tripIcePct = 100 - tripEvPct;

            cv.text('TRIP ICE TIME', 56, 110, 20, t.dim, { font: 'bold' });
            cv.text(fmtHours(state.trip.iceSec), 56, 155, 48, t.text, { font: 'bold' });

            cv.text('TRIP EV TIME', 450, 110, 20, t.dim, { font: 'bold' });
            cv.text(fmtHours(state.trip.evSec), 450, 155, 48, BLUE, { font: 'bold' });

            // Distance
            const tripIceKm = (state.trip.iceMeters / 1000).toFixed(1);
            const tripEvKm = (state.trip.evMeters / 1000).toFixed(1);
            const tripTotalKm = (Number(tripIceKm) + Number(tripEvKm)).toFixed(1);

            cv.text('ICE Distance:', 56, 230, 24, t.dim);
            cv.text(`${tripIceKm} km`, 380, 230, 28, t.text, { font: 'bold', align: 'right' });

            cv.text('EV Distance:', 450, 230, 24, t.dim);
            cv.text(`${tripEvKm} km`, 750, 230, 28, BLUE, { font: 'bold', align: 'right' });

            cv.text('Total Trip Distance:', 56, 290, 26, t.dim);
            cv.text(`${tripTotalKm} km`, 750, 290, 32, t.text, { font: 'bold', align: 'right' });

            // Split bar
            cv.fillRect(56, 340, 694, 24, withAlpha(t.track, 0.8));
            const tripBarW = Math.round((tripEvPct / 100) * 694);
            if (tripBarW > 0) cv.fillRect(56, 340, tripBarW, 24, BLUE);
            if (694 - tripBarW > 0) cv.fillRect(56 + tripBarW, 340, 694 - tripBarW, 24, t.accent);

            cv.text(`${tripEvPct}% Pure Electric`, 56, 400, 24, BLUE, { font: 'bold' });
            cv.text(`${tripIcePct}% Petrol`, 750, 400, 24, t.text, { font: 'bold', align: 'right' });

            // Right Panel (Trip Events & Service History)
            G.panel(cv, t, 816, 44, 760, 468, 'Trip Events & Service History');

            cv.text('Trip Cold Starts:', 848, 110, 22, t.dim);
            cv.text(String(state.trip.coldStarts), 1540, 110, 24, t.text, { font: 'bold', align: 'right' });

            cv.text('Trip Hard Abuses:', 848, 150, 22, t.dim);
            cv.text(String(state.trip.coldHardStarts), 1540, 150, 24, state.trip.coldHardStarts > 0 ? RED : GREEN, { font: 'bold', align: 'right' });

            cv.fillRect(848, 190, 692, 1.5, withAlpha('#ffffff', 0.15));
            cv.text('RECENT SERVICE LOG', 848, 230, 22, t.accent, { font: 'bold', spacing: 1.5 });

            if (state.history.length === 0) {
                cv.text('No previous service logged yet.', 848, 280, 22, t.dim);
                cv.text('Press "Reset Oil Service" when you change the engine oil.', 848, 315, 20, t.dim);
            } else {
                state.history.slice(-3).reverse().forEach((h, idx) => {
                    const rowY = 275 + idx * 60;
                    cv.text(`${h.date}`, 848, rowY, 22, t.text, { font: 'bold' });
                    cv.text(`${h.iceHours}h ICE (${h.iceKm} km) · ${h.coldHardStarts} cold abuses`, 848, rowY + 26, 19, t.dim);
                });
            }
        }

        // Render loop: 2 FPS (smooth, low CPU)
        ctx.loop('MAIN', 2, render);
        render().then(() => ctx.log.info('Engine Care first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
