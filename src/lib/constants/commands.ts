/**
 * Command metadata — shared constants for slash commands and their expansion prompts.
 *
 * Lives in lib/constants/ to avoid circular dependencies between hooks and logic modules.
 * Icon assignments live in command-icons.ts to keep this module presentation-free.
 */

import type { PopoverItem } from '@/types';

/** Expansion prompts for CLI-only commands (not natively supported by SDK). */
export const COMMAND_PROMPTS: Record<string, string> = {
  '/doctor': 'Run diagnostic checks on this project. Check system health, dependencies, configuration files, and report any issues.',
  '/terminal-setup': 'Help me configure my terminal for optimal use with Claude Code. Check current setup and suggest improvements.',
  '/memory': 'Show the current CLAUDE.md project memory file and help me review or edit it.',
};

/** Built-in slash commands shown in the popover (without icons — see command-icons.ts). */
export const BUILT_IN_COMMANDS: PopoverItem[] = [
  { label: 'help', value: '/help', description: 'Show available commands and tips', descriptionKey: 'messageInput.helpDesc', builtIn: true, immediate: true },
  { label: 'clear', value: '/clear', description: 'Clear conversation history', descriptionKey: 'messageInput.clearDesc', builtIn: true, immediate: true },
  { label: 'cost', value: '/cost', description: 'Show token usage statistics', descriptionKey: 'messageInput.costDesc', builtIn: true, immediate: true },
  { label: 'compact', value: '/compact', description: 'Compress conversation context', descriptionKey: 'messageInput.compactDesc', builtIn: true, kind: 'sdk_command' },
  { label: 'doctor', value: '/doctor', description: 'Diagnose project health', descriptionKey: 'messageInput.doctorDesc', builtIn: true, kind: 'codepilot_command' },
  { label: 'init', value: '/init', description: 'Initialize CLAUDE.md for project', descriptionKey: 'messageInput.initDesc', builtIn: true, kind: 'sdk_command' },
  { label: 'review', value: '/review', description: 'Review code quality', descriptionKey: 'messageInput.reviewDesc', builtIn: true, kind: 'sdk_command' },
  { label: 'terminal-setup', value: '/terminal-setup', description: 'Configure terminal settings', descriptionKey: 'messageInput.terminalSetupDesc', builtIn: true, kind: 'codepilot_command' },
  { label: 'memory', value: '/memory', description: 'Edit project memory file', descriptionKey: 'messageInput.memoryDesc', builtIn: true, kind: 'codepilot_command' },
];
