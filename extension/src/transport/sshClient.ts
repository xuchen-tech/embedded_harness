import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { TargetConfig } from '../types';
import { RemoteTransport } from './remoteTransport';

export class SshClient implements RemoteTransport {  private client = new Client();
  private connected = false;

  async connect(target: TargetConfig): Promise<void> {
    if (this.connected) {
      await this.disconnect();
    }

    const config: ConnectConfig = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
    };

    if (target.privateKeyPath) {
      config.privateKey = fs.readFileSync(target.privateKeyPath);
    } else if (target.password) {
      config.password = target.password;
    }

    await new Promise<void>((resolve, reject) => {
      this.client
        .on('ready', () => {
          this.connected = true;
          resolve();
        })
        .on('error', reject)
        .connect(config);
    });
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.client.end();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err: Error | undefined, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream
          .on('close', (code: number) => {
            if (code !== 0 && !stdout) {
              reject(new Error(stderr || `Command failed: ${command}`));
              return;
            }
            resolve(stdout.trim());
          })
          .on('data', (data: Buffer) => {
            stdout += data.toString();
          })
          .stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
      });
    });
  }

  async writeRemoteFile(remotePath: string, content: string): Promise<void> {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    await this.exec(`mkdir -p ${dir} && echo '${b64}' | base64 -d > ${remotePath}`);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      this.client.sftp((err: Error | undefined, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        sftp.fastGet(remotePath, localPath, (dlErr: Error | undefined) => {
          if (dlErr) {
            reject(dlErr);
            return;
          }
          resolve();
        });
      });
    });
  }

  async downloadCoreViaCoredumpctl(coredumpctlLine: string, localPath: string): Promise<void> {
    /* Extract PID if present in list line */
    const pidMatch = coredumpctlLine.match(/\s(\d+)\s/);
    const pid = pidMatch?.[1];
    if (!pid) {
      throw new Error('Cannot parse PID from coredumpctl entry');
    }
    await this.exec(`coredumpctl dump ${pid} -o /tmp/harness-core-${pid} 2>/dev/null`);
    await this.downloadFile(`/tmp/harness-core-${pid}`, localPath);
  }
}
