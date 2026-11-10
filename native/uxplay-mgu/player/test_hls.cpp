// SPDX-License-Identifier: GPL-3.0-or-later
/* test_hls - the stage 4 player off the car: plays an address, prints its events, and follows a script of
 * commands (seconds after the start):  test_hls <url> [start_s] [cmd@t ...]   cmd: pause, resume, seek=<s>, stop
 * Run with MGU_VIDEO_OFF=1 (no GPU) and MGU_AUDIO=wav:<file> or null. Ends at the play's end or at "stop". */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <unistd.h>
#include <time.h>
#include "mgu_hls.h"

static double mono() { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static void out(const char *j) { printf("MGU %s\n", j); fflush(stdout); }

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "test_hls <url> [start_s] [cmd@t ...]\n"); return 2; }
    mgu_hls_set_emit(out);
    const double t0 = mono();
    mgu_hls_start(argv[1], argc > 2 ? atof(argv[2]) : 0);
    int next = 3;
    for (;;) {
        usleep(20000);
        const double t = mono() - t0;
        while (next < argc) {
            std::string c = argv[next];
            size_t at = c.find('@');
            if (at == std::string::npos || atof(c.c_str() + at + 1) > t) break;
            std::string cmd = c.substr(0, at);
            double dur, pos, ss, sd; float rate; int be, bf;
            mgu_hls_info(&dur, &pos, &ss, &sd, &rate, &be, &bf);
            printf("CMD %s at %.2f (pos %.2f rate %.0f)\n", cmd.c_str(), t, pos, rate); fflush(stdout);
            if (cmd == "pause") mgu_hls_pause(1);
            else if (cmd == "resume") mgu_hls_pause(0);
            else if (cmd.compare(0, 5, "seek=") == 0) mgu_hls_seek(atof(cmd.c_str() + 5));
            else if (cmd == "stop") { mgu_hls_stop(); return 0; }
            next++;
        }
        if (mgu_hls_eos()) {
            double dur, pos, ss, sd; float rate; int be, bf;
            const int on = mgu_hls_info(&dur, &pos, &ss, &sd, &rate, &be, &bf);
            printf("EOS at %.2f on=%d pos %.2f dur %.2f\n", mono() - t0, on, pos, dur); fflush(stdout);
            mgu_hls_stop();
            return 0;
        }
    }
}
