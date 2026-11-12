# tvh-player

The player of the TVH service (`native/aurelm-tvhplayer`): one Tvheadend channel on the iDrive 7 head unit (MGU). MPEG-TS
comes in on stdin (the service fetches it from Tvheadend with one of the server's transcoding profiles and hands it
over). The picture is decoded on the GPU into mgu-render's frame file, and the sound goes into SmartXbar's CarLife
input. Another channel or another profile starts a new player.

**Its own player.** Everything it is built from is in this folder: nothing is read from `native/emby-player` or
`native/uxplay-mgu`, and a change there never changes it. It began as a copy of aurelm-emby's player (0.3.9), with
the AirPlay receiver's NAL framing, frame file, MSDK headers, ABI lists and checks copied beside it.

| Part | Does |
|---|---|
| demux | libavformat's mpegts demuxer on stdin. The analysis reads up to 1 MiB or 2.5 s of the stream: live TV starts anywhere in a group of pictures, and the size of the picture is known only from the next key frame's SPS (Tvheadend's `mgu-hd`: one each second; 1 s of analysis found 0x0). A video and an audio queue, 6 s or 40 MiB at most. |
| prebuffer | a live stream comes at its own pace, never ahead of the clock: the clock starts once **1.5 s** is queued (`MGU_PREBUFFER_MS`), and a stream that ran dry (buffering) plays again once 1.5 s is queued again. A channel without a picture (radio) waits for its sound's 1.5 s. |
| picture | `src/decoder_msdk.cpp` (VA-API on `/dev/dri/renderD128`): display order, the picture fitted whole into its own shape (at most 1920x1080), each picture into the frame file (`/dev/shm/mgu-video-aurelm-tvhplayer`, MGVF, 3 slots, I420) when the clock reaches it; the app places it (fit, zoom, fill). Each decoded picture's structure (`PicStruct`) is counted: field pictures (an interlaced stream) show in each tick as `fields`. |
| sound | libavcodec's aac, ac3 and eac3 decoders, mixed down to stereo S16 at the volume, written to ALSA `plug:smartx:CarLifeMedia_CF_48_STEREO` (libasound opened at run time, the device non-blocking). Kept on the clock. Any other sound (MP2 from a DVB "pass" stream) is told: `audio` `ok:false` "choose a profile that transcodes". |
| subtitles | the first DVB subtitle stream (`dvb_subtitle`: what a profile passes on with "Subtitle codec profile: Copy"), decoded by libavcodec's `dvbsub` into bitmaps with their palette, kept by their time (until the next one or its own timeout; 30 s without one), scaled to the picture (from the stream's display definition, 1920x1080, or 720x576 without one) and blended into each picture before it goes to the frame file. `open` is followed by `subs` (`ok`, `codec`, `lang`, `on`); the ticks count them (`subs` decoded, `subshown` pictures with one). `subs off` / `subs on` on the control line; `MGU_SUBS=0` starts without them. |
| level | TV is quiet beside the radio (EBU R128 programmes: the server's `mgu-hd` measured -25.5 LUFS, peaks -10 dBFS; HBO -29 LUFS; FM radio about -12), and the CarLife input adds nothing. `gain` raises it (0-15 dB; `MGU_GAIN_DB`; the service sends the app's setting, +9 by default), then a peak limiter holds it under -1 dBFS (instant attack, 150 ms release: only the peaks are taken back, never clipped). `even on` (`MGU_EVEN=1`) puts a gentle compressor first (above -30 dBFS 2.5:1, 5/250 ms, +8 dB made up). Measured through the player into a WAV: `mgu-hd` +9 dB -16.5 LUFS, peak -1.1, nothing limited; +12 dB -13.7 LUFS, 2.5% of samples limited; HBO +12 dB -16.8 LUFS; HBO +9 dB even -15.6 LUFS, LRA 6.8 -> 3.2. The ticks count the samples limited (`limited`) and say `gain` and `even`. |
| clock | monotonic, from the first picture's timestamp; stops while paused and while the stream runs dry. |

**Interlaced.** The server's profiles deinterlace (VAAPI), so nothing is deinterlaced here. A stream that is
interlaced all the same (a profile without deinterlacing, or `pass`) still plays, and is told: `open` has
`"interlaced": true` (from the stream), and the ticks count the field pictures the GPU decoded (`fields`), for the
app to say "this profile does not deinterlace".

**Runs as.** The service starts it as root; it becomes `MGU_RUN_AS` (nobody) with the groups in `MGU_GROUPS` (`video`,
`mgu_alsa`) before it reads a byte, and refuses to run as root; then it makes the frame file (owned by nobody, which
mgu-render takes). It has the service's limits (cgroup, nice 10, `LimitCORE=1`; listed in `crashNames`).

**Ending.** Told to end (`quit`, SIGTERM, the service gone), it closes the sound device first and is gone within 2.5 s.

**Control** (fd 3, one per line): `pause`, `resume`, `volume <0..1>`, `gain <dB 0..15>`, `even on|off`, `subs on|off`, `quit`. **Events** (stdout): `MGU {json}`
with `open` (the streams; the video's `fps` and `interlaced`), `decoder`, `audio`, `tick` (every 500 ms: position,
state, pictures shown and late, field pictures, sound played, dropped and unread, buffered seconds), `end`, `error`.

| Variable | |
|---|---|
| `MGU_VIDEO_PATH` | the frame file (default `/dev/shm/mgu-video-aurelm-tvhplayer`) |
| `MGU_VIDEO_SIZE` | `WxH`, the largest picture (default `1920x1080`) |
| `MGU_VIDEO_OFF` | set: no decoder (a PC); pictures are only timed and counted |
| `MGU_AUDIO` | `alsa:<device>` (default), `null`, or `wav:<path>` (tests) |
| `MGU_ALSA_US` | the ALSA buffer in µs (default 64000) |
| `MGU_PREBUFFER_MS` | queued before playing, and after running dry (default 1500) |
| `MGU_ANALYZE_MS` | how far the stream is analysed (default 2500) |
| `MGU_PROBE_KB` | how much is read for the analysis (default 1024; tests) |

## Build

```sh
sh native/tvh-player/build.sh    # -> native/tvh-player/build/tvh-player (needs git, python3, Docker)
python3 tools/pack_tools.py      # packs it into the aurelm-tvhplayer tool
```

Only this folder is mounted in the build's container (ubuntu:18.04, glibc 2.27 as the unit). FFmpeg n6.1.2 at the
same pinned commit as the other players, with only the mpegts demuxer, the h264, aac and ac3 parsers, and the aac,
ac3 and eac3 decoders, linked statically, as are libstdc++ and libgcc. `build.sh` refuses a binary that asks for
another loader than `/lib/ld-linux-x86-64.so.2`, needs glibc newer than 2.25, does not start in ubuntu:18.04, or
imports something the unit's `libmfxhw64`, `libva` or `libva-drm` do not export (`tools/woc_abi.py`).

**Checked off the car (0.1.0):** the build and its checks; the server's own `mgu-hd` stream (Tvheadend
4.3-2735, VAAPI: H.264 High 1280x720 25p progressive, a key frame each second, about 3 Mbit/s, AAC-LC stereo),
fed at its real pace: open at 3.0 s with its size known, 325 of 325 pictures on time, 610 sound frames played;
`tests/fixtures/tvh_sample.ts` (synthetic, 360p25 H.264 with B frames, AAC) and `tvh_interlaced_mp2.ts` (synthetic,
576i TFF H.264, MP2: told interlaced, its sound refused).

**Not checked yet (car only):** the picture on the GPU and the sound on the speakers with a live channel.

| File | From |
|---|---|
| `src/player.cpp` | aurelm-emby's `native/emby-player/src/player.cpp` (0.3.9), changed for live TV (above) |
| `src/decoder_msdk.cpp`, `.h` | aurelm-emby's copy (Robert Nisipeanu's waze-on-cluster decoder via Moonride, GPL-3.0-or-later); each frame carries its `PicStruct` |
| `src/nal_reader.cpp`, `.h`, `src/mgvf.cpp`, `.h` | [JustAnotherPU/moonride](https://github.com/JustAnotherPU/moonride) `a834a14`, as in `native/uxplay-mgu/video`; unchanged |
| `abi/include/mfx/` | Intel Media SDK headers as Moonride vendors them (MIT, `abi/include/mfx/LICENSE`) |
| `abi/*.symbols`, `tools/*.py` | Moonride's export lists of the unit's libraries; Robert Nisipeanu's stub generator and import check (GPL-3.0-or-later) |

**License.** GPL-3.0-or-later. FFmpeg is LGPL-2.1-or-later; its licence ships with the tool as `FFMPEG-LICENSE`.
