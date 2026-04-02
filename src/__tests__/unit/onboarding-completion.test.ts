/**
 * Unit tests for onboarding completion extraction and robust JSON parsing.
 *
 * Run with: npx tsx --test src/__tests__/unit/onboarding-completion.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCompletionFence,
  parseCompletionPayload,
  extractCompletion,
} from '../../lib/onboarding-completion';

// ─── Fence Extraction ────────────────────────────────────────────

describe('extractCompletionFence', () => {
  it('should extract onboarding-complete fence with LF', () => {
    const content = 'Some text\n```onboarding-complete\n{"q1":"hello"}\n```\nMore text';
    const result = extractCompletionFence(content);
    assert.ok(result);
    assert.equal(result!.type, 'onboarding');
    assert.equal(result!.rawPayload, '{"q1":"hello"}');
  });

  it('should extract fence with CRLF', () => {
    const content = '```onboarding-complete\r\n{"q1":"hello"}\r\n```';
    const result = extractCompletionFence(content);
    assert.ok(result);
    assert.equal(result!.rawPayload, '{"q1":"hello"}');
  });

  it('should extract fence with trailing spaces after tag', () => {
    const content = '```onboarding-complete   \n{"q1":"hello"}\n```';
    const result = extractCompletionFence(content);
    assert.ok(result);
  });

  it('should extract fence with leading whitespace before closing fence', () => {
    const content = '```onboarding-complete\n{"q1":"hello"}\n  ```';
    const result = extractCompletionFence(content);
    assert.ok(result);
  });

  it('should extract fence with triple+ backticks', () => {
    const content = '````onboarding-complete\n{"q1":"hello"}\n````';
    const result = extractCompletionFence(content);
    assert.ok(result);
  });

  it('should extract checkin-complete fence', () => {
    const content = '```checkin-complete\n{"q1":"did coding"}\n```';
    const result = extractCompletionFence(content);
    assert.ok(result);
    assert.equal(result!.type, 'checkin');
  });

  it('should return null when no fence present', () => {
    const content = 'Just a normal message with no fence';
    assert.equal(extractCompletionFence(content), null);
  });

  it('should handle fence embedded in larger markdown content', () => {
    const content = `Great, let me summarize your answers:

Here is your profile:

\`\`\`onboarding-complete
{"q1":"Alice","q2":"Claude","q3":"concise","q4":"minimal","q5":"no spam, no ads, no tracking","q6":"learn rust, ship product, read more","q7":"lists","q8":"preferences and goals","q9":"passwords","q10":"read README, check issues, review structure","q11":"project","q12":"Inbox","q13":"move to archive folder"}
\`\`\`

Your workspace is being initialized!`;
    const result = extractCompletionFence(content);
    assert.ok(result);
    assert.equal(result!.type, 'onboarding');
  });
});

// ─── Robust JSON Parsing ─────────────────────────────────────────

describe('parseCompletionPayload', () => {
  it('should parse valid JSON directly', () => {
    const payload = '{"q1":"hello","q2":"world"}';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(result!.q1, 'hello');
    assert.equal(result!.q2, 'world');
  });

  it('should handle JSON with whitespace padding', () => {
    const payload = '  {"q1":"hello","q2":"world"}  ';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(result!.q1, 'hello');
  });

  it('should handle values containing double quotes (escaped)', () => {
    const payload = '{"q1":"he said \\"hello\\"","q2":"world"}';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.ok(result!.q1.includes('hello'));
  });

  it('should handle values containing unescaped newlines', () => {
    // AI might produce a value with literal newlines
    const payload = '{"q1":"line1\nline2","q2":"world"}';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.ok(result!.q1.includes('line1'));
  });

  it('should handle trailing comma', () => {
    const payload = '{"q1":"hello","q2":"world",}';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(result!.q1, 'hello');
  });

  it('should handle markdown bold in values', () => {
    const payload = '{"q1":"**Alice**","q2":"world"}';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(result!.q1, 'Alice');
  });

  it('should handle single quotes', () => {
    const payload = "{'q1':'hello','q2':'world'}";
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(result!.q1, 'hello');
  });

  it('should handle Chinese text in values', () => {
    const payload = '{"q1":"小明","q2":"助手","q3":"简洁直接"}';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(result!.q1, '小明');
    assert.equal(result!.q3, '简洁直接');
  });

  it('should extract via regex as last resort for heavily malformed JSON', () => {
    // Simulate AI output with mixed formatting issues
    const payload = `{
  "q1": "Alice",
  "q2": "Claude",
  "q3": "concise and direct"
  "q4": "minimal interruptions",
}`;
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(result!.q1, 'Alice');
    assert.equal(result!.q2, 'Claude');
  });

  it('should return null for completely unparseable content', () => {
    const payload = 'this is not json at all';
    assert.equal(parseCompletionPayload(payload), null);
  });

  it('should handle full 13-question payload with free-text answers', () => {
    const payload = '{"q1":"小明","q2":"助手","q3":"简洁直接","q4":"主动建议","q5":"不要删除文件、不要发送邮件、不要修改系统设置","q6":"学Rust、发布产品、多读书","q7":"列表","q8":"偏好和目标","q9":"密码和私钥","q10":"读README、看issues、了解结构","q11":"按项目","q12":"Inbox","q13":"移到archive文件夹"}';
    const result = parseCompletionPayload(payload);
    assert.ok(result);
    assert.equal(Object.keys(result!).length, 13);
    assert.equal(result!.q1, '小明');
    assert.equal(result!.q13, '移到archive文件夹');
  });
});

// ─── End-to-End extractCompletion ────────────────────────────────

describe('extractCompletion (end-to-end)', () => {
  it('should extract and parse a valid onboarding completion', () => {
    const content = `Here is your summary:

\`\`\`onboarding-complete
{"q1":"Alice","q2":"Claude","q3":"concise"}
\`\`\`

Done!`;
    const result = extractCompletion(content);
    assert.ok(result);
    assert.equal(result!.type, 'onboarding');
    assert.equal(result!.answers.q1, 'Alice');
  });

  it('should extract and parse a valid checkin completion', () => {
    const content = '```checkin-complete\n{"q1":"coded all day","q2":"no changes","q3":"remember to review PR"}\n```';
    const result = extractCompletion(content);
    assert.ok(result);
    assert.equal(result!.type, 'checkin');
    assert.equal(result!.answers.q1, 'coded all day');
  });

  it('should return null when fence exists but JSON is completely broken', () => {
    const content = '```onboarding-complete\nthis is not json\n```';
    assert.equal(extractCompletion(content), null);
  });

  it('should handle CRLF + trailing comma + markdown bold combined', () => {
    const content = '```onboarding-complete\r\n{"q1":"**Alice**","q2":"Claude",}\r\n```';
    const result = extractCompletion(content);
    assert.ok(result);
    assert.equal(result!.answers.q1, 'Alice');
  });

  it('should handle fence with answers containing commas and colons', () => {
    const content = '```onboarding-complete\n{"q1":"Alice, Bob","q5":"no spam, no ads, no tracking: ever"}\n```';
    const result = extractCompletion(content);
    assert.ok(result);
    assert.equal(result!.answers.q1, 'Alice, Bob');
    assert.ok(result!.answers.q5.includes('no tracking'));
  });
});

// ─── Integration with workspace state ────────────────────────────

describe('onboarding completion + workspace state integration', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  // Set a temp data dir before importing db module
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-int-test-'));
  process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

  const {
    initializeWorkspace,
    loadState,
    saveState,
    needsDailyCheckIn,
  } = require('../../lib/assistant-workspace') as typeof import('../../lib/assistant-workspace');
  const { getLocalDateString } = require('../../lib/utils') as typeof import('../../lib/utils');
  /* eslint-enable @typescript-eslint/no-require-imports */

  it('onboarding success should set onboardingComplete=true and lastHeartbeatDate=today', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onb-state-'));
    initializeWorkspace(workDir);

    // Simulate what onboarding route does
    const today = getLocalDateString();
    const state = loadState(workDir);
    state.onboardingComplete = true;
    state.lastHeartbeatDate = today;
    state.schemaVersion = 5;
    state.heartbeatEnabled = true;
    saveState(workDir, state);

    const reloaded = loadState(workDir);
    assert.equal(reloaded.onboardingComplete, true);
    assert.equal(reloaded.lastHeartbeatDate, today);
    assert.equal(needsDailyCheckIn(reloaded), false, 'Should not need check-in on onboarding day');

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('after onboarding, next day should need check-in', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onb-checkin-'));
    initializeWorkspace(workDir);

    const state = loadState(workDir);
    state.onboardingComplete = true;
    state.lastHeartbeatDate = '2020-01-01'; // yesterday or earlier
    state.lastCheckInDate = '2020-01-01'; // keep deprecated field for needsDailyCheckIn compat
    state.schemaVersion = 5;
    state.heartbeatEnabled = true;
    state.dailyCheckInEnabled = true; // keep deprecated field for needsDailyCheckIn compat
    saveState(workDir, state);

    const reloaded = loadState(workDir);
    assert.equal(needsDailyCheckIn(reloaded), true);

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('re-entering session after onboarding should not re-trigger', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onb-reenter-'));
    initializeWorkspace(workDir);

    const today = getLocalDateString();
    const state = loadState(workDir);
    state.onboardingComplete = true;
    state.lastHeartbeatDate = today;
    saveState(workDir, state);

    // Simulate re-entering: check trigger conditions
    const reloaded = loadState(workDir);
    const needsOnboarding = !reloaded.onboardingComplete;
    const needsCheckIn = reloaded.onboardingComplete && reloaded.lastHeartbeatDate !== today;
    assert.equal(needsOnboarding, false);
    assert.equal(needsCheckIn, false);

    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
