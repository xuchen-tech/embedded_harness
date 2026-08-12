CC ?= gcc
CFLAGS ?= -Wall -Wextra -O2 -std=c11 -D_GNU_SOURCE
INCLUDES = -Iinclude -Isrc
LDFLAGS = -pthread

SRCS = \
	src/main.c \
	src/json_util.c \
	src/ring_buffer.c \
	src/events.c \
	src/collector/meminfo.c \
	src/collector/loadavg.c \
	src/collector/process.c \
	src/collector/env_probe.c \
	src/collector/coredump_setup.c \
	src/collector/syslog.c \
	src/collector/journal.c \
	src/collector/dmesg.c \
	src/collector/config.c \
	src/collector/custom_logs.c \
	src/collector/coredump.c \
	src/watchdog/self_heal.c

OBJS = $(SRCS:.c=.o)
TARGET = build/harness-remote

.PHONY: all clean install

all: $(TARGET)

$(TARGET): $(OBJS)
	@mkdir -p build
	$(CC) $(OBJS) -o $@ $(LDFLAGS)

%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(INCLUDES) -c $< -o $@

clean:
	rm -rf build src/**/*.o src/*.o

install: $(TARGET)
	install -D -m 755 $(TARGET) /usr/local/bin/harness-remote
	install -D -m 644 scripts/harness-remote.service /etc/systemd/system/harness-remote.service
