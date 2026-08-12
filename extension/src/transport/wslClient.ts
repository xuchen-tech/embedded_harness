import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { TargetConfig } from '../types';
import { RemoteTransport } from './remoteTransport';

const execFileAsync = promisify(execFile);

export function isWslAvailable(): boolean {
  return process.platform === 'win32';
}

function decodeWslListOutput(stdout: Buffer): string {
  if (stdout.length >= 2 && stdout[0] === 0xff && stdout[1] === 0xfe) {
    return stdout.toString('utf16le', 2);
  }
  if (stdout.length >= 2 && stdout[1] === 0x00) {
    return stdout.toString('utf16le');
  }
  return stdout.toString('utf8');
}

export async function listWslDistros(): Promise<string[]> {
  if (!isWslAvailable()) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], {
      encoding: 'buffer',
      windowsHide: true,
    });
    return decodeWslListOutput(stdout)
      .split(/\r?\n/)
      .map((l) => l.replace(/\0/g, '').trim())
      .filter((l) => l.length > 0 && !/^Windows Subsystem/i.test(l));
  } catch {
    return [];
  }
}

function bashEscape(command: string): string {
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

export class WslClient implements RemoteTransport {
  private connected = false;
  private distro?: string;

  constructor(distro?: string) {
    this.distro = distro;
  }

  private wslBaseArgs(): string[] {
    const args: string[] = [];
    if (this.distro) {
      args.push('-d', this.distro);
    }
    return args;
  }

  private async runWsl(command: string, encoding: BufferEncoding | 'buffer' = 'utf8'): Promise<string | Buffer> {
    const args = [...this.wslBaseArgs(), '-e', 'bash', '-lc', command];
    const { stdout } = await execFileAsync('wsl.exe', args, {
      encoding: encoding === 'buffer' ? undefined : encoding,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  }

  async connect(target: TargetConfig): Promise<void> {
    this.distro = target.wslDistro || this.distro;
    const binary = target.remoteBinary ?? 'harness-remote';
    try {
      await this.runWsl(`${binary} capabilities`);
    } catch {
      throw new Error(
        `${binary} not found in WSL${this.distro ? ` (${this.distro})` : ''}. ` +
          `In WSL run: cd harness-remote && make && sudo cp build/harness-remote /usr/local/bin/`
      );
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async exec(command: string): Promise<string> {
    const out = await this.runWsl(command);
    return typeof out === 'string' ? out.trim() : out.toString().trim();
  }

  async writeRemoteFile(remotePath: string, content: string): Promise<void> {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    await this.exec(`mkdir -p ${bashEscape(dir)} && echo ${bashEscape(b64)} | base64 -d > ${bashEscape(remotePath)}`);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const args = [...this.wslBaseArgs(), '-e', 'cat', remotePath];
    const { stdout } = await execFileAsync('wsl.exe', args, {
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    fs.writeFileSync(localPath, stdout);
  }

  async downloadCoreViaCoredumpctl(coredumpctlLine: string, localPath: string): Promise<void> {
    const pidMatch = coredumpctlLine.match(/\s(\d+)\s/);
    const pid = pidMatch?.[1];
    if (!pid) {
      throw new Error('Cannot parse PID from coredumpctl entry');
    }
    const remoteTmp = `/tmp/harness-core-${pid}`;
    await this.exec(`coredumpctl dump ${pid} -o ${remoteTmp} 2>/dev/null`);
    await this.downloadFile(remoteTmp, localPath);
  }
}

export async function probeWslHarnessRemote(
  distro?: string,
  remoteBinary = 'harness-remote'
): Promise<boolean> {
  const client = new WslClient(distro);
  try {
    await client.connect({
      id: 'probe',
      host: 'wsl',
      port: 0,
      username: 'wsl',
      transport: 'wsl',
      wslDistro: distro,
      remoteBinary,
    });
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

export async function findWslHarnessRemoteBinary(
  distro: string,
  candidates: string[]
): Promise<string | undefined> {
  for (const bin of candidates) {
    if (await probeWslHarnessRemote(distro, bin)) {
      return bin;
    }
  }
  return undefined;
}
