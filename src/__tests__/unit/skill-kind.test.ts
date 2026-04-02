/**
 * Unit tests for the SkillKind system — type values, COMMAND_PROMPTS mapping,
 * and badge dispatch logic.
 *
 * Run with: npx tsx --test src/__tests__/unit/skill-kind.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillKind } from '../../types';
import { dispatchBadge as realDispatchBadge } from '../../lib/message-input-logic';

// ─── SkillKind Type Values ──────────────────────────────────────

describe('SkillKind type values', () => {
  // SkillKind is a string literal union — we can't iterate it at runtime,
  // but we can verify the known values satisfy the type constraint.
  const validKinds: SkillKind[] = [
    'agent_skill',
    'slash_command',
    'sdk_command',
    'codepilot_command',
  ];

  it('should include exactly 4 expected kinds', () => {
    assert.equal(validKinds.length, 4);
  });

  it('each kind should be a non-empty string', () => {
    for (const kind of validKinds) {
      assert.equal(typeof kind, 'string');
      assert.ok(kind.length > 0, `kind "${kind}" should be non-empty`);
    }
  });

  it('should have no duplicate values', () => {
    const unique = new Set(validKinds);
    assert.equal(unique.size, validKinds.length, 'SkillKind values must be unique');
  });
});

// ─── COMMAND_PROMPTS Mapping ────────────────────────────────────

// Mirror of the COMMAND_PROMPTS from MessageInput.tsx (not exported, so we replicate)
const COMMAND_PROMPTS: Record<string, string> = {
  '/doctor': 'Run diagnostic checks on this project. Check system health, dependencies, configuration files, and report any issues.',
  '/terminal-setup': 'Help me configure my terminal for optimal use with Claude Code. Check current setup and suggest improvements.',
  '/memory': 'Show the current CLAUDE.md project memory file and help me review or edit it.',
};

// Mirror of built-in commands with kind info (subset relevant to this test)
interface BuiltInCommandStub {
  label: string;
  value: string;
  kind?: SkillKind;
  immediate?: boolean;
}

const BUILT_IN_COMMANDS: BuiltInCommandStub[] = [
  { label: 'help', value: '/help', immediate: true },
  { label: 'clear', value: '/clear', immediate: true },
  { label: 'cost', value: '/cost', immediate: true },
  { label: 'compact', value: '/compact', kind: 'sdk_command' },
  { label: 'doctor', value: '/doctor', kind: 'codepilot_command' },
  { label: 'init', value: '/init', kind: 'sdk_command' },
  { label: 'review', value: '/review', kind: 'sdk_command' },
  { label: 'terminal-setup', value: '/terminal-setup', kind: 'codepilot_command' },
  { label: 'memory', value: '/memory', kind: 'codepilot_command' },
];

describe('COMMAND_PROMPTS mapping', () => {
  it('should only have entries for codepilot_command kind', () => {
    const codepilotCommands = BUILT_IN_COMMANDS
      .filter(c => c.kind === 'codepilot_command')
      .map(c => c.value);

    for (const key of Object.keys(COMMAND_PROMPTS)) {
      assert.ok(
        codepilotCommands.includes(key),
        `COMMAND_PROMPTS key "${key}" should correspond to a codepilot_command`,
      );
    }
  });

  it('every codepilot_command should have an expansion prompt', () => {
    const codepilotCommands = BUILT_IN_COMMANDS.filter(c => c.kind === 'codepilot_command');
    for (const cmd of codepilotCommands) {
      assert.ok(
        COMMAND_PROMPTS[cmd.value],
        `codepilot_command "${cmd.value}" should have an expansion prompt in COMMAND_PROMPTS`,
      );
    }
  });

  it('sdk_command entries should NOT be in COMMAND_PROMPTS', () => {
    const sdkCommands = BUILT_IN_COMMANDS.filter(c => c.kind === 'sdk_command');
    for (const cmd of sdkCommands) {
      assert.equal(
        COMMAND_PROMPTS[cmd.value],
        undefined,
        `sdk_command "${cmd.value}" should not have an expansion prompt`,
      );
    }
  });

  it('immediate commands should not have a kind', () => {
    const immediateCommands = BUILT_IN_COMMANDS.filter(c => c.immediate);
    for (const cmd of immediateCommands) {
      assert.equal(cmd.kind, undefined, `immediate command "${cmd.value}" should not have a kind`);
    }
  });

  it('all expansion prompts should be non-empty strings', () => {
    for (const [key, prompt] of Object.entries(COMMAND_PROMPTS)) {
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt.length > 10, `Prompt for "${key}" should be a meaningful sentence`);
    }
  });
});

// ─── Badge Dispatch Logic ───────────────────────────────────────

// Pure-function extraction of the switch(badge.kind) dispatch from handleSubmit
interface CommandBadge {
  command: string;
  label: string;
  description: string;
  kind: SkillKind;
}

interface DispatchResult {
  prompt: string;
  displayLabel: string;
}

// Use the real implementation instead of a local copy to prevent drift
const dispatchBadge = realDispatchBadge as (badge: CommandBadge, userContent: string) => DispatchResult;

describe('badge dispatch logic', () => {
  describe('agent_skill kind', () => {
    const badge: CommandBadge = {
      command: '/git-commit',
      label: 'git-commit',
      description: 'Smart git commit',
      kind: 'agent_skill',
    };

    it('should include skill name AND user context when context provided', () => {
      const result = dispatchBadge(badge, 'fix the typo in README');
      assert.ok(result.prompt.includes('git-commit'), 'prompt must reference the skill name');
      assert.ok(result.prompt.includes('fix the typo in README'), 'prompt must include user context');
      assert.equal(result.displayLabel, '/git-commit\nfix the typo in README');
    });

    it('should send trigger hint with skill name when no user content', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.prompt, 'Please use the git-commit skill.');
      assert.equal(result.displayLabel, '/git-commit');
    });

    it('should NOT include SKILL.md content but SHOULD include skill name', () => {
      const result = dispatchBadge(badge, 'some context');
      assert.ok(!result.prompt.includes('SKILL.md'), 'agent_skill should not expand SKILL.md');
      assert.ok(result.prompt.includes('git-commit'), 'agent_skill must include skill name');
    });
  });

  describe('slash_command kind', () => {
    const badge: CommandBadge = {
      command: '/my-custom-skill',
      label: 'my-custom-skill',
      description: 'A custom slash command',
      kind: 'slash_command',
    };

    it('should send /{command} {context} format with user content', () => {
      const result = dispatchBadge(badge, 'extra context');
      assert.equal(result.prompt, '/my-custom-skill extra context');
    });

    it('should send just the command when no user content', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.prompt, '/my-custom-skill');
    });

    it('should show display label with slash prefix', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.displayLabel, '/my-custom-skill');
    });
  });

  describe('sdk_command kind', () => {
    const badge: CommandBadge = {
      command: '/compact',
      label: 'compact',
      description: 'Compress conversation context',
      kind: 'sdk_command',
    };

    it('should send /{command} {context} format with user content', () => {
      const result = dispatchBadge(badge, 'keep last 5 messages');
      assert.equal(result.prompt, '/compact keep last 5 messages');
    });

    it('should send just the command when no user content', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.prompt, '/compact');
    });

    it('should behave identically to slash_command', () => {
      const slashBadge: CommandBadge = { ...badge, kind: 'slash_command' };
      const sdkResult = dispatchBadge(badge, 'test input');
      const slashResult = dispatchBadge(slashBadge, 'test input');
      assert.equal(sdkResult.prompt, slashResult.prompt);
    });
  });

  describe('codepilot_command kind', () => {
    const badge: CommandBadge = {
      command: '/doctor',
      label: 'doctor',
      description: 'Diagnose project health',
      kind: 'codepilot_command',
    };

    it('should expand via COMMAND_PROMPTS when no user content', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.prompt, COMMAND_PROMPTS['/doctor']);
      assert.ok(result.prompt.includes('diagnostic checks'));
    });

    it('should append user context to expanded prompt', () => {
      const result = dispatchBadge(badge, 'focus on deps');
      assert.ok(result.prompt.startsWith(COMMAND_PROMPTS['/doctor']));
      assert.ok(result.prompt.includes('User context: focus on deps'));
    });

    it('should fall back to command string when no expansion prompt exists', () => {
      const unknownBadge: CommandBadge = {
        command: '/unknown-codepilot',
        label: 'unknown-codepilot',
        description: 'Unknown',
        kind: 'codepilot_command',
      };
      const result = dispatchBadge(unknownBadge, '');
      assert.equal(result.prompt, '/unknown-codepilot');
    });

    it('should NOT send raw command for known codepilot commands', () => {
      const result = dispatchBadge(badge, '');
      assert.ok(!result.prompt.startsWith('/doctor'), 'should expand, not send raw /doctor');
    });

    it('should show display label correctly', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.displayLabel, '/doctor');
    });
  });

  describe('cross-kind consistency', () => {
    it('all kinds should produce a displayLabel starting with /', () => {
      const kinds: SkillKind[] = ['agent_skill', 'slash_command', 'sdk_command', 'codepilot_command'];
      for (const kind of kinds) {
        const badge: CommandBadge = {
          command: '/test',
          label: 'test',
          description: 'test',
          kind,
        };
        const result = dispatchBadge(badge, '');
        assert.ok(result.displayLabel.startsWith('/'), `kind "${kind}" should produce /label`);
      }
    });

    it('all kinds should produce a non-empty prompt', () => {
      const kinds: SkillKind[] = ['agent_skill', 'slash_command', 'sdk_command', 'codepilot_command'];
      for (const kind of kinds) {
        const badge: CommandBadge = {
          command: '/test',
          label: 'test',
          description: 'test',
          kind,
        };
        const result = dispatchBadge(badge, '');
        assert.ok(result.prompt.length > 0, `kind "${kind}" should produce a non-empty prompt`);
      }
    });
  });
});
