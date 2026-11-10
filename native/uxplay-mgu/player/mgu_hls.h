// SPDX-License-Identifier: GPL-3.0-or-later
/* mgu_hls.cpp's C interface, for renderer/mgu_renderer.c: stage 4, a video the iPhone hands over (AirPlay's
 * "play": YouTube's HLS through UxPlay's local playlists, or a direct http(s) address) played on the head unit */
#ifndef MGU_HLS_H
#define MGU_HLS_H
#ifdef __cplusplus
extern "C" {
#endif
/* every event goes out as one JSON object (the renderer prints it as "MGU {json}") */
void mgu_hls_set_emit(void (*emit)(const char *json));
/* starts playing `url` from start_s seconds; the previous play is stopped first. 0, or -1 (a play is refused) */
int mgu_hls_start(const char *url, double start_s);
void mgu_hls_stop(void);
void mgu_hls_pause(int paused);
void mgu_hls_seek(double s);
void mgu_hls_volume(double v);   /* 0..1 */
/* the iPhone's progress bar: returns 1 while a play is on (also paused or buffering), 0 once it ended or failed */
int mgu_hls_info(double *duration, double *position, double *seek_start, double *seek_duration, float *rate,
                 int *buffer_empty, int *buffer_full);
/* 1 once, when a play reached its end (UxPlay's EOS watch) */
int mgu_hls_eos(void);
int mgu_hls_active(void);
#ifdef __cplusplus
}
#endif
#endif
