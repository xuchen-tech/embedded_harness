#include "json_util.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

int json_append(char *buf, size_t size, size_t *off, const char *fmt, ...) {
    if (*off >= size) {
        return -1;
    }
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf + *off, size - *off, fmt, ap);
    va_end(ap);
    if (n < 0) {
        return -1;
    }
    *off += (size_t)n;
    if (*off >= size) {
        buf[size - 1] = '\0';
        return -1;
    }
    return 0;
}

void json_escape(const char *in, char *out, size_t out_size) {
    size_t j = 0;
    for (size_t i = 0; in[i] != '\0' && j + 2 < out_size; i++) {
        char c = in[i];
        if (c == '"' || c == '\\') {
            out[j++] = '\\';
        }
        out[j++] = c;
    }
    out[j] = '\0';
}
