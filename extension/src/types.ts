export interface WatchedProcess {
  /** Match /proc comm or cmdline substring, e.g. myapp or nginx */
  match: string;
  label?: string;
}

export interface TargetConfig {
  id: string;
  host: string;
  port: number;
  username: string;
  /** `ssh` (default) or `wsl` for local WSL Linux on Windows */
  transport?: 'ssh' | 'wsl';
  /** WSL distro name, e.g. Ubuntu. Omit for default distro. */
  wslDistro?: string;
  privateKeyPath?: string;
  password?: string;
  remoteBinary?: string;
  customLogPaths?: CustomLogPath[];
  /** Processes to track every poll (name/cmdline match) */
  watchedProcesses?: WatchedProcess[];
  hostToolchain?: HostToolchain;
}

export interface HostToolchain {
  gdbPath?: string;
  sysroot?: string;
  elfPath?: string;
}

export interface CustomLogPath {
  id: string;
  path: string;
  label?: string;
}

export interface MetricsSnapshot {
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
  watchedProcesses?: Array<{
    pid: number;
    name: string;
    label: string;
    match: string;
    cpuPercent: number;
    memKb: number;
  }>;
}

export interface LogEntry {
  targetId: string;
  source:
    | 'linux-syslog'
    | 'linux-journal'
    | 'linux-dmesg'
    | 'linux-custom'
    | 'mcu-rtt'
    | 'mcu-uart';
  customLogId?: string;
  timestamp: number;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  module?: string;
  message: string;
  raw?: string;
}

export interface CoreDumpStatus {
  enabled: boolean;
  ulimitCore: string;
  pattern: string;
  storageWritable?: boolean;
  recommendedSetup: 'ulimit-pattern' | 'systemd-coredump' | 'unknown';
}

export interface TargetCapabilities {
  targetId: string;
  init: string;
  arch: {
    machine: string;
    normalized: string;
    libc: string;
  };
  logSources: string[];
  tools: {
    gdb?: { available: boolean };
    perf?: { available: boolean };
    coredumpctl?: { available: boolean };
  };
  syslogPath?: string;
  coreDump?: CoreDumpStatus;
}

export interface CoreDumpEvent {
  targetId: string;
  detectedAt: number;
  source: 'filesystem' | 'coredumpctl' | 'journal-only';
  remotePath?: string;
  coredumpctlId?: string;
  localPath?: string;
  pid?: number;
  executable?: string;
  signal?: number;
  backtrace?: string[];
}

export interface AlertRule {
  cpuThresholdPercent: number;
  cpuSustainPolls: number;
  memoryThresholdPercent: number;
  logLevelAlert: LogEntry['level'];
}

export interface HarnessMessage {
  protocolVersion: number;
  type: string;
  timestamp?: number;
  targetId?: string;
  payload: unknown;
}

export interface SessionState {
  connected: boolean;
  reconnectAttempts: number;
  droppedLogFrames: number;
  lastError?: string;
}
