#!/usr/bin/env node
'use strict';
/**
 * replay_engine_care.js - play a drive recorded on the car back through Engine Care's model.
 *
 *   node tools/replay_engine_care.js engine_care_drive.jsonl [more.jsonl ...] [--set key=value ...] [--events]
 *
 * The recording: setting "Record drive data" on, then copy <app data>/engine_care_drive.jsonl (and .1)
 * off the head unit. Each line is what the model got that second (see logSample in main.js). Change the
 * model or a setting (--set warmTarget=85) and see what the same drive would have counted.
 */
const fs = require('fs');
const path = require('path');
const M = require(path.join(__dirname, '..', 'apps', 'engine_care', 'model'));

const files = [], sets = {};
let events = false;
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--set') { const [k, v] = String(process.argv[++i]).split('='); sets[k] = Number(v); } else if (a === '--events') events = true;
    else files.push(a);
}
if (!files.length) { console.error('usage: replay_engine_care.js <drive.jsonl> [...] [--set key=value] [--events]'); process.exit(2); }

const cfg = Object.assign({ coldThreshold: 65, hardTorque: 150, warmTarget: 90, shortCycleH: 1, socReserve: 15, maxKm: 10000, maxMonths: 12, maxHours: 180 }, sets);
const rows = [];
for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch (e) { /* a line cut off at power loss */ }
    }
}
rows.sort((a, b) => a.t - b.t);
if (!rows.length) { console.error('no samples'); process.exit(1); }

let pending = [];
const out = (s) => { if (events) pending.push(s); };
const print = () => { pending.forEach((l) => console.log(l)); pending = []; };
const age = (v) => (v === null || v === undefined ? Infinity : v);
const tr = new M.Tracker(M.freshState(rows[0].t), {
    cfg: () => cfg,
    log: { info: (s) => out('  ' + s), warn: (s) => out('  WARN ' + s) },
    onAlert: (s) => out('  ALERT ' + s),
});
let prevT = null;
for (const r of rows) {
    if (events && prevT !== null && r.t - prevT > 60000) console.log(new Date(r.t).toISOString() + '  (car back after ' + Math.round((r.t - prevT) / 60000) + ' min)');
    prevT = r.t;
    const before = tr.engineOn;
    tr.tick({ now: r.t, live: true, rpm: r.rpm, rpmAge: age(r.rpmAge), speed: r.speed, speedAge: age(r.speedAge), oil: r.oil, coolant: r.coolant,
        torque: r.torque, torqueAge: age(r.torqueAge), soc: r.soc, visible: true });
    if (events && before !== null && before !== tr.engineOn && tr.engineOn !== null) console.log(new Date(r.t).toISOString() + '  engine ' + (tr.engineOn ? 'START' : 'stop') + `  oil ${r.oil ?? '-'} coolant ${r.coolant ?? '-'} soc ${r.soc ?? '-'}`);
    if (r.odo) tr.onOdo(r.odo[0], r.odo[1]);
    print();
}

const s = tr.state.service, h = M.oilHealth(tr.state, cfg, rows[rows.length - 1].t);
const hm = (sec) => `${Math.floor(sec / 3600)}h ${String(Math.round(sec / 60) % 60).padStart(2, '0')}m`;
console.log(`${rows.length} samples, ${new Date(rows[0].t).toISOString()} .. ${new Date(rows[rows.length - 1].t).toISOString()}`);
console.log(`engine ${hm(s.iceSec)} / ${(s.iceMeters / 1000).toFixed(1)} km   electric ${hm(s.evSec)} / ${(s.evMeters / 1000).toFixed(1)} km   distance ${tr.drivenKm().km.toFixed(1)} km (${tr.drivenKm().src})`);
console.log(`engine starts ${s.iceStarts}: cold ${s.coldStarts}, hard load ${s.coldHardStarts}, not warmed ${s.shortCycles} (${hm(s.shortCycleSec)})`);
console.log(`battery at starts: at reserve ${s.startsLowSoc}, charge left ${s.startsWithCharge} (cold ${s.coldStartsWithCharge}), not known ${s.iceStarts - s.startsLowSoc - s.startsWithCharge}`);
console.log(`torque with the engine off: ${tr.state.diag.torqueEvSec < 10 ? 'not seen' : 'max ' + Math.round(tr.state.diag.torqueEvMax) + ' Nm'}`);
console.log(`oil life ${h.lifePct} % (${h.status}), wear +${h.penaltyH.toFixed(1)} h on ${h.iceH.toFixed(1)} h run`);
