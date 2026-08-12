# Embedded Harness 架构设计说明

## 1. 目标与范围

Embedded Harness 是一套面向嵌入式开发场景的监控与诊断平台，目标是在 Host 侧统一管理 Remote 端的运行状态、日志、资源使用、崩溃信息和调试数据，并以 VSCode 为中心提供低侵入、可视化、可扩展的工程调试能力。

本方案遵循以下核心原则：

- Host 与 Remote 物理分离，职责明确
- Remote 端保持轻量，禁止承载 AI Agent 或重型运行时
- Host 负责集中控制、聚合、分析、告警和展示
- MCU 只输出结构化调试日志，不承担 Harness 运行时
- AI / MCP 作为增强能力，不是系统核心依赖

本系统适用于以下场景：

- Embedded Linux 设备状态监控
- MCU 固件调试与日志分析
- Core Dump 检测与符号化回溯
- 长期运行稳定性分析与告警
- VSCode 工作流下的统一嵌入式诊断入口

### 1.1 非目标

本架构不解决以下问题：

- 在 Remote 端部署完整大模型推理服务
- 在 MCU 上运行复杂监控框架
- 把所有决策逻辑下沉到设备侧
- 通过 AI 替代所有调试与分析流程

---

## 2. 总体架构

### 2.1 逻辑拓扑

架构图

### 2.2 架构关键结论

1. Remote 端不部署 AI Agent；只保留轻量采集器。
2. Host 端承载中心控制与分析逻辑。
3. Linux 与 MCU 使用不同的数据通道，且职责完全分离。
4. MCP / AI 仅作为 Host 侧增强层，用于分析和协同，而不是系统承载基础。

---

## 3. 设计原则


| 原则        | 说明                                      |
| --------- | --------------------------------------- |
| 轻量 Remote | 目标机上的 CPU、内存、Flash 资源有限，不能运行重型框架或大模型    |
| Host 集中式  | 聚合、告警、持久化、解析与展示全部在 Host 端完成             |
| 最小侵入      | 采集逻辑与固件打点对主业务代码影响最小                     |
| 自守护能力     | 采集器必须具备崩溃重启与 watchdog 能力                |
| 事件驱动优先    | syslog、core dump、异常日志基于事件驱动采集，不做大规模离线落盘 |
| 协议清晰      | Host 与 Remote 之间的接口必须稳定、版本化且可扩展         |
| AI 可选增强   | Harness 的核心能力不依赖 AI，AI/MCP 仅辅助诊断        |


---

## 4. 系统分层与职责

架构图

### 4.1 分层职责


| 层次  | 位置                 | 职责                                |
| --- | ------------------ | --------------------------------- |
| 采集层 | Remote Linux / MCU | 读取系统指标、日志、core dump、RTT/串口输出      |
| 传输层 | Host ↔ Remote      | SSH、WebSocket、J-Link、串口字节流        |
| 处理层 | Host               | 解析、校验、聚合、告警、持久化                   |
| 展示层 | Host               | VSCode Webview、日志视图、图表、堆栈展示       |
| 智能层 | Host / 云端          | AI Agent 通过 MCP 调用 Harness 数据进行分析 |


---

## 5. 组件边界

### 5.1 Remote Linux：Harness-Remote

定位：轻量采集器（非 AI Agent）

职责：

- 周期性采集 CPU、内存、负载、进程状态
- 监控 syslog、systemd journal、内核 dmesg 及用户指定的自定义日志文件
- 检测 core dump 是否已启用；未启用时在 Host 指导下完成 Remote 端配置
- 检测新生成的 core dump 文件并上报
- 探测 Remote 端可选工具链（gdb、perf 等）是否可用，上报能力清单
- 上报指标与事件给 Host
- 具备 watchdog 与自恢复能力

设计原则：

- 只采集，不决策
- 不保留大量历史数据
- 不依赖复杂运行时
- 优先保证目标系统稳定运行

### 5.2 Remote MCU：固件打点

定位：日志输出通道，非计算节点

职责：

- 通过结构化日志宏输出 JSON Lines 或键值日志
- 发送至 RTT 或 UART
- 提供调试和异常信息来源

设计原则：

- 无需在 MCU 上部署 Harness runtime
- 仅增加最小的日志宏与调试输出
- 传输数据由 Host 负责解码和处理

### 5.3 Host：VSCode Harness Plugin

定位：中央 Harness 平台

职责：

- 建立到 Linux / MCU 的连接
- 接收 Remote 端 `capabilities`（日志源、工具链、core dump 状态）
- 管理 target 配置：自定义日志路径、Host 端交叉工具链路径
- 引导 Remote 端 core dump 一次性配置（按 init 系统生成脚本）
- 引导 Remote 端可选调试环境安装（gdb / perf 等，用户确认后 SSH 执行）
- 获取并校验数据
- 聚合 Linux（syslog / journal / dmesg / 自定义日志）与 MCU 日志
- 持久化历史数据
- 实时告警与通知
- Core Dump 拉取与 Host 端 GDB 符号化回溯
- 提供 MCP 接口供外部 Agent 使用

---

## 6. Remote Linux 设计

### 6.1 模块结构

```text
harness-remote/
├── src/
│   ├── main.c                  # 入口、信号处理、主循环
│   ├── collector/
│   │   ├── meminfo.c           # /proc/meminfo 采集
│   │   ├── loadavg.c           # /proc/loadavg 采集
│   │   ├── process.c           # 进程快照采集
│   │   ├── syslog.c            # 传统 syslog 文件 tail（/var/log/messages 等）
│   │   ├── journal.c           # systemd journal 读取（journalctl）
│   │   ├── dmesg.c             # 内核环形缓冲区增量读取
│   │   ├── custom_logs.c       # 用户配置的自定义日志路径 tail
│   │   ├── coredump.c          # core 文件检测、元数据上报
│   │   ├── coredump_setup.c    # core dump 启用状态检测与配置辅助
│   │   └── env_probe.c         # gdb / perf 等工具可用性探测
│   ├── transport/
│   │   ├── ssh_pull.c          # Host 通过 SSH 拉取数据
│   │   ├── push_ws.c           # 可选 WebSocket 主动推送
│   │   └── push_tcp.c          # 可选 TCP 上报
│   └── watchdog/
│       └── self_heal.c         # 子进程崩溃重启、系统守护
├── scripts/
│   ├── harness-remote.service  # systemd 单元
│   └── watchdog.sh            # 二道防线
├── Makefile
└── README.md
```

### 6.2 采集能力


| 数据源             | 采样频率        | 说明                                               |
| --------------- | ----------- | ------------------------------------------------ |
| /proc/meminfo   | 2–5s        | 内存使用、缓存、Swap、可用内存                                |
| /proc/loadavg   | 2–5s        | 1/5/15 分钟负载                                      |
| 进程快照            | 5–10s       | Top-N 进程 CPU / 内存占用                              |
| syslog 文件       | 事件驱动        | `/var/log/messages`、`/var/log/syslog` 等（因发行版而异）  |
| systemd journal | 事件驱动        | 通过 `journalctl -f` 或 sd-journal API 读取服务崩溃、OOM 等 |
| dmesg（内核日志）     | 2–10s 或事件驱动 | 内核 panic、驱动错误、OOM killer、硬件异常                    |
| 自定义日志文件         | 事件驱动        | 用户在 Host 端配置的路径，如 `/opt/app/logs/*.log`          |
| core dump       | 事件驱动        | 检测新文件并上报摘要信息；未启用时触发配置流程                          |
| 工具链探测           | 连接时 / 周期性   | gdb、perf、addr2line 等是否存在及版本                      |
| 架构探测            | 连接时         | `uname -m`、libc 类型，用于选择 harness-remote 二进制       |


### 6.3 采集策略

- 不保留完整历史数据，避免 Flash 写入与空间膨胀
- 仅保留最近 N 条缓存日志或最近一段时间的摘要数据
- 实时上报优先，历史归档在 Host 端处理
- 采集器读取逻辑必须尽量低成本，不阻塞主业务程序

### 6.4 看门狗与自守护

```text
启动
 ├─ 父进程负责守护和重启
 ├─ 子进程执行采集主循环
 ├─ 子进程异常退出 -> 父进程 waitpid -> 退避重启
 ├─ 父进程收到 SIGTERM -> 资源清理并优雅退出
 └─ systemd / watchdog 作为第二层防护
```

要求：

- 进程崩溃后自动重启
- 采集器优先级低于业务进程
- 通过 `oom_score_adj` 降低其被 OOM 杀死概率
- 限制日志落盘和网络发包量

### 6.5 资源约束目标


| 指标     | 目标值              |
| ------ | ---------------- |
| 常驻内存   | < 2 MB           |
| CPU 占用 | 空闲时 < 1%         |
| 磁盘写入   | 最小化，仅配置或缓存文件     |
| 二进制体积  | < 500 KB（静态链接可选） |


### 6.6 日志源与采集策略

嵌入式 Linux 的日志来源分散且因发行版、init 系统、应用部署方式不同而差异很大。Harness-Remote 必须按 **日志源类型** 分别处理，而不是假设所有系统都有统一的 `/var/log/messages`。

#### 6.6.1 日志源分类


| 类型                  | 典型场景                         | 采集方式                                 | 备注                                          |
| ------------------- | ---------------------------- | ------------------------------------ | ------------------------------------------- |
| **syslog 文件**       | BusyBox、传统 syslog-ng/rsyslog | `inotify` + `tail` 指定文件              | 路径因发行版不同，需自动探测或配置                           |
| **systemd journal** | systemd 管理的现代发行版             | `journalctl -f -o json` 或 libsystemd | 服务 crash、segfault、Restart= 循环等常只出现在 journal |
| **dmesg（内核）**       | 所有 Linux                     | 周期性读取 `/dev/kmsg` 或 `dmesg -T` 增量    | OOM killer、内核 panic、驱动 fault 不在应用日志中        |
| **自定义应用日志**         | 自研程序、第三方中间件                  | 对用户配置的路径做 `tail`                     | 路径、轮转策略各项目不同，**必须支持 Host 端手动填入**            |


#### 6.6.2 常见 syslog 路径（自动探测候选）


| 发行版 / 环境               | 默认路径                               |
| ---------------------- | ---------------------------------- |
| Debian / Ubuntu        | `/var/log/syslog`                  |
| RHEL / CentOS / Fedora | `/var/log/messages`                |
| OpenWrt / BusyBox      | `/var/log/messages` 或仅 ring buffer |
| Buildroot 定制           | 无文件日志，仅 console / journal          |
| Yocto 最小镜像             | 可能未安装 rsyslog，仅 journal 或 dmesg    |


采集器启动时应 **探测可用源**，将结果写入 `capabilities` 上报 Host；不可用的源跳过，不视为致命错误。

#### 6.6.3 journal 与 syslog 的分工

- **优先 journal**：若检测到 systemd 且 `journalctl` 可用，对 *服务级崩溃*（如 `Main process exited, code=dumped`）以 journal 为主。
- **syslog 补充**：部分应用仍只写文件，不走 journal。
- **dmesg 独立通道**：内核级事件不应与 userspace 日志混在同一 tail 逻辑中；Host 侧展示时可合并时间线，但采集与解析保持分离。

#### 6.6.4 dmesg 采集要点

- 使用 **增量读取**（记录上次 offset 或 `--since` 时间戳），避免每次全量 dump。
- 关注关键字：`Out of memory`、`Killed process`、`BUG:`、`Oops:`、`segfault`、`watchdog`。
- 无 `dmesg` 命令时，可降级读取 `/dev/kmsg`（需适当权限）。

### 6.7 可配置自定义日志路径

不同程序的日志路径、命名、轮转规则各不相同，架构上 **不在 Remote 端硬编码**，而由 Host 端（VSCode 插件）为每个 target 维护配置，下发给 Harness-Remote。

#### 6.7.1 Host 端配置示例

```json
{
  "targetId": "board-a",
  "customLogPaths": [
    {
      "id": "app-main",
      "path": "/opt/myapp/logs/app.log",
      "label": "主程序",
      "encoding": "utf-8"
    },
    {
      "id": "nginx",
      "path": "/var/log/nginx/error.log",
      "label": "Nginx 错误"
    },
    {
      "id": "app-rotated",
      "path": "/data/logs/*.log",
      "label": "业务日志（通配）",
      "followRotation": true
    }
  ]
}
```

#### 6.7.2 行为约定

- 路径支持 **精确路径** 与 **通配符**（如 `*.log`）；通配模式下新文件创建时需自动跟进。
- 支持 **日志轮转**：检测到 rename/truncate 时重新打开文件，不丢失新内容。
- 文件不存在时：上报 `log_source_unavailable` 事件，Host 提示用户检查路径，不阻塞其他采集项。
- 权限不足时：明确上报 errno，Host 引导用户调整 ACL 或使用具备读权限的 deploy 用户。

#### 6.7.3 UI 交互（Host 插件）

- 在 target 配置页提供 **「添加监控日志」** 输入框，支持手动填入绝对路径。
- 可选「浏览 Remote 目录」：通过 SSH `ls` 辅助选择（只读，不执行任意命令）。
- 每条路径可单独启用/禁用、设置显示标签与级别过滤规则。

### 6.8 Core Dump：检测、配置与跨发行版差异

许多嵌入式镜像 **默认未开启 core dump**（`ulimit -c 0`、无存储路径、或 systemd-coredump 未配置）。Harness 必须在连接建立时 **检测状态**，未启用时由 Host 引导用户在 Remote 上完成一次性配置。

#### 6.8.1 启用状态检测项


| 检测项               | 命令 / 路径                         | 期望                         |
| ----------------- | ------------------------------- | -------------------------- |
| 单进程 core 限制       | `ulimit -c`                     | 非 0 或 `unlimited`          |
| 全局 core pattern   | `/proc/sys/kernel/core_pattern` | 指向可写路径或 `systemd-coredump` |
| core 存储目录         | pattern 解析结果                    | 目录存在且可写                    |
| systemd-coredump  | `coredumpctl list` 是否可用         | 可选，现代 systemd 系统           |
| Apport（Ubuntu 桌面） | 是否拦截 core                       | 嵌入式通常无，需知晓                 |


检测结果封装为 `CoreDumpCapability` 上报 Host，UI 显示 ✅ / ⚠️ / ❌。

#### 6.8.2 不同系统的配置方式

**A. 传统 ulimit + core_pattern（Buildroot / BusyBox / 通用嵌入式）**

```bash
# 临时生效（验证用）
ulimit -c unlimited
echo "/tmp/core.%e.%p.%t" > /proc/sys/kernel/core_pattern

# 持久化：写入 init 脚本或 harness-remote.service 的 ExecStartPre
```

**B. systemd + systemd-coredump（Yocto systemd / Debian / Ubuntu）**

```ini
# /etc/systemd/coredump.conf
[Coredump]
Storage=external
Compress=yes
ProcessSizeMax=512M
```

```bash
# 验证
coredumpctl list
coredumpctl info <PID>
```

core 文件可能不在 `/tmp`，而在 journal 关联的 coredump 存储中；采集器需同时监听 **文件系统路径** 与 **coredumpctl 事件**。

**C. OpenWrt / 只读根文件系统**

- core 必须写到 **可写分区**（如 `/overlay`、`/data/core/`）。
- `core_pattern` 需指向该分区；只读 `/` 时无法落 core 到默认路径。

**D. 容器 / 命名空间内进程**

- 需在 **容器所在 PID namespace** 或 host 侧配置 `core_pattern`。
- Harness 需识别目标进程是否在容器内，必要时配置 `host` 侧路径。

#### 6.8.3 Host 引导的配置流程

```text
连接 Remote
  -> env_probe + coredump_setup 检测
  -> 若未启用：
       Host UI 展示「Core Dump 未启用」向导
       按探测到的 init 系统（sysv / systemd / busybox）生成对应脚本
       用户确认后，通过 SSH 执行有限步骤（白名单命令）
       再次检测直至通过
  -> 启用后：coredump.c 开始 inotify 监控 + 可选 coredumpctl 订阅
```

配置脚本由 Host 生成、Remote 执行，**不**在采集器内嵌所有发行版逻辑；采集器只负责检测与上报。

#### 6.8.4 core 与 journal 的关联

部分崩溃 **不产生独立 core 文件**，仅在 journal 中可见，例如：

```text
systemd[1]: myapp.service: Main process exited, code=dumped, status=11/SEGV
```

采集策略：

1. journal 监听此类条目 → 触发 Host 告警；
2. 若 systemd-coredump 可用 → 自动执行 `coredumpctl dump` 导出或指引 Host 拉取；
3. 若无 coredump 仅有 journal 栈摘要 → 仍上报 `CoreDumpEvent`，`backtrace` 为空，标记 `source: journal-only`。

### 6.9 可选工具链与环境探测

嵌入式镜像常为减小体积 **未安装 gdb、perf、strace** 等工具。Harness 不应假设 Remote 端具备完整调试环境；**符号化与深度分析默认在 Host 端完成**。

#### 6.9.1 探测项与用途


| 工具                       | 探测命令                          | Remote 端用途       | 不可用时降级                        |
| ------------------------ | ----------------------------- | ---------------- | ----------------------------- |
| **gdb**                  | `which gdb` / `gdb --version` | 现场快速 `bt`（可选）    | Host 用交叉 gdb 解析拉回的 core       |
| **gdbserver**            | `which gdbserver`             | 远程调试会话（可选扩展）     | 仅 Host 侧调试                    |
| **perf**                 | `which perf`                  | 现场 CPU 火焰图采样（可选） | Host 仅依赖 /proc 指标，提示用户安装 perf |
| **addr2line**            | `which addr2line`             | 地址符号化            | Host 本地工具链                    |
| **eu-readelf / readelf** | `which readelf`               | ELF 架构验证         | Host 解析时检测                    |
| **coredumpctl**          | `coredumpctl --version`       | systemd core 管理  | 仅文件系统监控 core                  |


探测结果示例：

```json
{
  "type": "capabilities",
  "payload": {
    "init": "systemd",
    "logSources": ["journal", "dmesg"],
    "tools": {
      "gdb": { "available": false },
      "perf": { "available": false },
      "coredumpctl": { "available": true, "version": "252" }
    },
    "coreDump": {
      "enabled": false,
      "pattern": "|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h",
      "recommendedSetup": "systemd-coredump"
    }
  }
}
```

#### 6.9.2 设计原则

- **Remote 无 gdb 是正常状态**：core 文件 SCP 到 Host 后，用 **Host 上的 arm-linux-gnueabihf-gdb** + 对应 ELF 符号解析。
- **perf 为增强能力**：插件 UI 中「采样分析」按钮根据 `capabilities.tools.perf` 启用或置灰，并文档说明如何在目标机临时安装（若包管理器可用）。
- **不在 Remote 自动 apt/yum 安装**：避免侵入式变更；Host 可生成 **可选** 安装命令供用户手动确认执行。
- 采集器自身 **静态链接**，不依赖目标机 glibc 以外的调试库。

#### 6.9.3 Host 端工具链配置

VSCode 插件 settings 中需支持为每个 target 指定：

```json
{
  "hostToolchain": {
    "gdbPath": "C:/tools/arm-linux-gdb.exe",
    "sysroot": "D:/build/rootfs/",
    "elfPath": "D:/build/app/myapp"
  }
}
```

Remote 无 gdb 时，Core Dump 解析完全依赖上述 Host 配置。

### 6.10 Host 引导安装 Remote 调试环境

**可以。** Host 应提供「调试环境配置向导」，与 core dump 向导采用同一套交互模式；但 **默认不自动安装**，所有变更须经用户预览并确认后，通过 SSH 执行 **白名单内** 的命令。

#### 6.10.1 设计边界


| 行为                | 是否支持  | 说明                                    |
| ----------------- | ----- | ------------------------------------- |
| 检测缺失工具            | ✅     | `env_probe` 上报，`capabilities.tools.*` |
| 生成安装方案            | ✅     | 按包管理器 / 架构 / 发行版匹配命令或离线包              |
| 用户确认后 SSH 执行      | ✅     | 逐步执行，每步显示 stdout/stderr               |
| 静默自动 apt/yum/opkg | ❌     | 避免未经确认的侵入式变更                          |
| 强制安装完整开发镜像        | ❌     | 嵌入式 Flash 有限，只装必要组件                   |
| 离线推送静态二进制         | ✅（可选） | 无包管理器时，Host 上传预编译 gdb/perf            |


#### 6.10.2 推荐安装策略（分层）

**Tier 0 — 监控必需（向导默认勾选）**

不依赖 gdb/perf，Harness 核心能力即可工作：

- core dump 配置（§6.8）
- journal / dmesg 读权限
- Harness-Remote 采集器本身

**Tier 1 — 现场诊断增强（用户可选）**


| 工具        | 典型包名                    | 用途                       | 体积考量            |
| --------- | ----------------------- | ------------------------ | --------------- |
| gdb       | `gdb` / `gdb-multiarch` | Remote 现场 `bt`、attach 进程 | 较大，可选 multiarch |
| gdbserver | `gdbserver`             | Host gdb 远程调试            | 小，常与 gdb 配套     |
| perf      | `linux-perf` / `perf`   | CPU 采样、火焰图               | 需内核符号，部分嵌入式无    |
| strace    | `strace`                | 系统调用跟踪                   | 中等              |
| tcpdump   | `tcpdump`               | 网络抓包（若问题在网络）             | 小               |


**Tier 2 — 符号化与深度分析（优先 Host 端）**

- `addr2line`、`readelf`、`objdump` — 若 Remote 无，**不强制安装**，Host 交叉工具链承担。

原则：**Tier 0 必须引导；Tier 1 按需勾选；Tier 2 默认在 Host 完成。**

#### 6.10.3 包管理器识别与命令模板

`env_probe` 探测包管理器类型，Host 向导选择对应模板：


| 包管理器                  | 探测方式                 | 安装示例                                |
| --------------------- | -------------------- | ----------------------------------- |
| apt (Debian/Ubuntu)   | `/usr/bin/apt-get`   | `apt-get install -y gdb gdbserver`  |
| yum/dnf (RHEL/Fedora) | `command -v dnf`     | `dnf install -y gdb gdbserver perf` |
| opkg (OpenWrt)        | `/bin/opkg`          | `opkg update && opkg install gdb`   |
| apk (Alpine)          | `/sbin/apk`          | `apk add gdb`                       |
| ipk / 自定义             | 读取 `/etc/os-release` | Host 使用用户自定义模板                      |


向导 UI 展示：

1. 当前缺失工具列表
2. 将要执行的命令（可编辑）
3. 预估磁盘占用（若包管理器支持 `--dry-run` / `info`）
4. 「执行」「跳过」「复制到终端手动执行」三个选项

#### 6.10.4 无包管理器 / 离线嵌入式场景

许多 Buildroot/Yocto 镜像 **没有在线包管理器**，此时 Host 向导提供：

**方案 A — 静态二进制推送**

```text
Host 本地维护按架构预编译的工具包（如 armhf-static-gdb.tar.gz）
  -> SCP 到 Remote /opt/harness-tools/
  -> 可选写入 PATH 或 Harness 专用环境脚本
  -> env_probe 重新检测
```

**方案 B — 仅文档指引**

生成说明：「请在构建系统中启用 `BR2_PACKAGE_GDB`，重新烧录 rootfs」，不尝试 Remote 安装。

**方案 C — 混合**

core dump + 日志监控在现有镜像上即可；gdb/perf 仅在 **开发专用 rootfs** 或 **可写 overlay 分区** 上推送。

#### 6.10.5 安装向导流程

```text
连接 Remote -> capabilities 上报 tools.*.available == false
  -> Host UI「调试环境」页签显示缺失项
  -> 用户点击「配置调试环境」
  -> 选择 Tier 1 组件（gdb / perf / strace ...）
  -> Host 根据 pkgManager 生成命令列表
  -> 用户预览 -> 确认
  -> SSH 逐步执行（白名单：install、which、test -x）
  -> 每步成功/失败实时展示
  -> 完成后 env_probe 刷新 capabilities
  -> 若 perf 安装成功但内核无 `CONFIG_PERF_EVENTS` -> 提示内核限制，非安装失败
```

与 core dump 向导共用 `remoteSetup.ts` 模块，统一为 **「Remote 环境向导」** 框架。

#### 6.10.6 安全与回滚

- 安装命令限于 **预定义模板 + 用户编辑**，禁止任意 shell 注入。
- SSH 执行用户使用 **最小权限**；若需 root，向导明确提示 `sudo` 步骤并单独确认。
- 可选记录「安装前已存在包列表」，支持 **卸载指引**（生成 `apt remove` 等命令，同样需用户确认）。
- 安装失败不 rollback 系统；仅上报错误，保留已成功的步骤状态。

#### 6.10.7 与 Host 工具链的关系

```text
                    Remote 有 gdb          Remote 无 gdb
Core Dump 解析      可选 Remote 快速 bt     Host 交叉 gdb + SCP core
现场 attach 调试    gdbserver @ Remote      需先完成 Tier 1 安装
perf 火焰图         Remote perf record      不可用，仅 /proc 指标
```

**结论：Host 可以且应该引导在 Remote 安装调试环境，但这是可选增强路径；Harness 核心监控不依赖 Remote 侧 gdb/perf，安装行为必须用户显式确认。**

### 6.11 多架构构建与分发

**是的。** Harness-Remote 是跑在目标机上的 **原生二进制**，必须与 Remote Linux 的 **CPU 架构 + ABI + C 库** 一致。Host 插件（x86_64 Windows/Linux/macOS）与 Remote 架构无关，但 **采集器本身必须按目标架构分别编译发布**。

#### 6.11.1 为什么必须多架构


| 因素  | 说明                                            |
| --- | --------------------------------------------- |
| 指令集 | x86_64 二进制无法在 aarch64 / armhf 上运行             |
| ABI | armhf（gnueabihf）与 armel（gnueabi）、aarch64 互不兼容 |
| C 库 | glibc 与 musl 需分别构建或静态链接规避                     |
| 字节序 | 嵌入式几乎均为 little-endian；若遇 big-endian 需单独产物     |


不能用 Host 上的 x86_64 采集器通过 QEMU 在 ARM 板子上跑——Remote 端必须是 **目标架构的原生 ELF**。

#### 6.11.2 推荐支持的架构矩阵

按嵌入式 Linux 常见程度划分优先级：


| 优先级         | `uname -m`          | Harness 产物命名                   | 典型场景                           |
| ----------- | ------------------- | ------------------------------ | ------------------------------ |
| **P0 必支持**  | `aarch64` / `arm64` | `harness-remote-linux-aarch64` | 现代 ARM64 板卡、RK3588、树莓派 64 位    |
| **P0 必支持**  | `armv7l` / `armhf`  | `harness-remote-linux-armhf`   | Cortex-A7/A9 等 32 位 hard-float |
| **P1 建议支持** | `x86_64`            | `harness-remote-linux-x86_64`  | 工控机、网关、QEMU/x86 仿真             |
| **P2 按需扩展** | `riscv64`           | `harness-remote-linux-riscv64` | RISC-V 开发板                     |
| **P2 按需扩展** | `mips` / `mipsel`   | `harness-remote-linux-mipsel`  | 路由器、旧 MIPS 设备                  |
| **P3 少见**   | `i686`              | `harness-remote-linux-i686`    | 极老 x86 嵌入式                     |


**首版建议至少交付 P0 + P1 三种**：`aarch64`、`armhf`、`x86_64`，覆盖绝大多数 Embedded Linux 项目。

#### 6.11.3 构建策略

```text
harness-remote/
├── Makefile / CMakeLists.txt
├── build/
│   ├── build-aarch64-linux-musl.sh
│   ├── build-armhf-linux-musl.sh
│   └── build-x86_64-linux-musl.sh
└── dist/
    ├── harness-remote-linux-aarch64   # 静态 musl，无 libc 依赖
    ├── harness-remote-linux-armhf
    └── harness-remote-linux-x86_64
```

推荐做法：

- **静态链接 musl**：单个可执行文件，避免目标机 glibc 版本不一致（尤其 Yocto/Buildroot 定制 rootfs）。
- **交叉编译**：在 Host CI（x86_64）上用 `aarch64-linux-musl-gcc`、`arm-linux-musleabihf-gcc` 等工具链构建。
- **可选 glibc 动态版**：面向 Debian/Ubuntu 等标准发行版，体积更小，但需匹配目标 glibc 版本；作为 musl 静态版的备选产物。

#### 6.11.4 Host 端如何选择并部署正确版本

连接 Remote 后，`env_probe` 上报架构信息：

```json
{
  "arch": {
    "machine": "aarch64",
    "normalized": "aarch64",
    "libc": "glibc",
    "endian": "little"
  }
}
```

探测来源：`uname -m`、`ldd --version` 或 `/lib/libc.so.6` 存在性、Alpine 检测 `/etc/alpine-release`。

Host 插件逻辑：

```text
SSH 连接成功
  -> 读取 uname -m + libc 类型
  -> 映射到产物名 harness-remote-linux-{arch}[-musl|-glibc]
  -> 检查 Remote 是否已安装 harness-remote且版本匹配
  -> 若未安装或版本过旧：
       从插件内置 dist/ 或 CDN 取对应架构二进制
       SCP 到 Remote（如 /usr/local/bin/harness-remote）
       chmod +x，启动 systemd 单元
  -> 架构无匹配产物时：明确报错，提示从源码交叉编译，不尝试错误架构
```

**禁止**在 aarch64 目标上推送 armhf 二进制「碰运气」——应硬失败并列出支持的架构。

#### 6.11.5 与调试工具包架构的关系

§6.10 中「离线推送 gdb/perf」同样 **按架构分包**：

```text
tools/
├── gdb-aarch64-static.tar.gz
├── gdb-armhf-static.tar.gz
├── gdb-x86_64-static.tar.gz
└── perf-...   # perf 还依赖内核版本，比 harness-remote 更复杂
```

Harness-Remote 采集器与调试工具包 **独立版本管理**，但共用同一套 `uname -m` → 产物映射表。

#### 6.11.6 架构探测与 armhf 命名注意


| `uname -m` 输出                  | 归一化产物     |
| ------------------------------ | --------- |
| `aarch64`, `arm64`             | `aarch64` |
| `armv7l`, `armv6l`（hard float） | `armhf`   |
| `x86_64`, `amd64`              | `x86_64`  |
| `i686`, `i386`                 | `i686`    |


arm 32 位需确认 hard-float（`/proc/cpuinfo` 含 `vfp` / `neon`）；极少数 soft-float（armel）设备需单独 `armel` 产物，首版可文档说明不支持。

#### 6.11.7 发布与版本清单

每个发行版附带 `manifest.json`：

```json
{
  "version": "1.0.0",
  "artifacts": [
    { "arch": "aarch64", "libc": "musl", "sha256": "...", "size": 412000 },
    { "arch": "armhf",   "libc": "musl", "sha256": "...", "size": 398000 },
    { "arch": "x86_64",  "libc": "musl", "sha256": "...", "size": 445000 }
  ]
}
```

VSCode 插件打包时内置 P0/P1 产物；体积过大时可改为首次连接时按需下载。

---

## 7. MCU 设计

### 7.1 MCU 侧职责

MCU 通常无完整 OS、无网络协议栈、无复杂运行环境，因此不应承载 Agent 或 Harness runtime。

MCU 仅负责：

- 调试日志输出
- 关键状态事件上报
- 结构化错误信息输出

### 7.2 日志格式

推荐使用 JSON Lines 格式，方便 Host 统一解析与索引：

```json
{"ts":1234567,"lvl":"WARN","mod":"motor","msg":"overcurrent","val":842}
{"ts":1234689,"lvl":"ERROR","mod":"net","msg":"rx_timeout","pkt":51}
```

字段建议：

- ts: Unix time / tick count
- lvl: DEBUG / INFO / WARN / ERROR
- mod: 模块名
- msg: 事件描述
- val: 可选数值
- raw: 可选原始内容

### 7.3 传输通道


| 通道         | 说明             | 适用场景    |
| ---------- | -------------- | ------- |
| SEGGER RTT | 低侵入、高可靠、无需额外引脚 | 开发调试    |
| UART       | 通用性高，适合量产和现场调试 | 生产/现场调试 |
| SWO        | 单线输出，适合高带宽场景   | 特定硬件支持  |


### 7.4 Host 侧读取

Host 端的 VSCode 插件负责：

- 读取 RTT 缓冲区或串口数据流
- 按行解析 JSON 日志
- 做时间同步、过滤、告警和存储
- 将日志与 Linux syslog 统一时间线展示

MCU 日志不应在 MCU 上做复杂汇总，所有处理都在 Host 侧执行。

---

## 8. Host 端 VSCode Harness 插件

### 8.1 模块结构

```text
extension/
├── src/
│   ├── extension.ts            # 激活入口、命令注册
│   ├── core/
│   │   ├── session.ts          # 会话与设备连接生命周期
│   │   ├── aggregator.ts       # Linux + MCU 数据聚合
│   │   ├── alertEngine.ts      # CPU / 内存 / 日志阈值告警
│   │   ├── historyStore.ts     # SQLite / 文件持久化
│   │   ├── targetManager.ts    # 多目标设备管理
│   │   ├── remoteSetup.ts      # core dump 向导、capabilities 处理
│   │   └── logWatchConfig.ts   # 自定义日志路径配置的读写与下发
│   ├── transport/
│   │   ├── sshClient.ts        # Linux SSH 连接管理
│   │   ├── wsClient.ts         # Remote 推送接收（可选）
│   │   ├── jlinkReader.ts      # J-Link RTT 读取
│   │   └── serialReader.ts     # 串口读取
│   ├── parsers/
│   │   ├── metricsParser.ts    # 指标解析
│   │   ├── logParser.ts        # syslog / journal / dmesg / 自定义 / MCU 日志解析
│   │   └── coredumpParser.ts   # Host 端 GDB 解析入口
│   ├── ui/
│   │   ├── metricsPanel.ts     # CPU / 内存图表 Webview
│   │   ├── logView.ts          # 统一日志视图（多源过滤）
│   │   ├── coredumpView.ts     # 栈回溯展示
│   │   ├── targetConfigView.ts # target 配置：日志路径、工具链
│   │   └── coredumpWizard.ts   # core dump 启用向导
│   └── mcp/
│       ├── server.ts           # MCP server
│       └── tools.ts            # Harness 数据工具封装
├── media/
│   └── charts/
├── package.json
└── README.md
```

### 8.2 核心能力

#### 8.2.1 实时监控面板

- 支持多目标切换
- 按时间聚合展示 CPU / 内存 / 负载曲线
- 展示 Top 进程列表
- 支持筛选特定模块 / 设备

#### 8.2.2 日志聚合

- 合并 Linux 多源日志：syslog 文件、systemd journal、dmesg、用户配置的自定义路径
- 合并 MCU RTT / 串口日志
- 统一时间轴，按来源着色或标签区分（如 `journal`、`dmesg`、`custom:app-main`）
- 支持级别过滤、关键词高亮、模块过滤、来源过滤
- journal 中服务崩溃条目（`code=dumped`）高亮并关联 Core Dump 事件
- 可导出为 `.log` 或 JSON

#### 8.2.3 Remote 环境配置（连接后首屏）

连接 Remote Linux 后，插件根据 `capabilities` 展示环境摘要：


| 状态项          | 正常    | 异常时的 Host 行为             |
| ------------ | ----- | ------------------------ |
| core dump    | ✅ 已启用 | 弹出配置向导，按 init 类型生成脚本     |
| journal      | ✅ 可用  | 降级为 syslog + dmesg       |
| dmesg        | ✅ 可用  | 提示权限或 kmsg 访问问题          |
| gdb（Remote）  | 可选    | 不阻塞；提示使用 Host 工具链        |
| perf（Remote） | 可选    | 「采样分析」置灰；可打开「调试环境向导」引导安装 |
| 自定义日志路径      | 用户配置  | 路径不存在时告警，不阻塞其他源          |


用户可在 **「Remote 环境向导」** 中一次性处理 core dump 启用与调试工具安装；两者共用确认式 SSH 执行框架。

#### 8.2.4 Core Dump 解析

流程：

1. Remote 端通过文件 inotify、coredumpctl 或 journal 事件发现崩溃
2. Host 通过 SCP / SFTP 拉取 core，或通过 `coredumpctl dump` 导出
3. 解析文件元数据：signal、time、进程名、架构
4. 使用 **Host 端** 配置的交叉 `gdb` + `sysroot` + `elfPath` 解析 backtrace（不依赖 Remote 是否有 gdb）
5. 在 VSCode 面板展示调用栈；若仅有 journal 记录无 core 文件，展示 journal 摘要并标记 `source: journal-only`

#### 8.2.5 告警引擎

告警规则包括：

- CPU 使用率持续超过 90%
- 内存持续增长且超过阈值
- 日志中出现 ERROR/WARN 关键词
- core dump 触发事件
- 调试端口或网络连接中断

告警策略：

- VSCode 通知
- 日志记录
- 可选语音 / 弹窗 / 回调扩展

---

## 9. 通信协议与数据契约

### 9.1 通信路径


| 目标             | 主协议        | 备选协议            | 说明                    |
| -------------- | ---------- | --------------- | --------------------- |
| Embedded Linux | SSH        | WebSocket / TCP | Host 主动连接，Remote 事件上报 |
| MCU            | J-Link RTT | UART            | Host 主动读取，低侵入且稳定      |


### 9.2 基础协议约定

所有消息建议具备以下字段：

```json
{
  "protocolVersion": 1,
  "targetId": "board-a",
  "timestamp": 1723456789000,
  "type": "metrics|log|event|heartbeat|capabilities|error",
  "payload": {}
}
```

其中：

- protocolVersion: 协议版本号
- targetId: 目标设备标识
- timestamp: UTC / Unix ms
- type: 消息类型
- payload: 结构化载荷

### 9.3 数据模型

#### 9.3.1 MetricsSnapshot

```typescript
interface MetricsSnapshot {
  targetId: string;
  timestamp: number;
  cpu: {
    usagePercent: number;
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    totalKb: number;
    freeKb: number;
    availableKb: number;
    swapUsedKb: number;
  };
  topProcesses: Array<{
    pid: number;
    name: string;
    cpuPercent: number;
    memKb: number;
  }>;
}
```

#### 9.3.2 LogEntry

```typescript
interface LogEntry {
  targetId: string;
  source:
    | 'linux-syslog'
    | 'linux-journal'
    | 'linux-dmesg'
    | 'linux-custom'   // 用户配置的自定义路径，customLogId 标识具体文件
    | 'mcu-rtt'
    | 'mcu-uart';
  customLogId?: string;  // 对应 customLogPaths[].id
  timestamp: number;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  module?: string;
  message: string;
  raw?: string;
}
```

#### 9.3.3 CoreDumpEvent

```typescript
interface CoreDumpEvent {
  targetId: string;
  detectedAt: number;
  source: 'filesystem' | 'coredumpctl' | 'journal-only';
  remotePath?: string;       // filesystem 模式下的路径；journal-only 时为空
  coredumpctlId?: string;    // coredumpctl 模式下的条目 ID
  localPath?: string;        // Host 拉取后的本地路径
  pid?: number;
  executable?: string;
  signal?: number;
  backtrace?: string[];
}
```

#### 9.3.4 TargetCapabilities

连接建立后 Remote 上报一次，配置变更或周期性刷新：

```typescript
interface TargetCapabilities {
  targetId: string;
  init: 'systemd' | 'sysv' | 'busybox' | 'unknown';
  logSources: Array<'syslog' | 'journal' | 'dmesg' | 'custom'>;
  arch: {
    machine: string;           // uname -m 原始值，如 armv7l
    normalized: 'aarch64' | 'armhf' | 'x86_64' | 'riscv64' | 'mipsel' | 'i686' | 'unknown';
    libc: 'glibc' | 'musl' | 'unknown';
    endian: 'little' | 'big' | 'unknown';
  };
  tools: {
    gdb?: { available: boolean; version?: string };
    gdbserver?: { available: boolean; version?: string };
    perf?: { available: boolean; version?: string };
    coredumpctl?: { available: boolean; version?: string };
    readelf?: { available: boolean };
  };
  coreDump: {
    enabled: boolean;
    ulimitCore: string;          // 如 "0" 或 "unlimited"
    pattern: string;             // /proc/sys/kernel/core_pattern 原始值
    storageWritable?: boolean;
    recommendedSetup: 'ulimit-pattern' | 'systemd-coredump' | 'unknown';
  };
}
```

#### 9.3.5 Heartbeat

```json
{
  "protocolVersion": 1,
  "targetId": "board-a",
  "timestamp": 1723456789000,
  "type": "heartbeat",
  "payload": {
    "status": "online",
    "uptimeSeconds": 3600,
    "version": "1.2.0"
  }
}
```

### 9.4 事件语义

- 心跳：用于检测连接存活
- 指标：周期性报告 CPU / 内存 / 负载
- 日志：syslog、journal、dmesg、自定义路径、MCU 调试日志
- capabilities：Remote 环境能力清单（日志源、工具链、core dump 状态）
- 事件：core dump、journal 崩溃条目、`log_source_unavailable`、重启
- 错误：采集失败或解析失败的异常说明

### 9.5 协议约束

- Host 与 Remote 必须具备版本协商机制
- 旧版本消息需降级处理
- 缺失字段不应导致解析崩溃
- 严重错误必须显式返回 `error` 包，而非静默丢失
- 协议必须考虑丢帧、重连和重复消息场景

---

## 10. 可靠性与故障处理

### 10.1 关键故障模式


| 场景                 | 影响       | 设计处理                                  |
| ------------------ | -------- | ------------------------------------- |
| Remote Linux 采集器崩溃 | 指标中断     | 父进程重启，systemd watchdog 兜底             |
| SSH 断开             | 连接丢失     | 自动重连，重试退避，保留最近状态                      |
| MCU RTT 缓冲区满       | 日志丢失     | 限制日志级别，Host 做流控与告警                    |
| core dump 拉取失败     | 无法符号化    | 重试 + 本地缓存 + 明确错误提示                    |
| 历史存储写满             | 数据丢失     | 轮询清理，保留配置天数，压缩归档                      |
| 时钟不同步              | 日志时间错乱   | 使用统一时间源，记录本地偏移                        |
| core dump 未启用      | 崩溃无法分析   | 连接时检测，Host 向导引导配置                     |
| journal 不可用        | 服务崩溃信息缺失 | 降级 syslog + dmesg，UI 提示               |
| 自定义日志路径错误          | 业务日志看不到  | 上报 `log_source_unavailable`，不阻塞其他源    |
| Remote 无 gdb/perf  | 现场分析受限   | Host 端工具链解析 core；或引导用户经向导安装 Remote 工具 |


### 10.2 连接状态机

```text
Disconnected
  -> connect()
  -> Connecting
  -> Connected
      -> Sampling
      -> Reconnect on error
      -> Disconnect
```

状态要求：

- 连接失败必须记录日志并触发重试
- 断线后不直接清除历史数据
- 采集器必须在恢复后重新建立完整上下文
- Host 要保证冗余状态判断，而不是依赖单一连接

### 10.3 日志与告警的容错

- 非关键日志允许丢失，但必须记录“丢帧”事件
- 关键错误日志应持久化到 Host 本地缓冲区
- 告警的生成逻辑必须基于窗口状态，不应由单个瞬时峰值直接触发错误告警

---

## 11. 安全与合规

### 11.1 权限控制

- SSH 使用密钥认证，禁止密码登录
- 仅授予最小必要权限
- `deploy` 用户仅允许有限执行脚本和读取数据
- 禁止在 Remote 端执行任意命令或加载外部脚本

### 11.2 数据安全

- WebSocket / TCP 传输使用 TLS（如果走网络）
- 内网环境可接受 VPN + 隐私网段方案，但必须有明确安全边界
- core dump 文件包含敏感内存内容，拉取后应保存在受控目录
- 日志中不得输出明文密钥、认证 token 或用户密码

### 11.3 版本和兼容

所有 Host / Remote 接口都必须具备：

- protocolVersion 字段
- 向后兼容策略
- 版本不匹配时的降级处理

---

## 12. 风险评估与缓解


| 风险                   | 影响        | 可能原因                | 缓解方案                    |
| -------------------- | --------- | ------------------- | ----------------------- |
| Remote 采集器占用资源       | 影响主业务     | 采集过频、日志过大           | 采样间隔限制、低优先级、缓存上限        |
| 连接中断导致监控缺失           | 数据空洞      | 网络抖动、串口问题、设备重启      | 心跳 + 自动重连 + 最近状态保留      |
| core dump 未配置        | 崩溃无文件     | 嵌入式镜像默认 ulimit -c 0 | 连接时检测 + Host 配置向导       |
| core dump 拉取失败       | 无法分析根因    | 文件过大、路径不稳定、权限不足     | 分段拉取、权限最小化、错误回执         |
| journal / dmesg 权限不足 | 内核/服务日志缺失 | deploy 用户权限不足       | 最小权限 ACL 或 group 加入     |
| 自定义日志路径失效            | 业务日志断流    | 路径变更、轮转、权限          | 事件告警 + 配置页手动修正          |
| MCU 日志缓冲区满           | 关键事件丢失    | 输出频率太高              | 限制日志等级、轮询提取、ring buffer |
| 版本不一致                | 解析异常      | Host / Remote 升级不同步 | protocolVersion + 兼容层   |
| 安全泄露                 | 敏感信息外传    | 日志明文、core 文件未隔离     | 最小权限、TLS、受控目录           |
| AI/MCP 误用            | 调试依赖复杂化   | 外部工具过度扩展            | 让 AI 仅作为增强层，视为可选        |


---

## 13. 实施路线图

### Phase 1：基础监控（必做）

1. 实现 Remote Linux 采集器：/proc、loadavg、进程快照
2. 实现 env_probe：日志源与工具链能力探测
3. 实现 dmesg 增量采集 + syslog 文件 tail
4. 实现 Remote 自守护与 watchdog
5. VSCode 插件与 Host 建立 SSH 连接，展示 capabilities 摘要
6. 展示实时 CPU / 内存曲线与多源日志视图
7. Host 端支持手动配置自定义日志路径并下发
8. MCU 日志宏输出 JSON Lines，Host 读取并显示

目标：实现最小可用的实时嵌入式监控能力。

### Phase 2：稳定性与诊断（必做）

1. 完成 systemd journal 采集与服务崩溃条目识别
2. 完成 core dump 启用状态检测与 Host 配置向导（ulimit / systemd-coredump）
3. 完成 core dump 文件检测、coredumpctl 集成与 Host 端 GDB 回溯解析
4. Host 完成本地历史存储与告警引擎
5. 支持断线重连、丢帧处理、状态恢复
6. 建立 Linux（syslog / journal / dmesg / 自定义）+ MCU 日志统一时间线

目标：让 Harness 能够稳定支撑调试和异常排查。

### Phase 3：智能增强（可选）

1. 在 Host 端暴露 MCP Server
2. 封装 metrics / logs / coredump 查询工具
3. 与 Claude / Cursor / Copilot 等 Agent 对接
4. 提供诊断模板：CPU 峰值、内存泄漏、launch 异常
5. Remote 调试环境向导：多包管理器模板、离线静态工具包推送

目标：在 Harness 稳定后，让 AI 作为智能分析增强层叠加进来，并完善 Remote 侧可选调试能力的一键配置。

---

## 14. 时间同步与时间戳处理

嵌入式设备的时间同步是日志分析的关键问题。许多嵌入式系统缺少 RTC 硬件或电池耗尽，导致启动时时间戳不准确。

### 14.1 常见时间问题


| 场景       | 表现                      | 影响                  |
| -------- | ----------------------- | ------------------- |
| 无 RTC    | 启动时时间为 1970-01-01 或编译时间 | 日志时间戳完全错误           |
| RTC 电池耗尽 | 每次启动时间重置                | 无法关联多次启动的事件         |
| NTP 未同步  | 启动后数分钟内时间不准             | 早期日志时间偏移            |
| 时区配置错误   | 时间偏移固定小时数               | Host/Remote 时间线对齐困难 |
| 无网络连接    | 永久无法 NTP 同步             | 长期时间漂移              |


### 14.2 时间同步状态检测

Harness-Remote 在 `env_probe` 阶段检测时间同步状态，纳入 `capabilities` 上报：

```c
// 检测项
bool detect_time_sync_status(TimeSyncStatus *status) {
    // 1. 检查 systemd-timesyncd 状态
    if (system("systemctl is-active systemd-timesyncd.service") == 0) {
        status->method = "systemd-timesyncd";
        status->synced = check_timedatectl_sync();
        return true;
    }
    
    // 2. 检查 ntpd/chrony
    if (access("/var/run/ntpd.pid", F_OK) == 0) {
        status->method = "ntpd";
        status->synced = check_ntp_sync();
        return true;
    }
    
    // 3. 检查 /sys/class/rtc/rtc0 是否存在
    status->has_rtc = (access("/sys/class/rtc/rtc0", F_OK) == 0);
    
    // 4. 检测明显错误的时间（< 2020 年）
    time_t now = time(NULL);
    status->time_plausible = (now > 1577836800);  // 2020-01-01
    
    return true;
}
```

上报格式：

```json
{
  "timeSync": {
    "method": "systemd-timesyncd" | "ntpd" | "chrony" | "none",
    "synced": true,
    "hasRTC": false,
    "currentTime": 1723456789,
    "timePlausible": false,
    "bootTime": 1723450000,
    "uptime": 6789
  }
}
```

### 14.3 时间戳策略

#### 14.3.1 三层时间戳体系


| 时间戳类型              | 来源                        | 用途            | 可靠性    |
| ------------------ | ------------------------- | ------------- | ------ |
| **wall time**      | `time()` / `/proc/uptime` | 绝对时间，用于跨设备关联  | 依赖同步状态 |
| **boot time**      | `CLOCK_BOOTTIME`          | 相对启动时间，单设备内序列 | 高可靠    |
| **monotonic time** | `CLOCK_MONOTONIC`         | 单调递增，不受时间调整影响 | 最高可靠   |


#### 14.3.2 Remote 端时间戳采集

所有数据包同时携带三种时间戳：

```json
{
  "timestamp": {
    "wall": 1723456789000,
    "boot": 6789123,
    "mono": 6789456
  },
  "payload": { ... }
}
```

采集代码示例：

```c
void get_timestamps(Timestamps *ts) {
    struct timespec wall, boot, mono;
    
    clock_gettime(CLOCK_REALTIME, &wall);
    clock_gettime(CLOCK_BOOTTIME, &boot);
    clock_gettime(CLOCK_MONOTONIC, &mono);
    
    ts->wall_ms = wall.tv_sec * 1000 + wall.tv_nsec / 1000000;
    ts->boot_ms = boot.tv_sec * 1000 + boot.tv_nsec / 1000000;
    ts->mono_ms = mono.tv_sec * 1000 + mono.tv_nsec / 1000000;
}
```

#### 14.3.3 Host 端时间校准

Host 接收到数据后的处理逻辑：

```typescript
interface TimeCalibration {
  remoteWallOffset: number;  // Remote wall time - Host wall time
  remoteBootBase: number;    // Remote boot time 0 点对应的 Host wall time
  lastSync: number;          // 上次校准时间
  reliability: 'high' | 'medium' | 'low';
}

function calibrateTime(
  remoteTs: Timestamps,
  hostReceiveTime: number,
  calibration: TimeCalibration
): number {
  // 策略 1: 如果 Remote wall time 可信（已同步且时间合理）
  if (remoteTimeSyncStatus.synced && remoteTimeSyncStatus.timePlausible) {
    // 使用 wall time，考虑网络延迟
    const networkLatency = estimateLatency();
    return remoteTs.wall + networkLatency;
  }
  
  // 策略 2: wall time 不可信，使用 boot time + 基准点
  if (calibration.remoteBootBase) {
    return calibration.remoteBootBase + remoteTs.boot;
  }
  
  // 策略 3: 首次连接，建立基准点（假设连接时刻 Remote 与 Host 时间对齐）
  calibration.remoteBootBase = hostReceiveTime - remoteTs.boot;
  calibration.reliability = 'low';
  return hostReceiveTime;
}
```

### 14.4 时间异常处理


| 异常类型         | 检测方法                | Host 处理                         |
| ------------ | ------------------- | ------------------------------- |
| 1970 年时间戳    | `wall < 2020-01-01` | 标记为不可信，使用 boot time，UI 显示"相对时间" |
| 时间倒退         | 当前 wall < 上次 wall   | 检测到 NTP 调整或重启，重新校准              |
| boot time 重置 | boot < 上次 boot      | 设备重启，创建新会话分段                    |
| 巨大时间跳跃       | |当前 - 上次| > 1小时     | 标记异常，通知用户检查时间同步                 |


### 14.5 日志展示策略

Host 端 UI 提供多种时间显示模式：

```typescript
enum TimeDisplayMode {
  AbsoluteUTC,      // 2024-08-12 10:23:45 UTC（需 wall time 可信）
  AbsoluteLocal,    // 2024-08-12 18:23:45 CST（需 wall time 可信）
  RelativeBoot,     // +01:53:09（相对启动时间，始终可用）
  RelativeConnect,  // +00:15:32（相对连接时刻，便于调试）
}
```

不可信时间的 UI 呈现：

```
⚠️ Remote 时间未同步，显示为相对时间
[+00:15:32] ERROR kernel: segmentation fault at 0x12345678
```

### 14.6 MCU 时间戳处理

MCU 通常无准确 Unix time，只有 tick 计数：

```c
// MCU 日志宏
#define LOG_ERROR(mod, msg, ...) \
    printf("{\"tick\":%lu,\"lvl\":\"ERROR\",\"mod\":\"%s\",\"msg\":\"" msg "\"}\n", \
           HAL_GetTick(), mod, ##__VA_ARGS__)
```

Host 处理：

```typescript
interface MCULogEntry {
  tick: number;           // MCU tick (ms)
  hostReceiveTime: number; // Host 接收时间戳
  estimatedTime?: number;  // 估算的实际时间
}

// 基于第一条日志建立映射关系
function calibrateMCUTime(log: MCULogEntry, session: MCUSession) {
  if (!session.tickBase) {
    session.tickBase = log.tick;
    session.timeBase = log.hostReceiveTime;
  }
  
  // 估算实际时间（假设传输延迟恒定）
  const elapsedMs = log.tick - session.tickBase;
  log.estimatedTime = session.timeBase + elapsedMs;
}
```

MCU 重启检测：

- tick 值突然变小 → 检测到重启 → 重置 tickBase
- tick 溢出（32位 uint 约 49 天）→ 处理溢出

### 14.7 跨设备事件关联

当监控多个设备时，时间同步尤为重要：

```typescript
// 多设备日志合并展示
function mergeMultiDeviceLogs(devices: Device[]): LogEntry[] {
  return devices
    .flatMap(d => d.logs.map(log => ({
      ...log,
      deviceId: d.id,
      // 使用校准后的时间戳
      normalizedTime: calibrateTime(log.timestamp, d.calibration),
      // 标记时间可信度
      timeReliability: d.timeSyncStatus.synced ? 'high' : 'low'
    })))
    .sort((a, b) => a.normalizedTime - b.normalizedTime);
}
```

UI 显示多设备时间线时，对不可信时间戳的条目添加视觉提示（如虚线连接、半透明显示）。

---

## 15. 性能测试与基准

§6.5 中设定的资源约束目标（常驻内存 < 2 MB，CPU < 1%）需要在真实环境中验证和持续监控。

### 15.1 测试环境矩阵


| 配置档位   | CPU                  | RAM    | 存储           | 典型场景        |
| ------ | -------------------- | ------ | ------------ | ----------- |
| **低端** | Cortex-A7 单核 600MHz  | 256 MB | 128 MB Flash | 工业网关、低成本物联网 |
| **中端** | Cortex-A53 四核 1.2GHz | 1 GB   | 8 GB eMMC    | 开发板、智能设备    |
| **高端** | Cortex-A72 四核 1.8GHz | 4 GB   | 32 GB SSD    | 工控机、边缘服务器   |


性能目标应按档位分级：


| 指标           | 低端目标     | 中端目标     | 高端目标     |
| ------------ | -------- | -------- | -------- |
| 常驻内存（RSS）    | < 2 MB   | < 3 MB   | < 5 MB   |
| CPU 占用（空闲）   | < 0.5%   | < 0.3%   | < 0.2%   |
| CPU 占用（采集峰值） | < 5%     | < 3%     | < 2%     |
| 启动时间         | < 2 s    | < 1 s    | < 500 ms |
| 日志处理延迟       | < 500 ms | < 200 ms | < 100 ms |


### 15.2 内存测量方法

#### 15.2.1 RSS 测量（常驻物理内存）

```bash
# 方法 1：通过 /proc 读取
cat /proc/$(pidof harness-remote)/status | grep VmRSS

# 方法 2：使用 ps
ps -o pid,rss,vsz,cmd -p $(pidof harness-remote)

# 方法 3：持续监控
watch -n 1 "ps -o rss,cmd -p \$(pidof harness-remote)"
```

#### 15.2.2 内存泄漏检测

```bash
# 使用 Valgrind（开发阶段，x86_64 环境）
valgrind --leak-check=full \
         --show-leak-kinds=all \
         --track-origins=yes \
         --log-file=valgrind.log \
         ./harness-remote

# 长期运行测试（生产环境）
# 每小时记录一次 RSS，绘制趋势图
*/60 * * * * echo "$(date +%s) $(cat /proc/$(pidof harness-remote)/status | grep VmRSS)" >> /tmp/rss.log
```

预期结果：

- 启动后 RSS 应在 30 秒内稳定
- 24 小时运行 RSS 增长应 < 100 KB（允许缓存区适度增长）
- 7 天运行无明显泄漏趋势

#### 15.2.3 内存优化检查清单

- [ ] 所有动态分配有对应的 free
- [ ] 日志缓冲区使用 ring buffer 而非无限增长的链表
- [ ] 避免不必要的字符串拷贝
- [ ] 限制单次采集的数据量（如 top N 进程，不是全部进程）
- [ ] 使用栈内存优于堆内存（小对象）

### 15.3 CPU 占用测量

#### 15.3.1 采样方法

```bash
# 方法 1：top 持续监控
top -b -d 1 -p $(pidof harness-remote) | tee cpu.log

# 方法 2：使用 pidstat（若可用）
pidstat -p $(pidof harness-remote) 1 100

# 方法 3：通过 /proc/stat 计算
# 读取两次之间的 CPU time 差值
cat /proc/$(pidof harness-remote)/stat | awk '{print $14+$15}'
```

#### 15.3.2 CPU 性能剖析

使用 `perf` 找出热点函数（开发阶段）：

```bash
# 记录 30 秒的性能数据
perf record -p $(pidof harness-remote) -g -- sleep 30

# 生成报告
perf report

# 生成火焰图
perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg
```

预期热点：

- `inotify_read()` / `tail_log_file()` — 日志采集
- `parse_proc_meminfo()` — 指标解析
- `json_encode()` — 数据序列化
- `ssh_send()` / `websocket_send()` — 网络发送

优化方向：

- 减少不必要的系统调用
- 避免频繁的小块内存分配
- 使用高效的 JSON 库（如 cJSON）
- 批量发送而非每条日志单独发送

### 15.4 I/O 与网络开销

#### 15.4.1 磁盘 I/O 测量

```bash
# 使用 iotop 监控（若可用）
iotop -p $(pidof harness-remote)

# 或通过 /proc 读取
cat /proc/$(pidof harness-remote)/io
```

目标：

- 采集器本身**不应写磁盘**（除首次配置和异常日志）
- 读 I/O 主要来自 `/proc`、`/sys`、日志文件 tail
- 避免全量读取大文件

#### 15.4.2 网络带宽估算


| 数据类型         | 频率      | 单次大小    | 带宽（Kbps）     |
| ------------ | ------- | ------- | ------------ |
| Metrics      | 每 5s    | 500 B   | 0.8          |
| Syslog       | 10 条/s  | 200 B/条 | 16           |
| Journal      | 5 条/s   | 300 B/条 | 12           |
| Heartbeat    | 每 30s   | 100 B   | 0.027        |
| **总计（正常）**   | -       | -       | **~30 Kbps** |
| **突发（密集日志）** | 100 条/s | 250 B/条 | **200 Kbps** |


优化策略：

- 启用 gzip 压缩（文本压缩率通常 5:1）
- 批量发送（每 1 秒或累积 10 条）
- 限流保护（超过阈值时采样或丢弃低优先级日志）

### 15.5 压力测试场景

#### 15.5.1 日志洪水测试

模拟应用程序疯狂打日志：

```bash
# 生成高速日志流
while true; do
  echo "$(date +%s) ERROR test_module: high frequency log message $RANDOM" >> /var/log/test.log
  usleep 1000  # 1000 条/秒
done
```

验证：

- Harness-Remote CPU 占用应 < 10%
- 日志处理延迟应 < 1 秒
- 不应导致采集器崩溃或内存泄漏
- 应触发限流机制（若实现）

#### 15.5.2 连接中断恢复测试

```bash
# 模拟网络中断
iptables -A OUTPUT -p tcp --dport 22 -j DROP
sleep 60
iptables -D OUTPUT -p tcp --dport 22 -j DROP
```

验证：

- 采集器在断连期间继续运行
- Host 自动重连成功
- 断连期间的关键事件（如 core dump）不丢失
- 恢复后时间戳仍然正确

#### 15.5.3 资源耗尽测试

**内存压力**：

```bash
# 启动内存占用进程，模拟系统内存紧张
stress --vm 1 --vm-bytes 200M --timeout 300s
```

验证：

- Harness-Remote 不被 OOM killer 杀死（oom_score_adj 设置正确）
- 内存紧张时仍能采集 OOM 事件本身
- 降级采集策略（如减少缓存）

**CPU 压力**：

```bash
# 满载 CPU
stress --cpu 4 --timeout 300s
```

验证：

- Harness-Remote 优先级低，不影响业务进程
- 仍能采集到 CPU 100% 的指标
- 响应时间可能延长但不应超时

### 15.6 基准测试套件

建议实现自动化性能测试套件：

```text
harness-remote/
└── tests/
    └── perf/
        ├── benchmark.sh          # 总控脚本
        ├── memory_baseline.sh    # 内存基线测试
        ├── cpu_overhead.sh       # CPU 开销测试
        ├── log_throughput.sh     # 日志吞吐量测试
        ├── stress_test.sh        # 压力测试
        └── report_generator.py   # 生成性能报告
```

CI/CD 集成：

- 每次提交在 QEMU 模拟器上运行基准测试
- 性能退化超过 10% 时测试失败
- 生成性能趋势图，跟踪历史变化

### 15.7 性能监控仪表板

Host 端插件提供"性能监控"视图，实时展示 Harness-Remote 自身的资源占用：

```typescript
interface HarnessPerformance {
  targetId: string;
  timestamp: number;
  harness: {
    pid: number;
    rss_kb: number;           // 常驻内存
    cpu_percent: number;      // CPU 占用
    uptime: number;           // 运行时长
    log_rate: number;         // 日志处理速率（条/秒）
    network_tx_kbps: number;  // 上报带宽
  };
}
```

告警规则：

- RSS 超过 5 MB → 警告
- CPU 持续 > 10% → 警告
- 日志处理延迟 > 5 秒 → 错误

---

## 16. 数据生命周期管理

Host 端会积累大量历史数据，需要清晰的保留和清理策略。

### 16.1 数据分类与保留期


| 数据类型                | 默认保留期     | 磁盘占用估算（单设备/天）   | 可配置        |
| ------------------- | --------- | --------------- | ---------- |
| **实时指标**            | 7 天       | 10 MB（5s 采样）    | ✅ 1-30 天   |
| **聚合指标**            | 90 天      | 2 MB（1min 聚合）   | ✅ 30-365 天 |
| **日志（INFO/DEBUG）**  | 3 天       | 50-500 MB（视日志量） | ✅ 1-14 天   |
| **日志（WARN/ERROR）**  | 30 天      | 5-50 MB         | ✅ 7-90 天   |
| **Core Dump 事件**    | 90 天      | 100 MB - 数 GB   | ✅ 永久或手动清理  |
| **Core Dump 文件**    | 30 天（或手动） | 数 GB            | ⚠️ 需用户明确保留 |
| **告警历史**            | 90 天      | < 1 MB          | ✅ 30-365 天 |
| **Capabilities 快照** | 永久        | < 1 MB          | 🔒 不清理     |


### 16.2 存储架构

```text
~/.vscode-harness/
├── config/
│   └── targets.json              # Target 配置，永久保留
├── data/
│   ├── metrics/
│   │   ├── realtime/             # 实时指标（SQLite 或按天分文件）
│   │   │   ├── board-a-2024-08-12.db
│   │   │   └── board-a-2024-08-13.db
│   │   └── aggregated/           # 聚合指标（长期存储）
│   │       └── board-a-2024-08.db
│   ├── logs/
│   │   ├── board-a-2024-08-12.jsonl.gz  # 按天压缩
│   │   └── board-a-2024-08-13.jsonl.gz
│   ├── events/
│   │   └── board-a.db            # 告警、Core Dump 事件等
│   └── coredumps/
│       ├── board-a-1723456789-app.core.gz  # 压缩存储
│       └── board-a-1723456789-app.bt.txt   # 回溯文本
└── cache/
    └── capabilities/             # Capabilities 缓存
        └── board-a-latest.json
```

### 16.3 清理策略

#### 16.3.1 自动清理触发条件

- **定时清理**：每天凌晨 2:00（用户本地时间）
- **空间阈值**：数据目录超过配置的大小限制（默认 10 GB）
- **启动时检查**：VSCode 插件激活时检查过期数据

#### 16.3.2 清理流程

```typescript
async function cleanupExpiredData(config: CleanupConfig) {
  const now = Date.now();
  
  // 1. 清理过期实时指标
  const realtimeThreshold = now - config.realtimeRetentionDays * 86400000;
  await deleteFilesOlderThan('data/metrics/realtime/', realtimeThreshold);
  
  // 2. 清理过期日志
  const logThreshold = now - config.logRetentionDays * 86400000;
  await deleteFilesOlderThan('data/logs/', logThreshold);
  
  // 3. 清理过期 Core Dump 文件（事件记录保留）
  const coredumpThreshold = now - config.coredumpRetentionDays * 86400000;
  const dumps = await listCoreDumps();
  for (const dump of dumps) {
    if (dump.timestamp < coredumpThreshold && !dump.userPinned) {
      await deleteCoreDump(dump.id);
      // 保留事件记录，仅删除 .core 文件
      await markCoreDumpFileDeleted(dump.id);
    }
  }
  
  // 4. 聚合旧指标（降低采样率而非删除）
  await aggregateOldMetrics();
  
  // 5. 压缩旧日志
  await compressOldLogs();
}
```

#### 16.3.3 聚合降采样

对超过 7 天的实时指标，降采样到 1 分钟粒度：

```sql
-- 从 5s 采样聚合到 1min
INSERT INTO aggregated_metrics (timestamp, target_id, cpu_avg, cpu_max, mem_avg, mem_max)
SELECT 
  (timestamp / 60000) * 60000 AS minute_ts,
  target_id,
  AVG(cpu_percent) AS cpu_avg,
  MAX(cpu_percent) AS cpu_max,
  AVG(mem_used_kb) AS mem_avg,
  MAX(mem_used_kb) AS mem_max
FROM realtime_metrics
WHERE timestamp < ?
GROUP BY minute_ts, target_id;

-- 删除原始数据
DELETE FROM realtime_metrics WHERE timestamp < ?;
```

对超过 90 天的数据，进一步降采样到 1 小时粒度。

### 16.4 空间不足应急策略

当磁盘空间接近配置上限时的优先级清理顺序：

1. **临时缓存**：立即清理所有临时文件（cache/ 目录）
2. **DEBUG 日志**：删除 DEBUG 级别日志，保留 INFO 及以上
3. **过期实时指标**：提前清理，缩短保留期到 3 天
4. **INFO 日志**：删除 INFO 级别日志，仅保留 WARN/ERROR
5. **旧 Core Dump 文件**：删除未 pin 的 Core Dump 文件（保留事件记录）
6. **用户确认**：如仍不足，弹窗询问用户：
  - 增加磁盘配额
  - 手动选择删除特定数据
  - 导出后清理

不应自动删除的数据：

- 用户 pin 的 Core Dump
- 最近 24 小时的所有数据
- Target 配置
- WARN/ERROR 级别日志

### 16.5 数据导出

提供导出功能，便于用户归档或外部分析：

```typescript
interface ExportOptions {
  targetIds: string[];
  startTime: number;
  endTime: number;
  includeMetrics: boolean;
  includeLogs: boolean;
  includeEvents: boolean;
  includeCoreDumps: boolean;
  format: 'json' | 'csv' | 'sqlite';
  compress: boolean;
}

// 导出为自包含的归档文件
async function exportData(options: ExportOptions): Promise<string> {
  const archive = createArchive();
  
  if (options.includeMetrics) {
    const metrics = await queryMetrics(options);
    archive.addFile('metrics.json', JSON.stringify(metrics));
  }
  
  if (options.includeLogs) {
    const logs = await queryLogs(options);
    archive.addFile('logs.jsonl', logs.map(l => JSON.stringify(l)).join('\n'));
  }
  
  // ... 类似处理 events 和 coredumps
  
  const outputPath = `export-${Date.now()}.tar.gz`;
  await archive.finalize(outputPath, options.compress);
  return outputPath;
}
```

导出文件包含 `manifest.json` 说明数据来源和时间范围，便于后续导入或分析。

### 16.6 数据完整性

定期校验数据完整性，防止数据损坏：

```typescript
// 每周运行一次
async function verifyDataIntegrity() {
  // 1. 检查 SQLite 数据库完整性
  await db.pragma('integrity_check');
  
  // 2. 验证压缩文件可解压
  const compressedFiles = await listFiles('data/**/*.gz');
  for (const file of compressedFiles) {
    await verifyGzipIntegrity(file);
  }
  
  // 3. 检查文件与数据库记录一致性
  const dbCoreDumps = await queryAllCoreDumps();
  const fsCoreDumps = await listFiles('data/coredumps/*.core.gz');
  const orphanedFiles = findOrphans(fsCoreDumps, dbCoreDumps);
  
  if (orphanedFiles.length > 0) {
    logWarning(`Found ${orphanedFiles.length} orphaned core dump files`);
  }
}
```

发现损坏数据时：

- 记录错误日志
- 通知用户
- 隔离损坏文件（移到 corrupted/ 目录）
- 不阻塞正常功能

---

## 17. 网络优化与低带宽适配

嵌入式设备常面临网络条件恶劣的场景：蜂窝网络高延迟、间歇性连接、带宽极其有限。

### 17.1 网络条件分级


| 网络类型          | 延迟          | 带宽                | 丢包率     | 适配策略      |
| ------------- | ----------- | ----------------- | ------- | --------- |
| **有线局域网**     | < 5 ms      | > 100 Mbps        | < 0.01% | 无需特殊优化    |
| **WiFi**      | 5-50 ms     | 10-100 Mbps       | < 1%    | 标准配置      |
| **4G/5G**     | 20-100 ms   | 1-50 Mbps         | < 2%    | 启用压缩      |
| **3G**        | 50-200 ms   | 100 Kbps - 1 Mbps | 2-5%    | 压缩 + 限流   |
| **2G/NB-IoT** | 200-1000 ms | 10-50 Kbps        | 5-10%   | 激进压缩 + 采样 |
| **卫星/深山**     | 500-2000 ms | < 10 Kbps         | 10-20%  | 仅关键事件     |


### 17.2 自适应传输策略

Harness-Remote 根据网络质量自动调整传输策略：

```c
typedef enum {
    NETWORK_QUALITY_EXCELLENT,  // LAN
    NETWORK_QUALITY_GOOD,       // WiFi / 4G
    NETWORK_QUALITY_FAIR,       // 3G
    NETWORK_QUALITY_POOR,       // 2G
    NETWORK_QUALITY_CRITICAL    // 极差
} NetworkQuality;

typedef struct {
    int metrics_interval_sec;    // 指标采样间隔
    int log_batch_size;          // 日志批量发送条数
    bool compress_enabled;       // 是否压缩
    int compression_level;       // 压缩级别 (1-9)
    float log_sampling_rate;     // DEBUG/INFO 日志采样率
    int heartbeat_interval_sec;  // 心跳间隔
} TransmissionPolicy;

TransmissionPolicy get_policy(NetworkQuality quality) {
    switch (quality) {
        case NETWORK_QUALITY_EXCELLENT:
            return (TransmissionPolicy){
                .metrics_interval_sec = 5,
                .log_batch_size = 10,
                .compress_enabled = false,
                .log_sampling_rate = 1.0,
                .heartbeat_interval_sec = 30
            };
        
        case NETWORK_QUALITY_GOOD:
            return (TransmissionPolicy){
                .metrics_interval_sec = 10,
                .log_batch_size = 20,
                .compress_enabled = true,
                .compression_level = 3,
                .log_sampling_rate = 1.0,
                .heartbeat_interval_sec = 60
            };
        
        case NETWORK_QUALITY_POOR:
            return (TransmissionPolicy){
                .metrics_interval_sec = 30,
                .log_batch_size = 50,
                .compress_enabled = true,
                .compression_level = 6,
                .log_sampling_rate = 0.1,  // 仅 10% DEBUG/INFO
                .heartbeat_interval_sec = 300
            };
        
        // ... 其他级别
    }
}
```

### 17.3 网络质量评估

通过以下指标动态评估网络质量：

```c
typedef struct {
    uint32_t rtt_ms;              // 往返延迟
    uint32_t bandwidth_kbps;      // 估算带宽
    float packet_loss_rate;       // 丢包率
    uint32_t consecutive_failures; // 连续失败次数
} NetworkMetrics;

NetworkQuality assess_network_quality(NetworkMetrics *metrics) {
    // 连续失败 -> 降级
    if (metrics->consecutive_failures > 3) {
        return NETWORK_QUALITY_CRITICAL;
    }
    
    // 综合评分
    int score = 100;
    
    if (metrics->rtt_ms > 200) score -= 30;
    else if (metrics->rtt_ms > 50) score -= 10;
    
    if (metrics->bandwidth_kbps < 50) score -= 40;
    else if (metrics->bandwidth_kbps < 500) score -= 20;
    
    if (metrics->packet_loss_rate > 0.05) score -= 30;
    else if (metrics->packet_loss_rate > 0.01) score -= 10;
    
    if (score >= 80) return NETWORK_QUALITY_EXCELLENT;
    if (score >= 60) return NETWORK_QUALITY_GOOD;
    if (score >= 40) return NETWORK_QUALITY_FAIR;
    if (score >= 20) return NETWORK_QUALITY_POOR;
    return NETWORK_QUALITY_CRITICAL;
}
```

测量方法：

- **RTT**：通过心跳响应时间测量
- **带宽**：通过发送数据量和耗时计算
- **丢包率**：通过序列号缺失检测

### 17.4 数据压缩

#### 17.4.1 压缩算法选择


| 算法                   | 压缩率   | 速度  | CPU 开销 | 适用场景        |
| -------------------- | ----- | --- | ------ | ----------- |
| **gzip (level 1-3)** | 3:1   | 快   | 低      | 良好网络，实时压缩   |
| **gzip (level 6)**   | 4:1   | 中   | 中      | 一般网络，批量压缩   |
| **gzip (level 9)**   | 5:1   | 慢   | 高      | 极差网络，可接受延迟  |
| **lz4**              | 2.5:1 | 极快  | 极低     | 低端设备，需快速处理  |
| **zstd**             | 4:1   | 快   | 低      | 推荐，平衡性能与压缩率 |


推荐优先级：zstd > gzip (level 3) > lz4

#### 17.4.2 压缩粒度

```c
// 批量压缩多条日志
typedef struct {
    uint32_t count;
    uint64_t timestamp_base;  // 基准时间戳
    char compressed_data[];    // gzip 压缩的 JSON Lines
} LogBatch;

// 压缩前（10 条日志）：~2500 字节
// 压缩后：~600 字节
// 节省：76%
```

不压缩的数据：

- 单条告警（延迟敏感）
- Heartbeat（数据量小，压缩收益低）
- Core Dump 事件元数据（已很小）

### 17.5 优先级队列

低带宽场景下，按优先级发送数据：


| 优先级       | 数据类型                     | 发送策略            |
| --------- | ------------------------ | --------------- |
| **P0 关键** | ERROR 日志、Core Dump 事件、告警 | 立即发送，不批量，不采样    |
| **P1 重要** | WARN 日志、Metrics          | 短批量（10 条或 5 秒）  |
| **P2 普通** | INFO 日志                  | 长批量（50 条或 30 秒） |
| **P3 次要** | DEBUG 日志                 | 采样发送或丢弃         |


队列溢出时的丢弃策略：

1. 优先丢弃 P3
2. 采样 P2（保留每 10 条中的 1 条）
3. P0/P1 进入持久化缓冲区（磁盘）

### 17.6 断点续传

大文件（Core Dump）传输支持断点续传：

```typescript
// Host 端实现
async function downloadCoreDump(remoteP ath: string): Promise<string> {
  const localPath = getLocalCoreDumpPath(remotePath);
  const partialPath = `${localPath}.partial`;
  
  // 检查是否有未完成的下载
  let offset = 0;
  if (fs.existsSync(partialPath)) {
    const stat = fs.statSync(partialPath);
    offset = stat.size;
  }
  
  // 从断点继续下载
  const stream = await sshClient.sftp().createReadStream(remotePath, {
    start: offset,
    autoClose: true
  });
  
  const writer = fs.createWriteStream(partialPath, {
    flags: offset > 0 ? 'a' : 'w'  // append or write
  });
  
  await pipeline(stream, writer);
  
  // 完成后重命名
  fs.renameSync(partialPath, localPath);
  return localPath;
}
```

传输失败时：

- 保留 `.partial` 文件
- 下次连接时自动恢复
- 超过 7 天未完成的 partial 文件自动清理

### 17.7 间歇性连接场景

设备可能定时休眠或连接不稳定：

```c
// Remote 端离线缓冲
typedef struct {
    char buffer_file[256];     // /tmp/harness-offline.buf
    size_t max_size_mb;        // 最大缓冲 10 MB
    bool enabled;
} OfflineBuffer;

void handle_send_failure(const char *data, size_t len) {
    if (offline_buffer.enabled) {
        // 追加到离线缓冲文件
        append_to_buffer_file(data, len);
        
        // 检查大小限制
        if (get_buffer_size() > offline_buffer.max_size_mb * 1024 * 1024) {
            // 超过限制，开始丢弃 P3/P2 数据
            trim_buffer();
        }
    }
}

void on_connection_restored() {
    // 连接恢复，发送缓冲数据
    send_buffered_data();
    clear_buffer_file();
}
```

缓冲文件格式：

- JSONL（每行一条完整消息）
- 按优先级分段存储
- 包含时间戳，Host 接收后重新排序

### 17.8 Host 端网络适配

Host 插件也需适配网络条件：

```typescript
interface RemoteConnectionConfig {
  // 连接参数
  reconnectInterval: number;      // 重连间隔（ms）
  maxReconnectAttempts: number;   // 最大重连次数
  connectionTimeout: number;      // 连接超时（ms）
  
  // 低带宽优化
  enableCompression: boolean;     // 是否要求 Remote 压缩
  requestMetricsInterval: number; // 请求的指标采样间隔
  logLevelFilter: LogLevel;       // 日志级别过滤（仅接收 >= 此级别）
  
  // 高延迟优化
  batchAcknowledgement: boolean;  // 批量确认而非每条确认
  pipelineDepth: number;          // 允许的未确认包数量
}

// 根据网络状况自动调整
function adaptToNetworkCondition(metrics: NetworkMetrics): RemoteConnectionConfig {
  if (metrics.rtt_ms > 500) {
    return {
      reconnectInterval: 30000,
      enableCompression: true,
      requestMetricsInterval: 60,
      logLevelFilter: LogLevel.WARN,  // 仅接收 WARN/ERROR
      batchAcknowledgement: true,
      pipelineDepth: 10
    };
  }
  
  // ... 其他条件
}
```

---

## 18. 安全威胁模型与防护

### 18.1 攻击面分析


| 攻击面              | 暴露点              | 潜在威胁            | 影响范围        |
| ---------------- | ---------------- | --------------- | ----------- |
| **SSH 连接**       | 22 端口、认证         | 暴力破解、中间人攻击、密钥泄露 | 完全控制 Remote |
| **传输数据**         | 网络流量             | 窃听、篡改、重放攻击      | 数据泄露、错误决策   |
| **Remote 采集器**   | Root/高权限进程       | 权限提升、任意代码执行     | 系统完全妥协      |
| **Host 插件**      | VSCode 扩展权限      | 恶意数据注入、文件系统访问   | 开发机妥协       |
| **Core Dump 文件** | 敏感内存内容           | 密钥、token、PII 泄露 | 数据泄露、合规违规   |
| **日志内容**         | 明文敏感信息           | 密码、API key 泄露   | 凭证泄露        |
| **配置文件**         | SSH 密钥、target 配置 | 未授权访问           | 横向移动        |
| **MCP 接口**       | 外部 Agent 调用      | 未授权数据访问、注入攻击    | 数据泄露、系统操纵   |


### 18.2 威胁场景

#### 18.2.1 场景 1：SSH 密钥泄露

**攻击路径**：

1. 攻击者获取 Host 开发机访问权限
2. 读取 `~/.ssh/` 下的 Remote 设备私钥
3. 直接 SSH 登录 Remote 设备
4. 植入后门或窃取数据

**防护措施**：

- ✅ 使用 SSH 证书认证（OpenSSH CA）而非长期密钥
- ✅ 私钥使用密码保护（passphrase）
- ✅ 私钥权限严格限制（chmod 600）
- ✅ 定期轮换密钥（建议 90 天）
- ✅ 使用专用密钥（不与其他系统共享）
- ✅ 考虑硬件密钥（YubiKey）存储私钥

**检测**：

- 监控异常登录时间、地点
- 记录所有 SSH 登录到 audit log
- 多次失败登录告警

#### 18.2.2 场景 2：恶意数据注入

**攻击路径**：

1. 攻击者控制 Remote 设备或中间人攻击
2. 向 Host 发送精心构造的恶意数据
3. Host 解析时触发漏洞（SQL 注入、路径遍历、RCE）

例如：

```json
{
  "type": "log",
  "payload": {
    "message": "'; DROP TABLE logs; --",
    "filePath": "../../../../../../etc/passwd"
  }
}
```

**防护措施**：

- ✅ **严格输入验证**：所有 Remote 数据视为不可信
- ✅ **参数化查询**：SQL 使用 prepared statements
- ✅ **路径规范化**：文件路径必须在白名单目录内
  ```typescript
  function sanitizePath(inputPath: string, baseDir: string): string {
    const resolved = path.resolve(baseDir, inputPath);
    if (!resolved.startsWith(baseDir)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }
  ```
- ✅ **输出编码**：UI 显示时 HTML 转义，防止 XSS
- ✅ **长度限制**：拒绝超长字符串（如单条日志 > 64 KB）
- ✅ **类型校验**：使用 JSON Schema 验证消息结构

#### 18.2.3 场景 3：命令注入

**攻击路径**：
Host 向导引导用户在 Remote 执行命令时，攻击者通过配置注入恶意命令：

```typescript
// 危险示例（错误）
const cmd = `echo "${userProvidedPath}" > /proc/sys/kernel/core_pattern`;
await ssh.exec(cmd);  // 若 userProvidedPath 包含 `; rm -rf /` 则灾难
```

**防护措施**：

- ✅ **白名单命令**：仅允许预定义的命令模板
  ```typescript
  const ALLOWED_COMMANDS = {
    'set_core_pattern': {
      cmd: 'echo',
      args: ['%PATTERN%'],
      redirect: '/proc/sys/kernel/core_pattern',
      requireRoot: true
    },
    'install_gdb': {
      cmd: 'apt-get',
      args: ['install', '-y', 'gdb'],
      requireRoot: true
    }
  };
  ```
- ✅ **参数化执行**：使用 SSH 库的参数数组而非字符串拼接
  ```typescript
  // 安全方式
  await ssh.execCommand('echo', [sanitizedPattern], {
    redirect: '/proc/sys/kernel/core_pattern'
  });
  ```
- ✅ **输入校验**：正则表达式验证参数格式
  ```typescript
  const CORE_PATTERN_REGEX = /^[a-zA-Z0-9\/._%-]+$/;
  if (!CORE_PATTERN_REGEX.test(userInput)) {
    throw new Error('Invalid core pattern format');
  }
  ```
- ✅ **用户确认**：显示完整命令预览，用户明确确认
- ✅ **最小权限**：尽量不用 root，使用 sudo 仅针对特定命令

#### 18.2.4 场景 4：Core Dump 敏感信息泄露

**威胁**：
Core Dump 包含进程完整内存，可能含有：

- 加密密钥（如 TLS 私钥）
- 数据库密码、API token
- 用户个人信息（PII）
- 商业机密数据

**防护措施**：

- ✅ **访问控制**：Core Dump 文件 chmod 600，仅 owner 可读
- ✅ **存储加密**：Host 端存储 Core 文件时加密
  ```typescript
  async function storeCoreDump(data: Buffer, key: string): Promise<void> {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    await fs.writeFile(coreDumpPath, encrypted);
  }
  ```
- ✅ **传输加密**：SFTP over SSH 已加密，但需验证 Host Key
- ✅ **最小化内容**：探索 gcore 的 `--exclude` 选项（排除共享库映射）
- ✅ **保留期限制**：默认 30 天自动清理，减少暴露窗口
- ✅ **审计日志**：记录谁、何时访问了 Core Dump
- ✅ **数据分类**：提示用户标记敏感进程（如支付服务），禁用 core dump

**合规考虑**（GDPR、HIPAA 等）：

- 若 Core 可能含 PII，需在隐私政策中声明
- 考虑匿名化或脱敏处理（技术上困难）
- 提供用户删除数据的能力

### 18.3 SSH 安全最佳实践

#### 18.3.1 密钥管理

**生成专用密钥**：

```bash
# 为 Harness 生成专用 Ed25519 密钥
ssh-keygen -t ed25519 -f ~/.ssh/harness_ed25519 -C "harness@host" -N "passphrase"
```

**Host 端配置**：

```typescript
const sshConfig = {
  host: target.host,
  port: target.port || 22,
  username: target.username,
  privateKeyPath: '~/.ssh/harness_ed25519',
  passphrase: await getSecurePassphrase(),  // 从 keychain 读取
  algorithms: {
    serverHostKey: ['ssh-ed25519', 'rsa-sha2-512'],  // 禁用弱算法
    cipher: ['aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com']
  },
  strictHostKeyChecking: true,  // 必须验证 Host Key
  hostVerification: (hostKey: string) => verifyHostKey(target.id, hostKey)
};
```

**Remote 端配置**（`/etc/ssh/sshd_config`）：

```
# 仅允许公钥认证
PubkeyAuthentication yes
PasswordAuthentication no
PermitRootLogin no

# 限制用户
AllowUsers harness-deploy

# 强化算法
HostKeyAlgorithms ssh-ed25519
Ciphers aes256-gcm@openssh.com,chacha20-poly1305@openssh.com
MACs hmac-sha2-512-etm@openssh.com

# 限制登录尝试
MaxAuthTries 3
LoginGraceTime 30
```

#### 18.3.2 Host Key 验证

首次连接时记录 Host Key，后续连接必须匹配：

```typescript
interface HostKeyStore {
  [targetId: string]: {
    algorithm: string;
    fingerprint: string;  // SHA256 fingerprint
    firstSeen: number;
    lastVerified: number;
  };
}

async function verifyHostKey(targetId: string, hostKey: Buffer): Promise<boolean> {
  const fingerprint = crypto.createHash('sha256').update(hostKey).digest('base64');
  const stored = hostKeyStore[targetId];
  
  if (!stored) {
    // 首次连接，显示指纹让用户确认
    const confirmed = await showHostKeyConfirmation(targetId, fingerprint);
    if (confirmed) {
      hostKeyStore[targetId] = {
        algorithm: 'ssh-ed25519',
        fingerprint,
        firstSeen: Date.now(),
        lastVerified: Date.now()
      };
      await saveHostKeyStore();
      return true;
    }
    return false;
  }
  
  // 后续连接，必须匹配
  if (stored.fingerprint !== fingerprint) {
    await showSecurityAlert(
      `Host key mismatch for ${targetId}! Possible man-in-the-middle attack.`
    );
    return false;
  }
  
  stored.lastVerified = Date.now();
  await saveHostKeyStore();
  return true;
}
```

#### 18.3.3 证书认证（可选高级特性）

对于管理多个设备的场景，推荐 SSH 证书：

```bash
# 1. 创建 CA 密钥（一次性，安全保管）
ssh-keygen -t ed25519 -f ca_key

# 2. 为用户公钥签发证书（有效期 90 天）
ssh-keygen -s ca_key -I harness-user -n harness-deploy -V +90d ~/.ssh/harness_ed25519.pub

# 3. Remote 端信任 CA 公钥
echo "cert-authority $(cat ca_key.pub)" >> /etc/ssh/sshd_config
```

优势：

- 无需在每个设备上分发公钥
- 证书自动过期，强制轮换
- 可撤销（Certificate Revocation List）

### 18.4 数据传输安全

#### 18.4.1 传输层加密


| 通道            | 加密方案                   | 认证                   |
| ------------- | ---------------------- | -------------------- |
| SSH           | TLS 1.3-like（SSH 协议内置） | 双向（Host Key + 客户端密钥） |
| WebSocket（可选） | WSS（TLS 1.3）           | 证书 + Token           |
| TCP（可选）       | TLS 1.3                | 证书 + 预共享密钥           |


**禁用不安全选项**：

- ❌ 明文 WebSocket（ws://）
- ❌ 明文 TCP
- ❌ 自签名证书且跳过验证

#### 18.4.2 消息完整性

防止消息篡改和重放攻击：

```typescript
interface SecureMessage {
  version: number;
  sequence: number;        // 单调递增序列号
  timestamp: number;       // 发送时间戳
  nonce: string;           // 随机数
  payload: any;
  hmac: string;            // HMAC-SHA256(payload + sequence + timestamp + nonce, sharedKey)
}

function verifyMessage(msg: SecureMessage, lastSequence: number): boolean {
  // 1. 检查序列号（防重放）
  if (msg.sequence <= lastSequence) {
    throw new Error('Replay attack detected');
  }
  
  // 2. 检查时间戳（允许 5 分钟时钟偏移）
  const now = Date.now();
  if (Math.abs(msg.timestamp - now) > 300000) {
    throw new Error('Message timestamp out of range');
  }
  
  // 3. 验证 HMAC（防篡改）
  const data = JSON.stringify(msg.payload) + msg.sequence + msg.timestamp + msg.nonce;
  const expectedHmac = crypto.createHmac('sha256', sharedKey).update(data).digest('hex');
  if (msg.hmac !== expectedHmac) {
    throw new Error('HMAC verification failed');
  }
  
  return true;
}
```

**注意**：SSH 本身已提供完整性保护，此层在使用 WebSocket/TCP 时必需。

### 18.5 权限最小化

#### 18.5.1 Remote 端用户权限

创建专用低权限用户：

```bash
# 创建 harness-deploy 用户（无登录 shell）
useradd -r -s /usr/sbin/nologin -d /var/lib/harness harness-deploy

# 授予最小必要权限
# 1. 读取 /proc、/sys
# 2. 读取日志文件
setfacl -m u:harness-deploy:r /var/log/syslog
setfacl -m u:harness-deploy:r /var/log/messages

# 3. 读取 journal（加入 systemd-journal 组）
usermod -a -G systemd-journal harness-deploy

# 4. 读取 dmesg（需 CAP_SYSLOG 或 kernel.dmesg_restrict=0）
# 可选：sudo 规则允许 harness-deploy 执行 dmesg
echo "harness-deploy ALL=(ALL) NOPASSWD: /bin/dmesg" >> /etc/sudoers.d/harness
```

**禁止的权限**：

- ❌ Root 登录
- ❌ 写入系统配置（除一次性 setup）
- ❌ 执行任意命令
- ❌ 访问其他用户的 home 目录

#### 18.5.2 Host 端插件权限

VSCode 扩展运行在沙箱中，但需注意：

```json
{
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited",
      "description": "部分功能在不受信任的工作区中禁用"
    }
  }
}
```

限制：

- 仅访问配置的数据目录（`~/.vscode-harness/`）
- 不读取工作区文件（除非用户明确选择）
- 不执行工作区中的脚本
- Core Dump 分析时，GDB 在沙箱中运行

### 18.6 日志脱敏

防止敏感信息出现在日志中：

```typescript
// 自动检测和遮蔽敏感模式
const SENSITIVE_PATTERNS = [
  { name: 'API Key', regex: /\b[A-Za-z0-9]{32,}\b/, replacement: '[API_KEY_REDACTED]' },
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, replacement: '[JWT_REDACTED]' },
  { name: 'Password', regex: /(password|passwd|pwd)[=:]\s*["']?([^"'\s]+)["']?/i, replacement: '$1=[REDACTED]' },
  { name: 'IP Address', regex: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/, replacement: '[IP_REDACTED]' },
  { name: 'Email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, replacement: '[EMAIL_REDACTED]' }
];

function sanitizeLog(message: string, enableRedaction: boolean): string {
  if (!enableRedaction) return message;
  
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern.regex, pattern.replacement);
  }
  return sanitized;
}
```

**配置选项**：

- 用户可启用/禁用自动脱敏
- 可添加自定义脱敏规则
- 原始日志仍存储（加密），脱敏仅用于展示

### 18.7 MCP 接口安全

外部 AI Agent 通过 MCP 访问 Harness 数据时的安全控制：

```typescript
interface MCPAccessControl {
  authentication: {
    method: 'api_key' | 'oauth2';
    rotationPeriod: number;  // 天
  };
  authorization: {
    allowedTools: string[];   // 白名单工具
    allowedTargets: string[]; // 白名单设备
    readOnly: boolean;        // 是否只读
  };
  rateLimiting: {
    requestsPerMinute: number;
    burstSize: number;
  };
  auditLog: boolean;  // 记录所有访问
}

// 工具权限控制
const MCP_TOOL_PERMISSIONS = {
  'get_metrics': { sensitivity: 'low', readOnly: true },
  'get_logs': { sensitivity: 'medium', readOnly: true },
  'get_coredump': { sensitivity: 'high', readOnly: true },
  'execute_remote_command': { sensitivity: 'critical', readOnly: false }  // 默认禁用
};

async function handleMCPRequest(tool: string, params: any, auth: MCPAuth): Promise<any> {
  // 1. 认证
  const user = await authenticateMCP(auth);
  if (!user) throw new UnauthorizedError();
  
  // 2. 鉴权
  if (!user.acl.allowedTools.includes(tool)) {
    auditLog('mcp_access_denied', { user: user.id, tool });
    throw new ForbiddenError(`Tool ${tool} not allowed`);
  }
  
  // 3. 限流
  if (!rateLimiter.tryAcquire(user.id)) {
    throw new TooManyRequestsError();
  }
  
  // 4. 审计
  auditLog('mcp_request', { user: user.id, tool, params });
  
  // 5. 执行
  return await executeMCPTool(tool, params);
}
```

### 18.8 审计日志

记录所有安全相关事件：

```typescript
interface AuditLogEntry {
  timestamp: number;
  eventType: string;
  userId?: string;
  targetId?: string;
  action: string;
  result: 'success' | 'failure';
  details: any;
  sourceIP?: string;
}

// 记录的事件类型
const AUDIT_EVENTS = [
  'ssh_login',
  'ssh_login_failed',
  'host_key_mismatch',
  'coredump_accessed',
  'remote_command_executed',
  'mcp_request',
  'mcp_access_denied',
  'config_changed',
  'data_exported',
  'sensitive_data_accessed'
];
```

审计日志要求：

- 不可篡改（append-only，可选签名）
- 定期归档（按月）
- 保留至少 1 年（合规要求）
- 支持导出分析

### 18.9 安全配置检查清单

部署前必须完成的安全检查：

**Remote 端**：

- [ ] SSH 仅允许公钥认证
- [ ] 禁用 root 登录
- [ ] 专用低权限用户
- [ ] 防火墙限制 SSH 来源 IP
- [ ] 定期更新系统补丁
- [ ] Core dump 文件权限 600
- [ ] 日志文件适当的 ACL

**Host 端**：

- [ ] SSH 私钥有 passphrase
- [ ] 私钥权限 600
- [ ] Host Key 验证启用
- [ ] 数据目录加密（可选）
- [ ] 定期密钥轮换计划
- [ ] 审计日志启用

**传输**：

- [ ] 使用 SSH 或 TLS 1.3
- [ ] 禁用弱加密算法
- [ ] 证书有效期检查

**数据**：

- [ ] 敏感日志脱敏
- [ ] Core Dump 加密存储
- [ ] 数据保留期配置
- [ ] 导出数据时二次确认

### 18.10 事件响应

安全事件发生时的处理流程：


| 事件              | 严重性   | 响应措施                         |
| --------------- | ----- | ---------------------------- |
| Host Key 不匹配    | 🔴 严重 | 立即断开连接，告警用户，锁定 target 直至人工确认 |
| 多次 SSH 登录失败     | 🟡 警告 | 记录日志，可选暂时禁用连接（rate limiting） |
| 异常数据包（格式错误）     | 🟡 警告 | 丢弃数据包，记录审计日志，持续监控            |
| 命令注入检测          | 🔴 严重 | 拒绝执行，告警用户，审查配置来源             |
| Core Dump 未授权访问 | 🟠 重要 | 记录审计日志，通知用户，检查权限配置           |
| MCP 滥用（超频请求）    | 🟡 警告 | 触发限流，可选暂停 API 访问             |


响应自动化：

- 严重事件自动触发告警（系统通知 + 邮件）
- 重复事件自动升级（3 次警告 → 严重）
- 生成事件响应报告（时间线、影响范围、建议措施）

---

## 19. MCU 日志详细设计

§7 中 MCU 部分相对简略，此处扩展具体实现细节。

### 19.1 MCU 日志宏实现

#### 19.1.1 基础宏定义

```c
// harness_log.h
#ifndef HARNESS_LOG_H
#define HARNESS_LOG_H

#include <stdio.h>
#include <stdint.h>

// 日志级别
typedef enum {
    LOG_LEVEL_DEBUG = 0,
    LOG_LEVEL_INFO,
    LOG_LEVEL_WARN,
    LOG_LEVEL_ERROR
} LogLevel;

// 全局配置
extern LogLevel g_log_level;  // 运行时可调整
extern uint8_t g_log_enabled;

// 时间戳获取（需根据平台实现）
#if defined(USE_HAL_DRIVER)
    #define GET_TICK() HAL_GetTick()
#elif defined(USE_FREERTOS)
    #define GET_TICK() (xTaskGetTickCount() * portTICK_PERIOD_MS)
#else
    extern uint32_t SystemCoreClock;
    #define GET_TICK() (SysTick->VAL / (SystemCoreClock / 1000))
#endif

// 日志宏
#define LOG(level, module, fmt, ...) \
    do { \
        if (g_log_enabled && (level) >= g_log_level) { \
            printf("{\"tick\":%lu,\"lvl\":\"%s\",\"mod\":\"%s\",\"msg\":\"" fmt "\"}\n", \
                   GET_TICK(), #level, module, ##__VA_ARGS__); \
        } \
    } while(0)

#define LOG_DEBUG(mod, fmt, ...) LOG(DEBUG, mod, fmt, ##__VA_ARGS__)
#define LOG_INFO(mod, fmt, ...) LOG(INFO, mod, fmt, ##__VA_ARGS__)
#define LOG_WARN(mod, fmt, ...) LOG(WARN, mod, fmt, ##__VA_ARGS__)
#define LOG_ERROR(mod, fmt, ...) LOG(ERROR, mod, fmt, ##__VA_ARGS__)

// 带数值的日志（便于分析）
#define LOG_VALUE(level, module, msg, key, value) \
    do { \
        if (g_log_enabled && (level) >= g_log_level) { \
            printf("{\"tick\":%lu,\"lvl\":\"%s\",\"mod\":\"%s\",\"msg\":\"%s\",\"%s\":%d}\n", \
                   GET_TICK(), #level, module, msg, key, (int)(value)); \
        } \
    } while(0)

#endif // HARNESS_LOG_H
```

#### 19.1.2 使用示例

```c
// motor_control.c
#include "harness_log.h"

void motor_init(void) {
    LOG_INFO("motor", "Initializing motor controller");
    
    // ... 初始化代码 ...
    
    if (init_success) {
        LOG_INFO("motor", "Motor initialized successfully");
    } else {
        LOG_ERROR("motor", "Motor initialization failed");
    }
}

void motor_update(void) {
    int16_t current = read_motor_current();
    
    if (current > OVERCURRENT_THRESHOLD) {
        LOG_VALUE(WARN, "motor", "overcurrent detected", "current_ma", current);
        shutdown_motor();
    }
}

void hard_fault_handler(void) {
    // 在 fault handler 中也能安全调用
    LOG_ERROR("system", "HardFault occurred");
    // 注意：printf 可能依赖中断，fault handler 中需谨慎
}
```

输出示例：

```json
{"tick":1234,"lvl":"INFO","mod":"motor","msg":"Initializing motor controller"}
{"tick":5678,"lvl":"WARN","mod":"motor","msg":"overcurrent detected","current_ma":842}
{"tick":9012,"lvl":"ERROR","mod":"system","msg":"HardFault occurred"}
```

### 19.2 RTT 配置

#### 19.2.1 SEGGER RTT 集成

```c
// SEGGER_RTT_Conf.h 配置
#define SEGGER_RTT_MAX_NUM_UP_BUFFERS     2  // 上行缓冲区数量
#define SEGGER_RTT_MAX_NUM_DOWN_BUFFERS   1  // 下行缓冲区数量

#define BUFFER_SIZE_UP          4096   // 上行缓冲区大小（建议 2-8 KB）
#define SEGGER_RTT_MODE_DEFAULT SEGGER_RTT_MODE_NO_BLOCK_SKIP  // 满时丢弃

// 初始化（main.c）
#include "SEGGER_RTT.h"

int main(void) {
    // 系统初始化 ...
    
    // 配置 RTT Channel 0 用于日志
    SEGGER_RTT_ConfigUpBuffer(0, "HarnessLog", NULL, 0, SEGGER_RTT_MODE_NO_BLOCK_SKIP);
    
    // 重定向 printf 到 RTT
    SEGGER_RTT_SetTerminal(0);
    
    LOG_INFO("system", "System started");
    
    // ... 主循环 ...
}
```

#### 19.2.2 printf 重定向

```c
// syscalls.c 或 retarget.c

#ifdef USE_RTT
#include "SEGGER_RTT.h"

int _write(int file, char *ptr, int len) {
    (void)file;
    SEGGER_RTT_Write(0, ptr, len);
    return len;
}
#endif

#ifdef USE_UART
extern UART_HandleTypeDef huart1;

int _write(int file, char *ptr, int len) {
    (void)file;
    HAL_UART_Transmit(&huart1, (uint8_t*)ptr, len, HAL_MAX_DELAY);
    return len;
}
#endif
```

### 19.3 时间戳同步

MCU tick 与 Host 时间的映射关系：

#### 19.3.1 启动时刻同步

```c
// MCU 端：启动时发送同步标记
void harness_log_init(void) {
    // 发送特殊同步消息
    printf("{\"type\":\"sync\",\"tick\":%lu,\"reset_reason\":%d}\n", 
           GET_TICK(), get_reset_reason());
}
```

```typescript
// Host 端：建立映射
interface MCUSession {
  tickBase: number;        // 同步消息的 tick 值
  hostTimeBase: number;    // Host 接收同步消息的时间
  tickFrequency: number;   // tick 频率（Hz），如 1000
  tickOverflowAt: number;  // tick 溢出值（32位 uint32_t: 4294967296）
  lastTick: number;        // 上次接收到的 tick，用于检测溢出
}

function mapMCUTickToHostTime(tick: number, session: MCUSession): number {
  // 检测 tick 溢出（32位无符号整数回绕）
  if (tick < session.lastTick && (session.lastTick - tick) > 0x80000000) {
    // 发生溢出
    session.tickBase += session.tickOverflowAt;
  }
  session.lastTick = tick;
  
  // 计算经过的毫秒数
  const elapsedMs = (tick - session.tickBase % session.tickOverflowAt) / session.tickFrequency * 1000;
  
  // 映射到 Host 时间
  return session.hostTimeBase + elapsedMs;
}
```

#### 19.3.2 周期性时间校准（可选）

MCU 定时发送心跳，Host 用于检测时钟漂移：

```c
// MCU 端：每 60 秒发送一次心跳
void heartbeat_task(void) {
    while (1) {
        printf("{\"type\":\"heartbeat\",\"tick\":%lu,\"uptime\":%lu}\n", 
               GET_TICK(), get_uptime_seconds());
        vTaskDelay(pdMS_TO_TICKS(60000));
    }
}
```

```typescript
// Host 端：检测漂移
function checkClockDrift(heartbeat: MCUHeartbeat, session: MCUSession) {
  const expectedHostTime = mapMCUTickToHostTime(heartbeat.tick, session);
  const actualHostTime = Date.now();
  const drift = Math.abs(expectedHostTime - actualHostTime);
  
  if (drift > 5000) {  // 漂移超过 5 秒
    logWarning(`MCU clock drift detected: ${drift}ms`);
    // 重新校准
    session.hostTimeBase = actualHostTime - (heartbeat.tick / session.tickFrequency * 1000);
  }
}
```

### 19.4 多核 MCU 日志同步

对于多核 MCU（如 STM32H7 双核），需要日志序列化：

```c
// 使用共享内存 + 互斥锁
#include "cmsis_os.h"

osMutexId_t g_log_mutex;

void harness_log_init_multicore(void) {
    // 创建互斥锁（在共享 RAM 中）
    g_log_mutex = osMutexNew(NULL);
}

#define LOG_SAFE(level, module, fmt, ...) \
    do { \
        if (g_log_enabled && (level) >= g_log_level) { \
            osMutexAcquire(g_log_mutex, osWaitForever); \
            printf("{\"tick\":%lu,\"core\":%d,\"lvl\":\"%s\",\"mod\":\"%s\",\"msg\":\"" fmt "\"}\n", \
                   GET_TICK(), get_current_core_id(), #level, module, ##__VA_ARGS__); \
            osMutexRelease(g_log_mutex); \
        } \
    } while(0)
```

Host 端展示时按 core ID 着色或分组。

### 19.5 日志缓冲区管理

RTT 缓冲区满时的处理策略：

```c
// 优先级队列（在 MCU RAM 中维护小缓冲区）
#define LOG_BUFFER_SIZE 128

typedef struct {
    uint32_t tick;
    LogLevel level;
    char message[64];
} LogEntry;

typedef struct {
    LogEntry entries[LOG_BUFFER_SIZE];
    uint16_t write_idx;
    uint16_t read_idx;
    uint16_t count;
    uint16_t dropped;  // 统计丢弃的日志数
} LogBuffer;

LogBuffer g_log_buffer;

void log_enqueue(LogLevel level, const char *msg) {
    if (g_log_buffer.count >= LOG_BUFFER_SIZE) {
        // 缓冲区满，根据优先级决定是否丢弃
        if (level < LOG_LEVEL_WARN) {
            g_log_buffer.dropped++;
            return;  // 丢弃 DEBUG/INFO
        }
        // WARN/ERROR 覆盖最旧的 INFO/DEBUG
        // ... 实现优先级替换逻辑 ...
    }
    
    LogEntry *entry = &g_log_buffer.entries[g_log_buffer.write_idx];
    entry->tick = GET_TICK();
    entry->level = level;
    strncpy(entry->message, msg, sizeof(entry->message) - 1);
    
    g_log_buffer.write_idx = (g_log_buffer.write_idx + 1) % LOG_BUFFER_SIZE;
    g_log_buffer.count++;
}

// 低优先级任务负责刷新缓冲区到 RTT
void log_flush_task(void *arg) {
    while (1) {
        if (g_log_buffer.count > 0) {
            LogEntry *entry = &g_log_buffer.entries[g_log_buffer.read_idx];
            
            // 通过 RTT 发送
            char json[128];
            snprintf(json, sizeof(json),
                     "{\"tick\":%lu,\"lvl\":\"%d\",\"msg\":\"%s\"}\n",
                     entry->tick, entry->level, entry->message);
            SEGGER_RTT_WriteString(0, json);
            
            g_log_buffer.read_idx = (g_log_buffer.read_idx + 1) % LOG_BUFFER_SIZE;
            g_log_buffer.count--;
        }
        
        vTaskDelay(pdMS_TO_TICKS(10));  // 每 10ms 检查一次
    }
}
```

### 19.6 Host 端 RTT 读取

```typescript
// 使用 J-Link SDK 或命令行工具
import { spawn } from 'child_process';

class RTTReader {
  private process: ChildProcess;
  private buffer: string = '';
  
  start(deviceName: string) {
    // 使用 JLinkRTTClient 或 JLinkExe
    this.process = spawn('JLinkRTTClient', ['-Device', deviceName]);
    
    this.process.stdout.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processLines();
    });
  }
  
  private processLines() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';  // 保留不完整的行
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const log = JSON.parse(line);
          this.handleMCULog(log);
        } catch (e) {
          console.warn('Invalid JSON from MCU:', line);
        }
      }
    }
  }
  
  private handleMCULog(log: MCULogEntry) {
    // 映射时间戳
    const hostTime = this.mapTick(log.tick);
    
    // 存储到数据库
    this.storeLog({
      ...log,
      source: 'mcu-rtt',
      timestamp: hostTime,
      targetId: this.targetId
    });
    
    // 实时展示
    this.emit('log', log);
  }
}
```

### 19.7 UART 作为备选通道

当 J-Link 不可用时，回退到 UART：

```c
// MCU 端配置
#define USE_UART_LOG

#ifdef USE_UART_LOG
extern UART_HandleTypeDef huart1;  // 115200 baud, 8N1

void harness_uart_init(void) {
    // UART 已在 MX_UART1_Init() 中初始化
    LOG_INFO("system", "UART log output enabled");
}
#endif
```

```typescript
// Host 端使用 serialport
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

class UARTReader {
  private port: SerialPort;
  private parser: ReadlineParser;
  
  async start(portPath: string, baudRate: number = 115200) {
    this.port = new SerialPort({ path: portPath, baudRate });
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
    
    this.parser.on('data', (line: string) => {
      try {
        const log = JSON.parse(line);
        this.handleMCULog(log);
      } catch (e) {
        // 可能混有非 JSON 输出（如调试打印）
        this.handleRawOutput(line);
      }
    });
  }
}
```

---

## 20. 测试策略与质量保证

### 20.1 测试金字塔

```text
           /\
          /  \         E2E 测试（少量）
         /____\        - 完整工作流
        /      \       - 真实设备
       /________\      集成测试（适量）
      /          \     - 组件交互
     /____________\    - Mock 设备
    /              \   单元测试（大量）
   /________________\  - 函数级
                       - 快速反馈
```


| 测试类型       | 数量占比 | 执行频率     | 环境      |
| ---------- | ---- | -------- | ------- |
| **单元测试**   | 70%  | 每次提交     | 本地 + CI |
| **集成测试**   | 25%  | 每次 PR    | CI      |
| **E2E 测试** | 5%   | 每日 / 发布前 | 真实硬件    |


### 20.2 Remote 采集器测试

#### 20.2.1 单元测试

```c
// tests/test_meminfo_parser.c
#include "unity.h"
#include "../src/collector/meminfo.c"

void test_parse_meminfo_success(void) {
    const char *mock_meminfo = 
        "MemTotal:        1024000 kB\n"
        "MemFree:          512000 kB\n"
        "MemAvailable:     768000 kB\n"
        "SwapTotal:        512000 kB\n"
        "SwapFree:         256000 kB\n";
    
    MemInfo info;
    int result = parse_meminfo_string(mock_meminfo, &info);
    
    TEST_ASSERT_EQUAL(0, result);
    TEST_ASSERT_EQUAL(1024000, info.total_kb);
    TEST_ASSERT_EQUAL(512000, info.free_kb);
    TEST_ASSERT_EQUAL(768000, info.available_kb);
}

void test_parse_meminfo_malformed(void) {
    const char *bad_meminfo = "Invalid format\n";
    
    MemInfo info;
    int result = parse_meminfo_string(bad_meminfo, &info);
    
    TEST_ASSERT_NOT_EQUAL(0, result);
}

void test_parse_meminfo_missing_fields(void) {
    const char *incomplete = "MemTotal: 1024000 kB\n";
    
    MemInfo info;
    int result = parse_meminfo_string(incomplete, &info);
    
    // 应部分成功，设置默认值
    TEST_ASSERT_EQUAL(0, result);
    TEST_ASSERT_EQUAL(1024000, info.total_kb);
    TEST_ASSERT_EQUAL(0, info.free_kb);  // 默认值
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_parse_meminfo_success);
    RUN_TEST(test_parse_meminfo_malformed);
    RUN_TEST(test_parse_meminfo_missing_fields);
    return UNITY_END();
}
```

测试覆盖目标：

- 核心采集逻辑：> 90%
- 解析器：> 95%
- 错误处理路径：> 80%

#### 20.2.2 集成测试（Mock 环境）

```bash
# tests/integration/test_full_collection.sh

# 1. 创建 Mock /proc 文件系统
setup_mock_proc() {
    mkdir -p mock_proc
    echo "MemTotal: 1024000 kB" > mock_proc/meminfo
    echo "0.5 0.3 0.2 1/100 12345" > mock_proc/loadavg
}

# 2. 运行采集器（重定向 /proc 路径）
run_collector_with_mock() {
    MOCK_PROC_PATH=./mock_proc ./harness-remote --test-mode > output.json
}

# 3. 验证输出
validate_output() {
    jq -e '.type == "metrics"' output.json
    jq -e '.payload.memory.totalKb == 1024000' output.json
    jq -e '.payload.cpu.load1 == 0.5' output.json
}

# 执行
setup_mock_proc
run_collector_with_mock
validate_output

echo "✓ Integration test passed"
```

#### 20.2.3 多架构构建测试

```yaml
# .github/workflows/build-multiarch.yml
name: Multi-arch Build

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        arch: [aarch64, armhf, x86_64]
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Install cross-compiler
        run: |
          sudo apt-get update
          sudo apt-get install -y gcc-aarch64-linux-gnu gcc-arm-linux-gnueabihf
      
      - name: Build for ${{ matrix.arch }}
        run: |
          cd harness-remote
          make ARCH=${{ matrix.arch }}
      
      - name: Verify binary
        run: |
          file dist/harness-remote-linux-${{ matrix.arch }}
          # 验证架构正确
          readelf -h dist/harness-remote-linux-${{ matrix.arch }} | grep Machine
      
      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: harness-remote-${{ matrix.arch }}
          path: dist/harness-remote-linux-${{ matrix.arch }}
```

### 20.3 Host 插件测试

#### 20.3.1 单元测试（Jest）

```typescript
// tests/parsers/logParser.test.ts
import { parseLogEntry, LogEntry } from '../../src/parsers/logParser';

describe('LogParser', () => {
  describe('parseLogEntry', () => {
    it('should parse valid syslog entry', () => {
      const line = 'Aug 12 10:23:45 host kernel: [  123.456] OOM killer activated';
      
      const entry = parseLogEntry(line, 'linux-syslog');
      
      expect(entry).toMatchObject({
        source: 'linux-syslog',
        level: 'ERROR',
        message: expect.stringContaining('OOM killer'),
        module: 'kernel'
      });
    });
    
    it('should parse JSON log from MCU', () => {
      const line = '{"tick":1234,"lvl":"WARN","mod":"motor","msg":"overcurrent"}';
      
      const entry = parseLogEntry(line, 'mcu-rtt');
      
      expect(entry).toMatchObject({
        source: 'mcu-rtt',
        level: 'WARN',
        module: 'motor',
        message: 'overcurrent'
      });
    });
    
    it('should handle malformed input gracefully', () => {
      const line = 'Not a valid log format';
      
      const entry = parseLogEntry(line, 'linux-syslog');
      
      expect(entry.level).toBe('INFO');  // 默认级别
      expect(entry.message).toBe(line);   // 原始内容
    });
  });
});
```

#### 20.3.2 集成测试（Mock SSH）

```typescript
// tests/integration/sshConnection.test.ts
import { SSHClient } from '../../src/transport/sshClient';
import { MockSSHServer } from '../mocks/mockSSHServer';

describe('SSH Connection', () => {
  let mockServer: MockSSHServer;
  let client: SSHClient;
  
  beforeAll(async () => {
    mockServer = new MockSSHServer();
    await mockServer.start(2222);
  });
  
  afterAll(async () => {
    await mockServer.stop();
  });
  
  it('should connect and receive capabilities', async () => {
    client = new SSHClient({
      host: 'localhost',
      port: 2222,
      username: 'test',
      privateKey: TEST_PRIVATE_KEY
    });
    
    await client.connect();
    
    const capabilities = await client.getCapabilities();
    
    expect(capabilities).toMatchObject({
      init: 'systemd',
      arch: { normalized: 'x86_64' },
      coreDump: { enabled: expect.any(Boolean) }
    });
  });
  
  it('should handle connection failure and retry', async () => {
    mockServer.simulateDisconnect();
    
    const reconnected = await client.waitForReconnect(5000);
    
    expect(reconnected).toBe(true);
    expect(client.isConnected()).toBe(true);
  });
});
```

#### 20.3.3 UI 测试（Playwright）

```typescript
// tests/e2e/metricsPanel.spec.ts
import { test, expect } from '@playwright/test';

test('metrics panel displays real-time data', async ({ page }) => {
  // 启动 VSCode with extension
  await page.goto('vscode://extension/embedded-harness');
  
  // 连接到 Mock target
  await page.click('button:has-text("Connect")');
  await page.fill('input[placeholder="Host"]', 'mock-device');
  await page.click('button:has-text("OK")');
  
  // 等待连接建立
  await expect(page.locator('.status-indicator')).toHaveClass(/connected/);
  
  // 验证指标显示
  await expect(page.locator('.cpu-usage')).toContainText(/%$/);
  await expect(page.locator('.memory-chart')).toBeVisible();
  
  // 验证实时更新
  const initialCPU = await page.locator('.cpu-usage').textContent();
  await page.waitForTimeout(6000);  // 等待一个采样周期
  const updatedCPU = await page.locator('.cpu-usage').textContent();
  
  expect(updatedCPU).not.toBe(initialCPU);
});
```

### 20.4 端到端测试

#### 20.4.1 真实设备测试矩阵


| 设备          | 架构        | OS              | Init         | 测试场景                |
| ----------- | --------- | --------------- | ------------ | ------------------- |
| 树莓派 4       | aarch64   | Raspberry Pi OS | systemd      | 完整功能                |
| BeagleBone  | armhf     | Debian 11       | systemd      | Journal + Core Dump |
| 工控机         | x86_64    | Ubuntu 22.04    | systemd      | 高负载压力测试             |
| OpenWrt 路由器 | mipsel    | OpenWrt 22.03   | procd        | 最小化环境               |
| Buildroot   | armhf     | 自定义             | BusyBox init | 无 systemd 场景        |
| STM32H7     | Cortex-M7 | FreeRTOS        | N/A          | MCU RTT 日志          |


#### 20.4.2 E2E 测试用例

```typescript
// tests/e2e/full-workflow.test.ts

test('complete monitoring workflow', async ({ vscode, device }) => {
  // 1. 连接设备
  await vscode.command('harness.connectTarget', { 
    targetId: device.id 
  });
  await expect(vscode.status).toBe('connected');
  
  // 2. 验证 capabilities 检测
  const caps = await vscode.getCapabilities(device.id);
  expect(caps.arch.normalized).toBe(device.expectedArch);
  
  // 3. 若 core dump 未启用，执行配置向导
  if (!caps.coreDump.enabled) {
    await vscode.command('harness.setupCoreDump', { targetId: device.id });
    await vscode.confirmDialog();  // 确认执行脚本
    await expect(caps.coreDump.enabled).toBe(true);
  }
  
  // 4. 触发测试应用崩溃
  await device.ssh.exec('kill -SEGV $(pidof test-app)');
  
  // 5. 验证 Core Dump 检测与解析
  await expect(vscode.notification).toContainText('Core dump detected');
  const coreDump = await vscode.waitForCoreDump(10000);
  expect(coreDump.backtrace).toContain('segfault');
  
  // 6. 验证日志聚合
  const logs = await vscode.getLogs({
    sources: ['syslog', 'journal', 'dmesg'],
    level: 'ERROR',
    timeRange: 'last-5min'
  });
  expect(logs.some(l => l.message.includes('segmentation fault'))).toBe(true);
  
  // 7. 验证告警触发
  const alerts = await vscode.getAlerts();
  expect(alerts.some(a => a.type === 'core_dump')).toBe(true);
});
```

### 20.5 性能测试自动化

```typescript
// tests/perf/benchmark.test.ts

test('harness-remote resource usage', async ({ device }) => {
  // 启动采集器
  await device.ssh.exec('systemctl start harness-remote');
  await sleep(5000);  // 等待稳定
  
  // 测量基线资源
  const baseline = await device.measureResources('harness-remote');
  
  expect(baseline.rss_kb).toBeLessThan(3000);  // < 3 MB
  expect(baseline.cpu_percent).toBeLessThan(1);  // < 1%
  
  // 施加负载（高速日志生成）
  await device.ssh.exec('bash /tmp/generate_logs.sh');  // 1000 条/秒
  await sleep(60000);  // 持续 1 分钟
  
  // 测量高负载资源
  const underLoad = await device.measureResources('harness-remote');
  
  expect(underLoad.rss_kb).toBeLessThan(5000);  // < 5 MB
  expect(underLoad.cpu_percent).toBeLessThan(10);  // < 10%
  
  // 停止负载后验证恢复
  await device.ssh.exec('killall generate_logs.sh');
  await sleep(10000);
  
  const recovered = await device.measureResources('harness-remote');
  expect(recovered.rss_kb).toBeLessThan(baseline.rss_kb + 500);  // 允许 500KB 增长
});
```

### 20.6 回归测试

每次发布前必须通过的测试套件：

```bash
# tests/regression/run_all.sh

echo "=== Regression Test Suite ==="

# 1. 单元测试
echo "[1/6] Running unit tests..."
cd harness-remote && make test
cd ../extension && npm test

# 2. 集成测试
echo "[2/6] Running integration tests..."
npm run test:integration

# 3. 多架构构建
echo "[3/6] Testing multi-arch builds..."
./tests/build_all_archs.sh

# 4. 性能基准
echo "[4/6] Running performance benchmarks..."
npm run test:perf

# 5. E2E 测试（真实设备）
echo "[5/6] Running E2E tests on real devices..."
npm run test:e2e -- --devices=rpi4,beaglebone,x86vm

# 6. 安全扫描
echo "[6/6] Running security scans..."
npm audit
./tests/security/scan_ssh_config.sh

echo "=== All regression tests passed ✓ ==="
```

### 20.7 Fuzz 测试

测试异常输入的鲁棒性：

```c
// tests/fuzz/fuzz_log_parser.c
#include <stdint.h>
#include <stddef.h>
#include "../../src/parsers/log_parser.h"

// LibFuzzer 入口
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    if (size == 0 || size > 65536) return 0;
    
    // 确保 null 终止
    char *input = malloc(size + 1);
    memcpy(input, data, size);
    input[size] = '\0';
    
    // 测试解析器不崩溃
    LogEntry entry;
    parse_syslog_line(input, &entry);
    parse_journal_json(input, &entry);
    parse_dmesg_line(input, &entry);
    
    free(input);
    return 0;
}
```

```bash
# 运行 Fuzz 测试
clang -fsanitize=fuzzer,address -o fuzz_log_parser fuzz_log_parser.c log_parser.c
./fuzz_log_parser -max_total_time=300  # 5 分钟
```

### 20.8 模拟测试环境

#### 20.8.1 Docker 模拟不同发行版

```dockerfile
# tests/docker/Dockerfile.debian
FROM debian:11
RUN apt-get update && apt-get install -y \
    systemd rsyslog openssh-server gdb
COPY harness-remote-linux-x86_64 /usr/local/bin/harness-remote
COPY test_suite.sh /opt/
ENTRYPOINT ["/opt/test_suite.sh"]
```

```yaml
# tests/docker/docker-compose.yml
version: '3'
services:
  debian:
    build:
      context: .
      dockerfile: Dockerfile.debian
    privileged: true
  
  ubuntu:
    build:
      dockerfile: Dockerfile.ubuntu
    privileged: true
  
  alpine:
    build:
      dockerfile: Dockerfile.alpine
    privileged: true
```

```bash
# 在所有发行版上运行测试
docker-compose up --abort-on-container-exit
```

#### 20.8.2 QEMU 模拟 ARM 设备

```bash
# tests/qemu/run_arm_test.sh

# 启动 ARM64 虚拟机
qemu-system-aarch64 \
  -M virt \
  -cpu cortex-a57 \
  -m 1G \
  -kernel vmlinuz \
  -initrd initrd.img \
  -append "root=/dev/vda console=ttyAMA0" \
  -drive file=debian-arm64.qcow2,if=virtio \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -device virtio-net-device,netdev=net0 \
  -nographic &

# 等待启动
sleep 30

# 部署并测试
scp -P 2222 harness-remote-linux-aarch64 root@localhost:/usr/local/bin/harness-remote
ssh -p 2222 root@localhost '/opt/test_harness.sh'

# 关闭虚拟机
killall qemu-system-aarch64
```

### 20.9 测试数据管理

```typescript
// tests/fixtures/mockData.ts

export const MOCK_CAPABILITIES = {
  valid: {
    init: 'systemd',
    arch: { normalized: 'aarch64', libc: 'glibc' },
    logSources: ['syslog', 'journal', 'dmesg'],
    tools: { gdb: { available: true, version: '10.2' } },
    coreDump: { enabled: true, pattern: '/var/core/core.%e.%p' }
  },
  
  minimal: {
    init: 'busybox',
    arch: { normalized: 'armhf', libc: 'musl' },
    logSources: ['dmesg'],
    tools: {},
    coreDump: { enabled: false }
  },
  
  invalid: {
    // 缺少必需字段
    init: 'unknown'
  }
};

export const MOCK_LOG_ENTRIES = {
  syslog: [
    'Aug 12 10:23:45 host kernel: [  123.456] OOM killer activated',
    'Aug 12 10:23:46 host systemd[1]: myapp.service: Main process exited, code=dumped',
  ],
  
  journal: [
    '{"_PID":"1234","MESSAGE":"Service started","PRIORITY":"6"}',
  ],
  
  mcu: [
    '{"tick":1234,"lvl":"ERROR","mod":"motor","msg":"fault"}',
  ]
};
```

### 20.10 质量门禁

发布前必须满足的质量标准：


| 指标            | 目标    | 阻塞发布？  |
| ------------- | ----- | ------ |
| **单元测试覆盖率**   | > 80% | ✅ 是    |
| **集成测试通过率**   | 100%  | ✅ 是    |
| **E2E 测试通过率** | > 95% | ✅ 是    |
| **性能回归**      | < 10% | ✅ 是    |
| **内存泄漏**      | 0     | ✅ 是    |
| **安全漏洞（高危）**  | 0     | ✅ 是    |
| **安全漏洞（中危）**  | < 3   | ⚠️ 需评估 |
| **文档更新**      | 100%  | ✅ 是    |
| **多架构构建**     | 全部成功  | ✅ 是    |


CI/CD Pipeline：

```yaml
# .github/workflows/quality-gate.yml
name: Quality Gate

on:
  pull_request:
  push:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm test -- --coverage
      - name: Check coverage
        run: |
          COVERAGE=$(cat coverage/coverage-summary.json | jq '.total.lines.pct')
          if (( $(echo "$COVERAGE < 80" | bc -l) )); then
            echo "Coverage $COVERAGE% is below 80%"
            exit 1
          fi
  
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:integration
  
  e2e-tests:
    runs-on: [self-hosted, embedded-test-lab]
    steps:
      - run: npm run test:e2e
  
  performance:
    runs-on: [self-hosted, perf-test]
    steps:
      - run: npm run test:perf
      - name: Compare with baseline
        run: node scripts/compare-perf.js
  
  security:
    runs-on: ubuntu-latest
    steps:
      - run: npm audit --audit-level=high
      - uses: github/codeql-action/analyze@v2
  
  release:
    needs: [unit-tests, integration-tests, e2e-tests, performance, security]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
      - run: npm run package
      - uses: actions/upload-artifact@v3
```

---

## 21. 部署与运维

### 21.1 首次部署流程

#### 21.1.1 Host 端安装

**VSCode 插件安装**：

```bash
# 方法 1：从 Marketplace 安装
code --install-extension embedded-harness

# 方法 2：从 VSIX 文件安装（企业内部分发）
code --install-extension embedded-harness-1.0.0.vsix
```

**初始配置**：

1. 打开 VSCode 设置（Ctrl+,）
2. 搜索 "Embedded Harness"
3. 配置数据目录（默认 `~/.vscode-harness/`）
4. 配置保留策略（日志 7 天，指标 30 天）
5. 可选：配置 Host 交叉工具链路径

#### 21.1.2 Remote 端部署

**自动部署（推荐）**：

```typescript
// Host 插件自动执行
async function deployRemoteCollector(target: Target) {
  // 1. SSH 连接
  const ssh = await connectSSH(target);
  
  // 2. 探测架构
  const arch = await ssh.exec('uname -m');
  const libc = await detectLibc(ssh);
  
  // 3. 选择对应二进制
  const binaryName = `harness-remote-linux-${normalizeArch(arch)}`;
  const localPath = path.join(__dirname, 'dist', binaryName);
  
  // 4. 检查 Remote 版本
  const remoteVersion = await ssh.exec('/usr/local/bin/harness-remote --version').catch(() => null);
  
  if (remoteVersion !== LOCAL_VERSION) {
    // 5. 上传二进制
    await ssh.uploadFile(localPath, '/tmp/harness-remote');
    await ssh.exec('chmod +x /tmp/harness-remote');
    
    // 6. 安装到系统目录（需 sudo）
    await ssh.exec('sudo mv /tmp/harness-remote /usr/local/bin/');
    
    // 7. 安装 systemd 单元（若 systemd 可用）
    if (target.capabilities.init === 'systemd') {
      await installSystemdUnit(ssh);
    }
    
    // 8. 启动服务
    await ssh.exec('sudo systemctl start harness-remote');
  }
}
```

**手动部署**：

```bash
# 在 Remote 设备上执行

# 1. 下载对应架构的二进制（从发布页面或内部服务器）
wget https://releases.harness.dev/v1.0.0/harness-remote-linux-aarch64

# 2. 安装
sudo mv harness-remote-linux-aarch64 /usr/local/bin/harness-remote
sudo chmod +x /usr/local/bin/harness-remote

# 3. 创建 systemd 单元（systemd 系统）
sudo tee /etc/systemd/system/harness-remote.service <<EOF
[Unit]
Description=Embedded Harness Remote Collector
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/harness-remote
Restart=always
RestartSec=5
User=harness-deploy
OOMScoreAdjust=500

[Install]
WantedBy=multi-user.target
EOF

# 4. 启动服务
sudo systemctl daemon-reload
sudo systemctl enable harness-remote
sudo systemctl start harness-remote
```

### 21.2 升级策略

#### 21.2.1 Host 插件升级

**自动更新**（VSCode Marketplace）：

- VSCode 自动检测并提示更新
- 用户点击"更新"按钮
- 重新加载窗口生效

**手动更新**（企业部署）：

```bash
# 安装新版本 VSIX
code --install-extension embedded-harness-1.1.0.vsix --force

# 重启 VSCode
```

**配置迁移**：

```typescript
// 插件激活时检测配置版本
export async function activate(context: vscode.ExtensionContext) {
  const configVersion = context.globalState.get<number>('configVersion', 0);
  
  if (configVersion < 2) {
    // 从 v1.0 升级到 v1.1：迁移旧配置格式
    await migrateConfigV1ToV2(context);
    await context.globalState.update('configVersion', 2);
  }
  
  // ... 正常激活逻辑
}
```

#### 21.2.2 Remote 采集器升级

**滚动升级（多设备）**：

```typescript
async function upgradeAllTargets(targets: Target[]) {
  // 灰度策略：先升级 10%，观察 1 小时，再全量
  const canaryTargets = targets.slice(0, Math.ceil(targets.length * 0.1));
  const remainingTargets = targets.slice(canaryTargets.length);
  
  // 第一阶段：金丝雀
  console.log(`Upgrading ${canaryTargets.length} canary targets...`);
  for (const target of canaryTargets) {
    await upgradeRemoteCollector(target);
  }
  
  // 观察期
  console.log('Monitoring canary deployments for 1 hour...');
  await sleep(3600000);
  
  const canaryHealth = await checkTargetsHealth(canaryTargets);
  if (canaryHealth.failureRate > 0.1) {
    throw new Error('Canary deployment failed, aborting rollout');
  }
  
  // 第二阶段：全量
  console.log(`Upgrading remaining ${remainingTargets.length} targets...`);
  await Promise.all(
    remainingTargets.map(t => upgradeRemoteCollector(t))
  );
}

async function upgradeRemoteCollector(target: Target) {
  const ssh = await connectSSH(target);
  
  try {
    // 1. 下载新版本到临时位置
    await ssh.uploadFile(newBinaryPath, '/tmp/harness-remote-new');
    
    // 2. 验证二进制（版本号、架构）
    const version = await ssh.exec('/tmp/harness-remote-new --version');
    if (!version.includes(EXPECTED_VERSION)) {
      throw new Error('Version mismatch');
    }
    
    // 3. 停止旧服务
    await ssh.exec('sudo systemctl stop harness-remote');
    
    // 4. 备份旧版本
    await ssh.exec('sudo cp /usr/local/bin/harness-remote /usr/local/bin/harness-remote.bak');
    
    // 5. 替换二进制
    await ssh.exec('sudo mv /tmp/harness-remote-new /usr/local/bin/harness-remote');
    await ssh.exec('sudo chmod +x /usr/local/bin/harness-remote');
    
    // 6. 启动新服务
    await ssh.exec('sudo systemctl start harness-remote');
    
    // 7. 验证健康状态
    await sleep(5000);
    const health = await checkTargetHealth(target);
    if (!health.ok) {
      throw new Error('Health check failed after upgrade');
    }
    
    // 8. 清理备份
    await ssh.exec('sudo rm /usr/local/bin/harness-remote.bak');
    
    console.log(`✓ Target ${target.id} upgraded successfully`);
  } catch (error) {
    // 回滚
    console.error(`✗ Upgrade failed for ${target.id}, rolling back...`);
    await ssh.exec('sudo mv /usr/local/bin/harness-remote.bak /usr/local/bin/harness-remote');
    await ssh.exec('sudo systemctl start harness-remote');
    throw error;
  }
}
```

**版本兼容性矩阵**：


| Host 版本 | 兼容的 Remote 版本 | 说明                 |
| ------- | ------------- | ------------------ |
| 1.0.x   | 1.0.x         | 完全兼容               |
| 1.1.x   | 1.0.x, 1.1.x  | 向后兼容，旧 Remote 功能受限 |
| 1.2.x   | 1.1.x, 1.2.x  | 不兼容 1.0.x（协议变更）    |
| 2.0.x   | 2.0.x         | 主版本不兼容             |


协议版本协商：

```typescript
// Host 发起连接时声明支持的协议版本
const handshake = {
  protocolVersions: [3, 2],  // 支持 v3 和 v2
  hostVersion: '1.1.0'
};

// Remote 响应选择最高公共版本
const response = {
  selectedProtocolVersion: 2,
  remoteVersion: '1.0.5'
};
```

### 21.3 监控 Harness 自身

#### 21.3.1 Remote 采集器健康检查

```c
// 采集器内置健康端点（可选 HTTP 服务）
void handle_health_check(struct http_request *req) {
    HealthStatus status = {
        .uptime_sec = get_uptime(),
        .last_collection_time = g_last_collection_time,
        .collections_total = g_collections_total,
        .errors_total = g_errors_total,
        .memory_rss_kb = get_rss(),
        .cpu_percent = get_cpu_usage()
    };
    
    // 判断健康状态
    bool healthy = (time(NULL) - g_last_collection_time < 30) &&
                   (g_errors_total < 100);
    
    send_json_response(req, healthy ? 200 : 503, &status);
}
```

```bash
# 外部监控系统（Prometheus、Nagios）可轮询
curl http://remote-device:9090/health
```

#### 21.3.2 Host 插件自监控

```typescript
// 内置遥测
interface TelemetryData {
  activeTargets: number;
  connectionErrors24h: number;
  dataStorageSize: number;
  lastSuccessfulCollection: Record<string, number>;
}

// 定期上报到监控后台（可选，需用户同意）
async function reportTelemetry() {
  const data = await collectTelemetry();
  
  if (userConsented()) {
    await fetch('https://telemetry.harness.dev/report', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }
}
```

### 21.4 故障排查手册

#### 21.4.1 常见问题排查流程

**问题：无法连接 Remote 设备**

```
1. 检查网络连通性
   $ ping <remote-host>
   
2. 检查 SSH 端口
   $ telnet <remote-host> 22
   
3. 检查密钥权限
   $ ls -l ~/.ssh/harness_ed25519
   （应为 -rw-------）
   
4. 手动 SSH 测试
   $ ssh -i ~/.ssh/harness_ed25519 user@remote-host
   
5. 查看 Host 端日志
   VSCode → Output → Embedded Harness
   
6. 查看 Remote 端日志
   $ ssh remote-host 'journalctl -u harness-remote -n 50'
```

**问题：Core Dump 未检测到**

```
1. 检查 core dump 是否生成
   $ ssh remote-host 'ls -lh /var/core/'
   
2. 检查 ulimit 设置
   $ ssh remote-host 'ulimit -c'
   （应为 unlimited 或大于 0）
   
3. 检查 core_pattern
   $ ssh remote-host 'cat /proc/sys/kernel/core_pattern'
   
4. 手动触发测试 crash
   $ ssh remote-host 'kill -SEGV <test-pid>'
   
5. 查看 harness-remote 日志
   $ ssh remote-host 'journalctl -u harness-remote | grep -i core'
```

**问题：日志不显示或不完整**

```
1. 检查日志源权限
   $ ssh remote-host 'sudo -u harness-deploy cat /var/log/syslog'
   
2. 检查 journal 权限
   $ ssh remote-host 'groups harness-deploy | grep systemd-journal'
   
3. 检查自定义日志路径配置
   VSCode → Settings → Harness → Custom Log Paths
   
4. 检查 Remote 采集器状态
   $ ssh remote-host 'systemctl status harness-remote'
   
5. 启用详细日志
   修改 Remote 采集器配置：LOG_LEVEL=DEBUG
```

#### 21.4.2 日志收集

```bash
# 生成诊断报告
harness-cli diagnose --target <target-id> --output diag.tar.gz

# 报告内容：
# - Host 端配置和日志
# - Remote 端 capabilities 和日志
# - 最近的连接错误
# - 系统信息（OS、VSCode 版本）
```

### 21.5 卸载与清理

#### 21.5.1 Host 端卸载

```bash
# 卸载插件
code --uninstall-extension embedded-harness

# 清理数据（可选）
rm -rf ~/.vscode-harness/

# 清理配置
code --uninstall-extension embedded-harness --purge
```

#### 21.5.2 Remote 端卸载

```bash
# 停止服务
sudo systemctl stop harness-remote
sudo systemctl disable harness-remote

# 删除文件
sudo rm /usr/local/bin/harness-remote
sudo rm /etc/systemd/system/harness-remote.service

# 清理用户（可选）
sudo userdel harness-deploy
sudo rm -rf /var/lib/harness

# 重新加载 systemd
sudo systemctl daemon-reload
```

---

## 22. 技术选型建议


| 领域               | 推荐方案                              | 备选方案                |
| ---------------- | --------------------------------- | ------------------- |
| Remote Daemon 语言 | C（musl 静态交叉编译）                    | Shell + busybox     |
| Remote 多架构产物     | aarch64 + armhf + x86_64（P0/P1）   | riscv64 / mipsel 按需 |
| Remote 部署        | Host 按 uname -m SCP 对应二进制         | 用户手动拷贝              |
| Host 插件框架        | VSCode Extension API + TypeScript | Electron / 独立 GUI   |
| Linux 通信         | SSH + JSON                        | WebSocket / TCP     |
| MCU 调试通道         | SEGGER J-Link RTT                 | UART / OpenOCD      |
| 本地存储             | SQLite                            | LevelDB             |
| 图表渲染             | uPlot                             | Chart.js            |
| MCP SDK          | @modelcontextprotocol/sdk         | 自定义 JSON-RPC        |
| Core 解析          | arm-linux-gdb                     | llvm-symbolizer     |


---

## 15. 成功标准

本架构设计达到预期的成功标准如下：

- Remote 端保有稳定运行的轻量采集器，不拖垮业务程序
- Host 端可对 Linux 和 MCU 两类目标提供统一监控入口
- 日志、指标和 core dump 可在 VSCode 中集中展示
- 系统在断线、重启、日志丢失等异常场景中具备可恢复能力
- AI/MCP 仅增强分析能力，而不改变 Harness 的核心职责

---

## 16. 结论

Embedded Harness 采用的是典型的 “轻 Remote、重 Host” 分层架构。它的核心价值在于：

- 把嵌入式目标从复杂运行时中解放出来
- 把监控、诊断、告警、分析的重心放到 Host 端
- 把 MCU 与 Linux 分别视为不同的观察源，不混合执行环境

在工程实践中，真正的关键不在于 AI，而在于：

- 采集器是否稳定
- 协议是否清晰
- Host 是否具备完整的诊断闭环
- 能否在复杂故障下自动恢复并保持可观测性

因此，最优先的开发路径不是搭 AI，而是把 Host 端的 Harness 核心和 Remote 端的轻量采集器做稳，再逐步叠加 MCP 与 AI 增强能力。