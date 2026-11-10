# video: the GPU decoder (stage 2)

H.264 from the iPhone's screen mirroring, decoded on the head unit's GPU and written to mgu-render's frame file.

| File | From |
|---|---|
| `src/decoder_msdk.cpp`, `.h`, `src/nal_reader.cpp`, `.h` | [JustAnotherPU/moonride](https://github.com/JustAnotherPU/moonride) `native/mgu-moonlight`, commit `a834a14` (GPL-3.0-or-later), its copy of Robert Nisipeanu's waze-on-cluster decoder ([robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps)); unchanged |
| `src/mgvf.cpp`, `.h` | Moonride, same commit: mgu-render's frame file (MGVF) and NV12 -> I420; unchanged but for the SPDX line |
| `abi/include/mfx/` | Intel Media SDK headers as Moonride vendors them (MIT, `abi/include/mfx/LICENSE`) |
| `abi/*.symbols` | Moonride's export lists of the unit's `libmfxhw64`, `libva`, `libva-drm`: link stubs and the import check |
| `tools/ramses_abi.py`, `tools/woc_abi.py` | Robert Nisipeanu's stub generator and import check (GPL-3.0-or-later), from Moonride |
| `src/mgu_video.cpp`, `.h` | ours: UxPlay's renderer -> the decoder -> the frame file |

`mgu_video.cpp` opens, with the first access unit, `/dev/shm/mgu-video-aurelm-myairplay` (1920x720, 3 slots, I420; owned by
nobody, the receiver's user) and the decoder on `/dev/dri/renderD128` (the receiver runs in the group `video`); VPP fits
any picture (portrait, landscape, a rotation mid-stream) into 1920x720 with black bars. The app names the file to
mgu-render and draws it over the screen while the car is parked (`apps/aurelm_myairplay/mirror_view.js`).

The decoder's VA-API path ran on the car in Moonride; this receiver's use of it is checked in the car.
