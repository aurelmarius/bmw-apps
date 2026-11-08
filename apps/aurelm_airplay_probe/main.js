'use strict';
/**
 * AirPlay Test - can an iPhone find and reach this head unit as an AirPlay receiver?
 *
 * The screen of the AirPlay network test service (native/aurelm-airplay-probe, a root tool): "Start test"
 * has the service announce a test receiver ("BMW iDrive test") on the Wi-Fi-side networks for 15
 * minutes; the page shows, step by step, what got through: the network, the firewall, mDNS, the
 * iPhone's AirPlay query and its connection. On the iPhone: Control Center > Screen Mirroring.
 *
 * Talks to the service over /run/aurelm-airplay-probe.sock (a JSON object per line).
 */
const net = require('net');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const SOCK = process.env.AIRPLAY_PROBE_SOCK || '/run/aurelm-airplay-probe.sock';
const MINUTES = 15;
const GREEN = '#2fd27a', AMBER = '#ffb020', RED = '#ef2b2d';

/** one request: the service's status, or null when it does not answer */
function ask(cmd, extra) {
    return new Promise((res) => {
        let buf = '', done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch (e) { /* gone */ } res(v); } };
        const c = net.connect(SOCK);
        const t = setTimeout(() => end(null), 4000);
        c.setEncoding('utf8');
        c.on('connect', () => c.write(JSON.stringify(Object.assign({ cmd }, extra || {})) + '\n'));
        c.on('data', (d) => {
            buf += d;
            const i = buf.indexOf('\n');
            if (i < 0) return;
            try { end(JSON.parse(buf.slice(0, i))); } catch (e) { end(null); }
        });
        c.on('error', () => end(null));
    });
}

/** words into lines no wider than w */
function wrap(cv, text, size, w, font) {
    const out = [];
    let line = '';
    String(text).split(/\s+/).forEach((word) => {
        const next = line ? line + ' ' + word : word;
        if (line && cv.textWidth(next, size, { font, literal: true }) > w) { out.push(line); line = word; } else line = next;
    });
    if (line) out.push(line);
    return out;
}
function clip(cv, s, size, w, font) {
    s = String(s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s + '...';
}

const ago = (t, now) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; };

/**
 * The steps, each { label, state: 'ok'|'wait'|'bad'|'off', detail }, from a status (null: no service).
 * Exported for the tests and the screenshots.
 */
function steps(s) {
    if (!s) return [{ label: 'Service', state: 'bad', detail: 'not answering: install "AirPlay network test service" from the Store' }];
    const used = (s.ifaces || []).filter((i) => i.used);
    const off = !s.active && !(s.tcp && s.tcp.connections);
    const m = s.mdns || {}, tcp = s.tcp || {}, fw = s.fw || {};
    const lq = m.lastAirplayQuery, last = tcp.last;
    return [
        { label: 'Service', state: 'ok', detail: 'version ' + s.version + (s.active ? ', test running' : ', idle') },
        { label: 'Wi-Fi network', state: used.length ? 'ok' : off ? 'off' : 'bad',
            detail: used.length ? used.map((i) => i.name + ' ' + i.ip + ' (' + i.kind + ')').join(', ') : 'none: head unit on the iPhone hotspot, or iPhone on the car Wi-Fi' },
        { label: 'Firewall', state: fw.state === 'open' ? 'ok' : fw.state === 'failed' ? 'bad' : off ? 'off' : 'wait',
            detail: fw.state === 'open' ? (fw.chains || []).length + ' chains open for 7000, 7100, 5353' : fw.state === 'failed' ? fw.error : fw.state || '' },
        { label: 'mDNS', state: m.mode === 'own' ? 'ok' : m.mode === 'failed' ? 'bad' : off ? 'off' : 'wait',
            detail: m.mode === 'own' ? 'announcing "' + s.name + '", ' + m.answered + ' answers sent' : m.mode === 'failed' ? m.error + ((m.holders || []).length ? ', held by ' + m.holders.join(', ') : '') : '' },
        { label: 'Devices heard', state: (m.peers || []).length ? 'ok' : off ? 'off' : 'wait',
            detail: (m.peers || []).length ? m.peers.slice(-3).map((p) => p.ip + (p.names.length ? ' ' + p.names[0] : '')).join(', ') : 'none yet' },
        { label: 'AirPlay query', state: lq ? 'ok' : off ? 'off' : 'wait',
            detail: lq ? 'from ' + lq.ip + (lq.iface ? ' on ' + lq.iface : '') + ', ' + ago(lq.at, s.now) + ' (' + m.airplayQueries + ' in all)' : 'open Screen Mirroring on the iPhone' },
        { label: 'iPhone connected', state: last ? 'ok' : off ? 'off' : 'wait',
            detail: last ? last.ip + ' -> ' + last.port + ': ' + (last.request || '') + (last.agent ? ' (' + last.agent + ')' : '') : 'tap "' + s.name + '" in Screen Mirroring' },
    ];
}

const VERDICT_COLOR = { connected: GREEN, asked: AMBER, 'heard-phone': AMBER, waiting: AMBER, idle: null };

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let st = null, busy = null, polling = false;

        async function poll() {
            if (polling) return;
            polling = true;
            try { st = await ask('status'); } finally { polling = false; }
        }
        async function command(cmd, label) {
            busy = label;
            const r = await ask(cmd, cmd === 'start' ? { minutes: MINUTES } : null);
            busy = null;
            if (r) st = r;
            log.info('airplay test: ' + cmd + ' -> ' + (r ? r.verdict.code : 'no service'));
            return render();
        }
        ui.onClick('BTN_START', () => command('start', 'Starting...'));
        ui.onClick('BTN_STOP', () => command('stop', 'Stopping...'));

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const left = st && st.active ? Math.max(0, Math.round((st.endsAt - st.now) / 60000)) : null;
            G.frame(cv, t, ['AirPlay network test'], 0, [busy && { text: busy, color: 'accent' }, left != null && { text: left + ' MIN LEFT' }]);
            draw(cv, t);
            return ui.image('MAIN_GFX', cv);
        }

        function draw(cv, t) {
            const v = st ? st.verdict : { code: 'none', text: 'The AirPlay network test service does not answer. It comes with this app from the Store: restart the head unit once after installing (the service starts listening for this app at the next start).' };
            const vc = VERDICT_COLOR[v.code] || (v.code === 'idle' ? t.accent : RED);
            // verdict
            cv.fillRect(24, 58, 1552, 96, withAlpha(vc, 0.14));
            cv.fillRect(24, 58, 6, 96, vc);
            const vl = wrap(cv, v.text, 26, 1500, 'bold').slice(0, 2);
            vl.forEach((l, i) => cv.text(l, 52, 98 + i * 36 - (vl.length === 1 ? -14 : 0), 26, t.text, { font: 'bold', literal: true }));
            // steps
            const rows = steps(st);
            const COL = { ok: GREEN, wait: AMBER, bad: RED, off: withAlpha('#ffffff', 0.3) };
            rows.forEach((r, i) => {
                const y = 190 + i * 44;
                cv.circle(44, y - 8, 9, COL[r.state]);
                cv.text(r.label, 66, y, 22, t.text, { font: 'bold', literal: true });
                cv.text(clip(cv, r.detail || '', 20, 700, 'label'), 260, y, 20, r.state === 'off' ? t.dim : t.text, { literal: true });
            });
            // the service's log
            cv.fillRect(990, 172, 1.5, 320, withAlpha('#ffffff', 0.15));
            cv.text('LOG', 1010, 190, 18, t.dim, { font: 'bold', literal: true });
            const lines = (st && st.log ? st.log : []).slice(-12);
            lines.forEach((l, i) => cv.text(clip(cv, l, 16, 570, 'label'), 1010, 222 + i * 24, 16, t.dim, { literal: true }));
            if (!lines.length) cv.text('On the iPhone: Control Center > Screen Mirroring', 1010, 222, 16, t.dim, { literal: true });
        }

        setInterval(() => { poll().catch(() => {}); }, 1000);
        await poll();
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('AirPlay Test first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { steps, ask };
