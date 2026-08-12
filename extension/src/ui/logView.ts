import * as vscode from 'vscode';
import { LogEntry } from '../types';

export class LogView {
  private output: vscode.OutputChannel;

  constructor() {
    this.output = vscode.window.createOutputChannel('Embedded Harness Logs');
  }

  show(): void {
    this.output.show(true);
  }

  append(entries: LogEntry[]): void {
    for (const e of entries) {
      const ts = new Date(e.timestamp).toISOString();
      const src = e.customLogId ? `${e.source}:${e.customLogId}` : e.source;
      this.output.appendLine(`[${ts}] [${e.level}] [${src}] ${e.message}`);
    }
  }

  clear(): void {
    this.output.clear();
  }
}
