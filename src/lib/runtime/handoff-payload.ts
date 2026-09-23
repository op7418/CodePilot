import path from 'node:path';
import type { ChatSession, Message } from '@/types';
import type { RuntimeId } from './runtime-id';
import { isInternalRuntimeSwitchMarker } from './thread-execution-binding';
import { sanitizeText } from '@/lib/telemetry/sanitize';

export interface RuntimeHandoffPayloadV1 {
  version: 1;
  source: {
    sessionId: string;
    title: string;
    runtimeId: RuntimeId;
    boundaryRowid: number;
  };
  target: {
    runtimeId: RuntimeId;
    providerId: string;
    modelId: string;
  };
  workspace: { projectName: string };
  transcript: Array<{ role: 'user' | 'assistant'; content: string; rowid: number }>;
  userNote?: string;
  payloadSource: 'recent_transcript';
  truncated: boolean;
}

function handoffMessageContent(content: string): string {
  const withoutAttachmentMetadata = content.replace(/^<!--files:[\s\S]*?-->/, '[attachments omitted] ');
  return sanitizeText(withoutAttachmentMetadata, 3000);
}

/** Honest deterministic fallback: a bounded, redacted transcript window. */
export function buildRuntimeHandoffPayload(input: {
  sourceSession: ChatSession;
  sourceRuntimeId: RuntimeId;
  sourceBoundaryRowid: number;
  targetRuntimeId: RuntimeId;
  targetProviderId: string;
  targetModelId: string;
  messages: Message[];
  userNote?: string;
}): RuntimeHandoffPayloadV1 {
  const eligible = input.messages.filter(message =>
    (message._rowid ?? 0) <= input.sourceBoundaryRowid
    && message.is_heartbeat_ack !== 1
    && !isInternalRuntimeSwitchMarker(message.content));
  const window = eligible.slice(-16);
  let remaining = 18_000;
  const transcript: RuntimeHandoffPayloadV1['transcript'] = [];
  for (const message of window) {
    if (remaining <= 0) break;
    const content = handoffMessageContent(message.content).slice(0, remaining);
    remaining -= content.length;
    transcript.push({
      role: message.role,
      content,
      rowid: message._rowid ?? 0,
    });
  }
  return {
    version: 1,
    source: {
      sessionId: input.sourceSession.id,
      title: sanitizeText(input.sourceSession.title, 200),
      runtimeId: input.sourceRuntimeId,
      boundaryRowid: input.sourceBoundaryRowid,
    },
    target: {
      runtimeId: input.targetRuntimeId,
      providerId: input.targetProviderId,
      modelId: input.targetModelId,
    },
    workspace: {
      projectName: sanitizeText(
        input.sourceSession.project_name
          || path.basename(input.sourceSession.working_directory || '')
          || 'unknown',
        200,
      ),
    },
    transcript,
    ...(input.userNote?.trim() ? { userNote: sanitizeText(input.userNote.trim(), 2000) } : {}),
    payloadSource: 'recent_transcript',
    truncated: eligible.length > window.length || remaining <= 0,
  };
}

export function parseRuntimeHandoffPayload(raw: string): RuntimeHandoffPayloadV1 | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RuntimeHandoffPayloadV1>;
    if (value.version !== 1 || !value.source || !value.target || !Array.isArray(value.transcript)) {
      return undefined;
    }
    return value as RuntimeHandoffPayloadV1;
  } catch {
    return undefined;
  }
}

export function buildRuntimeHandoffContextFragment(payload: RuntimeHandoffPayloadV1): string {
  const transcript = payload.transcript.map(item =>
    `${item.role.toUpperCase()} [source row ${item.rowid}]:\n${item.content}`,
  ).join('\n\n');
  return [
    '<runtime_handoff>',
    `This chat continues from "${payload.source.title}" (${payload.source.runtimeId}).`,
    `The handoff covers source messages through row ${payload.source.boundaryRowid}.`,
    `Payload source: ${payload.payloadSource}${payload.truncated ? '; transcript window is truncated' : ''}.`,
    `Project: ${payload.workspace.projectName}. Runtime caches and native thread state were not transferred.`,
    payload.userNote ? `User handoff note:\n${payload.userNote}` : '',
    transcript ? `Recent source transcript:\n${transcript}` : 'No eligible source transcript was available.',
    '</runtime_handoff>',
  ].filter(Boolean).join('\n\n');
}
