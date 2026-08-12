import * as vscode from 'vscode';
import { MetricsSnapshot } from '../types';

export class MetricsPanel {
  public static current: MetricsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private history: Array<{ t: number; cpu: number; memUsed: number }> = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      MetricsPanel.current = undefined;
    });
  }

  static show(extensionUri: vscode.Uri): MetricsPanel {
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
    MetricsPanel.current = new MetricsPanel(panel, extensionUri);
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
  <table><thead><tr><th>Label</th><th>PID</th><th>Name</th><th>CPU %</th><th>Mem (KB)</th></tr></thead><tbody id="watched"></tbody></table>
  <h3>Top Processes</h3>
  <table><thead><tr><th>PID</th><th>Name</th><th>Mem (KB)</th></tr></thead><tbody id="procs"></tbody></table>
  <script>
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    let history = [];

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

    window.addEventListener('message', (e) => {
      if (e.data.type !== 'metrics') return;
      history = e.data.payload.history || [];
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
        tr.innerHTML = '<td colspan="5"><em>No watched processes — add via command palette: Add Watched Process</em></td>';
        watched.appendChild(tr);
      } else {
        wp.forEach(p => {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td>' + (p.label || p.match) + '</td><td>' + p.pid + '</td><td>' + p.name +
            '</td><td>' + (p.cpuPercent ?? 0).toFixed(1) + '</td><td>' + p.memKb + '</td>';
          watched.appendChild(tr);
        });
      }
      const tbody = document.getElementById('procs');
      tbody.innerHTML = '';
      (m.topProcesses || []).slice(0, 10).forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + p.pid + '</td><td>' + p.name + '</td><td>' + p.memKb + '</td>';
        tbody.appendChild(tr);
      });
      draw();
    });
  </script>
</body>
</html>`;
  }
}
