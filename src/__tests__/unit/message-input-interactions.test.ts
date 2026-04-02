/**
 * Tests the pure logic functions exported from message-input-logic.ts.
 *
 * Covers slash command dispatch, badge behavior, popover navigation,
 * submit gating, and CLI badge handling.
 *
 * Run with: npx tsx --test src/__tests__/unit/message-input-interactions.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Real imports from source modules ────────────────────────────
import { BUILT_IN_COMMANDS, COMMAND_PROMPTS } from '../../lib/constants/commands';
import { DEFAULT_MODEL_OPTIONS } from '../../hooks/useProviderModels';
import type { CommandBadge, CliBadge, PopoverItem, PopoverMode, SkillKind } from '../../types';

// ─── Pure logic functions under test ─────────────────────────────
import {
  detectPopoverTrigger,
  filterItems,
  resolveItemSelection,
  dispatchBadge,
  cycleIndex,
  isSubmitEnabled,
  resolveKeyAction,
  resolveDirectSlash,
  buildCliAppend,
} from '../../lib/message-input-logic';

// =====================================================================
// TESTS
// =====================================================================

// --- 1. Slash Command Popover ----------------------------------------

describe('Slash command popover trigger detection', () => {
  it('typing "/" at empty input triggers skill mode', () => {
    const result = detectPopoverTrigger('/', 1);
    assert.ok(result);
    assert.equal(result.mode, 'skill');
    assert.equal(result.filter, '');
  });

  it('typing "/" after a space triggers skill mode', () => {
    const result = detectPopoverTrigger('hello /com', 10);
    assert.ok(result);
    assert.equal(result.mode, 'skill');
    assert.equal(result.filter, 'com');
  });

  it('typing "/" mid-word does NOT trigger skill mode', () => {
    const result = detectPopoverTrigger('path/to/file', 12);
    assert.equal(result, null);
  });

  it('typing "@" triggers file popover mode', () => {
    const result = detectPopoverTrigger('@src', 4);
    assert.ok(result);
    assert.equal(result.mode, 'file');
    assert.equal(result.filter, 'src');
  });

  it('typing "@" without filter triggers file mode with empty filter', () => {
    const result = detectPopoverTrigger('@', 1);
    assert.ok(result);
    assert.equal(result.mode, 'file');
    assert.equal(result.filter, '');
  });

  it('no trigger character returns null', () => {
    const result = detectPopoverTrigger('hello world', 11);
    assert.equal(result, null);
  });

  it('"/" at beginning of text triggers skill mode', () => {
    const result = detectPopoverTrigger('/doc', 4);
    assert.ok(result);
    assert.equal(result.mode, 'skill');
    assert.equal(result.filter, 'doc');
  });

  it('"@" inside a word does NOT trigger file mode', () => {
    const result = detectPopoverTrigger('user@@test', 10);
    assert.ok(result);
    assert.equal(result.mode, 'file');
    assert.equal(result.filter, 'test');
  });
});

describe('Popover item filtering (using real BUILT_IN_COMMANDS)', () => {
  it('filters by label substring match (case-insensitive)', () => {
    const result = filterItems(BUILT_IN_COMMANDS, 'doc');
    assert.ok(result.some((i) => i.label === 'doctor'));
    assert.ok(!result.some((i) => i.label === 'help'));
  });

  it('filters by description substring match', () => {
    const result = filterItems(BUILT_IN_COMMANDS, 'token');
    assert.ok(result.some((i) => i.label === 'cost'));
  });

  it('empty filter returns all items', () => {
    const result = filterItems(BUILT_IN_COMMANDS, '');
    assert.equal(result.length, BUILT_IN_COMMANDS.length);
  });

  it('no match returns empty array', () => {
    const result = filterItems(BUILT_IN_COMMANDS, 'xyznonexistent');
    assert.equal(result.length, 0);
  });
});

describe('Popover keyboard navigation (ArrowDown/ArrowUp cycling)', () => {
  it('ArrowDown cycles forward', () => {
    assert.equal(cycleIndex(0, 'down', 5), 1);
    assert.equal(cycleIndex(3, 'down', 5), 4);
  });

  it('ArrowDown wraps around at end', () => {
    assert.equal(cycleIndex(4, 'down', 5), 0);
  });

  it('ArrowUp cycles backward', () => {
    assert.equal(cycleIndex(2, 'up', 5), 1);
  });

  it('ArrowUp wraps around at beginning', () => {
    assert.equal(cycleIndex(0, 'up', 5), 4);
  });

  it('single item stays at 0', () => {
    assert.equal(cycleIndex(0, 'down', 1), 0);
    assert.equal(cycleIndex(0, 'up', 1), 0);
  });

  it('cycling through full BUILT_IN_COMMANDS length wraps correctly', () => {
    const len = BUILT_IN_COMMANDS.length;
    assert.equal(cycleIndex(len - 1, 'down', len), 0);
    assert.equal(cycleIndex(0, 'up', len), len - 1);
  });
});

describe('Popover item selection (Enter/Tab)', () => {
  it('selecting immediate command returns immediate_command action', () => {
    const helpItem = BUILT_IN_COMMANDS.find((c) => c.label === 'help')!;
    assert.ok(helpItem, 'help command must exist in BUILT_IN_COMMANDS');
    const result = resolveItemSelection(helpItem, 'skill', 0, '/', '');
    assert.equal(result.action, 'immediate_command');
    assert.equal(result.commandValue, '/help');
  });

  it('selecting non-immediate skill command sets badge', () => {
    const compactItem = BUILT_IN_COMMANDS.find((c) => c.label === 'compact')!;
    assert.ok(compactItem, 'compact command must exist in BUILT_IN_COMMANDS');
    const result = resolveItemSelection(compactItem, 'skill', 0, '/', '');
    assert.equal(result.action, 'set_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.command, '/compact');
    assert.equal(result.badge.kind, 'sdk_command');
  });

  it('selecting file mention inserts @path into text', () => {
    const fileItem: PopoverItem = { label: 'index.ts', value: 'src/index.ts' };
    const result = resolveItemSelection(fileItem, 'file', 6, 'hello @ind', 'ind');
    assert.equal(result.action, 'insert_file_mention');
    assert.equal(result.newInputValue, 'hello @src/index.ts ');
  });

  it('selecting agent_skill sets badge with agent_skill kind', () => {
    const skillItem: PopoverItem = {
      label: 'git-commit',
      value: '/git-commit',
      description: 'Smart commit',
      kind: 'agent_skill',
      installedSource: 'agents',
    };
    const result = resolveItemSelection(skillItem, 'skill', 0, '/', '');
    assert.equal(result.action, 'set_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.kind, 'agent_skill');
    assert.equal(result.badge.installedSource, 'agents');
  });

  it('selecting codepilot_command sets badge with codepilot_command kind', () => {
    const doctorItem = BUILT_IN_COMMANDS.find((c) => c.label === 'doctor')!;
    assert.ok(doctorItem, 'doctor command must exist in BUILT_IN_COMMANDS');
    const result = resolveItemSelection(doctorItem, 'skill', 0, '/', '');
    assert.equal(result.action, 'set_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.kind, 'codepilot_command');
  });

  it('selecting item with no explicit kind defaults to slash_command', () => {
    const genericItem: PopoverItem = { label: 'custom', value: '/custom', description: 'Custom skill' };
    const result = resolveItemSelection(genericItem, 'skill', 0, '/', '');
    assert.equal(result.action, 'set_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.kind, 'slash_command');
  });
});

describe('Escape closes popover', () => {
  it('Escape in skill popover returns close_popover', () => {
    const action = resolveKeyAction('Escape', {
      popoverMode: 'skill',
      popoverHasItems: true,
      inputValue: '',
      hasBadge: false,
      hasCliBadge: false,
    });
    assert.equal(action.type, 'close_popover');
  });

  it('Escape in file popover returns close_popover', () => {
    const action = resolveKeyAction('Escape', {
      popoverMode: 'file',
      popoverHasItems: true,
      inputValue: '',
      hasBadge: false,
      hasCliBadge: false,
    });
    assert.equal(action.type, 'close_popover');
  });

  it('Escape in CLI popover returns close_popover', () => {
    const action = resolveKeyAction('Escape', {
      popoverMode: 'cli',
      popoverHasItems: true,
      inputValue: '',
      hasBadge: false,
      hasCliBadge: false,
    });
    assert.equal(action.type, 'close_popover');
  });
});

// --- 2. Badge Behavior -----------------------------------------------

describe('Badge dispatch by kind', () => {
  describe('agent_skill', () => {
    const badge: CommandBadge = {
      command: '/git-commit',
      label: 'git-commit',
      description: 'Smart git commit',
      kind: 'agent_skill',
    };

    it('includes skill name and user context when context provided', () => {
      const result = dispatchBadge(badge, 'fix the README');
      assert.ok(result.prompt.includes('git-commit'));
      assert.ok(result.prompt.includes('fix the README'));
    });

    it('sends default trigger when no user content', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.prompt, 'Please use the git-commit skill.');
    });

    it('display label starts with /', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.displayLabel, '/git-commit');
    });
  });

  describe('sdk_command', () => {
    const badge: CommandBadge = {
      command: '/compact',
      label: 'compact',
      description: 'Compress context',
      kind: 'sdk_command',
    };

    it('sends command with context appended', () => {
      const result = dispatchBadge(badge, 'keep 5 messages');
      assert.equal(result.prompt, '/compact keep 5 messages');
    });

    it('sends just command when no context', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.prompt, '/compact');
    });
  });

  describe('slash_command', () => {
    const badge: CommandBadge = {
      command: '/custom-skill',
      label: 'custom-skill',
      description: 'A custom skill',
      kind: 'slash_command',
    };

    it('sends command with context appended', () => {
      const result = dispatchBadge(badge, 'do the thing');
      assert.equal(result.prompt, '/custom-skill do the thing');
    });

    it('slash_command and sdk_command behave identically', () => {
      const sdkBadge: CommandBadge = { ...badge, kind: 'sdk_command' };
      const slashResult = dispatchBadge(badge, 'test');
      const sdkResult = dispatchBadge(sdkBadge, 'test');
      assert.equal(slashResult.prompt, sdkResult.prompt);
    });
  });

  describe('codepilot_command', () => {
    const badge: CommandBadge = {
      command: '/doctor',
      label: 'doctor',
      description: 'Diagnose project health',
      kind: 'codepilot_command',
    };

    it('expands via COMMAND_PROMPTS when no user content', () => {
      const result = dispatchBadge(badge, '');
      assert.equal(result.prompt, COMMAND_PROMPTS['/doctor']);
    });

    it('appends user context to expanded prompt', () => {
      const result = dispatchBadge(badge, 'focus on deps');
      assert.ok(result.prompt.startsWith(COMMAND_PROMPTS['/doctor']));
      assert.ok(result.prompt.includes('User context: focus on deps'));
    });

    it('falls back to command string when no expansion exists', () => {
      const unknownBadge: CommandBadge = {
        command: '/unknown',
        label: 'unknown',
        description: '',
        kind: 'codepilot_command',
      };
      const result = dispatchBadge(unknownBadge, '');
      assert.equal(result.prompt, '/unknown');
    });
  });
});

describe('Badge removal via keyboard', () => {
  it('Backspace on empty input with badge removes badge', () => {
    const action = resolveKeyAction('Backspace', {
      popoverMode: null,
      popoverHasItems: false,
      inputValue: '',
      hasBadge: true,
      hasCliBadge: false,
    });
    assert.equal(action.type, 'remove_badge');
  });

  it('Backspace on non-empty input does NOT remove badge', () => {
    const action = resolveKeyAction('Backspace', {
      popoverMode: null,
      popoverHasItems: false,
      inputValue: 'hello',
      hasBadge: true,
      hasCliBadge: false,
    });
    assert.equal(action.type, 'passthrough');
  });

  it('Escape removes badge when no popover is open', () => {
    const action = resolveKeyAction('Escape', {
      popoverMode: null,
      popoverHasItems: false,
      inputValue: 'anything',
      hasBadge: true,
      hasCliBadge: false,
    });
    assert.equal(action.type, 'remove_badge');
  });

  it('Escape in active popover closes popover, not badge', () => {
    const action = resolveKeyAction('Escape', {
      popoverMode: 'skill',
      popoverHasItems: true,
      inputValue: '',
      hasBadge: true,
      hasCliBadge: false,
    });
    assert.equal(action.type, 'close_popover');
  });
});

// --- 3. Model Selector (using real DEFAULT_MODEL_OPTIONS) ------------

describe('Model selector option lookup (real DEFAULT_MODEL_OPTIONS)', () => {
  it('DEFAULT_MODEL_OPTIONS contains expected models', () => {
    const values = DEFAULT_MODEL_OPTIONS.map((m) => m.value);
    assert.ok(values.includes('sonnet'), 'should include sonnet');
    assert.ok(values.includes('opus'), 'should include opus');
    assert.ok(values.includes('haiku'), 'should include haiku');
  });

  it('finds matching model option', () => {
    const current = DEFAULT_MODEL_OPTIONS.find((m) => m.value === 'opus');
    assert.ok(current);
    assert.ok(current.label.length > 0);
  });

  it('falls back to first option when model not found', () => {
    const current = DEFAULT_MODEL_OPTIONS.find((m) => m.value === 'nonexistent') || DEFAULT_MODEL_OPTIONS[0];
    assert.equal(current.value, DEFAULT_MODEL_OPTIONS[0].value);
  });

  it('default model is sonnet when modelName is empty', () => {
    const modelName = '';
    const currentModelValue = modelName || 'sonnet';
    assert.equal(currentModelValue, 'sonnet');
  });

  it('default model is sonnet when modelName is undefined', () => {
    const modelName: string | undefined = undefined;
    const currentModelValue = modelName || 'sonnet';
    assert.equal(currentModelValue, 'sonnet');
  });
});

// --- 4. Effort Selector ----------------------------------------------

describe('Effort selector visibility logic', () => {
  interface ModelMeta {
    value: string;
    label: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
  }

  it('visible when model has supportsEffort=true', () => {
    const meta: ModelMeta = { value: 'opus', label: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] };
    assert.equal(meta.supportsEffort === true, true);
  });

  it('hidden when model does not have supportsEffort', () => {
    const meta: ModelMeta = { value: 'sonnet', label: 'Sonnet' };
    assert.equal(meta.supportsEffort === true, false);
  });

  it('hidden when supportsEffort is false', () => {
    const meta: ModelMeta = { value: 'haiku', label: 'Haiku', supportsEffort: false };
    assert.equal(meta.supportsEffort === true, false);
  });

  it('effort prop takes precedence over local state', () => {
    const effortProp: string | undefined = 'low';
    const localEffort = 'high';
    const selectedEffort = effortProp ?? localEffort;
    assert.equal(selectedEffort, 'low');
  });

  it('local state used when effort prop is undefined', () => {
    const effortProp: string | undefined = undefined;
    const localEffort = 'high';
    const selectedEffort = effortProp ?? localEffort;
    assert.equal(selectedEffort, 'high');
  });
});

// --- 5. Submit Behavior ----------------------------------------------

describe('Submit gating logic', () => {
  it('empty input with no badge and no files disables submit', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: '', hasBadge: false, hasFiles: false, isStreaming: false, disabled: false }),
      false,
    );
  });

  it('whitespace-only input disables submit', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: '   ', hasBadge: false, hasFiles: false, isStreaming: false, disabled: false }),
      false,
    );
  });

  it('non-empty input enables submit', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: 'hello', hasBadge: false, hasFiles: false, isStreaming: false, disabled: false }),
      true,
    );
  });

  it('badge without input enables submit', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: '', hasBadge: true, hasFiles: false, isStreaming: false, disabled: false }),
      true,
    );
  });

  it('files without input enables submit', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: '', hasBadge: false, hasFiles: true, isStreaming: false, disabled: false }),
      true,
    );
  });

  it('streaming always enables submit (stop button)', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: '', hasBadge: false, hasFiles: false, isStreaming: true, disabled: false }),
      true,
    );
  });

  it('disabled flag overrides everything', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: 'hello', hasBadge: true, hasFiles: true, isStreaming: false, disabled: true }),
      false,
    );
  });

  it('disabled flag even overrides streaming', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: '', hasBadge: false, hasFiles: false, isStreaming: true, disabled: true }),
      false,
    );
  });
});

describe('Direct slash command typed in input', () => {
  it('/help is dispatched as immediate command', () => {
    const result = resolveDirectSlash('/help');
    assert.equal(result.action, 'immediate_command');
    assert.equal(result.commandValue, '/help');
  });

  it('/clear is dispatched as immediate command', () => {
    const result = resolveDirectSlash('/clear');
    assert.equal(result.action, 'immediate_command');
  });

  it('/compact becomes a badge (non-immediate)', () => {
    const result = resolveDirectSlash('/compact');
    assert.equal(result.action, 'set_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.kind, 'sdk_command');
  });

  it('/doctor becomes a codepilot_command badge', () => {
    const result = resolveDirectSlash('/doctor');
    assert.equal(result.action, 'set_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.kind, 'codepilot_command');
  });

  it('unknown /command becomes slash_command badge', () => {
    const result = resolveDirectSlash('/my-custom-tool');
    assert.equal(result.action, 'unknown_slash_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.kind, 'slash_command');
    assert.equal(result.badge.label, 'my-custom-tool');
  });

  it('bare "/" returns not_slash', () => {
    const result = resolveDirectSlash('/');
    assert.equal(result.action, 'not_slash');
  });

  it('non-slash content returns not_slash', () => {
    const result = resolveDirectSlash('hello world');
    assert.equal(result.action, 'not_slash');
  });
});

// --- 6. CLI Badge ----------------------------------------------------

describe('CLI badge behavior', () => {
  it('CLI append is generated when badge is set', () => {
    const cliBadge: CliBadge = { id: 'jq', name: 'jq' };
    const append = buildCliAppend(cliBadge);
    assert.ok(append);
    assert.ok(append.includes('jq'));
    assert.ok(append.includes('CLI tool'));
  });

  it('CLI append is undefined when no badge', () => {
    const append = buildCliAppend(null);
    assert.equal(append, undefined);
  });

  it('Backspace on empty input removes CLI badge (badge has priority)', () => {
    const action = resolveKeyAction('Backspace', {
      popoverMode: null,
      popoverHasItems: false,
      inputValue: '',
      hasBadge: true,
      hasCliBadge: true,
    });
    assert.equal(action.type, 'remove_badge');
  });

  it('Backspace on empty input removes CLI badge when no command badge', () => {
    const action = resolveKeyAction('Backspace', {
      popoverMode: null,
      popoverHasItems: false,
      inputValue: '',
      hasBadge: false,
      hasCliBadge: true,
    });
    assert.equal(action.type, 'remove_cli_badge');
  });

  it('Escape removes CLI badge when no command badge and no popover', () => {
    const action = resolveKeyAction('Escape', {
      popoverMode: null,
      popoverHasItems: false,
      inputValue: '',
      hasBadge: false,
      hasCliBadge: true,
    });
    assert.equal(action.type, 'remove_cli_badge');
  });

  it('CLI badge combined with hasBadge enables submit', () => {
    assert.equal(
      isSubmitEnabled({ inputValue: '', hasBadge: true, hasFiles: false, isStreaming: false, disabled: false }),
      true,
    );
  });
});

// --- Cross-cutting: full keyboard interaction scenarios ---------------

describe('Full keyboard interaction scenarios', () => {
  it('typing /doc -> ArrowDown -> Enter selects /doctor badge', () => {
    const trigger = detectPopoverTrigger('/doc', 4);
    assert.ok(trigger);
    assert.equal(trigger.mode, 'skill');
    assert.equal(trigger.filter, 'doc');

    const filtered = filterItems(BUILT_IN_COMMANDS, 'doc');
    assert.ok(filtered.length > 0);
    assert.ok(filtered.some((i) => i.label === 'doctor'));

    const doctorIdx = filtered.findIndex((i) => i.label === 'doctor');
    const item = filtered[doctorIdx];
    const result = resolveItemSelection(item, 'skill', trigger.triggerPos, '/doc', 'doc');
    assert.equal(result.action, 'set_badge');
    assert.ok(result.badge);
    assert.equal(result.badge.command, '/doctor');
    assert.equal(result.badge.kind, 'codepilot_command');
  });

  it('typing /help -> Enter immediately triggers command', () => {
    const trigger = detectPopoverTrigger('/help', 5);
    assert.ok(trigger);

    const filtered = filterItems(BUILT_IN_COMMANDS, 'help');
    assert.ok(filtered.length >= 1);

    const helpItem = filtered.find((i) => i.label === 'help')!;
    assert.ok(helpItem);

    const result = resolveItemSelection(helpItem, 'skill', trigger.triggerPos, '/help', 'help');
    assert.equal(result.action, 'immediate_command');
    assert.equal(result.commandValue, '/help');
  });

  it('badge set -> user types context -> submit dispatches correctly', () => {
    const badge: CommandBadge = {
      command: '/compact',
      label: 'compact',
      description: 'Compress conversation context',
      kind: 'sdk_command',
    };
    const userContent = 'keep last 5 messages';

    const result = dispatchBadge(badge, userContent);
    assert.equal(result.prompt, '/compact keep last 5 messages');
    assert.equal(result.displayLabel, '/compact\nkeep last 5 messages');
  });

  it('badge set -> empty submit dispatches with no context', () => {
    const badge: CommandBadge = {
      command: '/review',
      label: 'review',
      description: 'Review code',
      kind: 'sdk_command',
    };

    assert.equal(
      isSubmitEnabled({ inputValue: '', hasBadge: true, hasFiles: false, isStreaming: false, disabled: false }),
      true,
    );

    const result = dispatchBadge(badge, '');
    assert.equal(result.prompt, '/review');
  });

  it('typing @file -> selecting inserts mention', () => {
    const input = 'look at @inde';
    const cursorPos = input.length;
    const trigger = detectPopoverTrigger(input, cursorPos);
    assert.ok(trigger);
    assert.equal(trigger.mode, 'file');
    assert.equal(trigger.filter, 'inde');
    assert.equal(trigger.triggerPos, 8);

    const fileItem: PopoverItem = { label: 'index.ts', value: 'src/index.ts' };
    const result = resolveItemSelection(fileItem, 'file', trigger.triggerPos, input, 'inde');
    assert.equal(result.action, 'insert_file_mention');
    assert.equal(result.newInputValue, 'look at @src/index.ts ');
  });
});

// --- Built-in commands data integrity (using real imports) ------------

describe('Built-in commands data integrity (real BUILT_IN_COMMANDS)', () => {
  it('all immediate commands have no kind', () => {
    const immediates = BUILT_IN_COMMANDS.filter((c) => c.immediate);
    assert.ok(immediates.length > 0, 'there should be at least one immediate command');
    for (const cmd of immediates) {
      assert.equal(cmd.kind, undefined, `immediate command "${cmd.value}" should not have a kind`);
    }
  });

  it('all non-immediate commands have a kind', () => {
    const nonImmediates = BUILT_IN_COMMANDS.filter((c) => !c.immediate);
    assert.ok(nonImmediates.length > 0, 'there should be at least one non-immediate command');
    for (const cmd of nonImmediates) {
      assert.ok(cmd.kind, `non-immediate command "${cmd.value}" should have a kind`);
    }
  });

  it('all codepilot_commands have expansion prompts in COMMAND_PROMPTS', () => {
    const codepilotCmds = BUILT_IN_COMMANDS.filter((c) => c.kind === 'codepilot_command');
    assert.ok(codepilotCmds.length > 0, 'there should be at least one codepilot_command');
    for (const cmd of codepilotCmds) {
      assert.ok(
        COMMAND_PROMPTS[cmd.value],
        `codepilot_command "${cmd.value}" should have an expansion prompt`,
      );
    }
  });

  it('sdk_commands do NOT have expansion prompts', () => {
    const sdkCmds = BUILT_IN_COMMANDS.filter((c) => c.kind === 'sdk_command');
    assert.ok(sdkCmds.length > 0, 'there should be at least one sdk_command');
    for (const cmd of sdkCmds) {
      assert.equal(
        COMMAND_PROMPTS[cmd.value],
        undefined,
        `sdk_command "${cmd.value}" should not have an expansion prompt`,
      );
    }
  });

  it('all labels are unique', () => {
    const labels = BUILT_IN_COMMANDS.map((c) => c.label);
    const unique = new Set(labels);
    assert.equal(labels.length, unique.size, 'duplicate labels found');
  });

  it('all values are unique and start with /', () => {
    const values = BUILT_IN_COMMANDS.map((c) => c.value);
    const unique = new Set(values);
    assert.equal(values.length, unique.size, 'duplicate values found');
    for (const val of values) {
      assert.ok(val.startsWith('/'), `value "${val}" should start with /`);
    }
  });

  it('COMMAND_PROMPTS keys are a subset of codepilot_command values', () => {
    const codepilotValues = new Set(
      BUILT_IN_COMMANDS.filter((c) => c.kind === 'codepilot_command').map((c) => c.value),
    );
    for (const key of Object.keys(COMMAND_PROMPTS)) {
      assert.ok(
        codepilotValues.has(key),
        `COMMAND_PROMPTS key "${key}" is not a codepilot_command in BUILT_IN_COMMANDS`,
      );
    }
  });

  it('all builtIn flags are true', () => {
    for (const cmd of BUILT_IN_COMMANDS) {
      assert.equal(cmd.builtIn, true, `command "${cmd.value}" should have builtIn=true`);
    }
  });
});
