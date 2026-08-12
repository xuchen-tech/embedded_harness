import * as vscode from 'vscode';
import * as path from 'path';

function winPathToWsl(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, '/');
  const match = /^([A-Za-z]):\//.exec(normalized);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}${normalized.slice(2)}`;
  }
  return normalized;
}

/** Resolve harness-remote source dir on Windows and its WSL mount path. */
export function resolveHarnessRemoteDir(extensionUri?: vscode.Uri): {
  winPath: string;
  wslPath: string;
} {
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length) {
    const winPath = path.join(folders[0].uri.fsPath, 'harness-remote');
    return { winPath, wslPath: winPathToWsl(winPath) };
  }

  if (extensionUri) {
    const repoRoot = path.dirname(extensionUri.fsPath);
    const winPath = path.join(repoRoot, 'harness-remote');
    return { winPath, wslPath: winPathToWsl(winPath) };
  }

  return { winPath: '', wslPath: '~/embedded_harness/harness-remote' };
}

export function harnessRemoteBinaryCandidates(extensionUri?: vscode.Uri): string[] {
  const { wslPath } = resolveHarnessRemoteDir(extensionUri);
  return [
    'harness-remote',
    '/usr/local/bin/harness-remote',
    `${wslPath}/build/harness-remote`,
  ];
}
