#include "harness.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static harness_config g_config;

static int handle_client(int fd) {
    char req[256];
    ssize_t n = read(fd, req, sizeof(req) - 1);
    if (n <= 0) {
        return -1;
    }
    req[n] = '\0';

    char out[65536];
    if (strncmp(req, "metrics", 7) == 0) {
        harness_metrics m;
        collect_metrics(&m, &g_config);
        metrics_to_json(&m, out, sizeof(out));
    } else if (strncmp(req, "capabilities", 12) == 0) {
        harness_capabilities c;
        probe_capabilities(&c);
        capabilities_to_json(&c, out, sizeof(out));
    } else if (strncmp(req, "coredump-status", 15) == 0) {
        harness_core_dump_status s;
        probe_core_dump_status(&s);
        core_dump_status_to_json(&s, out, sizeof(out));
    } else if (strncmp(req, "logs", 4) == 0) {
        log_ring_pop_all(out, sizeof(out));
    } else if (strncmp(req, "events", 6) == 0) {
        event_ring_pop_all(out, sizeof(out));
    } else if (strncmp(req, "heartbeat", 9) == 0) {
        snprintf(out, sizeof(out),
                 "{\"protocolVersion\":%d,\"type\":\"heartbeat\",\"payload\":{"
                 "\"status\":\"online\",\"version\":\"%s\"}}",
                 HARNESS_PROTOCOL_VERSION, HARNESS_VERSION);
    } else {
        snprintf(out, sizeof(out),
                 "{\"protocolVersion\":%d,\"type\":\"error\",\"payload\":{"
                 "\"message\":\"unknown command\"}}",
                 HARNESS_PROTOCOL_VERSION);
    }

    strncat(out, "\n", sizeof(out) - strlen(out) - 1);
    write(fd, out, strlen(out));
    return 0;
}

static int run_daemon(void) {
    log_ring_init();
    event_ring_init();
    config_load(&g_config, HARNESS_CONFIG_PATH);
    syslog_collector_start();
    journal_collector_start();
    dmesg_collector_start();
    custom_logs_collector_start(&g_config);
    coredump_collector_start();

    unlink(HARNESS_SOCKET_PATH);
    int server = socket(AF_UNIX, SOCK_STREAM, 0);
    if (server < 0) {
        return 1;
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, HARNESS_SOCKET_PATH, sizeof(addr.sun_path) - 1);

    if (bind(server, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(server);
        return 1;
    }
    chmod(HARNESS_SOCKET_PATH, 0666);
    listen(server, 8);

    while (1) {
        int client = accept(server, NULL, NULL);
        if (client < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        handle_client(client);
        close(client);
    }

    close(server);
    unlink(HARNESS_SOCKET_PATH);
    coredump_collector_stop();
    custom_logs_collector_stop();
    dmesg_collector_stop();
    journal_collector_stop();
    syslog_collector_stop();
    return 0;
}

static int worker(void *arg) {
    (void)arg;
    return run_daemon();
}

static void run_once(const char *cmd) {
    char out[65536];
    config_load(&g_config, NULL);
    if (strcmp(cmd, "metrics") == 0) {
        harness_metrics m;
        collect_metrics(&m, &g_config);
        metrics_to_json(&m, out, sizeof(out));
    } else if (strcmp(cmd, "capabilities") == 0 || strcmp(cmd, "probe") == 0) {
        harness_capabilities c;
        probe_capabilities(&c);
        capabilities_to_json(&c, out, sizeof(out));
    } else if (strcmp(cmd, "coredump-status") == 0) {
        harness_core_dump_status s;
        probe_core_dump_status(&s);
        core_dump_status_to_json(&s, out, sizeof(out));
    } else if (strcmp(cmd, "logs") == 0) {
        log_ring_init();
        log_ring_pop_all(out, sizeof(out));
    } else if (strcmp(cmd, "events") == 0) {
        event_ring_init();
        event_ring_pop_all(out, sizeof(out));
    } else {
        fprintf(stderr,
                "Usage: harness-remote [daemon|metrics|capabilities|coredump-status|logs|events|probe]\n");
        exit(1);
    }
    puts(out);
}

int main(int argc, char **argv) {
    const char *cmd = argc > 1 ? argv[1] : "daemon";
    if (strcmp(cmd, "daemon") == 0) {
        return watchdog_run(worker, NULL);
    }
    run_once(cmd);
    return 0;
}
