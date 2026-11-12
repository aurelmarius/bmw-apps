'use strict';
/**
 * page.js - the sign-in page the phone opens over the car's Wi-Fi (the QR code on the iDrive screen): the
 * Tvheadend server's address, the user and the password. Tvheadend has no access token for its API, so the
 * password is kept on the head unit (root's, 0600): a user of its own, with the streaming right only, is best.
 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = 'body{font:17px -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;background:#101418;color:#eef2f5}' +
    'main{max-width:440px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}p{color:#9aa8b4;margin:6px 0 18px}' +
    'label{display:block;font-size:14px;color:#9aa8b4;margin:14px 0 6px}' +
    'input{box-sizing:border-box;width:100%;font-size:17px;padding:12px;border-radius:10px;border:1px solid #33404b;background:#1a2128;color:#eef2f5}' +
    'button{margin-top:22px;width:100%;font-size:17px;font-weight:600;padding:14px;border:0;border-radius:10px;background:#2f8fd8;color:#fff}' +
    '.msg{padding:12px 14px;border-radius:10px;margin:0 0 16px}.bad{background:#4a1d1f}.ok{background:#1d3f24}.hint{font-size:14px}';

function page(title, body) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>' + esc(title) + '</title><style>' + STYLE + '</style></head><body><main>' + body + '</main></body></html>';
}

function form(o) {
    const v = o || {};
    return page('Tvheadend on the iDrive',
        '<h1>Tvheadend on the iDrive</h1><p>Sign in once with a Tvheadend user that may stream. The head unit keeps the password ' +
        '(Tvheadend has no token): a user of its own, with only the streaming right and the mgu-* profiles, is best.</p>' +
        (v.error ? '<div class="msg bad">' + esc(v.error) + '</div>' : '') +
        '<form method="post" action="' + esc(v.action) + '" autocomplete="on">' +
        '<label for="s">Server address</label><input id="s" name="server" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="tv.example.com:9981" value="' + esc(v.server) + '" required>' +
        '<label for="u">User name</label><input id="u" name="user" autocapitalize="off" autocorrect="off" autocomplete="username" value="' + esc(v.user) + '" required>' +
        '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">' +
        '<button type="submit">Sign in</button></form>' +
        '<p class="hint">Without https:// the address is tried with https first, then http; without a port, 9981.</p>');
}

function done(o) {
    return page('Tvheadend on the iDrive', '<h1>Signed in</h1><div class="msg ok">Signed in to ' + esc(o.serverName || o.server) +
        (o.version ? ' (Tvheadend ' + esc(o.version) + ')' : '') + ' as ' + esc(o.user) + '.</div><p>The channels show in the TVH Player app on the iDrive. You can close this page.</p>');
}

const closed = () => page('Tvheadend on the iDrive', '<h1>This page is closed</h1><p>Open it again from the TVH Player app on the iDrive (Sign in).</p>');

module.exports = { form, done, closed, esc };
