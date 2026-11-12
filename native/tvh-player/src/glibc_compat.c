// SPDX-License-Identifier: GPL-3.0-or-later
/* glibc 2.27 gave powf and log2f new versions; FFmpeg's decoders would ask for them. The binary keeps to what the
 * AirPlay receiver needs (glibc 2.25 at most): linked with --wrap, these call the older versions. */
__asm__(".symver old_powf, powf@GLIBC_2.2.5");
__asm__(".symver old_log2f, log2f@GLIBC_2.2.5");
extern float old_powf(float, float);
extern float old_log2f(float);
float __wrap_powf(float x, float y) { return old_powf(x, y); }
float __wrap_log2f(float x) { return old_log2f(x); }
