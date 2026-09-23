import { spawn } from 'node:child_process';

export interface CliCommandSpec {
  command: string;
  args: string[];
}

export interface CliCommandResult {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  cleanupIncomplete: boolean;
  stdout: string;
  stderr: string;
}

export async function runCliMaintenanceCommand(input: {
  spec: CliCommandSpec;
  timeoutMs: number;
  platform: NodeJS.Platform;
  expandedPath: string;
  outputCapBytes: number;
  onSpawn?: (cancel: () => Promise<void>) => void;
}): Promise<CliCommandResult> {
  return new Promise<CliCommandResult>((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let cancelled = false;
    let cleanupIncomplete = false;
    let settled = false;
    const child = spawn(input.spec.command, input.spec.args, {
      env: { ...process.env, PATH: input.expandedPath },
      shell: false,
      windowsHide: true,
      detached: input.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= input.outputCapBytes) return current;
      return Buffer.concat([current, chunk.subarray(0, input.outputCapBytes - current.length)]);
    };
    child.stdout?.on('data', (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        cancelled,
        cleanupIncomplete,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    };

    const terminate = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (input.platform === 'win32' && child.pid) {
        await new Promise<void>((done) => {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore',
            windowsHide: true,
            shell: false,
          });
          killer.once('error', () => done());
          killer.once('exit', () => done());
        });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
        await new Promise((done) => setTimeout(done, 500));
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
      }
      await new Promise((done) => setTimeout(done, 100));
      cleanupIncomplete = child.exitCode === null && child.signalCode === null;
    };

    input.onSpawn?.(async () => {
      cancelled = true;
      await terminate();
      finish(child.exitCode);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void terminate().then(() => finish(child.exitCode));
    }, input.timeoutMs);
    timer.unref?.();

    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code));
  });
}
