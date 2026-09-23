import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

let tempDir: string;
let originalDataDir: string | undefined;

before(() => {
  originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-notify-test-route-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDir;
});

after(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CLAUDE_GUI_DATA_DIR;
  else process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
});

describe('test system notification route', () => {
  it('writes a real native delivery without a model call or chat mutation', async () => {
    const db = await import('../../lib/db');
    const route = await import('../../app/api/tasks/notify/test/route');
    const beforeMessages = (db.getDb().prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count;
    const response = await route.POST(new NextRequest('http://127.0.0.1:3000/api/tasks/notify/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:3000',
        Host: '127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '{}',
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { event_id: string; delivery: { channel: string; status: string } };
    assert.equal(payload.delivery.channel, 'electron-native');
    assert.equal(payload.delivery.status, 'queued');

    const event = db.getNotificationEvent(payload.event_id);
    assert.equal(event?.action_type, 'route');
    assert.equal(event?.action_payload, '/settings/assistant?notificationTest=1');
    assert.equal(
      (db.getDb().prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
      beforeMessages,
      'testing notification must not write assistant chat or memory evidence',
    );

    const status = await route.GET(new NextRequest(
      `http://127.0.0.1:3000/api/tasks/notify/test?event_id=${encodeURIComponent(payload.event_id)}`,
    ));
    assert.equal(status.status, 200);
    assert.equal((await status.json()).delivery.status, 'queued');
  });

  it('rejects a cross-origin mutation', async () => {
    const route = await import('../../app/api/tasks/notify/test/route');
    const response = await route.POST(new NextRequest('http://127.0.0.1:3000/api/tasks/notify/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://evil.example',
        Host: '127.0.0.1:3000',
      },
      body: '{}',
    }));
    assert.equal(response.status, 403);
  });

  it('rejects retired renderer-toast claims and acknowledgements', async () => {
    const claimRoute = await import('../../app/api/tasks/notify/claim/route');
    const ackRoute = await import('../../app/api/tasks/notify/ack/route');
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:3000',
      Host: '127.0.0.1:3000',
      'Sec-Fetch-Site': 'same-origin',
    };

    const claim = await claimRoute.POST(new NextRequest(
      'http://127.0.0.1:3000/api/tasks/notify/claim',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'renderer-toast', owner: 'retired-renderer' }),
      },
    ));
    assert.equal(claim.status, 400);

    const ack = await ackRoute.POST(new NextRequest(
      'http://127.0.0.1:3000/api/tasks/notify/ack',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          delivery_id: 'legacy-delivery',
          owner: 'retired-renderer',
          channel: 'renderer-toast',
          outcome: 'delivered',
        }),
      },
    ));
    assert.equal(ack.status, 400);
  });
});
