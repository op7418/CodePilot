/**
 * builtin-tools/media.ts — Media import + image generation tools (Native Runtime).
 *
 * Phase 5d Phase 2 slice 2d (2026-05-17) — system prompt is shared
 * with the MCP-side implementation.
 *
 * 2026-08-14 P1 — import the prompt from a dependency-free module,
 * never from `media-import-mcp.ts`. That MCP module imports the Claude
 * Agent SDK and becomes an async Turbopack chunk. A synchronous `require`
 * from the Native tool registry then failed and silently removed this
 * entire tool group from the real Next route.
 *
 * Phase 5e Phase 0.5 P1 (2026-05-17 Native MediaBlock 補齐) — image
 * generation + media import now emit `MediaBlock[]` via the harness
 * side-channel event bus (`@/lib/harness/builtin-event-bus`). Pre-fix
 * both tools returned a plain "Image generated: <path>" / "Media
 * imported: <path>" string from `execute()`; `agent-loop.ts`'s
 * `tool-result` SSE handler only stringified the output, so the chat
 * UI's `MediaPreview` (which reads SSE `tool_result.media`) never saw
 * an image card. This was the Phase 5e Phase 0.5 audit's P1 finding —
 * "工具存在但语义不完整": tool runs, returns localPath, model says
 * "done", but user sees no image in the chat surface.
 *
 * Fix shape (mirrors `src/lib/codex/proxy/builtin-bridge.ts` Codex
 * bridge):
 *   1. `execute()` accepts ai-sdk's `toolCallId` from execOptions.
 *   2. Tool body builds the `MediaBlock[]` and emits a `tool_completed`
 *      RuntimeRunEvent through `emitBuiltinEvent(sessionId, ...)` —
 *      this is the side-channel.
 *   3. `execute()` returns plain TEXT to ai-sdk (model sees clean
 *      description, NOT a base64-bearing JSON blob).
 *   4. `agent-loop.ts` subscribes to the bus per turn, splices the
 *      MediaBlock into its `tool_result` SSE event so the chat UI
 *      gets a structured media payload.
 *
 * Keep this file's tool surface stable: any new media-shaped tool
 * must follow the same emit-side-channel + return-plain-text pattern,
 * or the chat UI will silently miss its media block.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { MEDIA_CAPABILITY_SYSTEM_PROMPT } from '@/lib/media-capability-prompt';
import type { MediaBlock } from '@/types';
import { emitBuiltinEvent } from '@/lib/harness/builtin-event-bus';
import { makeToolCompleted } from '@/lib/runtime/event-adapter';
import { isXaiOAuthUsable } from '@/lib/xai-oauth-manager';
import { prepareMediaFailureForRethrow } from '@/lib/telemetry/media-failure';

export const MEDIA_SYSTEM_PROMPT = MEDIA_CAPABILITY_SYSTEM_PROMPT;

/** Map a mime type to a MediaBlock.type slot the chat UI knows how to
 *  render. Same logic the Codex bridge uses (builtin-bridge.ts
 *  `mediaTypeOf`); kept inline here so this file doesn't depend on a
 *  Codex-specific module. */
function mediaTypeOf(mimeType: string): 'image' | 'video' | 'audio' {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

/** Best-effort mime inference from filename extension. Used when
 *  `importFileToLibrary` returns a result that doesn't carry mimeType
 *  directly. Covers the same extensions the Codex bridge's
 *  `inferMimeFromPath` does (builtin-bridge.ts). */
function inferMimeFromPath(localPath: string): string {
  const idx = localPath.lastIndexOf('.');
  if (idx < 0) return 'application/octet-stream';
  const ext = localPath.toLowerCase().slice(idx);
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.avif': return 'image/avif';
    case '.svg': return 'image/svg+xml';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    default: return 'application/octet-stream';
  }
}

interface MediaToolOptions {
  sessionId?: string;
  workingDirectory?: string;
  providerId?: string;
  /** Test seam; production reads the current Grok Build OAuth status. */
  grokVideoAvailable?: boolean;
}

export function createMediaTools(options?: MediaToolOptions) {
  const sessionId = options?.sessionId;
  const tools: ToolSet = {
    codepilot_import_media: tool({
      description: 'Import a local file (image, video, audio) into the CodePilot media library.',
      inputSchema: z.object({
        filePath: z.string().describe('Path to the local file'),
        title: z.string().optional(),
        prompt: z.string().optional().describe('Generation prompt (if AI-generated)'),
        source: z.string().optional(),
        model: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      // Phase 5e Phase 0.5 P1 — second arg destructures ai-sdk's
      // `toolCallId` so the side-channel emit can be paired back to
      // the exact tool-result event in agent-loop.
      execute: async ({ filePath, title, prompt, source, model, tags }, execOptions) => {
        const execution = execOptions as { toolCallId?: string; abortSignal?: AbortSignal } | undefined;
        const toolCallId = execution?.toolCallId ?? '';
        try {
          const { importFileToLibrary } = await import('@/lib/media-saver');
          const result = importFileToLibrary(filePath, {
            sessionId,
            title,
            prompt,
            source,
            model,
            tags,
            cwd: options?.workingDirectory,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
          // `importFileToLibrary` can return either a typed result
          // object (newer call sites pass an options bag) or a string
          // (legacy). Narrow defensively — Native used to only read
          // the string form; now we want the structured form for the
          // MediaBlock.
          const localPath =
            typeof result === 'string'
              ? result
              : (result as { localPath?: string }).localPath ?? filePath;
          const mediaId =
            typeof result === 'string'
              ? undefined
              : (result as { mediaId?: string }).mediaId;
          const mimeType = inferMimeFromPath(localPath);
          const mediaType = mediaTypeOf(mimeType);

          // Side-channel: emit the MediaBlock to the harness bus so
          // agent-loop's tool_result SSE can splice it into the
          // `media` field. Model-visible text below stays clean
          // (no JSON blob).
          if (sessionId && toolCallId) {
            const block: MediaBlock = {
              type: mediaType,
              mimeType,
              localPath,
              ...(mediaId ? { mediaId } : {}),
            };
            emitBuiltinEvent(
              sessionId,
              makeToolCompleted(
                { runtimeId: 'codepilot_runtime', sessionId },
                {
                  toolId: toolCallId,
                  output: `Media imported: ${localPath}`,
                  media: [block],
                },
              ),
            );
          }
          return `Media imported: ${localPath} (type=${mediaType})`;
        } catch (err) {
          throw prepareMediaFailureForRethrow(err, 'Media import failed', {
            userCancelled: execution?.abortSignal?.aborted === true,
          });
        }
      },
    }),

    codepilot_generate_image: tool({
      description: 'Generate or edit an image using the configured media provider. Select grok-build when the user explicitly asks for Grok Imagine Image 2.0. The image appears inline in chat.',
      inputSchema: z.object({
        prompt: z.string().describe('Image generation prompt'),
        provider: z.enum(['active', 'grok-build']).optional().describe('Use grok-build only when the user requests Grok Imagine; otherwise use the active media provider.'),
        aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional(),
        imageSize: z.enum(['1K', '2K']).optional(),
        referenceImagePaths: z.array(z.string()).optional(),
      }),
      execute: async (
        { prompt, provider, aspectRatio, imageSize, referenceImagePaths },
        execOptions,
      ) => {
        const execution = execOptions as { toolCallId?: string; abortSignal?: AbortSignal } | undefined;
        const toolCallId = execution?.toolCallId ?? '';
        try {
          const { generateSingleImage } = await import('@/lib/image-generator');
          const result = await generateSingleImage({
            prompt,
            providerId: provider === 'grok-build' ? 'xai-oauth' : undefined,
            aspectRatio,
            imageSize,
            referenceImagePaths,
            sessionId,
            cwd: options?.workingDirectory,
            abortSignal: execution?.abortSignal,
          });

          // `generateSingleImage` returns either an `images[]` array
          // (Phase 5c onwards, the same shape the Codex bridge
          // consumes — see builtin-bridge.ts:300-305) or a legacy
          // shape with a single `localPath`. Build the MediaBlock[]
          // off whichever is present.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = result as any;
          const blocks: MediaBlock[] = [];
          if (Array.isArray(r.images)) {
            for (const img of r.images) {
              blocks.push({
                type: 'image',
                mimeType: img.mimeType ?? 'image/png',
                localPath: img.localPath,
                ...(r.mediaGenerationId ? { mediaId: r.mediaGenerationId } : {}),
              });
            }
          } else if (typeof r.localPath === 'string') {
            blocks.push({
              type: 'image',
              mimeType: 'image/png',
              localPath: r.localPath,
            });
          }

          const localPaths = blocks.map((b) => b.localPath).join(', ');
          const text =
            blocks.length > 0
              ? `Image generated successfully. Local paths: ${localPaths}`
              : 'Image generated.';

          if (sessionId && toolCallId && blocks.length > 0) {
            emitBuiltinEvent(
              sessionId,
              makeToolCompleted(
                { runtimeId: 'codepilot_runtime', sessionId },
                {
                  toolId: toolCallId,
                  output: text,
                  media: blocks,
                },
              ),
            );
          }
          return text;
        } catch (err) {
          throw prepareMediaFailureForRethrow(err, 'Image generation failed', {
            userCancelled: execution?.abortSignal?.aborted === true,
          });
        }
      },
    }),
  };

  const grokVideoAvailable = options?.grokVideoAvailable ?? isXaiOAuthUsable();
  if (grokVideoAvailable) {
    tools.codepilot_generate_video = tool({
      description: 'Generate a video with Grok Imagine Video 1.5 using the connected Grok Build OAuth account. Supports text-to-video, a single first-frame image, or multiple reference images. The result appears inline and is saved to Gallery.',
      inputSchema: z.object({
        prompt: z.string().describe('Detailed video generation prompt'),
        imagePath: z.string().optional().describe('Optional single source image to animate as the first frame'),
        referenceImagePaths: z.array(z.string()).max(7).optional().describe('Optional style/content reference images; ignored when imagePath is provided'),
        // Google `parameters` only accepts string enum values. AI SDK emits
        // the pipe's numeric input schema; Zod still validates 6 | 10 before
        // execute(), preserving both the numeric tool contract and its limits.
        duration: z.number().pipe(z.union([z.literal(6), z.literal(10)]))
          .optional().describe('Video duration in seconds. Must be 6 or 10; defaults to 6.'),
        aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']).optional(),
        resolution: z.enum(['480p', '720p']).optional(),
      }),
      execute: async (
        { prompt, imagePath, referenceImagePaths, duration, aspectRatio, resolution },
        execOptions,
      ) => {
        const execution = execOptions as { toolCallId?: string; abortSignal?: AbortSignal } | undefined;
        const toolCallId = execution?.toolCallId ?? '';
        try {
          const { generateGrokVideo } = await import('@/lib/xai-imagine');
          const result = await generateGrokVideo({
            prompt,
            imagePath,
            referenceImagePaths,
            duration,
            aspectRatio,
            resolution,
            sessionId,
            runtimeId: 'codepilot_runtime',
            cwd: options?.workingDirectory,
            abortSignal: execution?.abortSignal,
          });
          const block: MediaBlock = {
            type: 'video',
            mimeType: result.mimeType,
            localPath: result.localPath,
            mediaId: result.mediaGenerationId,
          };
          const text = `Video generated successfully (${result.elapsedMs}ms). Local path: ${result.localPath}`;
          if (sessionId && toolCallId) {
            emitBuiltinEvent(
              sessionId,
              makeToolCompleted(
                { runtimeId: 'codepilot_runtime', sessionId },
                { toolId: toolCallId, output: text, media: [block] },
              ),
            );
          }
          return text;
        } catch (err) {
          throw prepareMediaFailureForRethrow(err, 'Video generation failed', {
            userCancelled: execution?.abortSignal?.aborted === true,
          });
        }
      },
    });
  }
  return tools;
}
