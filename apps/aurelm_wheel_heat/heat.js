'use strict';
/**
 * heat.js - steering wheel heating over SOME/IP, the way the voice assistant does it.
 *
 * Two services on the unit's catalog can switch it:
 *   ClimateMaster (de.bmw.infotainment.climate.climatemaster.ClimateMaster, the head unit's climate
 *   service - what the voice command and the iDrive 8 climate menu use):
 *     field  statusSteeringWheelHeating  { configuredIntensityLevel, actualIntensityLevel,
 *                                          availableRange { minValue, maxValue }, saveLUM }
 *     field  statusAvailableSteeringWheelHeating { steeringWheelHeatingAvailable, priorityClientID }
 *     method requestSteeringWheelHeating(clientGroupId, steeringWheelHeating = level, saveLUM)
 *            -> accepted (ClimateMasterTypes.Accepted)
 *     statusSteeringWheelHeating also has a setter: written with the level when the method is
 *     turned down
 *   SteeringWheelClimate (de.bmw.body.steeringwheelcomfort.SteeringWheelClimate, the body service):
 *     field  heatingState { functionalityCoded, availability, heating }
 *     method requestHeating(requestor = 5 bytes, heating)   (fire and forget: no reply)
 *
 * Which client group the climate service takes from a custom app is not documented: with "probe"
 * on, a request it turns down is tried again with the other group ids (0-7) and the one it takes
 * is kept (onLearn). Every answer is in last / history for the app's details page.
 */
const EventEmitter = require('events');

const CLIMATE = 'de.bmw.infotainment.climate.climatemaster.ClimateMaster';
const BODY = 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate';

const ACCEPTED = {
    0: 'NO_CHANGES', 1: 'IS_ACCEPTED', 2: 'NOT_ACCEPTED', 3: 'NOT_ACCEPTED_DEFROST', 4: 'NOT_ACCEPTED_MANUAL_MODE',
    5: 'NOT_ACCEPTED_FOG', 6: 'NOT_ACCEPTED_LOW_PRIORITY', 7: 'NOT_ACCEPTED_MAX_VALUE', 8: 'NOT_ACCEPTED_MIN_VALUE',
};
/** The method's answer as a name (the binding hands enums over as names or numbers, alone or in a struct). */
function acceptedName(r) {
    let v = r;
    if (v && typeof v === 'object') v = 'accepted' in v ? v.accepted : v[Object.keys(v)[0]];
    if (typeof v === 'number') return ACCEPTED[v] || 'UNKNOWN_' + v;
    return v === undefined || v === null ? 'NO_ANSWER' : String(v);
}
const isOk = (name) => name === 'IS_ACCEPTED' || name === 'NO_CHANGES';
// a turned-down request worth trying with another client group
const RETRY = ['NOT_ACCEPTED', 'NOT_ACCEPTED_LOW_PRIORITY'];

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
/**
 * The struct that holds `key`, however the binding hands the field over: plain, wrapped in the
 * field's name, or as a one-entry list (as idrive7-apps' eDrive reads the same services).
 */
function holder(v, key, depth) {
    if (!v || typeof v !== 'object' || (depth || 0) > 4) return null;
    if (key in v) return v;
    for (const k of Object.keys(v)) { const h = holder(v[k], key, (depth || 0) + 1); if (h) return h; }
    return null;
}
const unwrap = (v, key) => holder(v, key) || v;

class WheelHeat extends EventEmitter {
    /**
     * signals: kit/signals.js (watch / call); opts:
     *   clientGroupId() -> the group id to ask with first
     *   path()          -> 'auto' | 'climate' | 'body'
     *   probe()         -> try the other group ids when the climate service turns a request down
     *   onLearn(id)     -> a group id the climate service took (other than the first one)
     *   confirmMs       -> how long to wait for the car to report the new state (default 3000)
     */
    constructor(signals, log, opts) {
        super();
        this.signals = signals; this.log = log; this.o = opts || {};
        this.climate = { sub: null, status: null, avail: null, t: 0 };
        this.body = { sub: null, state: null, t: 0 };
        this.last = null;          // last toggle's result
        this.history = [];         // every request sent: { t, via, args, answer }
        this.busy = null;
    }

    async init() {
        const s = this.signals;
        const [c, b] = await Promise.all([
            s.watch(CLIMATE, '1', {
                statusSteeringWheelHeating: (v) => { this.climate.status = unwrap(v, 'availableRange'); this.climate.t = Date.now(); this._changed('climate'); },
                statusAvailableSteeringWheelHeating: (v) => { this.climate.avail = unwrap(v, 'steeringWheelHeatingAvailable'); this._changed('climate availability'); },
            }, this.log),
            s.watch(BODY, '1', {
                heatingState: (v) => { this.body.state = unwrap(v, 'heating'); this.body.t = Date.now(); this._changed('body'); },
            }, this.log),
        ]);
        this.climate.sub = c; this.body.sub = b;
        this.log.info('ClimateMaster ' + (c.error ? 'error: ' + c.error : 'ready (available=' + c.available + ')') +
            ', SteeringWheelClimate ' + (b.error ? 'error: ' + b.error : 'ready (available=' + b.available + ')'));
        return this;
    }

    _changed(why) {
        this.log.info('state (' + why + '): ' + JSON.stringify(this.state()));
        this.emit('change', this.state());
    }

    /** Heating level range from the climate service (0..1 on a plain on/off wheel). */
    range() {
        const r = this.climate.status && this.climate.status.availableRange;
        const min = r && num(r.minValue) !== undefined ? r.minValue : 0;
        let max = r && num(r.maxValue) !== undefined ? r.maxValue : 1;
        if (max <= min) max = min + 1;
        return { min, max };
    }

    /** Is the heating on: true / false, or null while no service has said. */
    isOn() {
        const st = this.climate.status;
        if (st) {
            const lvl = num(st.configuredIntensityLevel) !== undefined ? st.configuredIntensityLevel : num(st.actualIntensityLevel);
            if (lvl !== undefined) return lvl > this.range().min;
        }
        const bs = this.body.state;
        if (bs && typeof bs.heating === 'boolean') return bs.heating;
        return null;
    }

    state() {
        const st = this.climate.status || {}, av = this.climate.avail || {}, bs = this.body.state || {};
        return {
            on: this.isOn(),
            climate: {
                service: !!(this.climate.sub && this.climate.sub.available), error: this.climate.sub && this.climate.sub.error,
                configured: st.configuredIntensityLevel, actual: st.actualIntensityLevel, range: st.availableRange,
                available: av.steeringWheelHeatingAvailable, priorityClient: av.priorityClientID,
            },
            body: {
                service: !!(this.body.sub && this.body.sub.available), error: this.body.sub && this.body.sub.error,
                coded: bs.functionalityCoded, available: bs.availability, heating: bs.heating,
            },
        };
    }

    /** Read both states again now (fields only notify on change). */
    async refresh() {
        const get = (sub, field, fn) => (sub && sub.proxy && sub.available
            ? sub.proxy.getValue(field, 1500).then(fn).catch((e) => this.log.warn('get ' + field + ': ' + e))
            : Promise.resolve());
        await Promise.all([
            get(this.climate.sub, 'statusSteeringWheelHeating', (v) => { this.climate.status = unwrap(v, 'availableRange'); this.climate.t = Date.now(); }),
            get(this.climate.sub, 'statusAvailableSteeringWheelHeating', (v) => { this.climate.avail = unwrap(v, 'steeringWheelHeatingAvailable'); }),
            get(this.body.sub, 'heatingState', (v) => { this.body.state = unwrap(v, 'heating'); this.body.t = Date.now(); }),
        ]);
        return this.state();
    }

    /** Toggle (want = undefined), or switch on (true) / off (false). Resolves with the result. */
    toggle(want) {
        if (this.busy) return this.busy;      // one request at a time
        this.busy = this._toggle(want).catch((e) => ({ ok: false, msg: String(e && e.message || e) }))
            .then((r) => { this.last = Object.assign({ t: Date.now() }, r); this.busy = null; this.emit('result', this.last); this.log.info('result: ' + JSON.stringify(this.last)); return this.last; });
        return this.busy;
    }

    async _toggle(want) {
        await this.refresh();
        const before = this.isOn();
        // state not known: the shortcut is most likely pressed to warm the wheel
        const on = typeof want === 'boolean' ? want : before === null ? true : !before;
        const path = (this.o.path && this.o.path()) || 'auto';
        let res = null;
        if (path !== 'body') res = await this._viaClimate(on);
        if (path === 'body' || (path === 'auto' && (!res || !res.ok))) {
            const prev = res;
            const body = await this._viaBody(on);
            // no steering wheel service either: the climate service's answer says more
            if (prev && body.answer === 'NO_SERVICE') res = prev;
            else { res = body; if (prev) res.climate = prev.answer; }
        }
        if (!res.ok) return Object.assign({ want: on, before }, res);
        const confirmed = await this._confirm(on);
        return Object.assign({ want: on, before, confirmed, on: this.isOn() }, res,
            { msg: (on ? 'Heating on' : 'Heating off') + (confirmed ? '' : ' (requested, the car has not confirmed yet)') });
    }

    async _viaClimate(on) {
        const sub = this.climate.sub;
        if (!sub || !sub.proxy) return { ok: false, via: 'climate', answer: 'NO_SERVICE', msg: 'climate service not reachable' + (sub && sub.error ? ': ' + sub.error : '') };
        // not offered on this car (no provider: every call answers "Service unavailable"): not asked
        if (!sub.available) return { ok: false, via: 'climate', answer: 'NO_SERVICE', msg: 'climate service not available on this car' };
        const { min, max } = this.range();
        const level = on ? max : min;
        const first = Number(this.o.clientGroupId ? this.o.clientGroupId() : 0) || 0;
        const ids = [first];
        if (this.o.probe && this.o.probe()) for (let i = 0; i <= 7; i++) if (i !== first) ids.push(i);
        let answer = 'NO_ANSWER';
        for (const id of ids) {
            const args = { clientGroupId: id, steeringWheelHeating: level, saveLUM: false };
            try {
                const r = await this.signals.call(sub.proxy, 'requestSteeringWheelHeating', args, 3000);
                answer = acceptedName(r);
            } catch (e) {
                answer = 'ERROR: ' + (e && e.message || e);
            }
            this._remember('climate', args, answer);
            if (isOk(answer)) {
                if (id !== first && this.o.onLearn) this.o.onLearn(id);
                return { ok: true, via: 'climate', clientGroupId: id, level, answer };
            }
            if (RETRY.indexOf(answer) < 0) break;      // an error, defrost, max/min...: another id won't help
        }
        // the status field has a setter too (id 119 in the catalog): write the level there
        const set = await this._viaClimateSetter(sub, level);
        if (set.ok) return Object.assign(set, { method: answer });
        return { ok: false, via: 'climate', answer, setter: set.answer, msg: 'climate service: ' + answer };
    }

    async _viaClimateSetter(sub, level) {
        if (!this.signals.set) return { ok: false, answer: 'NO_SETTER' };
        const cur = this.climate.status || {};
        const value = {
            configuredIntensityLevel: level,
            actualIntensityLevel: num(cur.actualIntensityLevel) !== undefined ? cur.actualIntensityLevel : level,
            availableRange: cur.availableRange || { minValue: this.range().min, maxValue: this.range().max },
            saveLUM: false,
        };
        try {
            await this.signals.set(sub.proxy, 'statusSteeringWheelHeating', value, 3000);
            // a write the provider takes need not switch anything: only a reported change counts,
            // else the next path is tried
            const done = await this._confirm(level > this.range().min);
            const answer = done ? 'SET' : 'SET_NO_EFFECT';
            this._remember('climate-set', value, answer);
            return { ok: done, via: 'climate-set', level, answer };
        } catch (e) {
            const answer = 'ERROR: ' + (e && e.message || e);
            this._remember('climate-set', value, answer);
            return { ok: false, via: 'climate-set', answer };
        }
    }

    async _viaBody(on) {
        const sub = this.body.sub;
        if (!sub || !sub.proxy) return { ok: false, via: 'body', answer: 'NO_SERVICE', msg: 'steering wheel service not reachable' + (sub && sub.error ? ': ' + sub.error : '') };
        const args = { requestor: [0, 0, 0, 0, 0], heating: !!on };
        try {
            await this.signals.call(sub.proxy, 'requestHeating', args, 3000);
            this._remember('body', args, 'SENT');
            return { ok: true, via: 'body', answer: 'SENT' };
        } catch (e) {
            const answer = 'ERROR: ' + (e && e.message || e);
            this._remember('body', args, answer);
            return { ok: false, via: 'body', answer, msg: 'steering wheel service: ' + answer };
        }
    }

    _remember(via, args, answer) {
        this.history.unshift({ t: Date.now(), via, args, answer });
        this.history.length = Math.min(this.history.length, 12);
        this.log.info('request ' + via + ' ' + JSON.stringify(args) + ' -> ' + answer);
    }

    /** Wait for a service to report state `on` (fields notify on change; read again meanwhile). */
    async _confirm(on) {
        const until = Date.now() + (this.o.confirmMs || 3000);
        while (Date.now() < until) {
            if (this.isOn() === on) return true;
            await new Promise((r) => setTimeout(r, 400));
            await this.refresh();
        }
        return this.isOn() === on;
    }
}

WheelHeat.CLIMATE = CLIMATE;
WheelHeat.BODY = BODY;
WheelHeat.acceptedName = acceptedName;
module.exports = { WheelHeat, acceptedName };
