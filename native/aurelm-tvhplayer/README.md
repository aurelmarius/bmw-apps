# aurelm-tvhplayer

The service behind the app **TVH Player** (`apps/aurelm_tvhplayer`): Tvheadend's TV channels on the head unit, as Kodi's
Tvheadend client (`kodi-pvr/pvr.hts`) shows them, over Tvheadend's HTTP interface. Signed in with a Tvheadend user,
it lists the channels the user may watch, with what is on now (EPG), and plays one: the server transcodes it with
one of its stream profiles, the head unit's GPU decodes it, and the sound goes to the car's speakers.

**1.0.0** (2026-11-12): TVH 0.1.10 / service 0.1.7 from bmw-test-apps, tested in the car, under its own ids (`aurelm_tvhplayer`, `aurelm-tvhplayer`: units, socket `/run/aurelm-tvhplayer.sock`, state `/var/opt/aurelm-tvhplayer`, frame file `/dev/shm/mgu-video-aurelm-tvhplayer`, sign-in page on 8492), so it can be installed beside the test one; both use uid 13103 for the internet, so remove the test one first. Since step 1 (0.1.x): sign-in, the channels with their logos and what is on now, a channel's programme for the next
24 hours (the guide), a channel playing with a profile from the app's settings, the profile lowered by itself when
the internet is slow. Not yet: recordings (DVR), timeshift, a grid of every channel's programme, HTSP.

**1.0.1** (2026-11-12, the car and the server's log): the stream breaks seen on HBO HD were the server's: Tvheadend's
transcoder stops a stream when the channel's MP2 sound jumps back in time ("Queue input is backward in time ...
non monotonically increasing dts ... muxer reported errors") and closes the connection cleanly; and its `mgu-sd`
profile failed at once, every time ("Error setting option mpegts_flags to value nit ... Failed to write mpegts header"),
so the reconnection, gone a profile down, never came back. Now a stream the server ends cleanly is opened again with
the same profile (only a network failure, a reset or 10 s of silence, takes one down), and a profile whose stream ends
at once (nothing played, within 8 s) twice is passed over for that channel's playing, said in the status
(`badProfiles`, the Status tab's Playing row), the stream going on with the last profile that played.

## Why the server transcodes

A channel as the satellite sends it ("pass") is, for example (PRO TV HD from DIGI, 2026-11-10): H.264 1920x1080
**interlaced** (top field first, every picture), sound in **MP2** and AC-3 5.1, **12 Mbit/s**, a key frame every
2 s. On the head unit that would need deinterlacing on the GPU, an MP2 decoder, and far more than LTE gives. So the
car asks for one of the server's **transcoding profiles**, made for it, and the player takes only what they send:

| Profile (Tvheadend: Configuration > Stream) | What it sends |
|---|---|
| `mgu-hd` | H.264 (VAAPI) 1280x720 **25p, deinterlaced by the server**, about 3 Mbit/s, a key frame each second; AAC stereo 128k; MPEG-TS |
| `mgu-sd` | the same at 576p, about 1.5 Mbit/s |
| `mgu-low` | the same at 360p/432p, about 0.7 Mbit/s, AAC 96k |

Checked against the server (Tvheadend 4.3-2735~gfcd987f0b, VAAPI): `mgu-hd` sends H.264 High 1280x720 25p
progressive, no B frames, a key frame each second, 3.0 Mbit/s, AAC-LC stereo 130k.

A profile that does not deinterlace (or `pass`) still plays: the player says the stream is interlaced, and the
app's page says which profile does not deinterlace. An MP2 sound is refused with "choose a profile that transcodes".

**Subtitles.** A channel with its own subtitle stream (HBO: DVB subtitles, Romanian then Hungarian) has them only
if the profile passes them on: each `mgu-*` profile's **Subtitle codec profile: Copy** (Tvheadend copies the first
subtitle stream). The player lays them over the picture; the app's setting "Subtitles" (on by default) turns them off
(`{"cmd":"prefs",...,"subs":false}`, at once on the channel playing).

**Quality.** The app's setting "Stream profile" (mgu-hd, mgu-sd, mgu-low) is the best one asked for. With "Lower the
profile by itself when the internet is slow" on (the default), the stream running dry (the player "buffering")
twice within a minute, or for 8 s at once, makes the channel go on with the next profile down (a new stream); 5
minutes without running dry, one back up, never above the setting; 30 s at least between two steps. A profile the
server does not list (`api/profile/list`) is passed over.

## Playback

| Step | Where |
|---|---|
| the channels | `api/channel/grid` (the enabled ones, by number; names in ASCII: the kit's fonts are ASCII, Știrile is Stirile), or `/playlist/channels` when the grid lists none; again every 10 minutes |
| what is on now | `api/epg/events/grid?mode=now`, every minute and when a programme ends |
| the guide | `api/epg/events/grid?channel=<uuid>` sorted by start: from what is on now, 24 hours ahead, 60 at most, with the subtitle, the episode and the description (in ASCII, 1200 characters at most); asked for when the app draws it (`{"cmd":"epg"}`), kept 3 minutes. The app shows it over the picture (EPG on the controls: the programme on the left, the one chosen on the right, < > the other channels, a press watches one) and on its page's TV tab (the selected channel's programme, beside the channels). |
| the logos | the channel's `icon_public_url` (or the playlist's `logo=`): the server's logos are public PNGs at their own address with `?v=<hash>` (2026-11-11: 400x240, 5:3, a plate with rounded corners), fetched by the client as they are (no user), kept in `state/logos/<uuid>.png` with `<uuid>.url` for as long as that address stays (a new `?v=` is fetched anew; the one kept for an earlier address is given while the new one cannot be had). A channel without a public logo (none, or `imagecache/<n>`: the server's image cache, which asks for a user, is to stay off) is no failure: `{"cmd":"logo"}` answers `quiet`, and the app shows a plate with the channel's name. The app asks only for the rows it draws, decodes them with the kit's `png.js`, fits them into 60x36 and draws them as runs of one colour (`apps/aurelm_tvhplayer/logos.js`), leaving what is transparent undrawn: mgu-render's own dialect, which the app needs for touch and the controller, takes no pixel images. |
| the stream | `/stream/channel/<uuid>?profile=<profile>`, MPEG-TS, fetched by the client through `netx.js` (the uplink's DNS, our CA list). It goes to the service on the client's fd 4, in frames (stream id, length), and on to `tvh-player`'s stdin (`player.js`), with the pipes' backpressure. A stream that breaks, ends (live TV never ends) or brings nothing for 10 s (a connection LTE dropped without closing it; 15 s for its first bytes) is opened again for **2 minutes** from the break, 1, 2, 4, 8, then every 10 s; with "Lower the profile" on, a stream that had played comes back a profile lower. After 2 minutes the status is an error with `lost: true`: the app keeps the picture's screen ("No connection to the server. Press to try again"). A 503 (no free tuner) and a crashed player: 3 times, then said. A 404 or 401/403: said at once. |
| the player | `native/tvh-player` (its own player, see its README): started as root for its frame file, then **nobody** with the groups `video` and `mgu_alsa`. It waits for 1.5 s of the live stream before it starts (and again after the stream ran dry). The GPU decodes into `/dev/shm/mgu-video-aurelm-tvhplayer`, the sound goes into `plug:smartx:CarLifeMedia_CF_48_STEREO`. |
| on the screen | the app: Emby's `mirror_view.js` over the whole screen, **only while parked** unless the setting "Picture only while parked" is off. The controls (`controls.js`): CH-, CH+, LIST (every channel with what is on now), stop, aspect (fit, zoom, fill), exit. |
| on the speakers | the app routes source 287 to the speakers (`car_audio.js`, Emby's), shared with myAirPlay and Emby: each app disconnects only its own connection and never connects over another's. |

**Another channel** is a new stream and a new player (the server's subscription ends with the old stream). The app
keeps the last channel for "Watch".

**The app's watch.** While a channel plays, the app asks the service every second or two. 90 s without a request
(the app closed or crashed) and the channel stops: no internet is used for a picture and a sound nobody gets.

## Sign-in and authentication

"Sign in" in the app opens a page for 10 minutes on the car Wi-Fi (`http://<car Wi-Fi address>:8492/<random
token>`; Emby's is 8490), shown as a QR code; the iPhone is on that network for wireless CarPlay. The page asks for
the server's address (without `https://`, https is tried first, then http; without a port, 9981), the user and the
password. While it is open, one accept rule per IPv4 input and output base chain lets tcp 8492 in and out on the
car Wi-Fi's interfaces (comment `aurelm-tvhplayer`); the page and the rules go after the sign-in, after 10 minutes, or
when the service stops.

Tvheadend answers with **HTTP Digest** (SHA-256 or MD5, its "Digest hash type") or **Basic**, as its "Authentication
type" is set; the client answers the challenge it gets (SHA-256 first), counting `nc` up, and takes a new one when a
nonce expires. Tvheadend has no access token for its API, so **the password is kept** on the head unit, in
`state/account.json` (root's, 0600; the status never shows it). Use a Tvheadend user of its own, with only:

- Users > Access entries: **Streaming** (Basic), the channels it may watch, **Profiles**: `mgu-hd`, `mgu-sd`, `mgu-low`;
- no web interface admin, no DVR (step 1 needs none).

The sign-in proves the password and the streaming right on `/playlist/channels`: the API's channel and EPG grids
answer an unknown user as anonymous, so they cannot. The client asks that path first after each start too, so its
API requests carry the user.

**Internet.** mgu-uplink routes only the uids a tool lists (`component.json` `"internet": true`, `"uids": [13103]`;
Emby is 13101, myAirPlay 13102): the client is a child running as 13103, names are resolved through the uplink's
DNS servers (`/run/mgu-uplink/lease.json`). TLS (a server behind an https reverse proxy) is checked against
`cacert.pem` (Mozilla's list, as Emby's). Tvheadend itself speaks plain HTTP: through a port forward, Digest keeps
the password off the wire, but the stream is not encrypted.

## How it runs

| Part | Runs as | Does |
|---|---|---|
| `service.js` | root | the app's control socket, the sign-in page, the state; starts `client.js` |
| `client.js` (`tvh.js`, `netx.js`, `playback.js`) | uid 13103 | the Tvheadend client: the API, the channels, EPG now, the stream |
| `tvh-player` (`player.js` starts it) | root, then nobody | the channel: MPEG-TS in, the picture on the GPU, the sound into SmartXbar |

**Lifetime.** Socket activation: the app's first connection starts the service, never the boot. It ends 10 minutes
after the app's last request while nothing plays.

## Removal leaves nothing

| What | Gone by |
|---|---|
| the sign-in page's firewall rules | the page's close; the service's `ExecStopPost` (`cleanup.js`, also after a crash or a kill); the tool's `deactivate`; a reboot |
| `/var/opt/aurelm-tvhplayer/` (versions, `state/`: `account.json` with the password, `prefs.json`, `logos/`) | the deploy tool's uninstall (the logos also at sign-out) |
| `aurelm-tvhplayer.socket`, `.service`, the `sockets.target` link, the recmgr name, `uplink uids.d/aurelm-tvhplayer` | the deploy tool's uninstall |
| `/run/aurelm-tvhplayer.sock` | the socket's stop (`RemoveOnStop=yes`) |
| `/dev/shm/mgu-video-aurelm-tvhplayer` | the player's end; `cleanup.js`; a reboot |
| the route of source 287 to the speakers | the app, when the channel ends; its own connection left by a crash, at the app's next start; a reboot |

## Head-unit safety

As Emby's service: `LimitCORE=1` and no `+` commands, every `nft` through `sh -c 'ulimit -c 1; exec nft ...'`,
recmgr lists `aurelm-tvhplayer`, a start limit (10 in 10 minutes), Node 8.9.4 JavaScript only, nothing written outside
`/var/opt/aurelm-tvhplayer`, the control socket in the TVH app's own group (`sockgroup.js`), never `tm_oap_app`. Bounded:
nice 10, idle I/O, 2 cores at most, 256 MiB, 48 tasks. `tvh-player` runs with the same limits and is listed in
`crashNames`.

## Control

One JSON object per line on `/run/aurelm-tvhplayer.sock`: `{"cmd":"status"}`, `{"cmd":"channels"}` (the list and EPG now),
`{"cmd":"logo","uuid":"..."}` (a logo's PNG), `{"cmd":"epg","uuid":"..."}` (the guide), `{"cmd":"play","uuid":"..."}`, `{"cmd":"stop"}`, `{"cmd":"prefs","profile":"mgu-hd","adaptive":true,"subs":true,"gain":9,"even":false}` (gain: the sound raised by 0-15 dB, the player limiting its peaks; even: its compressor; both at once on the channel playing),
`{"cmd":"refresh"}`, `{"cmd":"signin-open"}`, `{"cmd":"signin-close"}`, `{"cmd":"signout"}`, `{"cmd":"exit"}`.

Tests: `node tests/tvhplayer_service.test.js` (a fake Tvheadend: Digest SHA-256 and MD5 with expiring nonces, Basic, the
sign-in page, channels and EPG, a channel playing through the service to a stand-in player and to `tvh-player`
itself when it is built, another channel, the profile ladder, a broken stream, no free tuner, the app's watch,
the logos fetched once and drawn, a channel's programme, sign-out) and `node tests/tvhplayer_controls.test.js` (the controls over the picture).

**Not checked yet (car only):** everything on the head unit: the uplink, the GPU picture, the speakers.
