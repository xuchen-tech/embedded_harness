import * as vscode from 'vscode';
import { AlertRule, CoreDumpEvent, LogEntry, MetricsSnapshot } from '../types';

export class AlertEngine {
  private highCpuStreak = 0;
  private lastMemUsedPct = 0;

  constructor(private rules: AlertRule) {}

  static fromSettings(): AlertEngine {
    const cfg = vscode.workspace.getConfiguration('embeddedHarness');
    return new AlertEngine({
      cpuThresholdPercent: cfg.get<number>('alert.cpuThresholdPercent') ?? 90,
      cpuSustainPolls: cfg.get<number>('alert.cpuSustainPolls') ?? 3,
      memoryThresholdPercent: cfg.get<number>('alert.memoryThresholdPercent') ?? 90,
      logLevelAlert: (cfg.get<string>('alert.logLevel') ?? 'ERROR') as LogEntry['level'],
    });
  }

  checkMetrics(m: MetricsSnapshot): string[] {
    const alerts: string[] = [];
    if (m.cpu.usagePercent >= this.rules.cpuThresholdPercent) {
      this.highCpuStreak++;
      if (this.highCpuStreak >= this.rules.cpuSustainPolls) {
        alerts.push(
          `[${m.targetId}] CPU ${m.cpu.usagePercent.toFixed(1)}% >= ${this.rules.cpuThresholdPercent}%`
        );
      }
    } else {
      this.highCpuStreak = 0;
    }

    if (m.memory.totalKb > 0) {
      const usedPct =
        ((m.memory.totalKb - m.memory.availableKb) / m.memory.totalKb) * 100;
      if (usedPct >= this.rules.memoryThresholdPercent) {
        alerts.push(
          `[${m.targetId}] Memory ${usedPct.toFixed(1)}% >= ${this.rules.memoryThresholdPercent}%`
        );
      }
      if (usedPct > this.lastMemUsedPct + 5) {
        /* rapid growth hint */
      }
      this.lastMemUsedPct = usedPct;
    }
    return alerts;
  }

  checkLogs(entries: LogEntry[]): string[] {
    const alerts: string[] = [];
    const order = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    const minIdx = order.indexOf(this.rules.logLevelAlert);
    for (const e of entries) {
      if (order.indexOf(e.level) >= minIdx) {
        alerts.push(`[${e.targetId}] ${e.level} ${e.source}: ${e.message.slice(0, 120)}`);
      }
    }
    return alerts;
  }

  checkCoreDump(ev: CoreDumpEvent): string[] {
    return [`[${ev.targetId}] Core dump detected (${ev.source}) ${ev.remotePath ?? ev.executable ?? ''}`];
  }

  notify(alerts: string[]): void {
    for (const a of alerts.slice(0, 5)) {
      vscode.window.showWarningMessage(a);
    }
  }
}
