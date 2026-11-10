// SPDX-License-Identifier: GPL-3.0-or-later
// From JustAnotherPU/moonride (GPL-3.0-or-later), native/mgu-moonlight/src/mgvf.h, commit a834a14; unchanged.
/* MGVF writer: mgu-render's video frame file (mgu-render PROTOCOL.md, "Video";
 * src/proto.h struct mgu_video_head). A 64-byte header, then nslot I420
 * frames of w*h*3/2 bytes. The writer fills slot (slot + 1) % nslot, then
 * stores slot, then seq + 1 (release), so the renderer never reads a frame
 * being written. The file is 0600 and owned by `nobody` (the renderer accepts
 * root, the app's uid or nobody). */
#ifndef YTDEC_MGVF_H
#define YTDEC_MGVF_H

#include <stddef.h>
#include <stdint.h>
#include <string>

namespace ytdec {

struct MgvfHead {
    uint32_t magic, version, w, h, seq, slot, nslot, matrix, full, pad[7];
};
static_assert(sizeof(MgvfHead) == 64, "MGVF header is 64 bytes");

const uint32_t kMgvfMagic = 0x4656474du;   /* "MGVF" */
const size_t kMgvfAppLimit = 12u << 20;   /* renderer: w*h*3 bytes per video, 12 MiB per app */

class Mgvf {
public:
    ~Mgvf() { close(); }
    /* Creates (or replaces) path for w x h frames, BT.709 limited range, all
     * slots black, seq 0. *warn gets a non-fatal note (fchown refused). */
    bool open(const char *path, uint32_t w, uint32_t h, int nslot, std::string *err, std::string *warn);
    /* Y plane of the next slot; U = Y + w*h, V = U + w*h/4. */
    uint8_t *begin();
    void commit();
    void close();
    uint32_t seq() const { return head_ ? head_->seq : 0; }
    uint32_t w() const { return w_; }
    uint32_t h() const { return h_; }
    size_t frame_size() const { return (size_t)w_ * h_ * 3 / 2; }

private:
    MgvfHead *head_ = nullptr;
    size_t len_ = 0;
    uint32_t w_ = 0, h_ = 0;
};

/* w x h NV12 (Y, then UV interleaved; both planes `pitch` bytes a row) to
 * dense I420 at dst. */
void nv12_to_i420(const uint8_t *y, const uint8_t *uv, size_t pitch, uint32_t w, uint32_t h, uint8_t *dst);

}  // namespace ytdec

#endif
