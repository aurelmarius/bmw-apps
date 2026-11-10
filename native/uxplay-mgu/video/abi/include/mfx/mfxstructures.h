// SPDX-License-Identifier: MIT
// Copyright (c) 2007-2019 Intel Corporation (abi/include/mfx/LICENSE)
/* Intel Media SDK 1.x API: structures and constants.
 *
 * Subset of Intel's mfxcommon.h and mfxstructures.h (MIT licence, Copyright
 * (c) 2007-2019 Intel Corporation); see mfxdefs.h. Intel's names are kept;
 * some fields and unions this decoder does not use are folded into reserved
 * arrays of the same size, which the decoder zeroes. Sizes and offsets are
 * those of Intel's headers on x86-64 Linux. */
#ifndef WOC_MFXSTRUCTURES_H
#define WOC_MFXSTRUCTURES_H

#include "mfxdefs.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MFX_MAKEFOURCC(A,B,C,D)    ((((int)A))+(((int)B)<<8)+(((int)C)<<16)+(((int)D)<<24))

typedef struct {
    mfxU32  BufferId;
    mfxU32  BufferSz;
} mfxExtBuffer;

typedef mfxI32 mfxIMPL;

enum {
    MFX_IMPL_SOFTWARE     = 0x0001,
    MFX_IMPL_HARDWARE     = 0x0002,
    MFX_IMPL_VIA_VAAPI    = 0x0400
};

typedef union {
    struct {
        mfxU16  Minor;
        mfxU16  Major;
    };
    mfxU32  Version;
} mfxVersion;

typedef struct {
    mfxU32  reserved[8];
    mfxU64  TimeStamp;
    mfxU8*  Data;
    mfxU32  DataOffset;
    mfxU32  DataLength;
    mfxU32  MaxLength;
    mfxU16  PicStruct;
    mfxU16  FrameType;
    mfxU16  DataFlag;
    mfxU16  reserved2;
} mfxBitstream;

typedef struct _mfxSyncPoint *mfxSyncPoint;

typedef struct {
    mfxU32  reserved[4];
    mfxU16  reserved4;
    mfxU16  BitDepthLuma;
    mfxU16  BitDepthChroma;
    mfxU16  Shift;
    mfxU16  FrameId[4];

    mfxU32  FourCC;
    mfxU16  Width;
    mfxU16  Height;
    mfxU16  CropX;
    mfxU16  CropY;
    mfxU16  CropW;
    mfxU16  CropH;

    mfxU32  FrameRateExtN;
    mfxU32  FrameRateExtD;
    mfxU16  reserved3;

    mfxU16  AspectRatioW;
    mfxU16  AspectRatioH;

    mfxU16  PicStruct;
    mfxU16  ChromaFormat;
    mfxU16  reserved2;
} mfxFrameInfo;

enum {
    MFX_FOURCC_NV12         = MFX_MAKEFOURCC('N','V','1','2'),
    MFX_FOURCC_RGB4         = MFX_MAKEFOURCC('R','G','B','4')    /* ARGB in that order, A channel is 8 MSBs */
};

enum {
    MFX_PICSTRUCT_PROGRESSIVE   = 0x01
};

enum {
    MFX_CHROMAFORMAT_YUV420     = 1,
    MFX_CHROMAFORMAT_YUV444     = 3
};

typedef struct {
    mfxU32      reserved[8];
    mfxU64      TimeStamp;
    mfxU32      FrameOrder;
    mfxU16      Locked;
    mfxU16      Pitch;

    /* colour planes */
    union {
        mfxU8   *Y;
        mfxU8   *R;
    };
    union {
        mfxU8   *UV;
        mfxU8   *G;
    };
    union {
        mfxU8   *V;
        mfxU8   *B;
    };
    mfxU8       *A;
    mfxMemId    MemId;

    mfxU16  Corrupted;
    mfxU16  DataFlag;
} mfxFrameData;

typedef struct {
    mfxU32  reserved[4];
    mfxFrameInfo    Info;
    mfxFrameData    Data;
} mfxFrameSurface1;

typedef struct {
    mfxU32  reserved[7];
    mfxU16  LowPower;
    mfxU16  BRCParamMultiplier;

    mfxFrameInfo    FrameInfo;
    mfxU32  CodecId;
    mfxU16  CodecProfile;
    mfxU16  CodecLevel;
    mfxU16  NumThread;

    /* Decoding options; Intel's header overlays encoding and JPEG options
     * of the same size here. */
    mfxU16  DecodedOrder;
    mfxU16  ExtendedPicStruct;
    mfxU16  TimeStampCalc;
    mfxU16  SliceGroupsPresent;
    mfxU16  reserved2[9];
} mfxInfoMFX;

typedef struct {
    mfxU32  reserved[8];
    mfxFrameInfo    In;
    mfxFrameInfo    Out;
} mfxInfoVPP;

typedef struct {
    mfxU32  reserved[3];
    mfxU16  reserved3;
    mfxU16  AsyncDepth;

    union {
        mfxInfoMFX  mfx;
        mfxInfoVPP  vpp;
    };
    mfxU16  Protected;
    mfxU16  IOPattern;
    mfxExtBuffer** ExtParam;
    mfxU16  NumExtParam;
    mfxU16  reserved2;
} mfxVideoParam;

enum {
    MFX_IOPATTERN_IN_VIDEO_MEMORY   = 0x01,
    MFX_IOPATTERN_IN_SYSTEM_MEMORY  = 0x02,
    MFX_IOPATTERN_IN_OPAQUE_MEMORY  = 0x04,
    MFX_IOPATTERN_OUT_VIDEO_MEMORY  = 0x10,
    MFX_IOPATTERN_OUT_SYSTEM_MEMORY = 0x20,
    MFX_IOPATTERN_OUT_OPAQUE_MEMORY = 0x40
};

enum {
    MFX_CODEC_AVC         = MFX_MAKEFOURCC('A','V','C',' ')
};

enum {
    MFX_BITSTREAM_COMPLETE_FRAME    = 0x0001   /* the bitstream contains a complete frame or field pair of data */
};

enum {
    MFX_EXTBUFF_OPAQUE_SURFACE_ALLOCATION = MFX_MAKEFOURCC('O','P','Q','S')
};

typedef struct {
    mfxU32  reserved[4];
    mfxFrameInfo    Info;
    mfxU16  Type;   /* decoder or processor render targets */
    mfxU16  NumFrameMin;
    mfxU16  NumFrameSuggested;
    mfxU16  reserved2;
} mfxFrameAllocRequest;

typedef enum {
    MFX_HANDLE_VA_DISPLAY = 4
} mfxHandleType;

typedef struct {
    mfxExtBuffer    Header;
    mfxU32      reserved1[2];
    struct {
        mfxFrameSurface1 **Surfaces;
        mfxU32  reserved2[5];
        mfxU16  Type;
        mfxU16  NumSurface;
    } In, Out;
} mfxExtOpaqueSurfaceAlloc;

typedef struct _mfxExtVppAuxData mfxExtVppAuxData;

#ifdef __cplusplus
}
#endif

#endif
