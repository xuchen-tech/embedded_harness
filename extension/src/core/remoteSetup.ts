import * as vscode from 'vscode';
import { RemoteTransport } from '../transport/remoteTransport';
import { TargetCapabilities } from '../types';

export type CoreDumpSetupType = 'ulimit-pattern' | 'systemd-coredump';

const SCRIPTS: Record<CoreDumpSetupType, string[]> = {
  'ulimit-pattern': [
    'ulimit -c unlimited',
    "echo '/tmp/core.%e.%p.%t' | tee /proc/sys/kernel/core_pattern",
    'mkdir -p /tmp && chmod 1777 /tmp',
  ],
  'systemd-coredump': [
    'mkdir -p /etc/systemd/coredump.conf.d',
    'printf "[Coredump]\\nStorage=external\\nCompress=yes\\n" > /etc/systemd/coredump.conf.d/harness.conf',
    'systemctl daemon-reload 2>/dev/null || true',
  ],
};

export async function runCoreDumpWizard(
  ssh: RemoteTransport,
  caps: TargetCapabilities,
  binary: string
): Promise<boolean> {
  if (caps.coreDump?.enabled) {
    vscode.window.showInformationMessage(`Core dump already enabled on ${caps.targetId}.`);
    return true;
  }

  const recommended = caps.coreDump?.recommendedSetup ?? 'ulimit-pattern';
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'ulimit + core_pattern',
        description: 'Buildroot / BusyBox / generic embedded',
        id: 'ulimit-pattern' as CoreDumpSetupType,
      },
      {
        label: 'systemd-coredump',
        description: 'systemd-based distros',
        id: 'systemd-coredump' as CoreDumpSetupType,
      },
    ],
    {
      placeHolder: `Recommended: ${recommended}`,
    }
  );
  if (!choice) {
    return false;
  }

  const steps = SCRIPTS[choice.id];
  const preview = steps.join('\n');
  const confirm = await vscode.window.showWarningMessage(
    `Apply core dump setup on ${caps.targetId}?\n\n${preview}`,
    { modal: true },
    'Apply'
  );
  if (confirm !== 'Apply') {
    return false;
  }

  for (const cmd of steps) {
    try {
      await ssh.exec(cmd);
    } catch (e) {
      vscode.window.showErrorMessage(`Setup step failed: ${cmd}\n${e}`);
      return false;
    }
  }

  const verify = await ssh.exec(`${binary} coredump-status`);
  vscode.window.showInformationMessage(`Core dump setup done. Status: ${verify.slice(0, 200)}`);
  return true;
}
