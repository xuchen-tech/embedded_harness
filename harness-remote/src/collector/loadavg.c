#include "harness.h"

#include <stdio.h>

int collect_loadavg(harness_loadavg *out) {
    if (!out) {
        return -1;
    }
    FILE *f = fopen("/proc/loadavg", "r");
    if (!f) {
        return -1;
    }
    if (fscanf(f, "%lf %lf %lf", &out->load1, &out->load5, &out->load15) != 3) {
        fclose(f);
        return -1;
    }
    fclose(f);
    return 0;
}
