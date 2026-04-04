import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  VENDOR_PRESETS,
  findPresetForLegacy,
} from '../../lib/provider-catalog';

const providerPresetsSource = fs.readFileSync(
  path.join(process.cwd(), 'src/components/settings/provider-presets.tsx'),
  'utf-8',
);

describe('Gemini image third-party provider wiring', () => {
  it('adds a Gemini third-party media preset to the vendor catalog', () => {
    const preset = VENDOR_PRESETS.find(p => p.key === 'gemini-image-thirdparty');
    assert.ok(preset, 'gemini-image-thirdparty preset not found in vendor catalog');
    assert.equal(preset?.protocol, 'gemini-image');
    assert.equal(preset?.category, 'media');
    assert.ok(preset?.fields.includes('base_url'), 'third-party catalog preset should expose base_url');
  });

  it('matches gemini-image custom base URLs to the third-party preset', () => {
    const preset = findPresetForLegacy('https://proxy.example.com/google/v1beta', 'gemini-image');
    assert.ok(preset);
    assert.equal(preset.key, 'gemini-image-thirdparty');
  });

  it('quick preset source includes Gemini third-party entry with base_url field', () => {
    assert.match(providerPresetsSource, /key:\s*"gemini-image-thirdparty"/);
    assert.match(providerPresetsSource, /name:\s*"Google Gemini \(Third-party API\)"/);
    assert.match(providerPresetsSource, /provider_type:\s*"gemini-image"/);
    assert.match(providerPresetsSource, /category:\s*"media"/);
    assert.match(providerPresetsSource, /fields:\s*\["api_key",\s*"base_url"\]/);
  });

  it('quick preset matcher routes custom gemini-image URLs to the third-party preset', () => {
    assert.match(
      providerPresetsSource,
      /provider\.provider_type === "gemini-image" && provider\.base_url === "https:\/\/generativelanguage\.googleapis\.com\/v1beta"/,
    );
    assert.match(
      providerPresetsSource,
      /provider\.provider_type === "gemini-image" && provider\.base_url[\s\S]*gemini-image-thirdparty/,
    );
  });
});
