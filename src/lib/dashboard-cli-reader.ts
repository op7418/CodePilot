/**
 * CLI data source reader for dashboard widgets.
 * Executes a shell command and returns its output for widget refresh.
 */

import { execSync } from 'child_process';

const CLI_TIMEOUT = 10_000; // 10s
const CLI_MAX_OUTPUT = 50 * 1024; // 50KB

/**
 * Execute a CLI command and return its output.
 * Used by the dashboard refresh API route for `type: 'cli'` data sources.
 */
export function executeCLISource(command: string, workDir: string): { content: string; exitCode: number } {
  try {
    const output = execSync(command, {
      cwd: workDir,
      timeout: CLI_TIMEOUT,
      maxBuffer: CLI_MAX_OUTPUT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { content: output, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number; message?: string };
    const output = (err.stdout || '') + (err.stderr ? `\nSTDERR: ${err.stderr}` : '');
    return {
      content: output || `Command failed: ${err.message || String(e)}`,
      exitCode: err.status ?? 1,
    };
  }
}
