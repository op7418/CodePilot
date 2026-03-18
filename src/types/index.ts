// ==========================================
// Database Models
// ==========================================

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model: string;
  system_prompt: string;
  working_directory: string;
  sdk_session_id: string; // Claude Agent SDK session ID for resume
  project_name: string;
  status: 'active' | 'archived';
  mode?: 'code' | 'plan' | 'ask';
  needs_approval?: boolean;
  provider_name: string;
  provider_id: string;
  sdk_cwd: string;
  runtime_status: string;
  runtime_updated_at: string;
  runtime_error: string;
  permission_profile?: 'default' | 'full_access';
}

// ==========================================
// Project / File Types
// ==========================================

export interface ProjectInfo {
  path: string;
  name: string;
  files_count: number;
  last_modified: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  size?: number;
  extension?: string;
}

export interface FilePreview {
  path: string;
  content: string;
  language: string;
  line_count: number;
}

// ==========================================
// Skill / Command Types
// ==========================================

export type SkillKind = 'agent_skill' | 'slash_command' | 'sdk_command' | 'codepilot_command';

// ==========================================
// Popover / Command Input Types
// ==========================================

import type { TranslationKey } from '@/i18n';
import type { ComponentType, SVGAttributes, RefAttributes } from 'react';

/** Generic icon component type — compatible with Phosphor, Lucide, or any SVG icon. */
export type IconComponent = ComponentType<
  SVGAttributes<SVGSVGElement> & RefAttributes<SVGSVGElement> & { size?: number | string; className?: string }
>;

/** Shared model for popover items (slash commands, file mentions, skills). */
export interface PopoverItem {
  label: string;
  value: string;
  description?: string;
  descriptionKey?: TranslationKey;
  builtIn?: boolean;
  immediate?: boolean;
  installedSource?: 'agents' | 'claude';
  source?: 'global' | 'project' | 'plugin' | 'installed' | 'sdk';
  kind?: SkillKind;
  icon?: IconComponent;
}

/** Which popover is currently active in the command input. */
export type PopoverMode = 'file' | 'skill' | 'cli' | null;

/** Active slash-command badge shown above the textarea. */
export interface CommandBadge {
  command: string;
  label: string;
  description: string;
  kind: SkillKind;
  installedSource?: 'agents' | 'claude';
}

/** Active CLI tool badge shown above the textarea. */
export interface CliBadge {
  id: string;
  name: string;
}

/** A detected CLI tool available for use. */
export interface CliToolItem {
  id: string;
  name: string;
  version: string | null;
  summary: string;
}

// ==========================================
// Task Types
// ==========================================

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TaskItem {
  id: string;
  session_id: string;
  title: string;
  status: TaskStatus;
  description: string | null;
  source: 'user' | 'sdk';
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string; // JSON string of MessageContentBlock[] for structured content
  created_at: string;
  token_usage: string | null; // JSON string of TokenUsage
}

// Structured message content blocks (stored as JSON in messages.content)
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'code'; language: string; code: string };

// Helper to parse message content - returns blocks or wraps plain text
export function parseMessageContent(content: string): MessageContentBlock[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON, treat as plain text
  }
  return [{ type: 'text', text: content }];
}

export interface Setting {
  id: number;
  key: string;
  value: string;
}

// ==========================================
// API Provider Types
// ==========================================

export interface ApiProvider {
  id: string;
  name: string;
  provider_type: string; // legacy: 'anthropic' | 'openrouter' | 'bedrock' | 'vertex' | 'custom'
  /** Wire protocol — new field, takes precedence over provider_type for dispatch */
  protocol: string; // 'anthropic' | 'openai-compatible' | 'openrouter' | 'bedrock' | 'vertex' | 'google' | 'gemini-image'
  base_url: string;
  api_key: string;
  is_active: number; // SQLite boolean: 0 or 1
  sort_order: number;
  extra_env: string; // JSON string of Record<string, string> (legacy, prefer env_overrides_json)
  /** Extra headers to send with API requests — JSON string of Record<string, string> */
  headers_json: string;
  /** Environment overrides for Claude Code SDK subprocess — JSON string of Record<string, string> */
  env_overrides_json: string;
  /** Semantic model role mapping — JSON string of { default?, reasoning?, small?, haiku?, sonnet?, opus? } */
  role_models_json: string;
  /** Per-provider options — JSON string of { thinking_mode?, context_1m? } */
  options_json: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderModelGroup {
  provider_id: string;       // provider DB id, or 'env' for environment variables
  provider_name: string;
  provider_type: string;
  /** True if this provider only supports Claude Code SDK wire protocol, not standard Messages API */
  sdkProxyOnly?: boolean;
  models: Array<{
    value: string;           // internal/UI model ID
    label: string;           // display name
    upstreamModelId?: string; // actual API model ID (if different from value)
    contextWindow?: number;
    description?: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
    supportsAdaptiveThinking?: boolean;
    capabilities?: Record<string, unknown>;
    variants?: Record<string, unknown>;
  }>;
}

export interface ProviderModel {
  id: string;
  provider_id: string;
  model_id: string;
  upstream_model_id: string;
  display_name: string;
  capabilities_json: string;
  variants_json: string;
  sort_order: number;
  enabled: number; // SQLite boolean
  created_at: string;
}

export interface CreateProviderRequest {
  name: string;
  provider_type?: string;
  protocol?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  headers_json?: string;
  env_overrides_json?: string;
  role_models_json?: string;
  options_json?: string;
  notes?: string;
}

export interface UpdateProviderRequest {
  name?: string;
  provider_type?: string;
  protocol?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  headers_json?: string;
  env_overrides_json?: string;
  role_models_json?: string;
  options_json?: string;
  notes?: string;
  sort_order?: number;
}

/** Per-provider options stored in options_json */
export interface ProviderOptions {
  thinking_mode?: 'adaptive' | 'enabled' | 'disabled';
  context_1m?: boolean;
}

export interface ProvidersResponse {
  providers: ApiProvider[];
}

export interface ProviderResponse {
  provider: ApiProvider;
}

// ==========================================
// Token Usage
// ==========================================

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

// ==========================================
// API Request Types
// ==========================================

export interface CreateSessionRequest {
  title?: string;
  model?: string;
  system_prompt?: string;
  working_directory?: string;
  mode?: string;
  provider_id?: string;
  permission_profile?: string;
}

export interface SendMessageRequest {
  session_id: string;
  content: string;
  model?: string;
  mode?: string;
  provider_id?: string;
}

export interface UpdateMCPConfigRequest {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface AddMCPServerRequest {
  name: string;
  server: MCPServerConfig;
}

export interface UpdateSettingsRequest {
  settings: SettingsMap;
}

// --- File API ---

export interface FileTreeRequest {
  dir: string;
  depth?: number; // default 3
}

export interface FilePreviewRequest {
  path: string;
  maxLines?: number; // default 200
}

// --- Task API ---

export interface CreateTaskRequest {
  session_id: string;
  title: string;
  description?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  status?: TaskStatus;
  description?: string;
}

// --- Skill API ---

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
}

// --- Marketplace (Skills.sh) ---

export interface MarketplaceSkill {
  id: string;
  skillId: string;      // e.g. "git-commit"
  name: string;
  installs: number;
  source: string;       // e.g. "owner/repo"
  isInstalled?: boolean;
  installedAt?: string;
}

export interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

export interface SkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

export interface CreateSkillRequest {
  name: string;
  description: string;
  prompt: string;
}

export interface UpdateSkillRequest {
  description?: string;
  prompt?: string;
  enabled?: boolean;
}

// ==========================================
// API Response Types
// ==========================================

export interface SessionsResponse {
  sessions: ChatSession[];
}

export interface SessionResponse {
  session: ChatSession;
}

export interface MessagesResponse {
  messages: Message[];
  hasMore?: boolean;
}

export interface SuccessResponse {
  success: true;
}

export interface ErrorResponse {
  error: string;
}

export interface SettingsResponse {
  settings: SettingsMap;
}

export interface PluginsResponse {
  plugins: PluginInfo[];
}

export interface MCPConfigResponse {
  mcpServers: Record<string, MCPServerConfig>;
}

// --- File API Responses ---

export interface FileTreeResponse {
  tree: FileTreeNode[];
  root: string;
}

export interface FilePreviewResponse {
  preview: FilePreview;
}

// --- Task API Responses ---

export interface TasksResponse {
  tasks: TaskItem[];
}

export interface TaskResponse {
  task: TaskItem;
}

// --- Skill API Responses ---

export interface SkillsResponse {
  skills: SkillDefinition[];
}

export interface SkillResponse {
  skill: SkillDefinition;
}

// ==========================================
// SSE Event Types (streaming chat response)
// ==========================================

export type SSEEventType =
  | 'text'               // text content delta
  | 'tool_use'           // tool invocation info
  | 'tool_result'        // tool execution result
  | 'tool_output'        // streaming tool output (stderr from SDK process)
  | 'tool_timeout'       // tool execution timed out
  | 'status'             // status update (compacting, etc.)
  | 'result'             // final result with usage stats
  | 'error'              // error occurred
  | 'permission_request' // permission approval needed
  | 'mode_changed'       // SDK permission mode changed (e.g. plan → code)
  | 'task_update'        // SDK TodoWrite task sync
  | 'keep_alive'         // SDK keep-alive heartbeat (resets idle timer)
  | 'rewind_point'       // SDK user message with rewind checkpoint
  | 'done';              // stream complete

export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

// ==========================================
// Permission Types
// ==========================================

export interface PermissionSuggestion {
  type: string;
  rules?: Array<{ toolName: string; ruleContent?: string }>;
  behavior?: string;
  destination?: string;
}

export interface PermissionRequestEvent {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: PermissionSuggestion[];
  decisionReason?: string;
  blockedPath?: string;
  toolUseId: string;
  description?: string;
}

export interface PermissionResponseRequest {
  permissionRequestId: string;
  decision: {
    behavior: 'allow';
    updatedPermissions?: PermissionSuggestion[];
    updatedInput?: Record<string, unknown>;
  } | {
    behavior: 'deny';
    message?: string;
  };
}

// ==========================================
// Plugin / MCP Types
// ==========================================

export interface PluginInfo {
  name: string;
  description: string;
  author?: { name: string; url?: string };
  path: string;
  marketplace: string;
  location: 'plugins' | 'external_plugins';
  hasCommands: boolean;
  hasSkills: boolean;
  hasAgents: boolean;
  blocked: boolean;
  enabled: boolean;
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'sse' | 'http';
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

// Backward-compatible alias
export type MCPServer = MCPServerConfig;

// ==========================================
// Settings Types
// ==========================================

export interface SettingsMap {
  [key: string]: string;
}

// Well-known setting keys
export const SETTING_KEYS = {
  DEFAULT_MODEL: 'default_model',
  DEFAULT_SYSTEM_PROMPT: 'default_system_prompt',
  THEME: 'theme',
  PERMISSION_MODE: 'permission_mode',
  MAX_THINKING_TOKENS: 'max_thinking_tokens',
  ASSISTANT_WORKSPACE_PATH: 'assistant_workspace_path',
} as const;

// ==========================================
// Setup Center Types
// ==========================================

export type SetupCardStatus = 'not-configured' | 'completed' | 'skipped' | 'needs-fix';
export interface SetupState {
  completed: boolean;
  claude: SetupCardStatus;
  provider: SetupCardStatus;
  project: SetupCardStatus;
  defaultProject?: string;
}

// ==========================================
// Assistant Workspace Types
// ==========================================

export interface AssistantWorkspaceState {
  onboardingComplete: boolean;
  lastCheckInDate: string | null;
  schemaVersion: number;
  hookTriggeredSessionId?: string;
  /** ISO timestamp when hookTriggeredSessionId was set — used for staleness detection */
  hookTriggeredAt?: string;
  /** When false, daily check-in auto-trigger is disabled (default: true) */
  dailyCheckInEnabled?: boolean;
}

export interface AssistantWorkspaceFiles {
  soul?: string;
  memory?: string;
  user?: string;
  claude?: string;
}

export interface AssistantWorkspaceFilesV2 extends AssistantWorkspaceFiles {
  dailyMemories?: string[];
  rootReadme?: string;
  rootPath?: string;
  rootDir?: string;
}

// ==========================================
// Workspace Inspect Types
// ==========================================

export interface WorkspaceInspectResult {
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
  hasAssistantData: boolean;
  workspaceStatus: 'empty' | 'normal_directory' | 'existing_workspace' | 'partial_workspace' | 'invalid';
  summary?: {
    onboardingComplete: boolean;
    lastCheckInDate: string | null;
    fileCount: number;
  };
}

// ==========================================
// Workspace Config Types
// ==========================================

export interface AssistantWorkspaceConfig {
  workspaceType: string;
  organizationStyle: 'project' | 'time' | 'topic' | 'mixed';
  captureDefault: string;
  archivePolicy: {
    completedTaskArchiveAfterDays: number;
    closedProjectArchive: boolean;
    dailyMemoryRetentionDays: number;
  };
  ignore: string[];
  index: {
    maxFileSizeKB: number;
    chunkSize: number;
    chunkOverlap: number;
    maxDepth: number;
    includeExtensions: string[];
  };
}

// ==========================================
// Taxonomy Types
// ==========================================

export interface TaxonomyCategory {
  id: string;
  label: string;
  paths: string[];
  role: string;
  confidence: number;
  source: 'user' | 'learned' | 'default';
  description: string;
  createdBy: string;
}

export interface TaxonomyFile {
  version: number;
  categories: TaxonomyCategory[];
  evolutionRules: {
    allowAutoCreateCategory: boolean;
    allowAutoArchive: boolean;
    requireConfirmationForMoves: boolean;
  };
}

// ==========================================
// Workspace Index Types
// ==========================================

export interface ManifestEntry {
  noteId: string;
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  mtime: number;
  size: number;
  hash: string;
  summary: string;
  categoryIds: string[];
}

export interface ChunkEntry {
  chunkId: string;
  noteId: string;
  path: string;
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface HotsetFile {
  pinned: string[];
  frequent: Array<{ path: string; count: number; lastAccessed: number }>;
  lastUpdated: number;
}

export interface SearchResult {
  path: string;
  heading: string;
  snippet: string;
  score: number;
  source: 'title' | 'heading' | 'tag' | 'content';
}

// ==========================================
// Reference Image Types (for image generation)
// ==========================================

export interface ReferenceImage {
  mimeType: string;
  data?: string;       // base64 (user upload)
  localPath?: string;  // file path (generated result)
}

// ==========================================
// File Attachment Types
// ==========================================

export interface FileAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 encoded content
  filePath?: string; // persisted disk path (for messages reloaded from DB)
}

// Check if a MIME type is an image
export function isImageFile(type: string): boolean {
  return type.startsWith('image/');
}

// Format bytes into human-readable size
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ==========================================
// Classified Error Types (from error-classifier)
// ==========================================

export type { ClaudeErrorCategory, ClassifiedError } from '@/lib/error-classifier';

// ==========================================
// Claude Client Types
// ==========================================

// ==========================================
// Batch Image Generation Types
// ==========================================

export type MediaJobStatus = 'draft' | 'planning' | 'planned' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type MediaJobItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface MediaJob {
  id: string;
  session_id: string | null;
  status: MediaJobStatus;
  doc_paths: string;       // JSON array of file paths
  style_prompt: string;
  batch_config: string;    // JSON of BatchConfig
  total_items: number;
  completed_items: number;
  failed_items: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MediaJobItem {
  id: string;
  job_id: string;
  idx: number;
  prompt: string;
  aspect_ratio: string;
  image_size: string;
  model: string;
  tags: string;            // JSON array of strings
  source_refs: string;     // JSON array of strings
  status: MediaJobItemStatus;
  retry_count: number;
  result_media_generation_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaContextEvent {
  id: string;
  session_id: string;
  job_id: string;
  payload: string;         // JSON object
  sync_mode: 'manual' | 'auto_batch';
  synced_at: string | null;
  created_at: string;
}

export interface BatchConfig {
  concurrency: number;     // max parallel image generations (default: 2)
  maxRetries: number;      // max retry attempts per item (default: 2)
  retryDelayMs: number;    // base delay for exponential backoff (default: 2000)
}

export interface PlannerItem {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  tags: string[];
  sourceRefs: string[];
}

export interface PlannerOutput {
  summary: string;
  items: PlannerItem[];
}

export type JobProgressEventType =
  | 'item_started'
  | 'item_completed'
  | 'item_failed'
  | 'item_retry'
  | 'job_completed'
  | 'job_paused'
  | 'job_cancelled';

export interface JobProgressEvent {
  type: JobProgressEventType;
  jobId: string;
  itemId?: string;
  itemIdx?: number;
  progress: {
    total: number;
    completed: number;
    failed: number;
    processing: number;
  };
  error?: string;
  retryCount?: number;
  mediaGenerationId?: string;
  timestamp: string;
}

// --- Batch Image Gen API Types ---

export interface CreateMediaJobRequest {
  sessionId?: string;
  items: Array<{
    prompt: string;
    aspectRatio?: string;
    imageSize?: string;
    model?: string;
    tags?: string[];
    sourceRefs?: string[];
  }>;
  batchConfig?: Partial<BatchConfig>;
  stylePrompt?: string;
  docPaths?: string[];
}

export interface PlanMediaJobRequest {
  docPaths?: string[];
  docContent?: string;
  stylePrompt: string;
  sessionId?: string;
  count?: number;
}

export interface UpdateMediaJobItemsRequest {
  items: Array<{
    id: string;
    prompt?: string;
    aspectRatio?: string;
    imageSize?: string;
    tags?: string[];
  }>;
}

export interface MediaJobResponse {
  job: MediaJob;
  items: MediaJobItem[];
}

export interface MediaJobListResponse {
  jobs: MediaJob[];
}

// ==========================================
// Stream Session Manager Types
// ==========================================

export interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultInfo {
  tool_use_id: string;
  content: string;
}

export type StreamPhase = 'active' | 'completed' | 'error' | 'stopped';

export interface SessionStreamSnapshot {
  sessionId: string;
  phase: StreamPhase;
  streamingContent: string;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  streamingToolOutput: string;
  statusText: string | undefined;
  pendingPermission: PermissionRequestEvent | null;
  permissionResolved: 'allow' | 'deny' | null;
  tokenUsage: TokenUsage | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  /** Final message content built at stream completion for ChatView to consume */
  finalMessageContent: string | null;
}

export interface StreamEvent {
  type: 'snapshot-updated' | 'phase-changed' | 'permission-request' | 'completed';
  sessionId: string;
  snapshot: SessionStreamSnapshot;
}

export type StreamEventListener = (event: StreamEvent) => void;

export interface ClaudeStreamOptions {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string; // SDK session ID for resuming conversations
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  abortController?: AbortController;
  permissionMode?: string;
  files?: FileAttachment[];
  imageAgentMode?: boolean;
  toolTimeoutSeconds?: number;
  provider?: ApiProvider;
  /** Explicit provider ID (e.g. 'env') — passed to resolveForClaudeCode */
  providerId?: string;
  /** Session's stored provider ID — passed to resolveForClaudeCode */
  sessionProviderId?: string;
  /** Recent conversation history from DB — used as fallback context when SDK resume is unavailable or fails */
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onRuntimeStatusChange?: (status: string) => void;
  /** Per-session bypass: when true, skip all permission checks for this session */
  bypassPermissions?: boolean;
  /** Thinking configuration for the query */
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  /** Effort level for the query */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Output format for structured responses */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Custom agent definitions */
  agents?: Record<string, { description: string; prompt?: string; tools?: string[]; disallowedTools?: string[] }>;
  /** Agent name for the main thread */
  agent?: string;
  /** Enable file checkpointing for rewind support */
  enableFileCheckpointing?: boolean;
  /** When true, this is an auto-trigger turn (invisible to user) — skip rewind point emission */
  autoTrigger?: boolean;
  /** Enable 1M context window (beta header: context-1m-2025-08-07) */
  context1m?: boolean;
  /** Enable generative UI widget guidelines MCP server (default: true) */
  generativeUI?: boolean;
}

// ==========================================
// CLI Tools Types
// ==========================================

export type CliToolStatus = 'not_installed' | 'installed' | 'needs_auth' | 'ready';
export type CliToolCategory = 'media' | 'data' | 'search' | 'download' | 'document' | 'productivity';
export type InstallMethod = 'brew' | 'npm' | 'pipx' | 'cargo';

export type CliToolPlatform = 'darwin' | 'linux' | 'win32';

export interface CliToolInstallMethod {
  method: InstallMethod;
  command: string;
  platforms: CliToolPlatform[];
}

export interface CliToolExamplePrompt {
  label: string;
  promptZh: string;
  promptEn: string;
}

export interface CliToolDefinition {
  id: string;
  name: string;
  binNames: string[];
  summaryZh: string;
  summaryEn: string;
  categories: CliToolCategory[];
  installMethods: CliToolInstallMethod[];
  setupType: 'simple' | 'needs_auth';
  detailIntro: { zh: string; en: string };
  useCases: { zh: string[]; en: string[] };
  guideSteps: { zh: string[]; en: string[] };
  examplePrompts: CliToolExamplePrompt[];
  homepage?: string;
  repoUrl?: string;
  officialDocsUrl?: string;
  supportsAutoDescribe: boolean;
}

export interface CliToolRuntimeInfo {
  id: string;
  status: CliToolStatus;
  version: string | null;
  binPath: string | null;
  autoDescription?: { zh: string; en: string } | null;
}

// ==========================================
// Git Types
// ==========================================

export interface GitStatus {
  isRepo: boolean;
  repoRoot: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: GitChangedFile[];
}

export interface GitChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked';
  staged: boolean;
}

export interface GitBranch {
  name: string;
  isRemote: boolean;
  upstream: string;
  worktreePath: string;
}

export interface GitLogEntry {
  sha: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  message: string;
}

export interface GitCommitDetail extends GitLogEntry {
  stats: string;
  diff: string;
}

export interface GitWorktree {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  dirty: boolean;
}
