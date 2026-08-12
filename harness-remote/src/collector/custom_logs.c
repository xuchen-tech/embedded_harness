#include "harness.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define CUSTOM_THREADS_MAX HARNESS_CUSTOM_LOGS_MAX

typedef struct {
    char id[64];
    char path[512];
    volatile int running;
    pthread_t thread;
} custom_watch;

static custom_watch g_watches[CUSTOM_THREADS_MAX];
static int g_watch_count;

static void push_custom_line(const char *id, const char *line) {
    harness_log_entry entry;
    memset(&entry, 0, sizeof(entry));
    entry.source = LOG_SRC_CUSTOM;
    entry.timestamp = time(NULL);
    strncpy(entry.custom_id, id, sizeof(entry.custom_id) - 1);
    strncpy(entry.level, "INFO", sizeof(entry.level) - 1);

    if (strstr(line, "error") || strstr(line, "ERROR")) {
        strncpy(entry.level, "ERROR", sizeof(entry.level) - 1);
    } else if (strstr(line, "warn") || strstr(line, "WARN")) {
        strncpy(entry.level, "WARN", sizeof(entry.level) - 1);
    }

    size_t len = strlen(line);
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
        len--;
    }
    if (len >= sizeof(entry.message)) {
        len = sizeof(entry.message) - 1;
    }
    memcpy(entry.message, line, len);
    entry.message[len] = '\0';
    log_ring_push(&entry);
}

static void *custom_thread(void *arg) {
    custom_watch *w = arg;
    char cmd[640];
    snprintf(cmd, sizeof(cmd), "tail -n 0 -F %s 2>/dev/null", w->path);

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        return NULL;
    }

    char line[HARNESS_LOG_LINE_MAX];
    while (w->running && fgets(line, sizeof(line), fp)) {
        push_custom_line(w->id, line);
    }
    pclose(fp);
    return NULL;
}

int custom_logs_collector_start(const harness_config *cfg) {
    if (!cfg) {
        return -1;
    }
    custom_logs_collector_stop();

    for (int i = 0; i < cfg->count && g_watch_count < CUSTOM_THREADS_MAX; i++) {
        custom_watch *w = &g_watches[g_watch_count++];
        memset(w, 0, sizeof(*w));
        strncpy(w->id, cfg->paths[i].id, sizeof(w->id) - 1);
        strncpy(w->path, cfg->paths[i].path, sizeof(w->path) - 1);
        w->running = 1;
        pthread_create(&w->thread, NULL, custom_thread, w);
    }
    return g_watch_count;
}

void custom_logs_collector_stop(void) {
    for (int i = 0; i < g_watch_count; i++) {
        g_watches[i].running = 0;
        pthread_cancel(g_watches[i].thread);
        pthread_join(g_watches[i].thread, NULL);
    }
    g_watch_count = 0;
}
