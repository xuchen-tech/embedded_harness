#include "harness_log.h"

/* Example UART backend — replace with your HAL */
void harness_log_uart_write(const char *buf, unsigned len) {
    (void)buf;
    (void)len;
    /* HAL_UART_Transmit(&huart1, (uint8_t*)buf, len, HAL_MAX_DELAY); */
}
