'use client';

import { useRef, useState, useCallback, useEffect, type KeyboardEvent, type FormEvent } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AtIcon,
  FolderOpenIcon,
  Wrench01Icon,
  ClipboardIcon,
  HelpCircleIcon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  CommandLineIcon,
  Attachment01Icon,
  Cancel01Icon,
  Delete02Icon,
  Coins01Icon,
  FileZipIcon,
  Stethoscope02Icon,
  FileEditIcon,
  SearchList01Icon,
  BrainIcon,
  GlobalIcon,
} from "@hugeicons/core-free-icons";
import { cn } from '@/lib/utils';
import { FolderPicker } from './FolderPicker';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import { SquareIcon } from 'lucide-react';
import type { ChatStatus } from 'ai';
import type { FileAttachment } from '@/types';
import { nanoid } from 'nanoid';

// Accepted file types for upload
const ACCEPTED_FILE_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'text/*',
  '.md', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
].join(',');

// Max file sizes
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;  // 5MB
const MAX_DOC_SIZE = 10 * 1024 * 1024;   // 10MB
const MAX_FILE_SIZE = MAX_DOC_SIZE;       // Use larger limit; we validate per-type in conversion

interface MessageInputProps {
  onSend: (content: string, files?: FileAttachment[]) => void;
  onCommand?: (command: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  sessionId?: string;
  modelName?: string;
  onModelChange?: (model: string) => void;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  mode?: string;
  onModeChange?: (mode: string) => void;
}

interface PopoverItem {
  label: string;
  value: string;
  description?: string;
  builtIn?: boolean;
  immediate?: boolean;
  installedSource?: "agents" | "claude";
  icon?: typeof CommandLineIcon;
}

interface CommandBadge {
  command: string;
  label: string;
  description: string;
  isSkill: boolean;
  installedSource?: "agents" | "claude";
}

type PopoverMode = 'file' | 'skill' | null;

// Expansion prompts for CLI-only commands (not natively supported by SDK).
// SDK-native commands (/compact, /init, /review) are sent as-is — the SDK handles them directly.
const COMMAND_PROMPTS: Record<string, string> = {
  '/doctor': 'Run diagnostic checks on this project. Check system health, dependencies, configuration files, and report any issues.',
  '/terminal-setup': 'Help me configure my terminal for optimal use with Claude Code. Check current setup and suggest improvements.',
  '/memory': 'Show the current CLAUDE.md project memory file and help me review or edit it.',
};

const BUILT_IN_COMMANDS: PopoverItem[] = [
  { label: 'help', value: '/help', description: 'Show available commands and tips', builtIn: true, immediate: true, icon: HelpCircleIcon },
  { label: 'clear', value: '/clear', description: 'Clear conversation history', builtIn: true, immediate: true, icon: Delete02Icon },
  { label: 'cost', value: '/cost', description: 'Show token usage statistics', builtIn: true, immediate: true, icon: Coins01Icon },
  { label: 'compact', value: '/compact', description: 'Compress conversation context', builtIn: true, icon: FileZipIcon },
  { label: 'doctor', value: '/doctor', description: 'Diagnose project health', builtIn: true, icon: Stethoscope02Icon },
  { label: 'init', value: '/init', description: 'Initialize CLAUDE.md for project', builtIn: true, icon: FileEditIcon },
  { label: 'review', value: '/review', description: 'Review code quality', builtIn: true, icon: SearchList01Icon },
  { label: 'terminal-setup', value: '/terminal-setup', description: 'Configure terminal settings', builtIn: true, icon: CommandLineIcon },
  { label: 'memory', value: '/memory', description: 'Edit project memory file', builtIn: true, icon: BrainIcon },
];

interface ModeOption {
  value: string;
  label: string;
  icon: typeof Wrench01Icon;
  description: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { value: 'code', label: 'Code', icon: Wrench01Icon, description: 'Read, write files & run commands' },
  { value: 'plan', label: 'Plan', icon: ClipboardIcon, description: 'Analyze & plan without executing' },
  { value: 'ask', label: 'Ask', icon: HelpCircleIcon, description: 'Answer questions only' },
];

// Default Claude model options — labels are dynamically overridden by active provider
const DEFAULT_MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet 4.5' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

// Provider-specific model label mappings (alias → display name)
const PROVIDER_MODEL_LABELS: Record<string, Record<string, string>> = {
  // GLM Coding Plan (Z.AI / 智谱)
  'https://api.z.ai/api/anthropic': {
    sonnet: 'GLM-4.7',
    opus: 'GLM-4.7',
    haiku: 'GLM-4.5-Air',
  },
  'https://open.bigmodel.cn/api/anthropic': {
    sonnet: 'GLM-4.7',
    opus: 'GLM-4.7',
    haiku: 'GLM-4.5-Air',
  },
  // Kimi Coding Plan
  'https://api.kimi.com/coding/': {
    sonnet: 'Kimi K2.5',
    opus: 'Kimi K2.5',
    haiku: 'Kimi K2.5',
  },
  // Moonshot Open Platform
  'https://api.moonshot.ai/anthropic': {
    sonnet: 'Kimi K2.5',
    opus: 'Kimi K2.5',
    haiku: 'Kimi K2.5',
  },
  'https://api.moonshot.cn/anthropic': {
    sonnet: 'Kimi K2.5',
    opus: 'Kimi K2.5',
    haiku: 'Kimi K2.5',
  },
  // MiniMax Coding Plan
  'https://api.minimaxi.com/anthropic': {
    sonnet: 'MiniMax-M2.1',
    opus: 'MiniMax-M2.1',
    haiku: 'MiniMax-M2.1',
  },
  'https://api.minimax.io/anthropic': {
    sonnet: 'MiniMax-M2.1',
    opus: 'MiniMax-M2.1',
    haiku: 'MiniMax-M2.1',
  },
  // OpenRouter — keeps Claude names, provider handles routing
  'https://openrouter.ai/api': {
    sonnet: 'Sonnet 4.5',
    opus: 'Opus 4.6',
    haiku: 'Haiku 4.5',
  },
};

/**
 * Convert a data URL to a FileAttachment object.
 */
async function dataUrlToFileAttachment(
  dataUrl: string,
  filename: string,
  mediaType: string,
): Promise<FileAttachment> {
  // data:image/png;base64,<data>  — extract the base64 part
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

  // Estimate raw size from base64 length
  const size = Math.ceil((base64.length * 3) / 4);

  return {
    id: nanoid(),
    name: filename,
    type: mediaType || 'application/octet-stream',
    size,
    data: base64,
  };
}

/**
 * Submit button that's aware of file attachments. Must be rendered inside PromptInput.
 */
function FileAwareSubmitButton({
  status,
  onStop,
  disabled,
  inputValue,
  hasBadge,
}: {
  status: ChatStatus;
  onStop?: () => void;
  disabled?: boolean;
  inputValue: string;
  hasBadge: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const hasFiles = attachments.files.length > 0;
  const isStreaming = status === 'streaming' || status === 'submitted';

  return (
    <PromptInputSubmit
      status={status}
      onStop={onStop}
      disabled={disabled || (!isStreaming && !inputValue.trim() && !hasBadge && !hasFiles)}
      className="rounded-full"
    >
      {isStreaming ? (
        <SquareIcon className="size-4" />
      ) : (
        <HugeiconsIcon icon={ArrowUp02Icon} className="h-4 w-4" strokeWidth={2} />
      )}
    </PromptInputSubmit>
  );
}

/**
 * Attachment button that opens the file dialog. Must be rendered inside PromptInput.
 */
function AttachFileButton() {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      onClick={() => attachments.openFileDialog()}
      tooltip="Attach files"
    >
      <HugeiconsIcon icon={Attachment01Icon} className="h-3.5 w-3.5" />
    </PromptInputButton>
  );
}

/**
 * Bridge component that listens for 'attach-file-to-chat' custom events
 * from the file tree and adds files as attachments. Must be rendered inside PromptInput.
 */
function FileTreeAttachmentBridge() {
  const attachments = usePromptInputAttachments();
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const handler = async (e: Event) => {
      const customEvent = e as CustomEvent<{ path: string }>;
      const filePath = customEvent.detail?.path;
      if (!filePath) return;

      try {
        const res = await fetch(`/api/files/raw?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) return;
        const blob = await res.blob();
        const filename = filePath.split('/').pop() || 'file';
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        attachmentsRef.current.add([file]);
      } catch {
        // Silently fail if file fetch fails
      }
    };

    window.addEventListener('attach-file-to-chat', handler);
    return () => window.removeEventListener('attach-file-to-chat', handler);
  }, []);

  return null;
}

/**
 * Capsule display for attached files, rendered inside PromptInput context.
 */
function FileAttachmentsCapsules() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 px-3 pt-2 pb-0 order-first">
      {attachments.files.map((file) => {
        const isImage = file.mediaType?.startsWith('image/');
        return (
          <span
            key={file.id}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 pl-2 pr-1 py-0.5 text-xs font-medium border border-emerald-500/20"
          >
            {isImage && file.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={file.url}
                alt={file.filename || 'image'}
                className="h-5 w-5 rounded object-cover"
              />
            )}
            <span className="max-w-[120px] truncate text-[11px]">
              {file.filename || 'file'}
            </span>
            <button
              type="button"
              onClick={() => attachments.remove(file.id)}
              className="ml-0.5 rounded-full p-0.5 hover:bg-emerald-500/20 transition-colors"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function MessageInput({
  onSend,
  onCommand,
  onStop,
  disabled,
  isStreaming,
  sessionId,
  modelName,
  onModelChange,
  workingDirectory,
  onWorkingDirectoryChange,
  mode = 'code',
  onModeChange,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPos, setTriggerPos] = useState<number | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [badge, setBadge] = useState<CommandBadge | null>(null);
  const [activeProviderBaseUrl, setActiveProviderBaseUrl] = useState<string | null>(null);
  const [activeProviderName, setActiveProviderName] = useState<string | null>(null);

  // Fetch active provider to adapt model labels
  useEffect(() => {
    fetch('/api/providers')
      .then((r) => r.json())
      .then((data) => {
        const active = (data.providers || []).find((p: { is_active: number }) => p.is_active === 1);
        if (active) {
          setActiveProviderBaseUrl(active.base_url || null);
          setActiveProviderName(active.name || null);
        } else {
          setActiveProviderBaseUrl(null);
          setActiveProviderName(null);
        }
      })
      .catch(() => {});
  }, []);

  // Compute model options based on active provider
  const MODEL_OPTIONS = DEFAULT_MODEL_OPTIONS.map((opt) => {
    if (activeProviderBaseUrl && PROVIDER_MODEL_LABELS[activeProviderBaseUrl]) {
      const label = PROVIDER_MODEL_LABELS[activeProviderBaseUrl][opt.value];
      if (label) return { ...opt, label };
    }
    return opt;
  });

  // Fetch files for @ mention
  const fetchFiles = useCallback(async (filter: string) => {
    try {
      const params = new URLSearchParams();
      if (sessionId) params.set('session_id', sessionId);
      if (filter) params.set('q', filter);
      const res = await fetch(`/api/files?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json();
      const tree = data.tree || [];
      const items: PopoverItem[] = [];
      function flattenTree(nodes: Array<{ name: string; path: string; type: string; children?: unknown[] }>) {
        for (const node of nodes) {
          items.push({ label: node.name, value: node.path });
          if (node.children) flattenTree(node.children as typeof nodes);
        }
      }
      flattenTree(tree);
      return items.slice(0, 20);
    } catch {
      return [];
    }
  }, [sessionId]);

  // Fetch skills for / command (built-in + API)
  // Returns all items unfiltered — filtering is done by filteredItems
  const fetchSkills = useCallback(async () => {
    let apiSkills: PopoverItem[] = [];
    try {
      const res = await fetch('/api/skills');
      if (res.ok) {
        const data = await res.json();
        const skills = data.skills || [];
        apiSkills = skills
          .map((s: { name: string; description: string; source?: string; installedSource?: "agents" | "claude" }) => ({
            label: s.name,
            value: `/${s.name}`,
            description: s.description || "",
            builtIn: false,
            installedSource: s.installedSource,
          }));
      }
    } catch {
      // API not available - just use built-in commands
    }

    // Deduplicate: remove API skills that share a name with built-in commands
    const builtInNames = new Set(BUILT_IN_COMMANDS.map(c => c.label));
    const uniqueSkills = apiSkills.filter(s => !builtInNames.has(s.label));

    return [...BUILT_IN_COMMANDS, ...uniqueSkills];
  }, []);

  // Close popover
  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
  }, []);

  // Remove active badge
  const removeBadge = useCallback(() => {
    setBadge(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  // Insert selected item
  const insertItem = useCallback((item: PopoverItem) => {
    if (triggerPos === null) return;

    // Immediate built-in commands: execute right away
    if (item.builtIn && item.immediate && onCommand) {
      setInputValue('');
      closePopover();
      onCommand(item.value);
      return;
    }

    // Non-immediate commands (prompt-based built-ins and skills): show as badge
    if (popoverMode === 'skill') {
      setBadge({
        command: item.value,
        label: item.label,
        description: item.description || '',
        isSkill: !item.builtIn,
        installedSource: item.installedSource,
      });
      setInputValue('');
      closePopover();
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    // File mention: insert into text
    const currentVal = inputValue;
    const before = currentVal.slice(0, triggerPos);
    const cursorEnd = triggerPos + popoverFilter.length + 1;
    const after = currentVal.slice(cursorEnd);
    const insertText = `@${item.value} `;

    setInputValue(before + insertText + after);
    closePopover();

    // Refocus textarea
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [triggerPos, popoverMode, closePopover, onCommand, inputValue, popoverFilter]);

  // Handle input changes to detect @ and /
  const handleInputChange = useCallback(async (val: string) => {
    setInputValue(val);

    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const beforeCursor = val.slice(0, cursorPos);

    // Check for @ trigger
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);
    if (atMatch) {
      const filter = atMatch[1];
      setPopoverMode('file');
      setPopoverFilter(filter);
      setTriggerPos(cursorPos - atMatch[0].length);
      setSelectedIndex(0);
      const items = await fetchFiles(filter);
      setPopoverItems(items);
      return;
    }

    // Check for / trigger (only at start of line or after space)
    const slashMatch = beforeCursor.match(/(^|\s)\/([^\s]*)$/);
    if (slashMatch) {
      const filter = slashMatch[2];
      setPopoverMode('skill');
      setPopoverFilter(filter);
      setTriggerPos(cursorPos - slashMatch[2].length - 1);
      setSelectedIndex(0);
      const items = await fetchSkills();
      setPopoverItems(items);
      return;
    }

    if (popoverMode) {
      closePopover();
    }
  }, [fetchFiles, fetchSkills, popoverMode, closePopover]);

  const handleSubmit = useCallback(async (msg: { text: string; files: Array<{ type: string; url: string; filename?: string; mediaType?: string }> }, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const content = inputValue.trim();

    closePopover();

    // Convert PromptInput FileUIParts (with data URLs) to FileAttachment[]
    const convertFiles = async (): Promise<FileAttachment[]> => {
      if (!msg.files || msg.files.length === 0) return [];

      const attachments: FileAttachment[] = [];
      for (const file of msg.files) {
        if (!file.url) continue;
        try {
          const attachment = await dataUrlToFileAttachment(
            file.url,
            file.filename || 'file',
            file.mediaType || 'application/octet-stream',
          );
          // Enforce per-type size limits
          const isImage = attachment.type.startsWith('image/');
          const sizeLimit = isImage ? MAX_IMAGE_SIZE : MAX_DOC_SIZE;
          if (attachment.size <= sizeLimit) {
            attachments.push(attachment);
          }
        } catch {
          // Skip files that fail conversion
        }
      }
      return attachments;
    };

    // If badge is active, expand the command/skill and send
    if (badge && !isStreaming) {
      let expandedPrompt = '';

      if (badge.isSkill) {
        // Fetch skill content from API
        try {
          const sourceParam = badge.installedSource
            ? `?source=${badge.installedSource}`
            : "";
          const res = await fetch(
            `/api/skills/${encodeURIComponent(badge.label)}${sourceParam}`
          );
          if (res.ok) {
            const data = await res.json();
            expandedPrompt = data.skill?.content || '';
          }
        } catch {
          // Fallback: use command name
        }
      } else {
        // Built-in prompt command expansion
        expandedPrompt = COMMAND_PROMPTS[badge.command] || '';
      }

      const finalPrompt = content
        ? `${expandedPrompt}\n\nUser context: ${content}`
        : expandedPrompt || badge.command;

      const files = await convertFiles();
      setBadge(null);
      setInputValue('');
      onSend(finalPrompt, files.length > 0 ? files : undefined);
      return;
    }

    const files = await convertFiles();
    const hasFiles = files.length > 0;

    if ((!content && !hasFiles) || disabled || isStreaming) return;

    // Check if it's a direct slash command typed in the input
    if (content.startsWith('/') && !hasFiles) {
      const cmd = BUILT_IN_COMMANDS.find(c => c.value === content);
      if (cmd) {
        if (cmd.immediate && onCommand) {
          setInputValue('');
          onCommand(content);
          return;
        }
        // Non-immediate: show as badge for user to add context
        setBadge({
          command: cmd.value,
          label: cmd.label,
          description: cmd.description || '',
          isSkill: false,
        });
        setInputValue('');
        return;
      }

      // Not a built-in command — treat as a skill
      const skillName = content.slice(1);
      if (skillName) {
        setBadge({
          command: content,
          label: skillName,
          description: '',
          isSkill: true,
        });
        setInputValue('');
        return;
      }
    }

    onSend(content || 'Please review the attached file(s).', hasFiles ? files : undefined);
    setInputValue('');
  }, [inputValue, onSend, onCommand, disabled, isStreaming, closePopover, badge]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Popover navigation
      if (popoverMode && popoverItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (filteredItems[selectedIndex]) {
            insertItem(filteredItems[selectedIndex]);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closePopover();
          return;
        }
      }

      // Backspace removes badge when input is empty
      if (e.key === 'Backspace' && badge && !inputValue) {
        e.preventDefault();
        removeBadge();
        return;
      }

      // Escape removes badge
      if (e.key === 'Escape' && badge) {
        e.preventDefault();
        removeBadge();
        return;
      }
    },
    [popoverMode, popoverItems, popoverFilter, selectedIndex, insertItem, closePopover, badge, inputValue, removeBadge]
  );

  // Click outside to close popover
  useEffect(() => {
    if (!popoverMode) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverMode, closePopover]);

  // Click outside to close mode menu
  useEffect(() => {
    if (!modeMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeMenuOpen]);

  // Click outside to close model menu
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelMenuOpen]);

  const filteredItems = popoverItems.filter((item) =>
    item.label.toLowerCase().includes(popoverFilter.toLowerCase())
  );

  const currentModelValue = modelName || 'sonnet';
  const currentModelOption = MODEL_OPTIONS.find((m) => m.value === currentModelValue) || MODEL_OPTIONS[0];
  const currentMode = MODE_OPTIONS.find((m) => m.value === mode) || MODE_OPTIONS[0];

  const folderShortName = workingDirectory
    ? workingDirectory.split('/').filter(Boolean).pop() || workingDirectory
    : '';

  // Map isStreaming to ChatStatus for PromptInputSubmit
  const chatStatus: ChatStatus = isStreaming ? 'streaming' : 'ready';

  return (
    <div className="bg-background/80 backdrop-blur-lg px-4 py-3">
      <div className="mx-auto">
        <div className="relative">
          {/* Popover */}
          {popoverMode && filteredItems.length > 0 && (() => {
            const builtInItems = filteredItems.filter(item => item.builtIn);
            const skillItems = filteredItems.filter(item => !item.builtIn);
            let globalIdx = 0;

            const renderItem = (item: PopoverItem, idx: number) => (
              <button
                key={`${idx}-${item.value}`}
                ref={idx === selectedIndex ? (el) => { el?.scrollIntoView({ block: 'nearest' }); } : undefined}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                  idx === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                )}
                onClick={() => insertItem(item)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                {popoverMode === 'file' ? (
                  <HugeiconsIcon icon={AtIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : item.builtIn && item.icon ? (
                  <HugeiconsIcon icon={item.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : !item.builtIn ? (
                  <HugeiconsIcon icon={GlobalIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <HugeiconsIcon icon={CommandLineIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="font-mono text-xs truncate">{item.label}</span>
                {item.description && (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {item.description}
                  </span>
                )}
                {!item.builtIn && item.installedSource && (
                  <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                    {item.installedSource === 'claude' ? 'Personal' : 'Agents'}
                  </span>
                )}
              </button>
            );

            return (
              <div
                ref={popoverRef}
                className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border bg-popover shadow-lg overflow-hidden z-50"
              >
                {popoverMode === 'skill' ? (
                  <div className="px-3 py-2 border-b">
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Search..."
                      value={popoverFilter}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPopoverFilter(val);
                        setSelectedIndex(0);
                        // Sync textarea: replace the filter portion after /
                        if (triggerPos !== null) {
                          const before = inputValue.slice(0, triggerPos + 1);
                          setInputValue(before + val);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
                        } else if (e.key === 'Enter' || e.key === 'Tab') {
                          e.preventDefault();
                          if (filteredItems[selectedIndex]) {
                            insertItem(filteredItems[selectedIndex]);
                          }
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          closePopover();
                          textareaRef.current?.focus();
                        }
                      }}
                      className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                      autoFocus
                    />
                  </div>
                ) : (
                  <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                    Files
                  </div>
                )}
                <div className="max-h-48 overflow-y-auto py-1">
                  {popoverMode === 'file' ? (
                    filteredItems.map((item, i) => renderItem(item, i))
                  ) : (
                    <>
                      {builtInItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            Commands
                          </div>
                          {builtInItems.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                      {skillItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            Skills
                          </div>
                          {skillItems.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* PromptInput replaces the old input area */}
          <PromptInput
            onSubmit={handleSubmit}
            accept={ACCEPTED_FILE_TYPES}
            multiple
            maxFileSize={MAX_FILE_SIZE}
          >
            {/* Bridge: listens for file tree "+" button events */}
            <FileTreeAttachmentBridge />
            {/* Command badge */}
            {badge && (
              <div className="flex w-full items-center gap-1.5 px-3 pt-2.5 pb-0 order-first">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 pl-2.5 pr-1.5 py-1 text-xs font-medium border border-blue-500/20">
                  <span className="font-mono">{badge.command}</span>
                  {badge.description && (
                    <span className="text-blue-500/60 dark:text-blue-400/60 text-[10px]">{badge.description}</span>
                  )}
                  <button
                    type="button"
                    onClick={removeBadge}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-blue-500/20 transition-colors"
                  >
                    <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 3l6 6M9 3l-6 6" />
                    </svg>
                  </button>
                </span>
              </div>
            )}
            {/* File attachment capsules */}
            <FileAttachmentsCapsules />
            <PromptInputTextarea
              ref={textareaRef}
              placeholder={badge ? "Add details (optional), then press Enter..." : "Message Claude..."}
              value={inputValue}
              onChange={(e) => handleInputChange(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="min-h-10"
            />
            <PromptInputFooter>
              <PromptInputTools>
                {/* Attach file button */}
                <AttachFileButton />

                {/* Folder picker button */}
                <PromptInputButton
                  onClick={() => setFolderPickerOpen(true)}
                  tooltip={workingDirectory || 'Select project folder'}
                >
                  <HugeiconsIcon icon={FolderOpenIcon} className="h-3.5 w-3.5" />
                  <span className="max-w-[120px] truncate text-xs">
                    {folderShortName || 'Folder'}
                  </span>
                </PromptInputButton>

                {/* Mode selector */}
                <div className="relative" ref={modeMenuRef}>
                  <PromptInputButton
                    onClick={() => setModeMenuOpen((prev) => !prev)}
                  >
                    <HugeiconsIcon icon={currentMode.icon} className="h-3.5 w-3.5" />
                    <span className="text-xs">{currentMode.label}</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} className={cn("h-2.5 w-2.5 transition-transform duration-200", modeMenuOpen && "rotate-180")} />
                  </PromptInputButton>

                  {/* Mode dropdown */}
                  {modeMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-56 rounded-lg border bg-popover shadow-lg overflow-hidden z-50">
                      <div className="py-1">
                        {MODE_OPTIONS.map((opt) => {
                          const isActive = opt.value === mode;
                          return (
                            <button
                              key={opt.value}
                              className={cn(
                                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                                isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                              )}
                              onClick={() => {
                                onModeChange?.(opt.value);
                                setModeMenuOpen(false);
                              }}
                            >
                              <HugeiconsIcon icon={opt.icon} className="h-4 w-4 shrink-0" />
                              <div className="flex flex-col min-w-0">
                                <span className="font-medium text-xs">{opt.label}</span>
                                <span className="text-[10px] text-muted-foreground truncate">
                                  {opt.description}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </PromptInputTools>

              <div className="flex items-center gap-1.5">
                {/* Model selector */}
                <div className="relative" ref={modelMenuRef}>
                  <PromptInputButton
                    onClick={() => setModelMenuOpen((prev) => !prev)}
                  >
                    <span className="text-xs font-mono">{currentModelOption.label}</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} className={cn("h-2.5 w-2.5 transition-transform duration-200", modelMenuOpen && "rotate-180")} />
                  </PromptInputButton>

                  {modelMenuOpen && (
                    <div className="absolute bottom-full right-0 mb-1.5 w-48 rounded-lg border bg-popover shadow-lg overflow-hidden z-50">
                      <div className="py-1">
                        {MODEL_OPTIONS.map((opt) => {
                          const isActive = opt.value === currentModelValue;
                          return (
                            <button
                              key={opt.value}
                              className={cn(
                                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                                isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                              )}
                              onClick={() => {
                                onModelChange?.(opt.value);
                                setModelMenuOpen(false);
                              }}
                            >
                              <span className="font-mono text-xs">{opt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <FileAwareSubmitButton
                  status={chatStatus}
                  onStop={onStop}
                  disabled={disabled}
                  inputValue={inputValue}
                  hasBadge={!!badge}
                />
              </div>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

      {/* FolderPicker dialog */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={(dir) => {
          onWorkingDirectoryChange?.(dir);
        }}
        initialPath={workingDirectory || undefined}
      />
    </div>
  );
}
