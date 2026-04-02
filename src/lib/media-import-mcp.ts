/**
 * codepilot-media MCP — in-process MCP server for media library import.
 *
 * Replaces the CLI curl approach (POST /api/media/import) with a native MCP
 * tool that Claude can call directly. Keyword-gated: only registered when
 * the conversation involves media/image/video generation tasks.
 *
 * Follows the same pattern as widget-guidelines.ts createWidgetMcpServer().
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { importFileToLibrary } from '@/lib/media-saver';
import path from 'path';

/** Must match the marker in image-gen-mcp.ts and claude-client.ts */
const MEDIA_RESULT_MARKER = '__MEDIA_RESULT__';

// ── System prompt hint ──────────────────────────────────────────────

export const MEDIA_MCP_SYSTEM_PROMPT = `<media-capability>
You have access to media tools:
- codepilot_generate_image: Generate images via Gemini. Images appear inline in the chat and are auto-saved to the media library. Always write prompts in English for best results.
- codepilot_import_media: Import an existing local file (image/video/audio) into the media library and display it inline in the chat.

IMPORTANT RULES:
1. After ANY CLI tool (dreamina, comfyui, stable-diffusion, midjourney, etc.) generates a media file, you MUST call codepilot_import_media to display it in the chat. Do NOT use the Read tool — Read only shows images to you (the AI) but does NOT display them to the user.
2. Do NOT use curl or HTTP requests to interact with the media API.
3. When calling codepilot_import_media, ALWAYS extract and fill in ALL available metadata from the CLI tool's output:
   - prompt: the generation prompt that was used
   - model: the model name (e.g. "seedance-2.0", "flux-1", "sdxl")
   - resolution: the output resolution (e.g. "2K", "4096x4096", "1920x1080")
   - aspectRatio: the aspect ratio (e.g. "1:1", "16:9")
   - source: the tool name (e.g. "dreamina", "comfyui")
   These fields are critical for the media library — do not leave them empty if the information is available in the CLI output or from the generation parameters.
</media-capability>`;

// ── MCP server factory ──────────────────────────────────────────────

export function createMediaImportMcpServer(sessionId?: string, workingDirectory?: string) {
  return createSdkMcpServer({
    name: 'codepilot-media',
    version: '1.0.0',
    tools: [
      tool(
        'codepilot_import_media',
        'Import a local file (image, video, audio) into the CodePilot media library. Use this when the user asks to save a generated or downloaded media file to the library. The file must exist on disk. Always fill in prompt, model, resolution, and source when available.',
        {
          filePath: z.string().describe('Absolute or relative path to the media file on disk'),
          title: z.string().optional().describe('Display title for the media in the library'),
          prompt: z.string().optional().describe('The generation prompt used to create this media (if known)'),
          source: z.string().optional().describe('Source identifier, e.g. "dreamina", "comfyui", "stable-diffusion"'),
          model: z.string().optional().describe('The model used to generate, e.g. "seedance-2.0", "flux-1"'),
          resolution: z.string().optional().describe('Resolution or dimensions, e.g. "2K", "4096x4096", "1920x1080"'),
          aspectRatio: z.string().optional().describe('Aspect ratio, e.g. "1:1", "16:9"'),
          tags: z.array(z.string()).optional().describe('Tags for categorizing the media'),
        },
        async ({ filePath, title, prompt, source, model, resolution, aspectRatio, tags }) => {
          try {
            const result = importFileToLibrary(filePath, {
              prompt: prompt || title,
              source: source || 'mcp-import',
              tags,
              sessionId,
              model,
              aspectRatio,
              imageSize: resolution,
              cwd: workingDirectory,
            });

            // Detect media type from extension
            const ext = path.extname(filePath).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
              '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
              '.avif': 'image/avif', '.bmp': 'image/bmp',
              '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
              '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
              '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
              '.flac': 'audio/flac', '.aac': 'audio/aac',
            };
            const mimeType = mimeMap[ext] || 'application/octet-stream';
            // Derive media type from MIME — reliable and consistent with mimeMap
            const mediaType = mimeType.startsWith('video/') ? 'video'
              : mimeType.startsWith('audio/') ? 'audio'
              : 'image';

            // Include MEDIA_RESULT_MARKER so claude-client.ts injects MediaBlock
            // into the SSE event, enabling inline rendering in the chat.
            const mediaInfo = [{
              type: mediaType,
              mimeType,
              localPath: result.localPath,
              mediaId: result.mediaId,
            }];

            const textResult = [
              `Imported successfully. Media ID: ${result.mediaId}`,
              `Local path: ${result.localPath}`,
              `${MEDIA_RESULT_MARKER}${JSON.stringify(mediaInfo)}`,
            ].join('\n');

            return {
              content: [{ type: 'text' as const, text: textResult }],
            };
          } catch (error) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : 'Import failed',
                }),
              }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
