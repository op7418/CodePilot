import type { RuntimeSessionRef } from '@/lib/runtime/contract';
import { buildCodexContinuationInput } from './continuation-context';
import type { CodexContinuationContext } from './continuation-context';
import { buildCodexTurnInput } from './turn-input';
import type { CodexTurnInputBlock } from './types';

export interface CodexThreadContinuation {
  threadId: string;
  resumed: boolean;
}

/** Resolve the native thread without changing the product chat or its saved ref. */
export async function prepareCodexThread(input: {
  existingRef: RuntimeSessionRef | null;
  providerId: string;
  mcpFingerprint: string;
  resume: (threadId: string) => Promise<void>;
  start: () => Promise<string>;
}): Promise<CodexThreadContinuation> {
  const ref = input.existingRef;
  if (ref
    && ref.metadata?.providerId === input.providerId
    && (ref.metadata?.mcpConfigFingerprint ?? '') === input.mcpFingerprint) {
    try {
      await input.resume(ref.token);
      return { threadId: ref.token, resumed: true };
    } catch {
      // An unavailable native thread can be reconstructed from the chat history.
    }
  }
  return { threadId: await input.start(), resumed: false };
}

/**
 * New native threads receive the current chat's summary and recent history.
 * A successful resume already owns those turns. Only commit the new ref once
 * Codex accepts the first input, so a failed start/turn retries with history.
 */
export async function startCodexTurnWithContext<T>(input: CodexContinuationContext & {
  thread: CodexThreadContinuation;
  startTurn: (blocks: CodexTurnInputBlock[]) => Promise<T>;
  saveThread: () => void;
}): Promise<T> {
  const blocks = input.thread.resumed
    ? buildCodexTurnInput(input.prompt, input.files)
    : await buildCodexContinuationInput(input);
  const result = await input.startTurn(blocks);
  if (!input.thread.resumed) input.saveThread();
  return result;
}
