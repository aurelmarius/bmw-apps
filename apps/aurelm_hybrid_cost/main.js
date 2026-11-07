'use strict';
/**
 * Hybrid Cost & Optimizer - PHEV Running Cost & Energy Management for BMW 330e
 * Features:
 *   - Live running cost comparison: Electric vs Petrol (cost / 100 km)
 *   - Real-time ICE vs e-Motor torque/power split (Nm & kW)
 *   - Trip financial tracker: money spent vs money saved compared to pure petrol car
 *   - Regenerative braking energy harvest tracker (kWh & money recovered)
 *   - Prices per currency (fuel per L, electricity per kWh), set in a price editor: the iDrive controller,
 *     +/- buttons or a keypad (price_sheet.js); without the GPU renderer the bar buttons step through them
 *
 * The bookkeeping is in model.js (tested in tests/hybrid_cost.test.js); this file reads the car and draws.
 * Time, energy and cost are added up on a 1 s clock from the last values the car sent (the signals
 * only notify on change). Demo data runs through its own in-memory tracker and is never saved.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { fitText } = require('./kit/text-layout');
const M = require('./model');
const { priceSheet } = require('./price_sheet');

const W = 1600, H = 520;
const GREEN = '#2fd27a';
const BLUE = '#2a8cff';
const YELLOW = '#ffb020';
const RED = '#ef2b2d';

const TICK_MS = 1000;                // time / energy / cost are added up on this clock
const LIVE_MS = 60000;               // the car counts as there while it sent anything this recently
const CONFIRM_MS = 5000;             // "Reset Trip" needs a second press within this
const SAVE_MS = 15000;
const STATE_FILE = 'hybrid_cost_state.json';
const OLD_STATE_FILE = 'hybrid_cost_trip.json';   // up to 1.0.2: seeded with made-up values and demo data, not taken over

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque', 'accel']);

        /** a number setting; 0 is a value (only a missing one takes the default from app.json) */
        const specOf = (k) => ((ctx.spec && ctx.spec.settings) || []).find((x) => x.key === k) || {};
        const num = (k, d) => { const v = settings.get(k); const def = specOf(k).default !== undefined ? specOf(k).default : d; return v === undefined || v === null || v === '' || isNaN(Number(v)) ? def : Number(v); };
        const cur = () => String(settings.get('currency') || specOf('currency').default || 'RON');
        // prices live in the saved state, one pair per currency (the tracker's, also while demo data shows)
        const cfg = () => ({
            petrolPrice: M.price(tracker.state, cur(), 'petrol'), elecPrice: M.price(tracker.state, cur(), 'elec'),
            purePetrolAvg: num('purePetrolAvg', 8.5), monthlyKm: num('monthlyKm', 1200),
        });

        let toastMessage = null, toastUntil = 0;
        function showToast(msg, ms) {
            toastMessage = msg;
            toastUntil = Date.now() + (ms || 4000);
        }

        const saveFile = path.join(dataDir, STATE_FILE);
        if (fs.existsSync(path.join(dataDir, OLD_STATE_FILE)) && !fs.existsSync(saveFile)) log.info('trip state of 1.0.x not taken over (it held demo data): starting at 0');
        const tracker = new M.Tracker(M.loadState(saveFile, log), { log });
        // demo: the same bookkeeping on the simulated drive, in memory only - never saved, never mixed in
        let demoTracker = null;
        let lastSave = 0;
        function save() {
            try {
                M.saveState(saveFile, tracker.state);
                tracker.dirty = false;
                lastSave = Date.now();
            } catch (e) {
                log.warn('Could not save hybrid_cost state: ' + e.message);
            }
        }
        process.on('exit', () => { if (tracker.dirty) save(); });
        // up to 1.1 the prices were settings (one pair, whatever the currency): kept where they fit it
        if (M.seedPrices(tracker.state, cur(), { petrol: settings.get('petrolPrice'), elec: settings.get('elecPrice') })) {
            log.info('prices taken over from the settings for ' + cur());
            save();
        }

        /* ---------- The clock: one tick a second ---------- */
        function tick() {
            const now = Date.now(), d = car.data();
            if (d.demo) {
                tracker.pause();
                if (!demoTracker) demoTracker = new M.Tracker(M.freshState(now), {});
                demoTracker.tick({ now, live: true, rpm: d.rpm, rpmAge: 0, speed: d.speed, speedAge: 0,
                    torque: d.torque, torqueAge: 0, gLong: d.gLong, gLongAge: 0 });
                return;
            }
            demoTracker = null;
            const live = car.lastCar > 0 && now - car.lastCar < LIVE_MS;
            tracker.tick({
                now, live,
                rpm: car.live.rpm, rpmAge: car.age('rpm'),
                speed: car.live.speed, speedAge: car.age('speed'),
                torque: car.live.torque, torqueAge: car.age('torque'),
                gLong: car.live.gLong, gLongAge: car.age('gLong'),
            });
            if (tracker.dirty && now - lastSave > SAVE_MS) save();
        }
        setInterval(tick, TICK_MS);
        /** what the screen shows: the simulated drive in demo, else the car */
        const view = (d) => (d.demo && demoTracker ? demoTracker : tracker);

        /* ---------- Button Actions ---------- */
        let activeTab = 0; // 0 = Live Cost & Power, 1 = Trip Savings & Prices
        let resetArmed = 0;
        ui.onClick('BTN_PAGE', () => {
            activeTab = (activeTab + 1) % 2;
            resetArmed = 0;
            render();
        });
        if (ctx.onTab) ctx.onTab((i) => { activeTab = i; resetArmed = 0; render(); });

        const KIND = {
            petrol: { title: 'Petrol price', per: 'litre', short: 'L', color: () => ctx.theme().accent },
            elec: { title: 'Electricity price', per: 'kWh', short: 'kWh', color: () => BLUE },
        };
        const fmtPrice = (v) => v.toFixed(M.currency(cur()).dp);
        function setPrice(kind, v) {
            const p = M.setPrice(tracker.state, cur(), kind, v);
            if (p === null) return;
            save();
            showToast(`${KIND[kind].title} set to ${fmtPrice(p)} ${cur()}/${KIND[kind].short}`);
            render();
        }
        /**
         * The price editor over the page (GPU renderer, full-screen layout); elsewhere the bar button
         * steps through round prices around the currency's typical one.
         */
        function editPrice(kind) {
            const c = cur(), k = KIND[kind];
            const sheet = priceSheet({
                edit: new M.PriceEdit(c, kind, M.price(tracker.state, c, kind)),
                title: k.title, unit: `${c} per ${k.per}  ·  ${M.currency(c).name}`, color: k.color(),
                onSave: (v) => setPrice(kind, v),
            });
            if (ctx.sheet && ctx.sheet(sheet)) return;
            const p = M.nextPrice(tracker.state, c, kind);
            save();
            showToast(`${k.title} set to ${fmtPrice(p)} ${c}/${k.short}`);
            render();
        }
        ui.onClick('BTN_ADJ_FUEL', () => editPrice('petrol'));
        ui.onClick('BTN_ADJ_ELEC', () => editPrice('elec'));

        // first press arms the reset, a second one within 5 s does it
        ui.onClick('BTN_RESET', () => {
            if (car.data().demo) { resetArmed = 0; showToast('No reset in demo mode'); render(); return; }
            if (Date.now() - resetArmed > CONFIRM_MS) {
                resetArmed = Date.now();
                showToast(`Press "Reset Trip" again to confirm (${CONFIRM_MS / 1000} s)`, CONFIRM_MS);
                render();
                return;
            }
            resetArmed = 0;
            tracker.resetTrip(Date.now());
            save();
            showToast('Trip cost counters reset to 0');
            render();
        });

        /* ---------- Rendering ---------- */
        const fm = (v, dp) => (M.isNum(v) ? v.toFixed(dp) : '--');
        /** an amount in the current currency, with its decimals (none for HUF) */
        const money = (v) => v.toFixed(M.currency(cur()).dp);

        function render() {
            const t = ctx.theme();
            const d = car.data();
            const tr = view(d);
            const c = cfg();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // live: the tracker's view (stale rpm = engine off, a speed gone quiet after driving = unknown)
            const isIce = tr.engineOn === true;
            const live = {
                rpm: isIce && M.isNum(d.rpm) ? d.rpm : 0,
                speed: M.isNum(tr.speed) ? tr.speed : 0,
                torque: M.isNum(tr.torque) ? tr.torque : 0,
            };
            const lc = M.liveCost(tr.speed, c);
            const tc = M.tripCost(tr.state.trip, c);

            const badges = [
                d.demo && { text: 'DEMO' },
                toastMessage && Date.now() < toastUntil && { text: toastMessage, color: 'accent' },
            ];
            G.frame(cv, t, ['Live Cost & Power Split', 'Trip Savings & Prices'], activeTab, badges);

            if (activeTab === 0) {
                renderLiveCostTab(cv, t, live, c, lc, tc, tr, isIce);
            } else {
                renderTripSavingsTab(cv, t, c, tc, tr);
            }

            return ui.image('MAIN_GFX', cv);
        }

        function renderLiveCostTab(cv, t, live, c, lc, tc, tr, isIce) {
            const cu = cur();
            const trip = tr.state.trip;
            // ===== PANEL 1 (Left): Live Cost Comparison =====
            G.panel(cv, t, 24, 44, 490, 468, 'Live Cost Comparison');

            cv.text('RUNNING COST / 100 KM', 48, 110, 20, t.dim, { font: 'bold', spacing: 1 });

            // Electric Cost per 100km
            const e100 = lc.elec100.toFixed(1), p100 = lc.petrol100.toFixed(1);
            cv.text('ELECTRIC', 48, 145, 20, BLUE, { font: 'bold' });
            cv.text(e100, 48, 195, 54, BLUE, { font: 'num' });
            cv.text(`${cu} / 100 km`, 52 + cv.textWidth(e100, 54, { font: 'num' }), 195, 24, t.dim);
            cv.text(fitText(cv, `est. ${lc.kwh100.toFixed(1)} kWh/100km @ ${c.elecPrice.toFixed(M.currency(cu).dp)} ${cu}/kWh`, 19, 442), 48, 225, 19, t.dim);

            // Petrol Cost per 100km
            cv.text('PETROL (B48)', 48, 268, 20, t.accent, { font: 'bold' });
            cv.text(p100, 48, 318, 54, t.text, { font: 'num' });
            cv.text(`${cu} / 100 km`, 52 + cv.textWidth(p100, 54, { font: 'num' }), 318, 24, t.dim);
            cv.text(fitText(cv, `est. ${lc.fuel100.toFixed(1)} L/100km @ ${c.petrolPrice.toFixed(M.currency(cu).dp)} ${cu}/L`, 19, 442), 48, 348, 19, t.dim);

            cv.fillRect(48, 375, 442, 1.5, withAlpha('#ffffff', 0.15));

            // Efficiency Sweet-spot Badge
            const savingsPct = Math.round((1 - lc.elec100 / lc.petrol100) * 100);
            if (lc.electricCheaper) {
                cv.fillRect(48, 395, 442, 60, withAlpha(GREEN, 0.15));
                cv.strokeRoundRect(48, 395, 442, 60, 6, 1.5, withAlpha(GREEN, 0.5));
                cv.text(`ELECTRIC IS ${savingsPct}% CHEAPER`, 64, 424, 22, GREEN, { font: 'bold' });
                cv.text('Optimal mode: Pure Electric (Max eDrive)', 64, 445, 18, t.dim);
            } else if (lc.elec100 >= lc.petrol100) {
                cv.fillRect(48, 395, 442, 60, withAlpha(YELLOW, 0.15));
                cv.strokeRoundRect(48, 395, 442, 60, 6, 1.5, withAlpha(YELLOW, 0.5));
                cv.text(`PETROL IS ${-savingsPct}% CHEAPER`, 64, 424, 21, YELLOW, { font: 'bold' });
                cv.text('At these prices, electricity costs more per km', 64, 445, 18, t.dim);
            } else {
                cv.fillRect(48, 395, 442, 60, withAlpha(YELLOW, 0.15));
                cv.strokeRoundRect(48, 395, 442, 60, 6, 1.5, withAlpha(YELLOW, 0.5));
                cv.text('HIGHWAY: PETROL RECOMMENDED', 64, 424, 21, YELLOW, { font: 'bold' });
                cv.text(`Speed > ${M.EV_MAX_KMH} km/h: Save battery for city traffic`, 64, 445, 18, t.dim);
            }

            cv.text(fitText(cv, `Rates: ${c.petrolPrice.toFixed(M.currency(cu).dp)} ${cu}/L (Petrol)  ·  ${c.elecPrice.toFixed(M.currency(cu).dp)} ${cu}/kWh (Elec)`, 18, 442), 48, 485, 18, t.dim);

            // ===== PANEL 2 (Center): Dynamic Power / Torque Split =====
            G.panel(cv, t, 538, 44, 524, 468, 'Dynamic Torque & Power');

            const rpm = live.rpm;
            const totalTorque = Math.max(0, live.torque);

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
            const evKw = Math.round((evTorque * Math.max(800, isIce ? rpm : live.speed * 35)) / 9549);
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
            cv.text(isIce ? `Running at ${Math.round(rpm)} rpm` : tr.engineOn === null ? 'Engine state not known yet' : 'Engine Off (Decoupled K0)', 562, 335, 19, t.dim);

            // Electric Motor Output
            cv.text('ZF8 ELECTRIC MOTOR', 562, 380, 20, BLUE, { font: 'bold' });
            cv.text(`${evKw} kW  ·  ${evTorque.toFixed(2)} Nm`, 562, 420, 34, evKw > 0 ? BLUE : t.dim, { font: 'bold' });
            cv.text(evKw > 0 ? 'Active eDrive Assist' : 'Standby / Regenerating', 562, 450, 19, t.dim);

            cv.text('330e Architecture: Integrated e-Motor in ZF8HP', 562, 485, 18, t.dim);

            // ===== PANEL 3 (Right): Trip Cost & Savings =====
            G.panel(cv, t, 1086, 44, 490, 468, 'Trip Cost & Savings');

            cv.text('TRIP TOTAL COST', 1110, 110, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(`${money(tc.total)}`, 1110, 160, 52, t.text, { font: 'num' });
            cv.text(cu, 1118 + cv.textWidth(money(tc.total), 52, { font: 'num' }), 160, 26, t.dim);

            // Sub-breakdown
            cv.text(fitText(cv, `Fuel: ${money(tc.fuel)} ${cu} (${trip.fuelLitersConsumed.toFixed(2)} L)`, 21, 442), 1110, 200, 21, t.accent);
            cv.text(fitText(cv, `Elec: ${money(tc.elec)} ${cu} (${trip.kwhConsumed.toFixed(1)} kWh)`, 21, 442), 1110, 230, 21, BLUE);

            cv.fillRect(1110, 255, 442, 1.5, withAlpha('#ffffff', 0.15));

            // Big Savings Banner
            cv.fillRect(1110, 280, 442, 85, withAlpha(GREEN, 0.16));
            cv.strokeRoundRect(1110, 280, 442, 85, 6, 1.5, withAlpha(GREEN, 0.6));
            cv.text('TOTAL SAVINGS THIS TRIP', 1130, 310, 20, GREEN, { font: 'bold' });
            const savedStr = `+${money(tc.saved)} ${cu}`;
            cv.text(savedStr, 1130, 348, 38, GREEN, { font: 'bold' });
            const savedX = 1142 + cv.textWidth(savedStr, 38, { font: 'bold' });
            cv.text(fitText(cv, `vs petrol car @ ${c.purePetrolAvg} L/100km`, 19, 1540 - savedX), savedX, 348, 19, t.dim);

            // Regen Energy Harvest
            cv.text('REGEN BRAKING HARVEST:', 1110, 405, 20, t.dim);
            const regenStr = `${trip.regenKwhHarvested.toFixed(2)} kWh`;
            cv.text(regenStr, 1110, 435, 26, GREEN, { font: 'bold' });
            const regenX = 1122 + cv.textWidth(regenStr, 26, { font: 'bold' });
            cv.text(fitText(cv, `(+${money(tc.regen)} ${cu} free energy)`, 22, 1552 - regenX), regenX, 435, 22, t.dim);

            cv.text(fitText(cv, `Trip Distance: ${tc.km.toFixed(1)} km  ·  Press "Reset Trip" twice to clear`, 18, 442), 1110, 485, 18, t.dim);
        }

        function renderTripSavingsTab(cv, t, c, tc, tr) {
            const cu = cur();
            const trip = tr.state.trip;
            // ===== TAB 1: Detailed Economics & Price Editor =====
            G.panel(cv, t, 24, 44, 760, 468, 'Trip Energy Breakdown');

            cv.text('PHEV ENERGY USAGE', 56, 110, 20, t.dim, { font: 'bold' });
            const since = new Date(trip.start);
            const pad = (n) => (n < 10 ? '0' : '') + n;
            cv.text(`trip since ${pad(since.getHours())}:${pad(since.getMinutes())}  ·  new after ${M.TRIP_GAP_MS / 60000} min parked`, 750, 110, 17, t.dim, { align: 'right' });

            cv.text('Total Distance:', 56, 160, 24, t.dim);
            cv.text(`${tc.km.toFixed(1)} km`, 380, 160, 26, t.text, { font: 'bold', align: 'right' });

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

            cv.text(`avg ${fm(tc.avgKwh100, 1)} kWh/100km EV  ·  ${fm(tc.avgFuel100, 1)} L/100km petrol`, 56, 292, 17, t.dim);

            cv.fillRect(56, 310, 694, 1.5, withAlpha('#ffffff', 0.15));

            // Monthly Projection Box (setting monthlyKm, at this trip's cost per km)
            cv.fillRect(56, 335, 694, 130, withAlpha(t.track, 0.6));
            cv.strokeRoundRect(56, 335, 694, 130, 8, 1.5, withAlpha(BLUE, 0.4));

            cv.text(`MONTHLY COST ESTIMATE (${Math.round(c.monthlyKm)} km / month)`, 80, 370, 22, BLUE, { font: 'bold' });
            cv.text(tc.monthly === null ? 'PHEV Cost: -- (drive a little first)' : `PHEV Cost: ~${Math.round(tc.monthly)} ${cu} / month`, 80, 410, 24, t.text, { font: 'bold' });
            cv.text(fitText(cv, `Petrol car @ ${c.purePetrolAvg} L/100km: ~${Math.round(tc.monthlyPetrol)} ${cu} / month`, 22, 440), 80, 442, 22, t.dim);
            cv.text(tc.monthlySaved === null ? '' : `Save ~${Math.round(tc.monthlySaved)} ${cu}/mo`, 730, 420, 28, GREEN, { font: 'bold', align: 'right' });

            // ===== PANEL 2 (Right): Interactive Price Adjuster =====
            G.panel(cv, t, 816, 44, 760, 468, 'Interactive Price Settings');

            const touch = !!(cv.own && cv.target);
            const dp = M.currency(cu).dp;
            cv.text('PRICES IN ' + cu, 848, 110, 20, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(fitText(cv, touch ? 'Tap a price to change it - controller, +/- buttons or keypad' : 'Use the "Petrol Price" and "Elec Price" buttons to change them', 20, 692), 848, 140, 20, t.dim);

            // Petrol Price Card
            cv.fillRect(848, 170, 330, 150, withAlpha(t.accent, 0.12));
            cv.strokeRoundRect(848, 170, 330, 150, 8, 1.5, withAlpha(t.accent, 0.4));
            cv.text('PETROL PRICE', 872, 205, 20, t.accent, { font: 'bold' });
            cv.text(c.petrolPrice.toFixed(dp), 872, 258, 48, t.text, { font: 'num' });
            cv.text(`${cu} / Litre`, 872 + cv.textWidth(c.petrolPrice.toFixed(dp), 48, { font: 'num' }) + 10, 258, 22, t.dim);
            cv.text(touch ? 'Tap to change' : 'Button "Petrol Price"', 872, 298, 18, t.dim);
            if (touch) cv.target(848, 170, 330, 150, () => editPrice('petrol'), 'price-petrol', 8);

            // Electricity Price Card
            cv.fillRect(1210, 170, 330, 150, withAlpha(BLUE, 0.12));
            cv.strokeRoundRect(1210, 170, 330, 150, 8, 1.5, withAlpha(BLUE, 0.4));
            cv.text('ELECTRICITY PRICE', 1234, 205, 20, BLUE, { font: 'bold' });
            cv.text(c.elecPrice.toFixed(dp), 1234, 258, 48, BLUE, { font: 'num' });
            cv.text(`${cu} / kWh`, 1234 + cv.textWidth(c.elecPrice.toFixed(dp), 48, { font: 'num' }) + 10, 258, 22, t.dim);
            cv.text(touch ? 'Tap to change' : 'Button "Elec Price"', 1234, 298, 18, t.dim);
            if (touch) cv.target(1210, 170, 330, 150, () => editPrice('elec'), 'price-elec', 8);

            // Settings description
            cv.fillRect(848, 345, 692, 1.5, withAlpha('#ffffff', 0.15));
            cv.text('Settings & Persistence:', 848, 385, 22, t.text, { font: 'bold' });
            cv.text(fitText(cv, '- Prices are kept for each currency: switching currency keeps both sets.', 20, 692), 848, 415, 20, t.dim);
            cv.text(fitText(cv, `- Currency (${cu}), petrol car baseline and km per month: Settings screen.`, 20, 692), 848, 445, 20, t.dim);
            cv.text(fitText(cv, '- Trip totals are saved; demo data is never counted or saved.', 20, 692), 848, 475, 20, t.dim);
        }

        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('Hybrid Cost first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
