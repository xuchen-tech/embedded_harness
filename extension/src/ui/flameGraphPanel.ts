import * as vscode from 'vscode';

export class FlameGraphPanel {
  public static current: FlameGraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel, svg: string, title: string) {
    this.panel = panel;
    this.panel.title = title;
    this.panel.webview.html = FlameGraphPanel.buildHtml(svg, title);
    this.panel.onDidDispose(() => {
      FlameGraphPanel.current = undefined;
    });
  }

  static show(svg: string, title: string): FlameGraphPanel {
    if (FlameGraphPanel.current) {
      FlameGraphPanel.current.panel.webview.html = FlameGraphPanel.buildHtml(svg, title);
      FlameGraphPanel.current.panel.title = title;
      FlameGraphPanel.current.panel.reveal();
      return FlameGraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'embeddedHarnessFlameGraph',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    FlameGraphPanel.current = new FlameGraphPanel(panel, svg, title);
    return FlameGraphPanel.current;
  }

  private static buildHtml(svg: string, title: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { margin: 0; background: #1e1e1e; color: #ccc; font-family: sans-serif; }
    header { padding: 8px 12px; font-size: 12px; border-bottom: 1px solid #333; }
    .scroll { overflow: auto; max-height: calc(100vh - 40px); padding: 8px; }
    svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <header>${title} — hover blocks for sample counts; width ∝ CPU samples</header>
  <div class="scroll">${svg}</div>
</body>
</html>`;
  }
}
