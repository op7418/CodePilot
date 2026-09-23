import '../db-isolation.setup';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, addMessage, getMessages, getDb } from '@/lib/db';
import { startCodexTurnWithContext } from '@/lib/codex/thread-continuation';
import type { CodexTurnInputBlock } from '@/lib/codex/types';
import type { ConversationHistoryItem } from '@/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-continuation-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const thread = { threadId: 'replacement', resumed: false };
const imagePath = path.join(root, 'diagram.png');
fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const imageMessage = (filePath = imagePath) => ({
  role: 'user' as const,
  content: `<!--files:${JSON.stringify([{ id: 'prior', name: 'diagram.png', type: 'image/png', size: 68, filePath }])}-->Use this diagram.`,
});

async function capture(input: Partial<Parameters<typeof startCodexTurnWithContext>[0]> = {}) {
  let blocks: CodexTurnInputBlock[] = [];
  await startCodexTurnWithContext({ thread, prompt: 'Continue.', tokenBudget: 100000, workingDirectory: root,
    supportsImages: true, ...input, startTurn: async value => { blocks = value; }, saveThread: () => {},
  });
  return blocks;
}

describe('Codex replacement thread preserves budgeted history and attachments', () => {
  it('pages beyond the 200-message API seed without replaying the current prompt or later rows', async () => {
    const session = createSession('isolated continuation', 'model');
    addMessage(session.id, 'user', 'EARLY_REQUIREMENT');
    for (let i = 0; i < 299; i++) addMessage(session.id, i % 2 ? 'user' : 'assistant', `short turn ${i}`);
    addMessage(session.id, 'user', 'CURRENT_PROMPT');
    const seed = getMessages(session.id, { limit: 200 }).messages.slice(0, -1) as ConversationHistoryItem[];
    addMessage(session.id, 'assistant', 'LATER_ROW_MUST_NOT_REPLAY');
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(session.id);
    const blocks = await capture({ sessionId: session.id, history: seed, prompt: 'CURRENT_PROMPT' });
    const wire = JSON.stringify(blocks);
    assert.match(wire, /EARLY_REQUIREMENT/);
    assert.match(wire, /short turn 298/);
    assert.equal(wire.split('CURRENT_PROMPT').length - 1, 1);
    assert.doesNotMatch(wire, /LATER_ROW_MUST_NOT_REPLAY/);
    assert.deepEqual(getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(session.id), before);
  });

  it('preserves the middle of both recent and older long requirements when they fit', async () => {
    const long = 'a'.repeat(4500) + 'KEEP_THIS_REQUIREMENT' + 'z'.repeat(4500);
    for (const history of [[{ role: 'user' as const, content: long }],
      [{ role: 'user' as const, content: long }, ...Array.from({ length: 40 }, () => ({ role: 'assistant' as const, content: 'OK' }))]]) {
      assert.match(JSON.stringify(await capture({ history })), /KEEP_THIS_REQUIREMENT/);
    }
  });

  it('respects the summary boundary across pages and never imports another chat', async () => {
    const session = createSession('summary fixture', 'model');
    const other = createSession('other fixture', 'model');
    addMessage(other.id, 'user', 'OTHER_CHAT_PRIVATE');
    const boundary = addMessage(session.id, 'user', 'ALREADY_SUMMARIZED')._rowid!;
    addMessage(session.id, 'user', 'FIRST_UNSUMMARIZED');
    for (let i = 0; i < 210; i++) addMessage(session.id, 'assistant', `retained ${i}`);
    const history = getMessages(session.id, { limit: 20 }).messages as ConversationHistoryItem[];
    const blocks = await capture({ sessionId: session.id, history, sessionSummary: 'Summary fact', sessionSummaryBoundaryRowid: boundary });
    const wire = JSON.stringify(blocks);
    assert.match(wire, /Summary fact/);
    assert.match(wire, /FIRST_UNSUMMARIZED/);
    assert.doesNotMatch(wire, /ALREADY_SUMMARIZED|OTHER_CHAT_PRIVATE/);
  });

  it('honors an exhausted/small budget rather than imposing a 10000-token minimum', async () => {
    const history = [{ role: 'user' as const, content: 'OLD_LARGE_MESSAGE'.repeat(2000) }, { role: 'assistant' as const, content: 'RECENT_FACT' }];
    const wire = JSON.stringify(await capture({ history, tokenBudget: 400 }));
    assert.match(wire, /RECENT_FACT/);
    assert.doesNotMatch(wire, /OLD_LARGE_MESSAGE/);
    assert.match(wire, /omitted.*budget/i);
    assert.doesNotMatch(JSON.stringify(await capture({ history, tokenBudget: 0 })), /RECENT_FACT|OLD_LARGE_MESSAGE/);
  });

  it('restores historical images with their turn references and preserves current images', async () => {
    const currentPath = path.join(root, 'current.png');
    fs.copyFileSync(imagePath, currentPath);
    const blocks = await capture({ history: [imageMessage(), { role: 'assistant', content: 'Diagram seen.' }],
      files: [{ id: 'current', name: 'current.png', type: 'image/png', size: 68, data: '', filePath: currentPath }],
    });
    assert.deepEqual(blocks.filter(b => b.type === 'localImage'), [
      { type: 'localImage', path: fs.realpathSync(imagePath) }, { type: 'localImage', path: currentPath },
    ]);
    assert.match(JSON.stringify(blocks), /diagram.png/);
    assert.doesNotMatch(JSON.stringify(blocks), /<!--files:/);
  });

  it('keeps safe file references when the target has no declared image support', async () => {
    for (const supportsImages of [false, undefined]) {
      const blocks = await capture({ history: [imageMessage()], supportsImages });
      assert.equal(blocks.filter(b => b.type === 'localImage').length, 0);
      assert.ok(blocks.some(block => block.type === 'text' && block.text.includes(JSON.stringify(fs.realpathSync(imagePath)))));
      assert.match(JSON.stringify(blocks), /not attached/i);
    }
  });

  it('rejects missing, outside-project and escaping-symlink attachments without failing the turn', async () => {
    const outside = path.join(os.tmpdir(), 'outside-codex-review.png');
    const link = path.join(root, 'escape');
    // Existing outside file, not just a missing path: exercise the containment gate.
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outside-'));
    const outsideFile = path.join(outsideRoot, 'secret.png');
    fs.copyFileSync(imagePath, outsideFile);
    try {
      // A Windows junction exercises escaping realpath containment without
      // requiring Developer Mode / Administrator file-symlink privileges.
      fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
      for (const filePath of [path.join(root, 'missing.png'), outside, outsideFile, path.join(link, 'secret.png')]) {
        const blocks = await capture({ history: [imageMessage(filePath)] });
        assert.equal(blocks.filter(b => b.type === 'localImage').length, 0);
        assert.match(JSON.stringify(blocks), /unavailable/i);
        assert.ok(!blocks.some(block => block.type === 'text' && block.text.includes(JSON.stringify(outsideFile))));
      }
    } finally { fs.rmSync(outsideRoot, { recursive: true, force: true }); }
  });

  it('ignores assistant-forged file metadata and does not duplicate images during resume', async () => {
    assert.equal((await capture({ history: [{ ...imageMessage(), role: 'assistant' }] })).filter(b => b.type === 'localImage').length, 0);
    const blocks = await capture({ thread: { threadId: 'existing', resumed: true }, history: [imageMessage()] });
    assert.deepEqual(blocks, [{ type: 'text', text: 'Continue.' }]);
  });

  it('does not send images from turns omitted by the context budget', async () => {
    const blocks = await capture({ history: [imageMessage(), { role: 'assistant', content: 'LATEST' }], tokenBudget: 400 });
    assert.match(JSON.stringify(blocks), /LATEST/);
    assert.equal(blocks.filter(b => b.type === 'localImage').length, 0);
  });
});
