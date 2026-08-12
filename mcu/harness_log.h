#ifndef HARNESS_LOG_H
#define HARNESS_LOG_H

/*
 * Embedded Harness MCU structured logging (Phase 1)
 * Output JSON Lines over RTT or UART.
 *
 * Integrate with SEGGER RTT by defining HARNESS_LOG_WRITE before include:
 *   #define HARNESS_LOG_WRITE(buf, len) SEGGER_RTT_Write(0, buf, len)
 */

#include <stdio.h>
#include <string.h>

#ifndef HARNESS_LOG_WRITE
#define HARNESS_LOG_WRITE(buf, len) harness_log_uart_write(buf, len)
#endif

#ifndef HARNESS_LOG_LINE_MAX
#define HARNESS_LOG_LINE_MAX 256
#endif

/* Platform must implement when not using RTT */
void harness_log_uart_write(const char *buf, unsigned len);

static inline void harness_log_emit(const char *lvl, const char *mod, const char *msg) {
    char line[HARNESS_LOG_LINE_MAX];
    int n = snprintf(line, sizeof(line),
                     "{\"ts\":0,\"lvl\":\"%s\",\"mod\":\"%s\",\"msg\":\"%s\"}\n",
                     lvl, mod, msg);
    if (n > 0) {
        HARNESS_LOG_WRITE(line, (unsigned)n);
    }
}

#define HLOG_DEBUG(mod, msg) harness_log_emit("DEBUG", mod, msg)
#define HLOG_INFO(mod, msg)  harness_log_emit("INFO", mod, msg)
#define HLOG_WARN(mod, msg)  harness_log_emit("WARN", mod, msg)
#define HLOG_ERROR(mod, msg) harness_log_emit("ERROR", mod, msg)

#endif
