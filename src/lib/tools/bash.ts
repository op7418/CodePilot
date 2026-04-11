/**
 * tools/bash.ts — Execute shell commands.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import fs from 'fs';
import type { ToolContext } from './index';

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT_MS = 120_000;   // 2 minutes

export function createBashTool(ctx: ToolContext) {
  return tool({
    description:
      'Execute a bash command and return its output (stdout + stderr combined). ' +
      'The command runs in the working directory. Use for system operations, ' +
      'running tests, installing packages, git commands, etc. ' +
      'Long-running commands are automatically killed after the timeout.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to execute'),
      timeout: z.number().int().positive().optional()
        .describe('Timeout in milliseconds (default 120000)'),
    }),
    execute: async ({ command, timeout }, { abortSignal }) => {
      const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
      const cwd = ctx.workingDirectory;

      // Validate working directory exists before spawning
      if (!fs.existsSync(cwd)) {
        return `Error: working directory does not exist: ${cwd}`;
      }

      return new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let truncated = false;
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        const proc = spawn('bash', ['-c', command], {
          cwd,
          env: { ...process.env, TERM: 'dumb' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs,
        });

        const collect = (data: Buffer) => {
          if (truncated) return;
          totalBytes += data.length;
          if (totalBytes > MAX_OUTPUT_BYTES) {
            truncated = true;
            chunks.push(data.subarray(0, MAX_OUTPUT_BYTES - (totalBytes - data.length)));
          } else {
            chunks.push(data);
          }
        };

        // Stream tool output to the client as it arrives
        const streamOutput = (data: Buffer) => {
          if (ctx.emitSSE) {
            try {
              ctx.emitSSE({ type: 'tool_output', data: data.toString('utf-8') });
            } catch { /* stream closed */ }
          }
        };

        proc.stdout?.on('data', (data: Buffer) => {
          collect(data);
          streamOutput(data);
        });
        proc.stderr?.on('data', (data: Buffer) => {
          collect(data);
          streamOutput(data);
        });

        // Handle abort
        const onAbort = () => {
          proc.kill('SIGTERM');
          killTimer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          }, 3000);
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        proc.on('close', (code, signal) => {
          abortSignal?.removeEventListener('abort', onAbort);
          if (killTimer) clearTimeout(killTimer);

          let output = Buffer.concat(chunks).toString('utf-8');
          if (truncated) {
            const droppedBytes = totalBytes - MAX_OUTPUT_BYTES;
            output += `\n\n[Output truncated at 1MB — ${droppedBytes} bytes dropped]`;
          }

          if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            output += `\n\n[Process killed: ${signal}]`;
          }

          if (code !== null && code !== 0) {
            output += `\n\n[Exit code: ${code}]`;
          }

          resolve(output || '(no output)');
        });

        proc.on('error', (err) => {
          if (killTimer) clearTimeout(killTimer);
          resolve(`Error executing command: ${err.message}`);
        });
      });
    },
  });
}
