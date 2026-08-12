import {
  HarnessMessage,
  LogEntry,
  MetricsSnapshot,
  TargetCapabilities,
  CoreDumpEvent,
  CoreDumpStatus,
} from '../types';

export function parseHarnessMessage(raw: string): HarnessMessage | null {
  try {
    return JSON.parse(raw) as HarnessMessage;
  } catch {
    return null;
  }
}

export function parseMetrics(
  targetId: string,
  msg: HarnessMessage
): MetricsSnapshot | null {
  if (msg.type !== 'metrics') {
    return null;
  }
  const p = msg.payload as Record<string, unknown>;
  const cpu = p.cpu as MetricsSnapshot['cpu'];
  const memory = p.memory as MetricsSnapshot['memory'];
  const topProcesses = (p.topProcesses as MetricsSnapshot['topProcesses']) ?? [];
  const watchedProcesses =
    (p.watchedProcesses as MetricsSnapshot['watchedProcesses']) ?? [];
  return {
    targetId,
    timestamp: msg.timestamp ?? Date.now(),
    cpu,
    memory,
    topProcesses,
    watchedProcesses,
  };
}

export function parseCapabilities(
  targetId: string,
  msg: HarnessMessage
): TargetCapabilities | null {
  if (msg.type !== 'capabilities') {
    return null;
  }
  const p = msg.payload as Record<string, unknown>;
  return {
    targetId,
    init: String(p.init ?? 'unknown'),
    arch: (p.arch as TargetCapabilities['arch']) ?? {
      machine: 'unknown',
      normalized: 'unknown',
      libc: 'unknown',
    },
    logSources: (p.logSources as string[]) ?? [],
    tools: (p.tools as TargetCapabilities['tools']) ?? {},
    syslogPath: p.syslogPath as string | undefined,
    coreDump: p.coreDump as CoreDumpStatus | undefined,
  };
}

export function parseCoreDumpStatus(msg: HarnessMessage): CoreDumpStatus | null {
  if (msg.type !== 'coredump-status' && msg.type !== 'capabilities') {
    return null;
  }
  const p = msg.payload as Record<string, unknown>;
  if (msg.type === 'coredump-status') {
    return p as unknown as CoreDumpStatus;
  }
  return p.coreDump as CoreDumpStatus | undefined ?? null;
}

export function parseLogs(targetId: string, msg: HarnessMessage): LogEntry[] {
  if (msg.type !== 'logs') {
    return [];
  }
  const p = msg.payload as { entries?: Array<Record<string, unknown>> };
  const entries = p.entries ?? [];
  return entries.map((e) => ({
    targetId,
    source: (e.source as LogEntry['source']) ?? 'linux-syslog',
    customLogId: e.customLogId as string | undefined,
    timestamp: Number(e.timestamp ?? Date.now()),
    level: (e.level as LogEntry['level']) ?? 'INFO',
    message: String(e.message ?? ''),
    raw: e.raw as string | undefined,
  }));
}

export function parseCoreDumpEvents(
  targetId: string,
  msg: HarnessMessage
): CoreDumpEvent[] {
  if (msg.type !== 'events') {
    return [];
  }
  const p = msg.payload as { coredumps?: Array<Record<string, unknown>> };
  return (p.coredumps ?? []).map((e) => ({
    targetId,
    detectedAt: Number(e.detectedAt ?? Date.now()),
    source: (e.source as CoreDumpEvent['source']) ?? 'filesystem',
    remotePath: e.remotePath as string | undefined,
    coredumpctlId: e.coredumpctlId as string | undefined,
    pid: e.pid as number | undefined,
    executable: e.executable as string | undefined,
    signal: e.signal as number | undefined,
  }));
}

export function parseMcuLogLine(targetId: string, line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const level = String(obj.lvl ?? 'INFO').toUpperCase();
    return {
      targetId,
      source: 'mcu-uart',
      timestamp: Number(obj.ts ?? Date.now()),
      level: level as LogEntry['level'],
      module: obj.mod as string | undefined,
      message: String(obj.msg ?? trimmed),
      raw: trimmed,
    };
  } catch {
    return {
      targetId,
      source: 'mcu-uart',
      timestamp: Date.now(),
      level: 'INFO',
      message: trimmed,
      raw: trimmed,
    };
  }
}
