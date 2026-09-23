import { getMessages } from '@/lib/db';
import { roughTokenEstimate } from '@/lib/context-estimator';
import { buildFallbackContext } from '@/lib/fallback-context';
import { normalizeMessageContent } from '@/lib/message-normalizer';
import { resolveInTreeAttachmentPath } from '@/lib/in-tree-attachment';
import { isInternalRuntimeSwitchMarker } from '@/lib/runtime/thread-execution-binding';
import { isImageFile } from '@/types';
import type { ConversationHistoryItem, FileAttachment } from '@/types';
import { buildCodexTurnInput } from './turn-input';
import type { CodexTurnInputBlock } from './types';

export interface CodexContinuationContext {
  prompt: string;
  sessionId?: string;
  history?: ConversationHistoryItem[];
  sessionSummary?: string;
  sessionSummaryBoundaryRowid?: number;
  tokenBudget?: number;
  workingDirectory?: string;
  supportsImages?: boolean;
  files?: FileAttachment[];
}

/** Continue before the caller's snapshot, never reread newer/current messages.
 * Synthetic histories without DB rowids stay self-contained. Only a fresh
 * native thread calls this iterator; successful resumes do no DB paging.
 */
function* newestHistoryFirst(input: CodexContinuationContext): Generator<ConversationHistoryItem> {
  const seed = input.history ?? [];
  const boundary = input.sessionSummary ? (input.sessionSummaryBoundaryRowid ?? 0) : 0;
  let page = seed;
  while (page.length > 0) {
    for (let i = page.length - 1; i >= 0; i--) {
      const message = page[i];
      if (message._rowid !== undefined && message._rowid <= boundary) return;
      if (!isInternalRuntimeSwitchMarker(message.content)) yield message;
    }
    const cursor = page[0]._rowid;
    if (!input.sessionId || !cursor || cursor <= boundary) return;
    page = getMessages(input.sessionId, { limit: 200, beforeRowId: cursor, excludeHeartbeatAck: true }).messages
      .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content, _rowid: message._rowid }));
  }
}

/** Only the leading user attachment envelope is eligible for replay. Never
 * interpret assistant/tool text as permission to attach a local file.
 */
async function restoreAttachments(message: ConversationHistoryItem, input: CodexContinuationContext) {
  let content = normalizeMessageContent(message.role, message.content);
  const images: FileAttachment[] = [];
  const envelope = message.role === 'user' ? /^<!--files:([\s\S]*?)-->/.exec(message.content) : null;
  if (!envelope) return { content, images };
  let entries: unknown;
  try { entries = JSON.parse(envelope[1]); } catch { return { content: `${content}\n[Earlier attachments unavailable: invalid metadata.]`, images }; }
  if (!Array.isArray(entries)) return { content, images };
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { filePath, name, type } = entry as Record<string, unknown>;
    const label = JSON.stringify(typeof name === 'string' ? name : 'attachment');
    const safePath = await resolveInTreeAttachmentPath(typeof filePath === 'string' ? filePath : undefined, input.workingDirectory);
    if (!safePath) {
      content += `\n[Earlier attachment ${label} unavailable: file missing or outside this project.]`;
      continue;
    }
    content += `\n[Earlier attachment ${label}: ${JSON.stringify(safePath)}]`;
    if (typeof type === 'string' && isImageFile(type)) {
      if (input.supportsImages === true) {
        images.push({ id: safePath, name: typeof name === 'string' ? name : 'image', type, size: 0, data: '', filePath: safePath });
      } else {
        content += '\n[Image pixels not attached: the target model has no declared image support. This is a file reference, not a visual description.]';
      }
    }
  }
  return { content, images };
}

/** Budget estimates reserve room for wrappers and image input. Images vary
 * by provider/resolution; this is a conservative allowance, not measured usage.
 * The caller's budget already excludes system/summary/current text.
 */
const IMAGE_TOKEN_ALLOWANCE = 2048;
const WRAPPER_TOKEN_ALLOWANCE = 256;

export async function buildCodexContinuationInput(input: CodexContinuationContext): Promise<CodexTurnInputBlock[]> {
  const budget = Number.isFinite(input.tokenBudget) ? Math.max(0, input.tokenBudget!) : 32000;
  let remaining = Math.max(0, budget - WRAPPER_TOKEN_ALLOWANCE
    - (input.files ?? []).filter(file => isImageFile(file.type)).length * IMAGE_TOKEN_ALLOWANCE);
  const selected: Array<{ role: 'user' | 'assistant'; content: string; images: FileAttachment[] }> = [];
  let omitted = false;
  for (const message of newestHistoryFirst(input)) {
    // Check text before filesystem work, and do not microcompact user text:
    // budget pressure is the only reason to omit an otherwise eligible turn.
    if (roughTokenEstimate(normalizeMessageContent(message.role, message.content)) + 10 > remaining) {
      omitted = true;
      break;
    }
    const restored = await restoreAttachments(message, input);
    const cost = roughTokenEstimate(restored.content) + 10 + restored.images.length * IMAGE_TOKEN_ALLOWANCE;
    if (cost > remaining) {
      omitted = true;
      break;
    }
    selected.push({ role: message.role, ...restored });
    remaining -= cost;
  }
  selected.reverse();
  const prompt = buildFallbackContext({
    prompt: input.prompt,
    history: selected,
    sessionSummary: input.sessionSummary,
    preserveContent: true,
  });
  const notice = omitted ? '[Earlier conversation omitted to fit the context budget; do not assume omitted requirements are known.]\n\n' : '';
  // Keep historical image order aligned with the chronological file references
  // in the text. Deduplicate repeated historical references, not current input.
  const currentPaths = new Set((input.files ?? []).map(file => file.filePath).filter(Boolean));
  const seen = new Set<string>();
  const images = selected.flatMap(message => message.images).filter(file => {
    if (!file.filePath || seen.has(file.filePath) || currentPaths.has(file.filePath)) return false;
    seen.add(file.filePath);
    return true;
  });
  return buildCodexTurnInput(notice + prompt, [...images, ...(input.files ?? [])]);
}
