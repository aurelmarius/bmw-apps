// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "nal_reader.h"

namespace woc {

namespace {

/* Exp-Golomb reader over a NAL unit's payload that skips emulation
 * prevention bytes (a 03 after two zero bytes, H.264 7.4.1). */
struct Bits {
    const uint8_t *p, *end;
    int zeros = 0;      /* zero bytes just read */
    unsigned byte = 0;
    int left = 0;       /* unread bits of `byte` */

    Bits(const uint8_t *data, size_t len) : p(data), end(data + len) {}

    int bit()
    {
        if (left == 0) {
            if (p < end && zeros >= 2 && *p == 3) {
                p++;
                zeros = 0;
            }
            if (p >= end)
                return -1;
            byte = *p++;
            zeros = byte == 0 ? zeros + 1 : 0;
            left = 8;
        }
        return (byte >> --left) & 1;
    }

    bool ue(uint32_t *v)
    {
        int n = 0, b;
        while ((b = bit()) == 0)
            if (++n > 31)
                return false;
        if (b < 0)
            return false;
        uint64_t x = 0;
        for (int i = 0; i < n; i++) {
            if ((b = bit()) < 0)
                return false;
            x = x << 1 | (unsigned)b;
        }
        *v = (uint32_t)((1ull << n) - 1 + x);
        return true;
    }
};

/* Whether a NAL unit begins a new access unit once the current one holds a
 * slice. Its first two bytes decide it: for a slice, first_mb_in_slice is 0
 * when the bit after the header is 1 (ue(v) 0 is the single bit 1); that
 * byte is never an emulation prevention byte, which follows two zero bytes. */
bool first_of_au(const uint8_t *nal, size_t len)
{
    unsigned type = nal[0] & 0x1f;
    if (type == 6 || type == 7 || type == 8 || type == 9 || (type >= 14 && type <= 18))
        return true;
    if (type == 1 || type == 2 || type == 5)
        return len > 1 && (nal[1] & 0x80);
    return false;
}

}  // namespace

void NalReader::push(const uint8_t *data, size_t len, bool end_of_au, const Sink &sink)
{
    buf_.insert(buf_.end(), data, data + len);
    size_t nal_start = 0;   /* buf_ starts at the NAL unit in progress */
    size_t i = scan_;
    while (i + 3 <= buf_.size()) {
        uint8_t c = buf_[i + 2];
        if (c == 1 && buf_[i] == 0 && buf_[i + 1] == 0) {
            if (in_nal_)
                end_nal(buf_.data() + nal_start, i - nal_start, sink);
            in_nal_ = true;
            nal_start = i + 3;
            i += 3;
        } else if (c != 0) {
            /* A start code at i, i+1 or i+2 needs buf_[i+2] to be 1, 0, 0. */
            i += 3;
        } else {
            i += 1;
        }
    }

    if (end_of_au) {
        if (in_nal_)
            end_nal(buf_.data() + nal_start, buf_.size() - nal_start, sink);
        buf_.clear();
        scan_ = 0;
        in_nal_ = false;
        if (au_vcl_)
            emit(sink);
        return;
    }

    /* The previous access unit is complete as soon as the NAL unit in
     * progress is known to start the next one. */
    if (in_nal_ && au_vcl_ && buf_.size() - nal_start >= 2 && first_of_au(buf_.data() + nal_start, 2))
        emit(sink);

    /* Keep the NAL unit in progress; before the first start code only the
     * last two bytes, which may begin one. */
    size_t keep = in_nal_ ? nal_start : (buf_.size() > 2 ? buf_.size() - 2 : 0);
    buf_.erase(buf_.begin(), buf_.begin() + keep);
    scan_ = i - keep;
}

void NalReader::flush(const Sink &sink)
{
    if (in_nal_)
        end_nal(buf_.data(), buf_.size(), sink);
    if (au_vcl_)
        emit(sink);
    reset();
}

void NalReader::reset()
{
    buf_.clear();
    scan_ = 0;
    in_nal_ = false;
    au_.clear();
    au_vcl_ = au_sps_ = au_idr_ = au_b_ = false;
}

void NalReader::end_nal(const uint8_t *nal, size_t len, const Sink &sink)
{
    while (len > 0 && nal[len - 1] == 0)
        len--;
    if (len == 0)
        return;

    if (first_of_au(nal, len) && au_vcl_)
        emit(sink);

    unsigned type = nal[0] & 0x1f;
    bool b = false;
    if (type == 1 || type == 2 || type == 5) {
        /* The slice header starts with first_mb_in_slice and slice_type. */
        Bits bits(nal + 1, len - 1);
        uint32_t first_mb, slice_type;
        b = bits.ue(&first_mb) && bits.ue(&slice_type) && slice_type % 5 == 1;
    }

    static const uint8_t start_code[4] = {0, 0, 0, 1};
    au_.insert(au_.end(), start_code, start_code + 4);
    au_.insert(au_.end(), nal, nal + len);
    au_vcl_ = au_vcl_ || (type >= 1 && type <= 5);
    au_sps_ = au_sps_ || type == 7;
    au_idr_ = au_idr_ || type == 5;
    au_b_ = au_b_ || b;
}

void NalReader::emit(const Sink &sink)
{
    AccessUnit au = {au_.data(), au_.size(), au_sps_, au_idr_, au_b_};
    sink(au);
    au_.clear();
    au_vcl_ = au_sps_ = au_idr_ = au_b_ = false;
}

}  // namespace woc
