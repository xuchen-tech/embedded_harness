#include "harness.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pthread_t g_thread;
static volatile int g_running;

void emit_journal_crash_event(const char *line) {
    harness_coredump_event ev;
    memset(&ev, 0, sizeof(ev));
    strncpy(ev.source, "journal-only", sizeof(ev.source) - 1);
    ev.detected_at = time(NULL);
    ev.signal = 11;

    const char *dumped = strstr(line, "code=dumped");
    const char *segv = strstr(line, "status=11/SEGV");
    if (dumped) {
        snprintf(ev.executable, sizeof(ev.executable), "%.255s", line);
    }
    if (segv) {
        ev.signal = 11;
    }

    /* Try extract pid=12345 from journal line */
    const char *pid_tag = strstr(line, "pid=");
    if (pid_tag) {
        ev.pid = atoi(pid_tag + 4);
    }

    event_ring_push(&ev);

    harness_log_entry log;
    memset(&log, 0, sizeof(log));
    log.source = LOG_SRC_JOURNAL;
    log.timestamp = ev.detected_at;
    strncpy(log.level, "ERROR", sizeof(log.level) - 1);
    snprintf(log.message, sizeof(log.message), "[crash] %s", line);
    log_ring_push(&log);
}

static void push_journal_line(const char *line) {
    harness_log_entry entry;
    memset(&entry, 0, sizeof(entry));
    entry.source = LOG_SRC_JOURNAL;
    entry.timestamp = time(NULL);
    strncpy(entry.level, "INFO", sizeof(entry.level) - 1);

    if (strstr(line, "code=dumped") || strstr(line, "segfault") || strstr(line, "SEGV") ||
        strstr(line, "Failed") || strstr(line, "failed")) {
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

    if (strstr(line, "code=dumped") || strstr(line, "Main process exited, code=dumped")) {
        emit_journal_crash_event(line);
    }
}

static void *journal_thread(void *arg) {
    (void)arg;
    FILE *fp = popen("journalctl -f -n 0 -o cat --no-pager 2>/dev/null", "r");
    if (!fp) {
        return NULL;
    }

    char line[HARNESS_LOG_LINE_MAX];
    while (g_running && fgets(line, sizeof(line), fp)) {
        push_journal_line(line);
    }
    pclose(fp);
    return NULL;
}

int journal_collector_start(void) {
    harness_capabilities caps;
    probe_capabilities(&caps);
    if (!caps.has_journal) {
        return -1;
    }
    g_running = 1;
    if (pthread_create(&g_thread, NULL, journal_thread, NULL) != 0) {
        g_running = 0;
        return -1;
    }
    return 0;
}

void journal_collector_stop(void) {
    if (!g_running) {
        return;
    }
    g_running = 0;
    pthread_cancel(g_thread);
    pthread_join(g_thread, NULL);
}
