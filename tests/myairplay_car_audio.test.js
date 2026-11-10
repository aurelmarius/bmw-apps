'use strict';
/**
 * The receiver's sound to the speakers (apps/aurelm_myairplay/car_audio.js): node tests/airplay_car_audio.test.js
 * Against a fake audio manager: the order of the calls (as Moonride's), only our own connection ever disconnected (287
 * is shared with Emby), our crash leftover cleared, another app's connection left alone, refusals reported.
 */
const assert = require('assert');
const path = require('path');
const { createCarAudio } = require(path.join(__dirname, '..', 'apps', 'aurelm_myairplay', 'car_audio'));

function fakeSignals(opts) {
    const o = opts || {};
    const calls = [];
    return {
        calls,
        proxy: (iface) => Promise.resolve({ iface }),
        onAvailable: (p, fn) => setImmediate(() => fn(true)),
        call: (p, method, args) => {
            calls.push(method + (args && args.sourceID != null ? ' ' + args.sourceID : '') + (args && args.sinkID != null ? '->' + args.sinkID : '') +
                (args && args.availability ? ' ' + args.availability.availability : '') + (args && args.mainConnectionID != null ? ' #' + args.mainConnectionID : ''));
            if (method === 'getListMainConnections') return Promise.resolve({ listConnections: (o.list || []).slice() });
            if (method === 'disconnect') o.list = (o.list || []).filter((c) => c.mainConnectionID !== args.mainConnectionID);
            if (method === 'connect') {
                if (o.refuse) return Promise.resolve({ amError: 'E_NOT_POSSIBLE' });
                (o.list = o.list || []).push({ mainConnectionID: 42, sourceID: 287 });
                return Promise.resolve({ amError: 'E_OK', mainConnectionID: 42 });
            }
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
}
const log = { info() {}, warn() {} };
const fs = require('fs'), os = require('os');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-')), 'car-audio.json');
// this start of the head unit
const BOOT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boot-')), 'boot_id');
fs.writeFileSync(BOOT, 'boot-now\n');
const opt = (file) => ({ file, bootIdPath: BOOT });
const settle = () => new Promise((r) => setTimeout(r, 50));
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('at start: our own leftover (the saved id) disconnected, the source unavailable; another app\'s left alone', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 7, bootId: 'boot-now' }));
    const s = fakeSignals({ list: [{ mainConnectionID: 7, sourceID: 287 }, { mainConnectionID: 8, sourceID: 1 }] });
    createCarAudio(s, log, opt(file));
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections', 'disconnect #7', 'getListMainConnections', 'hookSourceAvailablityStatusChange 287 A_UNAVAILABLE']);
    assert.ok(!fs.existsSync(file));
});

test('our leftover gone while another app is on 287: the source stays available', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 7, bootId: 'boot-now' }));
    const s = fakeSignals({ list: [{ mainConnectionID: 7, sourceID: 287 }, { mainConnectionID: 9, sourceID: 287 }] });
    createCarAudio(s, log, opt(file));
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections', 'disconnect #7', 'getListMainConnections']);
});

test('an id saved before the head unit restarted: dropped, nothing disconnected', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 9, bootId: 'boot-before' }));
    const s = fakeSignals({ list: [{ mainConnectionID: 9, sourceID: 287 }] });
    createCarAudio(s, log, opt(file));
    await settle();
    assert.deepStrictEqual(s.calls, []);
    assert.ok(!fs.existsSync(file));
});

test('at start without a saved id: nothing touched (a 287 connection is Emby\'s)', async () => {
    const s = fakeSignals({ list: [{ mainConnectionID: 9, sourceID: 287 }] });
    createCarAudio(s, log, opt(tmpFile()));
    await settle();
    assert.deepStrictEqual(s.calls, []);
});

test('287 in use by another app: not connected, reported, connected once it is free', async () => {
    const o = { list: [{ mainConnectionID: 9, sourceID: 287 }] };
    const s = fakeSignals(o);
    const a = createCarAudio(s, log, opt(tmpFile()));
    a.want(true);
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections']);
    assert.deepStrictEqual(a.state(), { on: true, connected: false, error: null, taken: true });
    // off while taken: nothing of the other app's is touched
    a.want(false);
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections']);
    // the other app ends; asked again: connects
    o.list = [];
    a.want(true);
    await settle();
    assert.strictEqual(a.state().connected, true);
    assert.strictEqual(a.state().taken, false);
});

test('on: available, then connect 287 -> 1024; off: disconnect it, unavailable again', async () => {
    const file = tmpFile();
    const s = fakeSignals();
    const a = createCarAudio(s, log, opt(file));
    await settle(); s.calls.length = 0;
    a.want(true); a.want(true);
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections', 'hookSourceAvailablityStatusChange 287 A_AVAILABLE', 'connect 287->1024']);
    assert.deepStrictEqual(a.state(), { on: true, connected: true, error: null, taken: false });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mainConnectionID: 42, bootId: 'boot-now' });
    s.calls.length = 0;
    a.want(false);
    await settle();
    assert.deepStrictEqual(s.calls, ['disconnect #42', 'getListMainConnections', 'hookSourceAvailablityStatusChange 287 A_UNAVAILABLE']);
    assert.strictEqual(a.state().connected, false);
    assert.ok(!fs.existsSync(file));
});

test('a refused connect is reported', async () => {
    const s = fakeSignals({ refuse: true });
    const a = createCarAudio(s, log, opt(tmpFile()));
    a.want(true);
    await settle();
    assert.strictEqual(a.state().connected, false);
    assert.ok(/connect refused/.test(a.state().error));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + String(e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
