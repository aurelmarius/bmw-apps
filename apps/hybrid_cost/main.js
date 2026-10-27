'use strict';
/**
 * Hybrid Cost & Optimizer - PHEV Running Cost & Energy Management for BMW 330e
 * Features:
 *   - Live running cost comparison: Electric vs Petrol (RON / 100 km)
 *   - Real-time ICE vs e-Motor torque/power split (Nm & kW)
 *   - Trip financial tracker: money spent vs money saved compared to pure petrol car
 *   - Regenerative braking energy harvest tracker (kWh & RON recovered)
 *   - On-screen interactive price adjuster for fuel (RON/L) and electricity (RON/kWh)
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
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque', 'accel']);

        const saveFile = path.join(dataDir, 'hybrid_cost_trip.json');

        // Trip accumulation state
        let trip = {
            distanceMeters: 41200,      // 41.2 km baseline
            evMeters: 28600,            // 28.6 km EV
            iceMeters: 12600,           // 12.6 km ICE
            kwhConsumed: 5.4,           // 5.4 kWh used
            fuelLitersConsumed: 0.95,   // 0.95 L petrol used
            regenKwhHarvested: 1.85,    // 1.85 kWh generated from braking
            startTime: Date.now() - 48 * 60 * 1000,
        };

        try {
            if (fs.existsSync(saveFile)) {
                const loaded = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
                if (loaded && loaded.distanceMeters !== undefined) trip = loaded;
            }
        } catch (e) {
            ctx.log.warn('Could not load trip state:', e.message);
        }

        function saveTrip() {
            try {
                fs.writeFileSync(saveFile, JSON.stringify(trip, null, 2));
            } catch (e) {}
        }

        let activeTab = 0; // 0 = Live Cost & Power, 1 = Trip Savings & Prices
        let lastT = 0;
        let lastSave = 0;
        let toastMessage = null;
        let toastUntil = 0;

        function showToast(msg) {
            toastMessage = msg;
            toastUntil = Date.now() + 4000;
        }

        /* ---------- Telemetry Sampling ---------- */
        car.onSample((d, t) => {
            const dt = lastT ? Math.min(1.0, (t - lastT) / 1000) : 0.05;
            lastT = t;

            const speed = d.speed || 0;
            const rpm = d.rpm || 0;
            const torque = d.torque || 0;
            const gLong = d.gLong || 0;
            const isIceRunning = rpm > 400;

            const dist = (speed / 3.6) * dt;
            trip.distanceMeters += dist;

            if (isIceRunning) {
                trip.iceMeters += dist;
                // Fuel consumption model: ~6.5 L/100km base at cruise, scaling with torque
                const litersPerSec = (6.5 / 100 / 1000) * (speed / 3.6) * Math.max(0.6, torque / 140);
                trip.fuelLitersConsumed += litersPerSec * dt;
            } else if (speed > 3) {
                trip.evMeters += dist;
                // Electric consumption model: ~17 kWh/100km base
                const kwhPerSec = (17.5 / 100 / 1000) * (speed / 3.6) * Math.max(0.5, torque / 100);
                trip.kwhConsumed += kwhPerSec * dt;
            }

            // Regenerative braking: when decelerating (gLong < -0.05)
            if (gLong < -0.05 && speed > 5) {
                const regenPowerKw = Math.min(45, Math.abs(gLong) * 1.8 * speed);
                const regenKwh = (regenPowerKw * dt) / 3600;
                trip.regenKwhHarvested += regenKwh;
            }

            if (Date.now() - lastSave > 15000) {
                lastSave = Date.now();
                saveTrip();
            }
        });

        /* ---------- Button Actions ---------- */
        ui.onClick('BTN_PAGE', () => {
            activeTab = (activeTab + 1) % 2;
            render();
        });

        const fuelSteps = [6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5, 11.0, 11.5, 12.0, 12.5, 13.0];
        const elecSteps = [0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0];

        ui.onClick('BTN_ADJ_FUEL', () => {
            const current = settings.get('petrolPrice') || 7.5;
            let idx = fuelSteps.findIndex((s) => s > current + 0.05);
            let next = idx >= 0 ? fuelSteps[idx] : fuelSteps[0];
            settings.set('petrolPrice', next);
            showToast(`Petrol set to ${next.toFixed(2)} RON/L`);
            render();
        });

        ui.onClick('BTN_ADJ_ELEC', () => {
            const current = settings.get('elecPrice') || 0.8;
            let idx = elecSteps.findIndex((s) => s > current + 0.05);
            let next = idx >= 0 ? elecSteps[idx] : elecSteps[0];
            settings.set('elecPrice', next);
            showToast(`Elec set to ${next.toFixed(2)} RON/kWh`);
            render();
        });

        ui.onClick('BTN_RESET', () => {
            trip.distanceMeters = 0;
            trip.evMeters = 0;
            trip.iceMeters = 0;
            trip.kwhConsumed = 0;
            trip.fuelLitersConsumed = 0;
            trip.regenKwhHarvested = 0;
            trip.startTime = Date.now();
            saveTrip();
            showToast('Trip cost counters reset to 0');
            render();
        });

        /* ---------- Calculations ---------- */
        function computeLiveCost(speed, torque, isIce) {
            const pFuel = settings.get('petrolPrice') || 7.4;
            const pElec = settings.get('elecPrice') || 0.8;

            const v = Math.max(20, speed);
            // Electric kWh/100km estimation based on speed & aero
            const estKwh100 = Math.min(32, Math.max(13, 14.0 + Math.pow(v / 100, 2) * 8.5));
            // Petrol L/100km estimation based on speed & load
            const estFuel100 = Math.min(14, Math.max(4.8, 5.0 + Math.pow(v / 120, 2) * 2.8));

            const costElec100 = Number((estKwh100 * pElec).toFixed(1));
            const costPetrol100 = Number((estFuel100 * pFuel).toFixed(1));

            // Hybrid recommendation
            const isElectricCheaper = costElec100 < costPetrol100 && v < 118;

            return { costElec100, costPetrol100, estKwh100, estFuel100, isElectricCheaper, pFuel, pElec };
        }

        /* ---------- Rendering ---------- */
        function render() {
            const t = ctx.theme();
            const d = car.data();
            const cv = ctx.canvas(W, H).clear(t.bg);

            const isIce = (d.rpm || 0) > 400;
            const c = computeLiveCost(d.speed || 0, d.torque || 0, isIce);

            const badges = [
                d.demo && { text: 'DEMO' },
                toastMessage && Date.now() < toastUntil && { text: toastMessage, color: 'accent' },
            ];
            G.frame(cv, t, ['Live Cost & Power Split', 'Trip Savings & Prices'], activeTab, badges);

            if (activeTab === 0) {
                renderLiveCostTab(cv, t, d, c, isIce);
            } else {
                renderTripSavingsTab(cv, t, d, c);
            }

            return ui.image('MAIN_GFX', cv);
        }

        function renderLiveCostTab(cv, t, d, c, isIce) {
            // ===== PANEL 1 (Left): Live Cost Comparison =====
            G.panel(cv, t, 24, 44, 490, 468, 'Live Cost Comparison');

            cv.text('RUNNING COST / 100 KM', 48, 110, 20, t.dim, { font: 'bold', spacing: 1 });

            // Electric Cost per 100km
            cv.text('ELECTRIC', 48, 145, 20, BLUE, { font: 'bold' });
            cv.text(String(c.costElec100), 48, 195, 54, BLUE, { font: 'num' });
            cv.text('RON / 100 km', 52 + cv.textWidth(String(c.costElec100), 54, { font: 'num' }), 195, 24, t.dim);
            cv.text(`est. ${c.estKwh100.toFixed(1)} kWh/100km @ ${c.pElec.toFixed(2)} lei`, 48, 225, 19, t.dim);

            // Petrol Cost per 100km
            cv.text('PETROL (B48)', 48, 268, 20, t.accent, { font: 'bold' });
            cv.text(String(c.costPetrol100), 48, 318, 54, t.text, { font: 'num' });
            cv.text('RON / 100 km', 52 + cv.textWidth(String(c.costPetrol100), 54, { font: 'num' }), 318, 24, t.dim);
            cv.text(`est. ${c.estFuel100.toFixed(1)} L/100km @ ${c.pFuel.toFixed(2)} lei`, 48, 348, 19, t.dim);

            cv.fillRect(48, 375, 442, 1.5, withAlpha('#ffffff', 0.15));

            // Efficiency Sweet-spot Badge
            const savingsPct = Math.round((1 - c.costElec100 / c.costPetrol100) * 100);
            if (c.isElectricCheaper) {
                cv.fillRect(48, 395, 442, 60, withAlpha(GREEN, 0.15));
                cv.strokeRoundRect(48, 395, 442, 60, 6, 1.5, withAlpha(GREEN, 0.5));
                cv.text(`ELECTRIC IS ${savingsPct}% CHEAPER`, 64, 424, 22, GREEN, { font: 'bold' });
                cv.text('Optimal mode: Pure Electric (Max eDrive)', 64, 445, 18, t.dim);
            } else {
                cv.fillRect(48, 395, 442, 60, withAlpha(YELLOW, 0.15));
                cv.strokeRoundRect(48, 395, 442, 60, 6, 1.5, withAlpha(YELLOW, 0.5));
                cv.text('HIGHWAY: PETROL RECOMMENDED', 64, 424, 21, YELLOW, { font: 'bold' });
                cv.text('Speed > 118 km/h: Save battery for city traffic', 64, 445, 18, t.dim);
            }

            cv.text(`Rates: ${c.pFuel.toFixed(2)} RON/L (Petrol)  ·  ${c.pElec.toFixed(2)} RON/kWh (Elec)`, 48, 485, 18, t.dim);

            // ===== PANEL 2 (Center): Dynamic Power / Torque Split =====
            G.panel(cv, t, 538, 44, 524, 468, 'Dynamic Torque & Power');

            const rpm = d.rpm || 0;
            const totalTorque = Math.max(0, d.torque || 0);

            // 330e hybrid power split calculation
            let iceTorque = 0;
            let evTorque = 0;
            if (isIce) {
                iceTorque = Math.min(300, totalTorque);
                evTorque = Math.max(0, totalTorque - iceTorque);
            } else {
                iceTorque = 0;
                evTorque = Math.min(265, totalTorque);
            }
            evTorque = Math.round(evTorque * 100) / 100;
            iceTorque = Math.round(iceTorque * 100) / 100;

            const iceKw = Math.round((iceTorque * Math.max(800, rpm)) / 9549);
            const evKw = Math.round((evTorque * Math.max(800, rpm > 400 ? rpm : (d.speed || 0) * 35)) / 9549);
            const totalKw = iceKw + evKw;
            const totalHp = Math.round(totalKw * 1.36);

            // Combined system output badge
            cv.text('SYSTEM OUTPUT', 562, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(`${totalKw} kW`, 562, 155, 46, t.text, { font: 'bold' });
            cv.text(`(${totalHp} hp)`, 570 + cv.textWidth(`${totalKw} kW`, 46, { font: 'bold' }), 155, 28, t.accent);

            // Dual split bar
            const barW = 476;
            const maxSysKw = 215; // 330e system output with XtraBoost ~215 kW (292 hp)
            const iceBarW = Math.round(Math.min(1, iceKw / maxSysKw) * barW);
            const evBarW = Math.round(Math.min(1, evKw / maxSysKw) * barW);

            cv.fillRect(562, 180, barW, 24, withAlpha(t.track, 0.8));
            if (evBarW > 0) cv.fillRect(562, 180, evBarW, 24, BLUE);
            if (iceBarW > 0) cv.fillRect(562 + evBarW, 180, Math.min(barW - evBarW, iceBarW), 24, t.accent);

            // Individual component readings
            cv.fillRect(562, 230, barW, 1.5, withAlpha('#ffffff', 0.15));

            // Petrol Engine Output
            cv.text('B48 PETROL ENGINE', 562, 265, 20, t.accent, { font: 'bold' });
            cv.text(`${iceKw} kW  ·  ${iceTorque.toFixed(2)} Nm`, 562, 305, 34, isIce ? t.text : t.dim, { font: 'bold' });
            cv.text(isIce ? `Running at ${Math.round(rpm)} rpm` : 'Engine Off (Decoupled K0)', 562, 335, 19, t.dim);

            // Electric Motor Output
            cv.text('ZF8 ELECTRIC MOTOR', 562, 380, 20, BLUE, { font: 'bold' });
            cv.text(`${evKw} kW  ·  ${evTorque.toFixed(2)} Nm`, 562, 420, 34, evKw > 0 ? BLUE : t.dim, { font: 'bold' });
            cv.text(evKw > 0 ? 'Active eDrive Assist' : 'Standby / Regenerating', 562, 450, 19, t.dim);

            cv.text('330e Architecture: Integrated e-Motor in ZF8HP', 562, 485, 18, t.dim);

            // ===== PANEL 3 (Right): Trip Cost & Savings =====
            G.panel(cv, t, 1086, 44, 490, 468, 'Trip Cost & Savings');

            const tripFuelCost = trip.fuelLitersConsumed * c.pFuel;
            const tripElecCost = trip.kwhConsumed * c.pElec;
            const totalTripCost = tripFuelCost + tripElecCost;

            // Baseline cost if driven pure petrol @ baseline L/100km
            const baselineL100 = settings.get('purePetrolAvg') || 8.5;
            const purePetrolEquivalentCost = ((trip.distanceMeters / 1000) / 100) * baselineL100 * c.pFuel;
            const moneySaved = Math.max(0, purePetrolEquivalentCost - totalTripCost);

            cv.text('TRIP TOTAL COST', 1110, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(`${totalTripCost.toFixed(2)}`, 1110, 160, 52, t.text, { font: 'num' });
            cv.text('RON', 1118 + cv.textWidth(totalTripCost.toFixed(2), 52, { font: 'num' }), 160, 26, t.dim);

            // Sub-breakdown
            cv.text(`Fuel: ${tripFuelCost.toFixed(2)} lei (${trip.fuelLitersConsumed.toFixed(2)} L)`, 1110, 200, 21, t.accent);
            cv.text(`Elec: ${tripElecCost.toFixed(2)} lei (${trip.kwhConsumed.toFixed(1)} kWh)`, 1110, 230, 21, BLUE);

            cv.fillRect(1110, 255, 442, 1.5, withAlpha('#ffffff', 0.15));

            // Big Savings Banner
            cv.fillRect(1110, 280, 442, 85, withAlpha(GREEN, 0.16));
            cv.strokeRoundRect(1110, 280, 442, 85, 6, 1.5, withAlpha(GREEN, 0.6));
            cv.text('TOTAL SAVINGS THIS TRIP', 1130, 310, 20, GREEN, { font: 'bold' });
            cv.text(`+${moneySaved.toFixed(2)} RON`, 1130, 348, 38, GREEN, { font: 'bold' });
            cv.text(`vs petrol car @ ${baselineL100} L/100km`, 1330, 348, 19, t.dim);

            // Regen Energy Harvest
            const regenLei = trip.regenKwhHarvested * c.pElec;
            cv.text('REGEN BRAKING HARVEST:', 1110, 405, 20, t.dim);
            cv.text(`${trip.regenKwhHarvested.toFixed(2)} kWh`, 1110, 435, 26, GREEN, { font: 'bold' });
            cv.text(`(+${regenLei.toFixed(2)} lei free energy)`, 1240, 435, 22, t.dim);

            const tripKm = (trip.distanceMeters / 1000).toFixed(1);
            cv.text(`Trip Distance: ${tripKm} km  ·  Tap "Reset Trip" to clear`, 1110, 485, 18, t.dim);
        }

        function renderTripSavingsTab(cv, t, d, c) {
            // ===== TAB 1: Detailed Economics & Price Editor =====
            G.panel(cv, t, 24, 44, 760, 468, 'Trip Energy Breakdown');

            const tripKm = Math.max(0.1, trip.distanceMeters / 1000);
            const avgKwh100 = (trip.kwhConsumed / (trip.evMeters / 1000 || 1)) * 100;
            const avgFuel100 = (trip.fuelLitersConsumed / (trip.iceMeters / 1000 || 1)) * 100;

            cv.text('PHEV ENERGY USAGE', 56, 110, 20, t.dim, { font: 'bold' });

            cv.text('Total Distance:', 56, 160, 24, t.dim);
            cv.text(`${tripKm.toFixed(1)} km`, 380, 160, 26, t.text, { font: 'bold', align: 'right' });

            cv.text('Electric Distance:', 56, 210, 24, t.dim);
            cv.text(`${(trip.evMeters / 1000).toFixed(1)} km`, 380, 210, 26, BLUE, { font: 'bold', align: 'right' });

            cv.text('Petrol Distance:', 56, 260, 24, t.dim);
            cv.text(`${(trip.iceMeters / 1000).toFixed(1)} km`, 380, 260, 26, t.accent, { font: 'bold', align: 'right' });

            cv.text('Grid Energy Consumed:', 430, 160, 24, t.dim);
            cv.text(`${trip.kwhConsumed.toFixed(2)} kWh`, 750, 160, 26, BLUE, { font: 'bold', align: 'right' });

            cv.text('Petrol Consumed:', 430, 210, 24, t.dim);
            cv.text(`${trip.fuelLitersConsumed.toFixed(2)} Litres`, 750, 210, 26, t.accent, { font: 'bold', align: 'right' });

            cv.text('Regen Recovered:', 430, 260, 24, t.dim);
            cv.text(`${trip.regenKwhHarvested.toFixed(2)} kWh`, 750, 260, 26, GREEN, { font: 'bold', align: 'right' });

            cv.fillRect(56, 310, 694, 1.5, withAlpha('#ffffff', 0.15));

            // Monthly Projection Box
            const monthlyKm = 1200;
            const tripCostPerKm = (trip.fuelLitersConsumed * c.pFuel + trip.kwhConsumed * c.pElec) / tripKm;
            const monthlyCost = monthlyKm * tripCostPerKm;
            const purePetrolMonthly = monthlyKm * (8.5 / 100) * c.pFuel;
            const monthlySavings = Math.max(0, purePetrolMonthly - monthlyCost);

            cv.fillRect(56, 335, 694, 130, withAlpha(t.track, 0.6));
            cv.strokeRoundRect(56, 335, 694, 130, 8, 1.5, withAlpha(BLUE, 0.4));

            cv.text('MONTHLY COST ESTIMATE (1,200 km / month)', 80, 370, 22, BLUE, { font: 'bold' });
            cv.text(`PHEV Cost: ~${Math.round(monthlyCost)} RON / month`, 80, 410, 24, t.text, { font: 'bold' });
            cv.text(`Pure Petrol Car (330i): ~${Math.round(purePetrolMonthly)} RON / month`, 80, 442, 22, t.dim);
            cv.text(`Save ~${Math.round(monthlySavings)} RON/mo`, 730, 420, 28, GREEN, { font: 'bold', align: 'right' });

            // ===== PANEL 2 (Right): Interactive Price Adjuster =====
            G.panel(cv, t, 816, 44, 760, 468, 'Interactive Price Settings');

            cv.text('QUICK PRICE ADJUSTER', 848, 110, 20, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('Adjust energy prices on the fly using on-screen buttons:', 848, 140, 20, t.dim);

            // Petrol Price Card
            cv.fillRect(848, 170, 330, 150, withAlpha(t.accent, 0.12));
            cv.strokeRoundRect(848, 170, 330, 150, 8, 1.5, withAlpha(t.accent, 0.4));
            cv.text('PETROL PRICE', 872, 205, 20, t.accent, { font: 'bold' });
            cv.text(`${c.pFuel.toFixed(2)}`, 872, 258, 48, t.text, { font: 'num' });
            cv.text('RON / Litre', 872 + cv.textWidth(c.pFuel.toFixed(2), 48, { font: 'num' }) + 10, 258, 22, t.dim);
            cv.text('Tap "Petrol Price" button to cycle', 872, 298, 18, t.dim);

            // Electricity Price Card
            cv.fillRect(1210, 170, 330, 150, withAlpha(BLUE, 0.12));
            cv.strokeRoundRect(1210, 170, 330, 150, 8, 1.5, withAlpha(BLUE, 0.4));
            cv.text('ELECTRICITY PRICE', 1234, 205, 20, BLUE, { font: 'bold' });
            cv.text(`${c.pElec.toFixed(2)}`, 1234, 258, 48, BLUE, { font: 'num' });
            cv.text('RON / kWh', 1234 + cv.textWidth(c.pElec.toFixed(2), 48, { font: 'num' }) + 10, 258, 22, t.dim);
            cv.text('Tap "Elec Price" button to cycle', 1234, 298, 18, t.dim);

            // Settings description
            cv.fillRect(848, 345, 692, 1.5, withAlpha('#ffffff', 0.15));
            cv.text('Settings & Persistence:', 848, 385, 22, t.text, { font: 'bold' });
            cv.text('- Prices are automatically saved in settings.json and persist across reboots.', 848, 415, 20, t.dim);
            cv.text('- Full custom decimal values can also be selected in the Settings screen.', 848, 445, 20, t.dim);
            cv.text('- Calculations adjust live without needing to restart the head unit.', 848, 475, 20, t.dim);
        }

        ctx.loop('MAIN', 2, render);
        render().then(() => ctx.log.info('Hybrid Cost first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
