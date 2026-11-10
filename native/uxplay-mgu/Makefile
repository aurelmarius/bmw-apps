# Builds uxplay-mgu inside ubuntu:18.04 (glibc 2.27, the head unit's): build.sh runs it.
# UxPlay's protocol library (lib/) and uxplay.cpp, with renderer/mgu_renderer.c in place of the GStreamer
# renderers. OpenSSL, libplist, GLib and PCRE are linked statically, libstdc++ and libgcc too: the binary
# needs only the unit's glibc. libplist 2.6 comes from its release (build.sh), not 18.04's 2.0.
SRC     ?= src
OUT     ?= out
CC      = gcc
CXX     = g++
DEFS    = -DSTANDALONE -D__STDC_CONSTANT_MACROS -D__STDC_LIMIT_MACROS -DTARGET_POSIX -D_LINUX -D_REENTRANT \
          -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 -DNOHOLD -DOPENSSL_API_COMPAT=0x10101000L \
          -DNEED_G_STRING_REPLACE -DFULL_RANGE_RGB_FIX -DPLIST_210 -DPLIST_230
GLIB_CFLAGS := $(shell pkg-config --cflags glib-2.0)
PLIST   ?= /usr
PLIST_CFLAGS := -I$(PLIST)/include
INC     = -I$(SRC) -I$(SRC)/lib -I$(SRC)/lib/playfair -I$(SRC)/lib/llhttp -I$(SRC)/lib/mdnsd $(GLIB_CFLAGS) $(PLIST_CFLAGS)
CFLAGS  = -O2 -g0 -fPIC -Wall -Wno-unused-function -std=gnu99 $(DEFS) $(INC)
CXXFLAGS= -O2 -g0 -Wall -std=gnu++11 $(DEFS) $(INC)

C_SRCS  = $(wildcard $(SRC)/lib/*.c) $(wildcard $(SRC)/lib/playfair/*.c) $(wildcard $(SRC)/lib/llhttp/*.c) \
          $(wildcard $(SRC)/lib/mdnsd/*.c) renderer/mgu_renderer.c
C_OBJS  = $(patsubst %.c,$(OUT)/obj/%.o,$(notdir $(C_SRCS)))

# stage 2: the GPU decoder (video/: Moonride's copy of waze-on-cluster's MSDK decoder, its frame file writer), linked
# against stubs of the unit's libmfxhw64 / libva / libva-drm made from their export lists; every import is checked
VIDEO_SRCS = video/src/decoder_msdk.cpp video/src/nal_reader.cpp video/src/mgvf.cpp video/src/mgu_video.cpp
VIDEO_OBJS = $(patsubst %.cpp,$(OUT)/obj/v_%.o,$(notdir $(VIDEO_SRCS)))
VIDEO_CXXFLAGS = -std=c++14 -O2 -g0 -Wall -Wno-missing-field-initializers -DNDEBUG -Ivideo/src -Ivideo/abi/include
STUBS   = $(OUT)/stub/libmfxhw64.so $(OUT)/stub/libva.so.1 $(OUT)/stub/libva-drm.so.1

# stage 3: the sound (audio/mgu_audio.cpp) with libavcodec's aac and alac decoders, FFmpeg built minimal and static
# by build.sh (FFMPEG); libasound is opened at run time
FFMPEG  ?= /w/build/ffmpeg
AUDIO_OBJS = $(OUT)/obj/a_mgu_audio.o
# stage 4: the player (player/mgu_hls.cpp) with libavformat (hls, mpegts, mp4 over http/https through OpenSSL)
PLAYER_OBJS = $(OUT)/obj/p_mgu_hls.o
FFLIBS  = $(FFMPEG)/lib/libavformat.a $(FFMPEG)/lib/libavcodec.a $(FFMPEG)/lib/libavutil.a

STATIC  = -Wl,-Bstatic -L$(PLIST)/lib -lplist-2.0 -lglib-2.0 -lpcre -lssl -lcrypto -Wl,-Bdynamic
# the head unit's loader is /lib/ld-linux-x86-64.so.2 (no /lib64: a binary asking for /lib64/... fails to start, ENOENT)
LIBS    = $(STATIC) -lpthread -ldl -lm -static-libstdc++ -static-libgcc -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2

vpath %.c $(SRC)/lib $(SRC)/lib/playfair $(SRC)/lib/llhttp $(SRC)/lib/mdnsd renderer

all: $(OUT)/uxplay-mgu

$(OUT)/obj/%.o: %.c
	@mkdir -p $(OUT)/obj
	$(CC) $(CFLAGS) -c $< -o $@

$(OUT)/obj/mgu_renderer.o: renderer/mgu_renderer.c video/src/mgu_video.h audio/mgu_audio.h player/mgu_hls.h
	@mkdir -p $(OUT)/obj
	$(CC) $(CFLAGS) -I$(SRC)/renderers -Ivideo/src -Iaudio -Iplayer -c $< -o $@

$(OUT)/obj/p_mgu_hls.o: player/mgu_hls.cpp player/mgu_hls.h audio/mgu_audio.h video/src/mgu_video.h $(FFMPEG)/.conf
	@mkdir -p $(OUT)/obj
	$(CXX) -std=c++14 -O2 -g0 -Wall -DNDEBUG -Iplayer -Iaudio -Ivideo/src -I$(FFMPEG)/include -c $< -o $@

$(OUT)/obj/a_mgu_audio.o: audio/mgu_audio.cpp audio/mgu_audio.h $(FFMPEG)/.conf
	@mkdir -p $(OUT)/obj
	$(CXX) -std=c++14 -O2 -g0 -Wall -DNDEBUG -Iaudio -I$(FFMPEG)/include -c $< -o $@

$(OUT)/obj/v_%.o: video/src/%.cpp
	@mkdir -p $(OUT)/obj
	$(CXX) $(VIDEO_CXXFLAGS) -c $< -o $@

$(OUT)/stub/libmfxhw64.so: video/abi/libmfx.symbols
	@mkdir -p $(@D)
	python3 video/tools/ramses_abi.py stub-source $< > $(@D)/mfx_stub.c
	$(CC) -shared -Wl,-soname,libmfxhw64.so -o $@ $(@D)/mfx_stub.c
$(OUT)/stub/libva.so.1: video/abi/libva.symbols
	@mkdir -p $(@D)
	python3 video/tools/ramses_abi.py stub-source $< > $(@D)/va_stub.c
	$(CC) -shared -Wl,-soname,libva.so.1 -o $@ $(@D)/va_stub.c
$(OUT)/stub/libva-drm.so.1: video/abi/libva-drm.symbols
	@mkdir -p $(@D)
	python3 video/tools/ramses_abi.py stub-source $< > $(@D)/va_drm_stub.c
	$(CC) -shared -Wl,-soname,libva-drm.so.1 -o $@ $(@D)/va_drm_stub.c

$(OUT)/obj/uxplay.o: $(SRC)/uxplay.cpp
	@mkdir -p $(OUT)/obj
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(OUT)/uxplay-mgu: $(C_OBJS) $(VIDEO_OBJS) $(AUDIO_OBJS) $(PLAYER_OBJS) $(OUT)/obj/uxplay.o $(STUBS) $(FFLIBS)
	$(CXX) -o $@ $(OUT)/obj/uxplay.o $(C_OBJS) $(VIDEO_OBJS) $(AUDIO_OBJS) $(PLAYER_OBJS) $(STUBS) $(FFLIBS) $(LIBS)
	python3 video/tools/woc_abi.py check-imports $@ --prefix MFX va -- video/abi/libmfx.symbols video/abi/libva.symbols video/abi/libva-drm.symbols
	strip $@

# the stage 4 player off the car (tests): tools/test_hls.sh
$(OUT)/test_hls: player/test_hls.cpp $(PLAYER_OBJS) $(VIDEO_OBJS) $(AUDIO_OBJS) $(STUBS) $(FFLIBS)
	$(CXX) -std=c++14 -O2 -Iplayer -o $@ player/test_hls.cpp $(PLAYER_OBJS) $(VIDEO_OBJS) $(AUDIO_OBJS) $(STUBS) $(FFLIBS) $(LIBS)
