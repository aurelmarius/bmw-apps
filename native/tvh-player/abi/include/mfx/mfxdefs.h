// SPDX-License-Identifier: MIT
// Copyright (c) 2007-2019 Intel Corporation (abi/include/mfx/LICENSE)
/* Intel Media SDK 1.x API: base types and status codes.
 *
 * Subset of Intel's mfxdefs.h (MIT licence, Copyright (c) 2007-2019 Intel
 * Corporation), holding only what woc's decoder uses. The declarations come
 * from Intel's MediaSDK headers (Ubuntu libmfx-dev 20.1.0, API 1.32); every
 * size, offset, constant and prototype the decoder uses was compared with
 * them on x86-64 and is identical.
 *
 * The unit's MSDK reports API 1.24 (MFXQueryVersion on its libmfxsw64-p.so.1.24;
 * libmfxhw64-p.so.1.24 is the same release, file version 0.20.7.21); the
 * decoder requests that version. */
#ifndef WOC_MFXDEFS_H
#define WOC_MFXDEFS_H

#define MFX_VERSION_MAJOR 1
#define MFX_VERSION_MINOR 24

#ifdef __cplusplus
extern "C" {
#endif

#define MFX_INFINITE 0xFFFFFFFF

typedef unsigned char       mfxU8;
typedef char                mfxI8;
typedef short               mfxI16;
typedef unsigned short      mfxU16;
typedef unsigned int        mfxU32;
typedef int                 mfxI32;
typedef unsigned long long  mfxU64;
typedef long long           mfxI64;
typedef void*               mfxHDL;
typedef mfxHDL              mfxMemId;

typedef enum
{
    MFX_ERR_NONE                        = 0,
    MFX_ERR_UNKNOWN                     = -1,
    MFX_ERR_NULL_PTR                    = -2,
    MFX_ERR_UNSUPPORTED                 = -3,
    MFX_ERR_MEMORY_ALLOC                = -4,
    MFX_ERR_NOT_ENOUGH_BUFFER           = -5,
    MFX_ERR_INVALID_HANDLE              = -6,
    MFX_ERR_LOCK_MEMORY                 = -7,
    MFX_ERR_NOT_INITIALIZED             = -8,
    MFX_ERR_NOT_FOUND                   = -9,
    MFX_ERR_MORE_DATA                   = -10,
    MFX_ERR_MORE_SURFACE                = -11,
    MFX_ERR_ABORTED                     = -12,
    MFX_ERR_DEVICE_LOST                 = -13,
    MFX_ERR_INCOMPATIBLE_VIDEO_PARAM    = -14,
    MFX_ERR_INVALID_VIDEO_PARAM         = -15,
    MFX_ERR_UNDEFINED_BEHAVIOR          = -16,
    MFX_ERR_DEVICE_FAILED               = -17,
    MFX_ERR_MORE_BITSTREAM              = -18,
    MFX_ERR_INCOMPATIBLE_AUDIO_PARAM    = -19,
    MFX_ERR_INVALID_AUDIO_PARAM         = -20,
    MFX_ERR_GPU_HANG                    = -21,
    MFX_ERR_REALLOC_SURFACE             = -22,

    MFX_WRN_IN_EXECUTION                = 1,
    MFX_WRN_DEVICE_BUSY                 = 2,
    MFX_WRN_VIDEO_PARAM_CHANGED         = 3,
    MFX_WRN_PARTIAL_ACCELERATION        = 4,
    MFX_WRN_INCOMPATIBLE_VIDEO_PARAM    = 5,
    MFX_WRN_VALUE_NOT_CHANGED           = 6,
    MFX_WRN_OUT_OF_RANGE                = 7,
    MFX_WRN_FILTER_SKIPPED              = 10,
    MFX_WRN_INCOMPATIBLE_AUDIO_PARAM    = 11
} mfxStatus;

#ifdef __cplusplus
}
#endif

#endif
