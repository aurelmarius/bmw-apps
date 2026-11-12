# Builds tvh-player inside ubuntu:18.04 (glibc 2.27, the head unit's): build.sh runs it.
# Everything it needs is in this folder (nothing read from another one): player.cpp, our copy of the MSDK decoder
# (src/decoder_msdk.cpp: display order, fit whole, the picture structure told), the NAL framing and the frame-file
# writer (src/nal_reader.cpp, src/mgvf.cpp), the MSDK headers and the export lists of the unit's libmfxhw64 / libva /
# libva-drm (abi/), whose stubs it links against (every import is checked, tools/). FFmpeg (libavformat's mpegts
# demuxer, libavcodec's aac, ac3 and eac3 decoders) static; libasound is opened at run time. The binary needs only
# the unit's glibc and asks for its loader.
OUT     ?= out
FFMPEG  ?= /w/build/ffmpeg
CXX     = g++
CC      = gcc
CXXFLAGS = -std=c++14 -O2 -g0 -Wall -Wno-missing-field-initializers -DNDEBUG -Isrc -Iabi/include -I$(FFMPEG)/include
OBJS    = $(OUT)/obj/player.o $(OUT)/obj/decoder_msdk.o $(OUT)/obj/nal_reader.o $(OUT)/obj/mgvf.o $(OUT)/obj/glibc_compat.o
STUBS   = $(OUT)/stub/libmfxhw64.so $(OUT)/stub/libva.so.1 $(OUT)/stub/libva-drm.so.1
# the head unit's loader is /lib/ld-linux-x86-64.so.2 (no /lib64)
LIBS    = $(FFMPEG)/lib/libavformat.a $(FFMPEG)/lib/libavcodec.a $(FFMPEG)/lib/libavutil.a -lpthread -ldl -lm \
          -Wl,--wrap=powf -Wl,--wrap=log2f \
          -static-libstdc++ -static-libgcc -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2

all: $(OUT)/tvh-player

$(OUT)/obj/player.o: src/player.cpp src/decoder_msdk.h src/mgvf.h
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@
$(OUT)/obj/decoder_msdk.o: src/decoder_msdk.cpp src/decoder_msdk.h src/nal_reader.h
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@
$(OUT)/obj/nal_reader.o: src/nal_reader.cpp src/nal_reader.h
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@
$(OUT)/obj/mgvf.o: src/mgvf.cpp src/mgvf.h
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@
$(OUT)/obj/glibc_compat.o: src/glibc_compat.c
	@mkdir -p $(@D)
	$(CC) -O2 -c $< -o $@

$(OUT)/stub/libmfxhw64.so: abi/libmfx.symbols
	@mkdir -p $(@D)
	python3 tools/ramses_abi.py stub-source $< > $(@D)/mfx_stub.c
	$(CC) -shared -Wl,-soname,libmfxhw64.so -o $@ $(@D)/mfx_stub.c
$(OUT)/stub/libva.so.1: abi/libva.symbols
	@mkdir -p $(@D)
	python3 tools/ramses_abi.py stub-source $< > $(@D)/va_stub.c
	$(CC) -shared -Wl,-soname,libva.so.1 -o $@ $(@D)/va_stub.c
$(OUT)/stub/libva-drm.so.1: abi/libva-drm.symbols
	@mkdir -p $(@D)
	python3 tools/ramses_abi.py stub-source $< > $(@D)/va_drm_stub.c
	$(CC) -shared -Wl,-soname,libva-drm.so.1 -o $@ $(@D)/va_drm_stub.c

$(OUT)/tvh-player: $(OBJS) $(STUBS)
	$(CXX) -o $@ $(OBJS) $(STUBS) $(LIBS)
	python3 tools/woc_abi.py check-imports $@ --prefix MFX va -- abi/libmfx.symbols abi/libva.symbols abi/libva-drm.symbols
	strip $@
