'use strict';
/**
 * The channel's controls over the picture (apps/aurelm_tvhplayer/controls.js): node tests/tvhplayer_controls.test.js
 * Touch and the iDrive controller (the kit's codes), CH- / CH+ / stop / aspect / exit, the channel list (LIST, or a
 * push up) chosen by touch or by the knob and a press, hiding after 5 s; drawn with the kit's Recorder. Also the
 * app's channel order for CH+ / CH- (round).
 */
const assert = require('assert');
const path = require('path');
const { createControls, hm } = require(path.join(__dirname, '..', 'apps', 'aurelm_tvhplayer', 'controls'));
const record = require(path.join(__dirname, '..', 'kit', 'runtime', 'record'));

const PL = { w: 1920, h: 720 };
const chans = ['1  PRO TV HD  -  Stirile', '2  Antena 1 HD', '3  Digi 24 HD', '4  Kanal D', '5  TVR 1'].map((t, i) => ({ uuid: 'u' + i, t }));
const t0 = Date.now() / 1000;
const info = { title: '1  PRO TV HD', now: { title: 'Stirile Pro TV', start: t0 - 600, stop: t0 + 1200 }, aspect: 'fit', profile: 'mgu-hd', current: 'u0', channels: chans };
let clock = 0;
function make() {
    const acts = [];
    const c = createControls({ now: () => clock, act: (a) => acts.push(a) });
    c.key(info);
    return { c, acts };
}
const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('touch: the first shows the bar; the buttons run; above the bar hides it; hidden after 5 s', () => {
    const { c, acts } = make();
    c.touch('down', 900, 300, PL, info);
    assert.strictEqual(c.visible(), true);
    assert.deepStrictEqual(acts, []);
    const L = c.layout(PL);
    ['chdown', 'chup', 'aspect'].forEach((id) => { c.touch('down', ...centre(L.buttons.find((b) => b.id === id)), PL, info); c.touch('up', 0, 0, PL, info); });
    assert.deepStrictEqual(acts, ['chdown', 'chup', 'aspect']);
    c.touch('down', 900, 100, PL, info);
    assert.strictEqual(c.visible(), false);
    c.show();
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'stop')), PL, info);
    assert.strictEqual(acts[acts.length - 1], 'stop');
    assert.strictEqual(c.visible(), false, 'stop hides the bar');
    c.show(); clock += 5001;
    assert.strictEqual(c.visible(), false, '5 s');
});

test('the channel list: LIST opens it on the channel playing; a touch on a row plays that channel', () => {
    const { c, acts } = make();
    c.show();
    const L = c.layout(PL);
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'list')), PL, info);
    const m = c.menu();
    assert.ok(m && m.items.length === 5 && m.focus === 0 && m.cur === 'u0');
    const M = c.menuLayout(PL);
    const r = M.row(2 - m.first);
    c.touch('down', r.x + 20, r.y + r.h / 2, PL, info);
    assert.deepStrictEqual(acts, [], 'not on the way down: it may be a drag');
    c.touch('up', r.x + 20, r.y + r.h / 2, PL, info);
    assert.deepStrictEqual(acts, [{ channel: 'u2' }]);
    assert.strictEqual(c.menu(), null, 'closed');
    // the channel playing chosen again: nothing
    c.openList();
    c.touch('down', M.row(0 - c.menu().first).x + 20, M.row(0 - c.menu().first).y + 10, PL, info);
    c.touch('up', M.row(0 - c.menu().first).x + 20, M.row(0 - c.menu().first).y + 10, PL, info);
    assert.strictEqual(acts.length, 1);
});

test('the controller: knob and press along the buttons; push up opens the list, the knob and a press play one', () => {
    const { c, acts } = make();
    c.ccu({ knob: 100, press: 0, tilt: 0 });
    c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.strictEqual(c.visible(), true, 'the first move shows the bar');
    assert.strictEqual(c.focus(), 'chup');
    c.ccu({ knob: 101, press: 1, tilt: 0 }); c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.deepStrictEqual(acts, ['chup']);
    c.ccu({ knob: 101, press: 0, tilt: 1 }); c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.ok(c.menu(), 'push up: the list');
    c.ccu({ knob: 104, press: 0, tilt: 0 });
    assert.strictEqual(c.menu().focus, 3);
    c.ccu({ knob: 104, press: 2, tilt: 0 });
    assert.deepStrictEqual(acts[1], { channel: 'u3' });
    c.ccu({ knob: 104, press: 0, tilt: 7 });
    assert.strictEqual(c.visible(), false, 'push down hides');
    c.ccu({ knob: 104, press: 15, tilt: 15 });
    assert.strictEqual(c.visible(), false, 'no controller behind it');
});

test('the guide: EPG opens it on the channel playing; the knob moves along, a push right shows the next channel, a press watches it', () => {
    const acts = [], asked = [];
    const PROG = { u0: [{ title: 'Stirile', start: t0 - 600, stop: t0 + 1200, text: 'Azi.' }, { title: 'Vremea', start: t0 + 1200, stop: t0 + 1500 }],
        u1: [{ title: 'Observator', start: t0 - 60, stop: t0 + 3600 }] };
    const c = createControls({ now: () => clock, act: (a) => acts.push(a), guide: (u) => { asked.push(u); return PROG[u] ? { state: 'ok', events: PROG[u] } : { state: 'loading', events: [] }; } });
    c.key(info);
    c.ccu({ knob: 100, press: 0, tilt: 0 });
    c.ccu({ knob: 101, press: 0, tilt: 0 });           // the bar, CH+
    c.ccu({ knob: 103, press: 0, tilt: 0 });           // LIST, EPG
    assert.strictEqual(c.focus(), 'epg');
    c.ccu({ knob: 103, press: 1, tilt: 0 }); c.ccu({ knob: 103, press: 0, tilt: 0 });
    assert.deepStrictEqual(c.guide(), { uuid: 'u0', focus: 0, first: 0 });
    const rec = { text() {}, textWidth: (t, z) => String(t).length * z * 0.5, roundRect() {}, strokeRoundRect() {}, fillRect() {}, gradientRect() {}, circle() {}, line() {} };
    c.draw(rec, PL, info);
    assert.ok(asked.indexOf('u0') >= 0, 'the programme asked for');
    c.ccu({ knob: 104, press: 0, tilt: 0 });
    assert.strictEqual(c.guide().focus, 1);
    c.ccu({ knob: 104, press: 1, tilt: 0 }); c.ccu({ knob: 104, press: 0, tilt: 0 });
    assert.strictEqual(c.guide(), null, 'a press on the channel playing closes the guide');
    assert.deepStrictEqual(acts, []);
    c.openGuide('u0');
    c.ccu({ knob: 104, press: 0, tilt: 4 }); c.ccu({ knob: 104, press: 0, tilt: 0 });
    assert.strictEqual(c.guide().uuid, 'u1', 'a push right: the next channel');
    c.ccu({ knob: 104, press: 0, tilt: 10 }); c.ccu({ knob: 104, press: 0, tilt: 0 });
    c.ccu({ knob: 104, press: 0, tilt: 10 }); c.ccu({ knob: 104, press: 0, tilt: 0 });
    assert.strictEqual(c.guide().uuid, 'u4', 'round, the other way');
    c.ccu({ knob: 104, press: 0, tilt: 4 }); c.ccu({ knob: 104, press: 0, tilt: 0 });
    c.ccu({ knob: 104, press: 0, tilt: 4 }); c.ccu({ knob: 104, press: 0, tilt: 0 });
    c.ccu({ knob: 104, press: 2, tilt: 0 });
    assert.deepStrictEqual(acts, [{ channel: 'u1' }], 'a press watches the guide\'s channel');
    assert.strictEqual(c.guide(), null);
    // touch: < >, a programme chosen, a second touch watches; outside closes; 30 s idle closes
    c.openGuide('u0');
    const G = c.guideLayout(PL);
    c.touch('down', G.next.x + 10, G.next.y + 10, PL, info);
    assert.strictEqual(c.guide().uuid, 'u1');
    c.touch('down', G.prev.x + 10, G.prev.y + 10, PL, info);
    assert.strictEqual(c.guide().uuid, 'u0');
    const r1 = G.row(1);
    c.touch('down', r1.x + 50, r1.y + 10, PL, info); c.touch('up', r1.x + 50, r1.y + 10, PL, info);
    assert.strictEqual(c.guide().focus, 1);
    c.touch('down', r1.x + 50, r1.y + 10, PL, info); c.touch('up', r1.x + 50, r1.y + 10, PL, info);
    assert.strictEqual(c.guide(), null, 'the channel playing: closed, nothing played');
    assert.strictEqual(acts.length, 1);
    c.openGuide('u0');
    clock += 30001;
    assert.strictEqual(c.guide(), null, '30 s idle');
});

test('a finger dragged along the channel list scrolls it, and plays nothing', () => {
    const many = [];
    for (let i = 0; i < 40; i++) many.push({ uuid: 'c' + i, t: (i + 1) + '  Channel ' + (i + 1), n: (i + 1) + '  Channel ' + (i + 1) });
    const inf = Object.assign({}, info, { channels: many, current: 'c0' });
    const acts = [];
    const c = createControls({ now: () => clock, act: (a) => acts.push(a) });
    c.key(inf); c.show(); c.openList();
    const M = c.menuLayout(PL), r = M.row(2);
    assert.strictEqual(c.menu().first, 0);
    // up the screen by three rows and a bit: the list goes three rows on
    c.touch('down', r.x + 30, r.y + 5, PL, inf);
    for (let d = 0; d <= M.ih * 3 + 10; d += 10) c.touch('move', r.x + 30, r.y + 5 - d, PL, inf);
    c.touch('up', r.x + 30, r.y + 5 - M.ih * 3 - 10, PL, inf);
    c.menuLayout(PL);
    assert.strictEqual(c.menu().first, 3, 'three rows on');
    assert.deepStrictEqual(acts, [], 'a drag plays nothing');
    // and back down
    c.touch('down', r.x + 30, r.y, PL, inf);
    for (let d = 0; d <= M.ih * 2 + 10; d += 10) c.touch('move', r.x + 30, r.y + d, PL, inf);
    c.touch('up', r.x + 30, r.y + M.ih * 2 + 10, PL, inf);
    c.menuLayout(PL);
    assert.strictEqual(c.menu().first, 1);
    // a tap still plays the row under it
    const r0 = c.menuLayout(PL).row(0);
    c.touch('down', r0.x + 30, r0.y + 10, PL, inf); c.touch('up', r0.x + 30, r0.y + 10, PL, inf);
    assert.deepStrictEqual(acts, [{ channel: 'c1' }]);
});

test('drawn: the bar, the programme, the list', () => {
    const { c } = make();
    c.show(); c.openList();
    let rec = new record.Recorder(PL.w, PL.h).clear(0x000000ff);
    const said = [];
    const text = rec.text.bind(rec);
    rec.text = (t, ...r) => { said.push(String(t)); return text(t, ...r); };
    c.draw(rec, PL, info);
    const texts = said.join('|');
    assert.ok(texts.indexOf('Stirile Pro TV') >= 0 && texts.indexOf('CHANNELS') >= 0 && texts.indexOf('CH +') >= 0 && texts.indexOf('mgu-hd') >= 0, 'texts drawn');
    assert.ok(/^\d\d:\d\d$/.test(hm(t0)));
    // the guide, with the details of the programme chosen
    const g = createControls({ now: () => Date.now(), guide: () => ({ state: 'ok', events: [{ title: 'Stirile Pro TV', subtitle: 'Editia de seara', start: t0 - 600, stop: t0 + 1200, text: 'Cele mai importante stiri ale zilei, pe larg.' }] }) });
    g.key(info); g.openGuide('u0');
    rec = new record.Recorder(PL.w, PL.h).clear(0x000000ff);
    said.length = 0;
    rec.text = (t, ...r) => { said.push(String(t)); return text(t, ...r); };
    g.draw(rec, PL, info);
    const all = said.join('|');
    assert.ok(all.indexOf('EPG - PLAYING') >= 0 && all.indexOf('Editia de seara') >= 0 && /min left/.test(all) && all.indexOf('Cele mai importante') >= 0, all);
});

test('the app: CH+ / CH- go round the list', () => {
    // main.js runs the app when required: its helper is checked as written there
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'apps', 'aurelm_tvhplayer', 'main.js'), 'utf8');
    const body = /function neighbour\(list, uuid, d\) \{[\s\S]*?\n\}/.exec(src)[0];
    const neighbour = new Function(body + '; return neighbour;')();
    const l = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
    assert.strictEqual(neighbour(l, 'c', 1).uuid, 'a');
    assert.strictEqual(neighbour(l, 'a', -1).uuid, 'c');
    assert.strictEqual(neighbour(l, 'x', 1).uuid, 'a', 'nothing playing: the first');
    assert.strictEqual(neighbour(l, 'x', -1).uuid, 'c');
    assert.strictEqual(neighbour([], 'a', 1), null);
});

test("the guide's times in the car's zone (the head unit keeps UTC): Romania by default, EU summer time", () => {
    const c = require(path.join(__dirname, '..', 'apps', 'aurelm_tvhplayer', 'controls'));
    const at = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi) / 1000;
    c.setZone(() => 'eet');
    assert.strictEqual(c.hm(at(2026, 10, 11, 16, 0)), '18:00', 'winter: UTC+2 (0.1.6 in the car showed 16:00)');
    assert.strictEqual(c.hm(at(2026, 6, 1, 16, 0)), '19:00', 'summer: UTC+3');
    assert.strictEqual(c.when(at(2026, 10, 11, 22, 30), at(2026, 10, 11, 16, 0) * 1000), 'Thu 00:30', 'past midnight in the zone: the next day');
    c.setZone(() => 'cet');
    assert.strictEqual(c.hm(at(2026, 2, 29, 0, 59)), '01:59');
    assert.strictEqual(c.hm(at(2026, 2, 29, 1, 0)), '03:00', 'summer time from the last Sunday of March, 01:00 UTC');
    assert.strictEqual(c.hm(at(2026, 9, 25, 1, 0)), '02:00', 'back on the last Sunday of October');
    c.setZone(() => 'utc');
    assert.strictEqual(c.hm(at(2026, 6, 1, 16, 0)), '16:00');
    c.setZone(() => 'eet');
});

test('the cluster card: drawn on cluster-render\'s panel while a channel plays, its programme, hidden when it stops', () => {
    const fs = require('fs'), os = require('os');
    const { createClusterCard, CARD, PLACE } = require(path.join(__dirname, '..', 'apps', 'aurelm_tvhplayer', 'cluster_card'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvh-cluster-'));
    const calls = [];
    const fake = path.join(dir, 'client.js');
    fs.writeFileSync(fake, "const E = require('events'); let calls = null;\n" +
        "class ClusterRender extends E { constructor(app) { super(); calls = global.__clusterCalls; calls.push(['new', app]); }\n" +
        "  connect() { calls.push(['connect']); } image(o) { calls.push(['image', o]); return 7; } set(r, o) { calls.push(['set', r, o]); }\n" +
        "  pixels(r, rects, px) { calls.push(['pixels', r, px.length]); return true; } close() { calls.push(['close']); } }\n" +
        'module.exports = { ClusterRender };\n');
    global.__clusterCalls = calls;
    let playing = null, on = true;
    const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));
    const card = createClusterCard({ Canvas, clientPath: fake, socketPath: path.join(dir, 'none.sock'), hm: (t) => String(t), png: {},
        ask: () => new Promise(() => {}), enabled: () => on, offset: () => ({ dx: 40, dy: 0 }), info: () => playing });
    card.update();
    assert.strictEqual(calls.length, 0, 'nothing playing: cluster-render not asked');
    const now = Date.now() / 1000;
    playing = { uuid: 'u1', name: '4  PRO TV HD', title: 'Batem palma?', start: now - 600, stop: now + 3000, next: { start: now + 3000, title: 'Stirile Pro TV' } };
    card.update();
    const img = calls.filter((c) => c[0] === 'image')[0];
    assert.ok(img, 'an image layer');
    assert.strictEqual(img[1].target, 'panel');
    assert.strictEqual(img[1].x, PLACE.x + 40, 'moved by the setting');
    assert.deepStrictEqual([img[1].w, img[1].h, img[1].iw, img[1].ih], [CARD.w, CARD.h, CARD.w, CARD.h]);
    assert.ok(calls.some((c) => c[0] === 'pixels' && c[2] === CARD.w * CARD.h * 4), 'the card\'s pixels');
    assert.ok(calls.some((c) => c[0] === 'set' && c[2].visible === 1), 'shown');
    const n = calls.length;
    card.update();
    assert.strictEqual(calls.length, n, 'nothing changed: nothing sent');
    playing = null;
    card.update();
    assert.deepStrictEqual(calls[calls.length - 1], ['set', 7, { visible: 0 }], 'hidden when the channel stops');
    on = false; card.update();
    assert.strictEqual(card.state().state, 'off');
    // the card itself: opaque inside, transparent at the corners
    const cv = card.render(Object.assign({ now: Date.now(), logo: null }, { uuid: 'u1', name: '4  PRO TV HD', title: 'Batem palma?', start: now - 600, stop: now + 3000, next: null }));
    assert.strictEqual(cv.d[3], 0, 'a corner: transparent');
    assert.strictEqual(cv.d[((CARD.h >> 1) * CARD.w + (CARD.w >> 1)) * 4 + 3], 255, 'the middle: opaque (hides the widget underneath)');
    const edge = cv.d[((CARD.h >> 1) * CARD.w + 8) * 4 + 3];
    assert.ok(edge > 0 && edge < 128, 'the edge: fading out (' + edge + ')');
    card.close();
});

test('skip on the steering wheel: > channel +, < channel -, when let go, once a press; nothing while no channel is on or the setting is off', () => {
    const { createWheel } = require(path.join(__dirname, '..', 'apps', 'aurelm_tvhplayer', 'wheel'));
    const zaps = [];
    let on = true, active = true;
    const w = createWheel({ zap: (d) => zaps.push(d), enabled: () => on, active: () => active });
    const S = (v) => ({ operationPushButtonAudioAutomaticTuningSteeringWheel: v });
    w.onSwitch(S('SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS'));
    w.onSwitch(S('SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS'));   // the same press, sent again
    assert.deepStrictEqual(zaps, [], 'nothing while it is down');
    w.onSwitch(S('KEINE_AKTION'));
    assert.deepStrictEqual(zaps, [1], 'right, let go: channel +');
    w.onSwitch(S('KEINE_AKTION'));
    assert.deepStrictEqual(zaps, [1], 'a second let-go is no press');
    w.onSwitch('SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS'); w.onSwitch('KEINE_AKTION');
    assert.deepStrictEqual(zaps, [1, -1], 'left: channel - (the value as a string too)');
    assert.ok(w.state().seen && /channel -/.test(w.state().last));
    active = false;
    w.onSwitch(S('SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS')); w.onSwitch(S('KEINE_AKTION'));
    assert.deepStrictEqual(zaps, [1, -1], 'no channel on: the press is not ours');
    active = true; on = false;
    w.onSwitch(S('SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS')); w.onSwitch(S('KEINE_AKTION'));
    assert.deepStrictEqual(zaps, [1, -1], 'off in the settings');
    assert.strictEqual(w.state().on, false);
    w.onSwitch(S('LAUTSTAERKE_PLUS')); w.onSwitch(null);
    assert.deepStrictEqual(zaps, [1, -1], 'other buttons: nothing');
});

let failed = 0;
for (const t of tests) {
    try { t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
