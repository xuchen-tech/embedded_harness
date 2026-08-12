#include "harness.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t g_stop;

static void handle_term(int sig) {
    (void)sig;
    g_stop = 1;
}

int watchdog_run(int (*worker)(void *), void *arg) {
    signal(SIGTERM, handle_term);
    signal(SIGINT, handle_term);

    int backoff = 1;
    while (!g_stop) {
        pid_t pid = fork();
        if (pid < 0) {
            return -1;
        }
        if (pid == 0) {
            /* Lower OOM priority in child worker. */
            FILE *f = fopen("/proc/self/oom_score_adj", "w");
            if (f) {
                fputs("500", f);
                fclose(f);
            }
            exit(worker(arg) == 0 ? 0 : 1);
        }

        int status = 0;
        while (!g_stop) {
            pid_t w = waitpid(pid, &status, WNOHANG);
            if (w == pid) {
                break;
            }
            sleep(1);
        }
        if (g_stop) {
            kill(pid, SIGTERM);
            waitpid(pid, &status, 0);
            break;
        }

        sleep((unsigned)backoff);
        if (backoff < 30) {
            backoff *= 2;
        }
    }
    return 0;
}
