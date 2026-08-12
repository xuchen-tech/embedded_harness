import * as vscode from 'vscode';
import * as path from 'path';
import {
  getTargetsFromSettings,
  saveTargets,
  SessionManager,
} from './core/session';
import { HistoryStore } from './core/historyStore';
import { setHarnessContext } from './core/harnessContext';
import { runCoreDumpWizard } from './core/remoteSetup';
import { runDebugEnvWizard } from './core/debugEnvWizard';
import { HarnessDataService } from './mcp/harnessDataService';
import { McpHost, getMcpCursorConfig } from './mcp/mcpHost';
import {
  analyzeCpuSpike,
  analyzeLaunchFailure,
  analyzeMemoryLeak,
} from './mcp/diagnostics';
import { MetricsPanel } from './ui/metricsPanel';
import { LogView } from './ui/logView';
import { TimelineView } from './ui/timelineView';
import { CoredumpView } from './ui/coredumpView';
import { SerialReader } from './transport/serialReader';
import { targetDisplayLabel } from './transport/createTransport';
import { addWslTargetInteractive } from './core/wslSetup';
import { isWslAvailable } from './transport/wslClient';
import { fetchProcessDetail, showProcessDetailPanel } from './core/processDetail';
import { resolveAndPickWatchRule, watchRuleToEntry } from './core/watchProcessWizard';
import { ensurePerfOrGuide, profileProcessFlameGraph } from './core/perfProfile';
import { FlameGraphPanel } from './ui/flameGraphPanel';
import { TargetConfig } from './types';

class TargetTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  constructor(private sessions: SessionManager) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const targets = getTargetsFromSettings();
    if (targets.length === 0) {
      const items: vscode.TreeItem[] = [];

      if (isWslAvailable()) {
        const wsl = new vscode.TreeItem('添加 WSL Target（本机 Linux）', vscode.TreeItemCollapsibleState.None);
        wsl.iconPath = new vscode.ThemeIcon('terminal-linux');
        wsl.command = { command: 'embeddedHarness.addWslTarget', title: 'Add WSL Target' };
        items.push(wsl);
      }

      const hint = new vscode.TreeItem(
        '添加 SSH Linux Target',
        vscode.TreeItemCollapsibleState.None
      );
      hint.description = '嵌入式板卡 / 远程设备';
      hint.iconPath = new vscode.ThemeIcon('add');
      hint.command = {
        command: 'embeddedHarness.addTarget',
        title: 'Add Linux Target',
      };
      items.push(hint);

      const settings = new vscode.TreeItem(
        '打开 settings.json 手动配置',
        vscode.TreeItemCollapsibleState.None
      );
      settings.iconPath = new vscode.ThemeIcon('gear');
      settings.command = {
        command: 'workbench.action.openSettingsJson',
        title: 'Open Settings',
      };
      items.push(settings);

      return items;
    }

    return targets.map((t) => {
      const session = this.sessions.get(t.id);
      const connected = session?.isConnected() ?? false;
      const state = session?.getState();
      const item = new vscode.TreeItem(
        t.id,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = `${targetDisplayLabel(t)} — ${connected ? 'connected' : 'disconnected'}${
        state?.reconnectAttempts ? ` (retry ${state.reconnectAttempts})` : ''
      }`;
      item.iconPath = new vscode.ThemeIcon(
        t.transport === 'wsl' ? 'terminal-linux' : connected ? 'radio-tower' : 'debug-disconnect'
      );
      item.contextValue = 'target';
      item.tooltip =
        t.transport === 'wsl'
          ? `WSL${t.wslDistro ? `: ${t.wslDistro}` : ''}\nClick to connect`
          : `${t.username}@${t.host}:${t.port || 22}\nClick to connect`;
      item.command = {
        command: 'embeddedHarness.connect',
        title: 'Connect',
        arguments: [t.id],
      };
      return item;
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
}

export function activate(context: vscode.ExtensionContext): void {
  const sessions = new SessionManager();
  const history = HistoryStore.fromContext(context);
  setHarnessContext(sessions, history);

  const dataService = new HarnessDataService();
  let mcpHost: McpHost | undefined;

  const logView = new LogView();
  const coredumpView = new CoredumpView();
  const serialReader = new SerialReader();
  const tree = new TargetTreeProvider(sessions);
  vscode.window.registerTreeDataProvider('embeddedHarness.targets', tree);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('embeddedHarness.targets')) {
        tree.refresh();
      }
    })
  );

  if (getTargetsFromSettings().length === 0) {
    void vscode.window
      .showInformationMessage(
        'Embedded Harness: 添加 WSL Target（本机）或 SSH Target（板卡）',
        'Add WSL Target',
        'Add SSH Target'
      )
      .then((choice) => {
        if (choice === 'Add WSL Target') {
          void vscode.commands.executeCommand('embeddedHarness.addWslTarget');
        } else if (choice === 'Add SSH Target') {
          void vscode.commands.executeCommand('embeddedHarness.addTarget');
        }
      });
  }

  const cfg = () => vscode.workspace.getConfiguration('embeddedHarness');
  const pollMs = () => cfg().get<number>('pollIntervalMs') ?? 3000;
  const profileDurationSec = () => cfg().get<number>('perfProfileDurationSec') ?? 15;

  const runProfileForProcess = async (
    targetId: string,
    pid: number,
    label: string
  ): Promise<void> => {
    const session = sessions.get(targetId);
    if (!session?.isConnected()) {
      vscode.window.showWarningMessage('Connect target first.');
      return;
    }
    const caps = session.getCapabilities();
    if (!caps) {
      vscode.window.showWarningMessage('Capabilities unavailable.');
      return;
    }

    const perfStatus = await ensurePerfOrGuide(
      session.getTransport(),
      caps,
      context.extensionPath
    );
    if (!perfStatus) {
      return;
    }

    const duration = profileDurationSec();
    const outDir = path.join(context.globalStorageUri.fsPath, 'perf', targetId.replace(/[^\w-]/g, '_'));

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `perf record ${label} (PID ${pid}, ${duration}s)…`,
          cancellable: false,
        },
        () =>
          profileProcessFlameGraph(
            session.getTransport(),
            pid,
            label,
            duration,
            outDir,
            perfStatus
          )
      );

      FlameGraphPanel.show(result.svg, `Flame: ${label}`);
      if (result.sampleCount === 0) {
        vscode.window.showWarningMessage(
          'No stack samples. Ensure the process was active; try sudo sysctl kernel.perf_event_paranoid=-1.'
        );
      } else {
        vscode.window.showInformationMessage(
          `Flame graph ready (${result.sampleCount} samples). Saved: ${result.svgPath}`
        );
      }
    } catch (e) {
      vscode.window.showErrorMessage(`perf profile failed: ${e}`);
    }
  };

  const writeMcpState = () => {
    const statePath = path.join(context.globalStorageUri.fsPath, 'mcp', 'state.json');
    dataService.writeMcpStateFile(
      statePath,
      history.getBaseDir(),
      cfg().get<number>('mcp.port') ?? 9765,
      cfg().get<string>('mcp.apiKey')
    );
  };

  const startSession = async (target: TargetConfig) => {
    const session = sessions.getOrCreate(target);
    session.setHistoryStore(history);
    const caps = await session.connect();

    vscode.window.showInformationMessage(
      `Connected: arch=${caps.arch.normalized} core=${caps.coreDump?.enabled ? 'on' : 'OFF'} logs=[${caps.logSources.join(',')}]`
    );

    if (!caps.coreDump?.enabled) {
      const fix = await vscode.window.showWarningMessage(
        'Core dump not enabled.',
        'Setup Wizard',
        'Later'
      );
      if (fix === 'Setup Wizard') {
        await runCoreDumpWizard(session.getSsh(), caps, target.remoteBinary ?? 'harness-remote');
      }
    }

    const metricsPanel = MetricsPanel.show(context.extensionUri);
    metricsPanel.setProcessClickHandler(async (pid, targetId) => {
      const sess = sessions.get(targetId);
      if (!sess?.isConnected()) {
        vscode.window.showWarningMessage('Target not connected.');
        return;
      }
      try {
        const detail = await fetchProcessDetail(sess.getTransport(), pid);
        await showProcessDetailPanel(detail);
      } catch (e) {
        vscode.window.showErrorMessage(`Process detail failed: ${e}`);
      }
    });
    metricsPanel.setProfileHandler(async (pid, targetId, label) => {
      await runProfileForProcess(targetId, pid, label);
    });
    const timeline = TimelineView.show();
    logView.show();

    session.startPolling(pollMs(), {
      onMetrics: (m) => metricsPanel.update(m),
      onLogs: (logs) => logView.append(logs),
      onTimeline: (all) => timeline.update(all),
      onStateChange: () => tree.refresh(),
      onCoreDump: (ev, bt) => coredumpView.showEvent(ev, bt),
    });
    tree.refresh();
    writeMcpState();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('embeddedHarness.addTarget', async () => {
      const id = await vscode.window.showInputBox({ prompt: 'Target ID' });
      if (!id) return;
      const host = await vscode.window.showInputBox({ prompt: 'SSH Host' });
      if (!host) return;
      const username = await vscode.window.showInputBox({ prompt: 'SSH Username' });
      if (!username) return;
      const key = await vscode.window.showOpenDialog({ canSelectMany: false });

      const targets = getTargetsFromSettings();
      targets.push({
        id,
        host,
        port: 22,
        username,
        privateKeyPath: key?.[0]?.fsPath,
        customLogPaths: [],
      });
      await saveTargets(targets);
      tree.refresh();
    }),

    vscode.commands.registerCommand('embeddedHarness.addWslTarget', async () => {
      const target = await addWslTargetInteractive(context.extensionUri);
      if (target) {
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand('embeddedHarness.connect', async (targetId?: string) => {
      const targets = getTargetsFromSettings();
      if (!targets.length) {
        vscode.window.showWarningMessage('Add a target first.');
        return;
      }
      const id =
        targetId ??
        (await vscode.window.showQuickPick(targets.map((t) => t.id), { placeHolder: 'Target' }));
      if (!id) return;
      const target = targets.find((t) => t.id === id);
      if (!target) return;
      try {
        await startSession(target);
      } catch (e) {
        vscode.window.showErrorMessage(`Connect failed: ${e}`);
      }
    }),

    vscode.commands.registerCommand('embeddedHarness.disconnect', async () => {
      await sessions.disconnectAll();
      serialReader.stop();
      tree.refresh();
    }),

    vscode.commands.registerCommand('embeddedHarness.refreshTargets', () => {
      tree.refresh();
      vscode.window.showInformationMessage(
        `Targets: ${getTargetsFromSettings().length} configured`
      );
    }),

    vscode.commands.registerCommand('embeddedHarness.showMetrics', () => {
      MetricsPanel.show(context.extensionUri);
    }),

    vscode.commands.registerCommand('embeddedHarness.showLogs', () => logView.show()),

    vscode.commands.registerCommand('embeddedHarness.showTimeline', () => TimelineView.show()),

    vscode.commands.registerCommand('embeddedHarness.setupCoreDump', async () => {
      const id = await vscode.window.showQuickPick(getTargetsFromSettings().map((t) => t.id));
      if (!id) return;
      const session = sessions.get(id);
      const caps = session?.getCapabilities();
      const target = getTargetsFromSettings().find((t) => t.id === id);
      if (!session || !caps || !target) {
        vscode.window.showWarningMessage('Connect first.');
        return;
      }
      await runCoreDumpWizard(session.getSsh(), caps, target.remoteBinary ?? 'harness-remote');
    }),

    vscode.commands.registerCommand('embeddedHarness.setupDebugEnv', async () => {
      const id = await vscode.window.showQuickPick(getTargetsFromSettings().map((t) => t.id));
      if (!id) return;
      const session = sessions.get(id);
      const caps = session?.getCapabilities();
      if (!session || !caps) {
        vscode.window.showWarningMessage('Connect first.');
        return;
      }
      await runDebugEnvWizard(session.getSsh(), caps, context.extensionPath);
    }),

    vscode.commands.registerCommand('embeddedHarness.startMcpServer', async () => {
      const port = cfg().get<number>('mcp.port') ?? 9765;
      const apiKey = cfg().get<string>('mcp.apiKey');
      if (!mcpHost?.isRunning()) {
        mcpHost = new McpHost(dataService, port, apiKey || undefined);
        await mcpHost.start();
        writeMcpState();
        vscode.window.showInformationMessage(
          `MCP SSE server on http://127.0.0.1:${port}/sse (health: /health)`
        );
      } else {
        vscode.window.showInformationMessage(`MCP already running on port ${port}`);
      }
    }),

    vscode.commands.registerCommand('embeddedHarness.stopMcpServer', async () => {
      if (mcpHost) {
        await mcpHost.stop();
        mcpHost = undefined;
        vscode.window.showInformationMessage('MCP server stopped.');
      }
    }),

    vscode.commands.registerCommand('embeddedHarness.showMcpConfig', async () => {
      writeMcpState();
      const config = getMcpCursorConfig(
        context.extensionPath,
        history.getBaseDir(),
        cfg().get<string>('mcp.apiKey')
      );
      const text = JSON.stringify(config, null, 2);
      const doc = await vscode.workspace.openTextDocument({
        content: text,
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        'Add embedded-harness entry to Cursor MCP settings. Set HARNESS_STORAGE_DIR to history path shown.'
      );
    }),

    vscode.commands.registerCommand('embeddedHarness.runDiagnostic', async () => {
      const targets = getTargetsFromSettings();
      const id = await vscode.window.showQuickPick(targets.map((t) => t.id));
      if (!id) return;
      const template = await vscode.window.showQuickPick([
        { label: 'CPU Spike', id: 'cpu' },
        { label: 'Memory Leak', id: 'mem' },
        { label: 'Launch Failure', id: 'launch' },
      ]);
      if (!template) return;

      let report;
      if (template.id === 'cpu') {
        report = await analyzeCpuSpike(dataService, id, 5);
      } else if (template.id === 'mem') {
        report = await analyzeMemoryLeak(dataService, id, 30);
      } else {
        const svc = await vscode.window.showInputBox({ prompt: 'Service name (optional)' });
        report = await analyzeLaunchFailure(dataService, id, svc);
      }

      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(report, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('embeddedHarness.addWatchedProcess', async () => {
      const targets = getTargetsFromSettings();
      const id = await vscode.window.showQuickPick(targets.map((t) => t.id), {
        placeHolder: 'Target',
      });
      if (!id) return;
      const businessName = await vscode.window.showInputBox({
        prompt: 'Business process name (e.g. payment-service, nginx, myapp)',
        placeHolder: 'Enter process or service name — match rule is auto-generated',
      });
      if (!businessName) return;

      const target = targets.find((t) => t.id === id)!;
      const session = sessions.get(id);
      const transport = session?.isConnected() ? session.getTransport() : undefined;

      if (!transport) {
        const go = await vscode.window.showWarningMessage(
          'Target not connected — rule will be guessed offline. Connect for auto-detect from /proc.',
          'Connect now',
          'Save anyway'
        );
        if (go === 'Connect now') {
          await startSession(target);
          const connected = sessions.get(id);
          if (!connected?.isConnected()) {
            return;
          }
        } else if (go !== 'Save anyway') {
          return;
        }
      }

      const activeSession = sessions.get(id);
      const rule = await resolveAndPickWatchRule(
        activeSession?.isConnected() ? activeSession.getTransport() : undefined,
        businessName
      );
      const entry = watchRuleToEntry(rule);

      target.watchedProcesses = target.watchedProcesses ?? [];
      const existsIdx = target.watchedProcesses.findIndex(
        (w) => w.alias === entry.alias || w.match === entry.match
      );
      if (existsIdx >= 0) {
        target.watchedProcesses[existsIdx] = entry;
      } else {
        target.watchedProcesses.push(entry);
      }
      await saveTargets(targets);
      const updatedSession = sessions.getOrCreate(target);
      if (updatedSession.isConnected()) {
        try {
          await updatedSession.syncRemoteConfig();
          vscode.window.showInformationMessage(
            `Watching "${businessName}" → match \`${entry.match}\` (${rule.reason})`
          );
        } catch (e) {
          vscode.window.showErrorMessage(`Deploy watched process config failed: ${e}`);
        }
      } else {
        vscode.window.showInformationMessage(
          `Saved watch for "${businessName}" → \`${entry.match}\`. Connect to apply.`
        );
      }
    }),

    vscode.commands.registerCommand('embeddedHarness.removeWatchedProcess', async () => {
      const targets = getTargetsFromSettings();
      const id = await vscode.window.showQuickPick(targets.map((t) => t.id), {
        placeHolder: 'Target',
      });
      if (!id) return;
      const target = targets.find((t) => t.id === id)!;
      const list = target.watchedProcesses ?? [];
      if (list.length === 0) {
        vscode.window.showInformationMessage('No watched processes on this target.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        list.map((w) => ({
          label: `${w.label ?? w.match}`,
          description: `match: ${w.match}`,
          match: w.match,
        })),
        { placeHolder: 'Select watched process to remove' }
      );
      if (!pick) return;
      target.watchedProcesses = list.filter((w) => w.match !== pick.match);
      await saveTargets(targets);
      const session = sessions.getOrCreate(target);
      if (session.isConnected()) {
        try {
          await session.syncRemoteConfig();
        } catch (e) {
          vscode.window.showErrorMessage(`Remove failed to sync remote config: ${e}`);
          return;
        }
      }
      vscode.window.showInformationMessage(`Removed watched process "${pick.match}".`);
    }),

    vscode.commands.registerCommand('embeddedHarness.profileWatchedProcess', async () => {
      const targets = getTargetsFromSettings();
      const id = await vscode.window.showQuickPick(targets.map((t) => t.id), {
        placeHolder: 'Target',
      });
      if (!id) return;
      const session = sessions.get(id);
      if (!session?.isConnected()) {
        vscode.window.showWarningMessage('Connect target first.');
        return;
      }
      const watched = session.getLatestMetrics()?.watchedProcesses ?? [];
      if (watched.length === 0) {
        vscode.window.showWarningMessage('No watched processes in latest metrics. Add one first.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        watched.map((p) => ({
          label: `${p.label || p.match} (PID ${p.pid}, ${p.name})`,
          description: `CPU ${(p.cpuPercent ?? 0).toFixed(1)}% · ${p.memKb} KB`,
          pid: p.pid,
          name: p.label || p.match || p.name,
        })),
        { placeHolder: 'Select process to profile (15s perf + flame graph)' }
      );
      if (!pick) return;
      await runProfileForProcess(id, pick.pid, pick.name);
    }),

    vscode.commands.registerCommand('embeddedHarness.addCustomLogPath', async () => {
      const targets = getTargetsFromSettings();
      const id = await vscode.window.showQuickPick(targets.map((t) => t.id));
      if (!id) return;
      const logId = await vscode.window.showInputBox({ prompt: 'Log ID' });
      if (!logId) return;
      const logPath = await vscode.window.showInputBox({ prompt: 'Remote path' });
      if (!logPath) return;
      const label = await vscode.window.showInputBox({ prompt: 'Label' });
      const target = targets.find((t) => t.id === id)!;
      target.customLogPaths = target.customLogPaths ?? [];
      target.customLogPaths.push({ id: logId, path: logPath, label: label ?? logId });
      await saveTargets(targets);
      if (sessions.get(id)?.isConnected()) {
        await startSession(target);
      }
    }),

    vscode.commands.registerCommand('embeddedHarness.connectSerial', async () => {
      let port = cfg().get<string>('serialPort') || '';
      if (!port) {
        const input = await vscode.window.showInputBox({ prompt: 'Serial port' });
        if (!input) return;
        port = input;
        await cfg().update('serialPort', port, vscode.ConfigurationTarget.Global);
      }
      const baud = cfg().get<number>('serialBaudRate') ?? 115200;
      const targetId = targets()[0]?.id ?? 'mcu-0';

      serialReader.start(targetId, port, baud, (entry) => {
        logView.append([entry]);
        const session = sessions.get(targetId) ?? sessions.list()[0];
        if (session) {
          session.getAggregator().push([entry]);
          TimelineView.show().update(session.getAggregator().getAll());
        }
      });
      logView.show();
    })
  );

  writeMcpState();

  context.subscriptions.push({
    dispose: () => {
      void mcpHost?.stop();
    },
  });
}

function targets(): TargetConfig[] {
  return getTargetsFromSettings();
}

export function deactivate(): void {}
