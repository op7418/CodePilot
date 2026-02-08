'use client';

import { useRef, useState, useCallback, useEffect, type KeyboardEvent, type FormEvent } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AtIcon,
  DivideSignIcon,
  FolderOpenIcon,
  Wrench01Icon,
  ClipboardIcon,
  HelpCircleIcon,
  ArrowDown01Icon,
  CommandLineIcon,
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
} from '@/components/ai-elements/prompt-input';
import type { ChatStatus } from 'ai';

interface MessageInputProps {
  onSend: (content: string) => void;
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
}

type PopoverMode = 'file' | 'skill' | null;

const BUILT_IN_COMMANDS: PopoverItem[] = [
  { label: 'help', value: '/help', description: 'Show help information', builtIn: true },
  { label: 'clear', value: '/clear', description: 'Clear conversation', builtIn: true },
  { label: 'compact', value: '/compact', description: 'Compress conversation context', builtIn: true },
  { label: 'cost', value: '/cost', description: 'Show token usage', builtIn: true },
  { label: 'doctor', value: '/doctor', description: 'Check system health', builtIn: true },
  { label: 'init', value: '/init', description: 'Initialize CLAUDE.md', builtIn: true },
  { label: 'review', value: '/review', description: 'Code review', builtIn: true },
  { label: 'terminal-setup', value: '/terminal-setup', description: 'Terminal configuration', builtIn: true },
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

const CLAUDE_MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet 4.5' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

const OPENROUTER_MODEL_OPTIONS = [
  { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
  { value: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { value: 'anthropic/claude-opus-4', label: 'Claude Opus 4' },
  { value: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6' },
  { value: 'anthropic/claude-haiku-3.5', label: 'Claude Haiku 3.5' },
  { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
  { value: 'openai/o3', label: 'o3' },
  { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3' },
  { value: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
];

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
  const [apiProvider, setApiProvider] = useState<'claude_code' | 'openrouter'>('claude_code');
  const [customDefaultModel, setCustomDefaultModel] = useState<string>('');
  const prevProviderRef = useRef(apiProvider);

  // Fetch current provider setting on mount, on focus, and listen for changes
  useEffect(() => {
    const fetchProvider = () => {
      fetch('/api/settings/app', { cache: 'no-store' })
        .then((r) => r.json())
        .then((data) => {
          const p = data.settings?.api_provider;
          if (p === 'openrouter') setApiProvider('openrouter');
          else setApiProvider('claude_code');
          // Also read the custom default model from settings
          const orModel = data.settings?.openrouter_model;
          if (orModel) setCustomDefaultModel(orModel);
        })
        .catch(() => {});
    };
    fetchProvider();
    const handler = () => fetchProvider();
    // Re-fetch when settings saved, window focused, or page becomes visible
    window.addEventListener('provider-changed', handler);
    window.addEventListener('focus', handler);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') handler();
    });
    return () => {
      window.removeEventListener('provider-changed', handler);
      window.removeEventListener('focus', handler);
    };
  }, []);

  // When provider changes, auto-switch model to the default of the new provider
  useEffect(() => {
    if (prevProviderRef.current !== apiProvider) {
      prevProviderRef.current = apiProvider;
      if (apiProvider === 'openrouter' && customDefaultModel) {
        onModelChange?.(customDefaultModel);
      } else {
        const newOptions = apiProvider === 'openrouter' ? OPENROUTER_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
        onModelChange?.(newOptions[0].value);
      }
    }
  }, [apiProvider, onModelChange, customDefaultModel]);

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
  const fetchSkills = useCallback(async (filter: string) => {
    const builtIn = BUILT_IN_COMMANDS.filter((cmd) =>
      cmd.label.toLowerCase().includes(filter.toLowerCase())
    );

    let apiSkills: PopoverItem[] = [];
    try {
      const res = await fetch('/api/skills');
      if (res.ok) {
        const data = await res.json();
        const skills = data.skills || [];
        apiSkills = skills
          .filter((s: { name: string; enabled: boolean }) => s.enabled && s.name.toLowerCase().includes(filter.toLowerCase()))
          .map((s: { name: string; description: string }) => ({
            label: s.name,
            value: `/${s.name}`,
            description: s.description,
            builtIn: false,
          }));
      }
    } catch {
      // API not available - just use built-in commands
    }

    return [...builtIn, ...apiSkills].slice(0, 20);
  }, []);

  // Close popover
  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
  }, []);

  // Insert selected item
  const insertItem = useCallback((item: PopoverItem) => {
    if (triggerPos === null) return;

    // Built-in commands: execute immediately
    if (item.builtIn && onCommand) {
      setInputValue('');
      closePopover();
      onCommand(item.value);
      return;
    }

    const currentVal = inputValue;
    const before = currentVal.slice(0, triggerPos);
    const cursorEnd = triggerPos + (popoverMode === 'file' ? popoverFilter.length + 1 : popoverFilter.length + 1);
    const after = currentVal.slice(cursorEnd);
    const insertText = popoverMode === 'file' ? `@${item.value} ` : `${item.value} `;

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
      const items = await fetchSkills(filter);
      setPopoverItems(items);
      return;
    }

    if (popoverMode) {
      closePopover();
    }
  }, [fetchFiles, fetchSkills, popoverMode, closePopover]);

  const filteredItems = popoverItems.filter((item) =>
    item.label.toLowerCase().includes(popoverFilter.toLowerCase())
  );

  const handleSubmit = useCallback((_msg: { text: string; files: unknown[] }, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const content = inputValue.trim();
    if (!content || disabled) return;

    closePopover();

    // Check if it's a built-in command
    const builtInCmd = BUILT_IN_COMMANDS.find(cmd => cmd.value === content);
    if (builtInCmd && onCommand) {
      onCommand(content);
    } else {
      onSend(content);
    }

    setInputValue('');
  }, [inputValue, onSend, onCommand, disabled, closePopover]);

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
    },
    [popoverMode, popoverItems, filteredItems, selectedIndex, insertItem, closePopover]
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

  // Build model options: preset list + custom default model if not already included
  const baseModelOptions = apiProvider === 'openrouter' ? OPENROUTER_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
  const MODEL_OPTIONS = (() => {
    if (apiProvider !== 'openrouter' || !customDefaultModel) return baseModelOptions;
    // If the custom model from settings is not in the preset list, add it at the top
    if (!baseModelOptions.some((m) => m.value === customDefaultModel)) {
      // Generate a friendly label from the model ID (e.g. "anthropic/claude-opus-4.6" → "claude-opus-4.6")
      const shortLabel = customDefaultModel.includes('/')
        ? customDefaultModel.split('/').pop() || customDefaultModel
        : customDefaultModel;
      return [{ value: customDefaultModel, label: shortLabel }, ...baseModelOptions];
    }
    return baseModelOptions;
  })();
  const currentModelValue = modelName || MODEL_OPTIONS[0].value;
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
          {popoverMode && filteredItems.length > 0 && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border bg-popover shadow-lg overflow-hidden z-50"
            >
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                {popoverMode === 'file' ? 'Files' : 'Commands'}
              </div>
              <div className="max-h-48 overflow-y-auto py-1">
                {filteredItems.map((item, i) => (
                  <button
                    key={item.value}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                      i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                    )}
                    onClick={() => insertItem(item)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    {popoverMode === 'file' ? (
                      <HugeiconsIcon icon={AtIcon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : item.builtIn ? (
                      <HugeiconsIcon icon={CommandLineIcon} className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                    ) : (
                      <HugeiconsIcon icon={DivideSignIcon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-mono text-xs truncate">{item.label}</span>
                    {item.builtIn && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 font-medium shrink-0">
                        Built-in
                      </span>
                    )}
                    {item.description && (
                      <span className="ml-auto text-xs text-muted-foreground truncate max-w-[200px]">
                        {item.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* PromptInput replaces the old input area */}
          <PromptInput
            onSubmit={handleSubmit}
          >
            <PromptInputTextarea
              ref={textareaRef}
              placeholder="Message Claude..."
              value={inputValue}
              onChange={(e) => handleInputChange(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled || isStreaming}
              className="min-h-10"
            />
            <PromptInputFooter>
              <PromptInputTools>
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
                    <HugeiconsIcon icon={ArrowDown01Icon} className="h-2.5 w-2.5" />
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
                    <HugeiconsIcon icon={ArrowDown01Icon} className="h-2.5 w-2.5" />
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

                <PromptInputSubmit
                  status={chatStatus}
                  onStop={onStop}
                  disabled={disabled || (!isStreaming && !inputValue.trim())}
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
