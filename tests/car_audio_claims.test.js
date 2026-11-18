'use strict';
/**
 * Source 287 shared by the apps (car_audio.js, the same in TVH Player and myAirPlay here, Music Assistant and Emby in bmw-test-apps): the
 * latest app to want the speakers gets them. node tests/car_audio_claims.test.js. Two apps against one fake audio
 * manager and one claims folder: Music Assistant plays, TVH Player starts: Music Assistant lets go and is told
 * (onYield), TVH Player connects; TVH Player stops: Music Assistant (paused) does not come back on its own. An app
 * with the old rule (no claim) is never taken from. Each copy of the module is checked to be this one.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs'), os = require('os');
const ROOT = path.join(__dirname, '..');
const { createCarAudio } = require(path.join(ROOT, 'apps', 'aurelm_tvhplayer', 'car_audio'));

// one audio manager for both apps: connections by id
function fakeAm() {
    const list = [];
    let next = 40;
    const calls = [];
    const signals = {
        calls, list,
        proxy: (iface) => Promise.resolve({ iface }),
        onAvailable: (p, fn) => setImmediate(() => fn(true)),
        call: (p, method, args) => {
            calls.push(method);
            if (method === 'getListMainConnections') return Promise.resolve({ listConnections: list.slice() });
            if (method === 'disconnect') { const i = list.findIndex((c) => c.mainConnectionID === args.mainConnectionID); if (i >= 0) list.splice(i, 1); }
            if (method === 'connect') { const id = next++; list.push({ mainConnectionID: id, sourceID: 287 }); return Promise.resolve({ amError: 'E_OK', mainConnectionID: id }); }
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
    return signals;
}
const log = { info() {}, warn() {} };
const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claims-'));
const file = () => path.join(dir(), 'car-audio.json');
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('Music Assistant plays, TVH Player starts: Music Assistant lets go (told), TVH Player gets the speakers', async () => {
    const am = fakeAm(), claims = dir();
    const yielded = [];
    const ma = createCarAudio(am, log, { file: file(), app: 'Music Assistant', claimDir: claims, bootId: () => 'b', yieldStops: true, onYield: (by) => yielded.push(by) });
    const tvh = createCarAudio(am, log, { file: file(), app: 'TVH Player', claimDir: claims, bootId: () => 'b' });
    ma.want(true); await settle();
    assert.strictEqual(ma.state().connected, true);
    await settle(10);
    tvh.want(true); await settle();
    assert.strictEqual(tvh.state().taken, true, 'TVH Player finds 287 taken at first');
    // the apps call want() with each status: Music Assistant sees the newer claim within 2 s
    for (let i = 0; i < 30 && !tvh.state().connected; i++) { ma.want(true); tvh.want(true); await settle(150); }
    assert.deepStrictEqual(yielded, ['TVH Player']);
    assert.strictEqual(ma.state().connected, false);
    assert.strictEqual(ma.state().yieldedTo, 'TVH Player');
    assert.strictEqual(tvh.state().connected, true, 'TVH Player connected');
    assert.strictEqual(am.list.length, 1);
    assert.ok(!fs.existsSync(path.join(claims, 'Music_Assistant.json')), 'it withdrew its claim (it stops)');
    // still reported playing for a moment: no claim back (no ping-pong)
    for (let i = 0; i < 4; i++) { ma.want(true); tvh.want(true); await settle(150); }
    assert.strictEqual(tvh.state().connected, true, 'TVH Player keeps them');
    // Music Assistant paused: it no longer wants the speakers; TVH Player keeps them
    ma.want(false); await settle();
    for (let i = 0; i < 5; i++) { tvh.want(true); await settle(100); }
    assert.strictEqual(tvh.state().connected, true);
    assert.ok(!fs.existsSync(path.join(claims, 'Music_Assistant.json')), 'its claim gone');
    // TVH Player stops: 287 free; Music Assistant, paused, does not come back by itself
    tvh.want(false); await settle();
    assert.strictEqual(am.list.length, 0);
    assert.strictEqual(ma.state().connected, false);
});

test('a play in the app that let go, after a while: it claims again and gets the speakers back', async () => {
    const am = fakeAm(), claims = dir();
    const ma = createCarAudio(am, log, { file: file(), app: 'Music Assistant', claimDir: claims, bootId: () => 'b', yieldStops: true, onYield: () => {} });
    const tvh = createCarAudio(am, log, { file: file(), app: 'TVH Player', claimDir: claims, bootId: () => 'b' });
    ma.want(true); await settle(); await settle(10);
    tvh.want(true);
    for (let i = 0; i < 30 && !tvh.state().connected; i++) { ma.want(true); tvh.want(true); await settle(150); }
    assert.strictEqual(tvh.state().connected, true);
    ma.want(false);
    await settle(5100);                      // paused a while, then the user presses play
    ma.want(true);
    for (let i = 0; i < 40 && !ma.state().connected; i++) { ma.want(true); tvh.want(true); await settle(150); }
    assert.strictEqual(ma.state().connected, true, 'Music Assistant has them again');
    assert.strictEqual(tvh.state().yieldedTo, 'Music Assistant', 'TVH Player let go (and waits)');
});

test('while the newer app holds the speakers, the one that let go waits even if it still wants them', async () => {
    const am = fakeAm(), claims = dir();
    const tvh = createCarAudio(am, log, { file: file(), app: 'TVH Player', claimDir: claims, bootId: () => 'b' });
    const ma = createCarAudio(am, log, { file: file(), app: 'Music Assistant', claimDir: claims, bootId: () => 'b' });
    tvh.want(true); await settle();
    await settle(10);
    ma.want(true); await settle();
    for (let i = 0; i < 30 && !ma.state().connected; i++) { tvh.want(true); ma.want(true); await settle(150); }
    assert.strictEqual(ma.state().connected, true, 'the newer one (Music Assistant) has them');
    assert.strictEqual(tvh.state().yieldedTo, 'Music Assistant');
    for (let i = 0; i < 8; i++) { tvh.want(true); ma.want(true); await settle(150); }
    assert.strictEqual(tvh.state().connected, false, 'TVH Player waits');
    assert.strictEqual(am.list.length, 1);
    // Music Assistant stops: TVH Player (still wanting) gets them back
    ma.want(false); await settle();
    for (let i = 0; i < 30 && !tvh.state().connected; i++) { tvh.want(true); await settle(150); }
    assert.strictEqual(tvh.state().connected, true);
});

test('an app with the old rule (no claim) holding 287 is never taken from: the new one waits', async () => {
    const am = fakeAm(), claims = dir();
    am.list.push({ mainConnectionID: 9, sourceID: 287 });   // the old app's connection, no claim file
    const ma = createCarAudio(am, log, { file: file(), app: 'Music Assistant', claimDir: claims, bootId: () => 'b' });
    for (let i = 0; i < 6; i++) { ma.want(true); await settle(200); }
    assert.strictEqual(ma.state().connected, false);
    assert.strictEqual(ma.state().taken, true);
    assert.deepStrictEqual(am.list.map((c) => c.mainConnectionID), [9]);
});

test('every app\'s copy of car_audio.js has the same code as Music Assistant\'s', () => {
    const body = (f) => { const s = fs.readFileSync(f, 'utf8'); return s.slice(s.indexOf("const AM = '")); };
    const ref = body(path.join(ROOT, 'apps', 'aurelm_tvhplayer', 'car_audio.js'));
    ['aurelm_myairplay'].forEach((a) => assert.strictEqual(body(path.join(ROOT, 'apps', a, 'car_audio.js')), ref, a));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
