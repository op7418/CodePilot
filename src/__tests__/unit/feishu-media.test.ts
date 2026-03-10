import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extensionForMimeType,
  resolveFeishuResourceMimeType,
  sniffImageMimeType,
} from '../../lib/bridge/adapters/feishu-media';

describe('sniffImageMimeType', () => {
  it('detects jpeg from magic bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.strictEqual(sniffImageMimeType(jpeg), 'image/jpeg');
  });

  it('detects png from magic bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.strictEqual(sniffImageMimeType(png), 'image/png');
  });

  it('detects webp from riff container', () => {
    const webp = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    assert.strictEqual(sniffImageMimeType(webp), 'image/webp');
  });
});

describe('resolveFeishuResourceMimeType', () => {
  it('prefers sniffed image type over hardcoded fallback', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x18]);
    assert.strictEqual(resolveFeishuResourceMimeType('image', jpeg), 'image/jpeg');
  });

  it('falls back to response headers when bytes are unknown', () => {
    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const headers = { 'content-type': 'image/webp; charset=binary' };
    assert.strictEqual(resolveFeishuResourceMimeType('image', unknown, headers), 'image/webp');
  });
});

describe('extensionForMimeType', () => {
  it('maps jpeg to jpg extension', () => {
    assert.strictEqual(extensionForMimeType('image/jpeg', 'image'), 'jpg');
  });

  it('maps webp to webp extension', () => {
    assert.strictEqual(extensionForMimeType('image/webp', 'image'), 'webp');
  });
});
