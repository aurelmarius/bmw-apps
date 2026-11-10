// SPDX-License-Identifier: MIT
// Copyright (c) 2007-2019 Intel Corporation (abi/include/mfx/LICENSE)
/* Intel Media SDK 1.x API: session, core, decode and VPP functions.
 *
 * Subset of Intel's mfxsession.h and mfxvideo.h (MIT licence, Copyright (c)
 * 2007-2019 Intel Corporation); see mfxdefs.h. On the head unit these are
 * exported by /usr/lib/libmfxhw64.so itself (version nodes LIBMFX_1.0 ...
 * LIBMFX_1.19); it has no separate dispatcher library. */
#ifndef WOC_MFXVIDEO_H
#define WOC_MFXVIDEO_H

#include "mfxstructures.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct _mfxSession *mfxSession;

mfxStatus MFXInit(mfxIMPL impl, mfxVersion *ver, mfxSession *session);

/* mfxsession.h / mfxcommon.h, API 1.14+ (ytdec: GPU copy) */
enum { MFX_GPUCOPY_DEFAULT = 0, MFX_GPUCOPY_ON = 1, MFX_GPUCOPY_OFF = 2 };
typedef struct {
    mfxIMPL Implementation;
    mfxVersion Version;
    mfxU16 ExternalThreads;
    union {
        struct {
            mfxExtBuffer **ExtParam;
            mfxU16 NumExtParam;
        };
        mfxU16 reserved2[5];
    };
    mfxU16 GPUCopy;
    mfxU16 reserved[21];
} mfxInitParam;
mfxStatus MFXInitEx(mfxInitParam par, mfxSession *session);
mfxStatus MFXClose(mfxSession session);
mfxStatus MFXQueryIMPL(mfxSession session, mfxIMPL *impl);
mfxStatus MFXQueryVersion(mfxSession session, mfxVersion *version);

mfxStatus MFXVideoCORE_SetHandle(mfxSession session, mfxHandleType type, mfxHDL hdl);
mfxStatus MFXVideoCORE_SyncOperation(mfxSession session, mfxSyncPoint syncp, mfxU32 wait);

mfxStatus MFXVideoDECODE_DecodeHeader(mfxSession session, mfxBitstream *bs, mfxVideoParam *par);
mfxStatus MFXVideoDECODE_QueryIOSurf(mfxSession session, mfxVideoParam *par, mfxFrameAllocRequest *request);
mfxStatus MFXVideoDECODE_Init(mfxSession session, mfxVideoParam *par);
mfxStatus MFXVideoDECODE_Close(mfxSession session);
mfxStatus MFXVideoDECODE_GetVideoParam(mfxSession session, mfxVideoParam *par);
mfxStatus MFXVideoDECODE_DecodeFrameAsync(mfxSession session, mfxBitstream *bs, mfxFrameSurface1 *surface_work, mfxFrameSurface1 **surface_out, mfxSyncPoint *syncp);

mfxStatus MFXVideoVPP_QueryIOSurf(mfxSession session, mfxVideoParam *par, mfxFrameAllocRequest request[2]);
mfxStatus MFXVideoVPP_Init(mfxSession session, mfxVideoParam *par);
mfxStatus MFXVideoVPP_Close(mfxSession session);
mfxStatus MFXVideoVPP_RunFrameVPPAsync(mfxSession session, mfxFrameSurface1 *in, mfxFrameSurface1 *out, mfxExtVppAuxData *aux, mfxSyncPoint *syncp);

#ifdef __cplusplus
}
#endif

#endif
