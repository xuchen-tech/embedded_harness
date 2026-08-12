#include "harness.h"
#include "json_util.h"

#include <pthread.h>
#include <string.h>

static harness_log_entry g_ring[HARNESS_LOG_RING_SIZE];
static int g_head;
static int g_count;
static pthread_mutex_t g_mutex = PTHREAD_MUTEX_INITIALIZER;

void log_ring_init(void) {
    pthread_mutex_lock(&g_mutex);
    g_head = 0;
    g_count = 0;
    memset(g_ring, 0, sizeof(g_ring));
    pthread_mutex_unlock(&g_mutex);
}

void log_ring_push(const harness_log_entry *entry) {
    if (!entry) {
        return;
    }
    pthread_mutex_lock(&g_mutex);
    int idx = (g_head + g_count) % HARNESS_LOG_RING_SIZE;
    if (g_count == HARNESS_LOG_RING_SIZE) {
        g_head = (g_head + 1) % HARNESS_LOG_RING_SIZE;
    } else {
        g_count++;
    }
    g_ring[idx] = *entry;
    pthread_mutex_unlock(&g_mutex);
}

static const char *source_name(harness_log_source src) {
    switch (src) {
        case LOG_SRC_SYSLOG:
            return "linux-syslog";
        case LOG_SRC_DMESG:
            return "linux-dmesg";
        case LOG_SRC_CUSTOM:
            return "linux-custom";
        case LOG_SRC_JOURNAL:
            return "linux-journal";
        default:
            return "unknown";
    }
}

int log_ring_pop_all(char *buf, size_t size) {
    size_t off = 0;
    pthread_mutex_lock(&g_mutex);
    json_append(buf, size, &off, "{\"protocolVersion\":%d,\"type\":\"logs\",\"payload\":{\"entries\":[",
                HARNESS_PROTOCOL_VERSION);

    for (int i = 0; i < g_count; i++) {
        int idx = (g_head + i) % HARNESS_LOG_RING_SIZE;
        harness_log_entry *e = &g_ring[idx];
        char esc[HARNESS_LOG_LINE_MAX * 2];
        json_escape(e->message, esc, sizeof(esc));

        if (i > 0) {
            json_append(buf, size, &off, ",");
        }
        json_append(buf, size, &off,
                    "{\"source\":\"%s\",\"customLogId\":\"%s\",\"timestamp\":%ld,"
                    "\"level\":\"%s\",\"message\":\"%s\"}",
                    source_name(e->source), e->custom_id, (long)e->timestamp * 1000L, e->level,
                    esc);
    }
    g_head = 0;
    g_count = 0;
    pthread_mutex_unlock(&g_mutex);

    json_append(buf, size, &off, "]}}");
    return (int)off;
}
