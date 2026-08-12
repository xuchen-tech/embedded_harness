import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { CoreDumpEvent, HostToolchain } from '../types';

const execFileAsync = promisify(execFile);

export async function parseCoreDumpWithGdb(
  event: CoreDumpEvent,
  localCorePath: string,
  toolchain: HostToolchain
): Promise<string[]> {
  if (!toolchain.gdbPath || !fs.existsSync(toolchain.gdbPath)) {
    return [`GDB not configured. Set embeddedHarness.hostToolchain.gdbPath`];
  }
  if (!fs.existsSync(localCorePath)) {
    return [`Core file not found: ${localCorePath}`];
  }

  const args = ['-batch'];
  if (toolchain.sysroot) {
    args.push('-ex', `set sysroot ${toolchain.sysroot}`);
  }
  if (toolchain.elfPath && fs.existsSync(toolchain.elfPath)) {
    args.push('-ex', `file ${toolchain.elfPath}`);
  }
  args.push('-core', localCorePath, '-ex', 'bt full', '-ex', 'quit');

  try {
    const { stdout } = await execFileAsync(toolchain.gdbPath, args, {
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return [`GDB error: ${err.stderr ?? err.message ?? String(e)}`];
  }
}

export function localCoreCacheDir(globalStorage: string, targetId: string): string {
  const dir = path.join(globalStorage, 'coredumps', targetId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
