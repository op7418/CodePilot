import { modelMessageSchema, type ModelMessage } from 'ai';
import type { MessageContentBlock, NativeStepHistory } from '@/types';

/** Accept only model output roles, never a system/user instruction. */
export async function parseNativeStepHistory(value: unknown): Promise<NativeStepHistory | undefined> {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as NativeStepHistory;
  if (data.version !== 1 || typeof data.providerId !== 'string' || !data.providerId
    || typeof data.modelId !== 'string' || !data.modelId || !Array.isArray(data.messages)
    || data.messages.length === 0) return undefined;
  for (const message of data.messages) {
    if (message?.role !== 'assistant' && message?.role !== 'tool') return undefined;
    if (!(await modelMessageSchema.safeParseAsync(message)).success) return undefined;
  }
  return data;
}

/** Marks the end of one completed SDK step; later partial output stays separate. */
export function attachNativeStep(blocks: MessageContentBlock[], step: NativeStepHistory): void {
  if (!blocks.length || blocks[blocks.length - 1].nativeStep) {
    blocks.push({ type: 'text', text: '' });
  }
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], nativeStep: step };
}

/** Restore only on the same provider + upstream model. Other routes use visible history. */
export function replayNativeSteps(
  blocks: MessageContentBlock[],
  route: { providerId: string; modelId: string } | undefined,
  convert: (blocks: MessageContentBlock[]) => ModelMessage[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let pending: MessageContentBlock[] = [];
  for (const block of blocks) {
    pending.push(block);
    const step = block.nativeStep;
    if (!step) continue;
    const valid = route && step.version === 1 && step.providerId === route.providerId
      && step.modelId === route.modelId && Array.isArray(step.messages)
      && step.messages.length > 0
      && step.messages.every(m => (m?.role === 'assistant' || m?.role === 'tool')
        && modelMessageSchema.safeParse(m).success);
    messages.push(...(valid ? step.messages : convert(pending)));
    pending = [];
  }
  if (pending.length > 0) messages.push(...convert(pending));
  return messages;
}
