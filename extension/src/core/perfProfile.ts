import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RemoteTransport } from '../transport/remoteTransport';
import { TargetCapabilities } from '../types';
import {
  buildInstallCommands,
  detectPackageManager,
  runDebugEnvWizard,
} from './debugEnvWizard';
import { collapsePerfScript, generateFlameSvg } from './flameGraph';

export interface PerfStatus {
  available: boolean;
  perfPath: string;
  paranoid: number;
  needsSudo: boolean;
  version: string;
}

export async function checkPerfStatus(transport: RemoteTransport): Promise<PerfStatus> {
  const script = `
perf_path=$(command -v perf 2>/dev/null || true)
if [ -z "$perf_path" ]; then echo "MISSING"; exit 0; fi
par=$(cat /proc/sys/kernel/perf_event_paranoid 2>/dev/null || echo 2)
ver=$(perf --version 2>/dev/null | head -1)
echo "OK|$perf_path|$par|$ver"
`;
  try {
    const out = (await transport.exec(script)).trim();
    if (out === 'MISSING' || !out.startsWith('OK|')) {
      return { available: false, perfPath: '', paranoid: 2, needsSudo: true, version: '' };
    }
    const [, perfPath, parStr, version] = out.split('|');
    const paranoid = parseInt(parStr, 10);
    const needsSudo = Number.isNaN(paranoid) ? true : paranoid > 1;
    return {
      available: true,
      perfPath: perfPath || 'perf',
      paranoid: Number.isNaN(paranoid) ? 2 : paranoid,
      needsSudo,
      version: version ?? '',
    };
  } catch {
    return { available: false, perfPath: '', paranoid: 2, needsSudo: true, version: '' };
  }
}

export async function ensurePerfOrGuide(
  transport: RemoteTransport,
  caps: TargetCapabilities,
  extensionPath: string
): Promise<PerfStatus | undefined> {
  let status = await checkPerfStatus(transport);
  if (status.available) {
    if (status.needsSudo) {
      const hint = await vscode.window.showInformationMessage(
        `perf is installed but kernel.perf_event_paranoid=${status.paranoid} — sampling may require sudo.`,
        'Continue with sudo',
        'Show fix command'
      );
      if (hint === 'Show fix command') {
        const doc = await vscode.workspace.openTextDocument({
          content: [
            '# Allow perf without sudo (WSL / dev machine)',
            '',
            '```bash',
            'sudo sysctl -w kernel.perf_event_paranoid=-1',
            '# persistent: echo kernel.perf_event_paranoid=-1 | sudo tee /etc/sysctl.d/99-perf.conf',
            '```',
          ].join('\n'),
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc);
      }
      if (hint === undefined) {
        return undefined;
      }
    }
    return status;
  }

  const pkgMgr = await detectPackageManager(transport);
  const installCmds = buildInstallCommands(pkgMgr, ['perf']);
  const installHint =
    installCmds.length > 0
      ? installCmds.join('\n')
      : 'sudo apt install -y linux-perf   # or: sudo dnf install perf';

  const choice = await vscode.window.showWarningMessage(
    'perf is not installed on the target. CPU flame graphs require perf.',
    'Install via Wizard',
    'Copy install command',
    'Cancel'
  );

  if (choice === 'Copy install command') {
    await vscode.env.clipboard.writeText(installHint);
    vscode.window.showInformationMessage('perf install command copied to clipboard.');
    return undefined;
  }
  if (choice === 'Install via Wizard') {
    await runDebugEnvWizard(transport, caps, extensionPath);
    status = await checkPerfStatus(transport);
    if (status.available) {
      vscode.window.showInformationMessage(`perf ready: ${status.version || status.perfPath}`);
      return status;
    }
    vscode.window.showWarningMessage('perf still not found after wizard. Reconnect and retry.');
    return undefined;
  }
  return undefined;
}

export interface ProfileResult {
  svg: string;
  scriptPath: string;
  svgPath: string;
  sampleCount: number;
}

export async function profileProcessFlameGraph(
  transport: RemoteTransport,
  pid: number,
  label: string,
  durationSec: number,
  outDir: string,
  perfStatus: PerfStatus
): Promise<ProfileResult> {
  const safePid = Math.floor(pid);
  const dataPath = `/tmp/harness-perf-${safePid}.data`;
  const scriptPath = `/tmp/harness-perf-${safePid}.script`;
  const prefix = perfStatus.needsSudo ? 'sudo ' : '';

  fs.mkdirSync(outDir, { recursive: true });

  await transport.exec(`rm -f ${dataPath} ${scriptPath}`);

  const recordCmd =
    `${prefix}perf record -p ${safePid} -g -F 99 -o ${dataPath} -- sleep ${durationSec} 2>&1; ` +
    `echo RECORD_EXIT:$?`;
  const recordOut = await transport.exec(recordCmd);
  if (recordOut.includes('RECORD_EXIT:') && !recordOut.includes('RECORD_EXIT:0')) {
    throw new Error(
      `perf record failed:\n${recordOut.slice(-500)}\n` +
        'Try: sudo sysctl -w kernel.perf_event_paranoid=-1'
    );
  }

  await transport.exec(`${prefix}perf script -i ${dataPath} > ${scriptPath} 2>/dev/null`);

  const localScript = path.join(outDir, `perf-${safePid}.script`);
  const localSvg = path.join(outDir, `flame-${safePid}.svg`);

  try {
    await transport.downloadFile(scriptPath, localScript);
  } catch {
    const inline = await transport.exec(`cat ${scriptPath} 2>/dev/null | head -c 8000000`);
    fs.writeFileSync(localScript, inline, 'utf8');
  }

  const scriptText = fs.readFileSync(localScript, 'utf8');
  const folded = collapsePerfScript(scriptText);
  const sampleCount = folded.reduce((s, f) => s + f.count, 0);
  const svg = generateFlameSvg(
    folded,
    `${label} (PID ${safePid}, ${durationSec}s, ${sampleCount} samples)`
  );
  fs.writeFileSync(localSvg, svg, 'utf8');

  await transport.exec(`rm -f ${dataPath} ${scriptPath}`);

  return { svg, scriptPath: localScript, svgPath: localSvg, sampleCount };
}
