/**
 * Unit tests for claude-session-parser.ts
 *
 * Tests the JSONL parsing logic for Claude Code CLI session files.
 * Uses Node's built-in test runner (zero dependencies).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

// We test the parser functions by creating temporary JSONL files
// that mimic Claude Code's session storage format.

const TEST_DIR = path.join(os.tmpdir(), `codepilot-test-sessions-${Date.now()}`);
const PROJECTS_DIR = path.join(TEST_DIR, '.claude', 'projects');

// Helper to create a JSONL session file
function createSessionFile(
  projectDirName: string,
  sessionId: string,
  lines: object[],
): string {
  const dir = path.join(PROJECTS_DIR, projectDirName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ==========================================
// Test data factories
// ==========================================

function makeQueueEntry(sessionId: string, operation: string = 'dequeue') {
  return {
    type: 'queue-operation',
    operation,
    timestamp: '2026-01-15T10:00:00.000Z',
    sessionId,
  };
}

function makeUserEntry(opts: {
  sessionId: string;
  content: string;
  parentUuid?: string | null;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
}) {
  return {
    parentUuid: opts.parentUuid ?? null,
    isSidechain: false,
    userType: 'external',
    cwd: opts.cwd || '/home/user/myproject',
    sessionId: opts.sessionId,
    version: opts.version || '2.1.34',
    gitBranch: opts.gitBranch || 'main',
    type: 'user',
    message: {
      role: 'user',
      content: opts.content,
    },
    uuid: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: opts.timestamp || '2026-01-15T10:00:01.000Z',
    permissionMode: 'default',
  };
}

function makeAssistantEntry(opts: {
  sessionId: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string; is_error?: boolean }>;
  parentUuid: string;
  timestamp?: string;
  model?: string;
}) {
  return {
    parentUuid: opts.parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/user/myproject',
    sessionId: opts.sessionId,
    version: '2.1.34',
    gitBranch: 'main',
    message: {
      content: opts.content,
      id: `req-${Date.now()}`,
      model: opts.model || 'claude-sonnet-4-20250514',
      role: 'assistant',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
    type: 'assistant',
    uuid: `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: opts.timestamp || '2026-01-15T10:00:02.000Z',
  };
}

// ==========================================
// Tests
// ==========================================

// We need to dynamically import the parser because it uses @/lib path aliases.
// Instead, we'll test the core logic by requiring the compiled output or
// using tsx to run these tests.

// Since the project uses path aliases (@/), we import via a relative path
// that tsx can resolve with the project's tsconfig.
const parserPath = pathToFileURL(path.resolve(__dirname, '../../lib/claude-session-parser.ts')).href;

describe('claude-session-parser', () => {
  // We'll dynamically import the parser module
  let parser: typeof import('../../lib/claude-session-parser');

  before(async () => {
    // Set HOME/USERPROFILE to our test directory so the parser looks for sessions there
    process.env.HOME = TEST_DIR;
    process.env.USERPROFILE = TEST_DIR;

    // Dynamic import - tsx handles the TypeScript + path alias resolution
    parser = await import(parserPath);
  });

  after(() => {
    // Clean up test directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    // Restore HOME/USERPROFILE
    process.env.HOME = os.homedir();
    process.env.USERPROFILE = os.homedir();
  });

  describe('decodeProjectPath', () => {
    it('should decode a simple project path', () => {
      assert.equal(parser.decodeProjectPath('-root-myproject'), '/root/myproject');
    });

    it('should decode a deeper project path', () => {
      assert.equal(
        parser.decodeProjectPath('-Users-john-projects-myapp'),
        '/Users/john/projects/myapp',
      );
    });

    it('should return as-is if no leading dash', () => {
      assert.equal(parser.decodeProjectPath('some-dir'), 'some-dir');
    });
  });

  describe('getClaudeProjectsDir', () => {
    it('should return path under HOME/.claude/projects', () => {
      const dir = parser.getClaudeProjectsDir();
      assert.ok(dir.endsWith(path.join('.claude', 'projects')));
    });
  });

  describe('listClaudeSessions', () => {
    it('should return empty array when no sessions exist', () => {
      // Projects dir exists but is empty
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
      const sessions = parser.listClaudeSessions();
      assert.equal(sessions.length, 0);
    });

    it('should skip sessions with only queue-operation entries', () => {
      const sessionId = 'empty-session-001';
      createSessionFile('-home-user-emptyproject', sessionId, [
        makeQueueEntry(sessionId),
      ]);

      const sessions = parser.listClaudeSessions();
      const found = sessions.find(s => s.sessionId === sessionId);
      assert.equal(found, undefined, 'Should skip session with no messages');
    });

    it('should list a session with user and assistant messages', () => {
      const sessionId = 'test-session-001';
      const userEntry = makeUserEntry({
        sessionId,
        content: 'Hello, can you help me?',
        cwd: '/home/user/myproject',
        gitBranch: 'feature-branch',
        version: '2.1.34',
      });

      createSessionFile('-home-user-myproject', sessionId, [
        makeQueueEntry(sessionId),
        userEntry,
        makeAssistantEntry({
          sessionId,
          content: [{ type: 'text', text: 'Of course! How can I help you?' }],
          parentUuid: userEntry.uuid,
        }),
      ]);

      const sessions = parser.listClaudeSessions();
      const found = sessions.find(s => s.sessionId === sessionId);
      assert.ok(found, 'Session should be listed');
      assert.equal(found!.projectName, 'myproject');
      assert.equal(found!.cwd, '/home/user/myproject');
      assert.equal(found!.gitBranch, 'feature-branch');
      assert.equal(found!.version, '2.1.34');
      assert.equal(found!.preview, 'Hello, can you help me?');
      assert.equal(found!.userMessageCount, 1);
      assert.equal(found!.assistantMessageCount, 1);
    });

    it('should sort sessions by most recent first', () => {
      const oldSessionId = 'old-session-001';
      const newSessionId = 'new-session-001';

      createSessionFile('-home-user-oldproject', oldSessionId, [
        makeQueueEntry(oldSessionId),
        makeUserEntry({
          sessionId: oldSessionId,
          content: 'Old message',
          timestamp: '2025-01-01T00:00:00.000Z',
        }),
      ]);

      createSessionFile('-home-user-newproject', newSessionId, [
        makeQueueEntry(newSessionId),
        makeUserEntry({
          sessionId: newSessionId,
          content: 'New message',
          timestamp: '2026-06-01T00:00:00.000Z',
        }),
      ]);

      const sessions = parser.listClaudeSessions();
      const oldIdx = sessions.findIndex(s => s.sessionId === oldSessionId);
      const newIdx = sessions.findIndex(s => s.sessionId === newSessionId);
      assert.ok(newIdx < oldIdx, 'Newer session should come first');
    });
  });

  describe('parseClaudeSession', () => {
    it('should return null for non-existent session', () => {
      const result = parser.parseClaudeSession('non-existent-session-id');
      assert.equal(result, null);
    });

    it('should parse a simple text conversation', () => {
      const sessionId = 'parse-text-001';
      const userEntry = makeUserEntry({
        sessionId,
        content: 'What is TypeScript?',
        cwd: '/home/user/tsproject',
      });

      createSessionFile('-home-user-tsproject', sessionId, [
        makeQueueEntry(sessionId),
        userEntry,
        makeAssistantEntry({
          sessionId,
          content: [{ type: 'text', text: 'TypeScript is a typed superset of JavaScript.' }],
          parentUuid: userEntry.uuid,
        }),
      ]);

      const result = parser.parseClaudeSession(sessionId);
      assert.ok(result, 'Should return parsed session');
      assert.equal(result!.messages.length, 2);

      // Check user message
      const userMsg = result!.messages[0];
      assert.equal(userMsg.role, 'user');
      assert.equal(userMsg.content, 'What is TypeScript?');
      assert.equal(userMsg.hasToolBlocks, false);

      // Check assistant message
      const assistantMsg = result!.messages[1];
      assert.equal(assistantMsg.role, 'assistant');
      assert.equal(assistantMsg.content, 'TypeScript is a typed superset of JavaScript.');
      assert.equal(assistantMsg.hasToolBlocks, false);
    });

    it('should parse assistant messages with tool_use blocks', () => {
      const sessionId = 'parse-tools-001';
      const userEntry = makeUserEntry({
        sessionId,
        content: 'Read the package.json file',
        cwd: '/home/user/toolproject',
      });

      createSessionFile('-home-user-toolproject', sessionId, [
        makeQueueEntry(sessionId),
        userEntry,
        makeAssistantEntry({
          sessionId,
          content: [
            { type: 'text', text: "I'll read the file for you." },
            {
              type: 'tool_use',
              id: 'tool-001',
              name: 'Read',
              input: { file_path: '/home/user/toolproject/package.json' },
            },
          ],
          parentUuid: userEntry.uuid,
        }),
      ]);

      const result = parser.parseClaudeSession(sessionId);
      assert.ok(result);
      assert.equal(result!.messages.length, 2);

      const assistantMsg = result!.messages[1];
      assert.equal(assistantMsg.role, 'assistant');
      assert.equal(assistantMsg.hasToolBlocks, true);
      assert.equal(assistantMsg.contentBlocks.length, 2);
      assert.equal(assistantMsg.contentBlocks[0].type, 'text');
      assert.equal(assistantMsg.contentBlocks[1].type, 'tool_use');
      if (assistantMsg.contentBlocks[1].type === 'tool_use') {
        assert.equal(assistantMsg.contentBlocks[1].name, 'Read');
        assert.equal(assistantMsg.contentBlocks[1].id, 'tool-001');
      }
    });

    it('should parse assistant messages with tool_result blocks', () => {
      const sessionId = 'parse-results-001';
      const userEntry = makeUserEntry({
        sessionId,
        content: 'Show me the file',
        cwd: '/home/user/resultproject',
      });

      createSessionFile('-home-user-resultproject', sessionId, [
        makeQueueEntry(sessionId),
        userEntry,
        makeAssistantEntry({
          sessionId,
          content: [
            { type: 'text', text: 'Here is the content.' },
            {
              type: 'tool_use',
              id: 'tool-002',
              name: 'Read',
              input: { file_path: 'test.txt' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-002',
              content: 'file content here',
              is_error: false,
            },
          ],
          parentUuid: userEntry.uuid,
        }),
      ]);

      const result = parser.parseClaudeSession(sessionId);
      assert.ok(result);

      const assistantMsg = result!.messages[1];
      assert.equal(assistantMsg.hasToolBlocks, true);
      assert.equal(assistantMsg.contentBlocks.length, 3);
      assert.equal(assistantMsg.contentBlocks[2].type, 'tool_result');
      if (assistantMsg.contentBlocks[2].type === 'tool_result') {
        assert.equal(assistantMsg.contentBlocks[2].tool_use_id, 'tool-002');
        assert.equal(assistantMsg.contentBlocks[2].content, 'file content here');
        assert.equal(assistantMsg.contentBlocks[2].is_error, false);
      }
    });

    it('should parse multi-turn conversations', () => {
      const sessionId = 'parse-multi-001';
      const user1 = makeUserEntry({
        sessionId,
        content: 'First question',
        timestamp: '2026-01-15T10:00:01.000Z',
        cwd: '/home/user/multiproject',
      });
      const asst1 = makeAssistantEntry({
        sessionId,
        content: [{ type: 'text', text: 'First answer' }],
        parentUuid: user1.uuid,
        timestamp: '2026-01-15T10:00:02.000Z',
      });
      const user2 = makeUserEntry({
        sessionId,
        content: 'Follow-up question',
        parentUuid: asst1.uuid,
        timestamp: '2026-01-15T10:00:03.000Z',
        cwd: '/home/user/multiproject',
      });
      const asst2 = makeAssistantEntry({
        sessionId,
        content: [{ type: 'text', text: 'Follow-up answer' }],
        parentUuid: user2.uuid,
        timestamp: '2026-01-15T10:00:04.000Z',
      });

      createSessionFile('-home-user-multiproject', sessionId, [
        makeQueueEntry(sessionId),
        user1,
        asst1,
        user2,
        asst2,
      ]);

      const result = parser.parseClaudeSession(sessionId);
      assert.ok(result);
      assert.equal(result!.messages.length, 4);
      assert.equal(result!.messages[0].role, 'user');
      assert.equal(result!.messages[0].content, 'First question');
      assert.equal(result!.messages[1].role, 'assistant');
      assert.equal(result!.messages[1].content, 'First answer');
      assert.equal(result!.messages[2].role, 'user');
      assert.equal(result!.messages[2].content, 'Follow-up question');
      assert.equal(result!.messages[3].role, 'assistant');
      assert.equal(result!.messages[3].content, 'Follow-up answer');
    });

    it('should handle empty assistant content gracefully', () => {
      const sessionId = 'parse-empty-asst-001';
      const userEntry = makeUserEntry({
        sessionId,
        content: 'Test message',
        cwd: '/home/user/emptyasstproject',
      });

      createSessionFile('-home-user-emptyasstproject', sessionId, [
        makeQueueEntry(sessionId),
        userEntry,
        makeAssistantEntry({
          sessionId,
          content: [], // Empty content
          parentUuid: userEntry.uuid,
        }),
      ]);

      const result = parser.parseClaudeSession(sessionId);
      assert.ok(result);
      // Empty assistant message should be skipped
      assert.equal(result!.messages.length, 1);
      assert.equal(result!.messages[0].role, 'user');
    });

    it('should truncate preview to 120 characters', () => {
      const sessionId = 'parse-long-preview-001';
      const longMessage = 'A'.repeat(200);
      createSessionFile('-home-user-longproject', sessionId, [
        makeQueueEntry(sessionId),
        makeUserEntry({
          sessionId,
          content: longMessage,
          cwd: '/home/user/longproject',
        }),
      ]);

      const sessions = parser.listClaudeSessions();
      const found = sessions.find(s => s.sessionId === sessionId);
      assert.ok(found);
      assert.equal(found!.preview.length, 120);
    });

    it('should extract session info correctly', () => {
      const sessionId = 'parse-info-001';
      createSessionFile('-home-user-infoproject', sessionId, [
        makeQueueEntry(sessionId),
        makeUserEntry({
          sessionId,
          content: 'Test',
          cwd: '/home/user/infoproject',
          gitBranch: 'develop',
          version: '3.0.0',
          timestamp: '2026-03-15T14:30:00.000Z',
        }),
        makeAssistantEntry({
          sessionId,
          content: [{ type: 'text', text: 'Reply' }],
          parentUuid: 'some-uuid',
          timestamp: '2026-03-15T14:30:05.000Z',
        }),
      ]);

      const result = parser.parseClaudeSession(sessionId);
      assert.ok(result);
      assert.equal(result!.info.sessionId, sessionId);
      assert.equal(result!.info.cwd, '/home/user/infoproject');
      assert.equal(result!.info.gitBranch, 'develop');
      assert.equal(result!.info.version, '3.0.0');
      assert.equal(result!.info.userMessageCount, 1);
      assert.equal(result!.info.assistantMessageCount, 1);
      assert.equal(result!.info.createdAt, '2026-01-15T10:00:00.000Z'); // queue-operation timestamp
      assert.equal(result!.info.updatedAt, '2026-03-15T14:30:05.000Z');
    });

    it('should handle malformed JSONL lines gracefully', () => {
      const sessionId = 'parse-malformed-001';
      const dir = path.join(PROJECTS_DIR, '-home-user-malformedproject');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${sessionId}.jsonl`);

      const lines = [
        JSON.stringify(makeQueueEntry(sessionId)),
        'this is not valid json',
        JSON.stringify(makeUserEntry({
          sessionId,
          content: 'Valid message after bad line',
          cwd: '/home/user/malformedproject',
        })),
        '{"incomplete": true',
      ];
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const result = parser.parseClaudeSession(sessionId);
      assert.ok(result, 'Should handle malformed lines gracefully');
      assert.equal(result!.messages.length, 1);
      assert.equal(result!.messages[0].content, 'Valid message after bad line');
    });
  });
});
