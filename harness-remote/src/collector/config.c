#include "harness.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void home_config_path(char *buf, size_t size) {
    const char *home = getenv("HOME");
    if (!home) {
        buf[0] = '\0';
        return;
    }
    snprintf(buf, size, "%s/.config/harness-remote/config.json", home);
}

static FILE *open_config(const char *path) {
    if (!path || !path[0]) {
        return NULL;
    }
    return fopen(path, "r");
}

int config_load(harness_config *cfg, const char *path) {
    if (!cfg) {
        return -1;
    }
    memset(cfg, 0, sizeof(*cfg));

    char home_path[512];
    home_config_path(home_path, sizeof(home_path));

    const char *env_path = getenv("HARNESS_CONFIG");
    FILE *f = NULL;
    if (path) {
        f = open_config(path);
    }
    if (!f && env_path) {
        f = open_config(env_path);
    }
    if (!f) {
        f = open_config("/etc/harness-remote/config.json");
    }
    if (!f && home_path[0]) {
        f = open_config(home_path);
    }
    if (!f) {
        return 0; /* no config is OK */
    }

    char line[768];
    while (fgets(line, sizeof(line), f)) {
        char trimmed[768];
        strncpy(trimmed, line, sizeof(trimmed) - 1);
        trimmed[sizeof(trimmed) - 1] = '\0';
        /* trim leading/trailing whitespace */
        char *start = trimmed;
        while (*start && (*start == ' ' || *start == '\t' || *start == '\r' || *start == '\n')) {
            start++;
        }
        if (!start[0] || start[0] == '#') {
            continue;
        }

        if (strncmp(start, "proc|", 5) == 0) {
            if (cfg->watched_count >= HARNESS_WATCHED_PROCS_MAX) {
                continue;
            }
            char match[HARNESS_WATCHED_MATCH_MAX], label[128];
            if (sscanf(start + 5, " %31[^|]|%127[^\n]", match, label) >= 1) {
                harness_watched_process *wp = &cfg->watched[cfg->watched_count++];
                strncpy(wp->match, match, sizeof(wp->match) - 1);
                if (label[0]) {
                    strncpy(wp->label, label, sizeof(wp->label) - 1);
                } else {
                    strncpy(wp->label, match, sizeof(wp->label) - 1);
                }
            }
            continue;
        }

        if (cfg->count >= HARNESS_CUSTOM_LOGS_MAX) {
            continue;
        }
        char id[64], logpath[512], label[128];
        const char *log_line = start;
        if (strncmp(start, "log|", 4) == 0) {
            log_line = start + 4;
        }
        if (sscanf(log_line, " %63[^|]|%511[^|]|%127[^\n]", id, logpath, label) >= 2) {
            harness_custom_log_path *p = &cfg->paths[cfg->count++];
            strncpy(p->id, id, sizeof(p->id) - 1);
            strncpy(p->path, logpath, sizeof(p->path) - 1);
            if (label[0]) {
                strncpy(p->label, label, sizeof(p->label) - 1);
            } else {
                strncpy(p->label, id, sizeof(p->label) - 1);
            }
        }
    }
    fclose(f);
    return cfg->count + cfg->watched_count;
}
