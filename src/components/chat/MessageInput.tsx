'use client';

import { memo, useRef, useState, useCallback, useEffect, useMemo, type KeyboardEvent, type FormEvent } from 'react';
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionAddAttachments,
} from '@/components/ai-elements/prompt-input';
import type { ChatStatus } from 'ai';
import type { FileAttachment, MentionRef } from '@/types';
import { SlashCommandPopover } from './SlashCommandPopover';
import { CliToolsPopover } from './CliToolsPopover';
import { ModelSelectorDropdown } from './ModelSelectorDropdown';
import { EffortSelectorDropdown } from './EffortSelectorDropdown';
import { FileAwareSubmitButton, FileTreeAttachmentBridge, FileAttachmentsCapsules, CliBadge, ComposerBadgeRow, DirectoryRefsCapsules, AttachmentPendingTracker } from './MessageInputParts';
import { useMentionTokenEstimate } from '@/hooks/useMentionTokenEstimate';
import { dataUrlToFileAttachment } from '@/lib/file-utils';
import { usePopoverState } from '@/hooks/usePopoverState';
import { useProviderModels, isComposerProviderLoading } from '@/hooks/useProviderModels';
import { resolveComposerModelAutoCorrect } from '@/lib/model-option-match';
// Import from `chat-runtime-shared` (client-safe). See ChatView import
// note + `src/lib/chat-runtime-shared.ts` doc-block. Even type-only
// imports from `chat-runtime.ts` are risky if the build leans on
// runtime resolution paths; the shared module is the future-proof
// choice for any client bundle.
import type { ChatRuntimeParam } from '@/lib/chat-runtime-shared';
import { useCommandBadge } from '@/hooks/useCommandBadge';
import { useCliToolsFetch } from '@/hooks/useCliToolsFetch';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import {
  resolveKeyAction,
  cycleIndex,
  resolveDirectSlash,
  dispatchBadge,
  buildCliAppend,
  parseMentionRefs,
  dedupeMentionsByPath,
  computePendingContextTokens,
  computePendingContextSubTotals,
  type PendingContextSubTotals,
  composeSubmitPayload,
} from '@/lib/message-input-logic';
import { QuickActions } from './QuickActions';

const MAX_MENTION_FILE_BYTES = 256 * 1024; // 256KB per @file mention
const MAX_MENTION_FILE_COUNT = 6;
const MAX_DIRECTORY_MENTION_COUNT = 3;
const MAX_DIRECTORY_PREVIEW_ITEMS = 30;

interface MessageInputProps {
  onSend: (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string, mentions?: MentionRef[], selectedSkills?: readonly string[]) => void;
  onCommand?: (command: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  sessionId?: string;
  modelName?: string;
  onModelChange?: (model: string) => void;
  providerId?: string;
  /**
   * Phase 6 P0 (2026-05-15) — `opts.isAuto` differentiates the
   * MessageInput auto-correct fallback (model→firstCompatibleModel
   * when the user's saved model isn't reachable under the active
   * runtime) from a manual user pick in the dropdown. Manual picks
   * are the only path that should clear `invalidDefault` /
   * `noCompatibleProvider`, write to localStorage as the new
   * "recently used", or PATCH the session row. Auto-correct just
   * synchronises display state.
   */
  onProviderModelChange?: (
    providerId: string,
    model: string,
    opts?: { isAuto?: boolean },
  ) => void;
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
  /** Notify parent when the total estimated tokens of currently
   *  attached @ mention chips changes. Used to surface "+10K 待加"
   *  in the Run status panel before the message is sent. */
  onPendingContextTokensChange?: (tokens: number) => void;
  /** Phase 6 Phase 3 — per-source split of the same number. When wired
   *  on the parent, flows through to useContextUsage so the popover's
   *  pending kinds (files_attachments) render real per-source breakdowns.
   *  Independent from onPendingContextTokensChange — parents may listen
   *  to either or both. */
  onPendingContextSubTotalsChange?: (subTotals: PendingContextSubTotals) => void;
  /**
   * Round 2 — Run Checkpoint blocking. When non-empty, handleSubmit
   * silently no-ops (the active banner already explains why and
   * carries the confirm-and-send button). Bypassed by the
   * `run-checkpoint-confirm-send` window event so the page can
   * trigger send from the banner without flipping this prop first.
   */
  blockingReasonIds?: ReadonlyArray<string>;
  /**
   * Phase 2 Step 3b — runtime gate for the picker feed.
   *   - `'auto'`: new chat, follow global `agent_runtime`.
   *   - `'claude_code'` / `'codepilot_runtime'`: existing session with
   *     a `runtime_pin` — picker shows only what THIS session can
   *     reach, immune to global flips.
   * Required (no default) so a new caller can't silently inherit the
   * old "auto = follow global, drift on flip" behavior.
   */
  runtime: ChatRuntimeParam;
}

function joinPath(base: string, rel: string): string {
  const b = base.replace(/[\\/]+$/, '');
  const r = rel.replace(/^[\\/]+/, '');
  return `${b}/${r}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fileResponseToAttachment(
  response: Response,
  filename: string,
  idPrefix: string,
): Promise<FileAttachment> {
  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = await response.arrayBuffer();
  return {
    id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: filename,
    type: mimeType,
    size: buffer.byteLength,
    data: arrayBufferToBase64(buffer),
  };
}

export const MessageInput = memo(function MessageInput({
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
  runtime,
  effort: effortProp,
  onEffortChange,
  sdkInitMeta,
  initialValue,
  isAssistantProject,
  hasMessages,
  onPendingContextTokensChange,
  onPendingContextSubTotalsChange,
  blockingReasonIds,
}: MessageInputProps) {
  const { t, locale } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Run Checkpoint bypass — Round 2 (2026-04-30). When the banner's
  // confirm action fires (via the `run-checkpoint-confirm-send` window
  // event), we set this ref true synchronously, then programmatically
  // re-trigger the submit button. handleSubmit reads + clears the ref
  // on each call so the bypass only applies to the immediately-next
  // submission.
  const bypassBlockingRef = useRef(false);
  // Persist draft per session so switching chats doesn't lose typed text.
  const draftKey = `codepilot:draft:${sessionId || 'new'}`;
  const [inputValue, setInputValueRaw] = useState(() => {
    if (initialValue) return initialValue;
    try { return sessionStorage.getItem(draftKey) || ''; } catch { return ''; }
  });
  // Track the last `initialValue` we've reconciled so the warm-navigation
  // sync below fires only when the prop ACTUALLY transitions (not on every
  // render where it's stable). State (not a ref) so the reconcile can run
  // during render — reading a ref during render is itself a React Compiler
  // bailout. Initialised to the mount-time `initialValue`, so the first
  // render is a no-op and we don't double-set inputValue.
  const [seenInitialValue, setSeenInitialValue] = useState(initialValue);
  const [mentionNodeTypes, setMentionNodeTypes] = useState<Record<string, 'file' | 'directory'>>({});
  // Directories attached via the file tree's "+" button. Kept separate
  // from textarea-driven `@folder` mentions so the chip lives in the
  // green-capsule attachment row (visual parity with file/image
  // attachments) instead of writing `@path/` text into the textarea.
  const [directoryRefs, setDirectoryRefs] = useState<string[]>([]);
  const [badgeOrder, setBadgeOrder] = useState<Record<string, number>>({});
  const [mentionOrder, setMentionOrder] = useState<Record<string, number>>({});
  const orderSeqRef = useRef(0);
  const setInputValue = useCallback((v: string | ((prev: string) => string)) => {
    setInputValueRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try { if (next) sessionStorage.setItem(draftKey, next); else sessionStorage.removeItem(draftKey); } catch { /* quota */ }
      return next;
    });
  }, [draftKey]);

  // Warm-navigation prefill sync. The `useState` initialiser above only
  // runs at mount — if `initialValue` arrives later (e.g. /chat is already
  // mounted and the URL changes to /chat?prefill=…, or the parent reads URL
  // via `useSearchParams` after first paint), the textarea would otherwise
  // stay empty. React's "adjust state when a prop changes" pattern (render
  // time, not an effect — https://react.dev/learn/you-might-not-need-an-effect):
  // when `initialValue` transitions to a new value we adopt it; when it goes
  // back to empty we just record the transition so a later re-arrival of the
  // same prefill text counts as fresh. `setInputValueRaw` (not setInputValue)
  // because we're mid-render — the persisted-draft write happens on the next
  // user keystroke, and a URL prefill is re-derivable from the URL anyway.
  if (initialValue !== seenInitialValue) {
    setSeenInitialValue(initialValue);
    if (initialValue) {
      setInputValueRaw(initialValue);
    }
  }

  // Phase 4 — `codepilot:add-to-chat` listener. Selection from
  // PreviewPanel dispatches a window event with the selected text +
  // source metadata; we wrap the quote in a markdown blockquote and
  // append a provenance line so the AI sees both content and source.
  // The composer treats it as a normal prefill — the user can still
  // edit before sending, and badge / mention parsing kicks in
  // naturally because the appended content is plain text.
  useEffect(() => {
    function handle(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (!detail || typeof detail !== 'object') return;
      const d = detail as { text?: unknown; sourcePath?: unknown; sourceAnchor?: unknown; sourceLabel?: unknown };
      if (typeof d.text !== 'string' || typeof d.sourcePath !== 'string') return;
      const provenance =
        '> [来源] ' +
        d.sourcePath +
        (typeof d.sourceAnchor === 'string' ? d.sourceAnchor : '') +
        (typeof d.sourceLabel === 'string' ? ' — ' + d.sourceLabel : '');
      const quote = d.text
        .split(/\r?\n/)
        .map((l) => '> ' + l)
        .join('\n');
      const composed = `${provenance}\n${quote}\n\n`;
      setInputValue((prev) => (prev ? `${prev}\n\n${composed}` : composed));
    }
    window.addEventListener('codepilot:add-to-chat', handle);
    return () => window.removeEventListener('codepilot:add-to-chat', handle);
  }, [setInputValue]);

  const mentions = useMemo(() => {
    // Render chips only for explicitly inserted/known mentions.
    return parseMentionRefs(inputValue, mentionNodeTypes).filter((m) => !!mentionNodeTypes[m.path]);
  }, [inputValue, mentionNodeTypes]);

  const nextOrder = useCallback(() => {
    orderSeqRef.current += 1;
    return orderSeqRef.current;
  }, []);

  const ensureBadgeOrder = useCallback((command: string) => {
    setBadgeOrder((prev) => {
      if (prev[command]) return prev;
      return { ...prev, [command]: nextOrder() };
    });
  }, [nextOrder]);

  const ensureMentionOrder = useCallback((path: string) => {
    setMentionOrder((prev) => {
      if (prev[path]) return prev;
      return { ...prev, [path]: nextOrder() };
    });
  }, [nextOrder]);

  // --- Extracted hooks ---
  const popover = usePopoverState(modelName);
  const { providerGroups, runtimeApplied, currentProviderIdValue, modelOptions, currentModelOption, globalDefaultModel, globalDefaultProvider, fetchState } = useProviderModels(providerId, modelName, runtime);
  // P0.4 — only show "正在准备运行环境…" during the genuine first load, not
  // on a background refetch when a sendable model is already resolved.
  const isProviderLoading = isComposerProviderLoading(fetchState, !!currentModelOption);

  // Auto-correct model when it doesn't exist in the current provider's model list.
  // This prevents sending an unsupported model name (e.g. 'opus' to MiniMax which only has 'sonnet').
  // IMPORTANT: Only fall back to first model — never use globalDefaultModel here.
  // Global default model is only for NEW conversations (chat/page.tsx).
  // Existing sessions must keep their own selected model; if that model becomes
  // invalid (provider changed), fall back to the provider's first model, not the
  // global default, to avoid overwriting the session's model choice.
  //
  // Phase 6 P0 (2026-05-15) — pass `{ isAuto: true }` so the parent's
  // handler doesn't treat this as a manual user pick. A silent
  // auto-correct must NOT clear `invalidDefault` /
  // `noCompatibleProvider`, write `codepilot:last-model` /
  // `codepilot:last-provider-id` localStorage as the new "recently
  // used", or PATCH the session row. It just synchronises display
  // state so the picker label and the runtime-compatible fallback
  // pair (provider, model) agree.
  useEffect(() => {
    // Canonical-aware auto-correct (tech-debt #37). The decision lives in a pure,
    // unit-tested helper: a model that resolves by value OR canonical upstream is
    // NOT corrected (the old value-only check rewrote canonical ids like
    // `claude-opus-4-7` to the first model (Sonnet), which fed `useProviderModels`
    // and made the send path send Sonnet). Only correct genuinely-absent models.
    const fallback = resolveComposerModelAutoCorrect(modelName, modelOptions);
    if (fallback !== null) {
      onModelChange?.(fallback);
      onProviderModelChange?.(currentProviderIdValue, fallback, { isAuto: true });
    }
  }, [modelName, modelOptions, currentProviderIdValue, onModelChange, onProviderModelChange]);

  const { badges, addBadge, removeBadge, clearBadges, cliBadge, setCliBadge, removeCliBadge, hasBadge } = useCommandBadge(textareaRef);
  const addBadgeWithOrder = useCallback((badge: { command: string; label: string; description: string; kind: 'agent_skill' | 'slash_command' | 'sdk_command' | 'codepilot_command'; installedSource?: 'agents' | 'claude' }) => {
    ensureBadgeOrder(badge.command);
    addBadge(badge);
  }, [addBadge, ensureBadgeOrder]);
  const removeBadgeWithOrder = useCallback((command: string) => {
    removeBadge(command);
    setBadgeOrder((prev) => {
      if (!prev[command]) return prev;
      const next = { ...prev };
      delete next[command];
      return next;
    });
  }, [removeBadge]);
  const clearBadgesWithOrder = useCallback(() => {
    clearBadges();
    setBadgeOrder({});
  }, [clearBadges]);

  const cliToolsFetch = useCliToolsFetch({
    popoverMode: popover.popoverMode,
    closePopover: popover.closePopover,
    setPopoverMode: popover.setPopoverMode,
    setSelectedIndex: popover.setSelectedIndex,
    inputValue,
    locale,
    textareaRef,
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
    addBadge: addBadgeWithOrder,
    onMentionInserted: (mention) => {
      setMentionNodeTypes((prev) => ({ ...prev, [mention.path]: mention.nodeType }));
      ensureMentionOrder(mention.path);
    },
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

  // Listen for file tree "+" button and drop-router: insert @path into the
  // textarea. `nodeType` defaults to 'file' so older callers still work; when
  // it's 'directory', the difference is stored in mentionNodeTypes (not in the
  // text token) to match the picker's convention (see resolveItemSelection).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; nodeType?: 'file' | 'directory' }>).detail;
      const rawPath = detail?.path;
      if (!rawPath) return;
      const normalizedPath = rawPath.replace(/\/+$/, '');
      if (!normalizedPath) return;
      const nodeType = detail.nodeType ?? 'file';
      setMentionNodeTypes((prev) => ({ ...prev, [normalizedPath]: nodeType }));
      ensureMentionOrder(normalizedPath);
      setInputValue((prev) => {
        const needsSpace = prev.length > 0 && !prev.endsWith(' ') && !prev.endsWith('\n');
        return prev + (needsSpace ? ' ' : '') + `@${normalizedPath} `;
      });
      setTimeout(() => textareaRef.current?.focus(), 0);
    };
    window.addEventListener('insert-file-mention', handler);
    return () => window.removeEventListener('insert-file-mention', handler);
  }, [setInputValue, setMentionNodeTypes, ensureMentionOrder]);

  const normalizeMentionPath = useCallback((rawPath: string): string => {
    const normalizedRaw = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!workingDirectory) return normalizedRaw;
    const normalizedBase = workingDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalizedRaw.startsWith(normalizedBase + '/')) {
      return normalizedRaw.slice(normalizedBase.length + 1);
    }
    return normalizedRaw;
  }, [workingDirectory]);

  const fetchMentionFileAttachment = useCallback(async (mentionPath: string): Promise<{ attachment: FileAttachment | null; limitNote?: string }> => {
    const safePath = normalizeMentionPath(mentionPath);
    const filename = safePath.split('/').filter(Boolean).pop() || 'file';
    try {
      if (sessionId) {
        const res = await fetch(`/api/files/serve?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(safePath)}`);
        if (!res.ok) return { attachment: null };
        const headerSize = Number.parseInt(res.headers.get('content-length') || '', 10);
        if (Number.isFinite(headerSize) && headerSize > MAX_MENTION_FILE_BYTES) {
          return { attachment: null, limitNote: `@${safePath}: omitted (file too large > 256KB).` };
        }
        const attachment = await fileResponseToAttachment(res, filename, 'mention');
        if (attachment.size > MAX_MENTION_FILE_BYTES) {
          return { attachment: null, limitNote: `@${safePath}: omitted (file too large > 256KB).` };
        }
        return { attachment };
      }

      if (!workingDirectory) return { attachment: null };
      const absolutePath = joinPath(workingDirectory, safePath);
      const res = await fetch(`/api/files/raw?path=${encodeURIComponent(absolutePath)}`);
      if (!res.ok) return { attachment: null };
      const headerSize = Number.parseInt(res.headers.get('content-length') || '', 10);
      if (Number.isFinite(headerSize) && headerSize > MAX_MENTION_FILE_BYTES) {
        return { attachment: null, limitNote: `@${safePath}: omitted (file too large > 256KB).` };
      }
      const attachment = await fileResponseToAttachment(res, filename, 'mention');
      if (attachment.size > MAX_MENTION_FILE_BYTES) {
        return { attachment: null, limitNote: `@${safePath}: omitted (file too large > 256KB).` };
      }
      return { attachment };
    } catch {
      return { attachment: null };
    }
  }, [sessionId, workingDirectory, normalizeMentionPath]);

  const fetchDirectorySummary = useCallback(async (mentionPath: string): Promise<string | null> => {
    if (!workingDirectory) return null;
    const safePath = normalizeMentionPath(mentionPath);
    const dir = joinPath(workingDirectory, safePath);
    try {
      const res = await fetch(`/api/files?dir=${encodeURIComponent(dir)}&baseDir=${encodeURIComponent(workingDirectory)}&depth=2`);
      if (!res.ok) return null;
      const data = await res.json();
      const tree = Array.isArray(data.tree) ? data.tree : [];
      const preview = tree.slice(0, MAX_DIRECTORY_PREVIEW_ITEMS).map((node: { name: string; type: 'file' | 'directory' }) => (
        node.type === 'directory' ? `- ${node.name}/` : `- ${node.name}`
      ));
      const extra = tree.length > MAX_DIRECTORY_PREVIEW_ITEMS
        ? `\n- ... (${tree.length - MAX_DIRECTORY_PREVIEW_ITEMS} more)`
        : '';
      return `Directory reference @${safePath}/\n${preview.join('\n')}${extra}`;
    } catch {
      return null;
    }
  }, [workingDirectory, normalizeMentionPath]);

  const handleSubmit = useCallback(async (msg: { text: string; files: Array<{ type: string; url: string; filename?: string; mediaType?: string }> }, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Run Checkpoint blocking — Round 2. When the page reports any
    // active reason that requires confirmation, the send is silently
    // dropped here. The visible RunCheckpoint banner above the
    // composer carries the "确认并发送" action; clicking it sets
    // `bypassBlockingRef` and re-triggers this submit, so the same
    // user-edited content + attachments flow through unchanged.
    if (!bypassBlockingRef.current && blockingReasonIds && blockingReasonIds.length > 0) {
      return;
    }
    bypassBlockingRef.current = false;

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

    const resolveMentionPayload = async () => {
      // Only treat mentions inserted/confirmed by the picker (or file-tree bridge)
      // as structured mentions. Plain typed "@foo" should remain plain text.
      const parsedMentions = parseMentionRefs(inputValue, mentionNodeTypes)
        .filter((m) => !!mentionNodeTypes[m.path]);
      const dedupedMentions = dedupeMentionsByPath(parsedMentions);

      const mentionFiles: FileAttachment[] = [];
      const directoryNotes: string[] = [];
      const limitNotes: string[] = [];
      let usedDirectoryMentions = 0;
      for (const mention of dedupedMentions) {
        if (mention.nodeType === 'directory') {
          if (usedDirectoryMentions >= MAX_DIRECTORY_MENTION_COUNT) {
            limitNotes.push(`@${mention.path}/: omitted (max ${MAX_DIRECTORY_MENTION_COUNT} directories per message).`);
            continue;
          }
          const summary = await fetchDirectorySummary(mention.path);
          if (summary) directoryNotes.push(summary);
          usedDirectoryMentions += 1;
          continue;
        }
        if (mentionFiles.length >= MAX_MENTION_FILE_COUNT) {
          limitNotes.push(`@${mention.path}: omitted (max ${MAX_MENTION_FILE_COUNT} files per message).`);
          continue;
        }
        const { attachment, limitNote } = await fetchMentionFileAttachment(mention.path);
        if (attachment) mentionFiles.push(attachment);
        if (limitNote) limitNotes.push(limitNote);
      }

      // Merge in directories the user attached via the file-tree "+" —
      // they don't appear in `dedupedMentions` because they're tracked
      // outside the textarea. Same MAX_DIRECTORY_MENTION_COUNT cap
      // applies across both sources combined.
      for (const path of directoryRefs) {
        if (usedDirectoryMentions >= MAX_DIRECTORY_MENTION_COUNT) {
          limitNotes.push(`${path}/: omitted (max ${MAX_DIRECTORY_MENTION_COUNT} directories per message).`);
          continue;
        }
        const summary = await fetchDirectorySummary(path);
        if (summary) directoryNotes.push(summary);
        usedDirectoryMentions += 1;
      }

      return { mentions: dedupedMentions, files: mentionFiles, directoryNotes, limitNotes };
    };

    // If one or more badges are active, dispatch by kind (multi-skill combines).
    // Block during streaming — badges carry slash/skill semantics, not safe to queue.
    if (badges.length > 0) {
      if (isStreaming) return;
      const uploadedFiles = await convertFiles();
      const mentionPayload = await resolveMentionPayload();
      const { prompt, displayLabel } = dispatchBadge(badges, content);
      // Codex review v3 P1 fix (2026-05-20) — extract agent_skill badge
      // labels as a structured channel for Context Accounting Phase 2.
      // Codex v5 P1 fix (2026-05-20) — canonicalize before passing.
      // Inline (NOT importing canonicalizeSkillName from
      // claude-code-context-accounting): that module pulls
      // discoverSkills → `node:fs`, which Next.js Turbopack drags into
      // the client bundle through this import — produced "Module not
      // found: 'fs'" 500 on /chat. Keeping canonicalize inline here is
      // client-safe; the producer module has its own copy defensively
      // (intentional duplication for boundary safety).
      const canonicalizeSkillNameInline = (v: string) =>
        v.trim().replace(/^\/+/, '');
      const selectedSkills = badges
        .filter((b) => b.kind === 'agent_skill')
        .map((b) => canonicalizeSkillNameInline(b.command || b.label))
        .filter((n) => n.length > 0);
      // Badge path: `prompt` (dispatchBadge output) takes the content slot
      // for the model side, but the bubble's `displayLabel` is owned by the
      // badge dispatcher (e.g. "/agent\nuser context"), not the chip-aware
      // displayOverride. So we use composeSubmitPayload for files +
      // finalContent + mentions, and substitute displayLabel for the bubble.
      const payload = composeSubmitPayload({
        content: prompt,
        uploadedFiles,
        mentionPayload,
        directoryRefs,
      });
      const { files, finalContent: finalPrompt } = payload;
      clearBadgesWithOrder();
      setInputValue('');
      setDirectoryRefs([]);
      onSend(
        finalPrompt,
        files.length > 0 ? files.slice() : undefined,
        undefined,
        displayLabel,
        payload.mentions ? [...payload.mentions] : undefined,
        selectedSkills.length > 0 ? selectedSkills : undefined,
      );
      return;
    }

    const uploadedFiles = await convertFiles();
    const mentionPayload = await resolveMentionPayload();
    // composeSubmitPayload owns the entire normal-path payload assembly
    // (files ordering + mention append + finalContent trim + displayOverride
    // decision). Single helper = one place to test, one place to change.
    // The badge + image-agent branches above don't share this path because
    // they mutate `prompt` (dispatchBadge) before composing finalContent.
    const payload = composeSubmitPayload({
      content,
      uploadedFiles,
      mentionPayload,
      directoryRefs,
    });
    const { files, finalContent } = payload;
    const hasFiles = files.length > 0;

    if ((!finalContent && !hasFiles) || disabled) return;

    // Check if it's a direct slash command typed in the input.
    if (!hasFiles) {
      const slashResult = resolveDirectSlash(finalContent);
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
          addBadgeWithOrder(slashResult.badge!);
          setInputValue('');
          return;
        }
      }
    }

    // If CLI badge is active, inject systemPromptAppend to guide model
    const cliAppend = buildCliAppend(cliBadge);
    if (cliBadge) setCliBadge(null);

    // displayOverride keeps the bubble's text clean — when the user
    // attached @ mentions OR + directory chips, hide the inflated
    // `[Referenced Directories]\n...` LLM-context section from the UI
    // (the chips above the bubble already carry that information).
    onSend(
      finalContent || 'Please review the attached file(s).',
      hasFiles ? files.slice() : undefined,
      cliAppend,
      payload.displayOverride,
      payload.mentions ? [...payload.mentions] : undefined,
    );
    setInputValue('');
    setDirectoryRefs([]);
  }, [inputValue, mentionNodeTypes, directoryRefs, onSend, onCommand, disabled, isStreaming, popover, badges, cliBadge, addBadgeWithOrder, clearBadgesWithOrder, setCliBadge, setInputValue, fetchDirectorySummary, fetchMentionFileAttachment, blockingReasonIds]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Mention token behavior: one Backspace removes the whole @path token.
      if (e.key === 'Backspace') {
        const ta = textareaRef.current;
        const start = ta?.selectionStart ?? 0;
        const end = ta?.selectionEnd ?? 0;
        if (start === end && start > 0) {
          const before = inputValue.slice(0, start);
          const tokenMatch = before.match(/(^|\s)@([^\s@]+)\s$/) || before.match(/(^|\s)@([^\s@]+)$/);
          if (tokenMatch) {
            const mentionPath = (tokenMatch[2] || '').replace(/[.,!?;:)\]}]+$/, '');
            if (mentionPath && mentionNodeTypes[mentionPath]) {
              e.preventDefault();
              const boundaryLen = (tokenMatch[1] || '').length;
              const mentionStart = start - tokenMatch[0].length + boundaryLen;
              const mentionEnd = start;
              const next = `${inputValue.slice(0, mentionStart)}${inputValue.slice(mentionEnd)}`.replace(/\s{2,}/g, ' ');
              const stillHasSamePath = parseMentionRefs(next).some((m) => m.path === mentionPath);
              setInputValue(next);
              if (!stillHasSamePath) {
                setMentionNodeTypes((prev) => {
                  const updated = { ...prev };
                  delete updated[mentionPath];
                  return updated;
                });
                setMentionOrder((prev) => {
                  const updated = { ...prev };
                  delete updated[mentionPath];
                  return updated;
                });
              }
              requestAnimationFrame(() => {
                const el = textareaRef.current;
                if (!el) return;
                const pos = Math.max(0, Math.min(mentionStart, next.length));
                el.setSelectionRange(pos, pos);
              });
              return;
            }
          }
        }
      }

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
          if (badges.length > 0) removeBadgeWithOrder(badges[badges.length - 1].command);
          return;

        case 'remove_cli_badge':
          e.preventDefault();
          removeCliBadge();
          return;

        case 'passthrough':
          break;
      }

      // CLI popover keyboard navigation. Filtering was removed when the
      // in-popover search bar went away, so the list always shows the full
      // set of detected tools — drive selection straight off cliTools.
      if (popover.popoverMode === 'cli' && cliToolsFetch.cliTools.length > 0) {
        const tools = cliToolsFetch.cliTools;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          popover.setSelectedIndex((prev) => Math.min(prev + 1, tools.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          popover.setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (tools[popover.selectedIndex]) cliToolsFetch.handleCliSelect(tools[popover.selectedIndex]);
          return;
        }
      }
    },
    [popover, slashCommands, cliToolsFetch, badges, cliBadge, inputValue, mentionNodeTypes, removeBadgeWithOrder, removeCliBadge, setInputValue]
  );

  const uniqueMentions = useMemo(() => dedupeMentionsByPath(mentions), [mentions]);
  const mentionEstimates = useMentionTokenEstimate(uniqueMentions, { sessionId, workingDirectory });
  // Synthetic MentionRef[] for directory chips so the estimate hook can
  // share its caching logic. The estimates feed both the per-chip
  // "~3.2K" label and the pending total.
  const directoryRefMentions = useMemo<MentionRef[]>(
    () => directoryRefs.map((path) => ({
      path,
      display: path,
      nodeType: 'directory' as const,
      sourceRange: { start: 0, end: 0 },
    })),
    [directoryRefs],
  );
  const directoryRefEstimates = useMentionTokenEstimate(directoryRefMentions, { sessionId, workingDirectory });
  // Attachment pending tokens — summed inside an embedded child of
  // PromptInput (where `usePromptInputAttachments` resolves) and
  // reported up via callback. See `<AttachmentPendingTracker>` below.
  const [attachmentPendingTokens, setAttachmentPendingTokens] = useState(0);
  // Total context tokens that will be added by the current chip
  // selection — shown as a "+pending" annotation in the Run status
  // panel so the user can preview the cost before sending. Includes
  // typed @ mentions, file-tree-attached directories, and PromptInput
  // file attachments alike.
  const pendingContextTokens = useMemo(
    () => computePendingContextTokens({
      attachmentPendingTokens,
      uniqueMentions,
      mentionEstimates,
      directoryRefs,
      directoryRefEstimates,
    }),
    [attachmentPendingTokens, uniqueMentions, mentionEstimates, directoryRefs, directoryRefEstimates],
  );
  useEffect(() => {
    onPendingContextTokensChange?.(pendingContextTokens);
  }, [pendingContextTokens, onPendingContextTokensChange]);

  // Phase 6 Phase 3 — per-source split of the same pending pool. Mirrors
  // computePendingContextTokens so the displayed total never disagrees
  // with the per-source rows in the Context popover breakdown.
  const pendingContextSubTotals = useMemo(
    () => computePendingContextSubTotals({
      attachmentPendingTokens,
      uniqueMentions,
      mentionEstimates,
      directoryRefs,
      directoryRefEstimates,
    }),
    [attachmentPendingTokens, uniqueMentions, mentionEstimates, directoryRefs, directoryRefEstimates],
  );
  useEffect(() => {
    onPendingContextSubTotalsChange?.(pendingContextSubTotals);
  }, [pendingContextSubTotals, onPendingContextSubTotalsChange]);

  const removeDirectoryRef = useCallback((path: string) => {
    setDirectoryRefs((prev) => prev.filter((p) => p !== path));
  }, []);

  // File-tree "+" on a folder dispatches `attach-directory-to-chat`
  // (rather than writing `@path/` into the textarea) so the chip lives
  // in the same green-capsule attachment row as files and images.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      const rawPath = detail?.path;
      if (!rawPath) return;
      const normalized = rawPath.replace(/\/+$/, '');
      if (!normalized) return;
      setDirectoryRefs((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
    };
    window.addEventListener('attach-directory-to-chat', handler);
    return () => window.removeEventListener('attach-directory-to-chat', handler);
  }, []);

  // Run Checkpoint Round 2 — when the banner's confirm action fires,
  // we set the bypass flag and programmatically click the composer's
  // submit button. PromptInput's full submission pipeline (text +
  // attachments + mentions) then runs unchanged; handleSubmit reads
  // the bypass and skips its blocking-reasons check exactly once.
  useEffect(() => {
    const handler = () => {
      bypassBlockingRef.current = true;
      // Find this composer's submit button via the stable
      // `data-message-input-submit` hook on FileAwareSubmitButton.
      // We deliberately do NOT use aria-label — that gets i18n'd
      // ("发送消息" in zh) so a label-based query would silently
      // miss in non-en locales and the bypass flag would leak.
      // (Codex P2 fix, 2026-04-30.)
      const btn = typeof document !== 'undefined'
        ? document.querySelector('button[data-message-input-submit]') as HTMLButtonElement | null
        : null;
      if (btn && !btn.disabled) {
        btn.click();
      } else {
        // Submit button missing or disabled (e.g. empty input). Reset
        // the bypass so a stale flag doesn't leak into the next
        // user-initiated submit.
        bypassBlockingRef.current = false;
      }
    };
    window.addEventListener('run-checkpoint-confirm-send', handler);
    return () => window.removeEventListener('run-checkpoint-confirm-send', handler);
  }, []);

  const removeMention = useCallback((targetMention: MentionRef) => {
    let removedPath = '';
    let stillHasSamePath = false;
    setInputValue((prev) => {
      const parsed = parseMentionRefs(prev, mentionNodeTypes);
      const exact = parsed.find((m) =>
        m.path === targetMention.path
        && m.sourceRange?.start === targetMention.sourceRange?.start
        && m.sourceRange?.end === targetMention.sourceRange?.end
      );
      const target = exact || parsed.find((m) => m.path === targetMention.path);
      if (!target?.sourceRange) return prev;
      removedPath = target.path;
      const { start, end } = target.sourceRange;
      const before = prev.slice(0, start);
      let after = prev.slice(end);
      if (before.endsWith(' ') && after.startsWith(' ')) after = after.slice(1);
      const next = `${before}${after}`.replace(/\s{2,}/g, ' ').trimStart();
      stillHasSamePath = parseMentionRefs(next).some((m) => m.path === target.path);
      return next;
    });
    if (!removedPath) return;
    if (!stillHasSamePath) {
      setMentionNodeTypes((prev) => {
        if (!prev[removedPath]) return prev;
        const next = { ...prev };
        delete next[removedPath];
        return next;
      });
      setMentionOrder((prev) => {
        if (!prev[removedPath]) return prev;
        const next = { ...prev };
        delete next[removedPath];
        return next;
      });
    }
  }, [setInputValue, mentionNodeTypes]);

  // Drop-router for folders: browsers hand us directory drops as 0-size File
  // entries whose mediaType is ''. Default behavior in PromptInput would insert
  // them as bogus attachments. Route them to the existing @mention pipeline as
  // directory references instead — matching what the picker produces.
  const handleDirectoriesDropped = useCallback((dirs: File[]) => {
    const resolver = typeof window !== 'undefined' ? window.electronAPI?.fs?.getPathForFile : undefined;
    for (const dir of dirs) {
      const absolute = resolver ? resolver(dir) : '';
      // Without an absolute path (non-Electron or resolver missing), fall back
      // to the folder name — the LLM can still act on the name as a hint.
      const rawPath = absolute || dir.name;
      if (!rawPath) continue;
      const normalized = normalizeMentionPath(rawPath);
      window.dispatchEvent(new CustomEvent('insert-file-mention', {
        detail: { path: normalized, nodeType: 'directory' },
      }));
    }
  }, [normalizeMentionPath]);

  // Effort selector state — guard against undefined when model not found in current provider's list
  const currentModelMeta = currentModelOption as (typeof currentModelOption & { supportsEffort?: boolean; supportedEffortLevels?: string[] }) | undefined;
  const showEffortSelector = currentModelMeta?.supportsEffort === true;
  // Default label is 'auto' — the UI displays "默认 / Auto" and no explicit
  // effort value is sent to the backend. This lets Claude Code apply its
  // per-model default (e.g. xhigh on Opus 4.7). If we initialized to 'high'
  // instead, the button would say "High" while the request actually carried
  // undefined, which silently sent a different level than shown.
  const [localEffort, setLocalEffort] = useState<string>('auto');
  const selectedEffort = effortProp ?? localEffort;
  const setSelectedEffort = useCallback((v: string) => {
    setLocalEffort(v);
    // Passthrough — including the 'auto' sentinel. The send path in
    // page.tsx / ChatView.tsx filters 'auto' before building the request
    // so the backend receives no effort field, letting CLI apply its
    // per-model default.
    onEffortChange?.(v);
  }, [onEffortChange]);

  const currentModelValue = modelName || 'sonnet';
  const chatStatus: ChatStatus = isStreaming ? 'streaming' : 'ready';

  // Composer shell bg routed through the platform token (Phase 7b /
  // Phase 2). Default = `var(--background)` matches prior
  // `bg-background/80`; macOS profile drops alpha so vibrancy shows
  // through the composer hood.
  return (
    <div className="bg-[var(--platform-surface-bar)] backdrop-blur-lg px-4 pt-2 pb-1">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative">
          {/* Slash Command / File Popover */}
          <SlashCommandPopover
            popoverMode={popover.popoverMode}
            popoverRef={popover.popoverRef}
            filteredItems={popover.filteredItems}
            aiSuggestions={popover.aiSuggestions}
            aiSearchLoading={popover.aiSearchLoading}
            selectedIndex={popover.selectedIndex}
            allDisplayedItems={popover.allDisplayedItems}
            onInsertItem={slashCommands.insertItem}
            onSetSelectedIndex={popover.setSelectedIndex}
          />

          {/* CLI Tools Popover */}
          {popover.popoverMode === 'cli' && (
            <CliToolsPopover
              popoverRef={popover.popoverRef}
              cliTools={cliToolsFetch.cliTools}
              selectedIndex={popover.selectedIndex}
              onSetSelectedIndex={popover.setSelectedIndex}
              onCliSelect={cliToolsFetch.handleCliSelect}
              onClosePopover={popover.closePopover}
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

          {/* PromptInput follows the canonical ai-elements composition:
              Body(Textarea) + Footer(Tools + Submit). Chip rows live as
              direct children of PromptInput so they collapse to zero DOM
              when empty (a wrapping `PromptInputHeader` would always
              render its addon padding even with no chips). The `+` action
              menu folds attach / insert-slash / pick-CLI into one entry. */}
          <PromptInput
            onSubmit={handleSubmit}
            accept=""
            multiple
            onDirectoriesDropped={handleDirectoriesDropped}
            className="[&_[data-slot=input-group]]:shadow-[var(--shadow-diffuse)]"
          >
            <FileTreeAttachmentBridge />
            {/* Chip rows: each carries its own `pt-2.5 px-3 order-first`
                so they float above the textarea via flex `order` and
                produce zero DOM when their data is empty — wrapping them
                in `PromptInputHeader` would re-introduce the addon's
                always-on padding even with no chips. */}
            <ComposerBadgeRow
              badges={badges}
              mentions={uniqueMentions}
              badgeOrder={badgeOrder}
              mentionOrder={mentionOrder}
              onRemoveBadge={removeBadgeWithOrder}
              onRemoveMention={removeMention}
              mentionEstimates={mentionEstimates}
            />
            {cliBadge && (
              <CliBadge name={cliBadge.name} onRemove={removeCliBadge} />
            )}
            <FileAttachmentsCapsules />
            <AttachmentPendingTracker onChange={setAttachmentPendingTokens} />
            <DirectoryRefsCapsules
              paths={directoryRefs}
              onRemove={removeDirectoryRef}
              estimates={directoryRefEstimates}
            />

            <PromptInputBody>
              <PromptInputTextarea
                ref={textareaRef}
                placeholder={
                  isProviderLoading
                    ? t('messageInput.placeholderLoading' as TranslationKey)
                    : badges.length > 0
                      ? t('messageInput.placeholderWithBadges' as TranslationKey)
                      : cliBadge
                        ? t('messageInput.placeholderCli' as TranslationKey)
                        : t('messageInput.placeholderDefault' as TranslationKey)
                }
                value={inputValue}
                onChange={(e) => slashCommands.handleInputChange(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                onFocus={handleAssistantFocus}
                disabled={disabled}
                className="min-h-12 px-4 py-3"
              />
            </PromptInputBody>

            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger
                    aria-label={t('messageInput.actionMenuTooltip' as TranslationKey)}
                    tooltip={t('messageInput.actionMenuTooltip' as TranslationKey)}
                  />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments
                      label={t('messageInput.actionAddContext' as TranslationKey)}
                    />
                    <PromptInputActionMenuItem onSelect={() => slashCommands.handleInsertSlash()}>
                      <CodePilotIcon name="code" size="md" className="mr-2" aria-hidden />
                      {t('messageInput.actionInsertCommand' as TranslationKey)}
                    </PromptInputActionMenuItem>
                    <PromptInputActionMenuItem onSelect={() => { void cliToolsFetch.handleOpenCliPopover(); }}>
                      <CodePilotIcon name="cli" size="md" className="mr-2" aria-hidden />
                      {t('messageInput.actionCallCli' as TranslationKey)}
                    </PromptInputActionMenuItem>
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>

                <ModelSelectorDropdown
                  currentModelValue={currentModelValue}
                  currentProviderIdValue={currentProviderIdValue}
                  providerGroups={providerGroups}
                  modelOptions={modelOptions}
                  onModelChange={onModelChange}
                  onProviderModelChange={onProviderModelChange}
                  globalDefaultModel={globalDefaultModel}
                  globalDefaultProvider={globalDefaultProvider}
                  runtimeApplied={runtimeApplied}
                  isLoading={isProviderLoading}
                />

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
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

    </div>
  );
});
