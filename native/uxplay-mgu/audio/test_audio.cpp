// SPDX-License-Identifier: GPL-3.0-or-later
/* test_audio: mgu_audio.cpp off the car. `test_audio CT PACKETS OUT.wav` plays length-prefixed (u32 LE) packets of
 * compression type CT into OUT.wav (MGU_AUDIO=wav:...), the second half at volume 0.5; `test_audio open CT` only
 * opens the decoder (AAC-ELD has no free encoder to make packets with). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include "mgu_audio.h"

int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "open")) {
        setenv("MGU_AUDIO", "null", 1);
        int rc = mgu_audio_start(atoi(argv[2]));
        printf("open %s: %s\n", argv[2], rc == 0 ? "ok" : mgu_audio_error());
        mgu_audio_stop();
        return rc == 0 ? 0 : 1;
    }
    if (argc != 4) return 2;
    std::string out = std::string("wav:") + argv[3];
    setenv("MGU_AUDIO", out.c_str(), 1);
    if (mgu_audio_start(atoi(argv[1])) != 0) { fprintf(stderr, "start: %s\n", mgu_audio_error()); return 1; }
    FILE *f = fopen(argv[2], "rb");
    if (!f) return 1;
    std::vector<std::vector<unsigned char>> pk;
    unsigned len;
    while (fread(&len, 4, 1, f) == 1) { std::vector<unsigned char> b(len); if (fread(b.data(), 1, len, f) != len) break; pk.push_back(b); }
    fclose(f);
    for (size_t i = 0; i < pk.size(); i++) {
        if (i == pk.size() / 2) mgu_audio_volume(0.5);
        mgu_audio_packet(pk[i].data(), (int) pk[i].size());
    }
    mgu_audio_stats_t s;
    mgu_audio_stats(&s);
    printf("packets %llu decoded %llu errors %llu\n", s.packets, s.decoded, s.errors);
    mgu_audio_stop();
    return 0;
}
