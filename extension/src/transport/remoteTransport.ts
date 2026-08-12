import { TargetConfig } from '../types';

export interface RemoteTransport {
  connect(target: TargetConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  exec(command: string): Promise<string>;
  writeRemoteFile(remotePath: string, content: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  downloadCoreViaCoredumpctl(coredumpctlLine: string, localPath: string): Promise<void>;
}
