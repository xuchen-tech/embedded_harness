# Embedded Harness

Host–Remote 嵌入式监控与诊断平台（v0.3.0 — Phase 1–3）。

## 仓库结构

```text
embedded_harness/
├── docs/architecture.md      # 架构设计
├── harness-remote/           # Remote Linux 轻量采集器 (C)
├── extension/                # VSCode Host 插件 (TypeScript)
└── mcu/                      # MCU JSON Lines 日志宏
```

## Phase 1 范围

- [x] Remote：`/proc` 指标、env_probe、syslog tail、dmesg、自定义日志、watchdog
- [x] Host：SSH 连接、capabilities 摘要、指标曲线、多源日志 Output
- [x] Host：自定义日志路径配置并下发到 Remote
- [x] MCU：`harness_log.h` + Host 串口读取 stub

## Phase 2 范围

- [x] Remote：journal、core dump 检测、coredumpctl
- [x] Host：Core Dump 向导、GDB 回溯、历史存储、告警、重连、统一时间线

## Phase 3 范围

- [x] MCP Server（SSE 本地服务 + stdio 独立入口）
- [x] MCP Tools：metrics / logs / coredump / capabilities / 诊断模板
- [x] 诊断模板：CPU 峰值、内存泄漏、启动失败
- [x] Remote 调试环境向导（apt/dnf/opkg/apk + 离线工具包推送）

## 快速开始

### 1. 构建 Remote 采集器（Linux / WSL）

在 **WSL** 或嵌入式板卡上：

```bash
cd harness-remote
make
sudo cp build/harness-remote /usr/local/bin/
harness-remote capabilities
```

Windows 上无需 SSH：插件通过 `wsl.exe` 直接调用 WSL 内的 `harness-remote`。

**快速添加 WSL Target（Windows）**

1. F5 启动插件
2. 命令面板 → **`Embedded Harness: Add WSL Target`**
3. 选择 distro（如 Ubuntu）→ Connect

或 settings.json：

```json
{
  "embeddedHarness.targets": [
    {
      "id": "wsl-ubuntu",
      "host": "WSL",
      "port": 0,
      "username": "wsl",
      "transport": "wsl",
      "wslDistro": "Ubuntu",
      "remoteBinary": "harness-remote"
    }
  ]
}
```

部署到远程板卡（SSH）：

```bash
scp build/harness-remote user@target:/usr/local/bin/
ssh user@target 'harness-remote daemon &'
```

### 2. 运行 VSCode 插件

```bash
cd extension
npm install
npm run compile
```

在 VSCode 中 **Run Extension**（F5），或打包安装：

- 命令：`Embedded Harness: Add Linux Target`
- 命令：`Embedded Harness: Connect`
- 命令：`Embedded Harness: Add Custom Log Path`

### 3. 配置示例（settings.json）

```json
{
  "embeddedHarness.targets": [
    {
      "id": "board-a",
      "host": "192.168.1.10",
      "port": 22,
      "username": "root",
      "privateKeyPath": "C:\\Users\\you\\.ssh\\id_rsa",
      "remoteBinary": "harness-remote",
      "customLogPaths": [
        { "id": "app", "path": "/var/log/myapp.log", "label": "App" }
      ]
    }
  ],
  "embeddedHarness.pollIntervalMs": 3000,
  "embeddedHarness.serialPort": "COM3"
}
```

  "embeddedHarness.hostToolchain.elfPath": "D:/build/app/myapp",
  "embeddedHarness.alert.cpuThresholdPercent": 90
}
```

### Phase 2 命令

- `Embedded Harness: Show Unified Timeline` — 多源日志合并时间线
- `Embedded Harness: Core Dump Setup Wizard` — 引导启用 core dump
- 连接时若 core dump 未启用，会自动提示运行向导

Core dump 解析需配置 Host 交叉 GDB：

```json
{
  "embeddedHarness.hostToolchain.gdbPath": "C:/tools/arm-linux-gdb.exe",
  "embeddedHarness.hostToolchain.sysroot": "D:/build/rootfs/",
  "embeddedHarness.hostToolchain.elfPath": "D:/build/app/myapp"
}
```

历史数据保存在 VSCode globalStorage 的 `history/` 目录（JSONL）。

### Phase 3：MCP 与 AI 对接

**方式 A — Cursor stdio（推荐）**

1. 编译插件：`cd extension && npm install && npm run compile`
2. 命令面板：`Embedded Harness: Show MCP Config for Cursor`
3. 将生成的 JSON 合并到 Cursor MCP 设置；`HARNESS_STORAGE_DIR` 设为 `history/` 绝对路径
4. 在 Cursor 聊天中提问，例如：「用 embedded-harness 分析 board-a 过去 5 分钟 CPU 异常」

**方式 B — 插件内 SSE 服务**

1. `Embedded Harness: Start MCP Server`（默认 `http://127.0.0.1:9765/sse`）
2. 可选配置 `embeddedHarness.mcp.apiKey`

**MCP Tools 列表**

| Tool | 说明 |
|------|------|
| `list_targets` | 列出 target |
| `get_metrics_summary` | 指标摘要 + 历史 |
| `get_recent_logs` | 合并日志 |
| `get_last_coredump` | 最近一次 core |
| `get_capabilities` | Remote 环境能力 |
| `analyze_cpu_spike` | CPU 峰值诊断 |
| `analyze_memory_leak` | 内存趋势诊断 |
| `analyze_launch_failure` | 启动失败诊断 |

**调试环境向导**：`Embedded Harness: Debug Environment Wizard` — 支持 apt/dnf/opkg/apk 或离线 tarball（见 `extension/tools/manifest.json`）

### 4. MCU 固件

```c
#include "harness_log.h"

void app_init(void) {
    HLOG_INFO("main", "boot complete");
}
```

## 下一步

- 真实 serialport / J-Link RTT 集成
- MCP OAuth / 细粒度 ACL（见 architecture.md §18.7）
- 云端可选同步

## 文档

详见 [docs/architecture.md](docs/architecture.md)
