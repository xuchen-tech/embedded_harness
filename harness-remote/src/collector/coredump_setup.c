#include "harness.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int file_exists(const char *path) {
    return access(path, R_OK) == 0;
}

static int dir_writable(const char *path) {
    return access(path, W_OK) == 0;
}

static void read_core_pattern(char *out, size_t out_size) {
    FILE *f = fopen("/proc/sys/kernel/core_pattern", "r");
    if (!f) {
        out[0] = '\0';
        return;
    }
    if (!fgets(out, (int)out_size, f)) {
        out[0] = '\0';
    } else {
        size_t n = strlen(out);
        while (n > 0 && (out[n - 1] == '\n' || out[n - 1] == '\r')) {
            out[--n] = '\0';
        }
    }
    fclose(f);
}

static void read_ulimit_core(char *out, size_t out_size) {
    FILE *fp = popen("ulimit -c 2>/dev/null", "r");
    if (!fp) {
        snprintf(out, out_size, "0");
        return;
    }
    if (!fgets(out, (int)out_size, fp)) {
        snprintf(out, out_size, "0");
    } else {
        size_t n = strlen(out);
        while (n > 0 && (out[n - 1] == '\n' || out[n - 1] == '\r')) {
            out[--n] = '\0';
        }
    }
    pclose(fp);
}

int probe_core_dump_status(harness_core_dump_status *out) {
    if (!out) {
        return -1;
    }
    memset(out, 0, sizeof(*out));

    read_ulimit_core(out->ulimit_core, sizeof(out->ulimit_core));
    read_core_pattern(out->pattern, sizeof(out->pattern));

    int ulimit_ok = (strcmp(out->ulimit_core, "0") != 0);
    int pattern_ok = out->pattern[0] != '\0';
    int uses_systemd = strstr(out->pattern, "systemd-coredump") != NULL;

    if (uses_systemd) {
        strncpy(out->recommended_setup, "systemd-coredump", sizeof(out->recommended_setup) - 1);
        out->enabled = 1;
    } else if (ulimit_ok && pattern_ok && out->pattern[0] != '|') {
        strncpy(out->recommended_setup, "ulimit-pattern", sizeof(out->recommended_setup) - 1);
        /* Check directory from simple /path/%e pattern */
        char dir[256];
        strncpy(dir, out->pattern, sizeof(dir) - 1);
        char *slash = strrchr(dir, '/');
        if (slash) {
            *slash = '\0';
            out->storage_writable = dir_writable(dir);
        } else {
            out->storage_writable = dir_writable("/tmp");
        }
        out->enabled = out->storage_writable;
    } else {
        strncpy(out->recommended_setup, "unknown", sizeof(out->recommended_setup) - 1);
        out->enabled = 0;
    }

    return 0;
}

int core_dump_status_to_json(const harness_core_dump_status *s, char *buf, size_t size) {
    if (!s || !buf) {
        return -1;
    }
    char esc_pattern[HARNESS_CORE_PATTERN_MAX * 2];
    json_escape(s->pattern, esc_pattern, sizeof(esc_pattern));
    size_t off = 0;
    json_append(buf, size, &off,
                "{\"protocolVersion\":%d,\"type\":\"coredump-status\",\"payload\":{"
                "\"enabled\":%s,\"ulimitCore\":\"%s\",\"pattern\":\"%s\","
                "\"storageWritable\":%s,\"recommendedSetup\":\"%s\"}}",
                HARNESS_PROTOCOL_VERSION, s->enabled ? "true" : "false", s->ulimit_core,
                esc_pattern, s->storage_writable ? "true" : "false", s->recommended_setup);
    return (int)off;
}
