'use client';

import { useRef, useState, useCallback, useEffect, type KeyboardEvent, type FormEvent } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AtIcon,
  HelpCircleIcon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  CommandLineIcon,
  PlusSignIcon,
  Cancel01Icon,
  Delete02Icon,
  Coins01Icon,
  FileZipIcon,
  Stethoscope02Icon,
  FileEditIcon,
  SearchList01Icon,
  BrainIcon,
  GlobalIcon,
  StopIcon,
  Folder01Icon,
  File01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from '@/lib/utils';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import type { ChatStatus } from 'ai';
import type { FileAttachment, ProviderModelGroup } from '@/types';
import { nanoid } from 'nanoid';
import { ImageGenToggle } from './ImageGenToggle';
import { useImageGen } from '@/hooks/useImageGen';
import { PENDING_KEY, setRefImages, deleteRefImages } from '@/lib/image-ref-store';

const IMAGE_AGENT_SYSTEM_PROMPT = `你是一个图像生成助手。当用户请求生成图片时，分析用户意图并以结构化格式输出。

## 单张生成
如果用户只需要生成一张图片，输出：
\`\`\`image-gen-request
{"prompt":"详细的英文描述","aspectRatio":"1:1","resolution":"1K"}
\`\`\`

## 批量生成
如果用户提供了文档/列表/多个需求，需要批量生成多张图片，输出：
\`\`\`batch-plan
{"summary":"计划摘要","items":[{"prompt":"英文描述","aspectRatio":"1:1","resolution":"1K","tags":[]}]}
\`\`\`

## 参考图（垫图）
如果用户上传了图片，这些图片会自动作为参考图传给图片生成模型。你在 prompt 中应该描述如何利用这些参考图，例如：
- 基于参考图的风格/内容进行创作
- 将参考图中的元素融入新图
- 按照参考图的构图生成新图

## 连续编辑（基于上一次生成结果）
如果用户要求修改/编辑/调整之前生成的图片，在 JSON 中加入 "useLastGenerated": true，系统会自动将上次生成的结果图作为参考图传入。
编辑模式下 prompt 要简洁直接，只描述要做的修改，不要重复描述整张图片的内容。例如：
- 用户说"去掉右边的香水" → prompt: "Remove the perfume bottle on the right side of the image"
- 用户说"把背景换成蓝色" → prompt: "Change the background color to blue"
- 用户说"加个太阳" → prompt: "Add a sun in the sky"

\`\`\`image-gen-request
{"prompt":"简洁的英文编辑指令","aspectRatio":"1:1","resolution":"1K","useLastGenerated":true}
\`\`\`

## 规则
- 新图生成时 prompt 必须是详细的英文描述
- 编辑已有图片时 prompt 应该简洁直接，只描述修改内容
- aspectRatio 可选: 1:1, 16:9, 9:16, 3:2, 2:3, 4:3, 3:4
- resolution 可选: 1K, 2K, 4K
- 批量生成时每个 item 都需要独立的详细 prompt
- 如果用户没有特别要求比例和分辨率，使用 1:1 和 1K 作为默认值
- 如果用户上传了参考图，prompt 中要明确说明如何使用这些参考图
- 如果用户要求修改上一张生成的图片，必须加 "useLastGenerated": true
- 在输出结构化块之前，可以先简要说明你的理解和计划`;


const FILE_TREE_DRAG_MIME = 'application/x-codepilot-path';
const FILE_TREE_DRAG_FALLBACK_MIME = 'text/x-codepilot-path';

function hasDragType(dataTransfer: DataTransfer | null | undefined, type: string): boolean {
  if (!dataTransfer) return false;

  const types = dataTransfer.types as unknown;
  if (!types) return false;

  if (typeof (types as { includes?: unknown }).includes === 'function') {
    return (types as { includes: (value: string) => boolean }).includes(type);
  }

  if (typeof (types as { contains?: unknown }).contains === 'function') {
    return (types as { contains: (value: string) => boolean }).contains(type);
  }

  return Array.from(types as ArrayLike<string>).includes(type);
}

function readFileTreeDropData(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) return null;

  const raw = dataTransfer.getData(FILE_TREE_DRAG_MIME)
    || dataTransfer.getData(FILE_TREE_DRAG_FALLBACK_MIME);

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<{ path: string; name: string; type: string }>;
    if (!parsed.path || typeof parsed.path !== 'string') return null;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      path: parsed.path,
      type: parsed.type === 'directory' ? 'directory' : 'file',
    };
  } catch {
    return null;
  }
}

interface MessageInputProps {
  onSend: (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string) => void;
  onImageGenerate?: (prompt: string, files?: FileAttachment[]) => void;
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
  mode?: string;
  onModeChange?: (mode: string) => void;
  contextTokens?: number;
  contextStale?: boolean;
  maxContext?: number;
  isCompacting?: boolean;
  onProviderGroupsLoaded?: (groups: ProviderModelGroup[], defaultProviderId?: string) => void;
}

interface PopoverItem {
  label: string;
  value: string;
  description?: string;
  descriptionKey?: TranslationKey;
  builtIn?: boolean;
  immediate?: boolean;
  installedSource?: "agents" | "claude";
  source?: "global" | "project" | "plugin" | "installed";
  icon?: typeof CommandLineIcon;
}

interface CommandBadge {
  command: string;
  label: string;
  description: string;
  isSkill: boolean;
  installedSource?: "agents" | "claude";
}

interface ContextMention {
  id: string;
  path: string;
  name: string;
  type: 'file' | 'directory';
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
  { label: 'help', value: '/help', description: 'Show available commands and tips', descriptionKey: 'messageInput.helpDesc', builtIn: true, immediate: true, icon: HelpCircleIcon },
  { label: 'clear', value: '/clear', description: 'Clear conversation history', descriptionKey: 'messageInput.clearDesc', builtIn: true, immediate: true, icon: Delete02Icon },
  { label: 'cost', value: '/cost', description: 'Show token usage statistics', descriptionKey: 'messageInput.costDesc', builtIn: true, immediate: true, icon: Coins01Icon },
  { label: 'compact', value: '/compact', description: 'Compress conversation context', descriptionKey: 'messageInput.compactDesc', builtIn: true, icon: FileZipIcon },
  { label: 'doctor', value: '/doctor', description: 'Diagnose project health', descriptionKey: 'messageInput.doctorDesc', builtIn: true, icon: Stethoscope02Icon },
  { label: 'init', value: '/init', description: 'Initialize CLAUDE.md for project', descriptionKey: 'messageInput.initDesc', builtIn: true, icon: FileEditIcon },
  { label: 'review', value: '/review', description: 'Review code quality', descriptionKey: 'messageInput.reviewDesc', builtIn: true, icon: SearchList01Icon },
  { label: 'terminal-setup', value: '/terminal-setup', description: 'Configure terminal settings', descriptionKey: 'messageInput.terminalSetupDesc', builtIn: true, icon: CommandLineIcon },
  { label: 'memory', value: '/memory', description: 'Edit project memory file', descriptionKey: 'messageInput.memoryDesc', builtIn: true, icon: BrainIcon },
];

const BUILT_IN_COMMAND_NAMES = new Set(BUILT_IN_COMMANDS.map(c => c.label));

interface ModeOption {
  value: string;
  label: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { value: 'code', label: 'Code' },
  { value: 'plan', label: 'Plan' },
];

// Default Claude model options — used as fallback when API is unavailable
const DEFAULT_MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

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
  hasContextMentions,
}: {
  status: ChatStatus;
  onStop?: () => void;
  disabled?: boolean;
  inputValue: string;
  hasBadge: boolean;
  hasContextMentions: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const hasFiles = attachments.files.length > 0;
  const isStreaming = status === 'streaming' || status === 'submitted';

  return (
    <PromptInputSubmit
      status={status}
      onStop={onStop}
      disabled={disabled || (!isStreaming && !inputValue.trim() && !hasBadge && !hasFiles && !hasContextMentions)}
      className="rounded-full"
    >
      {isStreaming ? (
        <HugeiconsIcon icon={StopIcon} className="size-4" />
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
  const { t } = useTranslation();

  return (
    <PromptInputButton
      onClick={() => attachments.openFileDialog()}
      tooltip={t('messageInput.attachFiles')}
    >
      <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
    </PromptInputButton>
  );
}

/**
 * Infer a MIME type from a filename extension so that files added from the
 * file tree pass the PromptInput accept-type validation. Code / text files
 * are mapped to `text/*` subtypes; images and PDFs get their standard types.
 * For extensionless/unknown files, prefer server-detected MIME when available,
 * otherwise fall back to `text/plain` so common files like Dockerfile/README
 * can still be attached from the file tree.
 */
function mimeFromFilename(name: string, serverMime?: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const TEXT_EXTS: Record<string, string> = {
    md: 'text/markdown', mdx: 'text/markdown',
    txt: 'text/plain', csv: 'text/csv',
    json: 'application/json',
    ts: 'text/typescript', tsx: 'text/typescript',
    js: 'text/javascript', jsx: 'text/javascript',
    py: 'text/x-python', go: 'text/x-go', rs: 'text/x-rust',
    rb: 'text/x-ruby', java: 'text/x-java', c: 'text/x-c',
    cpp: 'text/x-c++', h: 'text/x-c', hpp: 'text/x-c++',
    cs: 'text/x-csharp', swift: 'text/x-swift', kt: 'text/x-kotlin',
    html: 'text/html', css: 'text/css', scss: 'text/css',
    xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml',
    toml: 'text/plain', ini: 'text/plain', cfg: 'text/plain',
    sh: 'text/x-shellscript', bash: 'text/x-shellscript', zsh: 'text/x-shellscript',
    sql: 'text/x-sql', graphql: 'text/plain', gql: 'text/plain',
    vue: 'text/plain', svelte: 'text/plain', astro: 'text/plain',
    env: 'text/plain', gitignore: 'text/plain', dockerignore: 'text/plain',
    dockerfile: 'text/plain', makefile: 'text/plain',
    log: 'text/plain', lock: 'text/plain',
  };
  const IMAGE_EXTS: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  };
  if (TEXT_EXTS[ext]) return TEXT_EXTS[ext];
  if (IMAGE_EXTS[ext]) return IMAGE_EXTS[ext];
  if (ext === 'pdf') return 'application/pdf';

  // Use API-reported MIME when it looks meaningful.
  if (serverMime && serverMime !== 'application/octet-stream') {
    return serverMime;
  }

  return 'text/plain';
}

/**
 * Bridge component that listens for 'attach-file-to-chat' custom events
 * from the file tree and adds files as attachments. Must be rendered inside PromptInput.
 */
function FileTreeAttachmentBridge({
  onAttachFailed,
}: {
  onAttachFailed?: (filePath: string) => void;
}) {
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
        if (!res.ok) {
          console.warn(`[FileTreeAttachment] Failed to fetch file: ${res.status} ${res.statusText}`, filePath);
          onAttachFailed?.(filePath);
          return;
        }
        const blob = await res.blob();
        // Handle both Unix (/) and Windows (\) path separators
        const filename = filePath.split(/[/\\]/).pop() || 'file';
        // Use a proper MIME type derived from the extension so the file
        // passes PromptInput's accept-type validation (text/* etc.)
        const mime = mimeFromFilename(filename, blob.type);
        const file = new File([blob], filename, { type: mime });
        attachmentsRef.current.add([file]);
      } catch (err) {
        console.warn('[FileTreeAttachment] Error attaching file:', filePath, err);
        onAttachFailed?.(filePath);
      }
    };

    window.addEventListener('attach-file-to-chat', handler);
    return () => window.removeEventListener('attach-file-to-chat', handler);
  }, [onAttachFailed]);

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

/**
 * Return Tailwind color classes for a context mention chip based on file extension.
 */
function getMentionColorClasses(mention: ContextMention): { chip: string; hover: string } {
  if (mention.type === 'directory') {
    return {
      chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
      hover: "hover:bg-amber-500/20",
    };
  }
  const ext = mention.name.split('.').pop()?.toLowerCase() || '';
  if (['doc', 'docx'].includes(ext)) {
    return {
      chip: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
      hover: "hover:bg-blue-500/20",
    };
  }
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return {
      chip: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
      hover: "hover:bg-green-500/20",
    };
  }
  if (ext === 'pdf') {
    return {
      chip: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
      hover: "hover:bg-red-500/20",
    };
  }
  if (ext === 'txt') {
    return {
      chip: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20",
      hover: "hover:bg-gray-500/20",
    };
  }
  return {
    chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
    hover: "hover:bg-violet-500/20",
  };
}

/**
 * Chip display for context mentions (dragged files/folders), rendered inside PromptInput context.
 */
function ContextMentionChips({
  mentions,
  onRemove,
}: {
  mentions: ContextMention[];
  onRemove: (id: string) => void;
}) {
  if (mentions.length === 0) return null;
  return (
    <div className="grid w-full grid-cols-5 gap-1.5 px-3 pt-2 pb-0 order-first">
      {mentions.map((m) => {
        const colors = getMentionColorClasses(m);
        return (
          <span
            key={m.id}
            className={cn(
              "inline-flex items-center gap-1 rounded-full pl-2 pr-1 py-0.5 text-xs font-medium border min-w-0",
              colors.chip
            )}
          >
            <HugeiconsIcon icon={m.type === 'directory' ? Folder01Icon : File01Icon} className="h-3 w-3 shrink-0" />
            <span className="truncate text-[11px] font-mono">{m.name}</span>
            <button
              type="button"
              onClick={() => onRemove(m.id)}
              className={cn("ml-auto shrink-0 rounded-full p-0.5 transition-colors", colors.hover)}
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
  onImageGenerate,
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
  mode = 'code',
  onModeChange,
  contextTokens = 0,
  contextStale = false,
  maxContext = 200000,
  isCompacting = false,
  onProviderGroupsLoaded,
}: MessageInputProps) {
  const { t } = useTranslation();
  const imageGen = useImageGen();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPos, setTriggerPos] = useState<number | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [badge, setBadge] = useState<CommandBadge | null>(null);
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string>('');
  const [aiSuggestions, setAiSuggestions] = useState<PopoverItem[]>([]);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const aiSearchAbortRef = useRef<AbortController | null>(null);
  const aiSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMentions, setContextMentions] = useState<ContextMention[]>([]);

  const removeContextMention = useCallback((id: string) => {
    setContextMentions((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const addContextMention = useCallback((path: string, name: string, type: 'file' | 'directory') => {
    setContextMentions((prev) => {
      if (prev.some((m) => m.path === path)) return prev;
      return [...prev, { id: nanoid(), path, name, type }];
    });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const appendPathMention = useCallback((path: string) => {
    setInputValue((prev) => {
      const suffix = `@${path} `;
      return prev ? `${prev}${suffix}` : suffix;
    });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  // Fetch provider groups from API
  const fetchProviderModels = useCallback(() => {
    fetch('/api/providers/models')
      .then((r) => r.json())
      .then((data) => {
        let nextGroups: ProviderModelGroup[];
        if (data.groups && data.groups.length > 0) {
          nextGroups = data.groups;
        } else {
          nextGroups = [{
            provider_id: 'env',
            provider_name: 'Anthropic',
            provider_type: 'anthropic',
            models: DEFAULT_MODEL_OPTIONS,
          }];
        }
        setProviderGroups(nextGroups);
        onProviderGroupsLoaded?.(nextGroups, data.default_provider_id || '');
        setDefaultProviderId(data.default_provider_id || '');
      })
      .catch(() => {
        const fallbackGroups: ProviderModelGroup[] = [{
          provider_id: 'env',
          provider_name: 'Anthropic',
          provider_type: 'anthropic',
          models: DEFAULT_MODEL_OPTIONS,
        }];
        setProviderGroups(fallbackGroups);
        onProviderGroupsLoaded?.(fallbackGroups, fallbackGroups[0]?.provider_id || '');
        setDefaultProviderId('');
      });
  }, [onProviderGroupsLoaded]);

  // Load models on mount and listen for provider changes
  useEffect(() => {
    fetchProviderModels();
    const handler = () => fetchProviderModels();
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchProviderModels]);

  // Derive flat model list for current provider (used by currentModelOption lookup)
  const currentProviderIdValue = providerId || defaultProviderId || (providerGroups[0]?.provider_id ?? '');
  const currentGroup = providerGroups.find(g => g.provider_id === currentProviderIdValue) || providerGroups[0];
  const MODEL_OPTIONS = currentGroup?.models || DEFAULT_MODEL_OPTIONS;

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
      const cwdParam = workingDirectory ? `?cwd=${encodeURIComponent(workingDirectory)}` : '';
      const res = await fetch(`/api/skills${cwdParam}`);
      if (res.ok) {
        const data = await res.json();
        const skills = data.skills || [];
        apiSkills = skills
          .map((s: { name: string; description: string; source?: "global" | "project" | "plugin" | "installed"; installedSource?: "agents" | "claude" }) => ({
            label: s.name,
            value: `/${s.name}`,
            description: s.description || "",
            builtIn: false,
            installedSource: s.installedSource,
            source: s.source,
          }));
      }
    } catch {
      // API not available - just use built-in commands
    }

    // Deduplicate: remove API skills that share a name with built-in commands
    const uniqueSkills = apiSkills.filter(s => !BUILT_IN_COMMAND_NAMES.has(s.label));

    return [...BUILT_IN_COMMANDS, ...uniqueSkills];
  }, [workingDirectory]);

  // Close popover
  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
    // Clean up AI search state
    setAiSuggestions([]);
    setAiSearchLoading(false);
    if (aiSearchTimerRef.current) {
      clearTimeout(aiSearchTimerRef.current);
      aiSearchTimerRef.current = null;
    }
    if (aiSearchAbortRef.current) {
      aiSearchAbortRef.current.abort();
      aiSearchAbortRef.current = null;
    }
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
    const rawContent = inputValue.trim();
    const mentionPrefix = contextMentions.length > 0
      ? contextMentions.map((m) => `@${m.path}`).join(' ') + ' '
      : '';
    const content = mentionPrefix + rawContent;

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
          attachments.push(attachment);
        } catch {
          // Skip files that fail conversion
        }
      }
      return attachments;
    };

    // If Image Agent toggle is on and no badge, send via normal LLM with systemPromptAppend
    if (imageGen.state.enabled && !badge && !isStreaming) {
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

    // If badge is active, expand the command/skill and send
    if (badge && !isStreaming) {
      let expandedPrompt = '';

      if (badge.isSkill) {
        // Fetch skill content from API
        try {
          const detailParams = new URLSearchParams();
          if (badge.installedSource) detailParams.set("source", badge.installedSource);
          if (workingDirectory) detailParams.set("cwd", workingDirectory);
          const qs = detailParams.toString();
          const res = await fetch(
            `/api/skills/${encodeURIComponent(badge.label)}${qs ? `?${qs}` : ""}`
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
      setContextMentions([]);
      setInputValue('');
      onSend(finalPrompt, files.length > 0 ? files : undefined);
      return;
    }

    const files = await convertFiles();
    const hasFiles = files.length > 0;

    if ((!content && !hasFiles && contextMentions.length === 0) || disabled || isStreaming) return;

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
    setContextMentions([]);
    setInputValue('');
  }, [inputValue, onSend, onImageGenerate, onCommand, disabled, isStreaming, closePopover, badge, contextMentions, imageGen]);

  const filteredItems = popoverItems.filter((item) => {
    const q = popoverFilter.toLowerCase();
    return item.label.toLowerCase().includes(q)
      || (item.description || '').toLowerCase().includes(q);
  });

  // Debounced AI semantic search when substring results are insufficient
  const nonBuiltInFilteredCount = filteredItems.filter(i => !i.builtIn).length;
  useEffect(() => {
    // Only trigger for skill mode with enough input and few substring matches
    if (popoverMode !== 'skill' || popoverFilter.length < 2 || nonBuiltInFilteredCount >= 2) {
      setAiSuggestions([]);
      setAiSearchLoading(false);
      if (aiSearchTimerRef.current) {
        clearTimeout(aiSearchTimerRef.current);
        aiSearchTimerRef.current = null;
      }
      if (aiSearchAbortRef.current) {
        aiSearchAbortRef.current.abort();
        aiSearchAbortRef.current = null;
      }
      return;
    }

    // Cancel previous timer and request
    if (aiSearchTimerRef.current) {
      clearTimeout(aiSearchTimerRef.current);
    }
    if (aiSearchAbortRef.current) {
      aiSearchAbortRef.current.abort();
    }

    setAiSearchLoading(true);

    aiSearchTimerRef.current = setTimeout(async () => {
      const abortController = new AbortController();
      aiSearchAbortRef.current = abortController;

      try {
        // Collect non-built-in skills for AI search
        const skillsPayload = popoverItems
          .filter(i => !i.builtIn)
          .map(i => ({ name: i.label, description: (i.description || '').slice(0, 100) }));

        if (skillsPayload.length === 0) {
          setAiSearchLoading(false);
          return;
        }

        const res = await fetch('/api/skills/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            query: popoverFilter,
            skills: skillsPayload,
            model: modelName || 'haiku',
          }),
        });

        if (abortController.signal.aborted) return;

        if (!res.ok) {
          setAiSuggestions([]);
          setAiSearchLoading(false);
          return;
        }

        const data = await res.json();
        const suggestions: string[] = data.suggestions || [];

        // Map suggested names back to PopoverItems, deduplicating against substring results
        const filteredNames = new Set(filteredItems.map(i => i.label));
        const aiItems = suggestions
          .filter(name => !filteredNames.has(name))
          .map(name => popoverItems.find(i => i.label === name))
          .filter((item): item is PopoverItem => !!item);

        setAiSuggestions(aiItems);
      } catch {
        // Silently fail — don't show AI suggestions on error
        if (!abortController.signal.aborted) {
          setAiSuggestions([]);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setAiSearchLoading(false);
        }
      }
    }, 500);

    return () => {
      if (aiSearchTimerRef.current) {
        clearTimeout(aiSearchTimerRef.current);
        aiSearchTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popoverFilter, popoverMode, nonBuiltInFilteredCount]);

  // Combined list for keyboard navigation
  const allDisplayedItems = [...filteredItems, ...aiSuggestions];

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Popover navigation
      if (popoverMode && popoverItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % allDisplayedItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + allDisplayedItems.length) % allDisplayedItems.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (allDisplayedItems[selectedIndex]) {
            insertItem(allDisplayedItems[selectedIndex]);
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
    [popoverMode, popoverItems, popoverFilter, selectedIndex, insertItem, closePopover, badge, inputValue, removeBadge, allDisplayedItems]
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

  const currentModelValue = modelName || 'sonnet';
  const currentModelOption = MODEL_OPTIONS.find((m) => m.value === currentModelValue) || MODEL_OPTIONS[0];

  // Map isStreaming to ChatStatus for PromptInputSubmit
  const chatStatus: ChatStatus = isStreaming ? 'streaming' : 'ready';

  // Handle file tree drag-and-drop onto the input area using native DOM events.
  // Native listeners on the wrapper div fire before React's delegated handlers,
  // ensuring preventDefault() reliably blocks the browser's default text-insert
  // behaviour on the textarea (which caused file paths to leak into the input).
  useEffect(() => {
    const el = dropZoneRef.current;
    if (!el) return;

    const onDragOver = (e: DragEvent) => {
      const isTreeDrag = hasDragType(e.dataTransfer, FILE_TREE_DRAG_MIME)
        || hasDragType(e.dataTransfer, FILE_TREE_DRAG_FALLBACK_MIME);

      if (isTreeDrag) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        setIsDragOver(true);
      }
    };

    const onDragLeave = (e: DragEvent) => {
      if (el.contains(e.relatedTarget as Node)) return;
      setIsDragOver(false);
    };

    const onDrop = (e: DragEvent) => {
      setIsDragOver(false);
      const data = readFileTreeDropData(e.dataTransfer);
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      addContextMention(data.path, data.name, data.type as 'file' | 'directory');
    };

    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, [addContextMention]);

  return (
    <div className="bg-background/80 backdrop-blur-lg px-4 py-3">
      <div className="mx-auto">
        <div
          ref={dropZoneRef}
          className={cn("relative", isDragOver && "ring-2 ring-primary/50 ring-offset-1 ring-offset-background rounded-xl")}
        >
          {/* Popover */}
          {popoverMode && (allDisplayedItems.length > 0 || aiSearchLoading) && (() => {
            const builtInItems = filteredItems.filter(item => item.builtIn);
            const projectItems = filteredItems.filter(item => !item.builtIn && item.source === 'project');
            const skillItems = filteredItems.filter(item => !item.builtIn && item.source !== 'project');
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
                ) : !item.builtIn && item.source === 'project' ? (
                  <HugeiconsIcon icon={FileEditIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : !item.builtIn ? (
                  <HugeiconsIcon icon={GlobalIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <HugeiconsIcon icon={CommandLineIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="font-mono text-xs truncate">{item.label}</span>
                {(item.descriptionKey || item.description) && (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {item.descriptionKey ? t(item.descriptionKey) : item.description}
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
                          setSelectedIndex((prev) => (prev + 1) % allDisplayedItems.length);
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setSelectedIndex((prev) => (prev - 1 + allDisplayedItems.length) % allDisplayedItems.length);
                        } else if (e.key === 'Enter' || e.key === 'Tab') {
                          e.preventDefault();
                          if (allDisplayedItems[selectedIndex]) {
                            insertItem(allDisplayedItems[selectedIndex]);
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
                      {projectItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            Project Commands
                          </div>
                          {projectItems.map((item) => {
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
                      {/* AI Suggested section */}
                      {(aiSuggestions.length > 0 || aiSearchLoading) && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                            <HugeiconsIcon icon={BrainIcon} className="h-3.5 w-3.5" />
                            {t('messageInput.aiSuggested')}
                            {aiSearchLoading && (
                              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            )}
                          </div>
                          {aiSuggestions.map((item) => {
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
            accept=""
            multiple
          >
            {/* Bridge: listens for file tree "+" button events */}
            <FileTreeAttachmentBridge onAttachFailed={appendPathMention} />
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
            {/* Context mention chips (dragged files/folders) */}
            <ContextMentionChips mentions={contextMentions} onRemove={removeContextMention} />
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

                {/* Mode capsule toggle */}
                <div className="flex items-center rounded-full border border-border/60 overflow-hidden h-7">
                  {MODE_OPTIONS.map((opt) => {
                    const isActive = opt.value === mode;
                    return (
                      <button
                        key={opt.value}
                        className={cn(
                          "px-2.5 py-1 text-xs font-medium transition-colors",
                          isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => onModeChange?.(opt.value)}
                      >
                        {opt.value === 'code' ? t('messageInput.modeCode') : opt.value === 'plan' ? t('messageInput.modePlan') : opt.label}
                      </button>
                    );
                  })}
                </div>

                {/* Model selector */}
                <div className="relative" ref={modelMenuRef}>
                  <PromptInputButton
                    onClick={() => setModelMenuOpen((prev) => !prev)}
                  >
                    <span className="text-xs font-mono">{currentModelOption.label}</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} className={cn("h-2.5 w-2.5 transition-transform duration-200", modelMenuOpen && "rotate-180")} />
                  </PromptInputButton>

                  {modelMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-52 rounded-lg border bg-popover shadow-lg overflow-hidden z-50 max-h-80 overflow-y-auto">
                      {providerGroups.map((group, groupIdx) => (
                        <div key={group.provider_id}>
                          {/* Group header */}
                          <div className={cn(
                            "px-3 py-1.5 text-[10px] font-medium text-muted-foreground",
                            groupIdx > 0 && "border-t"
                          )}>
                            {group.provider_name}
                          </div>
                          {/* Models in group */}
                          <div className="py-0.5">
                            {group.models.map((opt) => {
                              const isActive = opt.value === currentModelValue && group.provider_id === currentProviderIdValue;
                              return (
                                <button
                                  key={`${group.provider_id}-${opt.value}`}
                                  className={cn(
                                    "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                                    isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                                  )}
                                  onClick={() => {
                                    onModelChange?.(opt.value);
                                    onProviderModelChange?.(group.provider_id, opt.value);
                                    localStorage.setItem('codepilot:last-model', opt.value);
                                    localStorage.setItem('codepilot:last-provider-id', group.provider_id);
                                    setModelMenuOpen(false);
                                  }}
                                >
                                  <span className="font-mono text-xs">{opt.label}</span>
                                  {isActive && <span className="text-xs">✓</span>}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Context usage ring */}
                {(() => {
                  const circumference = 2 * Math.PI * 8; // r=8
                  const isContextStale = contextStale && !isCompacting;
                  const ratio = isContextStale ? 0 : Math.min(contextTokens / maxContext, 1);
                  const offset = circumference * (1 - ratio);
                  const color = isCompacting
                    ? '#a855f7'
                    : isContextStale
                      ? '#64748b'
                    : ratio > 0.7 ? '#ef4444' : ratio > 0.5 ? '#eab308' : '#22c55e';
                  const formatTokens = (n: number) => {
                    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
                    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
                    return `${n}`;
                  };
                  const label = formatTokens(contextTokens);
                  const maxLabel = formatTokens(maxContext);
                  const tooltipText = isCompacting
                    ? t('messageInput.compacting')
                    : isContextStale
                      ? t('messageInput.contextRefreshPending')
                    : `${label} / ${maxLabel}`;
                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent/50 transition-colors">
                          <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
                            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/15" />
                            <circle cx="10" cy="10" r="8" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={isContextStale ? `${circumference * 0.35} ${circumference}` : `${circumference}`} strokeDashoffset={isCompacting ? circumference * 0.25 : offset} style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.4s ease', ...(isCompacting ? { animation: 'spin 1.5s linear infinite', transformOrigin: 'center' } : {}) }} />
                          </svg>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <span className="text-xs">{tooltipText}</span>
                      </TooltipContent>
                    </Tooltip>
                  );
                })()}

                {/* Image Agent toggle */}
                <ImageGenToggle />
              </PromptInputTools>

              <FileAwareSubmitButton
                status={chatStatus}
                onStop={onStop}
                disabled={disabled}
                inputValue={inputValue}
                hasBadge={!!badge}
                hasContextMentions={contextMentions.length > 0}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

    </div>
  );
}
