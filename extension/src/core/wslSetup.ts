import * as vscode from 'vscode';
import { getTargetsFromSettings, saveTargets } from './session';
import {
  listWslDistros,
  isWslAvailable,
  findWslHarnessRemoteBinary,
} from '../transport/wslClient';
import { TargetConfig } from '../types';
import {
  resolveHarnessRemoteDir,
  harnessRemoteBinaryCandidates,
} from './repoPaths';

export { resolveHarnessRemoteDir } from './repoPaths';

export function buildHarnessRemoteInstructions(wslPath: string): string {
  return [
    '# Build harness-remote in WSL',
    '',
    '```bash',
    `cd ${wslPath}`,
    'make',
    '# Option A: install to PATH (needs sudo password)',
    'sudo cp build/harness-remote /usr/local/bin/',
    '# Option B: use build output directly (no sudo)',
    './build/harness-remote capabilities',
    '```',
    '',
    'After build, run **Add WSL Target** again — the plugin auto-detects `./build/harness-remote`.',
    '',
    'Optional daemon:',
    '```bash',
    'sudo harness-remote daemon &',
    '# or: sudo systemctl enable --now harness-remote',
    '```',
  ].join('\n');
}

export async function openWslBuildTerminal(distro: string, wslPath: string): Promise<void> {
  const term = vscode.window.createTerminal({
    name: `Build harness-remote (${distro})`,
    shellPath: 'wsl.exe',
    shellArgs: ['-d', distro],
  });
  term.show();
  term.sendText(`cd ${wslPath}`);
  term.sendText('make');
  term.sendText('./build/harness-remote capabilities');
}

async function saveWslTarget(
  id: string,
  distro: string,
  remoteBinary: string
): Promise<TargetConfig> {
  const target: TargetConfig = {
    id,
    host: 'WSL',
    port: 0,
    username: 'wsl',
    transport: 'wsl',
    wslDistro: distro,
    remoteBinary,
    customLogPaths: [],
  };

  const targets = getTargetsFromSettings();
  const existing = targets.findIndex((t) => t.id === id);
  if (existing >= 0) {
    targets[existing] = target;
  } else {
    targets.push(target);
  }
  await saveTargets(targets);
  return target;
}

export async function addWslTargetInteractive(
  extensionUri?: vscode.Uri
): Promise<TargetConfig | undefined> {
  if (!isWslAvailable()) {
    vscode.window.showWarningMessage('WSL transport is only available on Windows.');
    return undefined;
  }

  const distros = await listWslDistros();
  if (distros.length === 0) {
    vscode.window.showErrorMessage('No WSL distro found. Install WSL: wsl --install');
    return undefined;
  }

  const distro =
    distros.length === 1
      ? distros[0]
      : await vscode.window.showQuickPick(distros, {
          placeHolder: 'Select WSL distro',
        });
  if (!distro) {
    return undefined;
  }

  const defaultId = `wsl-${distro.toLowerCase().replace(/\s+/g, '-')}`;
  const id =
    (await vscode.window.showInputBox({
      prompt: 'Target ID',
      value: defaultId,
    })) ?? defaultId;

  const { wslPath } = resolveHarnessRemoteDir(extensionUri);
  const candidates = harnessRemoteBinaryCandidates(extensionUri);
  let remoteBinary = await findWslHarnessRemoteBinary(distro, candidates);

  while (!remoteBinary) {
    const build = await vscode.window.showWarningMessage(
      `harness-remote not found in WSL (${distro}). Build with \`make\` first.`,
      'Open WSL terminal',
      'Show build steps',
      'Add anyway (build path)'
    );
    if (build === 'Open WSL terminal') {
      await openWslBuildTerminal(distro, wslPath);
      const retry = await vscode.window.showInformationMessage(
        'After `make` finishes in the WSL terminal, add the target.',
        'Retry now',
        'Cancel'
      );
      if (retry !== 'Retry now') {
        return undefined;
      }
      remoteBinary = await findWslHarnessRemoteBinary(distro, candidates);
      continue;
    }
    if (build === 'Show build steps') {
      const doc = await vscode.workspace.openTextDocument({
        content: buildHarnessRemoteInstructions(wslPath),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);
      return undefined;
    }
    if (build === 'Add anyway (build path)') {
      remoteBinary = `${wslPath}/build/harness-remote`;
      break;
    }
    return undefined;
  }

  const target = await saveWslTarget(id, distro, remoteBinary);
  const binHint = remoteBinary.includes('/') ? remoteBinary : 'harness-remote (PATH)';
  vscode.window.showInformationMessage(
    `WSL target "${id}" added (${distro}, ${binHint}). Click it in Targets to Connect.`
  );
  return target;
}
