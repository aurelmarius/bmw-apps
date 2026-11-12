#!/usr/bin/env node
'use strict';
/* A stand-in for native/emby-player in the tests (no GPU, no ALSA, no build needed): reads the stream on stdin,
 * takes the control lines on fd 3, and reports as the real one does (MGU {json} lines): open, decoder, audio, a
 * tick every 100 ms with the position (stopped while paused), end when the stream ended. FAKE_PLAYER_LOG: a file
 * it appends what it got to ({"bytes"}, {"ctl"}), for the tests to read. FAKE_PLAYER_BUFFERING: "a-b,c-d", seconds
 * since it started in which it reports "buffering" (the stream ran dry). */
const fs = require('fs');
const net = require('net');
const out = (o) => process.stdout.write('MGU ' + JSON.stringify(o) + '\n');
const note = (o) => { if (process.env.FAKE_PLAYER_LOG) fs.appendFileSync(process.env.FAKE_PLAYER_LOG, JSON.stringify(o) + '\n'); };
let bytes = 0, t = 0, paused = false, ended = false;
out({ ev: 'open', video: { codec: 'h264', w: 192, h: 108 }, audio: { codec: 'aac', rate: 48000, channels: 2 } });
out({ ev: 'decoder', ok: false, error: 'off (fake player)' });
out({ ev: 'audio', ok: true, device: 'null', codec: 'aac', rate: 48000, channels: 2 });
process.stdin.on('data', (d) => { bytes += d.length; });
process.stdin.on('end', () => { ended = true; note({ bytes }); });
const ctl = new net.Socket({ fd: 3, readable: true, writable: false });
let buf = '';
ctl.setEncoding('utf8');
ctl.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        note({ ctl: l });
        if (l === 'pause') paused = true;
        else if (l === 'resume') paused = false;
        else if (l === 'quit') process.exit(0);
    }
});
ctl.on('end', () => process.exit(0));
ctl.on('error', () => process.exit(0));
const born = Date.now();
const dry = String(process.env.FAKE_PLAYER_BUFFERING || '').split(',').filter(Boolean).map((w) => w.split('-').map(Number));
const timer = setInterval(() => {
    const age = (Date.now() - born) / 1000;
    const buffering = dry.some((w) => age >= w[0] && age < w[1]);
    if (!paused && bytes && !buffering) t += 0.1;
    out({ ev: 'tick', t: Math.round(t * 1000) / 1000, state: paused ? 'paused' : buffering ? 'buffering' : bytes ? 'playing' : 'starting', shown: Math.round(t * 15), late: 0, decerr: 0,
        aplayed: Math.round(t * 47), alate: 0, aunread: 0, axrun: 0, adev: -1, buffered: 1, kbytes: Math.round(bytes / 1024) });
    // the stream ended and "played" for a moment: the end
    if (ended && t >= Number(process.env.FAKE_PLAYER_SECONDS || 0.3)) {
        out({ ev: 'end', t, shown: Math.round(t * 15), late: 0, aplayed: Math.round(t * 47) });
        clearInterval(timer);
        setTimeout(() => process.exit(0), 50);
    }
}, 100);
process.on('SIGTERM', () => process.exit(0));
