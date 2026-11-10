// SPDX-License-Identifier: GPL-3.0-or-later
// From JustAnotherPU/moonride (GPL-3.0-or-later), native/mgu-moonlight/src/mgvf.cpp, commit a834a14; unchanged.
#include "mgvf.h"

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace ytdec {

bool Mgvf::open(const char *path, uint32_t w, uint32_t h, int nslot, std::string *err, std::string *warn)
{
    close();
    if (w % 2 || h % 2 || w < 16 || h < 16 || w > 2048 || h > 2048) {
        *err = "frame size must be even, 16..2048";
        return false;
    }
    if ((size_t)w * h * 3 > kMgvfAppLimit) {
        *err = "frame size over the renderer's 12 MiB per-app video limit";
        return false;
    }
    if (nslot < 1 || nslot > 4) {
        *err = "nslot must be 1..4";
        return false;
    }
    /* No link following: a planted symlink would make root write elsewhere. */
    int fd = ::open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) {
        *err = std::string("open ") + path + ": " + strerror(errno);
        return false;
    }
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
        ::close(fd);
        *err = std::string(path) + " is not a regular file";
        return false;
    }
    const struct passwd *pw = getpwnam("nobody");
    const uid_t nobody = pw ? pw->pw_uid : 65534;
    const gid_t nogroup = pw ? pw->pw_gid : 65534;
    if (st.st_uid != nobody && fchown(fd, nobody, nogroup) != 0)
        *warn = std::string("fchown nobody: ") + strerror(errno) + " (the file stays ours)";
    fchmod(fd, 0600);
    const size_t len = sizeof(MgvfHead) + (size_t)nslot * w * h * 3 / 2;
    if (ftruncate(fd, 0) != 0 || ftruncate(fd, (off_t)len) != 0) {
        *err = std::string("ftruncate: ") + strerror(errno);
        ::close(fd);
        return false;
    }
    void *p = mmap(nullptr, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    ::close(fd);
    if (p == MAP_FAILED) {
        *err = std::string("mmap: ") + strerror(errno);
        return false;
    }
    head_ = (MgvfHead *)p;
    len_ = len;
    w_ = w, h_ = h;
    uint8_t *frames = (uint8_t *)p + sizeof(MgvfHead);
    for (int i = 0; i < nslot; i++) {
        uint8_t *f = frames + (size_t)i * frame_size();
        memset(f, 16, (size_t)w * h);
        memset(f + (size_t)w * h, 128, (size_t)w * h / 2);
    }
    MgvfHead hd;
    memset(&hd, 0, sizeof hd);
    hd.version = 1, hd.w = w, hd.h = h, hd.nslot = (uint32_t)nslot;
    hd.matrix = 1;   /* BT.709 */
    hd.full = 0;     /* limited range */
    memcpy(head_, &hd, sizeof hd);
    __atomic_store_n(&head_->magic, kMgvfMagic, __ATOMIC_RELEASE);
    return true;
}

uint8_t *Mgvf::begin()
{
    const uint32_t next = (head_->slot + 1) % head_->nslot;
    return (uint8_t *)head_ + sizeof(MgvfHead) + (size_t)next * frame_size();
}

void Mgvf::commit()
{
    const uint32_t next = (head_->slot + 1) % head_->nslot;
    __atomic_store_n(&head_->slot, next, __ATOMIC_RELEASE);
    __atomic_store_n(&head_->seq, head_->seq + 1, __ATOMIC_RELEASE);
}

void Mgvf::close()
{
    if (head_)
        munmap(head_, len_);
    head_ = nullptr;
}

void nv12_to_i420(const uint8_t *y, const uint8_t *uv, size_t pitch, uint32_t w, uint32_t h, uint8_t *dst)
{
    for (uint32_t r = 0; r < h; r++)
        memcpy(dst + (size_t)r * w, y + r * pitch, w);
    uint8_t *u = dst + (size_t)w * h, *v = u + (size_t)w * h / 4;
    const uint32_t cw = w / 2;
    for (uint32_t r = 0; r < h / 2; r++) {
        const uint8_t *s = uv + r * pitch;
        uint8_t *du = u + (size_t)r * cw, *dv = v + (size_t)r * cw;
        for (uint32_t c = 0; c < cw; c++) {
            du[c] = s[2 * c];
            dv[c] = s[2 * c + 1];
        }
    }
}

}  // namespace ytdec
