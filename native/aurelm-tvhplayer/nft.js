'use strict';
/**
 * nft.js - the one hole the sign-in page needs in the unit's firewall, while it is open, and nothing else.
 *
 * A packet must be accepted by every base chain on its hook (a drop in any of them is final): the unit's
 * own `ip filter` and mgu-uplink's `inet mgu_uplink`. So the accept rules go at the top of every IPv4 input
 * and output base chain, for the car Wi-Fi's interfaces and the page's tcp port only:
 *
 *   input   iifname <car Wi-Fi> tcp dport <port> accept
 *   output  oifname <car Wi-Fi> tcp sport <port> accept
 *
 * Each rule carries the comment COMMENT; remove() deletes every rule with it, wherever it is, so a close, a
 * crash and the next start all leave the firewall as the unit had it. mgu-uplink rewrites its own table
 * when its link changes: apply() runs again every few seconds while the page is open.
 */
const { execFileSync } = require('child_process');

const COMMENT = 'aurelm-tvhplayer';

/** nft through `sh -c 'ulimit -c 1; exec nft ...'`: no core dump to the unit's crash handler, from any caller */
function run(args, nft) {
    return execFileSync('/bin/sh', ['-c', 'ulimit -c 1; exec "$0" "$@"', nft || 'nft'].concat(args),
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `nft -a list ruleset` -> [{ family, table, chain, hook, ours: [handle] }] */
function parse(text) {
    const chains = [];
    let family = null, table = null, cur = null;
    String(text).split('\n').forEach((line) => {
        const s = line.trim();
        let m;
        if ((m = /^table\s+(\S+)\s+(\S+)\s*\{/.exec(s))) { family = m[1]; table = m[2]; cur = null; return; }
        if ((m = /^chain\s+(\S+)\s*\{/.exec(s)) && table) { cur = { family, table, chain: m[1], hook: null, ours: [] }; chains.push(cur); return; }
        if (!cur) return;
        if ((m = /\btype\s+\S+\s+hook\s+(\w+)/.exec(s))) { cur.hook = m[1]; return; }
        if (s.indexOf('comment "' + COMMENT + '"') >= 0 && (m = /#\s*handle\s+(\d+)\s*$/.exec(s))) cur.ours.push(m[1]);
    });
    return chains;
}

function rulesFor(hook, ifname, port) {
    const q = JSON.stringify(String(ifname));
    const p = Number(port);
    if (!(p > 0 && p < 65536)) return [];
    if (hook === 'input') return ['iifname ' + q + ' tcp dport ' + p + ' accept'];
    if (hook === 'output') return ['oifname ' + q + ' tcp sport ' + p + ' accept'];
    return [];
}

const targets = (chains) => chains.filter((c) => (c.family === 'ip' || c.family === 'inet') && (c.hook === 'input' || c.hook === 'output'));

/** puts the rules for `ifnames` at the top of every target chain that lacks them; [{ chain, ok, error, changed }] */
function apply(ifnames, port, opts) {
    const o = opts || {};
    const chains = parse(run(['-a', 'list', 'ruleset'], o.nft));
    return targets(chains).map((c) => {
        const want = [];
        ifnames.forEach((i) => rulesFor(c.hook, i, port).forEach((r) => want.push(r)));
        const res = { chain: c.family + ' ' + c.table + ' ' + c.chain, ok: true, error: null, changed: false };
        if (c.ours.length === want.length) return res;
        try {
            c.ours.forEach((h) => run(['delete', 'rule', c.family, c.table, c.chain, 'handle', h], o.nft));
            want.slice().reverse().forEach((r) => run(['insert', 'rule', c.family, c.table, c.chain].concat(r.split(' '), ['comment', '"' + COMMENT + '"']), o.nft));
            res.changed = true;
        } catch (e) {
            res.ok = false;
            res.error = String((e.stderr || e.message || e)).trim().split('\n')[0];
        }
        return res;
    });
}

/** deletes every rule this tool put anywhere; returns how many */
function remove(opts) {
    const o = opts || {};
    let n = 0, text;
    try { text = run(['-a', 'list', 'ruleset'], o.nft); } catch (e) { return 0; }
    parse(text).forEach((c) => c.ours.forEach((h) => {
        try { run(['delete', 'rule', c.family, c.table, c.chain, 'handle', h], o.nft); n++; } catch (e) { /* gone already */ }
    }));
    return n;
}

module.exports = { COMMENT, parse, rulesFor, targets, apply, remove };
