/**
 * Unit tests for assistant workspace.
 *
 * Run with: npx tsx --test src/__tests__/unit/assistant-workspace.test.ts
 *
 * Tests verify:
 * 1. Auto-trigger: onboarding detects correctly for new workspace
 * 2. Input focus fallback: hookTriggeredSessionId prevents repeat
 * 3. Daily check-in: shouldRunHeartbeat respects onboarding state (uses heartbeat fields)
 * 4. Workspace prompt scoping: only assistant project sessions get prompts
 * 5. V2: Daily memory write/load, v1→v2 migration, budget-aware prompt assembly
 */

import '../db-isolation.setup';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getLocalDateString } from '@/lib/utils';

// Set a temp data dir before importing db module
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-workspace-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  initializeWorkspace,
  loadState,
  saveState,
  shouldRunHeartbeat,
  loadWorkspaceFiles,
  inspectInstructionMirrors,
  reconcileInstructionMirrors,
  shouldOmitCanonicalRules,
  assembleWorkspacePrompt,
  generateDirectoryDocs,
  ensureDailyDir,
  writeDailyMemory,
  loadDailyMemories,
  migrateStateV1ToV2,
  generateRootDocs,
} = require('../../lib/assistant-workspace') as typeof import('../../lib/assistant-workspace');

const { createSession, getLatestSessionByWorkingDirectory, closeDb } = require('../../lib/db') as typeof import('../../lib/db');

describe('Assistant Workspace', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-ws-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('initializeWorkspace creates state.json', () => {
    it('should create .assistant/state.json on init', () => {
      initializeWorkspace(workDir);
      const statePath = path.join(workDir, '.assistant', 'state.json');
      assert.ok(fs.existsSync(statePath), 'state.json should exist after init');

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(state.onboardingComplete, false);
      assert.equal(state.lastHeartbeatDate, null);
      assert.equal(state.schemaVersion, 5);
    });

    it('creates neutral templates plus Claude Code and Codex discovery mirrors', () => {
      initializeWorkspace(workDir);
      assert.ok(fs.existsSync(path.join(workDir, 'instructions.md')));
      assert.ok(fs.existsSync(path.join(workDir, 'CLAUDE.md')));
      assert.ok(fs.existsSync(path.join(workDir, 'AGENTS.md')));
      assert.ok(fs.existsSync(path.join(workDir, 'soul.md')));
      assert.ok(fs.existsSync(path.join(workDir, 'user.md')));
      assert.ok(fs.existsSync(path.join(workDir, 'memory.md')));
      const canonical = fs.readFileSync(path.join(workDir, 'instructions.md'), 'utf8');
      assert.ok(fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8').endsWith(canonical));
      assert.ok(fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8').endsWith(canonical));
    });

    it('keeps a legacy rules file as the single source instead of creating a duplicate', () => {
      fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), '# Existing rules\n', 'utf-8');
      initializeWorkspace(workDir);

      assert.equal(fs.existsSync(path.join(workDir, 'instructions.md')), false);
      assert.equal(fs.existsSync(path.join(workDir, 'AGENTS.md')), false);
      const files = loadWorkspaceFiles(workDir);
      assert.equal(files.claude, '# Existing rules\n');
      assert.equal(files.rulesFileNativeClaude, true);
    });

    it('marks clean managed mirrors as native discovery owners', () => {
      initializeWorkspace(workDir);
      const files = loadWorkspaceFiles(workDir);
      assert.equal(files.rulesFileNativeClaude, true);
      assert.equal(files.rulesFileNativeCodex, true);
      assert.deepEqual(files.rulesMirrorConflicts, []);
    });

    it('updates both untouched mirrors when instructions.md changes', () => {
      initializeWorkspace(workDir);
      fs.writeFileSync(path.join(workDir, 'instructions.md'), '# Updated canonical rules\n', 'utf8');

      const result = reconcileInstructionMirrors(workDir);
      assert.deepEqual(result.conflicts, []);
      assert.deepEqual(result.updated.map((file) => path.basename(file)).sort(), ['AGENTS.md', 'CLAUDE.md']);
      for (const fileName of ['CLAUDE.md', 'AGENTS.md']) {
        assert.ok(
          fs.readFileSync(path.join(workDir, fileName), 'utf8').endsWith('# Updated canonical rules\n'),
        );
      }
    });

    it('freezes the mirror pair when one managed file was edited by the user', () => {
      initializeWorkspace(workDir);
      const agentsBefore = fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8');
      fs.appendFileSync(path.join(workDir, 'CLAUDE.md'), '\n# User-owned change\n', 'utf8');
      fs.writeFileSync(path.join(workDir, 'instructions.md'), '# New canonical content\n', 'utf8');

      const result = reconcileInstructionMirrors(workDir);
      assert.deepEqual(result.conflicts, ['CLAUDE.md']);
      assert.match(fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8'), /User-owned change/);
      assert.equal(fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8'), agentsBefore);
      assert.equal(loadWorkspaceFiles(workDir).rulesFileNativeClaude, false);
      assert.equal(loadWorkspaceFiles(workDir).rulesFileNativeCodex, false);
    });

    it('never creates the other mirror beside an unmanaged compatibility file', () => {
      fs.writeFileSync(path.join(workDir, 'instructions.md'), '# Canonical\n', 'utf8');
      fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), '# Existing custom Claude rules\n', 'utf8');

      const result = reconcileInstructionMirrors(workDir);
      assert.deepEqual(result.conflicts, ['CLAUDE.md']);
      assert.equal(fs.existsSync(path.join(workDir, 'AGENTS.md')), false);
      assert.equal(inspectInstructionMirrors(workDir).mirrors[0].status, 'unmanaged');
    });

    it('accepts a symlink to canonical but never replaces a foreign symlink', {
      skip: process.platform === 'win32' ? 'ordinary Windows users cannot create file symlinks' : false,
    }, () => {
      fs.writeFileSync(path.join(workDir, 'instructions.md'), '# Canonical\n', 'utf8');
      fs.symlinkSync('instructions.md', path.join(workDir, 'CLAUDE.md'));
      fs.writeFileSync(path.join(workDir, 'foreign.md'), '# Foreign\n', 'utf8');
      fs.symlinkSync('foreign.md', path.join(workDir, 'AGENTS.md'));

      const result = reconcileInstructionMirrors(workDir);
      assert.deepEqual(result.conflicts, ['AGENTS.md']);
      assert.equal(fs.readlinkSync(path.join(workDir, 'CLAUDE.md')), 'instructions.md');
      assert.equal(fs.readlinkSync(path.join(workDir, 'AGENTS.md')), 'foreign.md');
    });

    it('should create V2 directories (memory/daily, Inbox)', () => {
      initializeWorkspace(workDir);
      assert.ok(fs.existsSync(path.join(workDir, 'memory', 'daily')));
      assert.ok(fs.existsSync(path.join(workDir, 'Inbox')));
    });
  });

  describe('onboarding auto-trigger detection', () => {
    it('should detect onboarding needed for fresh workspace', () => {
      initializeWorkspace(workDir);
      const state = loadState(workDir);
      assert.equal(state.onboardingComplete, false);
      // shouldRunHeartbeat should return false when onboarding not done
      assert.equal(shouldRunHeartbeat(state), false);
    });

    it('should not need onboarding after completion', () => {
      initializeWorkspace(workDir);
      const state = loadState(workDir);
      state.onboardingComplete = true;
      state.lastHeartbeatDate = getLocalDateString();
      saveState(workDir, state);

      const reloaded = loadState(workDir);
      assert.equal(reloaded.onboardingComplete, true);
    });
  });

  describe('hookTriggeredSessionId prevents repeat', () => {
    it('should persist hookTriggeredSessionId', () => {
      initializeWorkspace(workDir);
      const state = loadState(workDir);
      state.hookTriggeredSessionId = 'session-123';
      saveState(workDir, state);

      const reloaded = loadState(workDir);
      assert.equal(reloaded.hookTriggeredSessionId, 'session-123');
    });

    it('should allow different session to trigger', () => {
      initializeWorkspace(workDir);
      const state = loadState(workDir);
      state.hookTriggeredSessionId = 'session-123';
      saveState(workDir, state);

      const reloaded = loadState(workDir);
      // A different session ID should not match
      assert.notEqual(reloaded.hookTriggeredSessionId, 'session-456');
    });
  });

  describe('daily check-in respects onboarding state', () => {
    it('should not trigger check-in if onboarding not complete', () => {
      const state = { onboardingComplete: false, lastHeartbeatDate: null, lastCheckInDate: null, heartbeatEnabled: false, schemaVersion: 5 };
      assert.equal(shouldRunHeartbeat(state), false);
    });

    it('should trigger check-in if onboarding done and no check-in today', () => {
      const state = { onboardingComplete: true, lastHeartbeatDate: '2020-01-01', lastCheckInDate: '2020-01-01', heartbeatEnabled: true, dailyCheckInEnabled: true, schemaVersion: 5 };
      assert.equal(shouldRunHeartbeat(state), true);
    });

    it('should not trigger check-in if already done today', () => {
      const today = getLocalDateString();
      const state = { onboardingComplete: true, lastHeartbeatDate: today, lastCheckInDate: today, heartbeatEnabled: true, dailyCheckInEnabled: true, schemaVersion: 5 };
      assert.equal(shouldRunHeartbeat(state), false);
    });

    it('onboarding day should skip daily check-in (lastHeartbeatDate set)', () => {
      const today = getLocalDateString();
      const state = { onboardingComplete: true, lastHeartbeatDate: today, lastCheckInDate: today, heartbeatEnabled: true, dailyCheckInEnabled: true, schemaVersion: 5 };
      assert.equal(shouldRunHeartbeat(state), false);
    });

    it('should not trigger check-in if heartbeatEnabled is not set (default off)', () => {
      const state = { onboardingComplete: true, lastHeartbeatDate: '2020-01-01', lastCheckInDate: '2020-01-01', heartbeatEnabled: false, schemaVersion: 5 };
      assert.equal(shouldRunHeartbeat(state), false);
    });
  });

  describe('workspace prompt scoping', () => {
    it('should generate prompt for workspace files', () => {
      initializeWorkspace(workDir);
      // Write some content
      fs.writeFileSync(path.join(workDir, 'soul.md'), '# Soul\nI am helpful.', 'utf-8');

      const files = loadWorkspaceFiles(workDir);
      const prompt = assembleWorkspacePrompt(files);

      assert.ok(prompt.includes('<assistant-workspace>'));
      assert.ok(prompt.includes('I am helpful'));
    });

    it('should return empty prompt for empty workspace', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-ws-'));
      const files = loadWorkspaceFiles(emptyDir);
      const prompt = assembleWorkspacePrompt(files);
      assert.equal(prompt, '');
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('session reuse for daily check-in', () => {
    it('should find latest session by working directory', () => {
      // Create a session for the directory
      const s1 = createSession('First', '', undefined, workDir);

      const latest = getLatestSessionByWorkingDirectory(workDir);
      assert.ok(latest, 'Should find a session');
      assert.equal(latest!.id, s1.id, 'Should return the session for this directory');
      assert.equal(latest!.working_directory, workDir);
    });

    it('should return undefined for directory with no sessions', () => {
      const result = getLatestSessionByWorkingDirectory('/nonexistent/dir');
      assert.equal(result, undefined);
    });
  });

  describe('generateDirectoryDocs produces README.ai.md and PATH.ai.md', () => {
    it('should generate both files for subdirectories', () => {
      // Create a subdirectory with some files
      const subDir = path.join(workDir, 'notes');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'todo.txt'), 'buy milk', 'utf-8');
      fs.writeFileSync(path.join(subDir, 'ideas.md'), '# Ideas', 'utf-8');

      const generated = generateDirectoryDocs(workDir);

      assert.ok(generated.length >= 2, 'Should generate at least 2 files');

      const readmePath = path.join(subDir, 'README.ai.md');
      const pathFilePath = path.join(subDir, 'PATH.ai.md');

      assert.ok(fs.existsSync(readmePath), 'README.ai.md should exist');
      assert.ok(fs.existsSync(pathFilePath), 'PATH.ai.md should exist');

      const readmeContent = fs.readFileSync(readmePath, 'utf-8');
      assert.ok(readmeContent.includes('<!-- AI_GENERATED_START -->'));
      assert.ok(readmeContent.includes('ideas.md'));

      const pathContent = fs.readFileSync(pathFilePath, 'utf-8');
      assert.ok(pathContent.includes('<!-- AI_GENERATED_START -->'));
      assert.ok(pathContent.includes('Path Index'));
    });
  });

  // ===== V2 Tests =====

  describe('daily memory write and load', () => {
    it('should write and read daily memory', () => {
      initializeWorkspace(workDir);
      const today = '2024-03-06';
      const content = '# Work Log\nDid some coding.';

      writeDailyMemory(workDir, today, content);

      const dailyPath = path.join(workDir, 'memory', 'daily', `${today}.md`);
      assert.ok(fs.existsSync(dailyPath), 'Daily memory file should exist');

      const read = fs.readFileSync(dailyPath, 'utf-8');
      assert.equal(read, content);
    });

    it('should load most recent daily memories', () => {
      initializeWorkspace(workDir);
      writeDailyMemory(workDir, '2024-03-04', 'Day 1');
      writeDailyMemory(workDir, '2024-03-05', 'Day 2');
      writeDailyMemory(workDir, '2024-03-06', 'Day 3');

      const memories = loadDailyMemories(workDir, 2);
      assert.equal(memories.length, 2);
      assert.equal(memories[0].date, '2024-03-06');
      assert.equal(memories[1].date, '2024-03-05');
    });

    it('should return empty array for no daily memories', () => {
      initializeWorkspace(workDir);
      const memories = loadDailyMemories(workDir, 2);
      assert.equal(memories.length, 0);
    });
  });

  describe('v1 to v2 migration', () => {
    it('should migrate v1 state to v2', () => {
      // Create a v1-style workspace
      const stateDir = path.join(workDir, '.assistant');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({ onboardingComplete: true, lastCheckInDate: '2024-01-01', schemaVersion: 1 }),
        'utf-8'
      );

      migrateStateV1ToV2(workDir);

      const state = loadState(workDir);
      assert.equal(state.schemaVersion, 5);
      assert.ok(fs.existsSync(path.join(workDir, 'memory', 'daily')));
      assert.ok(fs.existsSync(path.join(workDir, 'Inbox')));
    });

    it('should not re-migrate v5 state', () => {
      initializeWorkspace(workDir);
      const state = loadState(workDir);
      assert.equal(state.schemaVersion, 5);

      // Should not throw or change anything
      migrateStateV1ToV2(workDir);
      const reloaded = loadState(workDir);
      assert.equal(reloaded.schemaVersion, 5);
    });
  });

  describe('budget-aware prompt assembly', () => {
    it('can omit only Claude-native rules while retaining neutral identity files', () => {
      fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), '# Native Claude rules', 'utf-8');
      fs.writeFileSync(path.join(workDir, 'soul.md'), '# Soul\nKeep this identity.', 'utf-8');
      const files = loadWorkspaceFiles(workDir);
      const prompt = assembleWorkspacePrompt(files, undefined, { omitRules: true });
      assert.ok(!prompt.includes('Native Claude rules'));
      assert.ok(prompt.includes('Keep this identity.'));
    });

    it('renders canonical rules under a framework-neutral prompt role', () => {
      initializeWorkspace(workDir);
      const prompt = assembleWorkspacePrompt(loadWorkspaceFiles(workDir));
      assert.match(prompt, /<instructions>[\s\S]*?<\/instructions>/);
      assert.doesNotMatch(prompt, /<claude>/);
    });

    it('keeps canonical rules in Codex developerInstructions even with a synced AGENTS.md mirror', () => {
      initializeWorkspace(workDir);
      fs.writeFileSync(path.join(workDir, 'instructions.md'), '# Codex delivery marker\n', 'utf8');
      reconcileInstructionMirrors(workDir);
      const files = loadWorkspaceFiles(workDir);

      assert.equal(files.rulesFileNativeCodex, true);
      assert.equal(shouldOmitCanonicalRules('codex_runtime', files), false);
      const prompt = assembleWorkspacePrompt(files, undefined, {
        omitRules: shouldOmitCanonicalRules('codex_runtime', files),
      });
      assert.match(prompt, /Codex delivery marker/);
    });

    it('injects canonical rules during a native mirror conflict and preserves the user mirror', () => {
      initializeWorkspace(workDir);
      fs.appendFileSync(path.join(workDir, 'CLAUDE.md'), '\n# User conflict rule\n', 'utf8');
      const files = loadWorkspaceFiles(workDir);

      assert.equal(shouldOmitCanonicalRules('claude_code', files), false);
      assert.match(
        assembleWorkspacePrompt(files, undefined, {
          omitRules: shouldOmitCanonicalRules('claude_code', files),
        }),
        /Memory Rules/,
      );
      assert.match(fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8'), /User conflict rule/);
    });

    it('treats CRLF-only mirror rewrites as synced rather than a user-content conflict', () => {
      initializeWorkspace(workDir);
      for (const fileName of ['CLAUDE.md', 'AGENTS.md']) {
        const filePath = path.join(workDir, fileName);
        fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace(/\n/g, '\r\n'), 'utf8');
      }

      const inspection = inspectInstructionMirrors(workDir);
      assert.deepEqual(inspection.conflicts, []);
      assert.ok(inspection.mirrors.every((mirror) => mirror.status === 'synced'));
    });

    it('should only include identity files in prompt (memory accessed via MCP)', () => {
      initializeWorkspace(workDir);
      fs.writeFileSync(path.join(workDir, 'soul.md'), '# Soul\nI am helpful.', 'utf-8');
      writeDailyMemory(workDir, '2024-03-06', '# Today\nDid coding.');

      const files = loadWorkspaceFiles(workDir);
      const prompt = assembleWorkspacePrompt(files);

      assert.ok(prompt.includes('<assistant-workspace>'));
      assert.ok(prompt.includes('I am helpful'), 'soul.md should be in prompt');
      // Daily memories are no longer in system prompt — accessed via codepilot_memory_search MCP
      assert.ok(!prompt.includes('Did coding'), 'daily memories should NOT be in prompt');
    });

    it('should not include retrieval results in prompt (accessed via MCP)', () => {
      initializeWorkspace(workDir);
      fs.writeFileSync(path.join(workDir, 'soul.md'), '# Soul\nI am helpful.', 'utf-8');

      const files = loadWorkspaceFiles(workDir);
      const results = [
        { path: 'notes/test.md', heading: 'Test', snippet: 'Some test content', score: 15, source: 'title' as const },
      ];
      // assembleWorkspacePrompt no longer accepts retrieval results
      const prompt = assembleWorkspacePrompt(files);

      assert.ok(!prompt.includes('retrieval-result'), 'retrieval results should NOT be in prompt');
      assert.ok(!prompt.includes('Some test content'), 'retrieval content should NOT be in prompt');
      void results; // suppress unused variable warning
    });

    it('should respect total prompt limit', () => {
      initializeWorkspace(workDir);
      // Write large content to test truncation
      const largeContent = '# Soul\n' + 'x'.repeat(50000);
      fs.writeFileSync(path.join(workDir, 'soul.md'), largeContent, 'utf-8');

      const files = loadWorkspaceFiles(workDir);
      const prompt = assembleWorkspacePrompt(files);

      assert.ok(prompt.length <= 45000, 'Prompt should not exceed budget (with some overhead)');
    });
  });

  describe('root docs generation', () => {
    it('should generate README.ai.md and PATH.ai.md at root', () => {
      initializeWorkspace(workDir);
      // Create some subdirs
      fs.mkdirSync(path.join(workDir, 'notes'));
      fs.mkdirSync(path.join(workDir, 'projects'));

      const generated = generateRootDocs(workDir);
      assert.ok(generated.length >= 2);
      assert.ok(fs.existsSync(path.join(workDir, 'README.ai.md')));
      assert.ok(fs.existsSync(path.join(workDir, 'PATH.ai.md')));
    });

    // Root docs are now accessed via MCP tools, not loaded into workspace files.
    // The generateRootDocs function still works; we just don't load them into files.
  });
});

// ---------------------------------------------------------------------------
// Tests for review fixes
// ---------------------------------------------------------------------------

describe('parseQuery CJK support', () => {
  const { parseQuery } = require('../../lib/workspace-retrieval') as typeof import('../../lib/workspace-retrieval');

  it('should tokenize Chinese text into bigrams and unigrams', () => {
    const tokens = parseQuery('项目排期');
    // Should contain individual chars and bigrams
    assert.ok(tokens.includes('项'), 'should include unigram 项');
    assert.ok(tokens.includes('目'), 'should include unigram 目');
    assert.ok(tokens.includes('项目'), 'should include bigram 项目');
    assert.ok(tokens.includes('排期'), 'should include bigram 排期');
  });

  it('should handle mixed Chinese and English', () => {
    const tokens = parseQuery('下周project排期');
    assert.ok(tokens.includes('下周'), 'should include CJK bigram');
    assert.ok(tokens.includes('project'), 'should include English word');
    assert.ok(tokens.includes('排期'), 'should include CJK bigram');
  });

  it('should still filter English stop words', () => {
    const tokens = parseQuery('the project is good');
    assert.ok(!tokens.includes('the'));
    assert.ok(!tokens.includes('is'));
    assert.ok(tokens.includes('project'));
    assert.ok(tokens.includes('good'));
  });
});

describe('incremental indexWorkspace', () => {
  const { indexWorkspace, loadManifest } = require('../../lib/workspace-indexer') as typeof import('../../lib/workspace-indexer');
  let wsDir: string;

  beforeEach(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-test-'));
    fs.writeFileSync(path.join(wsDir, 'note1.md'), '# Note 1\nHello', 'utf-8');
    fs.writeFileSync(path.join(wsDir, 'note2.md'), '# Note 2\nWorld', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  it('should skip unchanged files on second run', () => {
    const first = indexWorkspace(wsDir);
    assert.equal(first.fileCount, 2);

    // Second run: nothing changed, should reuse existing
    const second = indexWorkspace(wsDir);
    assert.equal(second.fileCount, 2);

    // Manifest should be identical
    const manifest = loadManifest(wsDir);
    assert.equal(manifest.length, 2);
  });

  it('should re-index only modified files', () => {
    indexWorkspace(wsDir);
    const manifestBefore = loadManifest(wsDir);
    const note1Before = manifestBefore.find(m => m.path === 'note1.md')!;

    // Modify note1 (ensure mtime changes)
    const futureTime = Date.now() + 1000;
    fs.writeFileSync(path.join(wsDir, 'note1.md'), '# Note 1 Updated\nChanged content', 'utf-8');
    fs.utimesSync(path.join(wsDir, 'note1.md'), new Date(futureTime), new Date(futureTime));

    indexWorkspace(wsDir);
    const manifestAfter = loadManifest(wsDir);

    const note1After = manifestAfter.find(m => m.path === 'note1.md')!;
    const note2After = manifestAfter.find(m => m.path === 'note2.md')!;
    const note2Before = manifestBefore.find(m => m.path === 'note2.md')!;

    // note1 should have changed hash
    assert.notEqual(note1After.hash, note1Before.hash);
    // note2 should be unchanged
    assert.equal(note2After.hash, note2Before.hash);
  });

  it('force mode should re-index all files', () => {
    indexWorkspace(wsDir);
    const result = indexWorkspace(wsDir, { force: true });
    assert.equal(result.fileCount, 2);
  });
});

describe('memory.md promotion dedup', () => {
  const { promoteDailyToLongTerm } = require('../../lib/workspace-organizer') as typeof import('../../lib/workspace-organizer');
  let wsDir: string;

  beforeEach(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-test-'));
    fs.mkdirSync(path.join(wsDir, 'memory', 'daily'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'memory.md'), '# Memory\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  it('should promote content on first call', () => {
    const dailyContent = '## Work Log\nDid stuff\n\n## Candidate Long-Term Memory\nUser prefers dark mode and uses Vim keybindings daily.\n';
    fs.writeFileSync(path.join(wsDir, 'memory', 'daily', '2026-02-20.md'), dailyContent, 'utf-8');

    const result = promoteDailyToLongTerm(wsDir, '2026-02-20');
    assert.equal(result, true);

    const memory = fs.readFileSync(path.join(wsDir, 'memory.md'), 'utf-8');
    assert.ok(memory.includes('Promoted from 2026-02-20'));
  });

  it('should NOT promote same date twice (idempotent)', () => {
    const dailyContent = '## Candidate Long-Term Memory\nUser prefers dark mode and uses Vim keybindings daily.\n';
    fs.writeFileSync(path.join(wsDir, 'memory', 'daily', '2026-02-20.md'), dailyContent, 'utf-8');

    promoteDailyToLongTerm(wsDir, '2026-02-20');
    const memoryAfterFirst = fs.readFileSync(path.join(wsDir, 'memory.md'), 'utf-8');

    // Second call should return false
    const result = promoteDailyToLongTerm(wsDir, '2026-02-20');
    assert.equal(result, false);

    const memoryAfterSecond = fs.readFileSync(path.join(wsDir, 'memory.md'), 'utf-8');
    assert.equal(memoryAfterFirst, memoryAfterSecond, 'memory.md should not change on second call');
  });
});

describe('hotset boosts search results', () => {
  const { indexWorkspace } = require('../../lib/workspace-indexer') as typeof import('../../lib/workspace-indexer');
  const { searchWorkspace, updateHotset } = require('../../lib/workspace-retrieval') as typeof import('../../lib/workspace-retrieval');
  let wsDir: string;

  beforeEach(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotset-test-'));
    // Two notes with similar relevance to "design"
    fs.writeFileSync(path.join(wsDir, 'alpha.md'), '# Design Notes\nSome design thoughts', 'utf-8');
    fs.writeFileSync(path.join(wsDir, 'beta.md'), '# Design Patterns\nSome design patterns', 'utf-8');
    indexWorkspace(wsDir, { force: true });
  });

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  it('should boost frequently accessed files in search ranking', () => {
    // Access beta many times to build frequency
    for (let i = 0; i < 10; i++) {
      updateHotset(wsDir, ['beta.md']);
    }

    const results = searchWorkspace(wsDir, 'design');
    assert.ok(results.length >= 2, 'Should find both files');
    // beta.md should be boosted to top due to hotset frequency
    assert.equal(results[0].path, 'beta.md', 'Frequently accessed file should rank higher');
  });
});

// ---------------------------------------------------------------------------
// Issue 1: Onboarding stability fixes
// ---------------------------------------------------------------------------

describe('completion fence parsing tolerates formatting variations', () => {
  // These test the regex patterns used in ChatView.tsx for parsing
  // onboarding-complete and checkin-complete fences.

  const onboardingRegex = /```onboarding-complete\s*\r?\n([\s\S]*?)\r?\n\s*```/;
  const checkinRegex = /```checkin-complete\s*\r?\n([\s\S]*?)\r?\n\s*```/;

  it('should match standard LF format', () => {
    const content = '```onboarding-complete\n{"lang":"zh"}\n```';
    const match = content.match(onboardingRegex);
    assert.ok(match, 'Should match LF format');
    assert.equal(JSON.parse(match![1].trim()).lang, 'zh');
  });

  it('should match CRLF format', () => {
    const content = '```onboarding-complete\r\n{"lang":"zh"}\r\n```';
    const match = content.match(onboardingRegex);
    assert.ok(match, 'Should match CRLF format');
    assert.equal(JSON.parse(match![1].trim()).lang, 'zh');
  });

  it('should match with trailing spaces after tag', () => {
    const content = '```onboarding-complete   \n{"lang":"zh"}\n```';
    const match = content.match(onboardingRegex);
    assert.ok(match, 'Should match with trailing spaces');
  });

  it('should match with leading whitespace before closing fence', () => {
    const content = '```onboarding-complete\n{"lang":"zh"}\n  ```';
    const match = content.match(onboardingRegex);
    assert.ok(match, 'Should match with leading whitespace before closing fence');
  });

  it('should match checkin-complete with CRLF', () => {
    const content = '```checkin-complete\r\n{"mood":"good"}\r\n```';
    const match = content.match(checkinRegex);
    assert.ok(match, 'Should match checkin CRLF format');
    assert.equal(JSON.parse(match![1].trim()).mood, 'good');
  });

  it('should handle JSON with whitespace padding', () => {
    const content = '```onboarding-complete\n  {"lang":"zh"}  \n```';
    const match = content.match(onboardingRegex);
    assert.ok(match, 'Should match');
    assert.equal(JSON.parse(match![1].trim()).lang, 'zh');
  });
});

describe('saveState is atomic (write-then-rename)', () => {
  let workDir2: string;

  beforeEach(() => {
    workDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  });

  afterEach(() => {
    fs.rmSync(workDir2, { recursive: true, force: true });
  });

  it('should persist onboardingComplete = true reliably', () => {
    initializeWorkspace(workDir2);
    const state = loadState(workDir2);
    state.onboardingComplete = true;
    state.lastHeartbeatDate = getLocalDateString();
    saveState(workDir2, state);

    // Read raw file to verify it's valid JSON
    const statePath = path.join(workDir2, '.assistant', 'state.json');
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.onboardingComplete, true);
  });

  it('should not leave .tmp file after successful write', () => {
    initializeWorkspace(workDir2);
    const state = loadState(workDir2);
    state.onboardingComplete = true;
    saveState(workDir2, state);

    const tmpPath = path.join(workDir2, '.assistant', 'state.json.tmp');
    assert.ok(!fs.existsSync(tmpPath), 'Temp file should be removed after atomic rename');
  });

  it('loadState should return default when state.json is corrupted', () => {
    const stateDir = path.join(workDir2, '.assistant');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{corrupted', 'utf-8');

    const state = loadState(workDir2);
    assert.equal(state.onboardingComplete, false, 'Corrupted state should fall back to default');
  });
});

// Clean up DB
describe('cleanup', () => {
  it('close db', () => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
