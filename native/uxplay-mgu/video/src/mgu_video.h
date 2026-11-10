// SPDX-License-Identifier: GPL-3.0-or-later
/* mgu_video.cpp's C interface, for renderer/mgu_renderer.c */
#ifndef MGU_VIDEO_H
#define MGU_VIDEO_H
#ifdef __cplusplus
extern "C" {
#endif
/* one access unit; returns 1 the first time the decoder opened, -1 the first time it could not
 * (mgu_video_error() says why), else 0. shown/errors: totals so far. */
int mgu_video_frame(const unsigned char *data, int len, unsigned long long *shown, unsigned long long *errors);
/* stage 4: as mgu_video_frame, the access unit's pts given; each picture waits for wait(pts_ms, arg): 0 shown, 1 dropped */
int mgu_video_frame_timed(const unsigned char *data, int len, long long pts_ms, int (*wait)(long long, void *), void *arg,
                          unsigned long long *shown, unsigned long long *errors);
/* stage 4: 1 a played video's pictures in display order (B frames), 0 decoding order (mirroring); from the next start */
void mgu_video_display_order(int on);
/* stage 4: 1 a played video's own size (the frame file made at its first picture, the app places it), 0 MGU_VIDEO_SIZE fitted */
void mgu_video_native(int on);
/* a seek: the decoder starts again at the next SPS, the frame file stays */
void mgu_video_reset(void);
void mgu_video_stop(void);
void mgu_video_close(void);
const char *mgu_video_error(void);
const char *mgu_video_path(void);
void mgu_video_size(unsigned *w, unsigned *h);
#ifdef __cplusplus
}
#endif
#endif
