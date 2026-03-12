/**
 * Pure algorithm functions for MessageInput behavior.
 *
 * These functions contain no React dependencies — they are plain TypeScript
 * and can be tested directly without any framework setup.
 */

import { BUILT_IN_COMMANDS, COMMAND_PROMPTS } from '@/lib/constants/commands';
import type { PopoverItem, PopoverMode, CommandBadge, CliBadge } from '@/types';

// ─── Result types ────────────────────────────────────────────────

export interface InsertResult {
  action: 'immediate_command' | 'set_badge' | 'insert_file_mention';
  commandValue?: string;
  badge?: CommandBadge;
  newInputValue?: string;
}

export interface BadgeDispatchResult {
  prompt: string;
  displayLabel: string;
}

export type KeyAction =
  | { type: 'popover_navigate'; direction: 'up' | 'down' }
  | { type: 'popover_select' }
  | { type: 'close_popover' }
  | { type: 'remove_badge' }
  | { type: 'remove_cli_badge' }
  | { type: 'passthrough' };

export interface DirectSlashResult {
  action: 'immediate_command' | 'set_badge' | 'unknown_slash_badge' | 'not_slash';
  commandValue?: string;
  badge?: CommandBadge;
}

// ─── Functions ───────────────────────────────────────────────────

/**
 * Detects popover trigger from input text and cursor position.
 * Used by handleInputChange in useSlashCommands.
 */
export function detectPopoverTrigger(
  text: string,
  cursorPos: number,
): { mode: PopoverMode; filter: string; triggerPos: number } | null {
  const beforeCursor = text.slice(0, cursorPos);

  // Check for @ trigger
  const atMatch = beforeCursor.match(/@([^\s@]*)$/);
  if (atMatch) {
    return {
      mode: 'file',
      filter: atMatch[1],
      triggerPos: cursorPos - atMatch[0].length,
    };
  }

  // Check for / trigger (only at start of line or after space)
  const slashMatch = beforeCursor.match(/(^|\s)\/([^\s]*)$/);
  if (slashMatch) {
    return {
      mode: 'skill',
      filter: slashMatch[2],
      triggerPos: cursorPos - slashMatch[2].length - 1,
    };
  }

  return null;
}

/**
 * Filters popover items by substring match on label or description.
 * Used by the filteredItems useMemo in usePopoverState.
 */
export function filterItems(items: PopoverItem[], filter: string): PopoverItem[] {
  const q = filter.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q),
  );
}

/**
 * Determines what happens when an item is selected from the popover.
 * Used by insertItem in useSlashCommands.
 */
export function resolveItemSelection(
  item: PopoverItem,
  popoverMode: PopoverMode,
  triggerPos: number,
  inputValue: string,
  popoverFilter: string,
): InsertResult {
  // Immediate built-in commands
  if (item.builtIn && item.immediate) {
    return { action: 'immediate_command', commandValue: item.value };
  }

  // Non-immediate commands: show as badge
  if (popoverMode === 'skill') {
    return {
      action: 'set_badge',
      badge: {
        command: item.value,
        label: item.label,
        description: item.description || '',
        kind: item.kind || 'slash_command',
        installedSource: item.installedSource,
      },
    };
  }

  // File mention: insert into text
  const before = inputValue.slice(0, triggerPos);
  const cursorEnd = triggerPos + popoverFilter.length + 1;
  const after = inputValue.slice(cursorEnd);
  const insertText = `@${item.value} `;
  return {
    action: 'insert_file_mention',
    newInputValue: before + insertText + after,
  };
}

/**
 * Badge dispatch logic — what prompt is sent for each badge kind.
 * Used by handleSubmit in MessageInput.
 */
export function dispatchBadge(badge: CommandBadge, userContent: string): BadgeDispatchResult {
  const displayLabel = `/${badge.label}`;

  switch (badge.kind) {
    case 'agent_skill': {
      const agentPrompt = userContent
        ? `Use the ${badge.label} skill. User context: ${userContent}`
        : `Please use the ${badge.label} skill.`;
      return { prompt: agentPrompt, displayLabel };
    }
    case 'slash_command':
    case 'sdk_command': {
      const slashPrompt = userContent
        ? `${badge.command} ${userContent}`
        : badge.command;
      return { prompt: slashPrompt, displayLabel };
    }
    case 'codepilot_command': {
      const expandedPrompt = COMMAND_PROMPTS[badge.command] || '';
      const finalPrompt = userContent
        ? `${expandedPrompt}\n\nUser context: ${userContent}`
        : expandedPrompt || badge.command;
      return { prompt: finalPrompt, displayLabel };
    }
  }
}

/**
 * ArrowDown/ArrowUp index cycling logic.
 * Used by handleKeyDown popover navigation in MessageInput.
 */
export function cycleIndex(current: number, direction: 'up' | 'down', length: number): number {
  if (direction === 'down') return (current + 1) % length;
  return (current - 1 + length) % length;
}

/**
 * Submit gating logic — determines whether submit is enabled.
 * Used by FileAwareSubmitButton disabled logic.
 */
export function isSubmitEnabled(opts: {
  inputValue: string;
  hasBadge: boolean;
  hasFiles: boolean;
  isStreaming: boolean;
  disabled: boolean;
}): boolean {
  if (opts.disabled) return false;
  if (opts.isStreaming) return true; // streaming = stop button
  return !!(opts.inputValue.trim() || opts.hasBadge || opts.hasFiles);
}

/**
 * Keyboard dispatch logic — determines what action to take for a given key.
 * Used by handleKeyDown in MessageInput.
 */
export function resolveKeyAction(
  key: string,
  state: {
    popoverMode: PopoverMode;
    popoverHasItems: boolean;
    inputValue: string;
    hasBadge: boolean;
    hasCliBadge: boolean;
  },
): KeyAction {
  // Popover navigation (skill/file mode)
  if (state.popoverMode && state.popoverMode !== 'cli' && state.popoverHasItems) {
    if (key === 'ArrowDown') return { type: 'popover_navigate', direction: 'down' };
    if (key === 'ArrowUp') return { type: 'popover_navigate', direction: 'up' };
    if (key === 'Enter' || key === 'Tab') return { type: 'popover_select' };
    if (key === 'Escape') return { type: 'close_popover' };
  }

  // CLI popover
  if (state.popoverMode === 'cli') {
    if (key === 'Escape') return { type: 'close_popover' };
  }

  // Backspace removes badge when input is empty
  if (key === 'Backspace' && !state.inputValue) {
    if (state.hasBadge) return { type: 'remove_badge' };
    if (state.hasCliBadge) return { type: 'remove_cli_badge' };
  }

  // Escape removes badge
  if (key === 'Escape') {
    if (state.hasBadge) return { type: 'remove_badge' };
    if (state.hasCliBadge) return { type: 'remove_cli_badge' };
  }

  return { type: 'passthrough' };
}

/**
 * Direct slash command detection — when user types "/command" in input and submits.
 * Used by handleSubmit in MessageInput.
 */
export function resolveDirectSlash(content: string): DirectSlashResult {
  if (!content.startsWith('/')) return { action: 'not_slash' };

  const cmd = BUILT_IN_COMMANDS.find((c) => c.value === content);
  if (cmd) {
    if (cmd.immediate) {
      return { action: 'immediate_command', commandValue: content };
    }
    return {
      action: 'set_badge',
      badge: {
        command: cmd.value,
        label: cmd.label,
        description: cmd.description || '',
        kind: cmd.kind || 'sdk_command',
      },
    };
  }

  const skillName = content.slice(1);
  if (skillName) {
    return {
      action: 'unknown_slash_badge',
      badge: {
        command: content,
        label: skillName,
        description: '',
        kind: 'slash_command',
      },
    };
  }

  return { action: 'not_slash' };
}

/**
 * CLI badge system prompt append generation.
 * Used by handleSubmit in MessageInput.
 */
export function buildCliAppend(cliBadge: CliBadge | null): string | undefined {
  if (!cliBadge) return undefined;
  return `The user wants to use the installed CLI tool "${cliBadge.name}" if appropriate for this task. Prefer using "${cliBadge.name}" when suitable.`;
}
