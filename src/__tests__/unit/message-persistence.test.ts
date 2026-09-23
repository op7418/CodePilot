/**
 * Unit tests for structured message persistence in collectStreamResponse.
 *
 * Run with: npx tsx --test src/__tests__/unit/message-persistence.test.ts
 *
 * Tests verify that:
 * 1. parseMessageContent correctly parses structured JSON content
 * 2. parseMessageContent handles plain text fallback
 * 3. MessageContentBlock types are correctly structured
 * 4. Backward compatibility: text-only messages stay as plain strings
 * 5. Mixed content (text + tool_use + tool_result) serializes correctly
 */

import '../db-isolation.setup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMessageContent } from '../../types';
import type { MessageContentBlock } from '../../types';
import { addMessage, createSession, getDb } from '../../lib/db';

describe('parseMessageContent', () => {
  it('should parse plain text as a single text block', () => {
    const result = parseMessageContent('Hello, world!');
    assert.deepEqual(result, [{ type: 'text', text: 'Hello, world!' }]);
  });

  it('should parse JSON array of content blocks', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'text', text: 'Let me check that file.' },
      { type: 'tool_use', id: 'tu_123', name: 'read_file', input: { path: '/src/index.ts' } },
    ];
    const json = JSON.stringify(blocks);
    const result = parseMessageContent(json);
    assert.deepEqual(result, blocks);
  });

  it('should handle tool_result blocks', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'text', text: 'Reading file...' },
      { type: 'tool_use', id: 'tu_456', name: 'read_file', input: { path: '/package.json' } },
      { type: 'tool_result', tool_use_id: 'tu_456', content: '{"name": "codepilot"}', is_error: false },
      { type: 'text', text: 'The package name is codepilot.' },
    ];
    const json = JSON.stringify(blocks);
    const result = parseMessageContent(json);
    assert.equal(result.length, 4);
    assert.equal(result[0].type, 'text');
    assert.equal(result[1].type, 'tool_use');
    assert.equal(result[2].type, 'tool_result');
    assert.equal(result[3].type, 'text');
  });

  it('should handle error tool results', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'tu_789', content: 'File not found', is_error: true },
    ];
    const json = JSON.stringify(blocks);
    const result = parseMessageContent(json);
    assert.equal(result.length, 1);
    const block = result[0] as Extract<MessageContentBlock, { type: 'tool_result' }>;
    assert.equal(block.is_error, true);
  });

  it('should fall back to plain text for non-JSON content', () => {
    const content = 'This is markdown **bold** text with `code`';
    const result = parseMessageContent(content);
    assert.deepEqual(result, [{ type: 'text', text: content }]);
  });

  it('should fall back to plain text for JSON that is not an array', () => {
    const content = JSON.stringify({ key: 'value' });
    const result = parseMessageContent(content);
    assert.deepEqual(result, [{ type: 'text', text: content }]);
  });

  it('should handle empty content', () => {
    const result = parseMessageContent('');
    assert.deepEqual(result, [{ type: 'text', text: '' }]);
  });
});

describe('Structured message serialization', () => {
  it('should serialize text-only messages as plain text for backward compat', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'text', text: 'Hello, this is a response.' },
    ];

    // Logic from collectStreamResponse: text-only → plain string
    const hasToolBlocks = blocks.some(
      (b) => b.type === 'tool_use' || b.type === 'tool_result'
    );
    assert.equal(hasToolBlocks, false);

    const content = blocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    assert.equal(content, 'Hello, this is a response.');
    // parseMessageContent should handle it as plain text
    const parsed = parseMessageContent(content);
    assert.deepEqual(parsed, [{ type: 'text', text: 'Hello, this is a response.' }]);
  });

  it('should serialize mixed content as JSON', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'text', text: 'Let me read that.' },
      { type: 'tool_use', id: 'tu_001', name: 'read_file', input: { path: '/src/app.ts' } },
      { type: 'tool_result', tool_use_id: 'tu_001', content: 'export default {};', is_error: false },
      { type: 'text', text: 'The file exports a default empty object.' },
    ];

    const hasToolBlocks = blocks.some(
      (b) => b.type === 'tool_use' || b.type === 'tool_result'
    );
    assert.equal(hasToolBlocks, true);

    const content = JSON.stringify(blocks);
    // Should round-trip correctly
    const parsed = parseMessageContent(content);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].type, 'text');
    assert.equal(parsed[1].type, 'tool_use');
    assert.equal(parsed[2].type, 'tool_result');
    assert.equal(parsed[3].type, 'text');
  });

  it('should handle multiple text blocks being flushed around tool calls', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'text', text: 'First I will check the file structure.' },
      { type: 'tool_use', id: 'tu_a', name: 'list_files', input: { dir: '.' } },
      { type: 'tool_result', tool_use_id: 'tu_a', content: 'src/\npackage.json', is_error: false },
      { type: 'text', text: 'Now let me read package.json.' },
      { type: 'tool_use', id: 'tu_b', name: 'read_file', input: { path: 'package.json' } },
      { type: 'tool_result', tool_use_id: 'tu_b', content: '{"name":"test"}', is_error: false },
      { type: 'text', text: 'Done! The project is named "test".' },
    ];

    const content = JSON.stringify(blocks);
    const parsed = parseMessageContent(content);
    assert.equal(parsed.length, 7);

    // Verify interleaved structure is preserved
    const types = parsed.map((b) => b.type);
    assert.deepEqual(types, [
      'text', 'tool_use', 'tool_result',
      'text', 'tool_use', 'tool_result',
      'text',
    ]);
  });
});

describe('message persistence transaction', () => {
  it('returns the actual inserted row on the normal path', () => {
    const session = createSession('message-persistence-happy');
    const saved = addMessage(session.id, 'assistant', 'persisted reply', '{"input_tokens":1,"output_tokens":2}');

    assert.equal(saved.session_id, session.id);
    assert.equal(saved.role, 'assistant');
    assert.equal(saved.content, 'persisted reply');
    assert.equal(saved.stream_status, 'completed');
    assert.equal(typeof saved._rowid, 'number');
  });

  it('throws a stable product error and rolls back when the inserted row cannot be read', () => {
    const session = createSession('message-persistence-missing-row');
    const db = getDb();
    const originalUpdatedAt = '2000-01-01 00:00:00';
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?')
      .run(originalUpdatedAt, session.id);
    db.exec(`
      CREATE TRIGGER message_persistence_missing_row_probe
      AFTER INSERT ON messages
      WHEN NEW.content = 'force-missing-row'
      BEGIN
        DELETE FROM messages WHERE id = NEW.id;
      END;
    `);

    try {
      assert.throws(
        () => addMessage(session.id, 'assistant', 'force-missing-row'),
        /CODEPILOT_MESSAGE_PERSISTENCE_FAILED/,
      );
      const messageCount = db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
      ).get(session.id) as { count: number };
      assert.equal(messageCount.count, 0, 'failed persistence must not leave a partial row');
      const updated = db.prepare(
        'SELECT updated_at FROM chat_sessions WHERE id = ?',
      ).get(session.id) as { updated_at: string };
      assert.equal(updated.updated_at, originalUpdatedAt, 'session timestamp update must roll back too');
    } finally {
      db.exec('DROP TRIGGER IF EXISTS message_persistence_missing_row_probe');
    }
  });
});
