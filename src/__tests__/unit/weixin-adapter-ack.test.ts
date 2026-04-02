import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-weixin-ack-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

let WeixinAdapter: typeof import('../../lib/bridge/adapters/weixin-adapter').WeixinAdapter;
let getChannelOffset: typeof import('../../lib/db').getChannelOffset;
let closeDb: typeof import('../../lib/db').closeDb;

/** Test-only facade to access WeixinAdapter internals */
interface WeixinAdapterTestable {
  pendingCursors: Map<number, { offsetKey: string; cursor: string; remaining: number; sealed: boolean }>;
  processMessage: (...args: unknown[]) => Promise<void>;
  consumeOne: () => Promise<{ updateId?: number } | null>;
  acknowledgeUpdate: (id: number) => void;
  maybeCommitPendingCursor: (id: number) => void;
}

before(async () => {
  ({ WeixinAdapter } = await import('../../lib/bridge/adapters/weixin-adapter'));
  ({ getChannelOffset, closeDb } = await import('../../lib/db'));
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WeixinAdapter deferred cursor ack', () => {
  it('attaches batch updateId to enqueued inbound messages', async () => {
    const adapter = new WeixinAdapter() as unknown as WeixinAdapterTestable;
    adapter.pendingCursors.set(42, {
      offsetKey: 'weixin:acc-1',
      cursor: 'cursor-42',
      remaining: 0,
      sealed: false,
    });

    await adapter.processMessage(
      'acc-1',
      {
        botToken: 'token',
        ilinkBotId: 'acc-1',
        baseUrl: 'https://example.test',
        cdnBaseUrl: 'https://cdn.example.test',
      },
      {
        from_user_id: 'peer-1',
        message_id: 'msg-1',
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      },
      42,
    );

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.updateId, 42);
    assert.equal(adapter.pendingCursors.get(42)?.remaining, 1);
  });

  it('commits cursor only after final acknowledgeUpdate', () => {
    const adapter = new WeixinAdapter() as unknown as WeixinAdapterTestable;

    adapter.pendingCursors.set(7, {
      offsetKey: 'weixin:acc-7',
      cursor: 'cursor-7',
      remaining: 2,
      sealed: true,
    });

    adapter.acknowledgeUpdate(7);
    assert.equal(getChannelOffset('weixin:acc-7'), '0');

    adapter.acknowledgeUpdate(7);
    assert.equal(getChannelOffset('weixin:acc-7'), 'cursor-7');
  });

  it('does not commit cursor before the batch is sealed', () => {
    const adapter = new WeixinAdapter() as unknown as WeixinAdapterTestable;

    adapter.pendingCursors.set(8, {
      offsetKey: 'weixin:acc-8',
      cursor: 'cursor-8',
      remaining: 1,
      sealed: false,
    });

    adapter.acknowledgeUpdate(8);
    assert.equal(getChannelOffset('weixin:acc-8'), '0');

    adapter.pendingCursors.get(8)!.sealed = true;
    adapter.maybeCommitPendingCursor(8);
    assert.equal(getChannelOffset('weixin:acc-8'), 'cursor-8');
  });
});
