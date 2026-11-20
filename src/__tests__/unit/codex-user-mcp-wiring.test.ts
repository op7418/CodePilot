/**
 * Phase 8 — Codex Runtime MCP wiring guardrail.
 *
 * History: Phase 5e (2026-05-18) pinned "Codex Runtime does NOT mount user
 * MCP servers" by forbidding the ClaudeCode SDK MCP loaders in the Codex
 * files. Phase 8 (2026-05-27) gives Codex its OWN native injection path
 * (`config.mcp_servers` via `buildCodexMcpServersConfig` /
 * `buildCodexMemoryMcpConfig`), validated against Codex 0.133 — see
 * `docs/research/codex-mcp-injection-poc/`.
 *
 * So the guardrail evolved from "Codex has no MCP wire-up" to "Codex's MCP
 * wire-up is its OWN native injection, and the Settings capability flag
 * stays in lock-step with that wiring":
 *
 *   A. Codex files must never import the ClaudeCode SDK loaders — Codex
 *      injects via `config.mcp_servers`, not Claude's in-process loaders.
 *   B. The native injection builder must exist.
 *   C. SAME-SOURCE invariant: the scanner may only mark `mcp_server`
 *      executable on `codex_runtime` if the runtime actually injects
 *      `config.mcp_servers`. Until Phase 4 validates + flips that capability
 *      (paired with a Phase 5 smoke), it stays `perception_only` — and the
 *      explicit pin below fails loudly when someone flips it, so the flip,
 *      the injection, and this guardrail are reviewed together.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}
function srcExists(rel: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

// Files that comprise the Codex Runtime send path.
const CODEX_FILES = [
  'src/lib/codex/proxy/unified-adapter.ts',
  'src/lib/codex/proxy/builtin-bridge.ts',
  'src/lib/harness/builtin-event-bus.ts',
  'src/lib/codex/proxy/translate-input.ts',
  'src/lib/codex/proxy/translate-tools.ts',
  'src/lib/codex/proxy/translate-stream.ts',
  'src/lib/codex/proxy/translate-response.ts',
  'src/lib/codex/proxy/adapter.ts',
  'src/lib/codex/runtime.ts',
];

// Files where the native injection wiring lives (Phase 2).
const CODEX_INJECTION_FILES = ['src/lib/codex/provider-proxy.ts', 'src/lib/codex/runtime.ts'];

describe('Codex Runtime — A. never borrows the ClaudeCode SDK MCP loaders', () => {
  it('no Codex send-path file imports the SDK loaders', () => {
    const forbidden = [
      'buildMcpToolSet',
      'loadCodePilotMcpServers',
      'loadAllMcpServers',
      'loadProjectMcpServers',
    ];
    for (const rel of CODEX_FILES) {
      const src = readSrc(rel);
      for (const symbol of forbidden) {
        assert.equal(
          src.includes(symbol),
          false,
          `${rel} references "${symbol}" — Codex must inject MCP via its own native config.mcp_servers (buildCodexMcpServersConfig), not the ClaudeCode SDK loaders.`,
        );
      }
    }
  });
});

describe('Codex Runtime — B. native MCP injection builder exists', () => {
  it('mcp-config.ts exports the Codex MCP config builders', async () => {
    assert.ok(srcExists('src/lib/codex/mcp-config.ts'), 'src/lib/codex/mcp-config.ts is missing');
    const mod = await import('@/lib/codex/mcp-config');
    assert.equal(typeof mod.buildCodexMcpServersConfig, 'function');
    assert.equal(typeof mod.buildCodexMemoryMcpConfig, 'function');
    assert.equal(typeof mod.fingerprintCodexMcpConfig, 'function');
  });
});

describe('Codex Runtime — C. capability flag stays in lock-step with injection', () => {
  // Does the runtime actually inject config.mcp_servers? (Phase 2 wiring.)
  function runtimeInjectsMcp(): boolean {
    return CODEX_INJECTION_FILES.some((rel) => {
      if (!srcExists(rel)) return false;
      const src = readSrc(rel);
      return src.includes('mcp_servers') || src.includes('buildCodexMcpServersConfig');
    });
  }

  it('scanner only marks codex_runtime mcp_server executable when the runtime injects (same-source)', async () => {
    const { scanUserCodePilotExtensions } = await import('@/lib/harness/user-codepilot-extensions');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsMod = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const osMod = require('node:os');
    const tmp = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'codex-mcp-pin-'));
    try {
      fsMod.writeFileSync(
        path.join(tmp, '.mcp.json'),
        JSON.stringify({ mcpServers: { weather: { command: 'mcp-weather' } } }),
        'utf-8',
      );
      const out = scanUserCodePilotExtensions({ workspacePath: tmp, runtimeId: 'codex_runtime' });
      const mcp = out.find((e) => e.kind === 'mcp_server');
      assert.ok(mcp);

      // One-directional invariant: NEVER advertise "callable" without wiring.
      if (mcp!.executable) {
        assert.ok(
          runtimeInjectsMcp(),
          'scanner marks codex_runtime mcp_server executable, but no runtime file injects config.mcp_servers — wire injection (Phase 2) before flipping the capability.',
        );
      }

      // Current state (Phase 1–3): the injection plumbing is wired, but the
      // capability is NOT yet surfaced as executable. Phase 4 flips this only
      // after a Phase 5 real-credential smoke; when it does, update this
      // assertion + the capability matrix together (they change as a pair).
      assert.equal(
        mcp!.executable,
        false,
        'codex_runtime mcp_server is still perception_only until Phase 4 validates + flips it. If you are doing Phase 4, update this guardrail and the capability matrix in the same change.',
      );
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
