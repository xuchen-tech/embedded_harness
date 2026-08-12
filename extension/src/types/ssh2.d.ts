declare module 'ssh2' {
  import { EventEmitter } from 'events';
  import { Readable } from 'stream';

  export interface ConnectConfig {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: Buffer | string;
  }

  export interface Channel extends EventEmitter {
    stderr: Readable;
    on(event: 'close', listener: (code: number) => void): this;
    on(event: 'data', listener: (data: Buffer) => void): this;
  }

  export interface SFTPWrapper {
    fastGet(
      remotePath: string,
      localPath: string,
      callback: (err: Error | undefined) => void
    ): void;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): void;
    end(): void;
    exec(command: string, callback: (err: Error | undefined, stream: Channel) => void): void;
    sftp(callback: (err: Error | undefined, sftp: SFTPWrapper) => void): void;
  }
}
