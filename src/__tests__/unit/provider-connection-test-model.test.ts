import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConnectionTestModelName } from '../../lib/provider-connection-test-model';

describe('resolveConnectionTestModelName', () => {
  it('uses the mapped Sonnet model when no default model is configured', () => {
    assert.equal(
      resolveConnectionTestModelName('', 'claude-sonnet-4-6'),
      'claude-sonnet-4-6',
    );
  });

  it('prefers an explicitly configured default model over the Sonnet mapping', () => {
    assert.equal(
      resolveConnectionTestModelName('custom-default-model', 'claude-sonnet-4-6'),
      'custom-default-model',
    );
  });

  it('leaves model selection to the existing connection-test fallback when both fields are empty', () => {
    assert.equal(resolveConnectionTestModelName('', ''), undefined);
  });

  it('uses the resolver when building the connection-test payload', () => {
    const dialogSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/settings/PresetConnectDialog.tsx'),
      'utf8',
    );

    assert.match(
      dialogSource,
      /modelName:\s*resolveConnectionTestModelName\(modelName,\s*mapSonnet\)/,
    );
  });

  it('does not seed a hidden default model for mapping-only presets', () => {
    const dialogSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/settings/PresetConnectDialog.tsx'),
      'utf8',
    );

    assert.match(
      dialogSource,
      /setModelName\(\s*preset\.fields\.includes\("model_names"\)\s*\?\s*\(preset\.defaultModelId \|\| ""\)\s*:\s*""\s*,?\s*\)/,
    );
  });
});
