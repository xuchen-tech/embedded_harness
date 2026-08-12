import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deployRemoteConfig } from './logWatchConfig';
import {
  parseCapabilities,
  parseCoreDumpEvents,
  parseHarnessMessage,
  parseLogs,
  parseMetrics,
} from '../parsers/logParser';
import { parseCoreDumpWithGdb } from '../parsers/coredumpParser';
import { createTransport } from '../transport/createTransport';
import { RemoteTransport } from '../transport/remoteTransport';
import { LogAggregator } from './aggregator';
import { AlertEngine } from './alertEngine';
import { HistoryStore } from './historyStore';
import {
  CoreDumpEvent,
  LogEntry,
  MetricsSnapshot,
  SessionState,
  TargetCapabilities,
  TargetConfig,
} from '../types';

export interface SessionCallbacks {
  onMetrics: (m: MetricsSnapshot) => void;
  onLogs: (logs: LogEntry[]) => void;
  onTimeline: (logs: LogEntry[]) => void;
  onStateChange: (state: SessionState) => void;
  onCoreDump: (ev: CoreDumpEvent, backtrace: string[]) => void;
}

export class HarnessSession {
  private _target: TargetConfig;
  private transport: RemoteTransport;
  private pollTimer: NodeJS.Timeout | undefined;
  private capabilities: TargetCapabilities | undefined;
  private latestMetrics: MetricsSnapshot | undefined;
  private aggregator = new LogAggregator();
  private alertEngine = AlertEngine.fromSettings();
  private state: SessionState = {
    connected: false,
    reconnectAttempts: 0,
    droppedLogFrames: 0,
  };
  private callbacks: SessionCallbacks | undefined;
  private history: HistoryStore | undefined;
  private intentionalDisconnect = false;
  private maxReconnectAttempts = 10;

  constructor(readonly targetId: string, target: TargetConfig) {
    this._target = target;
    this.transport = createTransport(target);
  }

  get target(): TargetConfig {
    return this._target;
  }

  updateTarget(target: TargetConfig): void {
    const transportChanged =
      target.transport !== this._target.transport ||
      target.wslDistro !== this._target.wslDistro ||
      target.host !== this._target.host ||
      target.port !== this._target.port ||
      target.username !== this._target.username;
    this._target = target;
    if (transportChanged) {
      this.transport = createTransport(target);
    }
  }

  async syncRemoteConfig(): Promise<void> {
    if (!this._target.customLogPaths?.length && !this._target.watchedProcesses?.length) {
      return;
    }
    await deployRemoteConfig(
      (cmd) => this.transport.exec(cmd),
      this._target.customLogPaths ?? [],
      this._target.watchedProcesses ?? []
    );
    await this.transport.exec('systemctl restart harness-remote 2>/dev/null || true');
  }

  setHistoryStore(store: HistoryStore): void {
    this.history = store;
  }

  getCapabilities(): TargetCapabilities | undefined {
    return this.capabilities;
  }

  getLatestMetrics(): MetricsSnapshot | undefined {
    return this.latestMetrics;
  }

  getAggregator(): LogAggregator {
    return this.aggregator;
  }

  getState(): SessionState {
    return { ...this.state };
  }

  getTransport(): RemoteTransport {
    return this.transport;
  }

  /** @deprecated use getTransport() */
  getSsh(): RemoteTransport {
    return this.transport;
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  async connect(): Promise<TargetCapabilities> {
    this.intentionalDisconnect = false;
    await this.transport.connect(this.target);
    const binary = this.target.remoteBinary ?? 'harness-remote';

    await this.syncRemoteConfig();

    const raw = await this.transport.exec(`${binary} capabilities`);
    const msg = parseHarnessMessage(raw);
    if (!msg) {
      throw new Error('Invalid capabilities response from remote');
    }
    const caps = parseCapabilities(this.targetId, msg);
    if (!caps) {
      throw new Error('Failed to parse capabilities');
    }
    this.capabilities = caps;
    this.state.connected = true;
    this.state.reconnectAttempts = 0;
    this.state.lastError = undefined;
    this.callbacks?.onStateChange(this.getState());
    return caps;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.stopPolling();
    await this.transport.disconnect();
    this.state.connected = false;
    this.callbacks?.onStateChange(this.getState());
  }

  startPolling(intervalMs: number, callbacks: SessionCallbacks): void {
    this.callbacks = callbacks;
    this.stopPolling();
    const binary = this.target.remoteBinary ?? 'harness-remote';

    const tick = async () => {
      if (this.intentionalDisconnect) {
        return;
      }
      if (!this.transport.isConnected()) {
        await this.tryReconnect();
        return;
      }
      try {
        const metricsRaw = await this.transport.exec(`${binary} metrics`);
        const metricsMsg = parseHarnessMessage(metricsRaw);
        if (metricsMsg) {
          const m = parseMetrics(this.targetId, metricsMsg);
          if (m) {
            m.timestamp = Date.now();
            this.latestMetrics = m;
            this.history?.appendMetrics(m);
            callbacks.onMetrics(m);
            this.alertEngine.notify(this.alertEngine.checkMetrics(m));
          }
        }

        const logsRaw = await this.transport.exec(`${binary} logs`);
        const logsMsg = parseHarnessMessage(logsRaw);
        if (logsMsg) {
          const logs = parseLogs(this.targetId, logsMsg);
          const dropped = this.aggregator.push(logs);
          if (dropped > 0) {
            this.state.droppedLogFrames += dropped;
            this.callbacks?.onStateChange(this.getState());
          }
          this.history?.appendLogs(logs);
          callbacks.onLogs(logs);
          callbacks.onTimeline(this.aggregator.getAll());
          this.alertEngine.notify(this.alertEngine.checkLogs(logs));
        }

        const eventsRaw = await this.transport.exec(`${binary} events`);
        const eventsMsg = parseHarnessMessage(eventsRaw);
        if (eventsMsg) {
          const events = parseCoreDumpEvents(this.targetId, eventsMsg);
          for (const ev of events) {
            await this.handleCoreDump(ev, binary);
          }
        }
      } catch (e) {
        this.state.lastError = String(e);
        this.state.connected = false;
        this.callbacks?.onStateChange(this.getState());
        await this.tryReconnect();
      }
    };

    void tick();
    this.pollTimer = setInterval(() => void tick(), intervalMs);
  }

  private async handleCoreDump(ev: CoreDumpEvent, binary: string): Promise<void> {
    this.history?.appendCoreDump(ev);
    this.alertEngine.notify(this.alertEngine.checkCoreDump(ev));

    const cacheBase = path.join(
      this.history?.getBaseDir() ?? path.join(os.tmpdir(), 'embedded-harness'),
      'coredumps',
      this.targetId.replace(/[^a-zA-Z0-9_-]/g, '_')
    );
    fs.mkdirSync(cacheBase, { recursive: true });

    let localPath: string | undefined;
    try {
      if (ev.source === 'filesystem' && ev.remotePath && ev.remotePath[0] === '/') {
        localPath = `${cacheBase}/${Date.now()}.core`;
        await this.transport.downloadFile(ev.remotePath, localPath);
        ev.localPath = localPath;
      } else if (ev.source === 'coredumpctl' && ev.remotePath) {
        localPath = `${cacheBase}/${Date.now()}.core`;
        await this.transport.downloadCoreViaCoredumpctl(ev.remotePath, localPath);
        ev.localPath = localPath;
      }
    } catch {
      /* journal-only or download failed */
    }

    const toolchain = this.target.hostToolchain ?? {};
    const cfg = vscode.workspace.getConfiguration('embeddedHarness');
    const gdbPath = toolchain.gdbPath ?? cfg.get<string>('hostToolchain.gdbPath');
    const sysroot = toolchain.sysroot ?? cfg.get<string>('hostToolchain.sysroot');
    const elfPath = toolchain.elfPath ?? cfg.get<string>('hostToolchain.elfPath');

    let backtrace: string[] = [];
    if (ev.localPath) {
      backtrace = await parseCoreDumpWithGdb(ev, ev.localPath, {
        gdbPath,
        sysroot,
        elfPath,
      });
    } else {
      backtrace = [
        'No core file downloaded.',
        ev.executable ? `Journal: ${ev.executable}` : 'Check journal / coredumpctl on device.',
        `Verify with: ${binary} coredump-status`,
      ];
    }
    ev.backtrace = backtrace;
    this.callbacks?.onCoreDump(ev, backtrace);
  }

  private async tryReconnect(): Promise<void> {
    if (this.intentionalDisconnect) {
      return;
    }
    if (this.state.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }
    this.state.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(2, this.state.reconnectAttempts - 1));
    await new Promise((r) => setTimeout(r, delay));
    try {
      await this.connect();
    } catch (e) {
      this.state.lastError = String(e);
      this.callbacks?.onStateChange(this.getState());
    }
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

export class SessionManager {
  private sessions = new Map<string, HarnessSession>();

  get(id: string): HarnessSession | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(target: TargetConfig): HarnessSession {
    let s = this.sessions.get(target.id);
    if (!s) {
      s = new HarnessSession(target.id, target);
      this.sessions.set(target.id, s);
    } else {
      s.updateTarget(target);
    }
    return s;
  }

  list(): HarnessSession[] {
    return [...this.sessions.values()];
  }

  async disconnectAll(): Promise<void> {
    for (const s of this.sessions.values()) {
      await s.disconnect();
    }
  }
}

export function getTargetsFromSettings(): TargetConfig[] {
  const cfg = vscode.workspace.getConfiguration('embeddedHarness');
  return cfg.get<TargetConfig[]>('targets') ?? [];
}

export async function saveTargets(targets: TargetConfig[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('embeddedHarness');
  const scope = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await cfg.update('targets', targets, scope);
}
