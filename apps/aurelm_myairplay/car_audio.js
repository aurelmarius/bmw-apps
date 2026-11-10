'use strict';
/**
 * car_audio.js - stage 3: the receiver's sound on the car's speakers, through the audio manager.
 *
 * The receiver plays into SmartXbar's input for CarLife, source 287 (unused in Europe); the GENIVI audio manager
 * routes it to the main speakers, MediaSink_Front (1024), as Moonride does (its main.js, JustAnotherPU,
 * GPL-3.0-or-later): 287 is A_UNAVAILABLE without a CarLife phone and a connect to it would stay CS_CONNECTING for
 * ever, so it is marked available through the routing interface first; one connect while the sound is wanted, one
 * disconnect after it, in order.
 *
 * 287 is shared: the Emby app (aurelm-emby) plays into it too. So this module touches only its own connection: its
 * mainConnectionID is kept in a file (`file`, { mainConnectionID, bootId }, the same form as Emby's), and only that id
 * is ever disconnected, also the one a crash left. An id saved before the head unit restarted is not ours any more
 * (the audio manager numbers its connections afresh): the file is dropped, nothing disconnected. A 287 connection
 * that is not ours is left alone, and the sound is not connected over it: the state says the speakers are taken.
 * The source is marked unavailable only when no connection is left on 287 (the other app may have connected meanwhile).
 *
 *   const audio = createCarAudio(ctx.signals, log);
 *   audio.want(true | false);     // the receiver has an iPhone with sound and the app is up
 *   audio.state()                 // { on, connected, error }
 */
const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const SRC = 287, SINK = 1024;

function createCarAudio(signals, log, opts) {
    const o = opts || {};
    const fs = o.fs || require('fs');
    const am = { p: null, r: null, id: null, on: false, q: Promise.resolve(), connected: false, error: null, taken: false };
    // our connection's id, kept across a crash; null: none of ours
    const bootId = () => { try { return fs.readFileSync(o.bootIdPath || '/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; } };
    const saved = () => {
        try {
            const v = JSON.parse(fs.readFileSync(o.file, 'utf8'));
            // from an earlier start of the head unit: that number may now be another app's connection
            if (v.mainConnectionID == null || !v.bootId || v.bootId !== bootId()) return null;
            return v.mainConnectionID;
        } catch (e) { return null; }
    };
    const save = (id) => {
        if (!o.file) return;
        try { if (id == null) fs.unlinkSync(o.file); else fs.writeFileSync(o.file, JSON.stringify({ mainConnectionID: id, bootId: bootId() })); } catch (e) { /* none, or not writable */ }
    };
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
    /** our connection a crash or a power-off left: disconnected, and the source unavailable again */
    async function leftover() {
        const id = saved();
        if (id == null) { save(null); return; }   // none, or from an earlier start: dropped
        if ((await on287()).some((c) => c.mainConnectionID === id)) {
            log.info('car audio: our leftover ' + id + ' ' + JSON.stringify(await signals.call(am.p, 'disconnect', { mainConnectionID: id })));
            await release();
        }
        save(null);
    }
    /** the source unavailable, unless another app's connection is on it now */
    async function release() {
        const left = await on287();
        if (left.length) { log.info('car audio: 287 still in use (' + left.map((c) => c.mainConnectionID).join(', ') + '): left available'); return; }
        await avail(false);
    }
    async function ready() {
        if (am.p) return;
        am.p = await proxy(AM);
        am.r = await proxy(AMR);
        await leftover().catch((e) => log.warn('car audio leftover: ' + e));
    }
    am.q = am.q.then(ready).catch((e) => { am.error = String(e); log.warn('car audio start: ' + e); });

    function want(on) {
        // while another app holds 287, look again every few seconds: once it is free, the sound goes on
        if (on === am.on && !(on && am.taken && Date.now() - am.checked >= 3000)) return;
        am.on = on;
        am.checked = Date.now();
        am.q = am.q.then(async () => {
            await ready();
            if (on) {
                // another app's sound on 287 (Emby): not ours to take or to end
                const other = (await on287()).filter((c) => c.mainConnectionID !== am.id);
                if (other.length) {
                    am.taken = true; am.connected = false; am.error = null;
                    log.info('car audio: 287 is in use (' + other.map((c) => c.mainConnectionID).join(', ') + '): not connecting');
                    return;
                }
                am.taken = false;
                await avail(true);
                const r = await signals.call(am.p, 'connect', { sourceID: SRC, sinkID: SINK });
                const ok = r && (r.amError === 'E_OK' || r.amError === 0) && r.mainConnectionID != null;
                am.id = ok ? r.mainConnectionID : null;
                save(am.id);
                am.connected = ok;
                am.error = ok ? null : 'connect refused: ' + JSON.stringify(r);
                log.info('car audio: connect ' + JSON.stringify(r));
                if (!ok) await release();
            } else {
                am.taken = false;
                if (am.id == null) { am.connected = false; return; }
                log.info('car audio: disconnect ' + JSON.stringify(await signals.call(am.p, 'disconnect', { mainConnectionID: am.id })));
                am.id = null;
                save(null);
                am.connected = false;
                await release();
            }
        }).catch((e) => { am.error = String(e); log.warn('car audio: ' + e); });
    }
    return { want, state: () => ({ on: am.on, connected: am.connected, error: am.error, taken: am.taken }) };
}

module.exports = { createCarAudio, SRC, SINK };
