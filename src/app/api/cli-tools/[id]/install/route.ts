import { NextResponse } from 'next/server';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { CLI_TOOLS_CATALOG } from '@/lib/cli-tools-catalog';
import { invalidateDetectCache } from '@/lib/cli-tools-detect';
import { createCustomCliTool } from '@/lib/db';
import { getExpandedPath } from '@/lib/platform';
import path from 'path';

const execFileAsync = promisify(execFile);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tool = CLI_TOOLS_CATALOG.find(t => t.id === id);
  if (!tool) {
    return NextResponse.json({ error: 'Tool not found' }, { status: 404 });
  }

  try {
    const body = await request.json();
    const { method } = body as { method: string };

    // Security: only execute commands declared in the catalog
    const installMethod = tool.installMethods.find(m => m.method === method);
    if (!installMethod) {
      return NextResponse.json(
        { error: `Install method "${method}" not available for ${tool.name}` },
        { status: 400 }
      );
    }

    // Platform check: reject if this method doesn't support the current platform
    const currentPlatform = process.platform as 'darwin' | 'linux' | 'win32';
    if (!installMethod.platforms.includes(currentPlatform)) {
      return NextResponse.json(
        { error: `Install method "${method}" is not supported on ${currentPlatform}` },
        { status: 400 }
      );
    }

    // Parse the command into executable and args
    const parts = installMethod.command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const child = spawn(cmd, args, {
      env: { ...process.env, PATH: getExpandedPath() },
      shell: true,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = (event: string, data: string) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          send('output', chunk.toString());
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          send('output', chunk.toString());
        });

        child.on('close', async (code) => {
          invalidateDetectCache();
          if (code === 0) {
            // Persist install metadata so MCP update can use the correct method/package
            try {
              const expandedPath = getExpandedPath();
              const env = { ...process.env, PATH: expandedPath };
              // Extract package spec from the install command
              const cmdParts = installMethod.command.split(/\s+/);
              const instIdx = cmdParts.findIndex((p: string) => p === 'install');
              let packageSpec: string | undefined;
              if (instIdx >= 0) {
                for (let j = instIdx + 1; j < cmdParts.length; j++) {
                  if (!cmdParts[j].startsWith('-')) { packageSpec = cmdParts[j]; break; }
                }
              }
              // Find the binary path
              for (const bin of tool.binNames) {
                try {
                  const { stdout: whichOut } = await execFileAsync('/usr/bin/which', [bin], { timeout: 5000, env });
                  const binPath = whichOut.trim().split(/\r?\n/)[0]?.trim();
                  if (binPath) {
                    let version: string | null = null;
                    try {
                      const { stdout: vOut, stderr: vErr } = await execFileAsync(binPath, ['--version'], { timeout: 5000, env });
                      const match = (vOut || vErr).trim().split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
                      version = match ? match[1] : null;
                    } catch { /* optional */ }
                    createCustomCliTool({
                      name: tool.name,
                      binPath,
                      binName: path.basename(binPath),
                      version,
                      installMethod: method,
                      installPackage: packageSpec,
                    });
                    break;
                  }
                } catch { /* bin not found, try next */ }
              }
            } catch { /* metadata persistence is best-effort */ }
            send('done', 'Install completed successfully');
          } else {
            send('error', `Process exited with code ${code}`);
          }
          controller.close();
        });

        child.on('error', (err) => {
          send('error', err.message);
          controller.close();
        });
      },
      cancel() {
        child.kill();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error(`[cli-tools/${id}/install] Error:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Install failed' },
      { status: 500 }
    );
  }
}
