'use strict';
/**
 * car_audio.js - the channel's sound on the car's speakers, through the audio manager. Emby's copy
 * (apps/aurelm_emby/car_audio.js, 0.3.9), unchanged: it touches only its own connection, so a third app on source 287
 * (myAirPlay, Emby, TVH Player) never takes the speakers from another and never ends another's sound. Emby's words:
 *
 * (Emby's copy of AirPlay Test's module, apps/aurelm_airplay_probe/car_audio.js, 0.8.3, with two more checks for a
 * source both apps use, below.)
 *
 * tvh-player (as emby-player) plays into SmartXbar's input for CarLife, source 287 (unused in Europe); the GENIVI audio manager
 * routes it to the main speakers, MediaSink_Front (1024), as Moonride does (its main.js, JustAnotherPU,
 * GPL-3.0-or-later): 287 is A_UNAVAILABLE without a CarLife phone and a connect to it would stay CS_CONNECTING for
 * ever, so it is marked available through the routing interface first; one connect while the sound is wanted, one
 * disconnect after it, in order.
 *
 * 287 is shared: AirPlay Test's receiver plays into it too. So this module touches only its own connection: its
 * mainConnectionID is kept in a file (`file`), and only that id is ever disconnected, also the one a crash left. A
 * 287 connection that is not ours is left alone, and the sound is not connected over it: the state says the
 * speakers are taken. Two more checks than AirPlay Test's copy:
 *   - the saved id is kept with the boot it was made in (/proc/sys/kernel/random/boot_id): after a restart of the
 *     head unit the audio manager numbers its connections again, so an id from before may now be the other app's;
 *     it is forgotten, never disconnected;
 *   - the source is marked unavailable only when no 287 connection is left (the other app may have connected in
 *     the moment between our disconnect and that call).
 *
 * The latest app to want the sound gets it (Music Assistant 0.1.7, in every app on 287): each app that wants the
 * speakers says so in a file of its own in a shared folder (/tmp/aurelm-287/<app>.json, the time it started
 * wanting them); the app holding 287 that sees a newer one there lets go (its disconnect) and tells its app
 * (`onYield`: Music Assistant pauses), and the newer one, which saw 287 taken, connects as soon as it is free
 * (it looks every second). An app made to stop then (`yieldStops`: Music Assistant) withdraws its claim, and a
 * later play of its claims again (not in the first 5 s: the music still reported playing). Before, an app
 * found 287 taken and waited: TVH Player's picture came without its sound while Music Assistant played on. An app that lets go waits, as before, until 287 is free again.
 *
 *   const audio = createCarAudio(ctx.signals, log, { file, app: 'TVH Player', onYield: (by) => ..., yieldStops });
 *   audio.want(true | false);     // called again and again (each status): the checks run from there
 *   audio.state()                 // { on, connected, error, taken, yieldedTo }
 */
const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const path = require('path');
const SRC = 287, SINK = 1024;

function createCarAudio(signals, log, opts) {
    const o = opts || {};
    const fs = o.fs || require('fs');
    const am = { p: null, r: null, id: null, on: false, q: Promise.resolve(), connected: false, error: null, taken: false, checked: 0, claimAt: 0, yieldedTo: null, yieldedAt: 0 };
    /* ---------- the claims: who wants the speakers, and since when ---------- */
    const claimDir = o.claimDir || '/tmp/aurelm-287';
    const me = String(o.app || 'app').replace(/[^A-Za-z0-9_-]/g, '_');
    const myClaim = () => path.join(claimDir, me + '.json');
    function claim(on) {
        try {
            if (!on) { fs.unlinkSync(myClaim()); return; }
            try { fs.mkdirSync(claimDir); fs.chmodSync(claimDir, 0o1777); } catch (e) { /* there already */ }
            am.claimAt = Date.now();
            fs.writeFileSync(myClaim(), JSON.stringify({ app: o.app || me, at: am.claimAt }));
            try { fs.chmodSync(myClaim(), 0o644); } catch (e) { /* not ours to change */ }
        } catch (e) { /* none, or not writable: the apps then keep to the old rule */ }
    }
    /** the newest claim of another app, if newer than ours */
    function newerClaim() {
        let best = null;
        try {
            fs.readdirSync(claimDir).forEach((f) => {
                if (!/\.json$/.test(f) || f === me + '.json') return;
                try { const c = JSON.parse(fs.readFileSync(path.join(claimDir, f), 'utf8')); if (c && c.at > am.claimAt && (!best || c.at > best.at)) best = c; } catch (e) { /* half written */ }
            });
        } catch (e) { /* no folder */ }
        return best;
    }
    // our connection's id, kept across a crash; null: none of ours
    const bootId = () => { try { return (o.bootId ? o.bootId() : fs.readFileSync(o.bootIdPath || '/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch (e) { return null; } };
    // our id, only if saved in this boot (an id from before a restart may be another app's now)
    const saved = () => {
        try {
            const j = JSON.parse(fs.readFileSync(o.file, 'utf8'));
            if (j.mainConnectionID == null || !j.bootId || j.bootId !== bootId()) return null;
            return j.mainConnectionID;
        } catch (e) { return null; }
    };
    const save = (id) => {
        if (!o.file) return;
        try { if (id == null) fs.unlinkSync(o.file); else fs.writeFileSync(o.file, JSON.stringify({ mainConnectionID: id, bootId: bootId() })); } catch (e) { /* none, or not writable */ }
    };
    /** unavailable again, only when nothing but ours (just disconnected, maybe still listed) is on 287 */
    async function release(ours) {
        const left = (await on287().catch(() => [])).filter((c) => c.mainConnectionID !== ours);
        if (left.length) { log.info('car audio: 287 in use again (' + left.map((c) => c.mainConnectionID).join(', ') + '): left available'); return; }
        await avail(false);
    }
    // a fresh proxy answers "Service unavailable" until the provider is found: wait for it (max 5 s)
    async function proxy(iface) {
        const p = await signals.proxy(iface, '1');
        await new Promise((res) => { const t = setTimeout(res, 5000); signals.onAvailable(p, (a) => { if (a) { clearTimeout(t); res(); } }); });
        return p;
    }
    const avail = (on) => signals.call(am.r, 'hookSourceAvailablityStatusChange',
        { sourceID: SRC, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 } })
        .then(() => log.info('car audio: source ' + (on ? 'available' : 'unavailable')), (e) => log.warn('car audio availability: ' + e));
    /** the main connections on 287 */
    async function on287() {
        const r = await signals.call(am.p, 'getListMainConnections', {});
        const list = Array.isArray(r) ? r : (r && Object.values(r).find(Array.isArray)) || [];
        return list.filter((x) => x && x.sourceID === SRC);
    }
    /** our connection a crash left (in this boot): disconnected, and the source unavailable again */
    async function leftover() {
        const id = saved();
        if (id == null) { save(null); return; }   // none, or one from before a restart: forgotten, never disconnected
        if ((await on287()).some((c) => c.mainConnectionID === id)) {
            log.info('car audio: our leftover ' + id + ' ' + JSON.stringify(await signals.call(am.p, 'disconnect', { mainConnectionID: id })));
            await release(id);
        }
        save(null);
    }
    async function ready() {
        if (am.p) return;
        am.p = await proxy(AM);
        am.r = await proxy(AMR);
        await leftover().catch((e) => log.warn('car audio leftover: ' + e));
    }
    am.q = am.q.then(ready).catch((e) => { am.error = String(e); log.warn('car audio start: ' + e); });

    async function disconnectOurs() {
        if (am.id == null) { am.connected = false; return; }
        const was = am.id;
        log.info('car audio: disconnect ' + JSON.stringify(await signals.call(am.p, 'disconnect', { mainConnectionID: am.id })));
        am.id = null;
        save(null);
        am.connected = false;
        await release(was);
    }
    function want(on) {
        const now = Date.now();
        // our connection gone (the driver chose another source in the car's menu): not taken back while the app
        // goes on wanting the speakers (its music may still be reported playing); a stop, or resume() (the user's
        // play in the app), ends that
        if (!on && am.lost) am.lost = false;
        if (on && am.lost) return;
        // an app that stops when it lets go (yieldStops: Music Assistant pauses): its "on" in the next seconds is the
        // music still reported playing, not a new start; after that, an "on" is one (the user's play) and claims again
        if (on && !am.on && now - am.yieldedAt < 5000) return;
        if (on && !am.on) claim(true);          // from now on this app wants the speakers
        if (!on && am.on) claim(false);
        // called again while on: connected, look for a newer claim every 2 s; taken, look whether 287 is free every
        // second when ours is the newest claim (the other one lets go), else every 3 s
        if (on === am.on) {
            if (!on) return;
            const every = am.connected ? 2000 : am.taken ? (newerClaim() ? 3000 : 1000) : Infinity;
            if (now - am.checked < every) return;
        }
        am.on = on;
        am.checked = now;
        am.q = am.q.then(async () => {
            await ready();
            if (on) {
                if (am.connected && am.id != null) {
                    // ours no longer on 287: the car ended it (another source chosen); the app is told, and the
                    // speakers are not taken back on their own
                    if (!(await on287()).some((c) => c.mainConnectionID === am.id)) {
                        log.info('car audio: our connection ' + am.id + ' is gone (the car switched to another source): not taking the speakers back');
                        am.id = null; save(null); am.connected = false; am.lost = true; am.taken = false;
                        claim(false);
                        if (o.onLost) try { o.onLost(); } catch (e) { log.warn('car audio onLost: ' + e); }
                        return;
                    }
                    // a newer app wants the speakers: ours goes, and the app is told (Music Assistant pauses)
                    const c = newerClaim();
                    if (!c) return;
                    log.info('car audio: ' + c.app + ' wants the speakers (since ' + new Date(c.at).toISOString() + '): letting go');
                    await disconnectOurs();
                    am.taken = true; am.yieldedTo = c.app;
                    if (o.yieldStops) { am.on = false; am.yieldedAt = Date.now(); claim(false); }
                    if (o.onYield) try { o.onYield(c.app); } catch (e) { log.warn('car audio onYield: ' + e); }
                    return;
                }
                // another app's sound on 287: not ours to end; it lets go if our claim is the newer
                const other = (await on287()).filter((c) => c.mainConnectionID !== am.id);
                if (other.length) {
                    if (!am.taken) log.info('car audio: 287 is in use (' + other.map((c) => c.mainConnectionID).join(', ') + '): not connecting' + (newerClaim() ? '' : ' (waiting for it to let go)'));
                    am.taken = true; am.connected = false; am.error = null;
                    return;
                }
                if (am.yieldedTo && newerClaim()) return;   // we let go, and that app still wants the speakers
                am.taken = false; am.yieldedTo = null;
                await avail(true);
                const r = await signals.call(am.p, 'connect', { sourceID: SRC, sinkID: SINK });
                const ok = r && (r.amError === 'E_OK' || r.amError === 0) && r.mainConnectionID != null;
                am.id = ok ? r.mainConnectionID : null;
                save(am.id);
                am.connected = ok;
                am.error = ok ? null : 'connect refused: ' + JSON.stringify(r);
                log.info('car audio: connect ' + JSON.stringify(r));
                if (ok) claim(true);                    // connected now: the newest claim again
                else await release(null);
            } else {
                am.taken = false; am.yieldedTo = null;
                await disconnectOurs();
            }
        }).catch((e) => { am.error = String(e); log.warn('car audio: ' + e); });
    }
    /** the user's play in the app after the car took the speakers: the next want(true) connects again */
    function resume() { if (am.lost) { am.lost = false; am.on = false; } }
    return { want, resume, state: () => ({ on: am.on, connected: am.connected, error: am.error, taken: am.taken, yieldedTo: am.yieldedTo, lost: !!am.lost }) };
}

module.exports = { createCarAudio, SRC, SINK };
