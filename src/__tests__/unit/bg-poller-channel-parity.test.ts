import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MAIN = readFileSync(path.resolve(__dirname, '../../../electron/main.ts'), 'utf-8');
const PRELOAD = readFileSync(path.resolve(__dirname, '../../../electron/preload.ts'), 'utf-8');
const APP_SHELL = readFileSync(
  path.resolve(__dirname, '../../components/layout/AppShell.tsx'),
  'utf-8',
);

describe('single native-notification owner contract', () => {
  it('Electron Main claims and settles the durable electron-native row', () => {
    const block = MAIN.match(/function startNativeDeliveryService[\s\S]*?function stopNativeDeliveryService/);
    assert.ok(block, 'native delivery service body not found');
    assert.match(block![0], /['"]\/api\/tasks\/notify\/claim['"]/);
    assert.match(block![0], /channel:\s*['"]electron-native['"]/);
    assert.match(block![0], /['"]\/api\/tasks\/notify\/ack['"]/);
    assert.match(block![0], /deliverNativeNotification/);
  });

  it('window visibility never transfers native delivery ownership', () => {
    assert.doesNotMatch(MAIN, /startBgNotifyPoll|stopBgNotifyPoll|bgNotifyTimer/);
    assert.doesNotMatch(MAIN, /mainWindow\.on\(['"](?:hide|show)['"][\s\S]{0,120}Delivery/);
  });

  it('renderer cannot invoke a native notification show IPC', () => {
    assert.doesNotMatch(MAIN, /notification:show/);
    assert.doesNotMatch(PRELOAD, /notification:show|\bshow:\s*\(/);
    assert.match(PRELOAD, /notification:renderer-ready/);
  });

  it('renderer has no notification-delivery consumer', () => {
    assert.doesNotMatch(APP_SHELL, /useNotificationPoll|renderer-toast/);
    assert.doesNotMatch(PRELOAD, /notification:show|\bshow:\s*\(/);
  });

  it('the retired electron-bg-native channel remains absent', () => {
    assert.doesNotMatch(MAIN, /['"]electron-bg-native['"]/);
  });
});
