'use client';

import { useRef, useState, useCallback, useEffect, type KeyboardEvent, type FormEvent, type DragEvent as ReactDragEvent } from 'react';
import { Terminal } from "@/components/ui/icon";
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
} from '@/components/ai-elements/prompt-input';
import type { ChatStatus } from 'ai';
import type { FileAttachment } from '@/types';
import { SlashCommandButton } from './SlashCommandButton';
import { SlashCommandPopover } from './SlashCommandPopover';
import { CliToolsPopover } from './CliToolsPopover';
import { ModelSelectorDropdown } from './ModelSelectorDropdown';
import { EffortSelectorDropdown } from './EffortSelectorDropdown';
import { FileAwareSubmitButton, AttachFileButton, FileTreeAttachmentBridge, FileAttachmentsCapsules, CommandBadgeList, CliBadge } from './MessageInputParts';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useImageGen } from '@/hooks/useImageGen';
import { PENDING_KEY, setRefImages, deleteRefImages } from '@/lib/image-ref-store';
import { IMAGE_AGENT_SYSTEM_PROMPT } from '@/lib/constants/image-agent-prompt';
import { dataUrlToFileAttachment } from '@/lib/file-utils';
import { usePopoverState } from '@/hooks/usePopoverState';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useCommandBadge } from '@/hooks/useCommandBadge';
import { useCliToolsFetch } from '@/hooks/useCliToolsFetch';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { resolveKeyAction, cycleIndex, resolveDirectSlash, dispatchBadge, buildCliAppend } from '@/lib/message-input-logic';
import { QuickActions } from './QuickActions';
import { appendPathMention, hasFileTreeDragType, readFileTreeDragPayload } from '@/lib/file-tree-dnd';
import { cn } from '@/lib/utils';

interface MessageInputProps {
  onSend: (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string) => void;
  onCommand?: (command: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  sessionId?: string;
  modelName?: string;
  onModelChange?: (model: string) => void;
  providerId?: string;
  onProviderModelChange?: (providerId: string, model: string) => void;
  workingDirectory?: string;
  onAssistantTrigger?: () => void;
  /** Effort selection lifted to parent for inclusion in the stream chain */
  effort?: string;
  onEffortChange?: (effort: string | undefined) => void;
  /** SDK init metadata — when available, used to validate command/skill availability */
  sdkInitMeta?: { tools?: unknown; slash_commands?: unknown; skills?: unknown } | null;
  /** Initial value to prefill in the input */
  initialValue?: string;
  /** Whether this session is an assistant workspace project */
  isAssistantProject?: boolean;
  /** Whether the session already has messages */
  hasMessages?: boolean;
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
  providerId,
  onProviderModelChange,
  workingDirectory,
  onAssistantTrigger,
  effort: effortProp,
  onEffortChange,
  sdkInitMeta,
  initialValue,
  isAssistantProject,
  hasMessages,
}: MessageInputProps) {
  const { t, locale } = useTranslation();
  const imageGen = useImageGen();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cliSearchRef = useRef<HTMLInputElement>(null);
  const [isFileTreeDragOver, setIsFileTreeDragOver] = useState(false);
  // Persist draft per session so switching chats doesn't lose typed text.
  const draftKey = `codepilot:draft:${sessionId || 'new'}`;
  const [inputValue, setInputValueRaw] = useState(() => {
    if (initialValue) return initialValue;
    try { return sessionStorage.getItem(draftKey) || ''; } catch { return ''; }
  });
  const setInputValue = useCallback((v: string | ((prev: string) => string)) => {
    setInputValueRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try { if (next) sessionStorage.setItem(draftKey, next); else sessionStorage.removeItem(draftKey); } catch { /* quota */ }
      return next;
    });
  }, [draftKey]);

  // --- Extracted hooks ---
  const popover = usePopoverState(modelName);
  const { providerGroups, currentProviderIdValue, modelOptions, currentModelOption, globalDefaultModel, globalDefaultProvider } = useProviderModels(providerId, modelName);

  // Auto-correct model when it doesn't exist in the current provider's model list.
  // This prevents sending an unsupported model name (e.g. 'opus' to MiniMax which only has 'sonnet').
  // IMPORTANT: Only fall back to first model — never use globalDefaultModel here.
  // Global default model is only for NEW conversations (chat/page.tsx).
  // Existing sessions must keep their own selected model; if that model becomes
  // invalid (provider changed), fall back to the provider's first model, not the
  // global default, to avoid overwriting the session's model choice.
  useEffect(() => {
    if (modelName && modelOptions.length > 0 && !modelOptions.some(m => m.value === modelName)) {
      const fallback = modelOptions[0].value;
      onModelChange?.(fallback);
      onProviderModelChange?.(currentProviderIdValue, fallback);
    }
  }, [modelName, modelOptions, currentProviderIdValue, onModelChange, onProviderModelChange]);

  const { badges, addBadge, removeBadge, clearBadges, cliBadge, setCliBadge, removeCliBadge, hasBadge } = useCommandBadge(textareaRef);

  const cliToolsFetch = useCliToolsFetch({
    popoverMode: popover.popoverMode,
    closePopover: popover.closePopover,
    setPopoverMode: popover.setPopoverMode,
    setSelectedIndex: popover.setSelectedIndex,
    inputValue,
    locale,
    textareaRef,
    cliSearchRef,
    setCliBadge,
    setInputValue,
  });

  const slashCommands = useSlashCommands({
    sessionId,
    workingDirectory,
    sdkInitMeta,
    textareaRef,
    inputValue,
    setInputValue,
    popoverMode: popover.popoverMode,
    popoverFilter: popover.popoverFilter,
    triggerPos: popover.triggerPos,
    setPopoverMode: popover.setPopoverMode,
    setPopoverFilter: popover.setPopoverFilter,
    setPopoverItems: popover.setPopoverItems,
    setSelectedIndex: popover.setSelectedIndex,
    setTriggerPos: popover.setTriggerPos,
    closePopover: popover.closePopover,
    onCommand,
    addBadge,
    isStreaming: !!isStreaming,
  });

  // Assistant trigger on first focus
  const assistantTriggerFired = useRef(false);
  const handleAssistantFocus = useCallback(() => {
    if (!assistantTriggerFired.current && onAssistantTrigger) {
      assistantTriggerFired.current = true;
      onAssistantTrigger();
    }
  }, [onAssistantTrigger]);

  const handleInsertPathMention = useCallback((filePath: string) => {
    if (!filePath) return;
    setInputValue((prev) => appendPathMention(prev, filePath));
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [setInputValue]);

  // Listen for file tree "+" button: insert @filepath into textarea
  useEffect(() => {
    const handler = (e: Event) => {
      const filePath = (e as CustomEvent<{ path: string }>).detail?.path;
      handleInsertPathMention(filePath);
    };
    window.addEventListener('insert-file-mention', handler);
    return () => window.removeEventListener('insert-file-mention', handler);
  }, [handleInsertPathMention]);

  const handleFileTreeDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileTreeDragType(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsFileTreeDragOver(true);
  }, []);

  const handleFileTreeDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsFileTreeDragOver(false);
  }, []);

  const handleFileTreeDrop = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    const payload = readFileTreeDragPayload(e.dataTransfer);
    if (!payload) return;

    e.preventDefault();
    setIsFileTreeDragOver(false);
    handleInsertPathMention(payload.path);

    if (payload.type === 'file') {
      window.dispatchEvent(new CustomEvent('attach-file-to-chat', { detail: { path: payload.path } }));
    }
  }, [handleInsertPathMention]);

  const handleSubmit = useCallback(async (msg: { text: string; files: Array<{ type: string; url: string; filename?: string; mediaType?: string }> }, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const content = inputValue.trim();

    popover.closePopover();

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
          attachments.push(attachment);
        } catch {
          // Skip files that fail conversion
        }
      }
      return attachments;
    };

    // If Image Agent toggle is on and no badge, send via normal LLM with systemPromptAppend.
    // PENDING_KEY is a global singleton — queuing would misattach refs, so block entirely
    // during streaming rather than letting it fall through to the plain queue path.
    if (imageGen.state.enabled && badges.length === 0) {
      if (isStreaming) return; // silently block — can't safely queue image-agent prompts
      const files = await convertFiles();
      if (!content && files.length === 0) return;

      // Store uploaded images as pending reference images for ImageGenConfirmation
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        setRefImages(PENDING_KEY, imageFiles.map(f => ({ mimeType: f.type, data: f.data })));
      } else {
        deleteRefImages(PENDING_KEY);
      }

      setInputValue('');
      if (onSend) {
        onSend(content, files.length > 0 ? files : undefined, IMAGE_AGENT_SYSTEM_PROMPT);
      }
      return;
    }

    // If one or more badges are active, dispatch by kind (multi-skill combines).
    // Block during streaming — badges carry slash/skill semantics, not safe to queue.
    if (badges.length > 0) {
      if (isStreaming) return;
      const files = await convertFiles();
      const { prompt, displayLabel } = dispatchBadge(badges, content);
      clearBadges();
      setInputValue('');
      onSend(prompt, files.length > 0 ? files : undefined, undefined, displayLabel);
      return;
    }

    const files = await convertFiles();
    const hasFiles = files.length > 0;

    if ((!content && !hasFiles) || disabled) return;

    // Check if it's a direct slash command typed in the input.
    if (!hasFiles) {
      const slashResult = resolveDirectSlash(content);
      if (slashResult.action === 'immediate_command' || slashResult.action === 'set_badge' || slashResult.action === 'unknown_slash_badge') {
        // Slash commands must NOT execute or queue during streaming —
        // destructive commands (e.g. /clear) would race with the active stream.
        if (isStreaming) return;
        if (slashResult.action === 'immediate_command') {
          if (onCommand) {
            setInputValue('');
            onCommand(slashResult.commandValue!);
            return;
          }
        } else {
          addBadge(slashResult.badge!);
          setInputValue('');
          return;
        }
      }
    }

    // If CLI badge is active, inject systemPromptAppend to guide model
    const cliAppend = buildCliAppend(cliBadge);
    if (cliBadge) setCliBadge(null);

    onSend(content || 'Please review the attached file(s).', hasFiles ? files : undefined, cliAppend);
    setInputValue('');
  }, [inputValue, onSend, onCommand, disabled, isStreaming, popover, badges, cliBadge, imageGen, addBadge, clearBadges, setCliBadge, setInputValue]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const action = resolveKeyAction(e.key, {
        popoverMode: popover.popoverMode,
        popoverHasItems: popover.popoverItems.length > 0,
        inputValue,
        hasBadge: badges.length > 0,
        hasCliBadge: !!cliBadge,
      });

      switch (action.type) {
        case 'popover_navigate':
          e.preventDefault();
          popover.setSelectedIndex((prev) =>
            cycleIndex(prev, action.direction, popover.allDisplayedItems.length),
          );
          return;

        case 'popover_select':
          e.preventDefault();
          if (popover.allDisplayedItems[popover.selectedIndex]) {
            slashCommands.insertItem(popover.allDisplayedItems[popover.selectedIndex]);
          }
          return;

        case 'close_popover':
          e.preventDefault();
          popover.closePopover();
          return;

        case 'remove_badge':
          e.preventDefault();
          // Backspace/Escape pops the most recently added badge; matches the
          // mental model of "undo my last selection".
          if (badges.length > 0) removeBadge(badges[badges.length - 1].command);
          return;

        case 'remove_cli_badge':
          e.preventDefault();
          removeCliBadge();
          return;

        case 'passthrough':
          break;
      }

      // CLI popover keyboard navigation (not covered by resolveKeyAction)
      if (popover.popoverMode === 'cli' && cliToolsFetch.cliTools.length > 0) {
        const q = cliToolsFetch.cliFilter.toLowerCase();
        const filtered = cliToolsFetch.cliTools.filter(t =>
          t.name.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)
        );
        if (filtered.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            popover.setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            popover.setSelectedIndex((prev) => Math.max(prev - 1, 0));
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (filtered[popover.selectedIndex]) cliToolsFetch.handleCliSelect(filtered[popover.selectedIndex]);
            return;
          }
        }
      }
    },
    [popover, slashCommands, cliToolsFetch, badges, cliBadge, inputValue, removeBadge, removeCliBadge]
  );

  // Effort selector state — guard against undefined when model not found in current provider's list
  const currentModelMeta = currentModelOption as (typeof currentModelOption & { supportsEffort?: boolean; supportedEffortLevels?: string[] }) | undefined;
  const showEffortSelector = currentModelMeta?.supportsEffort === true;
  const [localEffort, setLocalEffort] = useState<string>('high');
  const selectedEffort = effortProp ?? localEffort;
  const setSelectedEffort = useCallback((v: string) => {
    setLocalEffort(v);
    onEffortChange?.(v);
  }, [onEffortChange]);

  const currentModelValue = modelName || 'sonnet';
  const chatStatus: ChatStatus = isStreaming ? 'streaming' : 'ready';

  return (
    <div className="bg-background/80 backdrop-blur-lg px-4 pt-2 pb-1">
      <div className="mx-auto">
        <div
          className={cn(
            "relative",
            isFileTreeDragOver && "rounded-xl ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
          )}
          onDragLeave={handleFileTreeDragLeave}
          onDragOver={handleFileTreeDragOver}
          onDrop={handleFileTreeDrop}
        >
          {/* Slash Command / File Popover */}
          <SlashCommandPopover
            popoverMode={popover.popoverMode}
            popoverRef={popover.popoverRef}
            filteredItems={popover.filteredItems}
            aiSuggestions={popover.aiSuggestions}
            aiSearchLoading={popover.aiSearchLoading}
            selectedIndex={popover.selectedIndex}
            popoverFilter={popover.popoverFilter}
            inputValue={inputValue}
            triggerPos={popover.triggerPos}
            searchInputRef={searchInputRef}
            allDisplayedItems={popover.allDisplayedItems}
            onInsertItem={slashCommands.insertItem}
            onSetSelectedIndex={popover.setSelectedIndex}
            onSetPopoverFilter={popover.setPopoverFilter}
            onSetInputValue={setInputValue}
            onClosePopover={popover.closePopover}
            onFocusTextarea={() => textareaRef.current?.focus()}
          />

          {/* CLI Tools Popover */}
          {popover.popoverMode === 'cli' && (
            <CliToolsPopover
              popoverRef={popover.popoverRef}
              cliTools={cliToolsFetch.cliTools}
              cliFilter={cliToolsFetch.cliFilter}
              selectedIndex={popover.selectedIndex}
              cliSearchRef={cliSearchRef}
              onSetCliFilter={cliToolsFetch.setCliFilter}
              onSetSelectedIndex={popover.setSelectedIndex}
              onCliSelect={cliToolsFetch.handleCliSelect}
              onClosePopover={popover.closePopover}
              onFocusTextarea={() => textareaRef.current?.focus()}
            />
          )}

          {/* Quick Actions — memory-driven suggestion chips */}
          <QuickActions
            isAssistantProject={!!isAssistantProject}
            hasMessages={!!hasMessages}
            onAction={(text) => {
              onSend(text);
              // Clear input after send to avoid stale text
              setInputValue('');
            }}
          />

          {/* PromptInput replaces the old input area */}
          <PromptInput
            onSubmit={handleSubmit}
            accept=""
            multiple
          >
            {/* Bridge: listens for file tree "+" button events */}
            <FileTreeAttachmentBridge />
            {/* Command badges (multi-skill stacks; other kinds are singletons) */}
            <CommandBadgeList badges={badges} onRemove={removeBadge} />
            {/* CLI badge */}
            {cliBadge && (
              <CliBadge name={cliBadge.name} onRemove={removeCliBadge} />
            )}
            {/* File attachment capsules */}
            <FileAttachmentsCapsules />
            <PromptInputTextarea
              ref={textareaRef}
              placeholder={badges.length > 0 ? "Add details (optional), then press Enter..." : cliBadge ? "Describe what you want to do..." : "Message Claude..."}
              value={inputValue}
              onChange={(e) => slashCommands.handleInputChange(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              onFocus={handleAssistantFocus}
              disabled={disabled}
              className="min-h-10"
            />
            <PromptInputFooter>
              <PromptInputTools>
                {/* Attach file button */}
                <AttachFileButton />

                {/* Slash command button */}
                <SlashCommandButton onInsertSlash={slashCommands.handleInsertSlash} />

                {/* CLI tools button */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PromptInputButton onClick={cliToolsFetch.handleOpenCliPopover}>
                      <Terminal size={16} />
                    </PromptInputButton>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('cliTools.selectTool' as TranslationKey)}
                  </TooltipContent>
                </Tooltip>

                {/* Model selector */}
                <ModelSelectorDropdown
                  currentModelValue={currentModelValue}
                  currentProviderIdValue={currentProviderIdValue}
                  providerGroups={providerGroups}
                  modelOptions={modelOptions}
                  onModelChange={onModelChange}
                  onProviderModelChange={onProviderModelChange}
                  globalDefaultModel={globalDefaultModel}
                  globalDefaultProvider={globalDefaultProvider}
                />

                {/* Effort selector — only visible when model supports effort */}
                {showEffortSelector && (
                  <EffortSelectorDropdown
                    selectedEffort={selectedEffort}
                    onEffortChange={setSelectedEffort}
                    supportedEffortLevels={currentModelMeta?.supportedEffortLevels}
                  />
                )}

              </PromptInputTools>

              <FileAwareSubmitButton
                status={chatStatus}
                onStop={onStop}
                disabled={disabled}
                inputValue={inputValue}
                hasBadge={hasBadge}
                isImageAgentOn={imageGen.state.enabled}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

    </div>
  );
}
