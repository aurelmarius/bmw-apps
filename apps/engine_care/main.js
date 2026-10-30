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

const W = 1600, H = 520;
const GREEN = '#2fd27a';
const BLUE = '#2a8cff';
const YELLOW = '#ffb020';
const RED = '#ef2b2d';

const KOMBI = 'de.bmw.infotainment.KombiInterface_2';
const COLORS = { DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 };

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

        const saveFile = path.join(dataDir, 'engine_care_state.json');

        // Initial default state - starts fresh on install
        let state = {
            service: {
                resetDate: Date.now(),
                resetCbsKm: null,
                iceSec: 0,
                evSec: 0,
                iceMeters: 0,
                evMeters: 0,
                coldStarts: 0,
                coldHardStarts: 0,
                thermalStressSec: 0,
            },
            trip: {
                iceSec: 0,
                evSec: 0,
                iceMeters: 0,
                evMeters: 0,
                coldStarts: 0,
                coldHardStarts: 0,
            },
            history: [],
        };

        // Cluster CBS state read directly from BMW instrument cluster
        let cbsOil = {
            available: false,
            name: 'Engine oil',
            way: '',
            date: '',
            color: GREEN,
        };

        function updateCbsBaseline(wayStr) {
            const km = parseKm(wayStr);
            if (km === null) return;
            const factoryInterval = Number(settings.get('factoryInterval') || 30000);
            if (state.service.resetCbsKm === null) {
                state.service.resetCbsKm = Math.max(km, factoryInterval);
                saveState();
            } else if (km > state.service.resetCbsKm) {
                // BMW cluster CBS was reset in the vehicle
                state.service.resetCbsKm = km;
                state.service.resetDate = Date.now();
                saveState();
            }
        }

        if (signals && typeof signals.watch === 'function') {
            signals.watch(KOMBI, '1', {
                cbsDataServiceList: (v) => {
                    const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
                    for (const e of arr) {
                        const s = find(e, 'cBSIdentifier') || {};
                        if (s.cBSIdentifier === 1) { // 1 = Engine oil
                            cbsOil.available = true;
                            cbsOil.name = txt(s.cBSServcieName || s.cBSServiceName) || 'Engine oil';
                            cbsOil.way = txt(s.cBSServiceWay);
                            cbsOil.date = txt(s.cBSServiceDate);
                            const col = colour(s.cBSColor);
                            cbsOil.color = col === 1 ? RED : (col === 2 || col === 4) ? YELLOW : GREEN;
                            if (log) log.info(`[Engine Care] CBS Oil from cluster: ${cbsOil.way}, date: ${cbsOil.date}`);
                            updateCbsBaseline(cbsOil.way);
                            break;
                        }
                    }
                },
                cbsDataSBA: (v) => {
                    if (v) {
                        const s = find(v, 'cBSDataSBAText') || v;
                        const sbaText = txt(s.cBSDataSBAText);
                        if (/oil|motor/i.test(sbaText)) {
                            cbsOil.available = true;
                            cbsOil.way = txt(s.cBSDataSBADistance) || cbsOil.way;
                            cbsOil.date = txt(s.cBSDataSBADate) || cbsOil.date;
                            const col = colour(s.cBSDataSBAColor);
                            cbsOil.color = col === 1 ? RED : (col === 2 || col === 4) ? YELLOW : GREEN;
                            updateCbsBaseline(cbsOil.way);
                        }
                    }
                },
            }, log);
        }

        // Load saved state
        try {
            if (fs.existsSync(saveFile)) {
                const loaded = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
                if (loaded && loaded.service) {
                    state = loaded;
                    if (state.service.resetCbsKm === undefined) {
                        state.service.resetCbsKm = null;
                    }
                }
            }
        } catch (e) {
            ctx.log.warn('Could not load engine_care state:', e.message);
        }

        let saveTimer = 0;
        function saveState() {
            try {
                fs.writeFileSync(saveFile, JSON.stringify(state, null, 2));
            } catch (e) {
                ctx.log.warn('Could not save engine_care state:', e.message);
            }
        }

        /* ---------- Telemetry Tracking ---------- */
        let prevRpm = 0;
        let lastT = 0;
        let coldStartActive = false;
        let alertMessage = null;
        let alertUntil = 0;
        let activeTab = 0; // 0 = Lifetime CBS, 1 = Trip Telemetry

        car.onSample((d, t) => {
            const dt = lastT ? Math.min(1.0, (t - lastT) / 1000) : 0.05;
            lastT = t;

            const rpm = d.rpm || 0;
            const speed = d.speed || 0;
            const oil = d.oil || 20;
            const torque = d.torque || 0;
            const coldThreshold = settings.get('coldThreshold') || 65;
            const hardTorque = settings.get('hardTorque') || 150;

            const isIceRunning = rpm > 400;

            // Detect engine start transition
            if (prevRpm <= 400 && isIceRunning) {
                if (oil < coldThreshold) {
                    state.service.coldStarts++;
                    state.trip.coldStarts++;
                    coldStartActive = true;
                }
            }

            // Check for Cold Hard Start Abuse (high torque or high RPM while engine oil is cold)
            if (isIceRunning && oil < coldThreshold && coldStartActive) {
                if (torque > hardTorque || rpm > 3200) {
                    state.service.coldHardStarts++;
                    state.trip.coldHardStarts++;
                    coldStartActive = false;
                    alertMessage = 'COLD HARD START! High torque under 65°C';
                    alertUntil = Date.now() + 8000;
                }
            }

            if (oil >= coldThreshold) {
                coldStartActive = false;
            }

            // Accumulate operating hours and distance
            if (isIceRunning) {
                state.service.iceSec += dt;
                state.trip.iceSec += dt;
                const m = (speed / 3.6) * dt;
                state.service.iceMeters += m;
                state.trip.iceMeters += m;
            } else if (speed > 3) {
                state.service.evSec += dt;
                state.trip.evSec += dt;
                const m = (speed / 3.6) * dt;
                state.service.evMeters += m;
                state.trip.evMeters += m;
            }

            if (isIceRunning && oil > 115) {
                state.service.thermalStressSec += dt;
            }

            prevRpm = rpm;

            // Save periodically every 15s
            if (Date.now() - saveTimer > 15000) {
                saveTimer = Date.now();
                saveState();
            }
        });

        /* ---------- Actions ---------- */
        ui.onClick('BTN_PAGE', () => {
            activeTab = (activeTab + 1) % 2;
            render();
        });

        ui.onClick('BTN_RESET', () => {
            const currentCbsKm = parseKm(cbsOil.way);
            const factoryInterval = Number(settings.get('factoryInterval') || 30000);

            // Archive current service
            state.history.push({
                date: new Date().toISOString().split('T')[0],
                iceHours: Number((state.service.iceSec / 3600).toFixed(1)),
                evHours: Number((state.service.evSec / 3600).toFixed(1)),
                iceKm: Math.round(state.service.iceMeters / 1000),
                evKm: Math.round(state.service.evMeters / 1000),
                coldHardStarts: state.service.coldHardStarts,
            });

            // Reset service counters & snapshot baseline
            state.service.resetDate = Date.now();
            state.service.resetCbsKm = currentCbsKm !== null ? currentCbsKm : factoryInterval;
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

        function parseKm(wayStr) {
            if (!wayStr) return null;
            const clean = String(wayStr).replace(/[^\d]/g, '');
            const n = parseInt(clean, 10);
            return isNaN(n) ? null : n;
        }

        function calculateOilHealth() {
            const maxH = Number(settings.get('maxHours') || 180);
            const targetKm = Number(settings.get('maxKm') || 10000);
            const targetMonths = Number(settings.get('maxMonths') || 12);
            const factoryInterval = Number(settings.get('factoryInterval') || 30000);

            const iceH = state.service.iceSec / 3600;
            const iceKm = state.service.iceMeters / 1000;

            // CBS Delta calculation:
            // Measures how many km have elapsed since the baseline snapshot was taken
            let cbsKmDriven = 0;
            const cbsWayNum = parseKm(cbsOil.way);
            if (cbsOil.available && cbsWayNum !== null) {
                const baseline = state.service.resetCbsKm !== null ? state.service.resetCbsKm : factoryInterval;
                cbsKmDriven = Math.max(0, baseline - cbsWayNum);
            }

            // Driven distance towards target:
            // Uses cluster CBS odometer delta if available, otherwise telemetry distance
            const effectiveDrivenKm = Math.max(iceKm, cbsKmDriven);

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
                targetKm,
                targetMonths,
                factoryInterval,
                cbsKmDriven,
                limitingFactor: kmRatio >= timeRatio ? 'km' : 'time',
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
            cv.text('BMW FACTORY CBS (LONG-LIFE 30,000 KM)', 64, 376, 17, t.dim, { font: 'bold', spacing: 1 });
            if (cbsOil.available && (cbsOil.way || cbsOil.date)) {
                const wayStr = cbsOil.way ? `${cbsOil.way}` : '';
                const dateStr = cbsOil.date ? `Due ${cbsOil.date}` : '';
                const fullStr = [wayStr, dateStr].filter(Boolean).join('  ·  ');
                cv.text(fullStr, 64, 406, 22, cbsOil.color, { font: 'bold' });
                cv.text('Official car schedule (30k is too long - 10k recommended)', 64, 428, 15, t.warn);
            } else {
                cv.text('Reading cluster CBS telemetry...', 64, 406, 20, t.dim);
            }

            cv.text(`Oil reset: ${c.daysSince}d ago (${c.effectiveDrivenKm.toLocaleString()} km driven)`, 48, 468, 17, t.dim);
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
            const totalKm = iceKm + evKm;

            cv.fillRect(562, 255, barW, 1.5, withAlpha('#ffffff', 0.15));

            cv.text('ICE Km:', 562, 295, 22, t.dim);
            cv.text(`${iceKm.toLocaleString()} km`, 720, 295, 24, t.text, { font: 'bold', align: 'right' });

            cv.text('EV Km:', 820, 295, 22, t.dim);
            cv.text(`${evKm.toLocaleString()} km`, 562 + barW, 295, 24, BLUE, { font: 'bold', align: 'right' });

            cv.text('Total Odometer:', 562, 345, 22, t.dim);
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
            const isRunning = d.rpm > 400;
            cv.text('ENGINE STATE:', 1110, 255, 22, t.dim);
            cv.text(isRunning ? `RUNNING (${Math.round(d.rpm)} rpm)` : 'OFF (EV GLIDE)', 1552, 255, 22, isRunning ? t.text : GREEN, { font: 'bold', align: 'right' });

            cv.text('ENGINE OIL TEMP:', 1110, 305, 22, t.dim);
            const oilColor = G.isNum(d.oil) ? (d.oil >= 75 ? GREEN : d.oil >= 50 ? YELLOW : BLUE) : t.dim;
            cv.text(G.isNum(d.oil) ? `${Math.round(d.oil)} °C` : '--', 1552, 305, 24, oilColor, { font: 'bold', align: 'right' });

            cv.text('COOLANT TEMP:', 1110, 355, 22, t.dim);
            const coolColor = G.isNum(d.coolant) ? (d.coolant >= 80 ? GREEN : YELLOW) : t.dim;
            cv.text(G.isNum(d.coolant) ? `${Math.round(d.coolant)} °C` : '--', 1552, 355, 24, coolColor, { font: 'bold', align: 'right' });

            cv.text('CURRENT TORQUE:', 1110, 405, 22, t.dim);
            cv.text(G.isNum(d.torque) ? `${Math.round(d.torque)} Nm` : '--', 1552, 405, 24, t.text, { font: 'bold', align: 'right' });

            // Thermal status message
            const warmMsg = G.isNum(d.oil) && d.oil >= 75 ? 'Engine oil at operating temp (OK)' : 'Engine warming up (keep load < 150 Nm)';
            cv.text(warmMsg, 1110, 480, 20, G.isNum(d.oil) && d.oil >= 75 ? GREEN : YELLOW);
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
