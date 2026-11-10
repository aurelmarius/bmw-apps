'use strict';
/**
 * parked.js - "parked only" for games and anything else that mustn't run while driving.
 *
 *   const parked = require('./kit/parked').watch(ctx, log);
 *   parked.moving()   // true while the car drives (above MAX_KMH)
 *   parked.speed()    // km/h last read, or null (no speed: a VM / bench)
 *
 * Needs "de.bmw.infotainment.vehicle.Vehicle2": { "statusCarSpeed2": "rs" } in app.json "signals".
 * Every game has a setting "parkedOnly" (bool, on by default) and checks it with moving().
 *
 * Speed from Vehicle2.statusCarSpeed2, also re-read every 2 s: a car standing still may not
 * notify a speed that doesn't change. When the signal goes quiet, the last speed it read counts:
 * quiet after standing = parked (counting quiet as moving blocked a parked car in Doom 1.4.0),
 * quiet after driving = moving (the safe side) until a speed is read again. Without any real speed
 * (a VM or a bench: none, or "invalid" 65535) the car counts as parked, unless opts.strict:
 * then no speed counts as moving (video: a failed subscription must not show it while driving), and neither
 * does a speed last read more than STALE_MS ago.
 */
const MAX_KMH = 3;
const STALE_MS = 5000;

function watch(ctx, log, opts) {
    const strict = !!(opts && opts.strict);
    let speed = null, at = 0;
    ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
        statusCarSpeed2: (v) => {
            const k = v && v.speedVehicleCentreOfGravity;
            if (typeof k === 'number' && k !== 65535) { speed = k * 0.015625; at = Date.now(); }
        },
    }, log, { pollMs: 2000 }).then((s) => log && log.info('parked check: speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
    return {
        // strict: a reading older than STALE_MS (the signal is re-read every 2 s) counts as moving, so a dead
        // subscription cannot keep a last 0 km/h for ever
        moving: () => {
            if (speed === null) return strict;
            if (strict && Date.now() - at > STALE_MS) return true;
            return speed > MAX_KMH;
        },
        speed: () => speed,
    };
}

module.exports = { watch, MAX_KMH, STALE_MS };
