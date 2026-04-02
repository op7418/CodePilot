/**
 * codepilot-cli-tools MCP — in-process MCP server for CLI tool management.
 *
 * Provides 6 tools:
 * - codepilot_cli_tools_list: List all CLI tools (text or JSON format)
 * - codepilot_cli_tools_install: Execute install command + register + detect
 * - codepilot_cli_tools_add: Register an already-installed tool by path
 * - codepilot_cli_tools_remove: Remove a custom tool
 * - codepilot_cli_tools_check_updates: Check for available updates
 * - codepilot_cli_tools_update: Update a tool to latest version
 *
 * Keyword-gated: registered when conversation involves CLI tool management.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import path from 'path';
import {
  getAllCustomCliTools,
  createCustomCliTool,
  deleteCustomCliTool,
  getCustomCliTool,
  upsertCliToolDescription,
  getAllCliToolDescriptions,
} from '@/lib/db';
import { detectAllCliTools, invalidateDetectCache } from '@/lib/cli-tools-detect';
import { CLI_TOOLS_CATALOG, EXTRA_WELL_KNOWN_BINS } from '@/lib/cli-tools-catalog';
import { getExpandedPath } from '@/lib/platform';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract package manager name from an install command. */
function extractInstallMethod(command: string): string {
  const cmd = command.trim().toLowerCase();
  if (cmd.startsWith('brew ')) return 'brew';
  if (cmd.startsWith('npm ')) return 'npm';
  if (cmd.startsWith('pipx ')) return 'pipx';
  if (cmd.startsWith('pip ') || cmd.startsWith('pip3 ')) return 'pip';
  if (cmd.startsWith('cargo ')) return 'cargo';
  if (cmd.startsWith('apt ') || cmd.startsWith('apt-get ')) return 'apt';
  return 'unknown';
}

/**
 * Extract the full package spec from an install command.
 * e.g. "brew install stripe/stripe-cli/stripe" → "stripe/stripe-cli/stripe"
 *      "npm install -g @elevenlabs/cli" → "@elevenlabs/cli"
 *      "pip install yt-dlp" → "yt-dlp"
 */
function extractPackageSpec(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  const installIdx = parts.findIndex(p => p === 'install');
  if (installIdx < 0) return null;
  // Find the first non-flag argument after "install"
  for (let i = installIdx + 1; i < parts.length; i++) {
    if (!parts[i].startsWith('-')) {
      return parts[i].replace(/@\d+.*$/, ''); // strip version pinning like @latest
    }
  }
  return null;
}

/** Build the update command for a given install method and package name. */
function buildUpdateCommand(method: string, packageName: string): string | null {
  switch (method) {
    case 'brew': return `brew upgrade ${packageName}`;
    case 'npm': return `npm update -g ${packageName}`;
    case 'pipx': return `pipx upgrade ${packageName}`;
    case 'pip': return `pip install --upgrade ${packageName}`;
    case 'cargo': return `cargo install ${packageName}`;
    case 'apt': return `sudo apt-get install --only-upgrade ${packageName}`;
    default: return null;
  }
}

/** Run --help on a binary and return truncated output for context. */
async function getHelpOutput(binPath: string): Promise<string> {
  const env = { ...process.env, PATH: getExpandedPath() };
  // Try --help first, fall back to -h
  for (const flag of ['--help', '-h']) {
    try {
      const { stdout, stderr } = await execFileAsync(binPath, [flag], {
        timeout: 5000,
        env,
      });
      const output = (stdout || stderr).trim();
      if (output.length > 50) return output.slice(0, 2000); // truncate to keep context manageable
    } catch { /* try next flag */ }
  }
  return '';
}

// ── System prompt hint ───────────────────────────────────────────────

export const CLI_TOOLS_MCP_SYSTEM_PROMPT = `<cli-tools-capability>
You have CLI tool management capabilities via MCP tools:
- codepilot_cli_tools_list: Query installed tools (supports format="json" for structured output)
- codepilot_cli_tools_install: Install new tools via shell command
- codepilot_cli_tools_add: Register an already-installed tool and save its description
- codepilot_cli_tools_remove: Remove a custom tool
- codepilot_cli_tools_check_updates: Check which tools have available updates
- codepilot_cli_tools_update: Update a tool to its latest version
After installing or registering a tool, the --help output is automatically included in the result. Use it to generate an accurate bilingual description (zh/en) and assess agent compatibility (agentFriendly, supportsJson, supportsSchema, supportsDryRun, contextFriendly) from the help output. Then call codepilot_cli_tools_add with all fields to save them. If the tool requires authentication, guide the user through the setup steps.
When listing tools with format="json", each tool includes: agentFriendly (designed for AI agents), supportsJson (structured JSON output), supportsSchema (runtime API schema introspection), supportsDryRun (preview before mutating), contextFriendly (field masks/pagination to save context window), and healthCheckCommand (verify auth/health). Prefer agent-friendly tools; use --dry-run before destructive actions; use field masks to limit response size; use healthCheckCommand after install.
</cli-tools-capability>`;

// ── MCP server factory ───────────────────────────────────────────────

export function createCliToolsMcpServer() {
  return createSdkMcpServer({
    name: 'codepilot-cli-tools',
    version: '1.0.0',
    tools: [
      // ── LIST ─────────────────────────────────────────────────────
      tool(
        'codepilot_cli_tools_list',
        'List all CLI tools available on this system. Returns catalog tools (curated), extra system-detected tools, and custom user-added tools. Use format="json" for structured machine-readable output.',
        {
          format: z.enum(['text', 'json']).optional().describe('Output format: "text" (default, human-readable) or "json" (structured, machine-readable)'),
        },
        async ({ format }) => {
          try {
            const { catalog, extra } = await detectAllCliTools();
            const allCustom = getAllCustomCliTools();
            const descriptions = getAllCliToolDescriptions();
            // Build a lookup from binPath → shadow custom row (for install metadata)
            const catalogBinPaths = new Set(catalog.filter(c => c.binPath).map(c => c.binPath!));
            const shadowByBinPath = new Map(
              allCustom.filter(ct => catalogBinPaths.has(ct.binPath)).map(ct => [ct.binPath, ct])
            );
            // Only expose non-shadow custom rows in the custom list
            const customTools = allCustom.filter(ct => !catalogBinPaths.has(ct.binPath));

            if (format === 'json') {
              const result = {
                catalog: catalog.map(rt => {
                  const def = CLI_TOOLS_CATALOG.find(c => c.id === rt.id);
                  // Merge actual install metadata from shadow row if it exists
                  const shadow = rt.binPath ? shadowByBinPath.get(rt.binPath) : undefined;
                  return {
                    id: rt.id,
                    name: def?.name ?? rt.id,
                    status: rt.status,
                    version: rt.version,
                    binPath: rt.binPath,
                    description: descriptions[rt.id]?.en ?? def?.summaryEn ?? null,
                    installMethod: shadow?.installMethod ?? def?.installMethods[0]?.method ?? null,
                    installPackage: shadow?.installPackage || null,
                    needsAuth: def?.setupType === 'needs_auth',
                    agentFriendly: def?.agentFriendly || false,
                    supportsJson: def?.supportsJson || false,
                    supportsSchema: def?.supportsSchema || false,
                    supportsDryRun: def?.supportsDryRun || false,
                    contextFriendly: def?.contextFriendly || false,
                    healthCheckCommand: def?.healthCheckCommand || null,
                  };
                }),
                extra: extra.map(rt => {
                  const entry = EXTRA_WELL_KNOWN_BINS.find(([eid]) => eid === rt.id);
                  const desc = descriptions[rt.id];
                  const compat = (desc?.structured as Record<string, unknown>)?.agentCompat as Record<string, boolean> | undefined;
                  return {
                    id: rt.id,
                    name: entry?.[1] ?? rt.id,
                    status: rt.status,
                    version: rt.version,
                    binPath: rt.binPath,
                    description: desc?.en ?? null,
                    agentFriendly: compat?.agentFriendly || false,
                    supportsJson: compat?.supportsJson || false,
                    supportsSchema: compat?.supportsSchema || false,
                    supportsDryRun: compat?.supportsDryRun || false,
                    contextFriendly: compat?.contextFriendly || false,
                    healthCheckCommand: null,
                  };
                }),
                custom: customTools.map(ct => {
                  const desc = descriptions[ct.id];
                  const compat = (desc?.structured as Record<string, unknown>)?.agentCompat as Record<string, boolean> | undefined;
                  return {
                    id: ct.id,
                    name: ct.name,
                    status: 'installed',
                    version: ct.version,
                    binPath: ct.binPath,
                    installMethod: ct.installMethod,
                    description: desc?.en ?? null,
                    agentFriendly: compat?.agentFriendly || false,
                    supportsJson: compat?.supportsJson || false,
                    supportsSchema: compat?.supportsSchema || false,
                    supportsDryRun: compat?.supportsDryRun || false,
                    contextFriendly: compat?.contextFriendly || false,
                    healthCheckCommand: null,
                  };
                }),
              };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              };
            }

            // Text format (default)
            const lines: string[] = [];

            lines.push('## Catalog Tools (Curated)');
            for (const rt of catalog) {
              const def = CLI_TOOLS_CATALOG.find(c => c.id === rt.id);
              if (!def) continue;
              const status = rt.status === 'installed' ? '✓' : '✗';
              const ver = rt.version ? ` v${rt.version}` : '';
              const desc = descriptions[rt.id]?.en ?? def.summaryEn;
              lines.push(`${status} ${def.name}${ver}: ${desc}`);
            }

            if (extra.length > 0) {
              lines.push('');
              lines.push('## System Detected Tools');
              for (const rt of extra) {
                const entry = EXTRA_WELL_KNOWN_BINS.find(([eid]) => eid === rt.id);
                const name = entry?.[1] ?? rt.id;
                const ver = rt.version ? ` v${rt.version}` : '';
                const desc = descriptions[rt.id] ? `: ${descriptions[rt.id].en}` : '';
                lines.push(`✓ ${name}${ver}${desc}`);
              }
            }

            if (customTools.length > 0) {
              lines.push('');
              lines.push('## Custom Tools (User Added)');
              for (const ct of customTools) {
                const ver = ct.version ? ` v${ct.version}` : '';
                const desc = descriptions[ct.id]
                  ? `: ${descriptions[ct.id].en}`
                  : ` (${ct.binPath})`;
                lines.push(`✓ ${ct.name}${ver}${desc}`);
              }
            }

            return {
              content: [{ type: 'text' as const, text: lines.join('\n') }],
            };
          } catch (error) {
            return {
              content: [{
                type: 'text' as const,
                text: `Failed to list CLI tools: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        },
      ),

      // ── INSTALL ──────────────────────────────────────────────────
      tool(
        'codepilot_cli_tools_install',
        'Install a CLI tool by executing a shell command (e.g. "brew install ffmpeg", "pip install yt-dlp"). After the command succeeds, the tool is automatically detected and registered. This tool requires user permission before execution. After calling this tool, generate a bilingual description and call codepilot_cli_tools_add to save it.',
        {
          command: z.string().describe('The install command to execute, e.g. "brew install ffmpeg"'),
          name: z.string().optional().describe('Display name for the tool. If omitted, extracted from the command.'),
        },
        async ({ command, name }) => {
          try {
            const expandedPath = getExpandedPath();
            const installMethod = extractInstallMethod(command);
            const installPackage = extractPackageSpec(command);

            const { stdout, stderr } = await execAsync(command, {
              timeout: 300_000,
              env: { ...process.env, PATH: expandedPath },
            });

            const output = (stdout + '\n' + stderr).trim();

            // Build a list of binary name candidates to try with `which`.
            // Package spec ≠ binary name, so we try multiple candidates:
            //   "brew install ffmpeg" → ["ffmpeg"]
            //   "npm install -g @elevenlabs/cli" → catalog binNames ["elevenlabs"], then ["cli"]
            //   "brew install stripe/stripe-cli/stripe" → ["stripe"]
            //   "npm install -g @music163/ncm-cli" → catalog binNames ["ncm-cli"]
            const cmdParts = command.trim().split(/\s+/);
            const binCandidates: string[] = [];
            let rawPkgArg: string | null = null;
            const installIdx = cmdParts.findIndex(p => p === 'install');
            if (installIdx >= 0) {
              for (let i = installIdx + 1; i < cmdParts.length; i++) {
                if (!cmdParts[i].startsWith('-')) {
                  rawPkgArg = cmdParts[i].replace(/@[\d.]*$/, ''); // strip version pinning
                  break;
                }
              }
            }

            // Priority 1: check if a catalog tool matches this package — use its declared binNames
            if (rawPkgArg) {
              const matchingCatalog = CLI_TOOLS_CATALOG.find(c =>
                c.installMethods.some(m => m.command.includes(rawPkgArg!))
              );
              if (matchingCatalog) {
                binCandidates.push(...matchingCatalog.binNames);
              }
            }

            // Priority 2: derive candidates from the package arg itself
            if (rawPkgArg) {
              const segments = rawPkgArg.split('/');
              // Last segment (e.g. "stripe" from "stripe/stripe-cli/stripe", "ncm-cli" from "@music163/ncm-cli")
              const last = segments[segments.length - 1];
              if (last && !binCandidates.includes(last)) binCandidates.push(last);
              // For scoped packages like @scope/name, also try "name" without scope
              if (segments.length >= 2 && segments[0].startsWith('@')) {
                const scopeless = segments[1];
                if (scopeless && !binCandidates.includes(scopeless)) binCandidates.push(scopeless);
              }
            }

            if (binCandidates.length === 0) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Command executed successfully but could not determine the binary name.\nOutput:\n${output.slice(0, 1000)}\n\nPlease use codepilot_cli_tools_add with the binary path to register it manually.`,
                }],
              };
            }

            invalidateDetectCache();

            // Try each candidate with `which` until one resolves
            let binPath: string | null = null;
            let binName: string | null = null;
            let version: string | null = null;
            for (const candidate of binCandidates) {
              try {
                const { stdout: whichOut } = await execFileAsync('/usr/bin/which', [candidate], {
                  timeout: 5000,
                  env: { ...process.env, PATH: expandedPath },
                });
                const resolved = whichOut.trim().split(/\r?\n/)[0]?.trim();
                if (resolved) {
                  binPath = resolved;
                  binName = candidate;
                  break;
                }
              } catch { /* try next candidate */ }
            }

            if (binPath) {
              try {
                const { stdout: vOut, stderr: vErr } = await execFileAsync(binPath, ['--version'], {
                  timeout: 5000,
                  env: { ...process.env, PATH: expandedPath },
                });
                const vText = (vOut || vErr).trim();
                const match = vText.split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
                version = match ? match[1] : null;
              } catch { /* optional */ }

              const toolName = name || binName || path.basename(binPath);
              const registeredTool = createCustomCliTool({
                name: toolName,
                binPath,
                binName: binName || path.basename(binPath),
                version,
                installMethod,
                installPackage: installPackage || undefined,
              });

              const verStr = version ? ` v${version}` : '';
              const resultLines = [
                `Successfully installed and registered "${toolName}"${verStr}.`,
                `Path: ${binPath}`,
                `Tool ID: ${registeredTool.id}`,
                `Install method: ${installMethod}`,
              ];

              // Check if this is a catalog tool that needs auth setup
              const catalogDef = CLI_TOOLS_CATALOG.find(
                c => c.binNames.includes(binName!) || c.id === binName
              );
              if (catalogDef?.setupType === 'needs_auth') {
                resultLines.push('');
                resultLines.push('⚠ This tool requires authentication before use:');
                const steps = catalogDef.guideSteps.en;
                // Skip the install step (usually first), show remaining setup steps
                for (let i = 1; i < steps.length; i++) {
                  resultLines.push(`  ${i}. ${steps[i]}`);
                }
                resultLines.push('');
                resultLines.push('Please guide the user through the authentication steps above.');
              }

              // Capture --help output so the model can generate an accurate description
              const helpOutput = await getHelpOutput(binPath);
              if (helpOutput) {
                resultLines.push('');
                resultLines.push('--- Tool Help Output ---');
                resultLines.push(helpOutput);
                resultLines.push('--- End Help Output ---');
              }

              resultLines.push('');
              resultLines.push('Now please generate a bilingual description (zh/en) based on the help output above and call codepilot_cli_tools_add to save it.');

              return {
                content: [{ type: 'text' as const, text: resultLines.join('\n') }],
              };
            } else {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Command executed but could not locate "${binName}" in PATH after installation.\nOutput:\n${output.slice(0, 1000)}\n\nThe tool may have been installed with a different binary name. Use "which" to find it, then call codepilot_cli_tools_add to register manually.`,
                }],
              };
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Command execution failed';
            return {
              content: [{ type: 'text' as const, text: `Installation failed: ${msg}` }],
              isError: true,
            };
          }
        },
      ),

      // ── ADD ──────────────────────────────────────────────────────
      tool(
        'codepilot_cli_tools_add',
        'Register an already-installed CLI tool by its binary path, and optionally save its bilingual description and agent compatibility assessment. Use this after codepilot_cli_tools_install to save the generated description, or to register a tool the user has already installed. When providing descriptions, also assess the agent compatibility dimensions based on the --help output.',
        {
          binPath: z.string().optional().describe('Absolute path to the binary, e.g. /usr/local/bin/ffmpeg. Required when registering a new tool.'),
          name: z.string().optional().describe('Display name for the tool'),
          descriptionZh: z.string().optional().describe('Chinese description (2-3 sentences)'),
          descriptionEn: z.string().optional().describe('English description (2-3 sentences)'),
          toolId: z.string().optional().describe('If updating description for an existing tool, pass its tool ID instead of binPath'),
          agentFriendly: z.boolean().optional().describe('Tool designed for AI agents (non-interactive flags, structured output, skills)'),
          supportsJson: z.boolean().optional().describe('Tool produces or processes structured JSON data'),
          supportsSchema: z.boolean().optional().describe('Tool supports runtime schema introspection (e.g. schema command)'),
          supportsDryRun: z.boolean().optional().describe('Tool supports --dry-run for previewing destructive actions'),
          contextFriendly: z.boolean().optional().describe('Tool supports field masks or pagination to reduce output size'),
        },
        async ({ binPath, name, descriptionZh, descriptionEn, toolId, agentFriendly: af, supportsJson: sj, supportsSchema: ss, supportsDryRun: sdr, contextFriendly: cf }) => {
          try {
            // Build agent compat object if any dimension is provided
            const agentCompat = (af || sj || ss || sdr || cf) ? { agentFriendly: af, supportsJson: sj, supportsSchema: ss, supportsDryRun: sdr, contextFriendly: cf } : undefined;

            // If toolId is provided, treat as a description update for an existing tool.
            if (toolId && descriptionZh && descriptionEn) {
              const structuredJson = agentCompat ? JSON.stringify({ agentCompat }) : undefined;
              upsertCliToolDescription(toolId, descriptionZh, descriptionEn, structuredJson);
              return {
                content: [{
                  type: 'text' as const,
                  text: `Description${agentCompat ? ' and agent compatibility assessment' : ''} saved for tool "${toolId}".`,
                }],
              };
            }

            if (!binPath) {
              return {
                content: [{ type: 'text' as const, text: 'binPath is required when registering a new tool. To update a description only, pass toolId with descriptionZh and descriptionEn.' }],
                isError: true,
              };
            }

            if (!path.isAbsolute(binPath)) {
              return {
                content: [{ type: 'text' as const, text: 'binPath must be an absolute path.' }],
                isError: true,
              };
            }

            try {
              await access(binPath, constants.X_OK);
            } catch {
              return {
                content: [{ type: 'text' as const, text: `File not found or not executable: ${binPath}` }],
                isError: true,
              };
            }

            let version: string | null = null;
            try {
              const { stdout, stderr } = await execFileAsync(binPath, ['--version'], { timeout: 5000 });
              const vText = (stdout || stderr).trim();
              const match = vText.split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
              version = match ? match[1] : null;
            } catch { /* optional */ }

            const binName = path.basename(binPath);
            const toolName = name || binName;

            const created = createCustomCliTool({
              name: toolName,
              binPath,
              binName,
              version,
            });

            if (descriptionZh && descriptionEn) {
              const structuredJson = agentCompat ? JSON.stringify({ agentCompat }) : undefined;
              upsertCliToolDescription(created.id, descriptionZh, descriptionEn, structuredJson);
            }

            const verStr = version ? ` v${version}` : '';
            const resultParts = [
              `Registered "${toolName}"${verStr}.`,
              `Path: ${binPath}`,
              `Tool ID: ${created.id}`,
            ];
            if (descriptionZh) {
              resultParts.push('Description saved.');
            } else {
              // No description provided — include help output so model can generate one
              const helpOutput = await getHelpOutput(binPath);
              if (helpOutput) {
                resultParts.push('');
                resultParts.push('--- Tool Help Output ---');
                resultParts.push(helpOutput);
                resultParts.push('--- End Help Output ---');
                resultParts.push('');
                resultParts.push('Please generate a bilingual description (zh/en) based on the help output above and call codepilot_cli_tools_add with toolId to save it.');
              }
            }
            return {
              content: [{
                type: 'text' as const,
                text: resultParts.join('\n'),
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: 'text' as const,
                text: `Failed to add tool: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        },
      ),

      // ── REMOVE ───────────────────────────────────────────────────
      tool(
        'codepilot_cli_tools_remove',
        'Remove a custom (user-added) CLI tool from the library. Only custom tools can be removed — catalog and system-detected tools cannot be removed.',
        {
          toolId: z.string().describe('The tool ID to remove, e.g. "custom-mytool"'),
        },
        async ({ toolId }) => {
          try {
            const existing = getCustomCliTool(toolId);
            if (!existing) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Tool "${toolId}" not found. Only custom tools (ID starting with "custom-") can be removed.`,
                }],
                isError: true,
              };
            }

            deleteCustomCliTool(toolId);
            return {
              content: [{
                type: 'text' as const,
                text: `Removed "${existing.name}" (${toolId}) from the tool library.`,
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: 'text' as const,
                text: `Failed to remove tool: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        },
      ),

      // ── CHECK UPDATES ────────────────────────────────────────────
      tool(
        'codepilot_cli_tools_check_updates',
        'Check which installed CLI tools have available updates. Checks brew outdated, npm outdated, and re-detects versions for custom tools.',
        {},
        async () => {
          try {
            const expandedPath = getExpandedPath();
            const env = { ...process.env, PATH: expandedPath };
            const updates: Array<{ name: string; id: string; current: string; latest?: string; method: string }> = [];

            // Check brew outdated
            try {
              const { stdout } = await execAsync('brew outdated --json', { timeout: 30000, env });
              const outdated = JSON.parse(stdout) as Array<{ name: string; installed_versions: string[]; current_version: string }>;
              // Match against catalog tools
              for (const pkg of outdated) {
                const catalogTool = CLI_TOOLS_CATALOG.find(c =>
                  c.installMethods.some(m => m.method === 'brew') &&
                  (c.binNames.includes(pkg.name) || c.id === pkg.name)
                );
                if (catalogTool) {
                  updates.push({
                    name: catalogTool.name,
                    id: catalogTool.id,
                    current: pkg.installed_versions?.[0] ?? 'unknown',
                    latest: pkg.current_version,
                    method: 'brew',
                  });
                }
              }
            } catch { /* brew not installed or no outdated packages */ }

            // Check npm outdated for global packages
            try {
              const { stdout } = await execAsync('npm outdated -g --json', { timeout: 30000, env });
              if (stdout.trim()) {
                const outdated = JSON.parse(stdout) as Record<string, { current: string; wanted: string; latest: string }>;
                for (const [pkg, info] of Object.entries(outdated)) {
                  const catalogTool = CLI_TOOLS_CATALOG.find(c =>
                    c.installMethods.some(m => m.method === 'npm' && m.command.includes(pkg))
                  );
                  // Match custom tools by installPackage (npm reports package names, not binary names)
                  const customTool = getAllCustomCliTools().find(ct =>
                    ct.installMethod === 'npm' && (ct.installPackage === pkg || ct.binName === pkg)
                  );
                  if (catalogTool) {
                    updates.push({
                      name: catalogTool.name,
                      id: catalogTool.id,
                      current: info.current,
                      latest: info.latest,
                      method: 'npm',
                    });
                  } else if (customTool) {
                    updates.push({
                      name: customTool.name,
                      id: customTool.id,
                      current: info.current,
                      latest: info.latest,
                      method: 'npm',
                    });
                  }
                }
              }
            } catch { /* npm not installed or no outdated packages */ }

            // Check custom tools by re-running --version
            const customTools = getAllCustomCliTools();
            for (const ct of customTools) {
              if (ct.installMethod !== 'unknown' && ct.installMethod !== 'brew' && ct.installMethod !== 'npm') continue;
              // For custom tools with unknown method, just report current version
              try {
                const { stdout: vOut, stderr: vErr } = await execFileAsync(ct.binPath, ['--version'], { timeout: 5000, env });
                const vText = (vOut || vErr).trim();
                const match = vText.split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
                const currentVersion = match ? match[1] : null;
                if (currentVersion && ct.version && currentVersion !== ct.version) {
                  updates.push({
                    name: ct.name,
                    id: ct.id,
                    current: ct.version,
                    latest: currentVersion,
                    method: ct.installMethod,
                  });
                }
              } catch { /* tool may have been removed */ }
            }

            if (updates.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'All installed CLI tools are up to date.' }],
              };
            }

            const lines = ['The following tools have available updates:', ''];
            for (const u of updates) {
              lines.push(`- ${u.name}: ${u.current} → ${u.latest ?? 'newer version available'} (${u.method})`);
            }
            lines.push('');
            lines.push('Use codepilot_cli_tools_update to update a specific tool.');

            return {
              content: [{ type: 'text' as const, text: lines.join('\n') }],
            };
          } catch (error) {
            return {
              content: [{
                type: 'text' as const,
                text: `Failed to check updates: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }],
              isError: true,
            };
          }
        },
      ),

      // ── UPDATE ───────────────────────────────────────────────────
      tool(
        'codepilot_cli_tools_update',
        'Update a CLI tool to its latest version. Requires user permission before execution. Determines the update command based on the tool\'s install method (brew upgrade, npm update -g, etc.).',
        {
          toolId: z.string().optional().describe('The tool ID to update (e.g. "ffmpeg", "custom-mytool")'),
          name: z.string().optional().describe('The tool name or binary name to update (used if toolId not provided)'),
        },
        async ({ toolId, name: toolName }) => {
          try {
            const expandedPath = getExpandedPath();
            const env = { ...process.env, PATH: expandedPath };

            let updateMethod: string | null = null;
            let packageName: string | null = null;
            let displayName: string | null = null;

            // Try custom tool first (has stored install metadata)
            const customTool = toolId
              ? getCustomCliTool(toolId)
              : getAllCustomCliTools().find(ct =>
                  ct.name.toLowerCase() === toolName?.toLowerCase() || ct.binName === toolName
                );

            let provenanceIsGuessed = false;

            if (customTool && customTool.installMethod !== 'unknown') {
              displayName = customTool.name;
              packageName = customTool.installPackage || customTool.binName;
              updateMethod = customTool.installMethod;
            } else {
              // Look up catalog definition
              const catalogTool = CLI_TOOLS_CATALOG.find(c =>
                c.id === toolId || c.id === toolName || c.name.toLowerCase() === toolName?.toLowerCase() ||
                c.binNames.some(b => b === toolName)
              );

              if (catalogTool) {
                displayName = catalogTool.name;
                // Check if a shadow custom row has real install metadata
                const { catalog: detected } = await detectAllCliTools();
                const detectedEntry = detected.find(c => c.id === catalogTool.id);
                const shadowRow = detectedEntry?.binPath
                  ? getAllCustomCliTools().find(ct => ct.binPath === detectedEntry.binPath && ct.installMethod !== 'unknown')
                  : undefined;

                if (shadowRow) {
                  updateMethod = shadowRow.installMethod;
                  packageName = shadowRow.installPackage || shadowRow.binName;
                } else {
                  // No tracked install metadata — use catalog default but flag as guessed
                  const primaryInstall = catalogTool.installMethods[0];
                  updateMethod = primaryInstall?.method ?? null;
                  packageName = primaryInstall ? (extractPackageSpec(primaryInstall.command) ?? catalogTool.id) : catalogTool.id;
                  provenanceIsGuessed = true;
                }
              } else if (customTool) {
                displayName = customTool.name;
                packageName = customTool.installPackage || customTool.binName;
                updateMethod = null;
              }
            }

            if (!displayName || !packageName) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Tool "${toolId || toolName}" not found. Use codepilot_cli_tools_list to see available tools.`,
                }],
                isError: true,
              };
            }

            if (!updateMethod) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Cannot determine update method for "${displayName}". The install method is unknown. Please update manually.`,
                }],
                isError: true,
              };
            }

            const updateCmd = buildUpdateCommand(updateMethod, packageName);
            if (!updateCmd) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Unsupported update method "${updateMethod}" for "${displayName}".`,
                }],
                isError: true,
              };
            }

            const { stdout, stderr } = await execAsync(updateCmd, {
              timeout: 300_000,
              env,
            });

            const output = (stdout + '\n' + stderr).trim();

            // Re-detect version after update
            invalidateDetectCache();
            let newVersion: string | null = null;
            let detectedBinPath: string | null = null;
            const catalogMatch = CLI_TOOLS_CATALOG.find(c =>
              c.id === toolId || c.id === toolName || c.name.toLowerCase() === toolName?.toLowerCase()
            );
            if (catalogMatch) {
              const { catalog: freshCatalog } = await detectAllCliTools(true);
              const updated = freshCatalog.find(c => c.id === catalogMatch.id);
              newVersion = updated?.version ?? null;
              detectedBinPath = updated?.binPath ?? null;
            } else {
              const ct = toolId ? getCustomCliTool(toolId) : customTool;
              if (ct) {
                try {
                  const { stdout: vOut, stderr: vErr } = await execFileAsync(ct.binPath, ['--version'], { timeout: 5000, env });
                  const match = (vOut || vErr).trim().split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
                  newVersion = match ? match[1] : null;
                } catch { /* optional */ }
              }
            }

            // Write new version back to DB so check_updates won't report a stale diff
            if (newVersion) {
              const rowToUpdate = customTool
                ?? (detectedBinPath ? getAllCustomCliTools().find(ct => ct.binPath === detectedBinPath) : null);
              if (rowToUpdate) {
                createCustomCliTool({
                  name: rowToUpdate.name,
                  binPath: rowToUpdate.binPath,
                  binName: rowToUpdate.binName,
                  version: newVersion,
                  installMethod: rowToUpdate.installMethod,
                  installPackage: rowToUpdate.installPackage,
                });
              }
            }

            const verStr = newVersion ? ` (now v${newVersion})` : '';
            const warning = provenanceIsGuessed
              ? `\n\nNote: The install method was guessed (${updateMethod}) because this tool was installed outside CodePilot. If the update failed, it may have been installed via a different package manager.`
              : '';
            return {
              content: [{
                type: 'text' as const,
                text: `Updated "${displayName}"${verStr}.\nCommand: ${updateCmd}\n${output.slice(0, 500)}${warning}`,
              }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Update failed';
            return {
              content: [{ type: 'text' as const, text: `Update failed: ${msg}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
