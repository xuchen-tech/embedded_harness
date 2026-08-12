import * as vscode from 'vscode';
import { parseMcuLogLine } from '../parsers/logParser';
import { LogEntry } from '../types';

/**
 * Phase 1 stub: reads MCU JSON Lines from a serial port using a simple
 * polling loop via PowerShell / Python helper when native serial is unavailable.
 * Replace with `serialport` npm package for production use.
 */
export class SerialReader {
  private timer: NodeJS.Timeout | undefined;
  private onLine?: (entry: LogEntry) => void;

  start(
    targetId: string,
    port: string,
    baudRate: number,
    onLine: (entry: LogEntry) => void
  ): void {
    this.stop();
    this.onLine = onLine;

    vscode.window.showInformationMessage(
      `MCU serial stub active for ${port} @ ${baudRate}. ` +
        'Connect a line-oriented JSON source or integrate serialport in Phase 2.'
    );

    /* Demo: emit sample MCU log every 10s for UI integration testing */
    this.timer = setInterval(() => {
      const sample =
        '{"ts":' +
        Date.now() +
        ',"lvl":"INFO","mod":"demo","msg":"mcu heartbeat"}';
      const entry = parseMcuLogLine(targetId, sample);
      if (entry && this.onLine) {
        this.onLine(entry);
      }
    }, 10000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
