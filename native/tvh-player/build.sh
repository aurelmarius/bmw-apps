#!/bin/sh
# Builds build/tvh-player for the head unit, in ubuntu:18.04 (glibc 2.27, as the unit). Needs git, python3 and
# Docker. FFmpeg n6.1.2 (the same pinned commit as the other players), configured with only what a channel from a
# Tvheadend transcoding profile needs: the mpegts demuxer, the h264 / aac / ac3 parsers, the aac, ac3 and eac3
# decoders, and the DVB subtitle decoder. Everything else is in this folder: nothing is read from another player's.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work="$here/build"
mkdir -p "$work"
ff_rev=b1a4534186ca51b0457579fc05a5739eb2cc45cd
if [ "$(git -C "$work/ffmpeg-src" rev-parse HEAD 2>/dev/null)" != "$ff_rev" ]; then
    rm -rf "$work/ffmpeg-src"
    git clone -q --depth 1 --branch n6.1.2 https://github.com/FFmpeg/FFmpeg "$work/ffmpeg-src"
    [ "$(git -C "$work/ffmpeg-src" rev-parse HEAD)" = "$ff_rev" ] || { echo "build.sh: FFmpeg n6.1.2 is not $ff_rev" >&2; exit 1; }
fi
# only this folder is mounted: the build needs nothing outside it
docker run --rm -v "$here:/n/tvh-player" -w /n/tvh-player ubuntu:18.04 sh -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends build-essential python3 python3-pyelftools >/dev/null
    # rebuilt when the configuration below changes (the DVB subtitle decoder came in 0.1.6)
    if [ ! -f build/ffmpeg/lib/libavformat.a ] || [ "$(cat build/ffmpeg/.flags 2>/dev/null)" != "dvbsub-1" ]; then
        rm -rf build/ffmpeg-bld && cp -r build/ffmpeg-src build/ffmpeg-bld
        (cd build/ffmpeg-bld && ./configure --prefix=/n/tvh-player/build/ffmpeg --disable-everything --disable-programs --disable-doc \
            --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample --disable-postproc \
            --disable-network --disable-x86asm --disable-autodetect --disable-iconv \
            --enable-avformat --enable-demuxer=mpegts --enable-parser=h264 --enable-parser=aac --enable-parser=ac3 \
            --enable-decoder=aac --enable-decoder=ac3 --enable-decoder=eac3 \
            --enable-decoder=dvbsub --enable-parser=dvbsub \
            --enable-static --disable-shared --enable-pic >/dev/null && make -s -j"$(nproc)" >/dev/null 2>&1 && make -s install >/dev/null) && echo dvbsub-1 > build/ffmpeg/.flags
    fi
    make -s OUT=build/out FFMPEG=/n/tvh-player/build/ffmpeg -j"$(nproc)"
    chown -R '"$(id -u):$(id -g)"' build
'
# the unit has only /lib/ld-linux-x86-64.so.2 (no /lib64): refuse a binary that asks for another loader
interp=$(readelf -l "$work/out/tvh-player" | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
[ "$interp" = "/lib/ld-linux-x86-64.so.2" ] || { echo "build.sh: interpreter is '$interp', not /lib/ld-linux-x86-64.so.2" >&2; exit 1; }
# glibc 2.25 at most, as the other players
newest=$(objdump -T "$work/out/tvh-player" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
case "$newest" in GLIBC_2.2[6-9]*|GLIBC_2.[3-9]*) echo "build.sh: needs $newest" >&2; exit 1;; esac
# it starts on glibc 2.27 with the loader where the unit has it, and plays a stream there (video off, sound to null)
docker run --rm -v "$here:/w" ubuntu:18.04 sh -c 'ln -sf /lib/x86_64-linux-gnu/ld-2.27.so /lib/ld-linux-x86-64.so.2 && head -c 0 /dev/null | MGU_VIDEO_OFF=1 MGU_AUDIO=null LD_LIBRARY_PATH=/w/build/out/stub /w/build/out/tvh-player 2>&1 | head -1' | grep -q '"ev":"error"' \
    || { echo "build.sh: tvh-player does not start in ubuntu:18.04 with /lib/ld-linux-x86-64.so.2" >&2; exit 1; }
cp "$work/out/tvh-player" "$work/tvh-player"
cp "$work/ffmpeg-src/COPYING.LGPLv2.1" "$work/FFMPEG-LICENSE"
# link-only stubs of the unit's video libraries: lets the binary start on a PC (tests); never shipped
rm -rf "$work/stub" && cp -r "$work/out/stub" "$work/stub"
ls -l "$work/tvh-player"
