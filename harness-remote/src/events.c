#include "harness.h"
#include "json_util.h"

#include <pthread.h>
#include <string.h>

static harness_coredump_event g_events[HARNESS_EVENT_RING_SIZE];
static int g_event_head;
static int g_event_count;
static pthread_mutex_t g_event_mutex = PTHREAD_MUTEX_INITIALIZER;

void event_ring_init(void) {
    pthread_mutex_lock(&g_event_mutex);
    g_event_head = 0;
    g_event_count = 0;
    memset(g_events, 0, sizeof(g_events));
    pthread_mutex_unlock(&g_event_mutex);
}

void event_ring_push(const harness_coredump_event *event) {
    if (!event) {
        return;
    }
    pthread_mutex_lock(&g_event_mutex);
    int idx = (g_event_head + g_event_count) % HARNESS_EVENT_RING_SIZE;
    if (g_event_count == HARNESS_EVENT_RING_SIZE) {
        g_event_head = (g_event_head + 1) % HARNESS_EVENT_RING_SIZE;
    } else {
        g_event_count++;
    }
    g_events[idx] = *event;
    pthread_mutex_unlock(&g_event_mutex);
}

int event_ring_pop_all(char *buf, size_t size) {
    size_t off = 0;
    pthread_mutex_lock(&g_event_mutex);
    json_append(buf, size, &off,
                "{\"protocolVersion\":%d,\"type\":\"events\",\"payload\":{\"coredumps\":[",
                HARNESS_PROTOCOL_VERSION);

    for (int i = 0; i < g_event_count; i++) {
        int idx = (g_event_head + i) % HARNESS_EVENT_RING_SIZE;
        harness_coredump_event *e = &g_events[idx];
        char esc_path[512 * 2];
        char esc_exe[256 * 2];
        json_escape(e->remote_path, esc_path, sizeof(esc_path));
        json_escape(e->executable, esc_exe, sizeof(esc_exe));

        if (i > 0) {
            json_append(buf, size, &off, ",");
        }
        json_append(buf, size, &off,
                    "{\"source\":\"%s\",\"remotePath\":\"%s\",\"coredumpctlId\":\"%s\","
                    "\"pid\":%d,\"executable\":\"%s\",\"signal\":%d,\"detectedAt\":%ld000}",
                    e->source, esc_path, e->coredumpctl_id, e->pid, esc_exe, e->signal,
                    (long)e->detected_at);
    }
    g_event_head = 0;
    g_event_count = 0;
    pthread_mutex_unlock(&g_event_mutex);

    json_append(buf, size, &off, "]}}");
    return (int)off;
}
