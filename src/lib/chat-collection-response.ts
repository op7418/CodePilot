import { SingleOwnerStreamWriter } from './single-owner-stream-writer';

export const CHAT_SAVE_UNCONFIRMED = 'CODEPILOT_CHAT_SAVE_UNCONFIRMED';

/** One-shot persistence result, independent of post-save model calls/notifications. */
export function createChatPersistenceSignal() {
  let settle!: (saved: boolean) => void;
  const settled = new Promise<boolean>((resolve) => { settle = resolve; });
  return { settled, settle };
}

/** Attach the rejection owner immediately, including when the renderer detaches. */
export function observeChatCollection(
  collection: Promise<unknown>,
  onFailure: (error: unknown) => void,
): Promise<boolean> {
  return collection.then(() => true, (error) => {
    try { onFailure(error); } catch { /* reporting/cleanup cannot create another rejection */ }
    return false;
  });
}

/** Runtime completion alone does not confirm that the assistant reply was saved. */
export function createChatCollectionResponse(
  clientStream: ReadableStream<string>,
  persistence: Promise<boolean>,
  initialChunk?: string,
): ReadableStream<string> {
  const reader = clientStream.getReader();
  const writer = new SingleOwnerStreamWriter<string>();
  return new ReadableStream<string>({
    start(controller) {
      writer.attach(controller);
      if (initialChunk) writer.enqueue(initialChunk);
    },
    async pull() {
      try {
        const { done, value } = await reader.read();
        if (!done) {
          writer.enqueue(value);
          return;
        }
        const saved = await persistence;
        if (!saved) {
          writer.enqueue(`data: ${JSON.stringify({ type: 'error', data: CHAT_SAVE_UNCONFIRMED })}\n\n`);
        }
        writer.close();
        reader.releaseLock();
      } catch (error) {
        writer.cancel();
        reader.releaseLock();
        throw error; // The Web Streams pull owner delivers transport failures to the client.
      }
    },
    cancel() {
      writer.cancel();
      // A tee branch's cancel promise waits for the other branch. Do not await it
      // or cancel the server-owned collector when the renderer closes/reloads.
      void reader.cancel().catch(() => {});
    },
  });
}
