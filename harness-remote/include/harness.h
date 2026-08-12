#ifndef HARNESS_H
#define HARNESS_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>

#define HARNESS_VERSION "0.2.0"
#define HARNESS_PROTOCOL_VERSION 1
#define HARNESS_LOG_RING_SIZE 256
#define HARNESS_EVENT_RING_SIZE 32
#define HARNESS_LOG_LINE_MAX 1024
#define HARNESS_TOP_PROCS 10
#define HARNESS_WATCHED_PROCS_MAX 16
#define HARNESS_WATCHED_MATCH_MAX 32
#define HARNESS_CONFIG_PATH "/etc/harness-remote/config.json"
#define HARNESS_SOCKET_PATH "/var/run/harness-remote.sock"
#define HARNESS_CUSTOM_LOGS_MAX 16
#define HARNESS_CORE_PATTERN_MAX 256

typedef struct {
    long total_kb;
    long free_kb;
    long available_kb;
    long swap_total_kb;
    long swap_free_kb;
} harness_meminfo;

typedef struct {
    double load1;
    double load5;
    double load15;
} harness_loadavg;

typedef struct {
    int pid;
    char name[64];
    unsigned long utime;
    unsigned long stime;
    long rss_kb;
} harness_proc_info;

typedef struct {
    char match[HARNESS_WATCHED_MATCH_MAX];
    char label[128];
} harness_watched_process;

typedef struct {
    int pid;
    char name[64];
    char label[128];
    char match[HARNESS_WATCHED_MATCH_MAX];
    double cpu_percent;
    long rss_kb;
} harness_watched_proc_snapshot;

typedef struct {
    double cpu_usage_percent;
    harness_loadavg load;
    harness_meminfo mem;
    harness_proc_info procs[HARNESS_TOP_PROCS];
    int proc_count;
    harness_watched_proc_snapshot watched[HARNESS_WATCHED_PROCS_MAX];
    int watched_count;
    time_t collected_at;
} harness_metrics;

typedef struct {
    char id[64];
    char path[512];
    char label[128];
} harness_custom_log_path;

typedef struct {
    harness_custom_log_path paths[HARNESS_CUSTOM_LOGS_MAX];
    int count;
    harness_watched_process watched[HARNESS_WATCHED_PROCS_MAX];
    int watched_count;
} harness_config;

typedef struct {
    int enabled;
    char ulimit_core[32];
    char pattern[HARNESS_CORE_PATTERN_MAX];
    int storage_writable;
    char recommended_setup[32];
} harness_core_dump_status;

typedef struct {
    char machine[64];
    char normalized[32];
    char libc[16];
    char init_system[32];
    int has_syslog;
    int has_journal;
    int has_dmesg;
    char syslog_path[256];
    int has_gdb;
    int has_perf;
    int has_coredumpctl;
    harness_core_dump_status core_dump;
} harness_capabilities;

typedef enum {
    LOG_SRC_SYSLOG = 0,
    LOG_SRC_DMESG,
    LOG_SRC_CUSTOM,
    LOG_SRC_JOURNAL
} harness_log_source;

typedef struct {
    harness_log_source source;
    char custom_id[64];
    char level[16];
    char message[HARNESS_LOG_LINE_MAX];
    time_t timestamp;
} harness_log_entry;

typedef struct {
    char source[32];
    char remote_path[512];
    char coredumpctl_id[64];
    int pid;
    char executable[256];
    int signal;
    time_t detected_at;
} harness_coredump_event;

/* json_util */
int json_append(char *buf, size_t size, size_t *off, const char *fmt, ...);
void json_escape(const char *in, char *out, size_t out_size);

/* ring_buffer */
void log_ring_init(void);
void log_ring_push(const harness_log_entry *entry);
int log_ring_pop_all(char *buf, size_t size);

/* events */
void event_ring_init(void);
void event_ring_push(const harness_coredump_event *event);
int event_ring_pop_all(char *buf, size_t size);

/* collectors */
int collect_meminfo(harness_meminfo *out);
int collect_loadavg(harness_loadavg *out);
int collect_processes(harness_proc_info *out, int max, int *count);
int collect_watched_processes(const harness_config *cfg, harness_watched_proc_snapshot *out,
                              int max, int *count);
int collect_metrics(harness_metrics *out, const harness_config *cfg);
int probe_capabilities(harness_capabilities *out);
int probe_core_dump_status(harness_core_dump_status *out);
int syslog_collector_start(void);
void syslog_collector_stop(void);
int journal_collector_start(void);
void journal_collector_stop(void);
int dmesg_collector_start(void);
void dmesg_collector_stop(void);
int custom_logs_collector_start(const harness_config *cfg);
void custom_logs_collector_stop(void);
int coredump_collector_start(void);
void coredump_collector_stop(void);
int config_load(harness_config *cfg, const char *path);
int metrics_to_json(const harness_metrics *m, char *buf, size_t size);
int capabilities_to_json(const harness_capabilities *c, char *buf, size_t size);
int core_dump_status_to_json(const harness_core_dump_status *s, char *buf, size_t size);
void emit_journal_crash_event(const char *line);

/* watchdog */
int watchdog_run(int (*worker)(void *), void *arg);

#endif
