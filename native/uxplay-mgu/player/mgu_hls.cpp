// SPDX-License-Identifier: GPL-3.0-or-later
/* mgu_hls.cpp - stage 4 of the AirPlay receiver: a video the iPhone hands over, played by the head unit itself.
 *
 * With AirPlay's video button (YouTube) the iPhone does not send its screen: it sends a "play" with an address.
 * UxPlay fetches YouTube's HLS playlists from the iPhone and serves them on its own port
 * (http://localhost:<port>/master.m3u8, the variants filtered to H.264 by -custom); a direct http(s) address (a
 * file, Safari's video button) is played as it is. This player stands in for UxPlay's GStreamer playbin:
 *
 *   demux thread   libavformat opens the address (hls, mpegts, mp4); the segments come from the internet through
 *                  the service's proxy (http_proxy, the uid mgu-uplink routes; TLS checked against MGU_CA_FILE).
 *                  One video stream (the tallest up to MGU_HLS_MAXH, 1080) and one audio stream are read; the
 *                  others are discarded (the hls demuxer then never downloads them). Packets queue up to ~6 s.
 *   video thread   each access unit (Annex B; mp4's avcC converted by h264_mp4toannexb) to the GPU decoder of
 *                  stage 2 (mgu_video_frame_timed): every picture waits for its time on the clock, or is dropped
 *                  when 250 ms late
 *   audio thread   each packet to the sound of stage 3 (mgu_audio_start_codec: the stream's own codec and rate,
 *                  into the same SmartXbar input), 50 ms ahead of the clock
 *   the clock      the stream's time, started 0.3 s after its first packet; held while paused, and while the
 *                  queue runs dry (buffering) until 1.5 s is read again
 *
 * Pause, resume and seek come from the iPhone (UxPlay's /rate and /scrub); its progress bar asks for the
 * position and duration (/playback-info). Events (JSON, the renderer prints them as "MGU {json}"):
 *   {"ev":"hls","url":"..."}                       a play started (the address, without its query)
 *   {"ev":"hlsopen","w":..,"h":..,"vcodec":..,"acodec":..,"rate":..,"ch":..,"dur":..,"variants":..}
 *   {"ev":"hlspos","pos":..,"dur":..,"paused":..,"buffering":..}   each second
 *   {"ev":"hlsend","why":"end"|"error"|"stopped","error":"..."}
 *   and the stage 2/3 ones: start, stop, decoder, sound, soundstop, stats
 */
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <math.h>
#include <stdarg.h>
#include <mutex>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <thread>
#include <algorithm>
#include <time.h>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/time.h>
}

#include "mgu_audio.h"
#include "mgu_hls.h"
#include "mgu_video.h"

namespace {

void (*g_emit)(const char *) = nullptr;
void emitf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void emitf(const char *fmt, ...) {
    if (!g_emit) return;
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    g_emit(buf);
}
/* JSON string body: quotes, backslashes and control characters left out */
std::string clean(const std::string &in, size_t max = 200) {
    std::string out;
    for (char c : in) {
        if ((unsigned char) c < 0x20 || c == '"' || c == '\\') continue;
        out += c;
        if (out.size() >= max) break;
    }
    return out;
}
double mono() { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
std::string averr(int e) { char b[128]; av_strerror(e, b, sizeof b); return b; }

/* ---------------- the clock ---------------- */
struct Clock {
    std::mutex m;
    bool started = false, paused = false, held = false;
    double base = 0, base_pts = 0, frozen = 0;   /* pts = base_pts + (mono() - base) while running */
    double now_locked() const { return (paused || held) ? frozen : base_pts + (mono() - base); }
    double now() { std::lock_guard<std::mutex> l(m); return started ? now_locked() : -1; }
    /* the first timestamp after a start or a seek: the clock starts at it, 0.3 s from now */
    void anchor(double pts) {
        std::lock_guard<std::mutex> l(m);
        if (started) return;
        started = true; base_pts = pts; base = mono() + 0.3; frozen = pts;
    }
    void reset() { std::lock_guard<std::mutex> l(m); started = false; held = false; }
    void set_paused(bool p) { std::lock_guard<std::mutex> l(m); freeze(p, held); paused = p; }
    void set_held(bool h) { std::lock_guard<std::mutex> l(m); freeze(paused, h); held = h; }
    bool is_held() { std::lock_guard<std::mutex> l(m); return held; }
    /* switching between running and frozen keeps the time where it is */
    void freeze(bool p, bool h) {
        const bool was = paused || held, will = p || h;
        if (!started || was == will) return;
        if (will) frozen = base_pts + (mono() - base);
        else { base_pts = frozen; base = mono(); }
    }
};

/* ---------------- packet queues ---------------- */
struct Queue {
    std::mutex m;
    std::condition_variable cv;
    std::deque<AVPacket *> q;
    bool eof = false;
    double last = -1;   /* the newest packet's time (s) */
    void clear() {
        std::lock_guard<std::mutex> l(m);
        for (auto *p : q) av_packet_free(&p);
        q.clear(); eof = false; last = -1;
        cv.notify_all();
    }
    size_t size() { std::lock_guard<std::mutex> l(m); return q.size(); }
};

struct Player {
    std::string url;
    double start_s = 0;
    std::thread demux, vthr, athr;
    std::atomic<bool> stop{false}, ended{false}, eos_flag{false}, open{false};
    std::atomic<int> seek_gen{0};      /* bumped by each seek: the threads drop what they hold */
    std::mutex seek_m;
    double seek_to = -1;
    /* a seek the demux thread has yet to make (a queue wait must not hold it up) */
    bool seek_pending() { std::lock_guard<std::mutex> l(seek_m); return seek_to >= 0; }
    Clock clock;
    Queue vq, aq;
    AVFormatContext *fmt = nullptr;
    int vi = -1, ai = -1;
    AVRational vtb{1, 90000}, atb{1, 90000};
    double duration = 0;
    double t0 = 0;   /* the stream's first timestamp (mpegts starts at ~1.4 s): positions and seeks are from it */
    std::string error;
    /* stats */
    std::atomic<unsigned long long> vpk{0}, apk{0}, bytes{0}, idr{0}, sps{0}, shown{0}, decerr{0};
    std::atomic<int> stalls{0};   /* how often the queue ran dry while playing */
    bool warm = false;            /* the start's buffer (3 s) was read; again after a seek */
    std::atomic<double> wait_pos{0};   /* the position before the clock starts: the start, then each seek's target */
    bool video_ok = true;
};

std::mutex g_m;                 /* start / stop / the pointer */
Player *g_p = nullptr;
std::atomic<int> g_eos{0};
double g_volume = 1.0;

int interrupt_cb(void *arg) { return ((Player *) arg)->stop.load() ? 1 : 0; }

double ts(int64_t v, AVRational tb) { return v == AV_NOPTS_VALUE ? -1 : v * av_q2d(tb); }

/* the video stream: H.264 (the GPU decodes it), the highest bitrate whose height (when known) is at most
 * MGU_HLS_MAXH (720: the screen is 720 high) and whose bitrate is at most MGU_HLS_MAXKBPS (5000; in the car, 0.9.5,
 * 1080p at ~8 Mbit/s through an iPhone hotspot stalled every few seconds); one audio stream; every other stream
 * discarded (the hls demuxer then never downloads it). UxPlay's master playlist is filtered to H.264 already. */
void pick_streams(Player *p) {
    const char *e = getenv("MGU_HLS_MAXH");
    const int maxh = e && atoi(e) > 0 ? atoi(e) : 720;
    e = getenv("MGU_HLS_MAXKBPS");
    const int64_t maxbr = (e && atoi(e) > 0 ? atoi(e) : 5000) * 1000LL;
    int best = -1, fallback = -1;
    int64_t bbr = -1, fbr = INT64_MAX;
    for (unsigned i = 0; i < p->fmt->nb_streams; i++) {
        AVCodecParameters *c = p->fmt->streams[i]->codecpar;
        if (c->codec_type != AVMEDIA_TYPE_VIDEO || c->codec_id != AV_CODEC_ID_H264) continue;
        AVDictionaryEntry *vb = av_dict_get(p->fmt->streams[i]->metadata, "variant_bitrate", nullptr, 0);
        const int64_t br = vb ? atoll(vb->value) : c->bit_rate;
        if (br < fbr) { fbr = br; fallback = (int) i; }   /* none fits: the lightest */
        if ((c->height > 0 && c->height > maxh) || br > maxbr) continue;
        if (br > bbr) { bbr = br; best = (int) i; }
    }
    p->vi = best >= 0 ? best : fallback;
    p->ai = av_find_best_stream(p->fmt, AVMEDIA_TYPE_AUDIO, -1, p->vi, nullptr, 0);
    if (p->ai < 0) p->ai = av_find_best_stream(p->fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    for (unsigned i = 0; i < p->fmt->nb_streams; i++)
        p->fmt->streams[i]->discard = ((int) i == p->vi || (int) i == p->ai) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
}

/* ---------------- the video thread ---------------- */
struct WaitArg { Player *p; int gen; };
/* holds a decoded picture until its time: 0 show, 1 drop */
int wait_picture(long long pts_ms, void *a) {
    WaitArg *w = (WaitArg *) a;
    Player *p = w->p;
    if (pts_ms < 0) return 0;
    const double pts = pts_ms / 1000.0;
    p->clock.anchor(pts);
    for (;;) {
        if (p->stop || p->seek_gen != w->gen) return 1;
        const double d = pts - p->clock.now();
        if (d < -0.25) return 1;
        if (d <= 0.004) return 0;
        std::this_thread::sleep_for(std::chrono::microseconds((long) (std::min(d, 0.05) * 1e6)));
    }
}

void video_loop(Player *p) {
    AVBSFContext *bsf = nullptr;
    AVCodecParameters *par = p->fmt->streams[p->vi]->codecpar;
    if (par->extradata_size > 0 && par->extradata[0] == 1) {   /* avcC (mp4): to Annex B */
        const AVBitStreamFilter *f = av_bsf_get_by_name("h264_mp4toannexb");
        if (f && av_bsf_alloc(f, &bsf) == 0) {
            avcodec_parameters_copy(bsf->par_in, par);
            bsf->time_base_in = p->vtb;
            if (av_bsf_init(bsf) < 0) av_bsf_free(&bsf);
        }
    }
    AVPacket *out = av_packet_alloc();
    bool reported = false;
    unsigned repW = 0, repH = 0;   /* the frame file's size last reported (the video's own: it comes with its first picture) */
    int gen = p->seek_gen;
    for (;;) {
        AVPacket *pk = nullptr;
        {
            std::unique_lock<std::mutex> l(p->vq.m);
            p->vq.cv.wait(l, [&] { return p->stop || !p->vq.q.empty() || p->vq.eof; });
            if (p->stop) break;
            if (p->vq.q.empty()) { if (p->vq.eof) break; continue; }
            pk = p->vq.q.front(); p->vq.q.pop_front();
            p->vq.cv.notify_all();
        }
        if (gen != p->seek_gen) {   /* a seek since: the decoder starts again at the next SPS */
            gen = p->seek_gen;
            mgu_video_reset();
            if (bsf) av_bsf_flush(bsf);
        }
        if (!pk) continue;
        const double pts = ts(pk->pts != AV_NOPTS_VALUE ? pk->pts : pk->dts, p->vtb);
        if (pts >= 0) p->clock.anchor(pts);
        if (bsf) {
            if (av_bsf_send_packet(bsf, pk) < 0) { av_packet_free(&pk); continue; }
        }
        for (;;) {
            AVPacket *au = pk;
            if (bsf) { if (av_bsf_receive_packet(bsf, out) < 0) break; au = out; }
            for (int i = 0; i + 4 < au->size; i++) {   /* Annex B NAL types, for the stats */
                if (au->data[i] == 0 && au->data[i + 1] == 0 && au->data[i + 2] == 1) {
                    const int t = au->data[i + 3] & 0x1f;
                    if (t == 5) p->idr++;
                    if (t == 7) p->sps++;
                    i += 2;
                }
            }
            const double apts = ts(au->pts != AV_NOPTS_VALUE ? au->pts : au->dts, p->vtb);
            WaitArg w{p, gen};
            unsigned long long sh = 0, er = 0;
            const int v = mgu_video_frame_timed(au->data, au->size, apts >= 0 ? (long long) llround(apts * 1000) : -1, wait_picture, &w, &sh, &er);
            p->vpk++;
            p->shown = sh; p->decerr = er;
            if (v == 1) reported = true;
            if (reported && sh > 0) {   /* the decoder open and a picture written: its size is the frame file's */
                unsigned W = 0, H = 0;
                mgu_video_size(&W, &H);
                if (W != repW || H != repH) {
                    repW = W; repH = H;
                    emitf("{\"ev\":\"decoder\",\"ok\":true,\"path\":\"%s\",\"w\":%u,\"h\":%u}", clean(mgu_video_path()).c_str(), W, H);
                }
            }
            if (v == -1) {
                emitf("{\"ev\":\"decoder\",\"ok\":false,\"error\":\"%s\"}", clean(mgu_video_error()).c_str());
                p->video_ok = false;
            }
            if (!p->video_ok && apts >= 0) {   /* no decoder (a PC, MGU_VIDEO_OFF): the packets still go at their time */
                WaitArg w2{p, gen};
                wait_picture((long long) llround(apts * 1000), &w2);
            }
            if (bsf) av_packet_unref(out); else break;
        }
        av_packet_free(&pk);
    }
    av_packet_free(&out);
    if (bsf) av_bsf_free(&bsf);
}

/* ---------------- the audio thread ---------------- */
void audio_loop(Player *p) {
    int gen = p->seek_gen;
    for (;;) {
        AVPacket *pk = nullptr;
        {
            std::unique_lock<std::mutex> l(p->aq.m);
            p->aq.cv.wait(l, [&] { return p->stop || !p->aq.q.empty() || p->aq.eof; });
            if (p->stop) break;
            if (p->aq.q.empty()) { if (p->aq.eof) break; continue; }
            pk = p->aq.q.front(); p->aq.q.pop_front();
            p->aq.cv.notify_all();
        }
        if (gen != p->seek_gen) { gen = p->seek_gen; mgu_audio_flush(); }
        const double pts = ts(pk->pts != AV_NOPTS_VALUE ? pk->pts : pk->dts, p->atb);
        if (pts >= 0) {
            if (p->vi < 0) p->clock.anchor(pts);   /* sound only: it starts the clock */
            bool drop = false;
            for (;;) {   /* 50 ms ahead of the clock: the device's own buffer plays it on time */
                if (p->stop || gen != p->seek_gen) { drop = true; break; }
                const double now = p->clock.now();
                if (now < 0) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }
                const double d = pts - 0.05 - now;
                if (d < -0.3) { drop = true; break; }   /* late (after a hold): dropped, not played fast */
                if (d <= 0.004) break;
                std::this_thread::sleep_for(std::chrono::microseconds((long) (std::min(d, 0.05) * 1e6)));
            }
            if (drop) { av_packet_free(&pk); continue; }
        }
        mgu_audio_packet(pk->data, pk->size);
        p->apk++;
        av_packet_free(&pk);
    }
}

/* ---------------- the demux thread ---------------- */
void push(Queue &q, AVPacket *pk, double t, Player *p) {
    std::unique_lock<std::mutex> l(q.m);
    /* at most ~6 s ahead of the clock (or 900 packets): the rest stays on the network */
    q.cv.wait(l, [&] {
        if (p->stop || p->seek_pending()) return true;
        const double now = p->clock.now();
        return q.q.size() < 4000 && (now < 0 || q.last < 0 || q.last - now < 20.0);   /* up to 20 s ahead */
    });
    if (p->stop) { av_packet_free(&pk); return; }
    q.q.push_back(pk);
    if (t >= 0) q.last = t;
    q.cv.notify_all();
}

/* the position on the iPhone's bar: from the stream's start */
double pos_of(Player *p) { const double now = p->clock.now(); return now < 0 ? -1 : std::max(0.0, now - p->t0); }

/* each second: the position for the app */
void tick_pos(Player *p, double &last) {
    const double t = mono();
    if (t - last < 1.0) return;
    last = t;
    bool paused, held;
    { std::lock_guard<std::mutex> l(p->clock.m); paused = p->clock.paused; held = p->clock.held; }
    const double pos = pos_of(p);
    emitf("{\"ev\":\"hlspos\",\"pos\":%.3f,\"dur\":%.3f,\"paused\":%s,\"buffering\":%s,\"stalls\":%d}", pos < 0 ? p->wait_pos.load() : pos, p->duration,
          paused ? "true" : "false", held ? "true" : "false", p->stalls.load());
}

void demux_loop(Player *p) {
    std::string err;
    AVDictionary *o = nullptr;
    av_dict_set(&o, "rw_timeout", "15000000", 0);
    av_dict_set(&o, "reconnect", "1", 0);
    av_dict_set(&o, "reconnect_streamed", "1", 0);
    /* a new connection for each segment: YouTube's segments come from several servers, and a connection kept through
     * the proxy's tunnel cannot be reused for another one (in the car, 0.9.4: "Cannot reuse HTTP connection for
     * different host", "keepalive request failed", the segments lost); a failed segment is loaded again */
    av_dict_set(&o, "http_persistent", "0", 0);
    av_dict_set(&o, "http_multiple", "0", 0);
    av_dict_set(&o, "seg_max_retry", "3", 0);
    av_dict_set(&o, "user_agent", "AppleCoreMedia/1.0.0 (Apple TV; U; CPU OS 17_0 like Mac OS X; en_us)", 0);
    p->fmt = avformat_alloc_context();
    p->fmt->interrupt_callback.callback = interrupt_cb;
    p->fmt->interrupt_callback.opaque = p;
    int rc = avformat_open_input(&p->fmt, p->url.c_str(), nullptr, &o);
    av_dict_free(&o);
    if (rc < 0) { p->fmt = nullptr; err = "cannot open the video: " + averr(rc); goto fail; }
    p->fmt->interrupt_callback.callback = interrupt_cb;
    p->fmt->interrupt_callback.opaque = p;
    pick_streams(p);
    rc = avformat_find_stream_info(p->fmt, nullptr);
    if (rc < 0 && !p->stop) { err = "cannot read the video: " + averr(rc); goto fail; }
    pick_streams(p);   /* sizes are known now */
    if (p->vi < 0 && p->ai < 0) { err = "no H.264 video and no sound in it"; goto fail; }
    p->duration = p->fmt->duration > 0 ? p->fmt->duration / (double) AV_TIME_BASE : 0;
    p->t0 = p->fmt->start_time != AV_NOPTS_VALUE && p->fmt->start_time > 0 ? p->fmt->start_time / (double) AV_TIME_BASE : 0;
    {
        AVCodecParameters *v = p->vi >= 0 ? p->fmt->streams[p->vi]->codecpar : nullptr;
        AVCodecParameters *a = p->ai >= 0 ? p->fmt->streams[p->ai]->codecpar : nullptr;
        if (v) p->vtb = p->fmt->streams[p->vi]->time_base;
        if (a) p->atb = p->fmt->streams[p->ai]->time_base;
        int variants = 0;
        for (unsigned i = 0; i < p->fmt->nb_streams; i++) if (p->fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) variants++;
        emitf("{\"ev\":\"hlsopen\",\"w\":%d,\"h\":%d,\"vcodec\":\"%s\",\"acodec\":\"%s\",\"rate\":%d,\"ch\":%d,\"dur\":%.3f,\"variants\":%d,\"format\":\"%s\"}",
              v ? v->width : 0, v ? v->height : 0, v ? avcodec_get_name(v->codec_id) : "", a ? avcodec_get_name(a->codec_id) : "",
              a ? a->sample_rate : 0, a ? a->ch_layout.nb_channels : 0, p->duration, variants, clean(p->fmt->iformat->name).c_str());
        if (a) {
            if (mgu_audio_start_codec(a->codec_id, a->sample_rate, a->ch_layout.nb_channels, a->extradata, a->extradata_size) == 0) {
                mgu_audio_volume(g_volume);
                emitf("{\"ev\":\"sound\",\"ok\":true,\"device\":\"%s\",\"ct\":0}", clean(mgu_audio_device()).c_str());
            } else {
                emitf("{\"ev\":\"sound\",\"ok\":false,\"error\":\"%s\",\"ct\":0}", clean(mgu_audio_error()).c_str());
                p->ai = -1;
            }
        }
    }
    if (p->start_s > 0.5 && p->duration > 0) {
        std::lock_guard<std::mutex> l(p->seek_m);
        p->seek_to = p->start_s;
    }
    p->open = true;
    mgu_video_display_order(1);   /* B frames: display order (the decoder starts at the first SPS after this) */
    mgu_video_native(1);          /* the video's own size: the app places it (fit, zoom, fill) */
    mgu_video_reset();
    emitf("{\"ev\":\"start\"}");
    if (p->vi >= 0) p->vthr = std::thread(video_loop, p);
    if (p->ai >= 0) p->athr = std::thread(audio_loop, p);
    {
        AVPacket *pk = av_packet_alloc();
        double last_stats = mono(), lastpos = mono();
        unsigned long long last_bytes = 0, last_vpk = 0;
        for (;;) {
            if (p->stop) break;
            double target = -1;
            { std::lock_guard<std::mutex> l(p->seek_m); target = p->seek_to; p->seek_to = -1; }
            if (target >= 0) {
                const int64_t t = (int64_t) ((target + p->t0) * AV_TIME_BASE);
                rc = avformat_seek_file(p->fmt, -1, INT64_MIN, t, t, 0);
                p->vq.clear(); p->aq.clear();
                p->clock.reset();
                p->warm = false;
                p->wait_pos = target;
                p->seek_gen++;
                p->vq.cv.notify_all(); p->aq.cv.notify_all();
                emitf("{\"ev\":\"hlsseek\",\"to\":%.3f,\"ok\":%s}", target, rc >= 0 ? "true" : "false");
            }
            /* buffering: at the start (and after a seek) the clock waits until 3 s is read; a queue that runs dry while
             * playing holds it until 4 s is read again (in the car, 0.9.5: holding until 1.5 s stuttered on a hotspot) */
            {
                const double now = p->clock.now();
                Queue &q = p->vi >= 0 ? p->vq : p->aq;
                double ahead;
                bool qeof;
                { std::lock_guard<std::mutex> l(q.m); ahead = q.last >= 0 && now >= 0 ? q.last - now : 0; qeof = q.eof; }
                const bool held = p->clock.is_held();
                if (now >= 0 && !p->warm) {
                    if (ahead >= 3.0 || qeof) { if (held) p->clock.set_held(false); p->warm = true; }
                    else if (!held) p->clock.set_held(true);
                } else if (now >= 0 && !held && !qeof && ahead < 0.1) { p->clock.set_held(true); p->stalls++; }
                else if (held && (ahead > 4.0 || qeof)) p->clock.set_held(false);
            }
            const double t = mono();
            if (t - last_stats >= 1.0) {
                mgu_audio_stats_t a;
                mgu_audio_stats(&a);
                const double dt = t - last_stats;
                emitf("{\"ev\":\"stats\",\"frames\":%llu,\"fps\":%.1f,\"kbps\":%.0f,\"idr\":%llu,\"sps\":%llu,\"audio\":%llu,\"shown\":%llu,\"decerr\":%llu,"
                      "\"adec\":%llu,\"alate\":%llu,\"afull\":%llu,\"aerr\":%llu,\"axrun\":%llu,\"adev\":%.0f}",
                      p->vpk.load(), (p->vpk - last_vpk) / dt, (p->bytes - last_bytes) * 8.0 / 1000.0 / dt, p->idr.load(), p->sps.load(),
                      p->apk.load(), p->shown.load(), p->decerr.load(), a.decoded, a.dropped_late, a.dropped_full, a.errors, a.xruns, a.device_ms);
                last_stats = t; last_bytes = p->bytes; last_vpk = p->vpk;
            }
            tick_pos(p, lastpos);
            rc = av_read_frame(p->fmt, pk);
            if (rc == AVERROR(EAGAIN)) { av_usleep(10000); continue; }
            if (rc < 0 && getenv("MGU_HLS_DEBUG")) fprintf(stderr, "read: %s\n", averr(rc).c_str());
            if (rc < 0) {
                if (p->stop) break;
                if (rc != AVERROR_EOF && !avio_feof(p->fmt->pb ? p->fmt->pb : nullptr)) err = "reading the video: " + averr(rc);
                /* the end: the threads play out what they hold */
                { std::lock_guard<std::mutex> l(p->vq.m); p->vq.eof = true; p->vq.cv.notify_all(); }
                { std::lock_guard<std::mutex> l(p->aq.m); p->aq.eof = true; p->aq.cv.notify_all(); }
                /* a seek during the play-out reopens the reading */
                bool reseek = false;
                while (!p->stop) {
                    { std::lock_guard<std::mutex> l(p->seek_m); if (p->seek_to >= 0) { reseek = true; break; } }
                    if (p->vq.size() == 0 && p->aq.size() == 0) break;
                    tick_pos(p, lastpos);
                    av_usleep(50000);
                }
                if (reseek) { err.clear(); p->vq.clear(); p->aq.clear(); continue; }
                if (p->vthr.joinable()) p->vthr.join();
                if (p->athr.joinable()) p->athr.join();
                break;
            }
            p->bytes += pk->size;
            if (getenv("MGU_HLS_DEBUG")) fprintf(stderr, "read s%d dts %.3f pts %.3f size %d\n", pk->stream_index,
                ts(pk->dts, p->fmt->streams[pk->stream_index]->time_base), ts(pk->pts, p->fmt->streams[pk->stream_index]->time_base), pk->size);
            AVPacket *c = av_packet_clone(pk);
            av_packet_unref(pk);
            if (!c) continue;
            if (c->stream_index == p->vi) push(p->vq, c, ts(c->dts != AV_NOPTS_VALUE ? c->dts : c->pts, p->vtb), p);
            else if (c->stream_index == p->ai) push(p->aq, c, ts(c->pts != AV_NOPTS_VALUE ? c->pts : c->dts, p->atb), p);
            else av_packet_free(&c);
        }
        av_packet_free(&pk);
    }
    if (!err.empty()) goto fail;
    p->ended = true;
    if (!p->stop) {
        emitf("{\"ev\":\"hlsend\",\"why\":\"end\"}");
        p->eos_flag = true;
        g_eos = 1;
    }
    return;
fail:
    p->error = err;
    p->ended = true;
    if (p->stop) return;   /* stopped (the iPhone ended it): no error, no end to report */
    emitf("{\"ev\":\"hlsend\",\"why\":\"error\",\"error\":\"%s\"}", clean(err).c_str());
    p->eos_flag = true;
    g_eos = 1;
}

/* everything of a play, once its threads have ended */
void stop_locked() {
    Player *p = g_p;
    if (!p) return;
    g_p = nullptr;
    p->stop = true;
    p->vq.cv.notify_all(); p->aq.cv.notify_all();
    if (p->demux.joinable()) p->demux.join();
    if (p->vthr.joinable()) p->vthr.join();
    if (p->athr.joinable()) p->athr.join();
    p->vq.clear(); p->aq.clear();
    if (p->fmt) avformat_close_input(&p->fmt);
    const bool was_open = p->open;
    delete p;
    mgu_audio_stop();
    if (was_open) { emitf("{\"ev\":\"soundstop\"}"); emitf("{\"ev\":\"stop\",\"frames\":0}"); }
    mgu_video_stop();
    mgu_video_display_order(0);   /* mirroring again: decoding order, the lowest latency */
    mgu_video_native(0);          /* and the screen's size, fitted by the decoder */
}

}  // namespace

extern "C" void mgu_hls_set_emit(void (*emit)(const char *)) { g_emit = emit; }

extern "C" int mgu_hls_start(const char *url, double start_s) {
    std::lock_guard<std::mutex> l(g_m);
    stop_locked();
    if (!url || !*url) return -1;
    avformat_network_init();
    /* FFmpeg's own lines (errors and warnings) go to the receiver's log; its info lines too with MGU_HLS_DEBUG */
    av_log_set_level(getenv("MGU_HLS_DEBUG") ? AV_LOG_INFO : AV_LOG_WARNING);
    Player *p = new Player();
    p->url = url;
    p->start_s = start_s > 0 ? start_s : 0;
    p->wait_pos = p->start_s;
    g_eos = 0;
    std::string shown = p->url.substr(0, p->url.find('?'));
    emitf("{\"ev\":\"hls\",\"url\":\"%s\",\"start\":%.3f}", clean(shown).c_str(), p->start_s);
    g_p = p;
    p->demux = std::thread(demux_loop, p);
    return 0;
}

extern "C" void mgu_hls_stop(void) {
    std::lock_guard<std::mutex> l(g_m);
    if (g_p && !g_p->ended) emitf("{\"ev\":\"hlsend\",\"why\":\"stopped\"}");
    stop_locked();
    g_eos = 0;   /* an end reported for a video that is gone would reach UxPlay with no video */
}

extern "C" void mgu_hls_pause(int paused) {
    std::lock_guard<std::mutex> l(g_m);
    if (g_p) g_p->clock.set_paused(paused != 0);
}

extern "C" void mgu_hls_seek(double s) {
    std::lock_guard<std::mutex> l(g_m);
    if (!g_p || s < 0) return;
    { std::lock_guard<std::mutex> k(g_p->seek_m); g_p->seek_to = s; }
    g_p->vq.cv.notify_all(); g_p->aq.cv.notify_all();
}

extern "C" void mgu_hls_volume(double v) {
    std::lock_guard<std::mutex> l(g_m);
    g_volume = v < 0 ? 0 : v > 1 ? 1 : v;
    mgu_audio_volume(g_volume);
}

extern "C" int mgu_hls_info(double *duration, double *position, double *seek_start, double *seek_duration, float *rate,
                            int *buffer_empty, int *buffer_full) {
    std::lock_guard<std::mutex> l(g_m);
    Player *p = g_p;
    const bool on = p && !p->ended;
    double pos = 0, dur = 0;
    bool paused = false, held = false;
    if (p) {
        const double now = pos_of(p);
        pos = now < 0 ? p->wait_pos.load() : now;
        dur = p->duration;
        std::lock_guard<std::mutex> k(p->clock.m);
        paused = p->clock.paused; held = p->clock.held;
    }
    if (duration) *duration = dur;
    if (position) *position = pos;
    if (seek_start) *seek_start = 0;
    if (seek_duration) *seek_duration = dur;
    if (rate) *rate = on && !paused ? 1.0f : 0.0f;   /* loading is still playing to the iPhone (GStreamer's PLAYING) */
    if (buffer_empty) *buffer_empty = held ? 1 : 0;
    if (buffer_full) *buffer_full = 0;
    return on ? 1 : 0;
}

extern "C" int mgu_hls_eos(void) { int e = 1; return g_eos.compare_exchange_strong(e, 0) ? 1 : 0; }
extern "C" int mgu_hls_active(void) { std::lock_guard<std::mutex> l(g_m); return g_p && !g_p->ended ? 1 : 0; }
