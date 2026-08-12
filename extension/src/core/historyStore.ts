import * as fs from 'fs';
import * as path from 'path';
import { CoreDumpEvent, LogEntry, MetricsSnapshot } from '../types';

export class HistoryStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  static fromContext(context: { globalStorageUri: { fsPath: string } }): HistoryStore {
    return new HistoryStore(path.join(context.globalStorageUri.fsPath, 'history'));
  }

  private fileFor(targetId: string, kind: string): string {
    const safe = targetId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${safe}.${kind}.jsonl`);
  }

  appendMetrics(m: MetricsSnapshot): void {
    const line = JSON.stringify({ kind: 'metrics', ...m }) + '\n';
    fs.appendFileSync(this.fileFor(m.targetId, 'metrics'), line, 'utf8');
  }

  appendLogs(entries: LogEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const targetId = entries[0].targetId;
    const lines = entries.map((e) => JSON.stringify({ kind: 'log', ...e })).join('\n') + '\n';
    fs.appendFileSync(this.fileFor(targetId, 'logs'), lines, 'utf8');
  }

  appendCoreDump(ev: CoreDumpEvent): void {
    const line = JSON.stringify({ kind: 'coredump', ...ev }) + '\n';
    fs.appendFileSync(this.fileFor(ev.targetId, 'coredumps'), line, 'utf8');
  }

  readRecentMetrics(targetId: string, limit = 120): MetricsSnapshot[] {
    return this.readJsonl<MetricsSnapshot>(this.fileFor(targetId, 'metrics'), limit, 'metrics');
  }

  readRecentLogs(targetId: string, limit = 200): LogEntry[] {
    return this.readJsonl<LogEntry>(this.fileFor(targetId, 'logs'), limit, 'log');
  }

  readRecentCoreDumps(targetId: string, limit = 10): CoreDumpEvent[] {
    return this.readJsonl<CoreDumpEvent>(this.fileFor(targetId, 'coredumps'), limit, 'coredump');
  }

  listTargetIds(): string[] {
    if (!fs.existsSync(this.baseDir)) {
      return [];
    }
    const ids = new Set<string>();
    for (const f of fs.readdirSync(this.baseDir)) {
      const m = f.match(/^(.+)\.(metrics|logs|coredumps)\.jsonl$/);
      if (m) {
        ids.add(m[1]);
      }
    }
    return [...ids];
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private readJsonl<T>(file: string, limit: number, kind: string): T[] {
    if (!fs.existsSync(file)) {
      return [];
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    return slice
      .map((l) => {
        try {
          const obj = JSON.parse(l) as Record<string, unknown>;
          if (obj.kind === kind) {
            delete obj.kind;
            return obj as T;
          }
        } catch {
          /* skip */
        }
        return null;
      })
      .filter((x): x is T => x !== null);
  }
}
