// SPDX-License-Identifier: GPL-3.0-or-later
/* tvh-player - plays one Tvheadend channel on the head unit: MPEG-TS on stdin, the picture on the GPU into
 * mgu-render's frame file, the sound into SmartXbar's CarLife input.
 *
 * The TVH service (native/aurelm-tvhplayer) fetches the channel's stream from Tvheadend with one of the server's
 * transcoding profiles (H.264, progressive: the server deinterlaces; AAC; MPEG-TS) and writes it to our stdin;
 * another channel or another profile is a new player. Started as root, it becomes MGU_RUN_AS (nobody) with the
 * groups in MGU_GROUPS (video: the GPU's render node; mgu_alsa: the sound devices) before it reads a byte of the
 * stream, and refuses to run as root. The frame file is made once the stream's picture is known, in the
 * picture's own shape (fitted into MGU_VIDEO_SIZE), owned by nobody (which mgu-render takes): the app places it.
 *
 * Its own copy of aurelm-emby's player (native/emby-player), with the decoder, the NAL framing, the frame file and
 * the MSDK headers beside it (nothing read from another folder), changed for live TV:
 *   - a live stream comes at its own pace, never ahead: the clock starts once MGU_PREBUFFER_MS of it is queued,
 *     and a stream that ran dry plays again once that much is queued again (a film's 1 s was too little on LTE);
 *   - the picture structure of what is decoded is counted: an interlaced stream (a profile that does not
 *     deinterlace, or "pass") is told in "open" and in each tick ("fields"), for the app to say so;
 *   - a channel without a picture (radio) plays its sound alone, with the same prebuffer;
 *   - DVB subtitles (the first subtitle stream: Tvheadend's transcoder copies the channel's first one, its profile's
 *     "Subtitle codec profile: Copy") are decoded and laid over each picture before it goes to the frame file, scaled
 *     from the subtitles' own display (1920x1080 from DVB-C HBO) to the picture's size. "subs on" / "subs off".
 *
 *   demux (main thread)  libavformat's mpegts demuxer on stdin -> a video and an audio queue (bounded)
 *   video thread         the MSDK decoder (decoder_msdk.cpp: display order, fit whole), each picture into the
 *                        frame file when the clock reaches it; late ones are decoded without a picture
 *   audio thread         libavcodec (aac, ac3, eac3) -> stereo S16 at the volume -> ALSA, kept on the clock
 *   the clock            the monotonic clock from the first picture's timestamp; stopped while paused or while
 *                        the stream runs dry (buffering)
 *
 * Control (fd 3, one per line): pause | resume | volume <0..1> | gain <dB 0..15> | even on | even off | subs on | subs off | quit
 *
 * The sound's level: TV is quiet beside the radio (EBU R128: the server's mgu-hd -25.7 LUFS, peaks -10 dBFS; HBO's
 * films -29 LUFS; FM radio about -12): `gain` raises it (MGU_GAIN_DB, default 0; the service gives the app's setting),
 * a peak limiter keeps it under -1 dBFS (instant attack, 150 ms release: the gain is only taken back on peaks).
 * `even` (MGU_EVEN=1) adds a gentle compressor before it (above -30 dBFS 2.5:1, 5 ms / 250 ms, +8 dB made up): speech
 * up, explosions down, for a car's road noise. The ticks count the samples the limiter lowered (`limited`).
 * Events (stdout, one per line): MGU {json}: open, decoder, audio, tick (each 500 ms), end, error
 *
 * MGU_VIDEO_PATH   the frame file (default /dev/shm/mgu-video-aurelm-tvhplayer)
 * MGU_VIDEO_SIZE   WxH, the largest picture (default 1920x1080): the picture's shape fitted into it
 * MGU_VIDEO_OFF    set: no decoder (a PC: pictures are only timed and counted)
 * MGU_AUDIO        alsa:<device> (default alsa:plug:smartx:CarLifeMedia_CF_48_STEREO) | null | wav:<path> (tests)
 * MGU_ALSA_US      the ALSA buffer in us (default 64000)
 * MGU_PROBE_KB     how much of the stream is read to find its streams (default 1024; tests)
 * MGU_PREBUFFER_MS what is queued before the clock starts, and again after the stream ran dry (default 1500)
 * MGU_ANALYZE_MS   how far the stream is analysed for its streams (default 2500: past the next key frame)
 * MGU_SUBS         0: the subtitles off from the start (default on)
 * MGU_GAIN_DB      the sound raised by this many dB, 0..15 (default 0), with the limiter
 * MGU_EVEN         1: the compressor on from the start
 * MGU_SUB_DUMP     <path>: with MGU_VIDEO_OFF, the first pictures a subtitle is on are written as I420 (a grey picture
 *                  with the subtitle laid over), <path>-<n>.yuv, the picture's size: tests
 */
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <math.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
}

#include "decoder_msdk.h"
#include "mgvf.h"
#include "mfx/mfxvideo.h"

/* decoder_msdk.cpp asks this for HEVC only; the server's profiles send H.264 */
int hevc_plugin(mfxSession s, void *plugin) { (void) s; (void) plugin; return -1; }

namespace {

/* ---------- events ---------- */
std::mutex g_out_mu;
void event(const char *fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    std::lock_guard<std::mutex> l(g_out_mu);
    fprintf(stdout, "MGU %s\n", buf);
    fflush(stdout);
}
/* s as a JSON string's body */
std::string js(const std::string &s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if ((unsigned char) c < 0x20) o += ' ';
        else o += c;
    }
    return o;
}

double mono() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}
void sleep_s(double s) {
    if (s <= 0) return;
    struct timespec ts;
    ts.tv_sec = (time_t) s;
    ts.tv_nsec = (long) ((s - ts.tv_sec) * 1e9);
    nanosleep(&ts, nullptr);
}

std::atomic<bool> g_quit(false);

/* ---------- the clock ---------- */
class Clock {
public:
    /* media seconds now; before the start, the start value */
    double now() {
        std::lock_guard<std::mutex> l(mu_);
        return running_locked() ? base_ + (mono() - t0_) : base_;
    }
    bool started() { std::lock_guard<std::mutex> l(mu_); return started_; }
    bool paused() { std::lock_guard<std::mutex> l(mu_); return paused_; }
    bool stalled() { std::lock_guard<std::mutex> l(mu_); return stalled_; }
    /* the first one wins */
    void start(double media) {
        {
            std::lock_guard<std::mutex> l(mu_);
            if (started_) return;
            started_ = true;
            base_ = media;
            t0_ = mono();
        }
        cv_.notify_all();
    }
    void set_paused(bool p) { set(&paused_, p); }
    void set_stalled(bool s) { set(&stalled_, s); }
    /* waits until started, at most `s` seconds; true when started */
    bool wait_start(double s) {
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait_for(l, std::chrono::milliseconds((int) (s * 1000)), [&] { return started_ || g_quit.load(); });
        return started_;
    }

private:
    bool running_locked() const { return started_ && !paused_ && !stalled_; }
    void set(bool *flag, bool v) {
        std::lock_guard<std::mutex> l(mu_);
        if (*flag == v) return;
        const bool was = running_locked();
        if (was) base_ += mono() - t0_;   /* freeze where it is */
        *flag = v;
        if (running_locked()) t0_ = mono();
    }
    std::mutex mu_;
    std::condition_variable cv_;
    bool started_ = false, paused_ = false, stalled_ = false;
    double base_ = 0, t0_ = 0;
};
Clock g_clock;

/* ---------- the queues ---------- */
struct Packet {
    std::vector<uint8_t> data;
    double pts = NAN;   /* media seconds, NAN unknown */
    double dur = 0;
};
class Queue {
public:
    void push(Packet &&p) {
        {
            std::lock_guard<std::mutex> l(mu_);
            bytes_ += p.data.size();
            if (!isnan(p.pts)) { if (isnan(first_)) first_ = p.pts; last_ = p.pts; }
            q_.push_back(std::move(p));
        }
        cv_.notify_all();
    }
    /* false: the stream ended and the queue is empty (or quit) */
    bool pop(Packet *out, double wait_s) {
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait_for(l, std::chrono::milliseconds((int) (wait_s * 1000)), [&] { return !q_.empty() || eof_ || g_quit.load(); });
        if (q_.empty()) { empty_ = true; return false; }
        *out = std::move(q_.front());
        q_.pop_front();
        bytes_ -= out->data.size();
        first_ = NAN;
        for (auto &p : q_) if (!isnan(p.pts)) { first_ = p.pts; break; }
        if (q_.empty()) last_ = NAN;
        return true;
    }
    void end() { { std::lock_guard<std::mutex> l(mu_); eof_ = true; } cv_.notify_all(); }
    void wake() { cv_.notify_all(); }
    bool eof() { std::lock_guard<std::mutex> l(mu_); return eof_; }
    bool drained() { std::lock_guard<std::mutex> l(mu_); return eof_ && q_.empty(); }
    size_t bytes() { std::lock_guard<std::mutex> l(mu_); return bytes_; }
    size_t count() { std::lock_guard<std::mutex> l(mu_); return q_.size(); }
    /* seconds between the first and the last timestamp queued */
    double span() { std::lock_guard<std::mutex> l(mu_); return isnan(first_) || isnan(last_) ? 0 : last_ - first_; }

private:
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<Packet> q_;
    size_t bytes_ = 0;
    double first_ = NAN, last_ = NAN;
    bool eof_ = false, empty_ = false;
};
Queue g_vq, g_aq;
bool g_has_video = false, g_has_audio = false;

const double kAhead = 6.0;              /* seconds queued before the demuxer waits */
const size_t kMaxBytes = 40u << 20;     /* or this many bytes */
double g_pre = 1.5;                     /* MGU_PREBUFFER_MS: queued before the clock starts, and to end buffering */
std::atomic<bool> g_prebuffered(false);  /* the video thread waited for its prebuffer (or there is no picture) */
const double kLate = 0.12;              /* a picture later than this is not shown */

/* a queue ran dry while the stream goes on: the clock stops until it refills */
void starved() {
    if (g_clock.started() && !g_clock.paused() && !g_vq.eof() && !g_clock.stalled()) g_clock.set_stalled(true);
}

/* ---------- stats ---------- */
std::atomic<unsigned long long> s_fields(0), s_shown(0), s_late(0), s_decerr(0), s_vpk(0), s_apk(0), s_aplayed(0), s_alate(0),
    s_aunread(0), s_axrun(0), s_aerr(0), s_bytes(0), s_limited(0);
std::atomic<int> s_adev_ms(-1);
double g_first_pts = NAN;   /* the stream's first timestamp: positions are counted from it */
std::mutex g_first_mu;
void note_first(double pts) {
    std::lock_guard<std::mutex> l(g_first_mu);
    if (isnan(g_first_pts) || pts < g_first_pts) g_first_pts = pts;
}
double first_pts() { std::lock_guard<std::mutex> l(g_first_mu); return isnan(g_first_pts) ? 0 : g_first_pts; }

/* ---------- video ---------- */
bool g_video_off = false;
ytdec::Mgvf g_mgvf;
std::string g_video_path = "/dev/shm/mgu-video-aurelm-tvhplayer";
uint32_t g_vw = 1920, g_vh = 1080, g_maxw = 1920, g_maxh = 1080;

/* the picture's size: the film's display shape (its pixels' aspect included), fitted into the largest one, even */
void picture_size(const AVCodecParameters *cp, AVRational sar) {
    double w = cp->width > 0 ? cp->width : 1920, h = cp->height > 0 ? cp->height : 1080;
    if (sar.num > 0 && sar.den > 0) w = w * sar.num / sar.den;
    double k = std::min(std::min(g_maxw / w, g_maxh / h), 1.0);
    if (w * k < 16 || h * k < 16) k = std::max(16 / w, 16 / h);
    g_vw = std::max(16u, (uint32_t) (w * k + 0.5) & ~1u);
    g_vh = std::max(16u, (uint32_t) (h * k + 0.5) & ~1u);
}
const double kPtsOffset = 20.0;   /* timestamps given to MSDK: never negative (B frames before the first I) */

/* ---------- DVB subtitles ---------- */
/* a page of subtitles as the decoder gives it (indexed bitmaps on the subtitles' own display, dw x dh, a palette each),
 * shown from start until end or the next page; the picture's copy is made at its first use (scaled, Y U V A) */
struct SubRect { int x = 0, y = 0, w = 0, h = 0; std::vector<uint8_t> idx; uint8_t pal[256][4]; };   /* pal: Y U V A */
struct SubScaled { int x = 0, y = 0, w = 0, h = 0; std::vector<uint8_t> y_, a, u, v, ca; };       /* ca, u, v: half size */
struct SubPage {
    double start = 0, end = 0;
    int dw = 720, dh = 576;
    std::vector<SubRect> rects;
    uint32_t fw = 0, fh = 0;
    std::vector<SubScaled> sc;
};
std::mutex g_sub_mu;
std::deque<std::shared_ptr<SubPage>> g_subs;
std::atomic<bool> g_subs_on(true);
std::atomic<unsigned long long> s_subpages(0), s_subshown(0);
AVCodecContext *g_subctx = nullptr;
AVStream *g_ss = nullptr;

inline uint8_t clamp8(double v) { return v < 0 ? 0 : v > 255 ? 255 : (uint8_t) lrint(v); }
/* RGB -> BT.709 limited range (the server's H.264 is HD, BT.709) */
void yuv709(int r, int g, int b, uint8_t *Y, uint8_t *U, uint8_t *V) {
    const double y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    *Y = clamp8(16 + y * 219.0 / 255.0);
    *U = clamp8(128 + (b - y) / 1.8556 * 224.0 / 255.0);
    *V = clamp8(128 + (r - y) / 1.5748 * 224.0 / 255.0);
}

/* a decoded page (pts: its packet's, in the stream's seconds) */
void sub_add(const AVSubtitle &sub, double pts, int dw, int dh) {
    auto pg = std::make_shared<SubPage>();
    pg->start = pts + sub.start_display_time / 1000.0;
    pg->end = sub.end_display_time ? pts + sub.end_display_time / 1000.0 : pts + 30.0;
    if (dw > 0 && dh > 0) { pg->dw = dw; pg->dh = dh; }
    for (unsigned i = 0; i < sub.num_rects; i++) {
        const AVSubtitleRect *r = sub.rects[i];
        if (!r || r->type != SUBTITLE_BITMAP || r->w <= 0 || r->h <= 0 || !r->data[0] || !r->data[1]) continue;
        SubRect q;
        q.x = r->x; q.y = r->y; q.w = r->w; q.h = r->h;
        q.idx.resize((size_t) r->w * r->h);
        for (int y = 0; y < r->h; y++) memcpy(&q.idx[(size_t) y * r->w], r->data[0] + (size_t) y * r->linesize[0], (size_t) r->w);
        const uint32_t *pal = (const uint32_t *) r->data[1];
        memset(q.pal, 0, sizeof q.pal);
        for (int c = 0; c < r->nb_colors && c < 256; c++) {
            const uint32_t v = pal[c];   /* 0xAARRGGBB */
            yuv709((v >> 16) & 255, (v >> 8) & 255, v & 255, &q.pal[c][0], &q.pal[c][1], &q.pal[c][2]);
            q.pal[c][3] = (uint8_t) (v >> 24);
        }
        pg->rects.push_back(std::move(q));
    }
    if (!pg->rects.empty()) s_subpages++;
    std::lock_guard<std::mutex> l(g_sub_mu);
    g_subs.push_back(pg);
    while (g_subs.size() > 32) g_subs.pop_front();
}

/* the page on at pts, or none */
std::shared_ptr<SubPage> sub_at(double pts) {
    std::lock_guard<std::mutex> l(g_sub_mu);
    std::shared_ptr<SubPage> cur;
    size_t at = 0;
    for (size_t i = 0; i < g_subs.size(); i++) if (g_subs[i]->start <= pts + 0.02) { cur = g_subs[i]; at = i; }
    while (at > 0) { g_subs.pop_front(); at--; }   /* the ones before it are done with */
    if (!cur || cur->rects.empty() || pts >= cur->end) return nullptr;
    return cur;
}

/* the page scaled to the picture (W x H), each picture pixel the alpha-weighted mean of the subtitle pixels it covers */
void sub_scale(SubPage &pg, uint32_t W, uint32_t H) {
    pg.sc.clear(); pg.fw = W; pg.fh = H;
    const double sx = (double) W / pg.dw, sy = (double) H / pg.dh;
    for (const SubRect &r : pg.rects) {
        SubScaled s;
        int x0 = (int) floor(r.x * sx) & ~1, y0 = (int) floor(r.y * sy) & ~1;
        int x1 = (int) ceil((r.x + r.w) * sx), y1 = (int) ceil((r.y + r.h) * sy);
        x1 += x1 & 1; y1 += y1 & 1;
        if (x1 > (int) W) x1 = (int) W & ~1;
        if (y1 > (int) H) y1 = (int) H & ~1;
        if (x1 <= x0 || y1 <= y0) continue;
        s.x = x0; s.y = y0; s.w = x1 - x0; s.h = y1 - y0;
        const size_t n = (size_t) s.w * s.h;
        s.y_.assign(n, 0); s.a.assign(n, 0);
        std::vector<double> pu(n, 0), pv(n, 0);
        for (int dy = 0; dy < s.h; dy++) {
            int a0 = (int) floor((y0 + dy) / sy) - r.y, a1 = (int) floor((y0 + dy + 1) / sy) - r.y;
            if (a1 <= a0) a1 = a0 + 1;
            for (int dx = 0; dx < s.w; dx++) {
                int b0 = (int) floor((x0 + dx) / sx) - r.x, b1 = (int) floor((x0 + dx + 1) / sx) - r.x;
                if (b1 <= b0) b1 = b0 + 1;
                double sa = 0, syv = 0, su = 0, sv = 0; int cnt = 0;
                for (int yy = a0; yy < a1; yy++) {
                    if (yy < 0 || yy >= r.h) continue;
                    for (int xx = b0; xx < b1; xx++) {
                        if (xx < 0 || xx >= r.w) continue;
                        const uint8_t *c = r.pal[r.idx[(size_t) yy * r.w + xx]];
                        sa += c[3]; syv += c[0] * c[3]; su += c[1] * c[3]; sv += c[2] * c[3]; cnt++;
                    }
                }
                const size_t i = (size_t) dy * s.w + dx;
                if (!cnt || sa <= 0) continue;
                s.a[i] = clamp8(sa / cnt);
                s.y_[i] = clamp8(syv / sa);
                pu[i] = su / sa; pv[i] = sv / sa;
            }
        }
        /* chroma: a 2x2 block's alpha-weighted mean */
        const int cw = s.w / 2, chh = s.h / 2;
        s.u.assign((size_t) cw * chh, 128); s.v.assign((size_t) cw * chh, 128); s.ca.assign((size_t) cw * chh, 0);
        for (int cy = 0; cy < chh; cy++) for (int cx = 0; cx < cw; cx++) {
            double sa = 0, su = 0, sv = 0;
            for (int k = 0; k < 4; k++) {
                const size_t i = (size_t) (cy * 2 + (k >> 1)) * s.w + cx * 2 + (k & 1);
                sa += s.a[i]; su += pu[i] * s.a[i]; sv += pv[i] * s.a[i];
            }
            const size_t j = (size_t) cy * cw + cx;
            if (sa <= 0) continue;
            s.ca[j] = clamp8(sa / 4); s.u[j] = clamp8(su / sa); s.v[j] = clamp8(sv / sa);
        }
        pg.sc.push_back(std::move(s));
    }
}

/* the page laid over a dense I420 picture of W x H */
void sub_blend(SubPage &pg, uint8_t *buf, uint32_t W, uint32_t H) {
    if (pg.fw != W || pg.fh != H) sub_scale(pg, W, H);
    uint8_t *Yp = buf, *Up = buf + (size_t) W * H, *Vp = Up + (size_t) (W / 2) * (H / 2);
    for (const SubScaled &s : pg.sc) {
        for (int dy = 0; dy < s.h; dy++) {
            uint8_t *row = Yp + (size_t) (s.y + dy) * W + s.x;
            const uint8_t *ys = &s.y_[(size_t) dy * s.w], *as = &s.a[(size_t) dy * s.w];
            for (int dx = 0; dx < s.w; dx++) {
                const unsigned a = as[dx];
                if (a) row[dx] = (uint8_t) ((row[dx] * (255 - a) + ys[dx] * a + 127) / 255);
            }
        }
        const int cw = s.w / 2, chh = s.h / 2;
        for (int cy = 0; cy < chh; cy++) {
            uint8_t *ur = Up + (size_t) (s.y / 2 + cy) * (W / 2) + s.x / 2, *vr = Vp + (size_t) (s.y / 2 + cy) * (W / 2) + s.x / 2;
            for (int cx = 0; cx < cw; cx++) {
                const size_t j = (size_t) cy * cw + cx;
                const unsigned a = s.ca[j];
                if (!a) continue;
                ur[cx] = (uint8_t) ((ur[cx] * (255 - a) + s.u[j] * a + 127) / 255);
                vr[cx] = (uint8_t) ((vr[cx] * (255 - a) + s.v[j] * a + 127) / 255);
            }
        }
    }
}

/* MGU_SUB_DUMP (tests, MGU_VIDEO_OFF): a grey picture with the subtitle on at pts, written once per page, 4 at most */
void sub_dump(double pts) {
    static const char *path = getenv("MGU_SUB_DUMP");
    static int n = 0;
    static const SubPage *last = nullptr;
    if (!path || !*path || n >= 4 || !g_subs_on) return;
    auto pg = sub_at(pts);
    if (!pg || pg.get() == last) return;
    last = pg.get();
    std::vector<uint8_t> buf((size_t) g_vw * g_vh * 3 / 2, 128);
    memset(buf.data(), 60, (size_t) g_vw * g_vh);
    sub_blend(*pg, buf.data(), g_vw, g_vh);
    char f[1024];
    snprintf(f, sizeof f, "%s-%d.yuv", path, n++);
    FILE *o = fopen(f, "wb");
    if (o) { fwrite(buf.data(), 1, buf.size(), o); fclose(o); }
}

/* waits until the clock reaches pts; false: quit */
bool wait_until(double pts) {
    for (;;) {
        if (g_quit) return false;
        const double d = pts - g_clock.now();
        if (d <= 0.002) return true;
        sleep_s(d > 0.02 ? 0.02 : d);
    }
}

void video_thread() {
    woc::Decoder dec;
    bool open = false;
    if (!g_video_off) {
        /* the frame file in the film's shape (0.2.x: 1920x720 with the decoder's black bars), as nobody: the
         * owner mgu-render takes */
        std::string err, warn;
        if (!g_mgvf.open(g_video_path.c_str(), g_vw, g_vh, 3, &err, &warn)) {
            event("{\"ev\":\"decoder\",\"ok\":false,\"error\":\"frame file: %s\"}", js(err).c_str());
            g_video_off = true;
        } else if (!warn.empty()) fprintf(stderr, "tvh-player: %s\n", warn.c_str());
    }
    if (!g_video_off) {
        std::string err;
        open = dec.init("/dev/dri/renderD128", g_vw, g_vh, false, &err);
        if (open) event("{\"ev\":\"decoder\",\"ok\":true,\"path\":\"%s\",\"w\":%u,\"h\":%u}", js(g_video_path).c_str(), g_vw, g_vh);
        else event("{\"ev\":\"decoder\",\"ok\":false,\"error\":\"%s\"}", js(err).c_str());
    } else event("{\"ev\":\"decoder\",\"ok\":false,\"error\":\"off (MGU_VIDEO_OFF)\"}");
    /* live: the clock starts once the prebuffer is queued (the first picture starts it) */
    const double pw0 = mono();
    while (!g_quit && !g_vq.eof() && g_vq.span() < g_pre) sleep_s(0.02);
    if (!g_quit) fprintf(stderr, "tvh-player: prebuffer %.2f s queued in %.2f s\n", g_vq.span(), mono() - pw0);
    g_prebuffered = true;
    bool lastLate = false;
    unsigned long long errors = 0;
    auto show = [&](double pts, const woc::VideoFrame *f) {
        if (!g_clock.started()) g_clock.start(pts);
        if (!f || !f->y) {   /* decoded without a picture (it was late) */
            if (f) { s_late++; lastLate = true; }
            else if (wait_until(pts)) { s_shown++; sub_dump(pts); }   /* no decoder: timed and counted */
            return;
        }
        if (!wait_until(pts - 0.004)) return;
        const double late = g_clock.now() - pts;
        if (late > kLate) { s_late++; lastLate = true; return; }
        lastLate = false;
        ytdec::nv12_to_i420(f->y, f->uv, f->pitch, f->w, f->h, g_mgvf.begin());
        if (g_subs_on) {   /* the subtitle on now, over the picture */
            auto pg = sub_at(pts);
            if (pg) { sub_blend(*pg, g_mgvf.begin(), g_vw, g_vh); s_subshown++; }
        }
        g_mgvf.commit();
        s_shown++;
    };
    Packet p;
    for (;;) {
        if (g_quit) break;
        if (!g_vq.pop(&p, 0.25)) {
            if (g_vq.drained() || g_quit) break;
            starved();
            continue;
        }
        const double pts = isnan(p.pts) ? NAN : p.pts;
        if (!open) {
            if (!isnan(pts)) show(pts, nullptr);
            continue;
        }
        /* a picture already late is decoded (the next ones refer to it) without VPP and its copy */
        const bool picture = !(g_clock.started() && !isnan(pts) && (lastLate || g_clock.now() - pts > kLate));
        std::string err;
        const int64_t ms = isnan(pts) ? -1 : (int64_t) ((pts - first_pts() + kPtsOffset) * 1000.0);
        const bool ok = dec.feed(p.data.data(), p.data.size(), [&](const woc::VideoFrame &f) {
            if (f.picstruct & 0x06) s_fields++;   /* MFX_PICSTRUCT_FIELD_TFF | FIELD_BFF: interlaced */
            const double fp = f.pts_ms < 0 ? g_clock.now() : f.pts_ms / 1000.0 - kPtsOffset + first_pts();
            show(fp, &f);
        }, &err, true, picture, ms);
        if (!ok) {
            s_decerr++;
            if (++errors <= 3 || errors % 100 == 0) fprintf(stderr, "tvh-player: video: %s\n", err.c_str());
        }
        if (picture == false) lastLate = false;   /* try a picture again with the next one */
    }
    if (open) {
        const double t0 = mono();
        if (!g_quit) dec.flush([&](const woc::VideoFrame &f) {
            const double fp = f.pts_ms < 0 ? g_clock.now() : f.pts_ms / 1000.0 - kPtsOffset + first_pts();
            show(fp, &f);
        });
        dec.shutdown();
        fprintf(stderr, "tvh-player: decoder closed (%.2f s)\n", mono() - t0);
    }
}

/* ---------- audio ---------- */
typedef struct snd_pcm snd_pcm_t;
struct Alsa {
    int (*open)(snd_pcm_t **, const char *, int, int);
    int (*set_params)(snd_pcm_t *, int, int, unsigned, unsigned, int, unsigned);
    long (*writei)(snd_pcm_t *, const void *, unsigned long);
    int (*recover)(snd_pcm_t *, int, int);
    int (*delay)(snd_pcm_t *, long *);
    int (*drop)(snd_pcm_t *);
    int (*prepare)(snd_pcm_t *);
    int (*close)(snd_pcm_t *);
    const char *(*strerror)(int);
} A;
const int kPlayback = 0, kS16LE = 2, kRwInterleaved = 3, kNonblock = 1;
std::atomic<int> g_volume_milli(1000);
std::atomic<int> g_gain_cdb(0);        /* centi-dB, 0..1500 */
std::atomic<bool> g_even(false);

/* the level: the compressor (even), the gain and the volume, the limiter; on interleaved stereo floats, in place */
struct Dsp {
    float env = 0, lim = 0;
    void run(float *lr, int n, int rate) {
        const float CEIL = 0.891f;                                   /* -1 dBFS; pow, exp, log10 in double: their float versions need GLIBC_2.27 */
        const bool even = g_even.load();
        const float g = (float) pow(10.0, (g_gain_cdb.load() / 100.0 + (even ? 8.0 : 0.0)) / 20.0) * (g_volume_milli.load() / 1000.0f);
        const float r = rate > 0 ? (float) rate : 48000.0f;
        const float att = (float) exp(-1.0 / (0.005 * r)), rel = (float) exp(-1.0 / (0.25 * r)), lrel = (float) exp(-1.0 / (0.15 * r));
        const float T = -30.0f, k = 1.0f - 1.0f / 2.5f;
        unsigned long long limited = 0;
        for (int i = 0; i < n; i++) {
            float L = lr[2 * i], R = lr[2 * i + 1];
            float cg = 1.0f;
            if (even) {
                const float x = std::max(fabsf(L), fabsf(R));
                env = x > env ? att * env + (1 - att) * x : rel * env + (1 - rel) * x;
                const float db = 20.0f * (float) log10((double) env + 1e-9);
                if (db > T) cg = (float) pow(10.0, (double) (-(db - T) * k / 20.0f));
            }
            L *= g * cg; R *= g * cg;
            const float p = std::max(fabsf(L), fabsf(R));
            lim = p > lim ? p : lrel * lim + (1 - lrel) * p;
            if (lim > CEIL) { const float lg = CEIL / lim; L *= lg; R *= lg; limited++; }
            lr[2 * i] = L; lr[2 * i + 1] = R;
        }
        s_limited += limited;
    }
} g_dsp;

enum Out { NUL, WAV, ALSA };
struct AudioOut {
    Out kind = NUL;
    std::string target, err;
    snd_pcm_t *pcm = nullptr;
    FILE *wav = nullptr;
    uint32_t wav_bytes = 0;
    unsigned rate = 0;
    bool dropped = false;   /* paused: the device's buffer thrown away, prepared again on resume */

    unsigned buffer_us() { const char *e = getenv("MGU_ALSA_US"); return e && atoi(e) > 0 ? (unsigned) atoi(e) : 64000; }
    void wav_header(uint32_t data) {
        const uint32_t br = rate * 4, riff = 36 + data, fmt = 16;
        const uint16_t pcm_ = 1, ch = 2, ba = 4, bits = 16;
        fseek(wav, 0, SEEK_SET);
        fwrite("RIFF", 1, 4, wav); fwrite(&riff, 4, 1, wav); fwrite("WAVEfmt ", 1, 8, wav);
        fwrite(&fmt, 4, 1, wav); fwrite(&pcm_, 2, 1, wav); fwrite(&ch, 2, 1, wav); fwrite(&rate, 4, 1, wav);
        fwrite(&br, 4, 1, wav); fwrite(&ba, 2, 1, wav); fwrite(&bits, 2, 1, wav); fwrite("data", 1, 4, wav);
        fwrite(&data, 4, 1, wav);
        fseek(wav, 0, SEEK_END);
    }
    bool open(unsigned r) {
        rate = r;
        const char *e = getenv("MGU_AUDIO");
        std::string s = e && *e ? e : "alsa:plug:smartx:CarLifeMedia_CF_48_STEREO";
        if (s == "null") { kind = NUL; target = "null"; return true; }
        if (s.compare(0, 4, "wav:") == 0 && s.size() > 4) {
            kind = WAV; target = s.substr(4);
            wav = fopen(target.c_str(), "wb");
            if (!wav) { err = "cannot create " + target; return false; }
            wav_header(0);
            return true;
        }
        if (s.compare(0, 5, "alsa:") != 0 || s.size() <= 5) { err = "MGU_AUDIO not understood: " + s; return false; }
        kind = ALSA; target = s.substr(5);
        void *h = dlopen("libasound.so.2", RTLD_NOW);
        if (!h) { err = std::string("dlopen libasound.so.2: ") + dlerror(); return false; }
#define SYM(f, n) (*(void **) &A.f = dlsym(h, n))
        if (!(SYM(open, "snd_pcm_open") && SYM(set_params, "snd_pcm_set_params") && SYM(writei, "snd_pcm_writei") &&
              SYM(recover, "snd_pcm_recover") && SYM(delay, "snd_pcm_delay") && SYM(drop, "snd_pcm_drop") &&
              SYM(prepare, "snd_pcm_prepare") && SYM(close, "snd_pcm_close") && SYM(strerror, "snd_strerror"))) {
            err = "libasound.so.2 lacks a symbol";
            return false;
        }
#undef SYM
        int rc = A.open(&pcm, target.c_str(), kPlayback, kNonblock);
        if (rc < 0) { err = "snd_pcm_open " + target + ": " + A.strerror(rc); pcm = nullptr; return false; }
        rc = A.set_params(pcm, kS16LE, kRwInterleaved, 2, rate, 1, buffer_us());
        if (rc < 0) { err = std::string("snd_pcm_set_params: ") + A.strerror(rc); A.close(pcm); pcm = nullptr; return false; }
        return true;
    }
    /* seconds of sound the device holds */
    double delay() {
        if (kind != ALSA || !pcm) return 0;
        long d = 0;
        if (A.delay(pcm, &d) != 0 || d < 0) return 0;
        s_adev_ms = (int) (d * 1000.0 / rate);
        return (double) d / rate;
    }
    void pause() {
        if (kind == ALSA && pcm && !dropped) { A.drop(pcm); dropped = true; }
    }
    /* writes n frames; false: the device does not take them (nobody reads it) */
    bool write(const int16_t *s, unsigned long n) {
        if (kind == WAV && wav) { fwrite(s, 4, n, wav); wav_bytes += (uint32_t) (4 * n); return true; }
        if (kind != ALSA || !pcm) return true;
        if (dropped) { A.prepare(pcm); dropped = false; }
        double waited = 0;
        while (n > 0 && !g_quit) {
            long w = A.writei(pcm, s, n);
            if (w == -EAGAIN) {
                if (waited > 0.25) return false;   /* not read: the speakers not connected (yet) */
                sleep_s(0.005); waited += 0.005;
                continue;
            }
            if (w < 0) { s_axrun++; if (A.recover(pcm, (int) w, 1) < 0) return false; continue; }
            s += w * 2; n -= (unsigned long) w;
        }
        return true;
    }
    void close() {
        if (pcm) { A.close(pcm); pcm = nullptr; }
        if (wav) { wav_header(wav_bytes); fclose(wav); wav = nullptr; }
    }
};

/* the downmix weights of one input channel into left and right */
void weights(AVChannel c, float *l, float *r) {
    const float k = 0.7071f;
    switch (c) {
    case AV_CHAN_FRONT_LEFT: case AV_CHAN_FRONT_LEFT_OF_CENTER: case AV_CHAN_WIDE_LEFT: *l = 1; *r = 0; break;
    case AV_CHAN_FRONT_RIGHT: case AV_CHAN_FRONT_RIGHT_OF_CENTER: case AV_CHAN_WIDE_RIGHT: *l = 0; *r = 1; break;
    case AV_CHAN_FRONT_CENTER: *l = *r = k; break;
    case AV_CHAN_LOW_FREQUENCY: case AV_CHAN_LOW_FREQUENCY_2: *l = *r = 0; break;
    case AV_CHAN_BACK_LEFT: case AV_CHAN_SIDE_LEFT: *l = k; *r = 0; break;
    case AV_CHAN_BACK_RIGHT: case AV_CHAN_SIDE_RIGHT: *l = 0; *r = k; break;
    default: *l = *r = 0.5f; break;
    }
}

/* a decoded frame -> stereo S16 at the volume; more than two channels are mixed down */
void to_stereo(const AVFrame *f, std::vector<int16_t> *out) {
    const int n = f->nb_samples, ch = f->ch_layout.nb_channels > 0 ? f->ch_layout.nb_channels : 2;
    std::vector<float> wl(ch), wr(ch);
    if (ch == 1) { wl[0] = wr[0] = 1; }
    else if (ch == 2) { wl[0] = 1; wr[0] = 0; wl[1] = 0; wr[1] = 1; }
    else {
        float sl = 0;
        for (int c = 0; c < ch; c++) {
            weights(av_channel_layout_channel_from_index(&f->ch_layout, (unsigned) c), &wl[c], &wr[c]);
            sl += wl[c];
        }
        const float norm = sl > 1 ? 1.0f / sqrtf(sl) : 1.0f;   /* louder than a plain sum's normalisation, clipped */
        for (int c = 0; c < ch; c++) { wl[c] *= norm; wr[c] *= norm; }
    }
    static std::vector<float> fl;
    fl.resize((size_t) n * 2);
    out->resize((size_t) n * 2);
    for (int i = 0; i < n; i++) {
        float L = 0, R = 0;
        for (int c = 0; c < ch; c++) {
            float x;
            switch (f->format) {
            case AV_SAMPLE_FMT_FLTP: x = ((const float *) f->extended_data[c])[i]; break;
            case AV_SAMPLE_FMT_FLT: x = ((const float *) f->extended_data[0])[i * ch + c]; break;
            case AV_SAMPLE_FMT_S16P: x = ((const int16_t *) f->extended_data[c])[i] / 32768.0f; break;
            case AV_SAMPLE_FMT_S16: x = ((const int16_t *) f->extended_data[0])[i * ch + c] / 32768.0f; break;
            case AV_SAMPLE_FMT_S32P: x = ((const int32_t *) f->extended_data[c])[i] / 2147483648.0f; break;
            case AV_SAMPLE_FMT_S32: x = ((const int32_t *) f->extended_data[0])[i * ch + c] / 2147483648.0f; break;
            default: x = 0; break;
            }
            L += x * wl[c]; R += x * wr[c];
        }
        fl[(size_t) i * 2] = L; fl[(size_t) i * 2 + 1] = R;
    }
    g_dsp.run(fl.data(), n, f->sample_rate);   /* the gain, the volume, the limiter */
    for (size_t i = 0; i < (size_t) n * 2; i++) {
        const float x = fl[i];
        (*out)[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : (int16_t) lrintf(x * 32767.0f);
    }
}

AVCodecParameters *g_apar = nullptr;
AVRational g_atb = {1, 90000};

void audio_thread() {
    const AVCodec *codec = avcodec_find_decoder(g_apar->codec_id);
    AVCodecContext *ctx = codec ? avcodec_alloc_context3(codec) : nullptr;
    if (!ctx || avcodec_parameters_to_context(ctx, g_apar) < 0 || avcodec_open2(ctx, codec, nullptr) < 0) {
        event("{\"ev\":\"audio\",\"ok\":false,\"error\":\"no decoder for %s\"}", avcodec_get_name(g_apar->codec_id));
        if (ctx) avcodec_free_context(&ctx);
        /* the queue is still emptied, so the demuxer never waits for us */
        Packet p;
        while (g_aq.pop(&p, 0.25) || !g_aq.drained()) if (g_quit) break;
        return;
    }
    ctx->pkt_timebase = g_atb;
    AVPacket *pkt = av_packet_alloc();
    AVFrame *fr = av_frame_alloc();
    AudioOut out;
    bool opened = false, failed = false;
    std::vector<int16_t> buf;
    double next = NAN;   /* the timestamp after the last frame: frames without one follow it */
    Packet p;
    for (;;) {
        if (g_quit) break;
        if (!g_aq.pop(&p, 0.25)) {
            if (g_aq.drained() || g_quit) break;
            if (!g_has_video) starved();
            continue;
        }
        if (av_new_packet(pkt, (int) p.data.size()) < 0) { s_aerr++; continue; }
        memcpy(pkt->data, p.data.data(), p.data.size());
        pkt->pts = isnan(p.pts) ? AV_NOPTS_VALUE : (int64_t) llround(p.pts / av_q2d(g_atb));
        int rc = avcodec_send_packet(ctx, pkt);
        av_packet_unref(pkt);
        if (rc < 0) { s_aerr++; continue; }
        while (avcodec_receive_frame(ctx, fr) == 0) {
            const unsigned rate = fr->sample_rate > 0 ? (unsigned) fr->sample_rate : 48000;
            double pts = fr->pts != AV_NOPTS_VALUE ? fr->pts * av_q2d(g_atb) : next;
            if (isnan(pts)) pts = g_clock.now();
            const double dur = (double) fr->nb_samples / rate;
            next = pts + dur;
            if (!opened && !failed) {
                if (out.open(rate)) {
                    opened = true;
                    event("{\"ev\":\"audio\",\"ok\":true,\"device\":\"%s\",\"codec\":\"%s\",\"rate\":%u,\"channels\":%d}",
                          js(out.target).c_str(), avcodec_get_name(g_apar->codec_id), rate, fr->ch_layout.nb_channels);
                } else {
                    failed = true;
                    event("{\"ev\":\"audio\",\"ok\":false,\"error\":\"%s\"}", js(out.err).c_str());
                }
            }
            /* with a picture, the picture starts the clock; without one (or none for 3 s), the sound does */
            if (!g_clock.started()) {
                if (g_has_video) {
                    /* the picture starts the clock, after its prebuffer; none 3 s after that: the sound does */
                    while (!g_quit && !g_prebuffered) sleep_s(0.02);
                    if (!g_clock.wait_start(3.0)) g_clock.start(pts);
                } else {
                    /* radio: the sound's own prebuffer */
                    while (!g_quit && !g_aq.eof() && g_aq.span() < g_pre - dur) sleep_s(0.02);
                    g_clock.start(pts);
                }
            }
            while (g_clock.paused() && !g_quit) { out.pause(); sleep_s(0.02); }
            to_stereo(fr, &buf);
            av_frame_unref(fr);
            if (!opened) continue;
            size_t skip = 0, n = buf.size() / 2;
            /* where the device is: what it holds plays first */
            double ahead = pts - (g_clock.now() + out.delay());
            if (ahead + dur < -0.05) { s_alate++; continue; }      /* all of it late */
            if (ahead < -0.04) {                                     /* its start late: cut */
                skip = (size_t) (-ahead * rate);
                if (skip >= n) { s_alate++; continue; }
            }
            /* early: wait (also while paused or buffering, the clock stands) */
            while (!g_quit && (ahead = pts - (g_clock.now() + out.delay())) > 0.04) {
                if (g_clock.paused()) out.pause();
                sleep_s(ahead > 0.06 ? 0.02 : ahead - 0.02);
            }
            if (out.write(buf.data() + skip * 2, n - skip)) s_aplayed++;
            else s_aunread++;
        }
    }
    {
        /* the device first: a sound input left open would stay busy for the next player */
        const double t0 = mono();
        out.close();
        if (opened) fprintf(stderr, "tvh-player: sound closed (%.2f s)\n", mono() - t0);
    }
    av_frame_free(&fr);
    av_packet_free(&pkt);
    avcodec_free_context(&ctx);
}

/* ---------- control ---------- */
void control_thread() {
    /* read(2), not stdio: a FILE locked in fgets would hold exit()'s flush of every stream */
    std::string buf;
    char chunk[256];
    for (;;) {
        const ssize_t n = read(3, chunk, sizeof chunk);
        if (n < 0 && errno == EINTR) { if (g_quit) break; continue; }
        if (n <= 0) break;
        buf.append(chunk, (size_t) n);
        size_t i;
        while ((i = buf.find('\n')) != std::string::npos) {
            const std::string line = buf.substr(0, i);
            buf.erase(0, i + 1);
            if (line == "pause") g_clock.set_paused(true);
            else if (line == "subs on") g_subs_on = true;
            else if (line == "subs off") g_subs_on = false;
            else if (line == "resume") g_clock.set_paused(false);
            else if (!line.compare(0, 7, "volume ")) {
                const double v = atof(line.c_str() + 7);
                g_volume_milli = (int) ((v < 0 ? 0 : v > 1 ? 1 : v) * 1000);
            } else if (!line.compare(0, 5, "gain ")) {
                const double db = atof(line.c_str() + 5);
                g_gain_cdb = (int) lrint((db < 0 ? 0 : db > 15 ? 15 : db) * 100);
            } else if (line == "even on") g_even = true;
            else if (line == "even off") g_even = false;
            else if (line == "quit") { g_quit = true; g_vq.wake(); g_aq.wake(); return; }
        }
        if (buf.size() > 4096) buf.clear();
    }
    /* the service went (its end of the pipe closed): so do we */
    g_quit = true;
    g_vq.wake(); g_aq.wake();
}

/* ---------- the stream ---------- */
int read_stdin(void *opaque, uint8_t *buf, int size) {
    (void) opaque;
    for (;;) {
        if (g_quit) return AVERROR_EOF;
        const ssize_t n = read(0, buf, (size_t) size);
        if (n > 0) { s_bytes += (unsigned long long) n; return (int) n; }
        if (n == 0) return AVERROR_EOF;
        if (errno == EINTR) continue;
        return AVERROR(errno);
    }
}

/* waits while enough is queued; false: quit */
bool room() {
    for (;;) {
        if (g_quit) return false;
        const double span = std::max(g_vq.span(), g_aq.span());
        if (span < kAhead && g_vq.bytes() + g_aq.bytes() < kMaxBytes) return true;
        if (g_clock.stalled()) g_clock.set_stalled(false);   /* full: whatever ran dry is back */
        sleep_s(0.01);
    }
}

void refill_check() {
    if (!g_clock.stalled()) return;
    const double span = g_has_video ? g_vq.span() : g_aq.span();
    if (span >= g_pre || g_vq.eof()) g_clock.set_stalled(false);
}

const char *state() {
    if (!g_clock.started()) return "starting";
    if (g_clock.paused()) return "paused";
    if (g_clock.stalled()) return "buffering";
    return "playing";
}

void tick_thread() {
    while (!g_quit) {
        for (int i = 0; i < 10 && !g_quit; i++) sleep_s(0.05);
        if (g_quit) break;
        const double t = g_clock.started() ? g_clock.now() - first_pts() : 0;
        event("{\"ev\":\"tick\",\"t\":%.3f,\"state\":\"%s\",\"shown\":%llu,\"late\":%llu,\"decerr\":%llu,\"aplayed\":%llu,"
              "\"alate\":%llu,\"aunread\":%llu,\"axrun\":%llu,\"adev\":%d,\"buffered\":%.2f,\"kbytes\":%llu,\"fields\":%llu,\"subs\":%llu,\"subshown\":%llu,\"limited\":%llu,\"gain\":%.1f,\"even\":%d}",
              t < 0 ? 0 : t, state(), s_shown.load(), s_late.load(), s_decerr.load(), s_aplayed.load(), s_alate.load(),
              s_aunread.load(), s_axrun.load(), s_adev_ms.load(), std::max(g_vq.span(), g_aq.span()), s_bytes.load() / 1024, s_fields.load(), s_subpages.load(), s_subshown.load(),
              s_limited.load(), g_gain_cdb.load() / 100.0, g_even.load() ? 1 : 0);
    }
}

/* As root: becomes MGU_RUN_AS (a name or a number) with MGU_GROUPS; exits rather than stay root */
void drop_root() {
    const char *who = getenv("MGU_RUN_AS");
    if (!who || getuid() != 0) return;
    uid_t uid;
    gid_t gid;
    char *end = nullptr;
    const unsigned long num = strtoul(who, &end, 10);
    if (*who && end && !*end) { uid = (uid_t) num; gid = (gid_t) num; }
    else {
        struct passwd *pw = getpwnam(who);
        if (!pw) { fprintf(stderr, "tvh-player: no user %s: refusing to run as root\n", who); _exit(126); }
        uid = pw->pw_uid; gid = pw->pw_gid;
    }
    gid_t gs[16];
    int n = 0;
    char list[256];
    snprintf(list, sizeof list, "%s", getenv("MGU_GROUPS") ? getenv("MGU_GROUPS") : "");
    for (char *save = nullptr, *t = strtok_r(list, ",", &save); t && n < 16; t = strtok_r(nullptr, ",", &save)) {
        struct group *g = getgrnam(t);
        if (g) gs[n++] = g->gr_gid;
    }
    if (setgroups((size_t) n, gs) != 0 || setgid(gid) != 0 || setuid(uid) != 0 || getuid() == 0 || geteuid() == 0) {
        fprintf(stderr, "tvh-player: cannot run as %s: refusing to run as root\n", who);
        _exit(126);
    }
    fprintf(stderr, "tvh-player: running as uid %u with %d groups\n", (unsigned) uid, n);
}

void on_term(int) { g_quit = true; }

/* the rest of the open event's video: its frame rate and whether the stream says it is interlaced */
std::string vtail(const AVStream *vs) {
    const AVFieldOrder fo = vs->codecpar->field_order;
    const bool il = fo == AV_FIELD_TT || fo == AV_FIELD_BB || fo == AV_FIELD_TB || fo == AV_FIELD_BT;
    const double fps = vs->avg_frame_rate.num > 0 && vs->avg_frame_rate.den > 0 ? av_q2d(vs->avg_frame_rate)
        : vs->r_frame_rate.num > 0 && vs->r_frame_rate.den > 0 ? av_q2d(vs->r_frame_rate) : 0;
    char b[96];
    snprintf(b, sizeof b, ",\"fps\":%.3f,\"interlaced\":%s}", fps > 0 && fps < 200 ? fps : 0.0, il ? "true" : "false");
    return b;
}

/* what is still to end: 3 the sound, 2 the picture, 1 the rest */
std::atomic<int> g_left(3);
/* told to end (quit, SIGTERM, the service gone): 2.5 s at most, then gone however far it got, with the log saying
 * what was still running (0.2.2 in the car: a player not ended after 6 s was killed by the service) */
void watchdog() {
    while (!g_quit) sleep_s(0.05);
    for (int i = 0; i < 50; i++) { if (!g_left.load()) return; sleep_s(0.05); }
    const int l = g_left.load();
    fprintf(stderr, "tvh-player: still %s after 2.5 s: exiting now\n", l == 3 ? "closing the sound" : l == 2 ? "closing the decoder" : "ending");
    fflush(stderr);
    _exit(0);
}

}  // namespace

int main() {
    signal(SIGPIPE, SIG_IGN);
    /* no SA_RESTART: a read of the stream waiting for data returns, and the player ends */
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_term;
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);
    g_video_off = getenv("MGU_VIDEO_OFF") != nullptr;
    if (const char *p = getenv("MGU_VIDEO_PATH")) if (*p) g_video_path = p;
    /* the largest picture: the film's own shape is fitted into it (the app places it: fit, zoom, fill) */
    if (const char *sz = getenv("MGU_VIDEO_SIZE")) {
        unsigned w = 0, h = 0;
        if (sscanf(sz, "%ux%u", &w, &h) == 2 && w >= 16 && h >= 16 && w <= 2048 && h <= 2048) g_maxw = w & ~1u, g_maxh = h & ~1u;
    }
    if (const char *pb = getenv("MGU_PREBUFFER_MS")) if (atoi(pb) >= 0 && atoi(pb) <= 10000) g_pre = atoi(pb) / 1000.0;
    if (const char *sb = getenv("MGU_SUBS")) if (!strcmp(sb, "0")) g_subs_on = false;
    if (const char *gd = getenv("MGU_GAIN_DB")) { const double db = atof(gd); g_gain_cdb = (int) lrint((db < 0 ? 0 : db > 15 ? 15 : db) * 100); }
    if (const char *ev = getenv("MGU_EVEN")) if (!strcmp(ev, "1")) g_even = true;
    drop_root();
    std::thread(watchdog).detach();
    std::thread ctl;
    if (fcntl(3, F_GETFD) != -1) ctl = std::thread(control_thread);
    else ctl = std::thread([] {});

    av_log_set_level(AV_LOG_ERROR);
    AVFormatContext *fmt = avformat_alloc_context();
    const int iosz = 64 * 1024;
    AVIOContext *io = avio_alloc_context((unsigned char *) av_malloc(iosz), iosz, 0, nullptr, read_stdin, nullptr, nullptr);
    fmt->pb = io;
    /* 1 MiB, 1 s: the server's transcoder may write its first sound after a good part of a second of picture (0.2.2
     * in the car: 256 KiB found no sound in a DTS -> AAC stream); a sound that shows up later still is taken below */
    fmt->probesize = 1024 * 1024;
    if (const char *pk = getenv("MGU_PROBE_KB")) if (atoi(pk) >= 4) fmt->probesize = atoi(pk) * 1024;   /* tests */
    /* live TV starts anywhere in a group of pictures: the analysis must reach the next key frame, with its SPS, to
     * know the picture's size (Tvheadend's mgu-hd: one each second, the first 1.4 s in; 1 s found 0x0) */
    fmt->max_analyze_duration = 2500000;
    if (const char *am = getenv("MGU_ANALYZE_MS")) if (atoi(am) >= 100) fmt->max_analyze_duration = (int64_t) atoi(am) * 1000;
    const AVInputFormat *ts = av_find_input_format("mpegts");
    int rc = avformat_open_input(&fmt, nullptr, ts, nullptr);
    if (rc < 0 || avformat_find_stream_info(fmt, nullptr) < 0) {
        char e[128];
        av_strerror(rc, e, sizeof e);
        event("{\"ev\":\"error\",\"error\":\"the stream does not open: %s\"}", js(rc < 0 ? e : "no stream information").c_str());
        g_quit = true;
        ctl.detach();
        g_mgvf.close();
        fflush(stdout);
        fflush(stderr);
        _exit(2);
    }
    for (unsigned i = 0; i < fmt->nb_streams; i++) {
        const AVCodecParameters *cp = fmt->streams[i]->codecpar;
        fprintf(stderr, "tvh-player: stream %u: %s %s %dx%d %d Hz %d ch\n", i, av_get_media_type_string(cp->codec_type) ? av_get_media_type_string(cp->codec_type) : "?",
                avcodec_get_name(cp->codec_id), cp->width, cp->height, cp->sample_rate, cp->ch_layout.nb_channels);
    }
    const int vi = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    const int ai = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    AVStream *vs = vi >= 0 ? fmt->streams[vi] : nullptr, *as = ai >= 0 ? fmt->streams[ai] : nullptr;
    if (vs && vs->codecpar->codec_id != AV_CODEC_ID_H264) {
        event("{\"ev\":\"error\",\"error\":\"video %s: only H.264 plays here (choose a profile that transcodes)\"}", avcodec_get_name(vs->codecpar->codec_id));
        vs = nullptr;
    }
    g_has_video = vs != nullptr;
    if (vs) {
        picture_size(vs->codecpar, av_guess_sample_aspect_ratio(fmt, vs, nullptr));
        fprintf(stderr, "tvh-player: the picture %ux%u\n", g_vw, g_vh);
    }
    auto playable = [](AVCodecID id) { return id == AV_CODEC_ID_AAC || id == AV_CODEC_ID_AC3 || id == AV_CODEC_ID_EAC3; };
    if (as && !playable(as->codecpar->codec_id)) {
        /* "pass" from DVB: MP2 most often. Told, and a playable sound that shows up later is still taken. */
        event("{\"ev\":\"audio\",\"ok\":false,\"error\":\"sound %s: only AAC, AC-3 and E-AC-3 play here (choose a profile that transcodes)\"}",
              as->codecpar->codec_id == AV_CODEC_ID_MP3 ? "mp2" : avcodec_get_name(as->codecpar->codec_id));
        as = nullptr;
        for (unsigned i = 0; i < fmt->nb_streams; i++)
            if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO && playable(fmt->streams[i]->codecpar->codec_id)) { as = fmt->streams[i]; break; }
    }
    if (!as) {
        /* a sound the demuxer could not even describe (no parser for it: MP2) */
        for (unsigned i = 0; i < fmt->nb_streams; i++)
            if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
                const AVCodecID id = fmt->streams[i]->codecpar->codec_id;
                event("{\"ev\":\"audio\",\"ok\":false,\"error\":\"sound %s: only AAC, AC-3 and E-AC-3 play here (choose a profile that transcodes)\"}",
                      id == AV_CODEC_ID_MP3 || id == AV_CODEC_ID_MP2 ? "mp2" : avcodec_get_name(id));
                break;
            }
    }
    g_has_audio = as != nullptr;
    if (as) { g_apar = as->codecpar; g_atb = as->time_base; }
    /* the first DVB subtitle stream (the transcoder copies only the channel's first one) */
    auto open_subs = [&](AVStream *st) {
        const AVCodec *c = avcodec_find_decoder(AV_CODEC_ID_DVB_SUBTITLE);
        AVCodecContext *ctx = c ? avcodec_alloc_context3(c) : nullptr;
        if (!ctx || avcodec_parameters_to_context(ctx, st->codecpar) < 0 || avcodec_open2(ctx, c, nullptr) < 0) {
            if (ctx) avcodec_free_context(&ctx);
            event("{\"ev\":\"subs\",\"ok\":false,\"error\":\"no DVB subtitle decoder\"}");
            return;
        }
        ctx->pkt_timebase = st->time_base;
        g_subctx = ctx; g_ss = st;
        const AVDictionaryEntry *lang = av_dict_get(st->metadata, "language", nullptr, 0);
        event("{\"ev\":\"subs\",\"ok\":true,\"codec\":\"dvb\",\"lang\":\"%s\",\"on\":%s}", js(lang ? lang->value : "").c_str(), g_subs_on ? "true" : "false");
    };
    for (unsigned i = 0; i < fmt->nb_streams && !g_ss; i++)
        if (fmt->streams[i]->codecpar->codec_id == AV_CODEC_ID_DVB_SUBTITLE) open_subs(fmt->streams[i]);
    event("{\"ev\":\"open\",\"video\":%s%s%s,\"audio\":%s%s%s}",
          vs ? "{\"codec\":\"h264\",\"w\":" : "null", vs ? std::to_string(vs->codecpar->width).c_str() : "",
          vs ? (",\"h\":" + std::to_string(vs->codecpar->height) + vtail(vs)).c_str() : "",
          as ? "{\"codec\":\"" : "null", as ? avcodec_get_name(as->codecpar->codec_id) : "",
          as ? ("\",\"rate\":" + std::to_string(as->codecpar->sample_rate) + ",\"channels\":" + std::to_string(as->codecpar->ch_layout.nb_channels) + "}").c_str() : "");
    if (!g_has_video && !g_has_audio) {
        event("{\"ev\":\"error\",\"error\":\"no picture or sound in the stream\"}");
        g_quit = true;
    }
    std::thread vt, at, tt(tick_thread);
    if (g_has_video) vt = std::thread(video_thread); else g_vq.end();
    /* no sound found yet: its queue stays open, a sound stream that shows up later is taken (below) */
    if (g_has_audio) at = std::thread(audio_thread);

    AVPacket *pkt = av_packet_alloc();
    while (!g_quit) {
        if (!room()) break;
        rc = av_read_frame(fmt, pkt);
        if (rc < 0) break;
        AVStream *s = fmt->streams[pkt->stream_index];
        if (!as && s->codecpar->codec_type == AVMEDIA_TYPE_AUDIO && playable(s->codecpar->codec_id)) {
            as = s;
            g_apar = as->codecpar; g_atb = as->time_base; g_has_audio = true;
            fprintf(stderr, "tvh-player: the sound came later: stream %d %s\n", pkt->stream_index, avcodec_get_name(as->codecpar->codec_id));
            event("{\"ev\":\"open\",\"video\":%s%s%s,\"audio\":{\"codec\":\"%s\",\"rate\":%d,\"channels\":%d},\"late\":true}",
                  vs ? "{\"codec\":\"h264\",\"w\":" : "null", vs ? std::to_string(vs->codecpar->width).c_str() : "",
                  vs ? (",\"h\":" + std::to_string(vs->codecpar->height) + "}").c_str() : "",
                  avcodec_get_name(as->codecpar->codec_id), as->codecpar->sample_rate, as->codecpar->ch_layout.nb_channels);
            at = std::thread(audio_thread);
        }
        if (!g_ss && s->codecpar->codec_id == AV_CODEC_ID_DVB_SUBTITLE) open_subs(s);   /* a subtitle stream that came later */
        if (s == g_ss && g_subctx && pkt->size > 0) {
            AVSubtitle sub;
            int got = 0;
            if (avcodec_decode_subtitle2(g_subctx, &sub, &got, pkt) >= 0 && got) {
                const double t = pkt->pts != AV_NOPTS_VALUE ? pkt->pts * av_q2d(s->time_base) : NAN;
                if (!isnan(t)) sub_add(sub, t, g_subctx->width, g_subctx->height);
                avsubtitle_free(&sub);
            }
        }
        if ((s == vs || s == as) && pkt->size > 0) {
            Packet p;
            p.data.assign(pkt->data, pkt->data + pkt->size);
            if (pkt->pts != AV_NOPTS_VALUE) p.pts = pkt->pts * av_q2d(s->time_base);
            else if (pkt->dts != AV_NOPTS_VALUE) p.pts = pkt->dts * av_q2d(s->time_base);
            p.dur = pkt->duration * av_q2d(s->time_base);
            if (!isnan(p.pts) && (s == vs || !g_has_video)) note_first(p.pts);
            if (s == vs) { s_vpk++; g_vq.push(std::move(p)); }
            else { s_apk++; g_aq.push(std::move(p)); }
            refill_check();
        }
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    g_vq.end(); g_aq.end();
    if (g_clock.stalled()) g_clock.set_stalled(false);
    const double q0 = mono();
    if (g_quit) fprintf(stderr, "tvh-player: quitting\n");
    if (at.joinable()) at.join();
    g_left = 2;
    if (vt.joinable()) vt.join();
    g_left = 1;
    if (g_quit) fprintf(stderr, "tvh-player: ended in %.2f s\n", mono() - q0);
    const bool ended = !g_quit;
    const double t = g_clock.started() ? g_clock.now() - first_pts() : 0;
    if (ended) event("{\"ev\":\"end\",\"t\":%.3f,\"shown\":%llu,\"late\":%llu,\"aplayed\":%llu}", t < 0 ? 0 : t, s_shown.load(), s_late.load(), s_aplayed.load());
    g_quit = true;
    tt.join();
    ctl.detach();   /* blocked in a read of fd 3: the exit ends it */
    avformat_close_input(&fmt);
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
    g_mgvf.close();
    /* gone without the libraries' global destructors: 0.3.0 in the car had a player told to end still there after
     * 6 s, its threads done (the watchdog had stood down at g_left 0, before main returned into the GPU libraries'
     * exit handlers). The watchdog keeps watching until here. */
    fflush(stdout);
    fflush(stderr);
    _exit(0);
}
