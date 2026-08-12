# Embedded Harness v0.3.0

## Phase 3: MCP + Diagnostics

### MCP Tools

- `list_targets`, `get_metrics_summary`, `get_recent_logs`
- `get_last_coredump`, `get_capabilities`
- `analyze_cpu_spike`, `analyze_memory_leak`, `analyze_launch_failure`

### Cursor setup

```bash
npm install && npm run compile
```

1. Connect to a target (populates `globalStorage/history/`)
2. Run command **Show MCP Config for Cursor**
3. Add to Cursor MCP settings; set storage path to `history/` folder

Or stdio manually:

```json
{
  "embedded-harness": {
    "command": "node",
    "args": ["D:/projects/embedded_harness/extension/out/mcp/stdioMain.js", "--storage", "PATH/TO/history"]
  }
}
```

### SSE server (in-extension)

- Command: **Start MCP Server**
- Default: `http://127.0.0.1:9765/sse`
- Health: `http://127.0.0.1:9765/health`

### Debug Environment Wizard

- Detects apt / dnf / opkg / apk
- Installs gdb, gdbserver, perf, strace
- Offline mode: place `extension/tools/bundles/harness-tools-{arch}.tar.gz`
