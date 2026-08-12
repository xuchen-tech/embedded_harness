import { TargetConfig } from '../types';
import { RemoteTransport } from './remoteTransport';
import { SshClient } from './sshClient';
import { WslClient } from './wslClient';

export function createTransport(target: TargetConfig): RemoteTransport {
  if (target.transport === 'wsl') {
    return new WslClient(target.wslDistro);
  }
  return new SshClient();
}

export function isWslTarget(target: TargetConfig): boolean {
  return target.transport === 'wsl';
}

export function targetDisplayLabel(target: TargetConfig): string {
  if (target.transport === 'wsl') {
    return `WSL (${target.wslDistro ?? 'default'})`;
  }
  return target.host;
}
