#include "harness.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pthread_t g_thread;
static volatile int g_running;

static void push_dmesg_line(const char *line) {
    harness_log_entry entry;
    memset(&entry, 0, sizeof(entry));
    entry.source = LOG_SRC_DMESG;
    entry.timestamp = time(NULL);
    strncpy(entry.level, "INFO", sizeof(entry.level) - 1);

    if (strstr(line, "error") || strstr(line, "Error") || strstr(line, "Oops") ||
        strstr(line, "BUG:")) {
        strncpy(entry.level, "ERROR", sizeof(entry.level) - 1);
    } else if (strstr(line, "warn") || strstr(line, "Warn")) {
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

static void *dmesg_thread(void *arg) {
    (void)arg;

    /* Seed: skip existing kernel buffer content on startup. */
    (void)system("dmesg >/dev/null 2>&1");

    while (g_running) {
        FILE *fp = popen("dmesg 2>/dev/null", "r");
        if (fp) {
            char line[HARNESS_LOG_LINE_MAX];
            while (g_running && fgets(line, sizeof(line), fp)) {
                push_dmesg_line(line);
            }
            pclose(fp);
        }
        sleep(5);
    }
    return NULL;
}

int dmesg_collector_start(void) {
    harness_capabilities caps;
    probe_capabilities(&caps);
    if (!caps.has_dmesg) {
        return -1;
    }
    g_running = 1;
    if (pthread_create(&g_thread, NULL, dmesg_thread, NULL) != 0) {
        g_running = 0;
        return -1;
    }
    return 0;
}

void dmesg_collector_stop(void) {
    if (!g_running) {
        return;
    }
    g_running = 0;
    pthread_cancel(g_thread);
    pthread_join(g_thread, NULL);
}
