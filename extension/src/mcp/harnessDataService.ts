import * as fs from 'fs';
import * as path from 'path';
import {
  getHistoryStore,
  getSessionManager,
} from '../core/harnessContext';
import { HistoryStore } from '../core/historyStore';
import { parseCapabilities, parseHarnessMessage, parseLogs, parseMetrics } from '../parsers/logParser';
import { getTargetsFromSettings, saveTargets } from '../core/session';
import { resolveWatchRules } from '../core/processMatchResolver';
import { watchRuleToEntry } from '../core/watchProcessWizard';
import {
  CoreDumpEvent,
  LogEntry,
  MetricsSnapshot,
  TargetCapabilities,
  TargetConfig,
} from '../types';

export class HarnessDataService {
  constructor(private readonly storageOnly?: HistoryStore) {}

  static fromStorageDir(storageDir: string): HarnessDataService {
    return new HarnessDataService(new HistoryStore(storageDir));
  }

  private store(): HistoryStore {
    if (this.storageOnly) {
      return this.storageOnly;
    }
    const h = getHistoryStore();
    if (!h) {
      throw new Error('History store unavailable');
    }
    return h;
  }

  listTargets(): TargetConfig[] {
    try {
      return getTargetsFromSettings();
    } catch {
      return this.store()
        .listTargetIds()
        .map((id) => ({ id, host: 'unknown', port: 22, username: 'unknown' }));
    }
  }

  async getLiveMetrics(targetId: string): Promise<MetricsSnapshot | null> {
    const session = getSessionManager()?.get(targetId);
    if (session?.isConnected()) {
      const latest = session.getLatestMetrics();
      if (latest) {
        return latest;
      }
      const binary = session.target.remoteBinary ?? 'harness-remote';
      const raw = await session.getTransport().exec(`${binary} metrics`);
      const msg = parseHarnessMessage(raw);
      return msg ? parseMetrics(targetId, msg) : null;
    }
    const history = this.store().readRecentMetrics(targetId, 1);
    return history[history.length - 1] ?? null;
  }

  getMetricsHistory(targetId: string, minutes = 5): MetricsSnapshot[] {
    const all = this.store().readRecentMetrics(targetId, 500);
    if (minutes <= 0) {
      return all;
    }
    const cutoff = Date.now() - minutes * 60 * 1000;
    return all.filter((m) => m.timestamp >= cutoff);
  }

  async getRecentLogs(
    targetId: string,
    options: { limit?: number; level?: string; source?: string } = {}
  ): Promise<LogEntry[]> {
    const limit = options.limit ?? 100;
    const session = getSessionManager()?.get(targetId);
    if (session?.isConnected()) {
      const live = session.getAggregator().getAll();
      if (live.length > 0) {
        return filterLogs(live, options).slice(-limit);
      }
      try {
        const binary = session.target.remoteBinary ?? 'harness-remote';
        const raw = await session.getTransport().exec(`${binary} logs`);
        const msg = parseHarnessMessage(raw);
        if (msg) {
          return filterLogs(parseLogs(targetId, msg), options).slice(-limit);
        }
      } catch {
        /* fall through */
      }
    }
    return filterLogs(this.store().readRecentLogs(targetId, limit * 2), options).slice(-limit);
  }

  getLastCoreDump(targetId: string): CoreDumpEvent | null {
    const dumps = this.store().readRecentCoreDumps(targetId, 1);
    return dumps[dumps.length - 1] ?? null;
  }

  async getCapabilities(targetId: string): Promise<TargetCapabilities | null> {
    const session = getSessionManager()?.get(targetId);
    if (session?.isConnected()) {
      const caps = session.getCapabilities();
      if (caps) {
        return caps;
      }
      try {
        const binary = session.target.remoteBinary ?? 'harness-remote';
        const raw = await session.getTransport().exec(`${binary} capabilities`);
        const msg = parseHarnessMessage(raw);
        return msg ? parseCapabilities(targetId, msg) : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async resolveProcessWatch(
    targetId: string,
    processName: string
  ): Promise<{ recommended: unknown; alternatives: unknown[] }> {
    const session = getSessionManager()?.get(targetId);
    if (!session?.isConnected()) {
      throw new Error('Target not connected — connect first for live /proc probe');
    }
    return resolveWatchRules(session.getTransport(), processName);
  }

  async addWatchedProcess(
    targetId: string,
    processName: string,
    apply = true
  ): Promise<{ entry: unknown; reason: string }> {
    const session = getSessionManager()?.get(targetId);
    if (!session?.isConnected()) {
      throw new Error('Target not connected');
    }
    const { recommended } = await resolveWatchRules(session.getTransport(), processName);
    const entry = watchRuleToEntry(recommended);

    if (apply) {
      const targets = getTargetsFromSettings();
      const target = targets.find((t) => t.id === targetId);
      if (!target) {
        throw new Error(`Target not found: ${targetId}`);
      }
      target.watchedProcesses = target.watchedProcesses ?? [];
      const idx = target.watchedProcesses.findIndex(
        (w) => w.alias === entry.alias || w.match === entry.match
      );
      if (idx >= 0) {
        target.watchedProcesses[idx] = entry;
      } else {
        target.watchedProcesses.push(entry);
      }
      await saveTargets(targets);
      session.updateTarget(target);
      await session.syncRemoteConfig();
    }

    return { entry, reason: recommended.reason };
  }

  writeMcpStateFile(statePath: string, storageDir: string, port: number, apiKey?: string): void {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ storageDir, port, apiKey: apiKey ?? '' }, null, 2),
      'utf8'
    );
  }

  static readMcpStateFile(statePath: string): {
    storageDir: string;
    port: number;
    apiKey: string;
  } | null {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        storageDir: string;
        port: number;
        apiKey: string;
      };
    } catch {
      return null;
    }
  }
}

function filterLogs(
  entries: LogEntry[],
  options: { level?: string; source?: string }
): LogEntry[] {
  return entries.filter((e) => {
    if (options.level && e.level !== options.level) {
      return false;
    }
    if (options.source && e.source !== options.source) {
      return false;
    }
    return true;
  });
}
