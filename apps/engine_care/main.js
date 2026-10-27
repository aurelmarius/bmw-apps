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

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque']);

        const saveFile = path.join(dataDir, 'engine_care_state.json');

        // Initial default state with realistic baseline for BMW 330e
        let state = {
            service: {
                resetDate: Date.now() - 42 * 86400 * 1000, // 42 days ago
                iceSec: 32.5 * 3600, // 32.5 engine hours
                evSec: 74.2 * 3600,  // 74.2 EV driving hours
                iceMeters: 2140 * 1000, // 2,140 km on petrol engine
                evMeters: 4560 * 1000,  // 4,560 km in pure electric mode
                coldStarts: 24,
                coldHardStarts: 3,
                thermalStressSec: 180,
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

        // Load saved state
        try {
            if (fs.existsSync(saveFile)) {
                const loaded = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
                if (loaded && loaded.service) state = loaded;
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
            // Archive current service
            state.history.push({
                date: new Date().toISOString().split('T')[0],
                iceHours: Number((state.service.iceSec / 3600).toFixed(1)),
                evHours: Number((state.service.evSec / 3600).toFixed(1)),
                iceKm: Math.round(state.service.iceMeters / 1000),
                evKm: Math.round(state.service.evMeters / 1000),
                coldHardStarts: state.service.coldHardStarts,
            });

            // Reset service counters
            state.service.resetDate = Date.now();
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
            const maxH = settings.get('maxHours') || 180;
            const maxK = settings.get('maxKm') || 10000;

            const iceH = state.service.iceSec / 3600;
            const iceKm = state.service.iceMeters / 1000;

            const hoursRatio = iceH / maxH;
            const kmRatio = iceKm / maxK;
            // Penalties: each cold hard start is equivalent to 2.5 hours of highway wear
            const coldPenalty = (state.service.coldHardStarts * 2.5) / maxH;
            const thermalPenalty = (state.service.thermalStressSec / 3600 * 2) / maxH;

            const totalWear = Math.max(hoursRatio, kmRatio) + coldPenalty + thermalPenalty;
            const lifePct = Math.max(0, Math.min(100, Math.round((1 - totalWear) * 100)));

            const remHours = Math.max(0, Math.round(maxH * (lifePct / 100)));
            const remKm = Math.max(0, Math.round(maxK * (lifePct / 100)));

            let status = 'HEALTHY';
            let color = GREEN;
            if (lifePct <= 10) {
                status = 'SERVICE DUE';
                color = RED;
            } else if (lifePct <= 25) {
                status = 'SERVICE SOON';
                color = YELLOW;
            }

            return { lifePct, remHours, remKm, status, color, iceH, iceKm };
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
            // Panel 1 (Left): True Oil Degradation Index
            G.panel(cv, t, 24, 44, 490, 468, 'True Oil Health');

            // Big Health Percentage
            cv.text(String(c.lifePct), 48, 175, 110, c.color, { font: 'num' });
            cv.text('%', 52 + cv.textWidth(String(c.lifePct), 110, { font: 'num' }), 175, 42, t.dim, { font: 'bold' });
            cv.text(c.status, 480, 115, 24, c.color, { font: 'bold', align: 'right' });

            // Service status sublabels
            cv.text('Remaining:', 48, 222, 22, t.dim);
            cv.text(`${c.remHours} hrs  ·  ${c.remKm.toLocaleString()} ICE km`, 48, 252, 28, t.text, { font: 'bold' });

            // Degradation progress bar
            G.bar(cv, t, 48, 276, 442, 70, {
                label: 'Oil Degradation Life',
                value: c.lifePct,
                max: 100,
                unit: '%',
                color: c.lifePct > 25 ? 'accent' : c.lifePct > 10 ? 'warn' : 'crit',
            });

            // Target limits and service age
            const daysSince = Math.max(1, Math.round((Date.now() - state.service.resetDate) / 86400000));
            cv.text(`Target: ${settings.get('maxHours')}h or ${settings.get('maxKm')} ICE km`, 48, 388, 20, t.dim);
            cv.text(`Last reset: ${daysSince} days ago`, 48, 416, 20, t.dim);
            cv.text('Press "Reset Oil Service" after oil change', 48, 480, 18, t.dim);

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
