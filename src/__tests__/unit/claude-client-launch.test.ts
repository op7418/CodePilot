import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeClaudeCodeModel, resolveClaudeLaunchConfig } from '../../lib/claude-client';

describe('claude client launch', () => {
  it('resolves npm cmd wrappers to cli.js plus sibling node.exe on Windows', () => {
    if (process.platform !== 'win32') return;

    const wrapperPath = 'C:\\Program Files\\nodejs\\claude.cmd';
    const config = resolveClaudeLaunchConfig(wrapperPath);

    assert.equal(config.pathToClaudeCodeExecutable, 'C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
    assert.equal(config.executable, 'node');
  });


  it('normalizes upstream Anthropic model ids back to Claude Code aliases', () => {
    const normalized = normalizeClaudeCodeModel('claude-sonnet-4-20250514', [
      { modelId: 'sonnet', upstreamModelId: 'claude-sonnet-4-20250514' },
      { modelId: 'opus', upstreamModelId: 'claude-opus-4-20250514' },
    ]);

    assert.equal(normalized, 'sonnet');
  });
  it('preserves exe paths', () => {
    const exePath = process.platform === 'win32'
      ? 'C:\\Program Files\\Claude\\claude.exe'
      : '/usr/local/bin/claude';

    const config = resolveClaudeLaunchConfig(exePath);
    assert.equal(config.pathToClaudeCodeExecutable, exePath);
    assert.equal(config.executable, undefined);
  });
});
