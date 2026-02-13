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
// Task Types
// ==========================================

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TaskItem {
  id: string;
  session_id: string;
  title: string;
  status: TaskStatus;
  description: string | null;
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
  provider_type: string; // 'anthropic' | 'openrouter' | 'bedrock' | 'vertex' | 'custom'
  base_url: string;
  api_key: string;
  is_active: number; // SQLite boolean: 0 or 1
  sort_order: number;
  extra_env: string; // JSON string of Record<string, string>
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProviderRequest {
  name: string;
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  notes?: string;
}

export interface UpdateProviderRequest {
  name?: string;
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  notes?: string;
  sort_order?: number;
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
}

export interface SendMessageRequest {
  session_id: string;
  content: string;
  model?: string;
  mode?: string;
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
  enabled: boolean;
}

export interface MCPServerConfig {
  command: string;
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
} as const;

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
// Claude Client Types
// ==========================================

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
  toolTimeoutSeconds?: number;
}
