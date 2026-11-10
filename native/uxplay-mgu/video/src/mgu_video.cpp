// SPDX-License-Identifier: GPL-3.0-or-later
/* mgu_video.cpp - stage 2 of the AirPlay receiver: the mirrored H.264 on the GPU, into mgu-render's frame file.
 *
 * UxPlay's renderer (renderer/mgu_renderer.c) hands every access unit it gets (Annex B, decrypted, SPS+PPS
 * before each IDR) to mgu_video_frame(). The first one opens the frame file (MGVF, 3 slots, I420) and the
 * Intel Media SDK decoder (decoder_msdk.cpp, from waze-on-cluster through Moonride: VA-API on
 * /dev/dri/renderD128, VPP fits the picture into the output size, black bars around); each decoded picture is
 * converted NV12 -> I420 into the next slot. The app (apps/aurelm_myairplay) names the file to mgu-render
 * and draws it over the screen while the car is parked.
 *
 * MGU_VIDEO_PATH  the frame file (default /dev/shm/mgu-video-aurelm-myairplay; mgu-render takes it when nobody owns it)
 * MGU_VIDEO_SIZE  WxH, the output (default 1920x720, the centre screen)
 * MGU_VIDEO_OFF   set: stage 1 behaviour, nothing decoded (a PC without the unit's GPU)
 *
 * One mutex: frames come from UxPlay's mirror thread, stop from another.
 */
#include <errno.h>
#include <mutex>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <unistd.h>

#include "decoder_msdk.h"
#include "mgvf.h"
#include "mgu_video.h"
#include "mfx/mfxvideo.h"

/* decoder_msdk.cpp asks this for HEVC only (Moonride's probe.cpp loads the unit's HEVC plugin); screen mirroring is
 * H.264 (the receiver does not offer H.265, features bit 42), so there is no HEVC here */
int hevc_plugin(mfxSession s, void *plugin) { (void) s; (void) plugin; return -1; }

namespace {
std::mutex g_mu;
woc::Decoder *g_dec = nullptr;
ytdec::Mgvf g_mgvf;
bool g_open = false, g_failed = false, g_reported = false, g_file = false;
/* stage 4: a played video's own shape: the decoder outputs the stream's size, and the frame file is made at the
 * first picture with that size (the app places it: fit, zoom, fill); mirroring keeps MGU_VIDEO_SIZE, fitted */
bool g_native = false;
unsigned long long g_shown = 0, g_errors = 0;
uint32_t g_w = 1920, g_h = 720;
std::string g_path = "/dev/shm/mgu-video-aurelm-myairplay", g_err;

/* opens the frame file and the decoder; false (once, with g_err) when it cannot */
bool open_locked() {
    if (g_open) return true;
    if (g_failed) return false;
    if (getenv("MGU_VIDEO_OFF")) { g_failed = true; g_err = "off (MGU_VIDEO_OFF)"; return false; }
    const char *p = getenv("MGU_VIDEO_PATH");
    if (p && *p) g_path = p;
    const char *sz = getenv("MGU_VIDEO_SIZE");
    unsigned w = 0, h = 0;
    if (sz && sscanf(sz, "%ux%u", &w, &h) == 2 && w >= 16 && h >= 16 && w <= 2048 && h <= 2048) g_w = w & ~1u, g_h = h & ~1u;
    std::string err, warn;
    if (!g_file && !g_native) {
        if (!g_mgvf.open(g_path.c_str(), g_w, g_h, 3, &err, &warn)) { g_failed = true; g_err = "frame file: " + err; return false; }
        g_file = true;
    }
    if (!g_dec) g_dec = new woc::Decoder();
    if (!g_dec->init("/dev/dri/renderD128", g_native ? 0 : g_w, g_native ? 0 : g_h, false, &err)) {
        g_failed = true;
        g_err = "decoder: " + err;
        g_mgvf.close();
        g_file = false;
        return false;
    }
    g_open = true;
    return true;
}
}  // namespace

/* one access unit; with `wait`, each decoded picture is held until wait(pts_ms) says (stage 4: a played stream's
 * pictures at their time; wait returns 0 to show it, 1 to drop it, too late) */
static int frame_locked(const unsigned char *data, int len, long long pts_ms, int (*wait)(long long, void *), void *arg,
                        unsigned long long *shown, unsigned long long *errors) {
    int ret = 0;
    if (!open_locked()) {
        ret = g_reported ? 0 : -1;   /* -1 once: the caller reports mgu_video_error() */
        g_reported = true;
    } else {
        std::string err;
        const bool ok = g_dec->feed(data, (size_t) len, [&](const woc::VideoFrame &f) {
            if (!f.y) return;
            if (wait && wait(f.pts_ms, arg) != 0) return;
            if (g_native && (!g_file || (f.w & ~1u) != g_w || (f.h & ~1u) != g_h)) {
                /* the stream's own size: the frame file made (again) for it */
                std::string ferr, fwarn;
                if (g_file) { g_mgvf.close(); g_file = false; }
                const uint32_t w = f.w & ~1u, h = f.h & ~1u;
                if (w < 16 || h < 16 || w > 2048 || h > 2048 || !g_mgvf.open(g_path.c_str(), w, h, 3, &ferr, &fwarn)) {
                    g_errors++;
                    if (g_errors <= 3) fprintf(stderr, "mgu_video: frame file %ux%u: %s\n", w, h, ferr.c_str());
                    return;
                }
                g_file = true; g_w = w; g_h = h;
            }
            if (!g_file) return;
            ytdec::nv12_to_i420(f.y, f.uv, f.pitch, g_native ? g_w : f.w, g_native ? g_h : f.h, g_mgvf.begin());
            g_mgvf.commit();
            g_shown++;
        }, &err, true, true, wait ? (int64_t) pts_ms : -1);
        if (!ok) { g_errors++; if (g_errors <= 3 || g_errors % 100 == 0) fprintf(stderr, "mgu_video: %s\n", err.c_str()); }
        if (!g_reported) { g_reported = true; ret = 1; }   /* 1 once: opened */
    }
    if (shown) *shown = g_shown;
    if (errors) *errors = g_errors;
    return ret;
}

extern "C" int mgu_video_frame(const unsigned char *data, int len, unsigned long long *shown, unsigned long long *errors) {
    std::lock_guard<std::mutex> l(g_mu);
    return frame_locked(data, len, -1, nullptr, nullptr, shown, errors);
}

extern "C" int mgu_video_frame_timed(const unsigned char *data, int len, long long pts_ms, int (*wait)(long long, void *), void *arg,
                                     unsigned long long *shown, unsigned long long *errors) {
    std::lock_guard<std::mutex> l(g_mu);
    return frame_locked(data, len, pts_ms, wait, arg, shown, errors);
}

/* stage 4: a played video has B frames: its pictures in display order (from the decoder's next start) */
extern "C" void mgu_video_display_order(int on) {
    std::lock_guard<std::mutex> l(g_mu);
    woc::Decoder::set_display_order(on != 0);
}

/* stage 4: 1 the stream's own size (the frame file made at the first picture), 0 MGU_VIDEO_SIZE (mirroring); from
 * the next open */
extern "C" void mgu_video_native(int on) {
    std::lock_guard<std::mutex> l(g_mu);
    g_native = on != 0;
}

/* a seek: the decoder starts again at the next SPS; the frame file and its last picture stay */
extern "C" void mgu_video_reset(void) {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_open && g_dec) g_dec->shutdown();
    g_open = false;
    g_failed = false;
}

/* the stream ended: the decoder is let go (a new stream starts at its first SPS); the file keeps the last
 * picture until mgu_video_close() */
extern "C" void mgu_video_stop(void) {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_open && g_dec) { g_dec->shutdown(); }
    g_open = false;
    g_failed = false;
    g_reported = false;
    g_mgvf.close();
    g_file = false;
}

/* at exit: no frame file left behind */
extern "C" void mgu_video_close(void) {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_dec) { g_dec->shutdown(); delete g_dec; g_dec = nullptr; }
    g_open = false;
    g_mgvf.close();
    g_file = false;
    unlink(g_path.c_str());
}

extern "C" const char *mgu_video_error(void) { return g_err.c_str(); }
extern "C" const char *mgu_video_path(void) { return g_path.c_str(); }
extern "C" void mgu_video_size(unsigned *w, unsigned *h) { if (w) *w = g_w; if (h) *h = g_h; }
