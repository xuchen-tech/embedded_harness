import { HarnessDataService } from './harnessDataService';
import { LogEntry, MetricsSnapshot } from '../types';

export interface DiagnosticReport {
  template: string;
  targetId: string;
  summary: string;
  findings: string[];
  evidence: Record<string, unknown>;
  suggestions: string[];
}

export async function analyzeCpuSpike(
  data: HarnessDataService,
  targetId: string,
  windowMinutes = 5
): Promise<DiagnosticReport> {
  const metrics = data.getMetricsHistory(targetId, windowMinutes);
  const logs = await data.getRecentLogs(targetId, { limit: 50, level: 'ERROR' });

  if (metrics.length === 0) {
    return emptyReport('cpu_spike', targetId, 'No metrics in the requested window.');
  }

  let peak = metrics[0];
  for (const m of metrics) {
    if (m.cpu.usagePercent > peak.cpu.usagePercent) {
      peak = m;
    }
  }

  const avgCpu = metrics.reduce((s, m) => s + m.cpu.usagePercent, 0) / metrics.length;
  const findings: string[] = [
    `Peak CPU ${peak.cpu.usagePercent.toFixed(1)}% at ${new Date(peak.timestamp).toISOString()}`,
    `Average CPU ${avgCpu.toFixed(1)}% over ${windowMinutes}m`,
    `Load at peak: ${peak.cpu.load1.toFixed(2)} (1m)`,
  ];

  const topAtPeak = peak.topProcesses?.slice(0, 5) ?? [];
  if (topAtPeak.length > 0) {
    findings.push(
      'Top processes at peak: ' +
        topAtPeak.map((p) => `${p.name}(pid=${p.pid}, mem=${p.memKb}KB)`).join(', ')
    );
  }

  const correlated = correlateLogs(logs, peak.timestamp, 120_000);
  if (correlated.length > 0) {
    findings.push(`${correlated.length} ERROR log(s) within ±2m of peak`);
  }

  const suggestions = [
    'Check if peak aligns with periodic jobs (cron/systemd timer).',
    'If single process dominates, profile with perf (if available on target).',
    'Review dmesg/journal for OOM or driver errors near peak timestamp.',
  ];

  return {
    template: 'cpu_spike',
    targetId,
    summary: `CPU spike analysis (${windowMinutes}m window)`,
    findings,
    evidence: { peakMetrics: peak, sampleCount: metrics.length, errorLogs: correlated.slice(0, 10) },
    suggestions,
  };
}

export async function analyzeMemoryLeak(
  data: HarnessDataService,
  targetId: string,
  windowMinutes = 30
): Promise<DiagnosticReport> {
  const metrics = data.getMetricsHistory(targetId, windowMinutes);
  if (metrics.length < 3) {
    return emptyReport('memory_leak', targetId, 'Need at least 3 metric samples.');
  }

  const usedPct = metrics.map((m) => memUsedPercent(m));
  const first = usedPct[0];
  const last = usedPct[usedPct.length - 1];
  const delta = last - first;

  const monotonicGrowth = isMonotonicIncrease(usedPct, 0.5);
  const findings: string[] = [
    `Memory used ${first.toFixed(1)}% → ${last.toFixed(1)}% (Δ ${delta.toFixed(1)}%)`,
    monotonicGrowth ? 'Trend: monotonic growth detected' : 'Trend: not strictly monotonic',
  ];

  const logs = await data.getRecentLogs(targetId, { limit: 30 });
  const oomHints = logs.filter(
    (l) =>
      l.message.toLowerCase().includes('oom') ||
      l.message.toLowerCase().includes('out of memory') ||
      l.message.toLowerCase().includes('killed process')
  );
  if (oomHints.length > 0) {
    findings.push(`${oomHints.length} OOM-related log line(s) in recent history`);
  }

  const suggestions = [
    delta > 10
      ? 'Significant memory growth — inspect top RSS processes on target.'
      : 'Growth moderate — continue monitoring over longer window.',
    'Check for unreleased buffers in application logs.',
    'Verify no memory leak in kernel drivers via dmesg.',
  ];

  return {
    template: 'memory_leak',
    targetId,
    summary: `Memory trend analysis (${windowMinutes}m)`,
    findings,
    evidence: { usedPercentSeries: usedPct, oomHints: oomHints.slice(0, 5) },
    suggestions,
  };
}

export async function analyzeLaunchFailure(
  data: HarnessDataService,
  targetId: string,
  serviceName?: string
): Promise<DiagnosticReport> {
  const logs = await data.getRecentLogs(targetId, { limit: 200 });
  const journal = logs.filter((l) => l.source === 'linux-journal' || l.source === 'linux-syslog');

  const launchPatterns = [
    'Failed to start',
    'Main process exited',
    'code=exited',
    'code=dumped',
    'No such file',
    'Permission denied',
    'error while loading shared libraries',
    'Segmentation fault',
  ];

  let relevant = journal.filter((l) =>
    launchPatterns.some((p) => l.message.includes(p))
  );

  if (serviceName) {
    const sn = serviceName.toLowerCase();
    relevant = relevant.filter((l) => l.message.toLowerCase().includes(sn));
  }

  const findings: string[] = [];
  if (relevant.length === 0) {
    findings.push('No obvious launch failure patterns in recent logs.');
  } else {
    findings.push(`${relevant.length} launch-related log line(s) found`);
    for (const line of relevant.slice(-5)) {
      findings.push(`[${line.source}] ${line.message.slice(0, 200)}`);
    }
  }

  const core = data.getLastCoreDump(targetId);
  if (core) {
    findings.push(`Recent core dump: ${core.source} ${core.remotePath ?? core.executable ?? ''}`);
  }

  const suggestions = [
    'Verify binary exists and is executable on target architecture.',
    'Check LD_LIBRARY_PATH / RPATH for missing shared libraries.',
    'Run service manually on target to capture stderr.',
    serviceName ? `Inspect: journalctl -u ${serviceName} -n 50` : 'Identify failing unit in journal.',
  ];

  return {
    template: 'launch_failure',
    targetId,
    summary: serviceName ? `Launch analysis: ${serviceName}` : 'Launch / startup failure analysis',
    findings,
    evidence: { matchedLogs: relevant.slice(-15), lastCoreDump: core },
    suggestions,
  };
}

function memUsedPercent(m: MetricsSnapshot): number {
  if (m.memory.totalKb <= 0) {
    return 0;
  }
  return ((m.memory.totalKb - m.memory.availableKb) / m.memory.totalKb) * 100;
}

function isMonotonicIncrease(values: number[], tolerance: number): boolean {
  let increases = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1] + tolerance) {
      increases++;
    }
  }
  return increases >= Math.floor(values.length * 0.6);
}

function correlateLogs(logs: LogEntry[], ts: number, windowMs: number): LogEntry[] {
  return logs.filter((l) => Math.abs(l.timestamp - ts) <= windowMs);
}

function emptyReport(template: string, targetId: string, msg: string): DiagnosticReport {
  return {
    template,
    targetId,
    summary: msg,
    findings: [msg],
    evidence: {},
    suggestions: ['Connect to target and collect metrics/logs first.'],
  };
}
