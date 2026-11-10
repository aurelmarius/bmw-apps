'use strict';
/**
 * The picture over the screen (apps/aurelm_myairplay/mirror_view.js): node tests/airplay_mirror_view.test.js
 * Against a fake mgu-render client: when it is shown and hidden, the frame file named, the keepalive frames.
 */
const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');
const { createMirrorView, VID } = require(path.join(__dirname, '..', 'apps', 'aurelm_myairplay', 'mirror_view'));
const record = require(path.join(__dirname, '..', 'kit', 'runtime', 'record'));

class FakeGpu extends EventEmitter {
    constructor() { super(); this.calls = []; this.placement = null; }
    connect() { this.calls.push('connect'); }
    mode(m) { this.calls.push('mode ' + m); }
    place(p) { this.placement = p; this.calls.push('place ' + p.w + 'x' + p.h); }
    claim(r) { this.calls.push('claim ' + r.length); }
    video(id, p) { this.calls.push('video ' + id + ' ' + p); }
    grab(on) { this.calls.push('grab ' + on); }
    show(on) { this.calls.push('show ' + on); }
    frame(r) { this.calls.push('frame'); this.lastRec = r; }
    close() { this.calls.push('close'); }
}

let clock = 1000;
function setup(inoOf) {
    let gpu = null;
    class RC extends FakeGpu { constructor() { super(); gpu = this; } }
    const v = createMirrorView({ RenderClient: RC, Recorder: record.Recorder, kit: record, appId: 'aurelm_myairplay',
        statIno: inoOf || (() => 42), now: () => clock });
    gpu.emit('ready', { w: 1920, h: 720 }, { video: true });
    gpu.calls = [];
    return { v, gpu };
}
const rx = (o) => Object.assign({ running: true, videoRunning: true, decoder: { ok: true, path: '/dev/shm/mgu-video-aurelm-myairplay', w: 1920, h: 720 },
    stream: { shown: 10 } }, o || {});

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('shown while parked, the page up and pictures coming: the file named, grabbed, a frame with the video op', () => {
    const { v, gpu } = setup();
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.deepStrictEqual(gpu.calls, ['video 1 /dev/shm/mgu-video-aurelm-myairplay', 'claim 1', 'grab true', 'show true', 'frame']);
    assert.strictEqual(v.state().shown, true);
    assert.strictEqual(v.state().why, 'on the screen');
    const w = gpu.lastRec.words();
    assert.ok(Array.prototype.indexOf.call(w, record.OP.VIDEO) >= 0);
    // the hint is over the picture at first (text drawn), then gone
    const words = (r) => Array.prototype.slice.call(r.words());
    assert.ok(words(gpu.lastRec).indexOf(record.OP.GLYPHS) >= 0, 'no hint');
    // the keepalive: a frame again within the renderer's 3 s
    gpu.calls = []; clock += 900;
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.deepStrictEqual(gpu.calls, ['frame']);
    clock += 4000;
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.ok(words(gpu.lastRec).indexOf(record.OP.GLYPHS) < 0, 'the hint stays');
});

test('hidden while driving, and when the app is not in front', () => {
    const { v, gpu } = setup();
    v.update({ rx: rx(), pageVisible: true, driving: false });
    gpu.calls = [];
    v.update({ rx: rx(), pageVisible: true, driving: true });
    // hidden: no touch claimed, the controller let go (the HMI gets them all: CarPlay's tile)
    assert.deepStrictEqual(gpu.calls, ['video 1 null', 'claim 0', 'grab false', 'show false']);
    assert.strictEqual(v.state().why, 'hidden while driving');
    v.update({ rx: rx(), pageVisible: false, driving: false });
    assert.strictEqual(v.state().shown, false);
    assert.strictEqual(v.state().why, 'the app is not in front');
});

test('a tap does nothing; the controller hides it; "Start receiver" (wantAgain) shows it again', () => {
    const { v, gpu } = setup();
    v.update({ rx: rx(), pageVisible: true, driving: false });
    gpu.emit('touch', 'down', 100, 100);
    assert.strictEqual(v.state().shown, true);
    gpu.emit('ccu', { press: 1, tilt: 0 });
    assert.strictEqual(v.state().shown, false);
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.strictEqual(v.state().shown, false);
    assert.ok(/Start receiver/.test(v.state().why));
    v.wantAgain();
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.strictEqual(v.state().shown, true);
    gpu.emit('ccu', { press: 0, tilt: 3 });
    assert.strictEqual(v.state().shown, false);
});

test('nothing without pictures, a failed decoder, or a missing frame file; a new file is named again', () => {
    let ino = 42;
    const { v, gpu } = setup(() => { if (ino === null) throw new Error('ENOENT'); return ino; });
    v.update({ rx: rx({ stream: { shown: 0 } }), pageVisible: true, driving: false });
    assert.strictEqual(v.state().why, 'waiting for the picture');
    v.update({ rx: rx({ decoder: { ok: false, error: 'decoder: no render node' } }), pageVisible: true, driving: false });
    assert.ok(/GPU decoder failed: decoder: no render node/.test(v.state().why));
    assert.deepStrictEqual(gpu.calls, []);
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.strictEqual(v.state().shown, true);
    gpu.calls = []; ino = 43;
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.deepStrictEqual(gpu.calls.slice(0, 2), ['video 1 null', 'video 1 /dev/shm/mgu-video-aurelm-myairplay']);
    ino = null;
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.strictEqual(v.state().shown, false);
    assert.strictEqual(v.state().why, 'the frame file is missing');
});

test('a renderer without mgu-render/1: never shown', () => {
    let gpu = null;
    class RC extends FakeGpu { constructor() { super(); gpu = this; } }
    const v = createMirrorView({ RenderClient: RC, Recorder: record.Recorder, kit: record, appId: 'x', statIno: () => 1 });
    gpu.emit('ready', { w: 1920, h: 720 }, null);
    v.update({ rx: rx(), pageVisible: true, driving: false });
    assert.strictEqual(v.state().shown, false);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + String(e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
