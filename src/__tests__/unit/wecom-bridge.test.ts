/**
 * Unit tests for WeCom bridge markdown/card helpers.
 *
 * Run with: npx tsx --test src/__tests__/unit/wecom-bridge.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarkdownMessage,
  buildPermissionCard,
  buildPermissionCommandText,
  hasComplexMarkdown,
  htmlToWecomMarkdown,
  preprocessWecomMarkdown,
} from '../../lib/bridge/markdown/wecom';

describe('WeCom markdown helpers', () => {
  it('detects fenced code blocks as complex markdown', () => {
    assert.equal(hasComplexMarkdown('hello\n```ts\nconst x = 1;\n```'), true);
  });

  it('detects tables as complex markdown', () => {
    assert.equal(hasComplexMarkdown('| a | b |\n| - | - |\n| 1 | 2 |'), true);
  });

  it('adds a newline before code fences when needed', () => {
    assert.equal(preprocessWecomMarkdown('Intro```ts\nconst x = 1;\n```'), 'Intro\n```ts\nconst x = 1;\n```');
  });

  it('converts simple html to markdown', () => {
    assert.equal(htmlToWecomMarkdown('<b>bold</b><br><code>x</code>'), '**bold**\n`x`');
  });

  it('builds markdown message payloads', () => {
    assert.deepEqual(buildMarkdownMessage('hello'), {
      msgtype: 'markdown',
      markdown: { content: 'hello' },
    });
  });
});

describe('WeCom permission helpers', () => {
  const buttons = [[
    { text: 'Allow once', callbackData: 'perm:allow:req-1' },
    { text: 'Deny', callbackData: 'perm:deny:req-1' },
  ]];

  it('renders /perm fallback text', () => {
    const text = buildPermissionCommandText('Need approval', buttons);
    assert.ok(text.includes('/perm allow req-1'));
    assert.ok(text.includes('/perm deny req-1'));
  });

  it('builds clickable permission cards', () => {
    const card = buildPermissionCard(buttons, 'perm_fixed');
    assert.equal(card.msgtype, 'template_card');
    assert.equal(card.template_card.card_type, 'button_interaction');
    assert.equal(card.template_card.task_id, 'perm_fixed');
    assert.equal(card.template_card.button_list?.[0]?.key, 'perm:allow:req-1');
  });
});