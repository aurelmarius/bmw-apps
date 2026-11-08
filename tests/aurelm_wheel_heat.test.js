'use strict';
/**
 * Wheel Heating's switching (apps/aurelm_wheel_heat/heat.js) against a made-up car: node tests/aurelm_wheel_heat.test.js
 * The fake climate service answers like ClimateMaster (Accepted enum, status field notified after a
 * request it takes); the fake body service like SteeringWheelClimate.
 */
const assert = require('assert');
const path = require('path');
const { WheelHeat, acceptedName } = require(path.join(__dirname, '..', 'apps', 'aurelm_wheel_heat', 'heat.js'));

const quiet = { info() {}, warn() {}, error() {} };

/** A car: climate = { takes: [group ids], level, min, max } or null; body = { heating } or null. */
function fakeCar(cfg) {
    const car = { calls: [], subs: {} };
    const climate = cfg.climate, body = cfg.body;
    const status = () => ({ configuredIntensityLevel: climate.level, actualIntensityLevel: climate.level, availableRange: { minValue: climate.min || 0, maxValue: climate.max || 1 }, saveLUM: false });
    car.signals = {
        async watch(iface, inst, handlers) {
            const isClimate = iface === WheelHeat.CLIMATE;
            const there = isClimate ? climate : body;
            if (!there) return { iface, available: false, proxy: null, error: 'no SOME/IP config for ' + iface };
            const proxy = {
                iface,
                async getValue(field) {
                    if (field === 'statusSteeringWheelHeating') return status();
                    if (field === 'statusAvailableSteeringWheelHeating') return { steeringWheelHeatingAvailable: true, priorityClientID: 0 };
                    if (field === 'heatingState') return { functionalityCoded: true, availability: true, heating: body.heating };
                    throw new Error('no field ' + field);
                },
            };
            const sub = { iface, available: !(isClimate && climate.unavailable), proxy, error: null, handlers };
            car.subs[isClimate ? 'climate' : 'body'] = sub;
            // the initial getValue the kit does (only while the provider is there)
            if (sub.available) for (const f of Object.keys(handlers)) handlers[f](await proxy.getValue(f));
            return sub;
        },
        async call(proxy, method, args) {
            car.calls.push({ method, args: JSON.parse(JSON.stringify(args)) });
            if (method === 'requestSteeringWheelHeating') {
                if (climate.fail) throw new Error(climate.fail);
                if (climate.takes.indexOf(args.clientGroupId) < 0) return { accepted: climate.enumAsName ? 'NOT_ACCEPTED_LOW_PRIORITY' : 6 };
                const changed = climate.level !== args.steeringWheelHeating;
                climate.level = args.steeringWheelHeating;
                if (changed && !climate.silent) setTimeout(() => car.subs.climate.handlers.statusSteeringWheelHeating(status()), 50);
                return { accepted: changed ? 1 : 0 };
            }
            if (method === 'requestHeating') {
                body.heating = args.heating;
                setTimeout(() => car.subs.body.handlers.heatingState({ functionalityCoded: true, availability: true, heating: body.heating }), 50);
                return {};
            }
            throw new Error('no method ' + method);
        },
    };
    if (climate && climate.setter) {
        car.signals.set = async (proxy, field, value) => {
            car.calls.push({ method: 'set ' + field, args: JSON.parse(JSON.stringify(value)) });
            if (climate.setter === 'ignored') return;
            climate.level = value.configuredIntensityLevel;
            setTimeout(() => car.subs.climate.handlers.statusSteeringWheelHeating({ statusSteeringWheelHeating: status() }), 50);
        };
    }
    return car;
}

function make(car, s) {
    const learned = [];
    const set = Object.assign({ clientGroupId: 0, path: 'auto', probe: true }, s || {});
    const h = new WheelHeat(car.signals, quiet, {
        clientGroupId: () => set.clientGroupId, path: () => set.path, probe: () => set.probe,
        onLearn: (id) => { learned.push(id); set.clientGroupId = id; }, confirmMs: 1500,
    });
    return { h, learned, set };
}

const tests = {
    async 'climate service takes group 0: off -> on -> off'() {
        const car = fakeCar({ climate: { takes: [0], level: 0 }, body: null });
        const { h } = make(car);
        await h.init();
        assert.strictEqual(h.isOn(), false);
        let r = await h.toggle();
        assert.ok(r.ok && r.confirmed && r.on === true && r.via === 'climate', JSON.stringify(r));
        assert.deepStrictEqual(car.calls[0].args, { clientGroupId: 0, steeringWheelHeating: 1, saveLUM: false });
        r = await h.toggle();
        assert.ok(r.ok && r.on === false, JSON.stringify(r));
        assert.strictEqual(car.calls[1].args.steeringWheelHeating, 0);
    },
    async 'a turned-down group: tries the others and keeps the one taken'() {
        const car = fakeCar({ climate: { takes: [2], level: 0 }, body: null });
        const { h, learned, set } = make(car);
        await h.init();
        const r = await h.toggle();
        assert.ok(r.ok && r.clientGroupId === 2, JSON.stringify(r));
        assert.deepStrictEqual(car.calls.map((c) => c.args.clientGroupId), [0, 1, 2]);
        assert.deepStrictEqual(learned, [2]);
        car.calls.length = 0;
        await h.toggle();
        assert.deepStrictEqual(car.calls.map((c) => c.args.clientGroupId), [2], 'asks with the learned group first');
        assert.strictEqual(set.clientGroupId, 2);
    },
    async 'probing off: one request only'() {
        const car = fakeCar({ climate: { takes: [3], level: 0, enumAsName: true }, body: null });
        const { h } = make(car, { probe: false });
        await h.init();
        const r = await h.toggle();
        assert.ok(!r.ok && r.answer === 'NOT_ACCEPTED_LOW_PRIORITY', JSON.stringify(r));
        assert.strictEqual(car.calls.length, 1);
    },
    async 'climate service turns every group down: falls back to the steering wheel service'() {
        const car = fakeCar({ climate: { takes: [], level: 0 }, body: { heating: false } });
        const { h } = make(car);
        await h.init();
        const r = await h.toggle();
        assert.ok(r.ok && r.via === 'body' && r.climate === 'NOT_ACCEPTED_LOW_PRIORITY', JSON.stringify(r));
        assert.deepStrictEqual(car.calls.pop().args, { requestor: [0, 0, 0, 0, 0], heating: true });
    },
    async 'no climate service on the unit: steering wheel service'() {
        const car = fakeCar({ climate: null, body: { heating: true } });
        const { h } = make(car);
        await h.init();
        assert.strictEqual(h.isOn(), true);
        const r = await h.toggle();
        assert.ok(r.ok && r.via === 'body' && r.on === false && r.confirmed, JSON.stringify(r));
    },
    async 'path "climate": no fallback'() {
        const car = fakeCar({ climate: { takes: [], level: 0 }, body: { heating: false } });
        const { h } = make(car, { path: 'climate', probe: false });
        await h.init();
        const r = await h.toggle();
        assert.ok(!r.ok && r.via === 'climate', JSON.stringify(r));
        assert.ok(car.calls.every((c) => c.method === 'requestSteeringWheelHeating'));
    },
    async 'a method error does not try the other groups'() {
        const car = fakeCar({ climate: { takes: [0], level: 0, fail: 'timeout' }, body: null });
        const { h } = make(car, { path: 'climate' });
        await h.init();
        const r = await h.toggle();
        assert.ok(!r.ok && /timeout/.test(r.answer), JSON.stringify(r));
        assert.strictEqual(car.calls.length, 1);
    },
    async '"always on" when already on: NO_CHANGES counts as done'() {
        const car = fakeCar({ climate: { takes: [0], level: 1 }, body: null });
        const { h } = make(car);
        await h.init();
        const r = await h.toggle(true);
        assert.ok(r.ok && r.answer === 'NO_CHANGES' && r.confirmed, JSON.stringify(r));
    },
    async 'three heating levels: on = the highest, off = the lowest'() {
        const car = fakeCar({ climate: { takes: [0], level: 0, min: 0, max: 3 }, body: null });
        const { h } = make(car);
        await h.init();
        await h.toggle();
        assert.strictEqual(car.calls[0].args.steeringWheelHeating, 3);
        await h.toggle();
        assert.strictEqual(car.calls[1].args.steeringWheelHeating, 0);
    },
    async 'taken but never reported: ok, not confirmed'() {
        const car = fakeCar({ climate: { takes: [0], level: 0, silent: true }, body: null });
        const { h } = make(car);
        await h.init();
        // the status read back reports the new level, so stop that too
        car.subs.climate.proxy.getValue = async () => ({ configuredIntensityLevel: 0, actualIntensityLevel: 0, availableRange: { minValue: 0, maxValue: 1 } });
        const r = await h.toggle();
        assert.ok(r.ok && r.confirmed === false && /not confirmed/.test(r.msg), JSON.stringify(r));
    },
    async 'two presses at once: one request'() {
        const car = fakeCar({ climate: { takes: [0], level: 0 }, body: null });
        const { h } = make(car);
        await h.init();
        const [a, b] = await Promise.all([h.toggle(), h.toggle()]);
        assert.strictEqual(a, b);
        assert.strictEqual(car.calls.length, 1);
    },
    async 'method turned down: the status field is written instead (notified wrapped in its name)'() {
        const car = fakeCar({ climate: { takes: [], level: 0, setter: true }, body: { heating: false } });
        const { h } = make(car);
        await h.init();
        const r = await h.toggle();
        assert.ok(r.ok && r.via === 'climate-set' && r.confirmed && r.on === true, JSON.stringify(r));
        const set = car.calls.find((c) => c.method === 'set statusSteeringWheelHeating');
        assert.strictEqual(set.args.configuredIntensityLevel, 1);
        assert.ok(!car.calls.some((c) => c.method === 'requestHeating'), 'no body request');
    },
    async 'a write that changes nothing: on to the steering wheel service'() {
        const car = fakeCar({ climate: { takes: [], level: 0, setter: 'ignored' }, body: { heating: false } });
        const { h } = make(car);
        await h.init();
        const r = await h.toggle();
        assert.ok(r.ok && r.via === 'body', JSON.stringify(r));
        assert.ok(h.history.some((x) => x.answer === 'SET_NO_EFFECT'));
    },
    async 'climate service without a provider (a G20 with iDrive 7): not asked, the steering wheel service switches'() {
        const car = fakeCar({ climate: { takes: [0], level: 0, setter: true, unavailable: true }, body: { heating: true } });
        const { h } = make(car);
        await h.init();
        assert.strictEqual(h.isOn(), true, 'state from the steering wheel service');
        const r = await h.toggle();
        assert.ok(r.ok && r.via === 'body' && r.on === false && r.confirmed, JSON.stringify(r));
        assert.deepStrictEqual(car.calls.map((c) => c.method), ['requestHeating'], 'no climate calls');
    },
    async 'accepted enum as number, name or struct'() {
        assert.strictEqual(acceptedName({ accepted: 1 }), 'IS_ACCEPTED');
        assert.strictEqual(acceptedName('NOT_ACCEPTED_DEFROST'), 'NOT_ACCEPTED_DEFROST');
        assert.strictEqual(acceptedName(6), 'NOT_ACCEPTED_LOW_PRIORITY');
        assert.strictEqual(acceptedName(undefined), 'NO_ANSWER');
    },
};

(async () => {
    let failed = 0;
    for (const [name, fn] of Object.entries(tests)) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
    process.exit(failed ? 1 : 0);
})();
