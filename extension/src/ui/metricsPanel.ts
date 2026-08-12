import * as vscode from 'vscode';
import { MetricsSnapshot } from '../types';

type ProcessClickHandler = (pid: number, targetId: string) => void;
type ProfileHandler = (pid: number, targetId: string, label: string) => void;

export class MetricsPanel {
  public static current: MetricsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private history: Array<{ t: number; cpu: number; memUsed: number }> = [];
  private onProcessClick?: ProcessClickHandler;
  private onProfile?: ProfileHandler;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'openProcess' && typeof msg.pid === 'number' && msg.targetId) {
        this.onProcessClick?.(msg.pid, msg.targetId);
      }
      if (msg.type === 'profileProcess' && typeof msg.pid === 'number' && msg.targetId && msg.label) {
        this.onProfile?.(msg.pid, msg.targetId, msg.label);
      }
    });
    this.panel.onDidDispose(() => {
      MetricsPanel.current = undefined;
    });
  }

  setProcessClickHandler(handler: ProcessClickHandler): void {
    this.onProcessClick = handler;
  }

  setProfileHandler(handler: ProfileHandler): void {
    this.onProfile = handler;
  }

  static show(_extensionUri: vscode.Uri): MetricsPanel {
    if (MetricsPanel.current) {
      MetricsPanel.current.panel.reveal();
      return MetricsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'embeddedHarnessMetrics',
      'Harness Metrics',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    MetricsPanel.current = new MetricsPanel(panel);
    return MetricsPanel.current;
  }

  update(metrics: MetricsSnapshot): void {
    const memUsed =
      metrics.memory.totalKb > 0
        ? ((metrics.memory.totalKb - metrics.memory.availableKb) / metrics.memory.totalKb) * 100
        : 0;
    this.history.push({
      t: metrics.timestamp,
      cpu: metrics.cpu.usagePercent,
      memUsed,
    });
    if (this.history.length > 120) {
      this.history.shift();
    }
    this.panel.webview.postMessage({
      type: 'metrics',
      payload: {
        history: this.history,
        latest: metrics,
        targetId: metrics.targetId,
      },
    });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    .stats { display: flex; gap: 24px; margin-bottom: 16px; }
    .stat { background: var(--vscode-editor-inactiveSelectionBackground); padding: 12px 16px; border-radius: 6px; }
    .stat label { display: block; font-size: 11px; opacity: 0.8; }
    .stat value { font-size: 22px; font-weight: 600; }
    canvas { width: 100%; height: 220px; background: var(--vscode-editor-background); border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover { background: var(--vscode-list-hoverBackground); }
    .hint { font-size: 11px; opacity: 0.75; margin: 4px 0 8px; }
    button.flame { cursor: pointer; font-size: 11px; padding: 2px 6px; }
  </style>
</head>
<body>
  <div class="stats">
    <div class="stat"><label>CPU</label><value id="cpu">--</value></div>
    <div class="stat"><label>Memory Used</label><value id="mem">--</value></div>
    <div class="stat"><label>Load (1m)</label><value id="load">--</value></div>
  </div>
  <canvas id="chart" width="900" height="220"></canvas>
  <h3>Watched Processes</h3>
  <p class="hint">Click row for /proc details. 🔥 = 15s perf flame graph (requires perf on target).</p>
  <table><thead><tr><th>Label</th><th>PID</th><th>Name</th><th>CPU %</th><th>Mem (KB)</th><th></th></tr></thead><tbody id="watched"></tbody></table>
  <h3>Top Processes</h3>
  <p class="hint">Click a row for /proc details.</p>
  <table><thead><tr><th>PID</th><th>Name</th><th>Mem (KB)</th></tr></thead><tbody id="procs"></tbody></table>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    let history = [];
    let currentTargetId = '';

    function draw() {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      if (history.length < 2) return;
      ctx.strokeStyle = '#4fc1ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      history.forEach((p, i) => {
        const x = (i / (history.length - 1)) * (w - 20) + 10;
        const y = h - 10 - (p.cpu / 100) * (h - 20);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.strokeStyle = '#89d185';
      ctx.beginPath();
      history.forEach((p, i) => {
        const x = (i / (history.length - 1)) * (w - 20) + 10;
        const y = h - 10 - (p.memUsed / 100) * (h - 20);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    function bindRow(tr, pid, label) {
      tr.className = 'clickable';
      tr.title = 'Click for /proc status, memory, threads';
      tr.addEventListener('click', (ev) => {
        if (ev.target && ev.target.classList && ev.target.classList.contains('flame')) return;
        vscode.postMessage({ type: 'openProcess', pid, targetId: currentTargetId });
      });
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'flame';
      btn.textContent = '🔥';
      btn.title = '15s perf flame graph';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'profileProcess', pid, targetId: currentTargetId, label: label || String(pid) });
      });
      td.appendChild(btn);
      tr.appendChild(td);
    }

    window.addEventListener('message', (e) => {
      if (e.data.type !== 'metrics') return;
      history = e.data.payload.history || [];
      currentTargetId = e.data.payload.targetId || '';
      const m = e.data.payload.latest;
      document.getElementById('cpu').textContent = m.cpu.usagePercent.toFixed(1) + '%';
      const memPct = m.memory.totalKb > 0
        ? (((m.memory.totalKb - m.memory.availableKb) / m.memory.totalKb) * 100).toFixed(1)
        : '0';
      document.getElementById('mem').textContent = memPct + '%';
      document.getElementById('load').textContent = m.cpu.load1.toFixed(2);
      const watched = document.getElementById('watched');
      watched.innerHTML = '';
      const wp = m.watchedProcesses || [];
      if (wp.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="6"><em>No watched processes — Add Watched Process (command palette)</em></td>';
        watched.appendChild(tr);
      } else {
        wp.forEach(p => {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td>' + (p.label || p.match) + '</td><td>' + p.pid + '</td><td>' + p.name +
            '</td><td>' + (p.cpuPercent ?? 0).toFixed(1) + '</td><td>' + p.memKb + '</td>';
          bindRow(tr, p.pid, p.label || p.match || p.name);
          watched.appendChild(tr);
        });
      }
      const tbody = document.getElementById('procs');
      tbody.innerHTML = '';
      (m.topProcesses || []).slice(0, 10).forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + p.pid + '</td><td>' + p.name + '</td><td>' + p.memKb + '</td>';
        tr.className = 'clickable';
        tr.title = 'Click for /proc details';
        tr.addEventListener('click', () => {
          vscode.postMessage({ type: 'openProcess', pid: p.pid, targetId: currentTargetId });
        });
        tbody.appendChild(tr);
      });
      draw();
    });
  </script>
</body>
</html>`;
  }
}
