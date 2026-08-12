import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RemoteTransport } from '../transport/remoteTransport';
import { TargetCapabilities } from '../types';

export type PackageManager = 'apt' | 'dnf' | 'opkg' | 'apk' | 'unknown';

export type DebugTool = 'gdb' | 'gdbserver' | 'perf' | 'strace';

const PACKAGE_MAP: Record<DebugTool, Partial<Record<PackageManager, string>>> = {
  gdb: { apt: 'gdb', dnf: 'gdb', opkg: 'gdb', apk: 'gdb' },
  gdbserver: { apt: 'gdbserver', dnf: 'gdb-gdbserver', opkg: 'gdbserver', apk: 'gdb' },
  perf: {
    apt: 'linux-perf',
    dnf: 'perf',
    opkg: 'perf',
    apk: 'perf',
  },
  strace: { apt: 'strace', dnf: 'strace', opkg: 'strace', apk: 'strace' },
};

const INSTALL_CMD: Record<PackageManager, (pkgs: string[]) => string> = {
  apt: (pkgs) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs.join(' ')}`,
  dnf: (pkgs) => `dnf install -y ${pkgs.join(' ')}`,
  opkg: (pkgs) => `opkg update && opkg install ${pkgs.join(' ')}`,
  apk: (pkgs) => `apk add ${pkgs.join(' ')}`,
  unknown: (pkgs) => `# unknown pkg manager — install manually: ${pkgs.join(' ')}`,
};

export async function detectPackageManager(transport: RemoteTransport): Promise<PackageManager> {
  const script = `
if command -v apt-get >/dev/null 2>&1; then echo apt;
elif command -v dnf >/dev/null 2>&1; then echo dnf;
elif command -v yum >/dev/null 2>&1; then echo dnf;
elif command -v opkg >/dev/null 2>&1; then echo opkg;
elif command -v apk >/dev/null 2>&1; then echo apk;
else echo unknown; fi`.trim();
  try {
    const out = (await transport.exec(script)).trim().split('\n').pop()?.trim() ?? 'unknown';
    if (out === 'apt' || out === 'dnf' || out === 'opkg' || out === 'apk') {
      return out;
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

export function buildInstallCommands(
  pkgMgr: PackageManager,
  tools: DebugTool[]
): string[] {
  if (pkgMgr === 'unknown') {
    return [];
  }
  const pkgs: string[] = [];
  for (const tool of tools) {
    const pkg = PACKAGE_MAP[tool][pkgMgr];
    if (pkg && !pkgs.includes(pkg)) {
      pkgs.push(pkg);
    }
  }
  if (pkgs.length === 0) {
    return [];
  }
  return [INSTALL_CMD[pkgMgr](pkgs)];
}

export async function runDebugEnvWizard(
  transport: RemoteTransport,
  caps: TargetCapabilities,
  extensionPath: string
): Promise<boolean> {
  const pkgMgr = await detectPackageManager(transport);

  const toolChoices = await vscode.window.showQuickPick(
    [
      { label: 'gdb', picked: !caps.tools.gdb?.available },
      { label: 'gdbserver', picked: true },
      { label: 'perf', picked: !caps.tools.perf?.available },
      { label: 'strace', picked: true },
    ].map((t) => ({
      label: t.label,
      description: caps.tools[t.label as keyof typeof caps.tools]?.available
        ? 'already installed'
        : 'missing',
      picked: t.picked,
    })),
    { canPickMany: true, placeHolder: 'Select debug tools to install' }
  );
  if (!toolChoices || toolChoices.length === 0) {
    return false;
  }

  const tools = toolChoices.map((c) => c.label as DebugTool);
  const method = await vscode.window.showQuickPick(
    [
      {
        label: 'Package manager',
        description: `Detected: ${pkgMgr}`,
        id: 'pkg' as const,
      },
      {
        label: 'Push offline static bundle',
        description: 'SCP prebuilt tools to /opt/harness-tools/',
        id: 'offline' as const,
      },
      {
        label: 'Copy commands only',
        description: 'Do not execute — copy to clipboard',
        id: 'copy' as const,
      },
    ],
    { placeHolder: 'Installation method' }
  );
  if (!method) {
    return false;
  }

  if (method.id === 'copy') {
    const cmds =
      pkgMgr === 'unknown'
        ? ['# Install gdb/perf via your build system (Buildroot/Yocto)']
        : buildInstallCommands(pkgMgr, tools);
    await vscode.env.clipboard.writeText(cmds.join('\n'));
    vscode.window.showInformationMessage('Install commands copied to clipboard.');
    return true;
  }

  if (method.id === 'offline') {
    return pushOfflineTools(transport, caps, extensionPath, tools);
  }

  const cmds = buildInstallCommands(pkgMgr, tools);
  if (cmds.length === 0) {
    vscode.window.showWarningMessage('No package manager detected. Try offline bundle or copy commands.');
    return false;
  }

  const preview = cmds.join('\n');
  const confirm = await vscode.window.showWarningMessage(
    `Run on ${caps.targetId}?\n\n${preview}`,
    { modal: true },
    'Apply'
  );
  if (confirm !== 'Apply') {
    return false;
  }

  for (const cmd of cmds) {
    try {
      await transport.exec(cmd);
    } catch (e) {
      vscode.window.showErrorMessage(`Install failed: ${cmd}\n${e}`);
      return false;
    }
  }

  vscode.window.showInformationMessage('Debug tools installation finished. Reconnect to refresh capabilities.');
  return true;
}

async function pushOfflineTools(
  transport: RemoteTransport,
  caps: TargetCapabilities,
  extensionPath: string,
  tools: DebugTool[]
): Promise<boolean> {
  const manifestPath = path.join(extensionPath, 'tools', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    vscode.window.showErrorMessage('Offline tools manifest not found.');
    return false;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    bundles: Array<{ arch: string; tools: string[]; tarPath: string }>;
  };

  const arch = caps.arch.normalized;
  const bundle = manifest.bundles.find((b) => b.arch === arch);
  if (!bundle) {
    vscode.window.showWarningMessage(
      `No offline bundle for arch "${arch}". Add one to extension/tools/manifest.json`
    );
    return false;
  }

  const localTar = path.join(extensionPath, 'tools', bundle.tarPath);
  if (!fs.existsSync(localTar)) {
    vscode.window.showWarningMessage(
      `Bundle file missing: ${bundle.tarPath}. Place prebuilt tarball in extension/tools/`
    );
    return false;
  }

  const remoteTar = `/tmp/harness-tools-${arch}.tar.gz`;
  const b64 = fs.readFileSync(localTar).toString('base64');
  await transport.exec(`echo '${b64}' | base64 -d > ${remoteTar}`);
  await transport.exec(
    'mkdir -p /opt/harness-tools && tar -xzf ' +
      remoteTar +
      ' -C /opt/harness-tools && rm -f ' +
      remoteTar
  );
  await transport.exec(
    'grep -q harness-tools /etc/profile.d/harness-tools.sh 2>/dev/null || ' +
      'echo export PATH=/opt/harness-tools/bin:\\$PATH > /etc/profile.d/harness-tools.sh'
  );

  vscode.window.showInformationMessage(
    `Offline tools pushed for ${tools.join(', ')} (${arch}). Add /opt/harness-tools/bin to PATH.`
  );
  return true;
}
