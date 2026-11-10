// SPDX-License-Identifier: GPL-3.0-or-later
/* mgu_audio.cpp - stage 3 of the AirPlay receiver: the iPhone's sound on the car's speakers.
 *
 * UxPlay's renderer hands each decrypted audio packet here: AAC-ELD 44100/2 (480 samples, screen mirroring), ALAC
 * 44100/16/2 (352 samples, AirPlay audio) or AAC-LC. They are decoded with libavcodec (the aac and alac decoders
 * UxPlay itself uses through GStreamer's avdec_aac / avdec_alac, with the same codec data), turned into S16
 * interleaved at the iPhone's volume, and written to ALSA: by default plug:smartx:CarLifeMedia_CF_48_STEREO, the
 * SmartXbar input Moonride plays into (CarLife's, unused in Europe; plug converts 44.1 to 48 kHz). The app routes
 * that source to the speakers through the audio manager while the receiver has an iPhone with sound.
 *
 * As Moonride's audio.cpp (JustAnotherPU, GPL-3.0-or-later), whose ALSA handling this follows: libasound is opened
 * at run time (dlopen), the device NONBLOCKING (an input nobody consumes must never park a thread or keep the device
 * busy: Vizualyse's notes), and a packet is dropped, not queued, when the device is more than its buffer + 25 ms
 * behind or full: live sound stays live after the first, slow, connect of an input.
 *
 * MGU_AUDIO   alsa:<device> (default alsa:plug:smartx:CarLifeMedia_CF_48_STEREO) | null | wav:<path> (tests)
 * MGU_ALSA_US the ALSA buffer in us (default 64000: smartx's 3 periods of 1024 frames, measured by Moonride)
 */
#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <mutex>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <time.h>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
}

#include "mgu_audio.h"

namespace {

typedef struct snd_pcm snd_pcm_t;
struct Alsa {
    int (*open)(snd_pcm_t **, const char *, int, int);
    int (*set_params)(snd_pcm_t *, int, int, unsigned, unsigned, int, unsigned);
    long (*writei)(snd_pcm_t *, const void *, unsigned long);
    int (*recover)(snd_pcm_t *, int, int);
    int (*delay)(snd_pcm_t *, long *);
    int (*close)(snd_pcm_t *);
    const char *(*strerror)(int);
} A;
bool g_alsa_loaded = false;
const int kPlayback = 0, kS16LE = 2, kRwInterleaved = 3, kNonblock = 1;
const unsigned kCh = 2;
unsigned g_rate = 44100;   /* the device's rate: 44100 (the iPhone's), or the stream's (stage 4, HLS) */

std::mutex g_m;
AVCodecContext *g_ctx = nullptr;
AVPacket *g_pkt = nullptr;
AVFrame *g_frame = nullptr;
int g_ct = -1;
enum Kind { NUL, WAV, ALSA } g_kind = NUL;
std::string g_target, g_err;
snd_pcm_t *g_pcm = nullptr;
FILE *g_wav = nullptr;
uint32_t g_wav_bytes = 0;
double g_volume = 1.0;
std::vector<int16_t> g_out;
mgu_audio_stats_t g_st = {0, 0, 0, 0, 0, 0, -1.0, 0};

unsigned buffer_us() { const char *e = getenv("MGU_ALSA_US"); return e && atoi(e) > 0 ? (unsigned) atoi(e) : 64000; }
long drop_above_ms() { return (long) (buffer_us() / 1000) + 25; }

bool alsa_load() {
    if (g_alsa_loaded) return true;
    void *h = dlopen("libasound.so.2", RTLD_NOW);
    if (!h) { g_err = std::string("dlopen libasound.so.2: ") + dlerror(); return false; }
#define SYM(f, n) (*(void **) &A.f = dlsym(h, n))
    g_alsa_loaded = SYM(open, "snd_pcm_open") && SYM(set_params, "snd_pcm_set_params") && SYM(writei, "snd_pcm_writei") &&
                    SYM(recover, "snd_pcm_recover") && SYM(delay, "snd_pcm_delay") && SYM(close, "snd_pcm_close") &&
                    SYM(strerror, "snd_strerror");
#undef SYM
    if (!g_alsa_loaded) g_err = "libasound.so.2 lacks a symbol";
    return g_alsa_loaded;
}

void wav_header(uint32_t data) {
    const uint32_t rate = g_rate, br = rate * 2 * kCh, riff = 36 + data, fmt = 16;
    const uint16_t pcm = 1, ch = kCh, ba = 2 * kCh, bits = 16;
    fseek(g_wav, 0, SEEK_SET);
    fwrite("RIFF", 1, 4, g_wav); fwrite(&riff, 4, 1, g_wav); fwrite("WAVEfmt ", 1, 8, g_wav);
    fwrite(&fmt, 4, 1, g_wav); fwrite(&pcm, 2, 1, g_wav); fwrite(&ch, 2, 1, g_wav); fwrite(&rate, 4, 1, g_wav);
    fwrite(&br, 4, 1, g_wav); fwrite(&ba, 2, 1, g_wav); fwrite(&bits, 2, 1, g_wav); fwrite("data", 1, 4, g_wav);
    fwrite(&data, 4, 1, g_wav);
    fseek(g_wav, 0, SEEK_END);
}

void parse_target() {
    const char *e = getenv("MGU_AUDIO");
    std::string s = e && *e ? e : "alsa:plug:smartx:CarLifeMedia_CF_48_STEREO";
    if (s == "null") { g_kind = NUL; g_target = "null"; }
    else if (s.compare(0, 4, "wav:") == 0 && s.size() > 4) { g_kind = WAV; g_target = s.substr(4); }
    else if (s.compare(0, 5, "alsa:") == 0 && s.size() > 5) { g_kind = ALSA; g_target = s.substr(5); }
    else { g_kind = NUL; g_target = "null"; g_err = "MGU_AUDIO not understood: " + s; }
}

/* the codec data UxPlay gives GStreamer (renderers/audio_renderer.c) */
bool open_decoder(int ct) {
    static const uint8_t eld[] = {0xf8, 0xe8, 0x50, 0x00};                       /* AAC-ELD 44100/2, 480 */
    static const uint8_t lc[] = {0x12, 0x10};                                     /* AAC-LC 44100/2 */
    static const uint8_t alac[] = {0x00, 0x00, 0x00, 0x24, 0x61, 0x6c, 0x61, 0x63, 0x00, 0x00, 0x00, 0x00,
                                   0x00, 0x00, 0x01, 0x60, 0x00, 0x10, 0x28, 0x0a, 0x0e, 0x02, 0x00, 0xff,
                                   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xac, 0x44};   /* 44100/16/2, 352 */
    const uint8_t *cd = nullptr;
    size_t cdlen = 0;
    enum AVCodecID id;
    if (ct == 8) { id = AV_CODEC_ID_AAC; cd = eld; cdlen = sizeof eld; }
    else if (ct == 4) { id = AV_CODEC_ID_AAC; cd = lc; cdlen = sizeof lc; }
    else if (ct == 2) { id = AV_CODEC_ID_ALAC; cd = alac; cdlen = sizeof alac; }
    else { g_err = "audio type " + std::to_string(ct) + " not handled"; return false; }
    const AVCodec *codec = avcodec_find_decoder(id);
    if (!codec) { g_err = "no decoder"; return false; }
    g_ctx = avcodec_alloc_context3(codec);
    g_ctx->sample_rate = (int) g_rate;
    av_channel_layout_default(&g_ctx->ch_layout, kCh);
    g_ctx->extradata = (uint8_t *) av_mallocz(cdlen + AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(g_ctx->extradata, cd, cdlen);
    g_ctx->extradata_size = (int) cdlen;
    if (avcodec_open2(g_ctx, codec, nullptr) < 0) { g_err = "avcodec_open2 failed"; avcodec_free_context(&g_ctx); return false; }
    g_pkt = av_packet_alloc();
    g_frame = av_frame_alloc();
    return true;
}

void close_all() {
    if (g_ctx) avcodec_free_context(&g_ctx);
    if (g_pkt) av_packet_free(&g_pkt);
    if (g_frame) av_frame_free(&g_frame);
    if (g_pcm) { A.close(g_pcm); g_pcm = nullptr; }
    if (g_wav) { wav_header(g_wav_bytes); fclose(g_wav); g_wav = nullptr; }
    g_ct = -1;
    g_st.open = 0;
}

int16_t clip(float f) { return f >= 1.0f ? 32767 : f <= -1.0f ? -32768 : (int16_t) lrintf(f * 32767.0f); }

/* the decoded frame -> g_out, S16 interleaved stereo at the volume */
void to_s16(const AVFrame *f) {
    const int n = f->nb_samples, ch = f->ch_layout.nb_channels > 0 ? f->ch_layout.nb_channels : (int) kCh;
    g_out.resize((size_t) n * kCh);
    const float v = (float) g_volume;
    for (int i = 0; i < n; i++) {
        for (unsigned c = 0; c < kCh; c++) {
            const int sc = (int) c < ch ? (int) c : ch - 1;
            float x = 0;
            switch (f->format) {
            case AV_SAMPLE_FMT_FLTP: x = ((const float *) f->extended_data[sc])[i]; break;
            case AV_SAMPLE_FMT_FLT: x = ((const float *) f->extended_data[0])[i * ch + sc]; break;
            case AV_SAMPLE_FMT_S16P: x = ((const int16_t *) f->extended_data[sc])[i] / 32768.0f; break;
            case AV_SAMPLE_FMT_S16: x = ((const int16_t *) f->extended_data[0])[i * ch + sc] / 32768.0f; break;
            case AV_SAMPLE_FMT_S32P: x = ((const int32_t *) f->extended_data[sc])[i] / 2147483648.0f; break;
            case AV_SAMPLE_FMT_S32: x = ((const int32_t *) f->extended_data[0])[i * ch + sc] / 2147483648.0f; break;
            default: x = 0; break;
            }
            g_out[(size_t) i * kCh + c] = clip(x * v);
        }
    }
}

void play_out() {
    const unsigned long n = g_out.size() / kCh;
    if (!n) return;
    if (g_kind == WAV && g_wav) {
        fwrite(g_out.data(), 2 * kCh, n, g_wav);
        g_wav_bytes += (uint32_t) (2 * kCh * n);
        return;
    }
    if (g_kind != ALSA || !g_pcm) return;
    long d = 0;
    if (A.delay(g_pcm, &d) == 0) {
        g_st.device_ms = d * 1000.0 / g_rate;
        if (g_st.device_ms > drop_above_ms()) { g_st.dropped_late++; return; }
    }
    long w = A.writei(g_pcm, g_out.data(), n);
    if (w == -EAGAIN) g_st.dropped_full++;   /* nobody reads (the source not connected yet): never wait */
    else if (w < 0) { g_st.xruns++; A.recover(g_pcm, (int) w, 1); }
}

/* the output (ALSA, wav or null) for g_rate; g_err and -1 when it cannot */
int open_output() {
    if (g_kind == WAV) {
        g_wav = fopen(g_target.c_str(), "wb");
        if (!g_wav) { g_err = "cannot create " + g_target; g_st.open = -1; return -1; }
        wav_header(0);
        g_wav_bytes = 0;
    } else if (g_kind == ALSA) {
        int rc = alsa_load() ? A.open(&g_pcm, g_target.c_str(), kPlayback, kNonblock) : -1;
        if (rc < 0) {
            if (rc != -1) g_err = std::string("snd_pcm_open ") + g_target + ": " + A.strerror(rc);
            g_pcm = nullptr;
            g_st.open = -1;
            return -1;
        }
        rc = A.set_params(g_pcm, kS16LE, kRwInterleaved, kCh, g_rate, 1, buffer_us());
        if (rc < 0) {
            g_err = std::string("snd_pcm_set_params: ") + A.strerror(rc);
            A.close(g_pcm); g_pcm = nullptr;
            g_st.open = -1;
            return -1;
        }
    }
    g_st.open = 1;
    return 0;
}

}  // namespace

extern "C" int mgu_audio_start(int ct) {
    std::lock_guard<std::mutex> l(g_m);
    close_all();
    g_err.clear();
    parse_target();
    g_rate = 44100;
    if (!open_decoder(ct)) { g_st.open = -1; return -1; }
    g_ct = ct;
    return open_output();
}

/* stage 4 (HLS): a stream's own codec (libavcodec id), rate, channels and codec data (may be empty: ADTS) */
extern "C" int mgu_audio_start_codec(int codec_id, int rate, int channels, const unsigned char *extradata, int extradata_len) {
    std::lock_guard<std::mutex> l(g_m);
    close_all();
    g_err.clear();
    parse_target();
    g_rate = rate >= 8000 && rate <= 96000 ? (unsigned) rate : 48000;
    const AVCodec *codec = avcodec_find_decoder((enum AVCodecID) codec_id);
    if (!codec) { g_err = "no decoder for the stream's audio (" + std::string(avcodec_get_name((enum AVCodecID) codec_id)) + ")"; g_st.open = -1; return -1; }
    g_ctx = avcodec_alloc_context3(codec);
    g_ctx->sample_rate = (int) g_rate;
    av_channel_layout_default(&g_ctx->ch_layout, channels > 0 ? channels : 2);
    if (extradata && extradata_len > 0) {
        g_ctx->extradata = (uint8_t *) av_mallocz((size_t) extradata_len + AV_INPUT_BUFFER_PADDING_SIZE);
        memcpy(g_ctx->extradata, extradata, (size_t) extradata_len);
        g_ctx->extradata_size = extradata_len;
    }
    if (avcodec_open2(g_ctx, codec, nullptr) < 0) { g_err = "avcodec_open2 failed"; avcodec_free_context(&g_ctx); g_st.open = -1; return -1; }
    g_pkt = av_packet_alloc();
    g_frame = av_frame_alloc();
    g_ct = 100;
    return open_output();
}

extern "C" void mgu_audio_packet(const unsigned char *data, int len) {
    std::lock_guard<std::mutex> l(g_m);
    if (!g_ctx || len <= 0) return;
    g_st.packets++;
    if (av_new_packet(g_pkt, len) < 0) { g_st.errors++; return; }
    memcpy(g_pkt->data, data, (size_t) len);
    int rc = avcodec_send_packet(g_ctx, g_pkt);
    av_packet_unref(g_pkt);
    if (rc < 0) { g_st.errors++; return; }
    while (avcodec_receive_frame(g_ctx, g_frame) == 0) {
        g_st.decoded++;
        to_s16(g_frame);
        play_out();
        av_frame_unref(g_frame);
    }
}

extern "C" void mgu_audio_flush(void) {
    std::lock_guard<std::mutex> l(g_m);
    if (g_ctx) avcodec_flush_buffers(g_ctx);
}

extern "C" void mgu_audio_volume(double v) {
    std::lock_guard<std::mutex> l(g_m);
    g_volume = v < 0 ? 0 : v > 1 ? 1 : v;
}

/* the device closed: an input left open would stay busy (Vizualyse) */
extern "C" void mgu_audio_stop(void) {
    std::lock_guard<std::mutex> l(g_m);
    close_all();
}

extern "C" void mgu_audio_stats(mgu_audio_stats_t *s) {
    std::lock_guard<std::mutex> l(g_m);
    if (s) *s = g_st;
}

extern "C" const char *mgu_audio_error(void) { return g_err.c_str(); }
extern "C" const char *mgu_audio_device(void) { return g_target.c_str(); }
