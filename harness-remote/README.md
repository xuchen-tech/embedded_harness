# harness-remote v0.2.0

Phase 2 adds journal, core dump detection, and extended capabilities.

## CLI commands

| Command | Description |
|---------|-------------|
| `daemon` | Run collectors + unix socket |
| `metrics` | CPU / memory / processes JSON |
| `capabilities` | arch, logs, tools, **coreDump** status |
| `coredump-status` | Core dump configuration only |
| `logs` | Pop log ring buffer |
| `events` | Pop core dump events |

## Phase 2 collectors

- **journal** — `journalctl -f`, detects `code=dumped`
- **coredump** — inotify on core directory + `coredumpctl list`
- **events ring** — core dump events for Host polling

## Build

```bash
make clean && make
```
