/**
 * Structured output route — generates JSON conforming to a schema.
 *
 * Uses Vercel AI SDK generateText with output option.
 * No Claude Code SDK dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { generateText, Output, jsonSchema } from 'ai';
import { createModel } from '@/lib/ai-provider';
import { ProviderCallPolicyError } from '@/lib/provider-call-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt, outputFormat, options } = body;

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    // Validate outputFormat: must be { type: 'json_schema', schema: { ... } }
    if (
      !outputFormat ||
      typeof outputFormat !== 'object' ||
      outputFormat.type !== 'json_schema' ||
      !outputFormat.schema ||
      typeof outputFormat.schema !== 'object'
    ) {
      return NextResponse.json(
        { error: 'outputFormat must be { type: "json_schema", schema: { ... } }' },
        { status: 400 },
      );
    }

    // Create model via unified provider factory
    const { languageModel } = createModel({
      callScene: 'structured_generation',
      providerId: options?.providerId,
      model: options?.model,
    });

    // Use generateText with structured output
    const result = await generateText({
      model: languageModel,
      prompt,
      output: Output.object({ schema: jsonSchema(outputFormat.schema) }),
      maxOutputTokens: options?.maxTokens || 4096,
    });

    // Return structured output
    if (result.output !== undefined) {
      return NextResponse.json({ result: result.output });
    }

    // Fallback: try to parse text as JSON
    if (result.text) {
      try {
        const parsed = JSON.parse(result.text);
        return NextResponse.json({ result: parsed });
      } catch {
        return NextResponse.json({ result: result.text });
      }
    }

    return NextResponse.json({ result: null });
  } catch (error) {
    console.error('[structured] Structured query failed:', error);
    if (error instanceof ProviderCallPolicyError) {
      return NextResponse.json(
        { error: error.message, code: error.code, scene: error.scene },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
