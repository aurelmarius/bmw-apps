'use strict';
/**
 * nft.js - the holes the test opens in the unit's firewall, and nothing else.
 *
 * A packet must be accepted by every base chain on its hook (a drop in any of them is final): the
 * unit's own tables, and mgu-uplink's `inet mgu_uplink` while it runs ("nothing connects in"). So
 * the test puts its accept rules at the top of every IPv4 input and output base chain, for the
 * interfaces it uses and the ports it needs only:
 *
 *   input   tcp dport 7000, 7100 (AirPlay), udp dport 5353 (mDNS)
 *   output  tcp sport 7000, 7100; udp dport 5353 and udp sport 5353 from root (this service) only
 *
 * Each rule carries the comment COMMENT; remove() deletes every rule with it, wherever it is, so a
 * stop, a crash and the next start all leave the firewall as the unit had it. mgu-uplink rewrites
 * its own table when its link changes: apply() is run again every few seconds while the test is on
 * and puts back what is missing.
 */
const { execFileSync } = require('child_process');

const COMMENT = 'aurelm-airplay-probe';
const PORTS_TCP = '{ 7000, 7100 }';

/**
 * nft through `sh -c 'ulimit -c 1; exec nft ...'`: a crash of nft pipes no core dump to the unit's crash
 * handler, which restarts the head unit for a program it does not list. The service's LimitCORE=1
 * covers it already; a hook the deploy tool runs (deactivate) may not have it.
 */
function run(args, nft) {
    return execFileSync('/bin/sh', ['-c', 'ulimit -c 1; exec "$0" "$@"', nft || 'nft'].concat(args),
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `nft -a list ruleset` -> [{ family, table, chain, hook, ours: [handle] }] for every chain */
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

/** the rules for one base chain (its hook) and one interface */
function rulesFor(hook, ifname) {
    const q = JSON.stringify(String(ifname));
    if (hook === 'input') return [
        'iifname ' + q + ' tcp dport ' + PORTS_TCP + ' accept',
        'iifname ' + q + ' udp dport 5353 accept',
    ];
    // mDNS out: only this service's own socket (root), not the car's own responder
    if (hook === 'output') return [
        'oifname ' + q + ' tcp sport ' + PORTS_TCP + ' accept',
        'oifname ' + q + ' meta skuid 0 udp dport 5353 accept',
        'oifname ' + q + ' meta skuid 0 udp sport 5353 accept',
    ];
    return [];
}

/** the base chains the rules go in: IPv4 (ip, inet) input and output */
const targets = (chains) => chains.filter((c) => (c.family === 'ip' || c.family === 'inet') && (c.hook === 'input' || c.hook === 'output'));

/**
 * Puts the rules for `ifnames` at the top of every target chain that does not have exactly them.
 * Returns [{ chain: 'ip filter input', hook, rules, ok, error, changed }].
 */
function apply(ifnames, opts) {
    const o = opts || {};
    const chains = parse(run(['-a', 'list', 'ruleset'], o.nft));
    return targets(chains).map((c) => {
        const want = [];
        ifnames.forEach((i) => rulesFor(c.hook, i).forEach((r) => want.push(r)));
        const res = { chain: c.family + ' ' + c.table + ' ' + c.chain, hook: c.hook, rules: want.length, ok: true, error: null, changed: false };
        if (c.ours.length === want.length) return res;
        try {
            c.ours.forEach((h) => run(['delete', 'rule', c.family, c.table, c.chain, 'handle', h], o.nft));
            // inserted in reverse, so they read top-down in this order
            want.slice().reverse().forEach((r) => run(['insert', 'rule', c.family, c.table, c.chain].concat(r.split(' '), ['comment', '"' + COMMENT + '"']), o.nft));
            res.changed = true;
        } catch (e) {
            res.ok = false;
            res.error = String((e.stderr || e.message || e)).trim().split('\n')[0];
        }
        return res;
    });
}

/** deletes every rule this test put anywhere; returns how many */
function remove(opts) {
    const o = opts || {};
    let n = 0;
    let text;
    try { text = run(['-a', 'list', 'ruleset'], o.nft); } catch (e) { return 0; }
    parse(text).forEach((c) => c.ours.forEach((h) => {
        try { run(['delete', 'rule', c.family, c.table, c.chain, 'handle', h], o.nft); n++; } catch (e) { /* gone already */ }
    }));
    return n;
}

/** the ruleset as text (for the report), or the error */
function listing(opts) {
    try { return run(['list', 'ruleset'], (opts || {}).nft); } catch (e) { return 'nft list ruleset failed: ' + String(e.stderr || e.message || e).trim(); }
}

module.exports = { COMMENT, parse, rulesFor, targets, apply, remove, listing };
