'use strict';
/**
 * dns.js - the little of DNS that an mDNS responder needs (RFC 1035 / RFC 6762):
 * decode a packet's questions and answers, encode a response.
 *
 * Plain Node (8 and later): the unit's /usr/bin/node runs it.
 */

const T = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, NSEC: 47, ANY: 255 };
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;
const UNICAST_RESPONSE = 0x8000;

/* ---------------- decode ---------------- */

/** a name at off; returns [name, next offset]. Follows compression pointers (at most 32). */
function readName(buf, off) {
    const labels = [];
    let next = -1, jumps = 0;
    for (;;) {
        if (off >= buf.length) throw new Error('name past the end');
        const len = buf[off];
        if (len === 0) { off += 1; break; }
        if ((len & 0xc0) === 0xc0) {
            if (off + 1 >= buf.length) throw new Error('pointer past the end');
            if (next < 0) next = off + 2;
            off = ((len & 0x3f) << 8) | buf[off + 1];
            if (++jumps > 32) throw new Error('pointer loop');
            continue;
        }
        if ((len & 0xc0) !== 0) throw new Error('bad label');
        if (off + 1 + len > buf.length) throw new Error('label past the end');
        labels.push(buf.toString('utf8', off + 1, off + 1 + len));
        off += 1 + len;
    }
    return [labels.join('.'), next >= 0 ? next : off];
}

/** { id, qr, opcode, questions: [{name, type, qu}], answers: [{name, type, ttl, data}] } or throws */
function decode(buf) {
    if (buf.length < 12) throw new Error('short packet');
    const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2);
    const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
    let off = 12;
    const questions = [];
    for (let i = 0; i < qd; i++) {
        const r = readName(buf, off);
        off = r[1];
        if (off + 4 > buf.length) throw new Error('question past the end');
        const type = buf.readUInt16BE(off), cls = buf.readUInt16BE(off + 2);
        off += 4;
        questions.push({ name: r[0], type, qu: (cls & UNICAST_RESPONSE) !== 0 });
    }
    const records = [];
    for (let i = 0; i < an + ns + ar; i++) {
        const r = readName(buf, off);
        off = r[1];
        if (off + 10 > buf.length) throw new Error('record past the end');
        const type = buf.readUInt16BE(off), ttl = buf.readUInt32BE(off + 4), rdlen = buf.readUInt16BE(off + 8);
        off += 10;
        if (off + rdlen > buf.length) throw new Error('rdata past the end');
        let data = null;
        try {
            if (type === T.PTR) data = readName(buf, off)[0];
            else if (type === T.A && rdlen === 4) data = Array.prototype.join.call(buf.slice(off, off + 4), '.');
            else if (type === T.SRV) data = { port: buf.readUInt16BE(off + 4), target: readName(buf, off + 6)[0] };
        } catch (e) { data = null; }
        records.push({ name: r[0], type, ttl, data, section: i < an ? 'an' : i < an + ns ? 'ns' : 'ar' });
        off += rdlen;
    }
    return { id, qr: (flags & 0x8000) !== 0, opcode: (flags >> 11) & 0xf, questions, answers: records.filter((x) => x.section === 'an'), records };
}

/* ---------------- encode ---------------- */

function nameBytes(name) {
    const parts = [];
    String(name).split('.').filter((l) => l.length).forEach((l) => {
        const b = Buffer.from(l, 'utf8');
        if (b.length > 63) throw new Error('label too long: ' + l);
        parts.push(Buffer.from([b.length]), b);
    });
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

function txtBytes(entries) {
    const parts = [];
    (entries || []).forEach((s) => {
        const b = Buffer.from(String(s), 'utf8');
        if (b.length > 255) throw new Error('TXT entry too long');
        parts.push(Buffer.from([b.length]), b);
    });
    if (!parts.length) parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

function rdata(rec) {
    switch (rec.type) {
    case T.A: return Buffer.from(String(rec.data).split('.').map(Number));
    case T.PTR: return nameBytes(rec.data);
    case T.TXT: return txtBytes(rec.data);
    case T.SRV: {
        const h = Buffer.alloc(6);
        h.writeUInt16BE(rec.data.priority || 0, 0); h.writeUInt16BE(rec.data.weight || 0, 2); h.writeUInt16BE(rec.data.port, 4);
        return Buffer.concat([h, nameBytes(rec.data.target)]);
    }
    default: throw new Error('cannot encode type ' + rec.type);
    }
}

function recordBytes(rec) {
    const rd = rdata(rec);
    const h = Buffer.alloc(10);
    h.writeUInt16BE(rec.type, 0);
    h.writeUInt16BE(CLASS_IN | (rec.flush ? CACHE_FLUSH : 0), 2);
    h.writeUInt32BE(rec.ttl >>> 0, 4);
    h.writeUInt16BE(rd.length, 8);
    return Buffer.concat([nameBytes(rec.name), h, rd]);
}

/**
 * A response: { id, questions: [{name, type}] (echoed for legacy unicast), answers: [], additionals: [] }.
 * Records: { name, type, ttl, flush, data } (A: dotted ip, PTR: name, TXT: [strings], SRV: {port, target}).
 */
function encodeResponse(r) {
    const qs = r.questions || [], an = r.answers || [], ar = r.additionals || [];
    const h = Buffer.alloc(12);
    h.writeUInt16BE(r.id || 0, 0);
    h.writeUInt16BE(0x8400, 2);   // QR, AA
    h.writeUInt16BE(qs.length, 4); h.writeUInt16BE(an.length, 6); h.writeUInt16BE(0, 8); h.writeUInt16BE(ar.length, 10);
    const parts = [h];
    qs.forEach((q) => { const t = Buffer.alloc(4); t.writeUInt16BE(q.type, 0); t.writeUInt16BE(CLASS_IN, 2); parts.push(nameBytes(q.name), t); });
    an.concat(ar).forEach((rec) => parts.push(recordBytes(rec)));
    return Buffer.concat(parts);
}

/** a query for PTR names (to see who answers) */
function encodeQuery(names) {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(names.length, 4);
    const parts = [h];
    names.forEach((n) => { const t = Buffer.alloc(4); t.writeUInt16BE(T.PTR, 0); t.writeUInt16BE(CLASS_IN, 2); parts.push(nameBytes(n), t); });
    return Buffer.concat(parts);
}

const lower = (s) => String(s).toLowerCase();
const sameName = (a, b) => lower(a).replace(/\.$/, '') === lower(b).replace(/\.$/, '');

module.exports = { T, decode, encodeResponse, encodeQuery, readName, nameBytes, sameName };
