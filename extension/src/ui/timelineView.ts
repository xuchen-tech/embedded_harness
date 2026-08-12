import * as vscode from 'vscode';
import { LogEntry } from '../types';

export class TimelineView {
  public static current: TimelineView | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      TimelineView.current = undefined;
    });
  }

  static show(): TimelineView {
    if (TimelineView.current) {
      TimelineView.current.panel.reveal();
      return TimelineView.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'embeddedHarnessTimeline',
      'Harness Log Timeline',
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );
    TimelineView.current = new TimelineView(panel);
    return TimelineView.current;
  }

  update(entries: LogEntry[]): void {
    this.panel.webview.postMessage({ type: 'timeline', payload: entries.slice(-500) });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; }
  .toolbar { padding: 8px; background: var(--vscode-editor-background); position: sticky; top: 0; }
  input { width: 200px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
  .row { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: pre-wrap; }
  .ERROR { color: #f48771; }
  .WARN { color: #cca700; }
  .INFO { color: var(--vscode-foreground); }
  .src { opacity: 0.65; font-size: 10px; }
</style></head><body>
<div class="toolbar">
  <input id="filter" placeholder="Filter keyword..." />
  <select id="source"><option value="">All sources</option></select>
</div>
<div id="list"></div>
<script>
  let all = [];
  const list = document.getElementById('list');
  const filter = document.getElementById('filter');
  const source = document.getElementById('source');

  function render() {
    const kw = filter.value.toLowerCase();
    const src = source.value;
    list.innerHTML = '';
    all.filter(e => (!src || e.source === src) && (!kw || e.message.toLowerCase().includes(kw)))
      .forEach(e => {
        const div = document.createElement('div');
        div.className = 'row ' + e.level;
        const ts = new Date(e.timestamp).toISOString();
        div.innerHTML = '<span class="src">[' + ts + '][' + e.source + ']</span> ' + e.message;
        list.appendChild(div);
      });
    list.scrollTop = list.scrollHeight;
  }

  filter.oninput = render;
  source.onchange = render;

  window.addEventListener('message', e => {
    if (e.data.type !== 'timeline') return;
    all = e.data.payload || [];
    const sources = [...new Set(all.map(x => x.source))];
    source.innerHTML = '<option value="">All sources</option>' +
      sources.map(s => '<option value="'+s+'">'+s+'</option>').join('');
    render();
  });
</script></body></html>`;
  }
}
