#ifndef JSON_UTIL_H
#define JSON_UTIL_H

#include <stddef.h>

int json_append(char *buf, size_t size, size_t *off, const char *fmt, ...);
void json_escape(const char *in, char *out, size_t out_size);

#endif
