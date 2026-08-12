import { CustomLogPath, TargetConfig, WatchedProcess } from '../types';

export function buildRemoteConfigContent(
  logPaths: CustomLogPath[],
  watchedProcesses: WatchedProcess[] = []
): string {
  const lines: string[] = [];
  for (const p of logPaths) {
    lines.push(`log|${p.id}|${p.path}|${p.label ?? p.id}`);
  }
  for (const w of watchedProcesses) {
    lines.push(`proc|${w.match}|${w.alias ?? w.label ?? w.match}`);
  }
  return lines.join('\n');
}

export async function deployRemoteConfig(
  execFn: (cmd: string) => Promise<string>,
  logPaths: CustomLogPath[],
  watchedProcesses: WatchedProcess[] = []
): Promise<void> {
  const content = buildRemoteConfigContent(logPaths, watchedProcesses);
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  await execFn(
    "mkdir -p ~/.config/harness-remote /etc/harness-remote 2>/dev/null; " +
      "echo '" +
      b64 +
      "' | base64 -d > ~/.config/harness-remote/config.json && " +
      "(cp ~/.config/harness-remote/config.json /etc/harness-remote/config.json 2>/dev/null || true)"
  );
}

/** @deprecated use deployRemoteConfig */
export async function deployCustomLogConfig(
  execFn: (cmd: string) => Promise<string>,
  paths: CustomLogPath[]
): Promise<void> {
  await deployRemoteConfig(execFn, paths, []);
}

export function getTargetFromConfig(
  targets: TargetConfig[],
  id: string
): TargetConfig | undefined {
  return targets.find((t) => t.id === id);
}
