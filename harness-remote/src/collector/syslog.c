#include "harness.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pthread_t g_thread;
static volatile int g_running;
static char g_path[256];

static void push_line(const char *line) {
    harness_log_entry entry;
    memset(&entry, 0, sizeof(entry));
    entry.source = LOG_SRC_SYSLOG;
    entry.timestamp = time(NULL);
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

static void *syslog_thread(void *arg) {
    (void)arg;
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "tail -n 0 -F %s 2>/dev/null", g_path);

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        return NULL;
    }

    char line[HARNESS_LOG_LINE_MAX];
    while (g_running && fgets(line, sizeof(line), fp)) {
        push_line(line);
    }
    pclose(fp);
    return NULL;
}

int syslog_collector_start(void) {
    harness_capabilities caps;
    probe_capabilities(&caps);
    if (!caps.has_syslog || caps.syslog_path[0] == '\0') {
        return -1;
    }
    strncpy(g_path, caps.syslog_path, sizeof(g_path) - 1);
    g_running = 1;
    if (pthread_create(&g_thread, NULL, syslog_thread, NULL) != 0) {
        g_running = 0;
        return -1;
    }
    return 0;
}

void syslog_collector_stop(void) {
    if (!g_running) {
        return;
    }
    g_running = 0;
    pthread_cancel(g_thread);
    pthread_join(g_thread, NULL);
}
