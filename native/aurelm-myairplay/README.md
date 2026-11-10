# aurelm-myairplay

The service behind **myAirPlay** (`apps/aurelm_myairplay`). It was developed and tested in the car as "AirPlay
Test" in aurelmarius/bmw-test-apps; the notes below keep that history (versions 0.x).

The service behind the app **myAirPlay** (`apps/aurelm_myairplay`): a network test for a future
AirPlay receiver on the iDrive 7 head unit. It answers one question: **can an iPhone find the head unit
as an AirPlay receiver and connect to it?** Nothing is streamed; it is not a receiver.

**Nothing runs at boot.** systemd listens on `/run/aurelm-myairplay.sock` (socket activation); the
app's first connection starts the service, and it exits by itself 10 minutes after the last test and
the last request. Idle until the app starts a test. While a test runs (15 minutes from the app, 60 at
most):

1. **Firewall.** Accept rules go at the top of every IPv4 input and output base chain (the unit's own
   `ip filter`, which its firewall drops in by default, and mgu-uplink's `inet mgu_uplink`, which lets
   nothing in), for the Wi-Fi-side interfaces only: in, the receiver's tcp port (AirPlay) and udp 5353
   (mDNS); out, that tcp port and udp 5353 from root only (this service, not the car's own responder). Only
   accepts, never a drop. Every rule carries the comment `aurelm-myairplay`; the rules are put back
   when a ruleset load drops them, and removed when the test ends.
2. **mDNS.** A responder on udp 5353 announces `BMW iDrive test` as `_airplay._tcp` and `_raop._tcp`
   (the TXT records open-source receivers such as UxPlay use), answers queries for it, notes every
   AirPlay query (an iPhone asks when Control Center > Screen Mirroring opens), and asks every 10 s who
   is there (`_airplay`, `_raop`, `_companion-link`, `_apple-mobdev2`). Should port 5353 be taken by a
   responder that does not share it, the status names the process that holds it.
3. **The receiver's port.** AirPlay's usual tcp 7000 is taken on the head unit: the car's own CarPlay
   receiver holds it (found in the car, 2026-11-08: the iPhone listed the test receiver and its
   connection to 7000 reached CarPlay, "Unable to Connect"). The receiver therefore listens on tcp 7300,
   or the first free one of 7350, 7400, 47000, and announces that port (mDNS SRV); the log names the
   process that holds 7000 and any port passed over. The port notes who connects and the first request (`GET /info`,
   `POST /pair-setup`, ...) and answer `503`. The iPhone then says it could not connect: expected.

**Interfaces used:** names `wlan*` (the car's hotspot is `wlan_bridge`), `p2p*`, `wfd*`, `uap*`,
`mlan*`, `wl*`, `br*`, `bridge*`, the uplink `vethuplink`, and any address in `172.20.10.0/28` (an
iPhone's Personal Hotspot) or `172.16.222.0/24` (the car's Wi-Fi). Every other interface is listed in
the log, not used.

**Updates.** The deploy tool restarts the service on every install and update (`restart`), so a new
version never waits for the old process to end; the app polls only while its page shows, so the service
can end 10 minutes after the last request; and an app that finds an older service still running (no
test on) asks it once to end (`{"cmd":"exit"}`): it answers, exits 0, and the socket starts the new one
at the next request. Found in the car (2026-11-08): 0.4.0's files were installed while 0.3.0 kept running,
because the app polled it every second from the background.

## The receiver test (stage 1)

"Start receiver" in the app (`{"cmd":"start","mode":"receiver"}`) runs `uxplay-mgu` (`native/uxplay-mgu`:
UxPlay's protocol, as `AppleTV5,4` / `366.0`, with a renderer that only counts) for 15 minutes:

- as **nobody**, a child of this service (its limits: no core dump, nice 10, 200% CPU (2 of 4 cores; 50% made the picture and sound stutter), 256 MiB; `uxplay-mgu`
  is on the crash handler's list too), started again at most 3 times when it exits;
- announced as **BMW iDrive** on one address: the car's Wi-Fi (`wlan_bridge`, wireless CarPlay) first, else
  the iPhone's hotspot; started again when that address changes;
- the firewall opens tcp and udp 7300-7302 and mDNS on the Wi-Fi interfaces, out only for nobody.

The page shows the receiver, the iPhone that connected, the picture (codec, size, frames, keyframes) and the
stream (frames per second, bit rate, sound packets). **PASS** (`rx-video`) is the picture reaching the head
unit; `rx-audio-only` is an iPhone that sends sound and no picture (what iOS does during CarPlay for a
receiver it does not take for an Apple TV).

## The picture (stage 2)

`uxplay-mgu` decodes the mirrored H.264 on the GPU (`native/uxplay-mgu/video`, Moonride's MSDK decoder) into
`/dev/shm/mgu-video-aurelm-myairplay` (1920x720, I420, owned by nobody; the receiver runs in the group `video` for the
render node). The app shows it over the whole screen through mgu-render (`mirror_view.js`) while the car is parked
(strict: no speed reading counts as moving); a tap or the iDrive controller hides it, and the touch screen and the
controller are the HMI's again (claims and grab only while shown). The app ends the iPhone's session when it leaves the
front (`{"cmd":"end-session"}`: the receiver is started again, the iPhone stops mirroring), so CarPlay opens at once.
The receiver asks the iPhone for 1920x720 (`-s 1920x720@60`). The frame file is removed when the
receiver ends (by itself, by the service after a crash, by `cleanup.js` at a stop or an uninstall).

## The sound (stage 3)

`uxplay-mgu` decodes the iPhone's sound (AAC-ELD while mirroring) and plays it into SmartXbar's input for CarLife
(`plug:smartx:CarLifeMedia_CF_48_STEREO`, source 287, unused in Europe), as Moonride does; it runs as nobody in the
groups video and mgu_alsa (it drops root itself: Node cannot give a child supplementary groups). The app routes source
287 to the speakers (`MediaSink_Front`, 1024) through the audio manager while the receiver has an iPhone with sound and
the app is up (`car_audio.js`), and back when it is not; a leftover connection is cleared at start.

## Videos sent with the AirPlay button (stage 4)

With the app's setting **AirPlay video button** (on), the receiver also takes AirPlay's video button (`-hls`): the
iPhone does not send its screen but the video's address, and the head unit plays it itself. For YouTube, UxPlay fetches
the playlists from the iPhone and serves them on its own port (`http://localhost:7300/master.m3u8`), its variants
filtered to H.264, 1080p at 30 fps and 720p at 60 (`-custom AVC:1080,720;HEVC:0;VP9:0;AV1:0`); a direct http(s)
address (Safari's video button) is played as it is. The player (`native/uxplay-mgu/player/mgu_hls.cpp`) reads it with
FFmpeg and shows and plays it through the same GPU decoder, frame file and sound input as mirroring; the iPhone keeps
pause, seek and its progress bar. **It works only while the iPhone is not in a CarPlay session** (in the car,
2026-11-09, 0.9.8/0.9.9: with wireless CarPlay connected the iPhone ends the video, TEARDOWN, a few seconds after it
starts, whatever the identity or network; with CarPlay off it plays on, 720p at ~28 fps, its sound on the speakers,
over the car's Wi-Fi or the iPhone's hotspot). Screen mirroring is the way with CarPlay on.

**Its controls and shape on the iDrive** (0.10): the video plays at its own size in the frame file (the decoder's
"native" mode, display order for its B frames) and the app places it: fill (default), zoom or fit, the setting "Picture
shape" and the ASPECT button. A touch on the picture or the iDrive controller shows Emby's controls bar (controls.js):
-10 s, play / pause, +30 s, aspect, exit, and the progress bar (no stop: ending the video from the iDrive left
YouTube in error; the iPhone's own Stop ends it, and stops the player). Pause, resume and seek reach the player as
`{"cmd":"video","op":"pause"|"resume"|"seek","to":s}`, a line on the receiver's stdin; the iPhone follows through
/playback-info.

**Internet.** The receiver runs as nobody, which mgu-uplink does not route. The video's segments come through
`proxy.js`, a child of the service running as uid **13102** (`component.json` `"internet": true`, `"uids": [13102]`;
the deploy tool writes `/var/opt/mgu-uplink/uids.d/aurelm-myairplay`): on 127.0.0.1:7390 only, `CONNECT` to ports
443 and 80 and plain http requests, names resolved through the uplink's DNS (`/run/mgu-uplink/lease.json`). TLS goes
through the tunnel end to end: the player checks each server's certificate and name against `cacert.pem` (Mozilla's
list, from certifi `b71b898`; the unit has no public one). The proxy runs only while a receiver with the video button
does.

**UxPlay's language.** With `-hls` UxPlay aborts at start without a language in its environment; the service sets
`LANGUAGE=zxx` (no linguistic content) always. It matches no audio track, so UxPlay keeps the one the iPhone's playlist
marks default: YouTube's own choice.

**The receiver's identity** (the app's setting): `AppleTV5,4` / `366.0` as "BMW iDrive" (the default: iOS 27 mirrors
during CarPlay only to it), or UxPlay's own `AppleTV3,2` / `220.68` as "BMW iDrive Video", another receiver to the iPhone
(its device id differs in the last bit; iOS keeps what it learnt per id). YouTube's video button went through UxPlay's
whole HLS exchange on a Mac with the classic one (2026-11-08). To the default one, iOS starts the video with
`POST /action` "playlistInsert" instead of `POST /play` (found in the car, 0.9.1), which UxPlay leaves unimplemented:
`patch.py` handles the inserted item as a `/play` (0.9.2).
`uxplay-mgu` reads `MGU_MODEL` / `MGU_SRCVERS`. The app's log shows the receiver's own lines with the service's: each
request of the iPhone (`iPhone: POST /play`) and UxPlay's errors.

**The video button's TXT bits.** `-hls` adds AirPlay's "video" and "HLS" feature bits to the announcement. Mirroring
during CarPlay depended on the model and version (stage 1); should these bits change that, the setting turns them off
(and the receiver runs as in 0.8).

## Removal leaves nothing

| What | Gone by |
|---|---|
| firewall rules | the end of the test; the service's `ExecStopPost` (`cleanup.js`, after a stop, a crash, a kill or the OOM killer); the tool's `deactivate` (`cleanup.js` again, the first step of an uninstall); a reboot (the unit loads its ruleset afresh) |
| `/var/opt/aurelm-myairplay/` (versions, `state/`: the receiver's identity, the last report) | the deploy tool's uninstall (removes the tool's whole folder) |
| `aurelm-myairplay.socket`, `.service`, the `sockets.target` link, the deploy tool's limits drop-in, the recmgr names | the deploy tool's uninstall |
| `/run/aurelm-myairplay.sock` | the socket's stop (`RemoveOnStop=yes`) |
| `/dev/shm/mgu-video-aurelm-myairplay` | the receiver's exit; the service after a crash; `cleanup.js` (stop, uninstall); a reboot |
| the announcement on the network | a goodbye (TTL 0) when the test ends |
| the proxy (stage 4) | the end of the receiver test; it exits with the service (its IPC channel closes) |
| `/var/opt/mgu-uplink/uids.d/aurelm-myairplay` (uid 13102's internet) | the deploy tool's uninstall |

Nothing is written under `/` (the read-only root file system), no stock file or unit is touched, no
drop-in goes on a unit of the car's.

## Head-unit safety

What the Store's tools learned the hard way (mgu-store, waze-on-cluster), and how this service follows it:

- **No core dump to the crash handler** (it restarts the head unit for a program it does not list):
  `LimitCORE=1` on the service, no root `+` commands (systemd gives them no limits), and every `nft`
  runs as `sh -c 'ulimit -c 1; exec nft ...'`, so also from the deploy tool's `deactivate` hook.
- **recmgr** lists `aurelm-myairplay` (the deploy tool writes it): a crash or exit restarts the
  service, never the head unit. A start limit (10 in 10 minutes) leaves it failed instead of looping.
- **Node 8.9.4** (the 2019 head units' `/usr/bin/node`): plain Node 8 JavaScript; the tests run on
  8.9.4 too.
- **No umask trap:** the service writes only its own files under `/var/opt/aurelm-myairplay`, read
  by root; the app reaches it through the socket, whose mode and owner are set explicitly.
- **The socket is the app's alone:** every OAP app is in `tm_oap_app`, so a socket in that group would
  let any installed app start the test and open the ports (Vizualyse/idrive-apps,
  `knowledge/head-unit.md`). `sockgroup.js` (the socket's `ExecStartPost`, and the service at each
  start) gives it the myAirPlay app's own group, found by its package name under
  `/var/opt/public/oap`, mode 0660; root only (0600) while the app is not installed. The group is read
  when the socket starts: after a fresh install, restart the head unit once.
- **No boot ordering:** nothing waits for it, it waits for nothing of the car's; it does not run at boot.
- **Bounded:** nice 10, idle I/O, 200% CPU (2 of the 4 cores), 256 MiB, 48 tasks (the proxy and the receiver included).
- **CarPlay:** during a test the service shares udp 5353 with the car's own mDNS responder
  (`SO_REUSEADDR`). Multicast reaches both; a unicast mDNS packet may reach only one of them. Run the
  test with CarPlay already connected, and stop it when done.

## Files

| | |
|---|---|
| `probe.js` | the service (root, the unit's `/usr/bin/node`) |
| `dns.js`, `airplay.js` | DNS codec, the AirPlay records |
| `nft.js` | the firewall rules |
| `check.js` | the deploy tool's check: the service answers on its socket |
| `receiver.js` | the receiver test: runs `uxplay-mgu`, reads its reports |
| `proxy.js`, `cacert.pem` | stage 4: the receiver's way to the internet (uid 13102), the CA list its player checks TLS against |
| `uxplay-mgu`, `UXPLAY-LICENSE` | the receiver (built by `native/uxplay-mgu/build.sh`) and UxPlay's license |
| `cleanup.js` | `ExecStopPost` and `deactivate`: removes every rule of the test, never fails |
| `sockgroup.js` | the control socket's group: the app's own, never `tm_oap_app` |

Control: one JSON object per line on the socket, `{"cmd":"status"}`, `{"cmd":"start","minutes":15}` (`"mode":"receiver"`,
`"hls":true` for the receiver with the video button),
`{"cmd":"stop"}`, `{"cmd":"exit"}`; the reply is the status. The last test's status is kept in
`/var/opt/aurelm-myairplay/state/last-report.json` (every 30 s while it runs, and at its end).

Tests: `node tests/myairplay_service.test.js` (also on Node 8.9.4). Package: `python3 tools/pack_tools.py`
(`packages/aurelm-myairplay@<version>.tgz`, the deploy tool's artifact format).
