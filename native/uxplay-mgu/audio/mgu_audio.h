// SPDX-License-Identifier: GPL-3.0-or-later
/* mgu_audio.cpp's C interface, for renderer/mgu_renderer.c */
#ifndef MGU_AUDIO_H
#define MGU_AUDIO_H
#ifdef __cplusplus
extern "C" {
#endif
typedef struct mgu_audio_stats_s {
    unsigned long long packets, decoded, dropped_late, dropped_full, errors, xruns;
    double device_ms;   /* the device's delay last read, -1 unknown */
    int open;           /* 1 the device is open, 0 not (yet), -1 failed */
} mgu_audio_stats_t;
/* ct: UxPlay's compression type (2 ALAC, 4 AAC-LC, 8 AAC-ELD); returns 0, or -1 with mgu_audio_error() */
int mgu_audio_start(int ct);
/* stage 4 (HLS): the stream's codec (libavcodec AVCodecID), rate, channels, codec data (NULL/0 for ADTS) */
int mgu_audio_start_codec(int codec_id, int rate, int channels, const unsigned char *extradata, int extradata_len);
void mgu_audio_packet(const unsigned char *data, int len);
void mgu_audio_flush(void);
void mgu_audio_volume(double v);   /* 0..1, the iPhone's volume */
void mgu_audio_stop(void);
void mgu_audio_stats(mgu_audio_stats_t *s);
const char *mgu_audio_error(void);
const char *mgu_audio_device(void);
#ifdef __cplusplus
}
#endif
#endif
