# uxplay-mgu

UxPlay's AirPlay mirroring protocol for the iDrive 7 head unit (MGU), run by the service
`aurelm-myairplay` in its receiver test. The renderer (`renderer/mgu_renderer.c`) replaces UxPlay's GStreamer renderers: it reports what the iPhone sends
(client, codec and size, frames, frame rate, bit rate, keyframes, sound packets, pictures decoded) on stdout as
`MGU {json}` lines and, **stage 2**, hands every access unit to the GPU decoder (`video/`, see its README), which writes
the pictures to mgu-render's frame file. **Stage 3**: every audio packet goes to `audio/mgu_audio.cpp`: AAC-ELD (mirroring), ALAC or AAC-LC decoded with
libavcodec (FFmpeg n6.1.2, built by `build.sh`, LGPL-2.1-or-later, its licence ships
as `FFMPEG-LICENSE`), at the iPhone's volume, into ALSA `plug:smartx:CarLifeMedia_CF_48_STEREO` (libasound opened at
run time, the device non-blocking, late packets dropped: Moonride's way). Started as root by the service, the binary
drops to nobody with the groups video and mgu_alsa itself (`MGU_RUN_AS`, `MGU_GROUPS`) before anything runs, and refuses
to run if it cannot.

**Stage 4**: a video sent with AirPlay's video button (`-hls`; YouTube's HLS through UxPlay's local playlists, or a
direct http(s) address) is played by `player/mgu_hls.cpp` in place of GStreamer's playbin: libavformat reads it (hls,
mpegts, mp4; http, https through `http_proxy`, the service's proxy), one H.264 stream (the highest bitrate up to
1080p and 8 Mbit/s) goes to the GPU decoder with each picture held until its time, one audio stream to the sound
above in the stream's own codec and rate. A clock (held while paused, and while the queue runs dry until 1.5 s is read
again) paces both; the iPhone's pause, seek and progress bar come through UxPlay (`/rate`, `/scrub`,
`/playback-info`). FFmpeg is built with its network, OpenSSL's TLS and those demuxers; `ffmpeg-tls.py` makes its TLS
check the certificate and the server's name against `MGU_CA_FILE` by default (FFmpeg 6.1 checks neither unless asked,
and the hls demuxer opens each segment without our options).

| | |
|---|---|
| `UXPLAY_REV` | the UxPlay commit built ([FDH2/UxPlay](https://github.com/FDH2/UxPlay), UxPlay 1.74) |
| `patch.py` | the changes to it: model `AppleTV5,4` and version `366.0` (iOS 27 sends the mirrored picture during CarPlay only to a receiver that presents itself so; found 2026-11-08), and the mDNS address from `UXPLAY_MDNS_IPV4` with `UXPLAY_MDNS_NO_IPV6` (the head unit has several interfaces) |
| `renderer/mgu_renderer.c` | the renderer API without GStreamer |
| `player/mgu_hls.cpp`, `player/test_hls.cpp` | stage 4: the player, and a program that plays an address off the car (`make ... build/out/test_hls`; `MGU_VIDEO_OFF=1`, `MGU_AUDIO=wav:<file>`) |
| `ffmpeg-tls.py` | FFmpeg's TLS checks certificates and names by default (`MGU_CA_FILE`) |
| `Makefile`, `build.sh` | the build: ubuntu:18.04 (glibc 2.27, as the unit) in Docker; libplist 2.6.0 from its release, OpenSSL 1.1.1, GLib and PCRE linked statically. The binary needs only glibc (2.27 at most) and asks for the unit's loader, `/lib/ld-linux-x86-64.so.2` (the unit has no `/lib64`: 0.6.0 asked for `/lib64/...` and did not start, ENOENT); `build.sh` checks it and starts it in ubuntu:18.04 with the loader there |

```sh
sh native/uxplay-mgu/build.sh    # -> native/uxplay-mgu/build/uxplay-mgu (needs git, python3, Docker)
python3 tools/pack_tools.py      # packs it into the aurelm-myairplay tool
```

The service runs it as `uxplay-mgu -n "BMW iDrive" -nh -p 7300 -m <deviceid>`, as nobody, with
`UXPLAY_MDNS_IPV4=<the car's Wi-Fi address>`: tcp and udp 7300-7302 (tcp 7000 is the car's own CarPlay
receiver's).

**License.** UxPlay is GPL-3.0 (its `LICENSE` ships with the tool as `UXPLAY-LICENSE`); this folder is
GPL-3.0-or-later. The binary in the tool is built from the commit in `UXPLAY_REV` with the changes above,
all in this repository.
