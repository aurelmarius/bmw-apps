'use strict';
/**
 * airplay.js - the Bonjour records of an AirPlay receiver (screen mirroring and audio), the way
 * open-source receivers (UxPlay, RPiPlay) announce themselves, and which of them answer a query.
 *
 * Only discovery: the TCP port behind them is a probe that notes who connects (probe.js), not a
 * receiver.
 */
const crypto = require('crypto');
const { T, sameName } = require('./dns');

const AIRPLAY = '_airplay._tcp.local';
const RAOP = '_raop._tcp.local';
const SERVICES = '_services._dns-sd._udp.local';
const FEATURES = '0x5A7FFEE6';
const MODEL = 'AppleTV3,2';
const SRCVERS = '220.68';
const TTL_HOST = 120, TTL_SVC = 4500;

/** a new identity: { name, deviceid (AA:BB:..), pk (64 hex), pi (uuid) } */
function newIdentity(name) {
    const mac = crypto.randomBytes(6);
    mac[0] = (mac[0] & 0xfc) | 0x02;   // locally administered, unicast
    const hex = (b) => b.toString('hex');
    const u = crypto.randomBytes(16);
    u[6] = (u[6] & 0x0f) | 0x40; u[8] = (u[8] & 0x3f) | 0x80;
    const h = hex(u);
    return {
        name: name || 'BMW iDrive test',
        deviceid: hex(mac).toUpperCase().match(/../g).join(':'),
        pk: hex(crypto.randomBytes(32)),
        pi: [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-'),
    };
}

/** the names this receiver uses */
function names(id) {
    const host = 'bmw-idrive-' + id.deviceid.replace(/:/g, '').slice(-6).toLowerCase() + '.local';
    return {
        host,
        airplay: id.name + '.' + AIRPLAY,
        raop: id.deviceid.replace(/:/g, '') + '@' + id.name + '.' + RAOP,
    };
}

function txtAirplay(id) {
    return ['deviceid=' + id.deviceid, 'features=' + FEATURES, 'flags=0x4', 'model=' + MODEL, 'pk=' + id.pk, 'pi=' + id.pi,
        'srcvers=' + SRCVERS, 'vv=2'];
}
function txtRaop(id) {
    return ['ch=2', 'cn=0,1,2,3', 'da=true', 'et=0,3,5', 'vv=2', 'ft=' + FEATURES, 'am=' + MODEL, 'md=0,1,2', 'rhd=5.6.0.0',
        'pw=false', 'sr=44100', 'ss=16', 'sv=false', 'tp=UDP', 'txtvers=1', 'sf=0x4', 'vs=' + SRCVERS, 'vn=65537', 'pk=' + id.pk];
}

/**
 * Every record, for the address `ip` of the interface they go out on. ttl0: a goodbye.
 * { ptr: [..], srv: [..], txt: [..], a: rec, svcs: [..] }
 */
function records(id, port, ip, ttl0) {
    const n = names(id);
    const ttl = (t) => (ttl0 ? 0 : t);
    return {
        ptr: [
            { name: AIRPLAY, type: T.PTR, ttl: ttl(TTL_SVC), data: n.airplay },
            { name: RAOP, type: T.PTR, ttl: ttl(TTL_SVC), data: n.raop },
        ],
        srv: [
            { name: n.airplay, type: T.SRV, ttl: ttl(TTL_HOST), flush: true, data: { port, target: n.host } },
            { name: n.raop, type: T.SRV, ttl: ttl(TTL_HOST), flush: true, data: { port, target: n.host } },
        ],
        txt: [
            { name: n.airplay, type: T.TXT, ttl: ttl(TTL_SVC), flush: true, data: txtAirplay(id) },
            { name: n.raop, type: T.TXT, ttl: ttl(TTL_SVC), flush: true, data: txtRaop(id) },
        ],
        a: { name: n.host, type: T.A, ttl: ttl(TTL_HOST), flush: true, data: ip },
        svcs: [
            { name: SERVICES, type: T.PTR, ttl: ttl(TTL_SVC), data: AIRPLAY },
            { name: SERVICES, type: T.PTR, ttl: ttl(TTL_SVC), data: RAOP },
        ],
    };
}

/** the unsolicited announcement (or goodbye): everything */
function announcement(id, port, ip, ttl0) {
    const r = records(id, port, ip, ttl0);
    return { answers: r.ptr.concat(r.srv, r.txt, [r.a]), additionals: [] };
}

const wants = (q, type) => q.type === type || q.type === T.ANY;

/**
 * The answer to a query's questions, or null when none is ours.
 * Known answers (RFC 6762 7.1) are not suppressed: a probe answers every time, and the phone's
 * cache copes.
 */
function answer(id, port, ip, questions) {
    const r = records(id, port, ip, false), n = names(id);
    const an = [], ar = [];
    const add = (list, rec) => { if (list.indexOf(rec) < 0) list.push(rec); };
    questions.forEach((q) => {
        if (sameName(q.name, AIRPLAY) && wants(q, T.PTR)) { add(an, r.ptr[0]); add(ar, r.srv[0]); add(ar, r.txt[0]); add(ar, r.a); }
        else if (sameName(q.name, RAOP) && wants(q, T.PTR)) { add(an, r.ptr[1]); add(ar, r.srv[1]); add(ar, r.txt[1]); add(ar, r.a); }
        else if (sameName(q.name, SERVICES) && wants(q, T.PTR)) { r.svcs.forEach((s) => add(an, s)); }
        else if (sameName(q.name, n.airplay) || sameName(q.name, n.raop)) {
            const i = sameName(q.name, n.airplay) ? 0 : 1;
            if (wants(q, T.SRV)) { add(an, r.srv[i]); add(ar, r.a); }
            if (wants(q, T.TXT)) add(an, r.txt[i]);
        } else if (sameName(q.name, n.host) && wants(q, T.A)) add(an, r.a);
    });
    if (!an.length) return null;
    return { answers: an, additionals: ar.filter((x) => an.indexOf(x) < 0) };
}

/** a question for AirPlay (what an iPhone asks when its Screen Mirroring list opens) */
const isAirplayQuestion = (q) => sameName(q.name, AIRPLAY) || sameName(q.name, RAOP);

module.exports = { AIRPLAY, RAOP, newIdentity, names, records, announcement, answer, isAirplayQuestion };
