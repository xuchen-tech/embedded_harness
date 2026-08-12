#include "harness.h"
#include "json_util.h"

#include <stdio.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

static int file_exists(const char *path) {
    return access(path, R_OK) == 0;
}

static int cmd_exists(const char *cmd) {
    char buf[256];
    snprintf(buf, sizeof(buf), "command -v %s >/dev/null 2>&1", cmd);
    return system(buf) == 0;
}

static void normalize_arch(const char *machine, char *out, size_t out_size) {
    if (strcmp(machine, "aarch64") == 0 || strcmp(machine, "arm64") == 0) {
        snprintf(out, out_size, "aarch64");
    } else if (strncmp(machine, "arm", 3) == 0) {
        snprintf(out, out_size, "armhf");
    } else if (strcmp(machine, "x86_64") == 0 || strcmp(machine, "amd64") == 0) {
        snprintf(out, out_size, "x86_64");
    } else if (strcmp(machine, "i686") == 0 || strcmp(machine, "i386") == 0) {
        snprintf(out, out_size, "i686");
    } else {
        snprintf(out, out_size, "unknown");
    }
}

static void detect_libc(char *out, size_t out_size) {
    if (file_exists("/etc/alpine-release")) {
        snprintf(out, out_size, "musl");
    } else if (file_exists("/lib/libc.so.6") || file_exists("/usr/lib/libc.so.6")) {
        snprintf(out, out_size, "glibc");
    } else {
        snprintf(out, out_size, "unknown");
    }
}

static void detect_init(char *out, size_t out_size) {
    if (file_exists("/run/systemd/system") || cmd_exists("systemctl")) {
        snprintf(out, out_size, "systemd");
    } else if (file_exists("/sbin/init") && !file_exists("/etc/inittab")) {
        snprintf(out, out_size, "unknown");
    } else if (file_exists("/etc/inittab")) {
        snprintf(out, out_size, "sysv");
    } else {
        snprintf(out, out_size, "busybox");
    }
}

static void detect_syslog_path(char *out, size_t out_size) {
    const char *candidates[] = {"/var/log/syslog", "/var/log/messages", NULL};
    out[0] = '\0';
    for (int i = 0; candidates[i]; i++) {
        if (file_exists(candidates[i])) {
            strncpy(out, candidates[i], out_size - 1);
            return;
        }
    }
}

int probe_capabilities(harness_capabilities *out) {
    if (!out) {
        return -1;
    }
    memset(out, 0, sizeof(*out));

    struct utsname uts;
    if (uname(&uts) == 0) {
        strncpy(out->machine, uts.machine, sizeof(out->machine) - 1);
        normalize_arch(uts.machine, out->normalized, sizeof(out->normalized));
    }

    detect_libc(out->libc, sizeof(out->libc));
    detect_init(out->init_system, sizeof(out->init_system));
    detect_syslog_path(out->syslog_path, sizeof(out->syslog_path));

    out->has_syslog = out->syslog_path[0] != '\0';
    out->has_journal = cmd_exists("journalctl");
    out->has_dmesg = cmd_exists("dmesg") || file_exists("/dev/kmsg");
    out->has_gdb = cmd_exists("gdb");
    out->has_perf = cmd_exists("perf");
    out->has_coredumpctl = cmd_exists("coredumpctl");
    probe_core_dump_status(&out->core_dump);
    return 0;
}

int capabilities_to_json(const harness_capabilities *c, char *buf, size_t size) {
    if (!c || !buf) {
        return -1;
    }
    size_t off = 0;
    json_append(buf, size, &off,
                "{\"protocolVersion\":%d,\"type\":\"capabilities\",\"payload\":{"
                "\"init\":\"%s\",\"arch\":{\"machine\":\"%s\",\"normalized\":\"%s\",\"libc\":\"%s\"},"
                "\"logSources\":[",
                HARNESS_PROTOCOL_VERSION, c->init_system, c->machine, c->normalized, c->libc);

    int first = 1;
    if (c->has_syslog) {
        json_append(buf, size, &off, "%s\"syslog\"", first ? "" : ",");
        first = 0;
    }
    if (c->has_journal) {
        json_append(buf, size, &off, "%s\"journal\"", first ? "" : ",");
        first = 0;
    }
    if (c->has_dmesg) {
        json_append(buf, size, &off, "%s\"dmesg\"", first ? "" : ",");
        first = 0;
    }

    char esc_pattern[HARNESS_CORE_PATTERN_MAX * 2];
    json_escape(c->core_dump.pattern, esc_pattern, sizeof(esc_pattern));

    json_append(buf, size, &off,
                "],\"tools\":{\"gdb\":{\"available\":%s},\"perf\":{\"available\":%s},"
                "\"coredumpctl\":{\"available\":%s}},\"syslogPath\":\"%s\","
                "\"coreDump\":{\"enabled\":%s,\"ulimitCore\":\"%s\",\"pattern\":\"%s\","
                "\"storageWritable\":%s,\"recommendedSetup\":\"%s\"}}}",
                c->has_gdb ? "true" : "false", c->has_perf ? "true" : "false",
                c->has_coredumpctl ? "true" : "false", c->syslog_path,
                c->core_dump.enabled ? "true" : "false", c->core_dump.ulimit_core,
                esc_pattern, c->core_dump.storage_writable ? "true" : "false",
                c->core_dump.recommended_setup);
    return (int)off;
}
