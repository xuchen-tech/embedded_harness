import * as vscode from 'vscode';
import { CoreDumpEvent } from '../types';

export class CoredumpView {
  private output: vscode.OutputChannel;

  constructor() {
    this.output = vscode.window.createOutputChannel('Embedded Harness Core Dumps');
  }

  show(): void {
    this.output.show(true);
  }

  showEvent(event: CoreDumpEvent, backtrace: string[]): void {
    this.output.appendLine('=== Core Dump Event ===');
    this.output.appendLine(`Target:   ${event.targetId}`);
    this.output.appendLine(`Source:   ${event.source}`);
    this.output.appendLine(`Time:     ${new Date(event.detectedAt).toISOString()}`);
    if (event.remotePath) {
      this.output.appendLine(`Remote:   ${event.remotePath}`);
    }
    if (event.localPath) {
      this.output.appendLine(`Local:    ${event.localPath}`);
    }
    if (event.pid) {
      this.output.appendLine(`PID:      ${event.pid}`);
    }
    if (event.signal) {
      this.output.appendLine(`Signal:   ${event.signal}`);
    }
    this.output.appendLine('--- Backtrace ---');
    for (const line of backtrace) {
      this.output.appendLine(line);
    }
    this.output.appendLine('');
  }
}
