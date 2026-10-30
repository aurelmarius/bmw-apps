'use strict';
/**
 * Engine Care - PHEV B48 True Engine Health & CBS Oil Degradation Monitor
 * Built specifically for BMW G20 330e PHEV architecture:
 *   - Tracks actual ICE runtime hours vs EV glide hours
 *   - Detects Cold Hard Starts (electric overtaking kick-downs when engine oil < 65°C)
 *   - Counts short engine runs that stop before the oil is warm (fuel and water stay in the oil)
 *   - Splits engine starts by battery charge: the car had to, or it had charge left
 *   - Computes Real Oil Degradation Index (%) based on operating hours & thermal stress
 *   - Interactive Service Reset & History Logging
 *
 * The bookkeeping is in model.js (tested in tests/engine_care.test.js); this file reads the car and draws.
 * Sources: CDS / Vehicle2 / FES over SOME/IP (rpm, speed, temperatures, torque), the instrument
 * cluster's CBS (KombiInterface_2), and UDS over the head unit's diagnostic link (TASU) for what the
 * bus doesn't carry: oil temperature when CDS sends none, the distance counter, the battery charge.
 * Setting "Diagnostics page" shows all of it raw; "Record drive data" writes a log that
 * tools/replay_engine_care.js plays back through the model.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { fitText } = require('./kit/text-layout');
const M = require('./model');

const W = 1600, H = 520;
const GREEN = '#2fd27a';
const BLUE = '#2a8cff';
const YELLOW = '#ffb020';
const RED = '#ef2b2d';
const LEVEL = { ok: GREEN, warn: YELLOW, crit: RED };

const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const COLORS = { DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 };

const TICK_MS = 1000;                // runtime / distance are added up on this clock
const LIVE_MS = 60000;               // the car counts as there while it sent anything this recently
const CONFIRM_MS = 5000;             // "Reset Oil Service" needs a second press within this
const SAVE_MS = 15000;
/**
 * Values read with UDS (kit/dids candidates; the first that answers plausibly wins). app.json
 * config.uds overrides a list. Default ecu: the engine unit (DME, 0x12).
 */
const UDS = {
    ecu: 0x12,
    // engine oil temperature when CDS sends none - as Car Vitals
    oil: [
        { obd: '5C', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 170 },
        { did: 'F45C', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 170 },
    ],
    // distance driven: OBD PID A6 odometer (0.1 km), else PID 31 distance since the fault memory
    // was cleared (1 km; back to 0 after a clear - only its increases are used, see model onOdo)
    odo: [
        { obd: 'A6', bytes: 4, at: 0, factor: 0.1, offset: 0, min: 1, max: 2000000 },
        { did: 'F4A6', bytes: 4, at: 0, factor: 0.1, offset: 0, min: 1, max: 2000000 },
        { obd: '31', bytes: 2, at: 0, factor: 1, offset: 0, min: 0, max: 65535 },
        { did: 'F431', bytes: 2, at: 0, factor: 1, offset: 0, min: 0, max: 65535 },
    ],
    // high-voltage battery charge: the battery unit (SME, ecu 7) as eDrive reads it on the X5 45e,
    // else the standard OBD PID 5B (hybrid battery pack remaining, 100/255 %)
    soc: [
        { ecu: 7, did: 'DDBC', bytes: 2, at: 0, factor: 0.1, offset: 0, min: 0, max: 100 },
        { ecu: 0x12, obd: '5B', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100 },
        { ecu: 7, obd: '5B', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100 },
    ],
};
const OIL_WAIT_MS = 30000;           // no CDS oil temperature this long after the car answered: ask the DME
const OIL_POLL_MS = 15000;
const OIL_FRESH_MS = 60000;
const ODO_POLL_MS = 60000;
const SOC_POLL_MS = 30000;
const SOC_FRESH_MS = 120000;
const LOG_FILE = 'engine_care_drive.jsonl';
const LOG_FLUSH_MS = 30000;
const LOG_MAX_BYTES = 5e6;           // then the log becomes .1 (the one before is dropped)
const EV_TORQUE_NM = 30;             // torque above this with the engine off: the signal includes the e-motor

function find(v, key, str) {
    if (!v || typeof v !== 'object') return null;
    if (key in v && (!str || typeof v[key] === 'string')) return v;
    for (const k of Object.keys(v)) { const r = find(v[k], key, str); if (r) return r; }
    return null;
}
const colour = (c) => (typeof c === 'number' ? c : COLORS[String(c)] !== undefined ? COLORS[String(c)] : 0);
const txt = (s) => String(s === undefined || s === null ? '' : s).replace(/[^\x20-\x7e]/g, (ch) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' }[ch] || '')).trim();
/** JSON without the item icons (each CBS answer carries a PNG as a long list of byte numbers) */
const brief = (v) => JSON.stringify(v, (k, x) => (k === 'symbolData' ? '[icon]' : x));
const ageText = (ms) => (!isFinite(ms) ? 'never' : ms < 1000 ? 'now' : ms < 120000 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60000) + ' min');
const fmtNum = (v, dp, unit) => (M.isNum(v) ? v.toFixed(dp) + (unit || '') : '--');

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, signals, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque']);
        const userUds = (ctx.spec.config && ctx.spec.config.uds) || {};
        const uds = Object.assign({}, UDS, userUds);

        /** a number setting; 0 is a value (only a missing one takes the default) */
        const num = (k, d) => { const v = settings.get(k); return v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v); };
        const cfg = () => ({
            coldThreshold: num('coldThreshold', 65), hardTorque: num('hardTorque', 150),
            warmTarget: num('warmTarget', 90), shortCycleH: num('shortCycleH', 1), socReserve: num('socReserve', 15),
            maxKm: num('maxKm', 10000), maxMonths: num('maxMonths', 12), maxHours: num('maxHours', 180),
        });

        let alertMessage = null, alertUntil = 0;
        const alert = (text, ms) => { alertMessage = text; alertUntil = Date.now() + ms; };

        const saveFile = path.join(dataDir, 'engine_care_state.json');
        const tracker = new M.Tracker(M.loadState(saveFile, log), { log, cfg, onAlert: alert });
        // demo: the same bookkeeping on the simulated drive, in memory only - never saved, never mixed in
        let demoTracker = null;
        let lastSave = 0;
        function save() {
            try {
                M.saveState(saveFile, tracker.state);
                tracker.dirty = false;
                lastSave = Date.now();
            } catch (e) {
                log.warn('Could not save engine_care state: ' + e.message);
            }
        }

        /* ---------- BMW CBS (instrument cluster) ----------
         * Shown as the car says it, never used as a distance: BMW's oil countdown is condition based
         * (fuel burnt, cold starts, driving style) and doesn't go down 1 km per km driven. */
        const cbsOil = {
            available: false,
            fromList: false,        // the service list had an oil item (the summary is only a fallback)
            name: 'Engine oil',
            way: '',
            km: null,               // signed km left (< 0 = overdue), null = no distance
            date: '',
            color: GREEN,
        };
        let cbsRaw = { list: '', sba: '', t: 0 }, kombi = null;
        function setCbs(way, date, col) {
            cbsOil.available = true;
            cbsOil.way = txt(way);
            cbsOil.km = M.parseDistance(way);
            cbsOil.date = txt(date);
            const c = colour(col);
            cbsOil.color = c === 1 || (cbsOil.km !== null && cbsOil.km < 0) ? RED : (c === 2 || c === 4) ? YELLOW : GREEN;
        }
        signals.watch(KOMBI, '1', {
            cbsDataServiceList: (v) => {
                cbsRaw.list = brief(v); cbsRaw.t = Date.now();
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
                cbsRaw.sba = brief(v); cbsRaw.t = Date.now();
                if (!v || cbsOil.fromList) return;
                const s = find(v, 'cBSDataSBAText') || v;
                // the next service, in the car's language ("Engine oil", "Motoroel", "Ulei de motor")
                if (/oil|motor|oel/i.test(txt(s.cBSDataSBAText))) setCbs(s.cBSDataSBADistance, s.cBSDataSBADate, s.cBSDataSBAColor);
            },
        }, log, { pollMs: 60000 }).then((r) => { kombi = r; });   // some clusters don't notify these: read them every minute

        /* ---------- UDS: one request at a time over one diagnostic link ---------- */
        let link = null, rd = null, udsQueue = Promise.resolve(), firstLive = 0;
        function udsRead(name, list) {
            const run = async () => {
                if (!rd) {
                    link = new Diag(signals, log);
                    link.quiet = true;
                    await link.init();
                    rd = new DidReader(link, { ecu: uds.ecu });
                }
                const v = await rd.value(name, list);
                return { v, src: v === null ? null : DidReader.label(list[rd.pick[name] || 0]) };
            };
            const p = udsQueue.then(run, run);
            udsQueue = p.catch(() => {});
            return p;
        }
        const carAwake = (now) => firstLive && now - car.lastCar < LIVE_MS;

        // engine oil temperature: CDS (statusEngineTemperature); some cars send none there (invalid 255)
        let dmeOil = null;               // { value, t }
        let oilBusy = false, oilAskT = 0;
        const cdsOil = () => (M.isNum(car.live.oil) ? car.live.oil : null);
        function pollOil(now) {
            if (oilBusy || now - oilAskT < OIL_POLL_MS || cdsOil() !== null) return;
            if (!carAwake(now) || now - firstLive < OIL_WAIT_MS) return;
            if (!oilAskT) log.info('no oil temperature from CDS: reading it from the engine unit');
            oilAskT = now; oilBusy = true;
            udsRead('oil', uds.oil).then(({ v }) => { if (v !== null) dmeOil = { value: v, t: Date.now() }; })
                .catch((e) => log.warn('DME oil: ' + e)).then(() => { oilBusy = false; });
        }
        /** { oil, src }: engine oil temperature (CDS, else the engine unit) for showing; src null = none */
        function oilNow() {
            const c = cdsOil();
            if (c !== null) return { oil: c, src: 'CDS' };
            if (dmeOil && Date.now() - dmeOil.t < OIL_FRESH_MS) return { oil: dmeOil.value, src: 'DME' };
            return { oil: null, src: M.isNum(car.live.coolant) ? 'coolant' : null };
        }

        // distance counter, once a minute (only its increases count: model onOdo)
        let odoBusy = false, odoAskT = 0, odoFails = 0, odoEvent = null;
        function pollOdo(now) {
            if (odoBusy || now - odoAskT < ODO_POLL_MS * Math.min(10, 1 + odoFails) || !carAwake(now)) return;
            odoAskT = now; odoBusy = true;
            udsRead('odo', uds.odo).then(({ v, src }) => {
                if (v === null) { if (++odoFails === 3) log.warn('no distance from the engine unit: estimating it from the speed'); return; }
                odoFails = 0;
                tracker.onOdo(src, v);
                odoEvent = [src, v];
            }).catch((e) => log.warn('DME distance: ' + e)).then(() => { odoBusy = false; });
        }

        // battery charge, every 30 s: splits engine starts into "had to" (at the reserve) and "had charge left"
        let soc = null, socBusy = false, socAskT = 0, socFails = 0;
        function pollSoc(now) {
            if (socBusy || now - socAskT < SOC_POLL_MS * Math.min(10, 1 + socFails) || !carAwake(now)) return;
            socAskT = now; socBusy = true;
            udsRead('soc', uds.soc).then(({ v, src }) => {
                if (v === null) { if (++socFails === 3) log.warn('no battery charge from the car: engine starts are not split by charge'); return; }
                socFails = 0;
                soc = { value: v, t: Date.now(), src };
            }).catch((e) => log.warn('battery charge: ' + e)).then(() => { socBusy = false; });
        }
        const socNow = () => (soc && Date.now() - soc.t < SOC_FRESH_MS ? soc.value : null);

        /* ---------- Drive log (setting "Record drive data") ----------
         * One line a second while the car is there: what the model gets, for tools/replay_engine_care.js. */
        const logFile = path.join(dataDir, LOG_FILE);
        let logBuf = [], logFlushT = 0;
        const age = (ms) => (isFinite(ms) ? Math.round(ms) : null);
        function logSample(s) {
            if (settings.get('logDrive') !== true) { logBuf = []; return; }
            const row = { t: s.now, rpm: s.rpm, rpmAge: age(s.rpmAge), speed: s.speed, speedAge: age(s.speedAge), oil: s.oil, coolant: s.coolant,
                torque: s.torque, torqueAge: age(s.torqueAge), soc: s.soc };
            if (odoEvent) { row.odo = odoEvent; odoEvent = null; }
            logBuf.push(JSON.stringify(row));
            if (s.now - logFlushT > LOG_FLUSH_MS) flushLog();
        }
        function flushLog() {
            logFlushT = Date.now();
            if (!logBuf.length) return;
            try {
                if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
                fs.appendFileSync(logFile, logBuf.join('\n') + '\n');
            } catch (e) {
                log.warn('drive log: ' + e.message);
            }
            logBuf = [];
        }
        process.on('exit', () => { flushLog(); if (tracker.dirty) save(); });

        /* ---------- The clock: one tick a second ---------- */
        let visible = null;              // the app's screen: null = not known yet
        ui.onVisible((name, on) => { if (name === 'MAIN') { visible = on; if (on) redraw(); } });
        function tick() {
            const now = Date.now(), d = car.data();
            if (d.demo) {
                tracker.pause();
                if (!demoTracker) demoTracker = new M.Tracker(M.freshState(now), { cfg, onAlert: alert });
                demoTracker.tick({ now, live: true, rpm: d.rpm, rpmAge: 0, speed: d.speed, speedAge: 0, oil: d.oil, coolant: d.coolant,
                    torque: d.torque, torqueAge: 0, soc: 55, visible });
                return;
            }
            demoTracker = null;
            const live = car.lastCar > 0 && now - car.lastCar < LIVE_MS;
            if (live && !firstLive) firstLive = now;
            const s = {
                now, live,
                rpm: car.live.rpm, rpmAge: car.age('rpm'),
                speed: car.live.speed, speedAge: car.age('speed'),
                oil: oilNow().oil, coolant: car.live.coolant,
                torque: car.live.torque, torqueAge: car.age('torque'),
                soc: socNow(), visible,
            };
            tracker.tick(s);
            if (live) logSample(s);
            if (tracker.dirty && now - lastSave > SAVE_MS) save();
            pollOil(now); pollOdo(now); pollSoc(now);
        }
        setInterval(tick, TICK_MS);

        /* ---------- Actions ---------- */
        let activeTab = 0; // 0 = Lifetime CBS, 1 = Trip Telemetry, 2 = Diagnostics (setting)
        let resetArmed = 0;
        const pages = () => (settings.get('diagPage') === true ? ['Oil Health & CBS', 'PHEV Trip Split', 'Diagnostics'] : ['Oil Health & CBS', 'PHEV Trip Split']);

        ui.onClick('BTN_PAGE', () => {
            activeTab = (activeTab + 1) % pages().length;
            resetArmed = 0;
            redraw();
        });
        if (ctx.onTab) ctx.onTab((i) => { activeTab = i; resetArmed = 0; redraw(); });

        // first press arms the reset, a second one within 5 s does it
        ui.onClick('BTN_RESET', () => {
            if (car.data().demo) { alert('No reset in demo mode', 4000); redraw(); return; }
            if (Date.now() - resetArmed > CONFIRM_MS) {
                resetArmed = Date.now();
                alert('Press "Reset Oil Service" again to confirm (5 s)', CONFIRM_MS);
                redraw();
                return;
            }
            resetArmed = 0;
            tracker.resetService(Date.now());
            save();
            alert('OIL SERVICE RESET COMPLETE', 5000);
            redraw();
        });

        /* ---------- Helpers ---------- */
        function fmtHours(sec) {
            const totalMin = Math.round(sec / 60);
            const hrs = Math.floor(totalMin / 60);
            const mins = totalMin % 60;
            return `${hrs}h ${mins < 10 ? '0' : ''}${mins}m`;
        }
        /** what the screen shows: the simulated drive in demo, else the car */
        const view = (d) => (d.demo && demoTracker ? demoTracker : tracker);

        /* ---------- Rendering ---------- */
        // drawn only when something on the screen changed (key), or when asked (redraw)
        let lastKey = '', forced = true;
        function redraw() { forced = true; }
        settings.onChange(redraw);

        function screenKey(d, tr, c) {
            const now = Date.now(), o = oilNow();
            const r = (v, step) => (M.isNum(v) ? Math.round(v / step) : null);
            return JSON.stringify([
                activeTab, pages().length, d.demo, alertMessage && now < alertUntil ? alertMessage : null,
                tr.engineOn, r(d.rpm, 10), r(o.oil, 1), r(d.coolant, 1), r(d.torque, 1), r(socNow(), 1),
                c.lifePct, c.remKm, c.remDays, c.effectiveDrivenKm,
                Math.round(tr.state.service.iceSec / 60), Math.round(tr.state.service.evSec / 60),
                Math.round(tr.state.trip.iceSec / 60), Math.round(tr.state.trip.evSec / 60),
                Math.round(tr.state.trip.iceMeters / 100), Math.round(tr.state.trip.evMeters / 100),
                tr.state.service.coldStarts, tr.state.service.coldHardStarts, tr.state.service.shortCycles, tr.state.history.length,
                cbsOil.way, cbsOil.date, cbsOil.color,
                activeTab === 2 ? Math.floor(now / 1000) : 0,          // the diagnostics page shows ages
            ]);
        }

        function render() {
            const t = ctx.theme();
            const d = car.data();
            const tr = view(d);
            const c = M.oilHealth(tr.state, cfg(), Date.now());
            const pg = pages();
            if (activeTab >= pg.length) activeTab = 0;
            const key = screenKey(d, tr, c);
            if (!forced && key === lastKey) return Promise.resolve();
            forced = false; lastKey = key;

            const cv = ctx.canvas(W, H).clear(t.bg);
            const badges = [
                d.demo && { text: 'DEMO' },
                alertMessage && Date.now() < alertUntil && { text: alertMessage, color: 'warn' },
            ];
            G.frame(cv, t, pg, activeTab, badges);

            if (activeTab === 0) renderLifetimeTab(cv, t, d, c, tr);
            else if (activeTab === 1) renderTripTab(cv, t, tr);
            else renderDiagTab(cv, t, d, tr);

            return ui.image('MAIN_GFX', cv);
        }

        function renderLifetimeTab(cv, t, d, c, tr) {
            const sv = tr.state.service;
            const col = LEVEL[c.level];
            // Panel 1 (Left): Optimal Oil Care (10k km / 12 mo)
            G.panel(cv, t, 24, 44, 490, 468, 'Recommended Oil Care');

            // Big Health Percentage
            cv.text(String(c.lifePct), 48, 175, 110, col, { font: 'num' });
            cv.text('%', 52 + cv.textWidth(String(c.lifePct), 110, { font: 'num' }), 175, 42, t.dim, { font: 'bold' });
            cv.text(c.status, 480, 115, 24, col, { font: 'bold', align: 'right' });

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
                cv.text(fitText(cv, fullStr, 22, 410, { font: 'bold' }), 64, 406, 22, cbsOil.color, { font: 'bold' });
                // BMW's condition-based countdown next to this app's target
                const diff = cbsOil.km !== null ? cbsOil.km - c.remKm : null;
                const cmp = diff === null ? 'BMW gives a date only'
                    : diff > 500 ? `BMW allows ${diff.toLocaleString()} km more than your target`
                        : diff < -500 ? `BMW wants it ${(-diff).toLocaleString()} km sooner than your target`
                            : 'BMW and your target agree';
                cv.text(fitText(cv, cmp, 15, 410), 64, 428, 15, diff !== null && diff < -500 ? RED : t.warn);
            } else {
                cv.text('Waiting for the instrument cluster...', 64, 406, 20, t.dim);
            }

            const kmNote = c.drivenSrc === 'speed' ? ' km driven, est. from speed' : ' km driven';
            cv.text(fitText(cv, `Oil reset: ${c.daysSince}d ago (${c.effectiveDrivenKm.toLocaleString()}${kmNote})`, 17, 442), 48, 468, 17, t.dim);
            cv.text(`Target: ${c.targetKm.toLocaleString()} km / ${c.targetMonths} mo`, 48, 492, 17, t.dim);
            cv.text('Reset Oil Service', 480, 492, 18, t.accent, { align: 'right' });

            // Panel 2 (Center): PHEV Runtime & Distance Split
            G.panel(cv, t, 538, 44, 524, 468, 'PHEV Runtime Split');

            const totalSec = sv.iceSec + sv.evSec;
            const hasSplit = totalSec >= 1;
            const evRatio = hasSplit ? Math.round((sv.evSec / totalSec) * 100) : null;

            // Runtime Breakdown Cards
            cv.text('ICE RUNTIME (B48)', 562, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(fmtHours(sv.iceSec), 562, 150, 42, t.text, { font: 'bold' });

            cv.text('ELECTRIC GLIDE', 830, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(fmtHours(sv.evSec), 830, 150, 42, BLUE, { font: 'bold' });

            // Split Bar (grey until something was counted)
            const barY = 175;
            const barW = 476;
            cv.fillRect(562, barY, barW, 20, withAlpha(t.track, 0.8));
            if (hasSplit) {
                const evBarW = Math.round((evRatio / 100) * barW);
                if (evBarW > 0) cv.fillRect(562, barY, evBarW, 20, BLUE);
                if (barW - evBarW > 0) cv.fillRect(562 + evBarW, barY, barW - evBarW, 20, t.accent);
            }
            cv.text(hasSplit ? `${evRatio}% EV Mode` : '-- EV Mode', 562, barY + 44, 22, BLUE, { font: 'bold' });
            cv.text(hasSplit ? `${100 - evRatio}% Petrol Engine` : '-- Petrol Engine', 562 + barW, barY + 44, 22, t.text, { font: 'bold', align: 'right' });

            // Distance Breakdown
            const iceKm = Math.round(sv.iceMeters / 1000);
            const evKm = Math.round(sv.evMeters / 1000);
            const totalKm = c.effectiveDrivenKm;

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
            if (hasSplit) {
                cv.text(`${evRatio}% pure electric driving saved`, 578, 415, 22, BLUE, { font: 'bold' });
                cv.text(`${evKm.toLocaleString()} km of wear on your B48 petrol engine!`, 578, 442, 20, t.text);
            } else {
                cv.text('Nothing counted yet', 578, 415, 22, BLUE, { font: 'bold' });
                cv.text('The split fills in as you drive', 578, 442, 20, t.dim);
            }
            cv.text(`Wear from starts & heat: +${c.penaltyH.toFixed(1)} h on top of ${c.iceH.toFixed(1)} h run`, 562, 490, 17, t.dim);

            // Panel 3 (Right): Cold Starts & Engine Thermals
            G.panel(cv, t, 1086, 44, 490, 468, 'Cold Starts & Thermals');

            const hardColor = sv.coldHardStarts > 5 ? RED : sv.coldHardStarts > 0 ? YELLOW : GREEN;
            const shortColor = sv.shortCycles > 10 ? RED : sv.shortCycles > 0 ? YELLOW : GREEN;
            cv.text('COLD STARTS', 1110, 108, 17, t.dim, { font: 'bold', spacing: 1 });
            cv.text(String(sv.coldStarts), 1110, 148, 42, t.text, { font: 'num' });
            cv.text('HARD LOAD', 1265, 108, 17, t.dim, { font: 'bold', spacing: 1 });
            cv.text(String(sv.coldHardStarts), 1265, 148, 42, hardColor, { font: 'num' });
            cv.text('NOT WARMED', 1410, 108, 17, t.dim, { font: 'bold', spacing: 1 });
            cv.text(String(sv.shortCycles), 1410, 148, 42, shortColor, { font: 'num' });

            // Abuse Rating Badge: hard starts and runs that never warmed the oil
            const bad = sv.coldHardStarts + sv.shortCycles / 3;
            const abuseRating = bad === 0 ? 'NO ABUSE (EXCELLENT)' : bad <= 3 ? 'LOW WEAR' : bad <= 7 ? 'MODERATE ABUSE' : 'HIGH WEAR!';
            const ratingColor = bad === 0 ? GREEN : bad <= 3 ? YELLOW : RED;
            cv.text(`Rating: ${abuseRating}`, 1110, 182, 20, ratingColor, { font: 'bold' });
            const known = sv.startsLowSoc + sv.startsWithCharge;
            const socLine = known ? `${sv.coldStartsWithCharge} cold starts had battery charge left` : 'Battery charge at engine starts: not known';
            cv.text(fitText(cv, socLine, 16, 442), 1110, 206, 16, t.dim);

            cv.fillRect(1110, 218, 442, 1.5, withAlpha('#ffffff', 0.15));

            // Real-Time Engine Sensors
            // live: the tracker's own view (fresh rpm, oil from CDS or the DME); demo: the simulated values
            const isRunning = tr.engineOn === true;
            const o = d.demo ? { oil: d.oil, src: 'CDS' } : oilNow();
            const rows = [
                ['ENGINE STATE:', isRunning ? `RUNNING (${Math.round(d.rpm)} rpm)` : tr.engineOn === null ? 'WAITING FOR DATA' : 'OFF (EV GLIDE)',
                    isRunning ? t.text : tr.engineOn === null ? t.dim : GREEN],
                [o.src === 'DME' ? 'ENGINE OIL TEMP (DME):' : 'ENGINE OIL TEMP:',
                    M.isNum(o.oil) ? `${Math.round(o.oil)} °C` : o.src === 'coolant' ? 'n/a (using coolant)' : '--',
                    M.isNum(o.oil) ? (o.oil >= 75 ? GREEN : o.oil >= 50 ? YELLOW : BLUE) : t.dim],
                ['COOLANT TEMP:', M.isNum(d.coolant) ? `${Math.round(d.coolant)} °C` : '--', M.isNum(d.coolant) ? (d.coolant >= 80 ? GREEN : YELLOW) : t.dim],
                ['CURRENT TORQUE:', M.isNum(d.torque) ? `${Math.round(d.torque)} Nm` : '--', t.text],
                ['HV BATTERY:', d.demo ? '55 %' : M.isNum(socNow()) ? `${Math.round(socNow())} %` : '--', BLUE],
            ];
            rows.forEach(([label, value, vc], i) => {
                const y = 254 + i * 44;
                cv.text(label, 1110, y, 21, t.dim);
                cv.text(value, 1552, y, 23, vc, { font: 'bold', align: 'right' });
            });

            // Thermal status message
            const warm = M.isNum(o.oil) && o.oil >= 75;
            const warmMsg = warm ? 'Engine oil at operating temp (OK)' : `Engine warming up (keep load < ${cfg().hardTorque} Nm)`;
            cv.text(warmMsg, 1110, 490, 20, warm ? GREEN : YELLOW);
        }

        function renderTripTab(cv, t, tr) {
            const trip = tr.state.trip, history = tr.state.history;
            // Tab 1: Current Trip Session
            G.panel(cv, t, 24, 44, 760, 468, 'Current Trip Telemetry');

            const tripTotalSec = trip.iceSec + trip.evSec;
            const hasSplit = tripTotalSec >= 1;
            const tripEvPct = hasSplit ? Math.round((trip.evSec / tripTotalSec) * 100) : null;

            cv.text('TRIP ICE TIME', 56, 110, 20, t.dim, { font: 'bold' });
            cv.text(fmtHours(trip.iceSec), 56, 155, 48, t.text, { font: 'bold' });

            cv.text('TRIP EV TIME', 450, 110, 20, t.dim, { font: 'bold' });
            cv.text(fmtHours(trip.evSec), 450, 155, 48, BLUE, { font: 'bold' });

            // Distance
            const tripIceKm = (trip.iceMeters / 1000).toFixed(1);
            const tripEvKm = (trip.evMeters / 1000).toFixed(1);
            const tripTotalKm = (Number(tripIceKm) + Number(tripEvKm)).toFixed(1);

            cv.text('ICE Distance:', 56, 230, 24, t.dim);
            cv.text(`${tripIceKm} km`, 380, 230, 28, t.text, { font: 'bold', align: 'right' });

            cv.text('EV Distance:', 450, 230, 24, t.dim);
            cv.text(`${tripEvKm} km`, 750, 230, 28, BLUE, { font: 'bold', align: 'right' });

            cv.text('Total Trip Distance:', 56, 290, 26, t.dim);
            cv.text(`${tripTotalKm} km`, 750, 290, 32, t.text, { font: 'bold', align: 'right' });

            // Split bar (grey until something was counted)
            cv.fillRect(56, 340, 694, 24, withAlpha(t.track, 0.8));
            if (hasSplit) {
                const tripBarW = Math.round((tripEvPct / 100) * 694);
                if (tripBarW > 0) cv.fillRect(56, 340, tripBarW, 24, BLUE);
                if (694 - tripBarW > 0) cv.fillRect(56 + tripBarW, 340, 694 - tripBarW, 24, t.accent);
            }
            cv.text(hasSplit ? `${tripEvPct}% Pure Electric` : '-- Pure Electric', 56, 400, 24, BLUE, { font: 'bold' });
            cv.text(hasSplit ? `${100 - tripEvPct}% Petrol` : '-- Petrol', 750, 400, 24, t.text, { font: 'bold', align: 'right' });
            const started = new Date(trip.start || Date.now());
            cv.text(`Trip since ${started.toISOString().slice(0, 16).replace('T', ' ')} UTC  ·  a new trip starts after 15 min without the car`, 56, 480, 17, t.dim);

            // Right Panel (Trip Events & Service History)
            G.panel(cv, t, 816, 44, 760, 468, 'Trip Events & Service History');

            const tripRows = [
                ['Trip Engine Starts:', String(trip.iceStarts || 0), t.text],
                ['Trip Cold Starts:', String(trip.coldStarts), t.text],
                ['Trip Hard Abuses:', String(trip.coldHardStarts), trip.coldHardStarts > 0 ? RED : GREEN],
                ['Trip Runs Not Warmed:', String(trip.shortCycles || 0), trip.shortCycles > 0 ? YELLOW : GREEN],
            ];
            tripRows.forEach(([label, value, vc], i) => {
                cv.text(label, 848, 118 + i * 34, 22, t.dim);
                cv.text(value, 1540, 118 + i * 34, 24, vc, { font: 'bold', align: 'right' });
            });

            cv.fillRect(848, 240, 692, 1.5, withAlpha('#ffffff', 0.15));
            cv.text('RECENT SERVICE LOG', 848, 278, 22, t.accent, { font: 'bold', spacing: 1.5 });

            if (history.length === 0) {
                cv.text('No previous service logged yet.', 848, 325, 22, t.dim);
                cv.text('Press "Reset Oil Service" when you change the engine oil.', 848, 360, 20, t.dim);
            } else {
                history.slice(-3).reverse().forEach((h, idx) => {
                    const rowY = 318 + idx * 62;
                    cv.text(`${h.date}${M.isNum(h.km) ? '  ·  ' + h.km.toLocaleString() + ' km' : ''}`, 848, rowY, 22, t.text, { font: 'bold' });
                    cv.text(`${h.iceHours}h ICE (${h.iceKm} km) · ${h.coldHardStarts} cold abuses${M.isNum(h.shortCycles) ? ' · ' + h.shortCycles + ' not warmed' : ''}`, 848, rowY + 26, 19, t.dim);
                });
            }
        }

        /** Everything the app gets from the car, raw: for checking a car (setting "Diagnostics page"). */
        function renderDiagTab(cv, t, d, tr) {
            const now = Date.now();
            const dg = tr.state.diag;
            // left: the bus signals
            G.panel(cv, t, 24, 44, 760, 468, 'Signals (SOME/IP)');
            const src = d.demo ? 'DEMO (simulated, nothing saved)' : car.lastCar ? (now - car.lastCar < LIVE_MS ? 'LIVE' : 'car quiet ' + ageText(now - car.lastCar)) : 'waiting for the car';
            cv.text('Data: ' + src, 48, 114, 20, d.demo ? t.warn : t.text, { font: 'bold' });
            const sig = [
                ['rpm', fmtNum(car.live.rpm, 0), car.age('rpm')],
                ['speed', fmtNum(car.live.speed, 1, ' km/h'), car.age('speed')],
                ['oil (CDS)', fmtNum(car.live.oil, 0, ' °C'), car.age('oil')],
                ['coolant', fmtNum(car.live.coolant, 0, ' °C'), car.age('coolant')],
                ['torque', fmtNum(car.live.torque, 0, ' Nm'), car.age('torque')],
            ];
            sig.forEach(([name, v, a], i) => {
                const y = 170 + i * 28;
                cv.text(name, 48, y, 19, t.dim);
                cv.text(v, 400, y, 19, t.text, { align: 'right', font: 'bold' });
                cv.text(ageText(a), 560, y, 19, isFinite(a) && a < 5000 ? GREEN : t.dim, { align: 'right' });
            });
            cv.text('value', 400, 144, 15, t.dim, { align: 'right' });
            cv.text('last sent', 560, 144, 15, t.dim, { align: 'right' });
            const o = oilNow();
            const lines = [
                ['Engine (model)', tr.engineOn === null ? 'not known' : tr.engineOn ? 'running' : 'off', t.text],
                ['Cold check uses', o.src === 'CDS' ? 'oil (CDS)' : o.src === 'DME' ? 'oil (engine unit)' : o.src === 'coolant' ? 'coolant (no oil temp)' : 'nothing yet', o.src === 'coolant' ? t.warn : t.text],
                ['Counting with screen closed', dg.countedSec < 60 ? 'not seen yet' : dg.hiddenSec > 0 ? `yes (${fmtHours(dg.hiddenSec)} of ${fmtHours(dg.countedSec)})` : `no (0 of ${fmtHours(dg.countedSec)})`,
                    dg.countedSec >= 60 && dg.hiddenSec === 0 ? t.warn : t.text],
                ['Torque with engine off', dg.torqueEvSec < 10 ? 'not seen yet' : `max ${Math.round(dg.torqueEvMax || 0)} Nm -> ${dg.torqueEvMax > EV_TORQUE_NM ? 'includes the e-motor' : 'engine only'}`,
                    dg.torqueEvSec >= 10 && dg.torqueEvMax > EV_TORQUE_NM ? t.warn : t.text],
            ];
            lines.forEach(([name, v, vc], i) => {
                const y = 326 + i * 34;
                cv.text(name, 48, y, 19, t.dim);
                cv.text(fitText(cv, v, 19, 470, { font: 'bold' }), 760, y, 19, vc, { align: 'right', font: 'bold' });
            });
            cv.text('Store: ' + (d.demo ? 'demo, nothing saved' : tracker.dirty ? 'changes not saved yet' : lastSave ? 'saved ' + ageText(now - lastSave) + ' ago' : 'nothing to save yet') + (settings.get('logDrive') === true ? '  ·  recording drive data' : ''), 48, 490, 17, t.dim);

            // right: the engine unit (UDS) and the cluster's CBS
            G.panel(cv, t, 816, 44, 760, 468, 'Engine unit (UDS) & CBS');
            const linkTxt = !link ? 'not opened yet' : link.error ? 'error: ' + link.error : link.available ? 'available' : 'not available';
            cv.text('Diagnostic link: ' + linkTxt, 848, 114, 20, link && link.error ? RED : t.text, { font: 'bold' });
            let y = 144;
            const udsRows = [['oil temp', 'oil', uds.oil], ['distance', 'odo', uds.odo], ['battery', 'soc', uds.soc]];
            udsRows.forEach(([title, name, list]) => {
                const picked = rd && rd.pick[name] !== undefined ? DidReader.label(list[rd.pick[name]]) : null;
                cv.text(title + (picked ? ' - using ' + picked : ''), 848, y, 18, t.text, { font: 'bold' });
                y += 22;
                list.forEach((cand) => {
                    const r = rd && rd.raws[rd.key(cand)];
                    const what = !r ? 'not asked' : r.ok ? fmtNum(r.value, 1) + '  [' + r.bytes.split(' ').slice(0, 8).join(' ') + ']' : r.why;
                    cv.text(`${(cand.ecu == null ? uds.ecu : cand.ecu).toString(16).toUpperCase()}:${DidReader.label(cand)}  ${what}`.slice(0, 80), 870, y, 15, r && r.ok ? GREEN : t.dim, { font: 'label' });
                    y += 18;
                });
                y += 4;
            });
            const sv = tracker.state.service;
            cv.text(`Distance: ${sv.odoLast ? sv.odoLast.src + ' ' + sv.odoLast.km + ' km' : 'no reading yet'}  ·  battery ${soc ? Math.round(soc.value) + ' % (' + ageText(now - soc.t) + ')' : '--'}`, 848, y + 4, 17, t.text);
            y += 30;
            cv.text(`CBS (${kombi ? (kombi.error ? 'error' : kombi.available ? 'cluster available' : 'not available') : 'connecting'}): ` +
                (cbsOil.available ? `"${cbsOil.way}" -> ${cbsOil.km} km, due ${cbsOil.date || '--'}${cbsOil.fromList ? '' : ' (summary)'}` : 'nothing received'), 848, y, 17, t.text);
            y += 22;
            const raw = cbsRaw.list || cbsRaw.sba;
            for (let i = 0; i < raw.length && y < 500; i += 92) { cv.text(raw.slice(i, i + 92), 848, y, 14, t.dim, { font: 'label' }); y += 17; }
        }

        // Render loop: 2 FPS, drawn only when something changed
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('Engine Care first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
