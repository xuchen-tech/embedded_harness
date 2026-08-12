import * as vscode from 'vscode';
import { RemoteTransport } from '../transport/remoteTransport';

export interface ProcessDetail {
  pid: number;
  status: string;
  smaps: string;
  cmdline: string;
  threadCount: number;
  perfAvailable: boolean;
}

export async function fetchProcessDetail(
  transport: RemoteTransport,
  pid: number
): Promise<ProcessDetail> {
  const safePid = Math.floor(pid);
  if (safePid <= 0) {
    throw new Error('Invalid PID');
  }

  const [status, smaps, cmdline, threads, perfCheck] = await Promise.all([
    transport.exec(`cat /proc/${safePid}/status 2>/dev/null || echo '(process exited)'`),
    transport.exec(
      `cat /proc/${safePid}/smaps_rollup 2>/dev/null || cat /proc/${safePid}/status 2>/dev/null | grep -E 'Vm(RSS|HWM|Peak|Swap|Lib|Data|Stk)' || echo '(smaps not available)'`
    ),
    transport.exec(`tr '\\0' ' ' < /proc/${safePid}/cmdline 2>/dev/null; echo`),
    transport.exec(`ls -1 /proc/${safePid}/task 2>/dev/null | wc -l`),
    transport.exec('command -v perf >/dev/null && echo yes || echo no'),
  ]);

  return {
    pid: safePid,
    status: status.trim(),
    smaps: smaps.trim(),
    cmdline: cmdline.trim() || '(empty)',
    threadCount: parseInt(threads.trim(), 10) || 0,
    perfAvailable: perfCheck.trim() === 'yes',
  };
}

export function formatProcessDetailMarkdown(d: ProcessDetail): string {
  return [
    `# Process ${d.pid}`,
    '',
    '## Command line',
    '```',
    d.cmdline,
    '```',
    '',
    `## Threads: ${d.threadCount}`,
    '',
    '## Memory (/proc/status + smaps_rollup)',
    '```',
    d.smaps,
    '```',
    '',
    '## Full /proc/status',
    '```',
    d.status,
    '```',
    '',
    d.perfAvailable
      ? '**perf** is available on target. Flame graphs are not built into the panel yet — run on remote:\n```bash\nperf record -p ' +
          d.pid +
          ' -g -- sleep 10 && perf script > /tmp/perf-' +
          d.pid +
          '.txt\n```'
      : '**perf** not installed. Use **Embedded Harness: Debug Environment Wizard** to install profiling tools.',
  ].join('\n');
}

export async function showProcessDetailPanel(detail: ProcessDetail): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: formatProcessDetailMarkdown(detail),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
