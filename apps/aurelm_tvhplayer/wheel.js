'use strict';
/**
 * wheel.js - skip on the steering wheel changes the channel: right (>) the next one, left (<) the one before, while a
 * channel is on and the setting lets it.
 *
 * The buttons reach apps through de.bmw.infotainment.controlelements.SteeringWheelPushButton, instance 1, field
 * statusSearchSwitch1 (bmw-test-apps' Media Probe 0.1.2 in the car, 2026-11-13: skip, volume, the knurled wheel and the
 * special buttons all come to an app): its operationPushButtonAudioAutomaticTuningSteeringWheel is
 * SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS (right) or SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS (left) while the button is down,
 * and KEINE_AKTION once it is let go. The channel changes when it is let go, once a press (as Music Assistant's next /
 * previous track, apps/aurelm_music/main.js in bmw-test-apps); a press while nothing plays does nothing, so the
 * radio, Music Assistant or another app keeps its own skip.
 *
 *   const wheel = createWheel({ zap(dir), enabled(), active(), now, log });
 *   wheel.onSwitch(value)   the field's value (the struct, or the string)
 *   wheel.state()           { on, seen, last }: the Status tab's Wheel row
 */
const IFACE = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';
const FIELD = 'statusSearchSwitch1';

function createWheel(o) {
    const now = o.now || Date.now;
    const log = o.log || { info() {} };
    let down = null, seen = false, last = '';
    function onSwitch(v) {
        const val = v && typeof v === 'object' ? v.operationPushButtonAudioAutomaticTuningSteeringWheel : v;
        if (!val || typeof val !== 'string') return;
        if (/SKIP_RECHTS|SKIP_LINKS/.test(val)) {
            if (!down) down = { dir: /RECHTS/.test(val) ? 1 : -1, at: now() };
            return;
        }
        if (!/KEINE_AKTION/.test(val) || !down) return;
        const d = down;
        down = null;
        if (!o.enabled() || !o.active()) return;
        seen = true;
        last = d.dir > 0 ? 'channel + (skip >)' : 'channel - (skip <)';
        log.info('tvh: wheel ' + last);
        o.zap(d.dir);
    }
    return { onSwitch, state: () => ({ on: !!o.enabled(), seen, last }) };
}

module.exports = { createWheel, IFACE, FIELD };
