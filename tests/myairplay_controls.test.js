'use strict';
/**
 * The film's controls over the picture (apps/aurelm_myairplay/controls.js): node tests/emby_controls.test.js
 * Touch and the iDrive controller (the kit's codes), the buttons, a seek on the progress bar, hiding after 5 s (not
 * while paused), the aspect's rectangles; drawn with the kit's Recorder.
 */
const assert = require('assert');
const path = require('path');
const { createControls, videoRect } = require(path.join(__dirname, '..', 'apps', 'aurelm_myairplay', 'controls'));
const record = require(path.join(__dirname, '..', 'kit', 'runtime', 'record'));

const PL = { w: 1920, h: 720 };
const info = { title: 'Armageddon (1998)', pos: 600, dur: 9050, paused: false, aspect: 'fit' };
let clock = 0;
function make() {
    const acts = [];
    const c = createControls({ now: () => clock, act: (a) => acts.push(a) });
    return { c, acts };
}
const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('touch: the first shows the bar; a button runs; the progress bar seeks; above the bar hides it', () => {
    const { c, acts } = make();
    assert.strictEqual(c.visible(), false);
    c.touch('down', 900, 300, PL, info);
    assert.strictEqual(c.visible(), true);
    assert.deepStrictEqual(acts, [], 'the first touch only shows the bar');
    const L = c.layout(PL);
    const pp = L.buttons.find((b) => b.id === 'playpause');
    c.touch('down', ...centre(pp), PL, info);
    c.touch('up', ...centre(pp), PL, info);
    assert.deepStrictEqual(acts, ['playpause'], 'on the way down only');
    // a finger on the progress bar, dragged: nothing sent until it lifts, then one seek where it lifted
    c.touch('down', L.bar.x + L.bar.w * 0.1, L.bar.y + 2, PL, info);
    c.touch('move', L.bar.x + L.bar.w * 0.3, L.bar.y + 40, PL, info);
    assert.strictEqual(acts.length, 1, 'nothing while dragging');
    assert.ok(/\|true$/.test(c.key(info)), 'the bar shows the target');
    c.touch('move', L.bar.x + L.bar.w / 2, L.bar.y + 80, PL, info);
    c.touch('up', L.bar.x + L.bar.w / 2, L.bar.y + 80, PL, info);
    assert.ok(Math.abs(acts[1].seek - 4525) < 1, JSON.stringify(acts[1]));
    assert.strictEqual(acts.length, 2);
    ['back10', 'fwd30', 'aspect', 'stop'].forEach((id) => c.touch('down', ...centre(L.buttons.find((b) => b.id === id)), PL, info));
    assert.deepStrictEqual(acts.slice(2), ['back10', 'fwd30', 'aspect', 'stop']);
    assert.strictEqual(c.visible(), false, 'stop hides the bar');
    c.show();
    c.touch('down', 900, 100, PL, info);
    assert.strictEqual(c.visible(), false, 'a touch above the bar hides it');
    c.show();
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'exit')), PL, info);
    assert.strictEqual(acts[acts.length - 1], 'exit');
    assert.strictEqual(c.visible(), false, 'exit hides the bar too');
});

test('the controller: the first move shows the bar; the knob moves the focus, a press runs it; push down hides', () => {
    const { c, acts } = make();
    c.ccu({ knob: 100, press: 0, tilt: 0 });   // the first state: nothing moved
    assert.strictEqual(c.visible(), false);
    c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.strictEqual(c.visible(), true);
    assert.strictEqual(c.focus(), 'playpause', 'the first move only shows the bar, on play / pause');
    c.ccu({ knob: 103, press: 0, tilt: 0 });
    assert.strictEqual(c.focus(), 'fwd30');
    c.ccu({ knob: 103, press: 1, tilt: 0 });
    c.ccu({ knob: 103, press: 1, tilt: 0 });   // held: one press
    c.ccu({ knob: 103, press: 0, tilt: 0 });
    assert.deepStrictEqual(acts, ['fwd30']);
    c.ccu({ knob: 103, press: 0, tilt: 10 });  // pushed left
    assert.strictEqual(c.focus(), 'stop');
    c.ccu({ knob: 103, press: 0, tilt: 0 });
    c.ccu({ knob: 65535, press: 0, tilt: 0 });  // a counter reset (a jump): ignored
    assert.strictEqual(c.focus(), 'stop');
    c.ccu({ knob: 1, press: 0, tilt: 0 });      // across the wrap: +2
    assert.strictEqual(c.focus(), 'aspect');
    c.ccu({ knob: 1, press: 0, tilt: 7 });      // pushed down
    assert.strictEqual(c.visible(), false);
    c.ccu({ knob: 1, press: 15, tilt: 15 });    // no controller behind it
    assert.strictEqual(c.visible(), false);
});

test('hidden 5 s after the last touch, not while paused', () => {
    const { c } = make();
    clock = 1000;
    c.show();
    clock = 5900; assert.strictEqual(c.visible(), true);
    clock = 6100; assert.strictEqual(c.visible(), false);
    c.keepOpen(true);
    clock = 60000; assert.strictEqual(c.visible(), true);
    c.keepOpen(false);
    assert.strictEqual(c.visible(), false);
});

test('the bar drawn with the kit\'s Recorder; its key changes with what it shows', () => {
    const { c } = make();
    clock = 0;
    c.show();
    const k1 = c.key(info);
    assert.ok(k1);
    assert.notStrictEqual(c.key(Object.assign({}, info, { paused: true })), k1);
    assert.notStrictEqual(c.key(Object.assign({}, info, { pos: 601 })), k1);
    assert.strictEqual(c.key(Object.assign({}, info, { pos: 600.4 })), k1, 'the same second: no new frame');
    const rec = new record.Recorder(PL.w, PL.h).clear(0x000000ff);
    c.draw(rec, PL, info);
    c.draw(rec, PL, Object.assign({}, info, { paused: true, seeking: 700, aspect: 'fill' }));
    assert.ok(rec.n > 200);
    c.hide();
    assert.strictEqual(c.key(info), null);
});

test('aspect: fit keeps the whole film, fill covers the screen, zoom is between', () => {
    // a 2.40:1 film (1920x800) on the 1920x720 screen
    assert.deepStrictEqual(videoRect('fit', 1920, 800, PL), { x: 96, y: 0, w: 1728, h: 720 });
    assert.deepStrictEqual(videoRect('fill', 1920, 800, PL), { x: 0, y: -40, w: 1920, h: 800 });
    const z = videoRect('zoom', 1920, 800, PL);
    assert.ok(z.w > 1728 && z.w < 1920 && z.h > 720 && z.h < 800, JSON.stringify(z));
    // a 16:9 one (1920x1080)
    assert.deepStrictEqual(videoRect('fit', 1920, 1080, PL), { x: 320, y: 0, w: 1280, h: 720 });
    assert.deepStrictEqual(videoRect('fill', 1920, 1080, PL), { x: 0, y: -180, w: 1920, h: 1080 });
    // no size known yet: the whole screen
    assert.deepStrictEqual(videoRect('fill', 0, 0, PL), { x: 0, y: 0, w: 1920, h: 720 });
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
