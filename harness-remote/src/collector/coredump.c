#include "harness.h"

#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/select.h>
#include <unistd.h>

static pthread_t g_watch_thread;
static volatile int g_running;
static char g_watch_dir[256];

static void push_core_file_event(const char *path, const char *source) {
    harness_coredump_event ev;
    memset(&ev, 0, sizeof(ev));
    strncpy(ev.source, source, sizeof(ev.source) - 1);
    strncpy(ev.remote_path, path, sizeof(ev.remote_path) - 1);
    ev.detected_at = time(NULL);
    ev.signal = 11;
    event_ring_push(&ev);

    harness_log_entry log;
    memset(&log, 0, sizeof(log));
    log.source = LOG_SRC_SYSLOG;
    log.timestamp = ev.detected_at;
    strncpy(log.level, "ERROR", sizeof(log.level) - 1);
    snprintf(log.message, sizeof(log.message), "[coredump] new core file: %s", path);
    log_ring_push(&log);
}

static void resolve_watch_dir(void) {
    harness_core_dump_status st;
    probe_core_dump_status(&st);

    g_watch_dir[0] = '\0';
    if (st.pattern[0] == '|' || st.pattern[0] == '\0') {
        strncpy(g_watch_dir, "/var/lib/systemd/coredump", sizeof(g_watch_dir) - 1);
        if (access(g_watch_dir, R_OK) != 0) {
            strncpy(g_watch_dir, "/tmp", sizeof(g_watch_dir) - 1);
        }
        return;
    }

    strncpy(g_watch_dir, st.pattern, sizeof(g_watch_dir) - 1);
    char *slash = strrchr(g_watch_dir, '/');
    if (slash) {
        *slash = '\0';
    } else {
        strncpy(g_watch_dir, "/tmp", sizeof(g_watch_dir) - 1);
    }
}

static void poll_coredumpctl(void) {
    harness_capabilities caps;
    probe_capabilities(&caps);
    if (!caps.has_coredumpctl) {
        return;
    }

    FILE *fp = popen("coredumpctl list --no-pager -n 5 2>/dev/null", "r");
    if (!fp) {
        return;
    }

    char line[512];
    int header = 1;
    while (fgets(line, sizeof(line), fp)) {
        if (header) {
            if (strstr(line, "PID") || strstr(line, "TIME")) {
                header = 0;
            }
            continue;
        }
        if (strstr(line, ".") || strstr(line, "present")) {
            push_core_file_event(line, "coredumpctl");
        }
    }
    pclose(fp);
}

static void *watch_thread(void *arg) {
    (void)arg;
    resolve_watch_dir();

    int fd = inotify_init();
    if (fd < 0) {
        while (g_running) {
            poll_coredumpctl();
            sleep(5);
        }
        return NULL;
    }

    int wd = inotify_add_watch(fd, g_watch_dir, IN_CREATE | IN_MOVED_TO | IN_CLOSE_WRITE);
    if (wd < 0) {
        close(fd);
        while (g_running) {
            poll_coredumpctl();
            sleep(5);
        }
        return NULL;
    }

    char buf[4096];
    while (g_running) {
        struct timeval tv = {.tv_sec = 5, .tv_usec = 0};
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(fd, &rfds);
        int ret = select(fd + 1, &rfds, NULL, NULL, &tv);
        if (ret > 0) {
            ssize_t len = read(fd, buf, sizeof(buf));
            if (len > 0) {
                char cmd[512];
                snprintf(cmd, sizeof(cmd), "find %s -maxdepth 1 -name 'core*' -mmin -1 2>/dev/null",
                         g_watch_dir);
                FILE *fp = popen(cmd, "r");
                if (fp) {
                    char path[512];
                    while (fgets(path, sizeof(path), fp)) {
                        size_t n = strlen(path);
                        while (n > 0 && path[n - 1] == '\n') {
                            path[--n] = '\0';
                        }
                        if (n > 0) {
                            push_core_file_event(path, "filesystem");
                        }
                    }
                    pclose(fp);
                }
            }
        }
        poll_coredumpctl();
    }

    inotify_rm_watch(fd, wd);
    close(fd);
    return NULL;
}

int coredump_collector_start(void) {
    g_running = 1;
    if (pthread_create(&g_watch_thread, NULL, watch_thread, NULL) != 0) {
        g_running = 0;
        return -1;
    }
    return 0;
}

void coredump_collector_stop(void) {
    if (!g_running) {
        return;
    }
    g_running = 0;
    pthread_cancel(g_watch_thread);
    pthread_join(g_watch_thread, NULL);
}
