#include "harness.h"
#include "json_util.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int read_proc_stat(int pid, harness_proc_info *info) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    FILE *f = fopen(path, "r");
    if (!f) {
        return -1;
    }

    info->pid = pid;
    unsigned long dummy;
    char state;
    char comm[64];
    if (fscanf(f, "%d (%63[^)]) %c %u %u %u %u %u %u %u %u %u %u %lu %lu", &info->pid, comm,
               &state, &dummy, &dummy, &dummy, &dummy, &dummy, &dummy, &dummy, &dummy, &dummy,
               &dummy, &info->utime, &info->stime) < 15) {
        fclose(f);
        return -1;
    }
    strncpy(info->name, comm, sizeof(info->name) - 1);
    fclose(f);

    snprintf(path, sizeof(path), "/proc/%d/status", pid);
    f = fopen(path, "r");
    info->rss_kb = 0;
    if (f) {
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            if (strncmp(line, "VmRSS:", 6) == 0) {
                sscanf(line + 6, "%ld", &info->rss_kb);
                break;
            }
        }
        fclose(f);
    }
    return 0;
}

static int cmp_proc(const void *a, const void *b) {
    const harness_proc_info *pa = a;
    const harness_proc_info *pb = b;
    unsigned long score_a = pa->utime + pa->stime;
    unsigned long score_b = pb->utime + pb->stime;
    if (score_a < score_b) {
        return 1;
    }
    if (score_a > score_b) {
        return -1;
    }
    return 0;
}

int collect_processes(harness_proc_info *out, int max, int *count) {
    if (!out || !count || max <= 0) {
        return -1;
    }
    DIR *dir = opendir("/proc");
    if (!dir) {
        return -1;
    }

    harness_proc_info tmp[128];
    int n = 0;
    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL && n < 128) {
        if (ent->d_name[0] < '0' || ent->d_name[0] > '9') {
            continue;
        }
        int pid = atoi(ent->d_name);
        if (read_proc_stat(pid, &tmp[n]) == 0) {
            n++;
        }
    }
    closedir(dir);

    qsort(tmp, (size_t)n, sizeof(harness_proc_info), cmp_proc);
    *count = n < max ? n : max;
    memcpy(out, tmp, (size_t)(*count) * sizeof(harness_proc_info));
    return 0;
}

static unsigned long g_prev_total;
static unsigned long g_prev_idle;

typedef struct {
    int pid;
    unsigned long utime;
    unsigned long stime;
    int valid;
} proc_cpu_prev;

static proc_cpu_prev g_proc_prev[256];
static time_t g_prev_sample_at;
static unsigned long g_watch_prev_total;

static int read_cmdline(int pid, char *buf, size_t size) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
    FILE *f = fopen(path, "r");
    if (!f) {
        return -1;
    }
    size_t n = fread(buf, 1, size - 1, f);
    fclose(f);
    if (n == 0) {
        return -1;
    }
    buf[n] = '\0';
    for (size_t i = 0; i < n; i++) {
        if (buf[i] == '\0') {
            buf[i] = ' ';
        }
    }
    return 0;
}

static int name_matches(const char *pattern, int pid, const char *comm) {
    if (!pattern || !pattern[0]) {
        return 0;
    }
    if (pattern[0] == '=') {
        pattern++;
        return comm && strcmp(comm, pattern) == 0;
    }
    if (comm && strstr(comm, pattern)) {
        return 1;
    }
    char cmdline[512];
    if (read_cmdline(pid, cmdline, sizeof(cmdline)) == 0 && strstr(cmdline, pattern)) {
        return 1;
    }
    return 0;
}

static proc_cpu_prev *find_proc_prev(int pid) {
    for (size_t i = 0; i < sizeof(g_proc_prev) / sizeof(g_proc_prev[0]); i++) {
        if (g_proc_prev[i].valid && g_proc_prev[i].pid == pid) {
            return &g_proc_prev[i];
        }
    }
    for (size_t i = 0; i < sizeof(g_proc_prev) / sizeof(g_proc_prev[0]); i++) {
        if (!g_proc_prev[i].valid) {
            g_proc_prev[i].pid = pid;
            g_proc_prev[i].valid = 1;
            return &g_proc_prev[i];
        }
    }
    return NULL;
}

static double calc_proc_cpu_percent(int pid, unsigned long utime, unsigned long stime,
                                    unsigned long diff_total_jiffies) {
    proc_cpu_prev *prev = find_proc_prev(pid);
    if (!prev || diff_total_jiffies == 0) {
        if (prev) {
            prev->utime = utime;
            prev->stime = stime;
        }
        return 0.0;
    }
    unsigned long diff_proc = (utime + stime) - (prev->utime + prev->stime);
    prev->utime = utime;
    prev->stime = stime;
    if (diff_total_jiffies == 0) {
        return 0.0;
    }
    long ncpu = sysconf(_SC_NPROCESSORS_ONLN);
    if (ncpu < 1) {
        ncpu = 1;
    }
    return 100.0 * (double)diff_proc / (double)diff_total_jiffies * (double)ncpu;
}

static double read_cpu_usage(void) {
    FILE *f = fopen("/proc/stat", "r");
    if (!f) {
        return 0.0;
    }
    unsigned long user, nice, system, idle, iowait, irq, softirq, steal;
    if (fscanf(f, "cpu %lu %lu %lu %lu %lu %lu %lu %lu", &user, &nice, &system, &idle, &iowait,
               &irq, &softirq, &steal) != 8) {
        fclose(f);
        return 0.0;
    }
    fclose(f);

    unsigned long idle_all = idle + iowait;
    unsigned long total = user + nice + system + idle_all + irq + softirq + steal;
    unsigned long diff_total = total - g_prev_total;
    unsigned long diff_idle = idle_all - g_prev_idle;
    g_prev_total = total;
    g_prev_idle = idle_all;

    if (diff_total == 0) {
        return 0.0;
    }
    return 100.0 * (double)(diff_total - diff_idle) / (double)diff_total;
}

int collect_watched_processes(const harness_config *cfg, harness_watched_proc_snapshot *out,
                              int max, int *count) {
    if (!out || !count || max <= 0) {
        return -1;
    }
    *count = 0;
    if (!cfg || cfg->watched_count <= 0) {
        return 0;
    }

    unsigned long total_now = 0, idle_now = 0;
    FILE *sf = fopen("/proc/stat", "r");
    if (sf) {
        unsigned long user, nice, system, idle, iowait, irq, softirq, steal;
        if (fscanf(sf, "cpu %lu %lu %lu %lu %lu %lu %lu %lu", &user, &nice, &system, &idle,
                   &iowait, &irq, &softirq, &steal) == 8) {
            idle_now = idle + iowait;
            total_now = user + nice + system + idle_now + irq + softirq + steal;
        }
        fclose(sf);
    }
    unsigned long diff_total = total_now - g_watch_prev_total;
    time_t now = time(NULL);
    if (g_watch_prev_total == 0) {
        diff_total = 0;
    }
    g_prev_sample_at = now;

    DIR *dir = opendir("/proc");
    if (!dir) {
        return -1;
    }

    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL && *count < max) {
        if (ent->d_name[0] < '1' || ent->d_name[0] > '9') {
            continue;
        }
        int pid = atoi(ent->d_name);
        harness_proc_info info;
        if (read_proc_stat(pid, &info) != 0) {
            continue;
        }

        for (int w = 0; w < cfg->watched_count && *count < max; w++) {
            const harness_watched_process *wp = &cfg->watched[w];
            if (!name_matches(wp->match, pid, info.name)) {
                continue;
            }

            harness_watched_proc_snapshot *slot = &out[*count];
            slot->pid = pid;
            slot->rss_kb = info.rss_kb;
            slot->cpu_percent = calc_proc_cpu_percent(pid, info.utime, info.stime, diff_total);
            strncpy(slot->name, info.name, sizeof(slot->name) - 1);
            strncpy(slot->match, wp->match, sizeof(slot->match) - 1);
            if (wp->label[0]) {
                strncpy(slot->label, wp->label, sizeof(slot->label) - 1);
            } else {
                strncpy(slot->label, wp->match, sizeof(slot->label) - 1);
            }
            (*count)++;
        }
    }
    closedir(dir);

    if (total_now >= g_watch_prev_total && total_now > 0) {
        g_watch_prev_total = total_now;
    }
    return 0;
}

int collect_metrics(harness_metrics *out, const harness_config *cfg) {
    if (!out) {
        return -1;
    }
    memset(out, 0, sizeof(*out));
    collect_meminfo(&out->mem);
    collect_loadavg(&out->load);
    collect_processes(out->procs, HARNESS_TOP_PROCS, &out->proc_count);
    collect_watched_processes(cfg, out->watched, HARNESS_WATCHED_PROCS_MAX, &out->watched_count);
    out->cpu_usage_percent = read_cpu_usage();
    out->collected_at = time(NULL);
    return 0;
}

int metrics_to_json(const harness_metrics *m, char *buf, size_t size) {
    if (!m || !buf) {
        return -1;
    }
    size_t off = 0;
    json_append(buf, size, &off,
                "{\"protocolVersion\":%d,\"type\":\"metrics\",\"timestamp\":%ld000,\"payload\":{",
                HARNESS_PROTOCOL_VERSION, (long)m->collected_at);
    json_append(buf, size, &off,
                "\"cpu\":{\"usagePercent\":%.2f,\"load1\":%.2f,\"load5\":%.2f,\"load15\":%.2f},",
                m->cpu_usage_percent, m->load.load1, m->load.load5, m->load.load15);
    json_append(buf, size, &off,
                "\"memory\":{\"totalKb\":%ld,\"freeKb\":%ld,\"availableKb\":%ld,\"swapUsedKb\":%ld},",
                m->mem.total_kb, m->mem.free_kb, m->mem.available_kb,
                m->mem.swap_total_kb - m->mem.swap_free_kb);
    json_append(buf, size, &off, "\"topProcesses\":[");
    for (int i = 0; i < m->proc_count; i++) {
        if (i > 0) {
            json_append(buf, size, &off, ",");
        }
        char esc[128];
        json_escape(m->procs[i].name, esc, sizeof(esc));
        json_append(buf, size, &off,
                    "{\"pid\":%d,\"name\":\"%s\",\"cpuPercent\":0,\"memKb\":%ld}",
                    m->procs[i].pid, esc, m->procs[i].rss_kb);
    }
    json_append(buf, size, &off, "],\"watchedProcesses\":[");
    for (int i = 0; i < m->watched_count; i++) {
        if (i > 0) {
            json_append(buf, size, &off, ",");
        }
        char esc_name[128];
        char esc_label[128];
        char esc_match[128];
        json_escape(m->watched[i].name, esc_name, sizeof(esc_name));
        json_escape(m->watched[i].label, esc_label, sizeof(esc_label));
        json_escape(m->watched[i].match, esc_match, sizeof(esc_match));
        json_append(buf, size, &off,
                    "{\"pid\":%d,\"name\":\"%s\",\"label\":\"%s\",\"match\":\"%s\","
                    "\"cpuPercent\":%.2f,\"memKb\":%ld}",
                    m->watched[i].pid, esc_name, esc_label, esc_match, m->watched[i].cpu_percent,
                    m->watched[i].rss_kb);
    }
    json_append(buf, size, &off, "]}}");
    return (int)off;
}
