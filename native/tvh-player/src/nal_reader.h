// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* H.264 Annex-B byte stream to access units.
 *
 * NAL units are split at start codes (00 00 01, with or without a leading
 * zero byte; ITU-T H.264 Annex B). Trailing zero bytes are not part of a NAL
 * unit (its last byte is never 0x00), so they are dropped.
 *
 * Access units are framed by the first-NAL rule of H.264 7.4.1.2.3: once the
 * current access unit holds a slice, the next access unit starts at an access
 * unit delimiter (9), SPS (7), PPS (8), SEI (6), type 14..18, or a slice of
 * type 1, 2 or 5 whose first_mb_in_slice is 0. Any other NAL unit, including
 * further slices of the same picture, joins the current access unit. The
 * slice header's first_mb_in_slice and slice_type are read past emulation
 * prevention bytes.
 *
 * Input may be split anywhere, even inside a start code; the tail is kept
 * until the next push. Without end_of_au an access unit is delivered once the
 * first two bytes of the next one's first NAL unit have arrived; the last one
 * waits for flush(). */
#ifndef WOC_NAL_READER_H
#define WOC_NAL_READER_H

#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <vector>

namespace woc {

struct AccessUnit {
    const uint8_t *data;   /* each NAL unit behind a 00 00 00 01 start code */
    size_t size;
    bool sps;              /* holds a sequence parameter set */
    bool idr;              /* holds an IDR slice */
    bool b;                /* holds a B slice (slice_type 1 or 6) */
};

class NalReader {
public:
    /* Called once per complete access unit; `data` is valid only during the
     * call, and the sink must not call back into the reader. */
    using Sink = std::function<void(const AccessUnit &)>;

    /* end_of_au: the bytes end exactly at the end of an access unit (one
     * whole frame per push). The last NAL unit is then complete and the access
     * unit is delivered now. An access unit with no slice yet (SPS and PPS
     * sent on their own) is held and joins the next one. */
    void push(const uint8_t *data, size_t len, bool end_of_au, const Sink &sink);

    /* End of stream: the buffered tail is the last NAL unit. Delivers the last
     * access unit and empties the reader. */
    void flush(const Sink &sink);

    void reset();

private:
    void end_nal(const uint8_t *nal, size_t len, const Sink &sink);
    void emit(const Sink &sink);

    std::vector<uint8_t> buf_;    /* the NAL unit in progress, or bytes before the first start code */
    size_t scan_ = 0;             /* first position of buf_ not yet ruled out as a start code */
    bool in_nal_ = false;         /* a start code has been seen; buf_ holds a NAL unit's bytes */

    std::vector<uint8_t> au_;     /* access unit being assembled */
    bool au_vcl_ = false, au_sps_ = false, au_idr_ = false, au_b_ = false;
};

}  // namespace woc

#endif
