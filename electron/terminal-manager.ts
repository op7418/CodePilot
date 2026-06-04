import * as pty from 'node-pty';

export interface TerminalCreateOptions {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

interface TerminalInstance {
  pty: pty.IPty;
  cwd: string;
}

/**
 * TerminalManager — manages real PTY terminal sessions via node-pty.
 *
 * Supports full terminal emulation: resize, full-screen programs (vim, htop),
 * proper readline editing, and true xterm-256color escape sequences.
 */
export class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();
  private onData: ((id: string, data: string) => void) | null = null;
  private onExit: ((id: string, code: number) => void) | null = null;

  setOnData(handler: (id: string, data: string) => void) {
    this.onData = handler;
  }

  setOnExit(handler: (id: string, code: number) => void) {
    this.onExit = handler;
  }

  create(id: string, opts: TerminalCreateOptions): void {
    if (this.terminals.has(id)) {
      this.kill(id);
    }

    const shell = this.getShell();
    const shellArgs = this.getShellArgs();

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...opts.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    // Allow launching Claude Code inside the terminal
    delete env.CLAUDECODE;

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: env as Record<string, string>,
    });

    ptyProcess.onData((data: string) => {
      this.onData?.(id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      this.onExit?.(id, exitCode);
    });

    this.terminals.set(id, { pty: ptyProcess, cwd: opts.cwd });
  }

  write(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.pty.resize(cols, rows);
  }

  kill(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    try {
      terminal.pty.kill();
    } catch {
      // already dead
    }
    this.terminals.delete(id);
  }

  killAll(): void {
    for (const [id] of this.terminals) {
      this.kill(id);
    }
  }

  private getShell(): string {
    if (process.platform === 'win32') {
      return this.findGitBash() || process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/zsh';
  }

  private getShellArgs(): string[] {
    if (process.platform === 'win32') {
      return [];
    }
    // Interactive login shell
    return ['-il'];
  }

  private findGitBash(): string | null {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');

    // Check env var
    const envBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (envBash && fs.existsSync(envBash)) return envBash;

    // Common paths
    const commonPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }

    // Try to find via 'where git'
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execFileSync } = require('child_process');
      const whereResult = execFileSync('where', ['git'], {
        timeout: 3000, encoding: 'utf-8', shell: true, stdio: 'pipe',
      });
      for (const line of whereResult.trim().split(/\r?\n/)) {
        const gitExe = line.trim();
        if (!gitExe) continue;
        const gitDir = path.dirname(path.dirname(gitExe));
        const bashPath = path.join(gitDir, 'bin', 'bash.exe');
        if (fs.existsSync(bashPath)) return bashPath;
      }
    } catch {
      // ignore
    }

    return null;
  }
}
