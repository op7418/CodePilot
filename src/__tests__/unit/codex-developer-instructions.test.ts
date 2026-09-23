import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { composeCodexDeveloperInstructions } from '../../lib/codex/developer-instructions';

describe('Codex developer instructions', () => {
  it('forwards CodePilot context and preserves runtime-only guidance', () => {
    assert.equal(
      composeCodexDeveloperInstructions('assistant workspace rules', 'exact-route guidance'),
      'assistant workspace rules\n\nexact-route guidance',
    );
    assert.equal(composeCodexDeveloperInstructions('assistant workspace rules'), 'assistant workspace rules');
    assert.equal(composeCodexDeveloperInstructions(undefined, '  '), undefined);
  });

  it('runtime passes the assembled system prompt to thread developerInstructions', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../lib/codex/runtime.ts'), 'utf8');
    assert.match(
      source,
      /composeCodexDeveloperInstructions\(\s*\[options\.systemPrompt,\s*codexMcpServers\.codepilot_memory \? MEMORY_SEARCH_SYSTEM_PROMPT : '',\s*codexMcpServers\.codepilot_memory_write \? MEMORY_WRITE_SYSTEM_PROMPT : '',\s*\]\.filter\(Boolean\)\.join\('\\n\\n'\),\s*accountDelegationInstructions/,
    );
    assert.match(source, /developerInstructions\s*\?\s*\{ developerInstructions \}/);
  });
});
