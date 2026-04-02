/**
 * codepilot-image-gen MCP — in-process MCP server for Gemini image generation.
 *
 * The MCP tool calls generateSingleImage() which saves images to disk and DB.
 * It returns a text result with localPaths — the frontend renders them via
 * the tool_result media field that claude-client.ts injects from the paths.
 *
 * Keyword-gated: co-registered with codepilot-media when the conversation
 * involves media/image/video generation tasks.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { generateSingleImage, NoImageGeneratedError } from '@/lib/image-generator';

/**
 * Marker prefix in tool result text that claude-client.ts detects to construct
 * MediaBlock[] for the SSE event. Format: __MEDIA_RESULT__<JSON array of {type, mimeType, localPath}>
 */
export const MEDIA_RESULT_MARKER = '__MEDIA_RESULT__';

export function createImageGenMcpServer(sessionId?: string, workingDirectory?: string) {
  return createSdkMcpServer({
    name: 'codepilot-image-gen',
    version: '1.0.0',
    tools: [
      tool(
        'codepilot_generate_image',
        'Generate an image using Gemini. The generated image will automatically appear inline in the chat and be saved to the media library. Use this when the user asks you to create, draw, or generate an image. Write prompts in English for best results.',
        {
          prompt: z.string().describe('Detailed image generation prompt in English'),
          aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional().describe('Aspect ratio, defaults to 1:1'),
          imageSize: z.enum(['1K', '2K']).optional().describe('Output resolution, defaults to 1K'),
          referenceImagePaths: z.array(z.string()).optional().describe('Paths to reference images for style/content guidance'),
        },
        async ({ prompt, aspectRatio, imageSize, referenceImagePaths }) => {
          try {
            // generateSingleImage saves to disk + DB internally.
            // We return the localPaths as text so Claude can reference them
            // for continuous editing, and claude-client.ts detects the
            // MEDIA_RESULT_MARKER to inject media blocks into the SSE event.
            const result = await generateSingleImage({
              prompt,
              aspectRatio,
              imageSize,
              referenceImagePaths,
              sessionId,
              cwd: workingDirectory,
            });

            const mediaInfo = result.images.map(img => ({
              type: 'image' as const,
              mimeType: img.mimeType,
              localPath: img.localPath,
              mediaId: result.mediaGenerationId,
            }));

            const textResult = [
              `Image generated successfully (${result.elapsedMs}ms).`,
              `Local paths: ${result.images.map(img => img.localPath).join(', ')}`,
              `${MEDIA_RESULT_MARKER}${JSON.stringify(mediaInfo)}`,
            ].join('\n');

            return {
              content: [{ type: 'text' as const, text: textResult }],
            };
          } catch (error) {
            const message = NoImageGeneratedError.isInstance(error)
              ? 'Image generation succeeded but no image was returned by the model. Try a different prompt.'
              : error instanceof Error ? error.message : 'Image generation failed';
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
