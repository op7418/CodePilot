import { NextRequest } from 'next/server';
import { streamTextFromProvider } from '@/lib/text-generator';
import { resolveProvider } from '@/lib/provider-resolver';
import fs from 'fs';
import type { PlanMediaJobRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const PLANNER_SYSTEM_PROMPT = `You are an image generation planner. Given document content and a style prompt, you must plan a series of image generation tasks.

Your output MUST be a valid JSON object with this exact structure:
{
  "summary": "Brief summary of the plan",
  "items": [
    {
      "prompt": "Detailed image generation prompt",
      "aspectRatio": "1:1",
      "resolution": "1K",
      "tags": ["tag1", "tag2"],
      "sourceRefs": ["reference to source document section"]
    }
  ]
}

Guidelines:
- Each prompt should be detailed, specific, and optimized for AI image generation
- Incorporate the style prompt into each item's prompt naturally
- Choose appropriate aspect ratios based on content (1:1, 16:9, 9:16, 3:2, 4:3, etc.)
- Add relevant tags for organization
- Reference the source document sections that inspired each image
- Keep resolution at "1K" unless the content specifically needs higher resolution
- Generate the requested number of items, or determine an appropriate count from the content`;

/**
 * POST /api/media/jobs/plan — SSE streaming planner
 * Does NOT write to DB — returns plan for client preview/editing
 */
export async function POST(request: NextRequest) {
  try {
    const body: PlanMediaJobRequest = await request.json();

    if (!body.stylePrompt) {
      return Response.json(
        { error: 'stylePrompt is required' },
        { status: 400 }
      );
    }

    // Resolve the provider and model from the session or defaults
    let session: { provider_id: string; model: string } | undefined;
    if (body.sessionId) {
      const { getDb } = await import('@/lib/db');
      const db = getDb();
      session = db.prepare('SELECT provider_id, model FROM chat_sessions WHERE id = ?').get(body.sessionId) as { provider_id: string; model: string } | undefined;
    }

    const resolved = resolveProvider({
      callScene: 'media_plan',
      sessionProviderId: session?.provider_id || undefined,
      sessionModel: session?.model || undefined,
    });
    // Preserve 'env' semantics (see onboarding route for rationale)
    const providerId = resolved.provider?.id || 'env';
    const modelId = resolved.upstreamModel || resolved.model || session?.model || 'claude-sonnet-4-6';

    // Read document content
    let docContent = body.docContent || '';
    if (body.docPaths && body.docPaths.length > 0 && !docContent) {
      const parts: string[] = [];
      for (const docPath of body.docPaths) {
        try {
          const stat = fs.statSync(docPath);
          if (stat.size > 100 * 1024) {
            parts.push(`[File: ${docPath} — skipped, too large (${Math.round(stat.size / 1024)}KB)]`);
            continue;
          }
          const content = fs.readFileSync(docPath, 'utf-8');
          parts.push(`--- File: ${docPath} ---\n${content}`);
        } catch {
          parts.push(`[File: ${docPath} — could not be read]`);
        }
      }
      docContent = parts.join('\n\n');
    }

    // Build the user prompt
    const countHint = body.count ? `Generate exactly ${body.count} image items.` : 'Determine the appropriate number of images based on the content.';
    const userPrompt = `Style prompt: ${body.stylePrompt}

${countHint}

${docContent ? `Document content:\n${docContent}` : 'No document provided — generate images based on the style prompt alone.'}`;

    // Create SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        send('planning_start', { message: 'Starting plan generation...' });

        try {
          let fullText = '';

          for await (const chunk of streamTextFromProvider({
            callScene: 'media_plan',
            providerId,
            model: modelId,
            system: PLANNER_SYSTEM_PROMPT,
            prompt: userPrompt,
            maxTokens: 4096,
          })) {
            fullText += chunk;
            send('text', { chunk });
          }

          // Extract JSON from the response
          const jsonMatch = fullText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            send('error', { message: 'Failed to extract plan JSON from LLM response' });
            send('done', {});
            controller.close();
            return;
          }

          const plan = JSON.parse(jsonMatch[0]);
          send('plan_complete', { plan });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Planning failed';
          send('error', { message });
        }

        send('done', {});
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[api/media/jobs/plan] POST failed:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Planning failed' },
      { status: 500 }
    );
  }
}
