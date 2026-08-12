#include "harness.h"

#include <stdio.h>
#include <string.h>

int collect_meminfo(harness_meminfo *out) {
    if (!out) {
        return -1;
    }
    memset(out, 0, sizeof(*out));
    FILE *f = fopen("/proc/meminfo", "r");
    if (!f) {
        return -1;
    }
    char key[64];
    long val;
    char unit[16];
    while (fscanf(f, "%63s %ld %15s", key, &val, unit) == 3) {
        if (strcmp(key, "MemTotal:") == 0) {
            out->total_kb = val;
        } else if (strcmp(key, "MemFree:") == 0) {
            out->free_kb = val;
        } else if (strcmp(key, "MemAvailable:") == 0) {
            out->available_kb = val;
        } else if (strcmp(key, "SwapTotal:") == 0) {
            out->swap_total_kb = val;
        } else if (strcmp(key, "SwapFree:") == 0) {
            out->swap_free_kb = val;
        }
    }
    fclose(f);
    if (out->available_kb == 0) {
        out->available_kb = out->free_kb;
    }
    return 0;
}
