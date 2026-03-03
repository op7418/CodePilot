import { NextRequest } from 'next/server';
import { generateSingleImage, NoImageGeneratedError } from '@/lib/image-generator';

interface GenerateRequest {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  referenceImages?: { mimeType: string; data: string }[];
  referenceImagePaths?: string[];
  sessionId?: string;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body: GenerateRequest = await request.json();

    if (!body.prompt) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: prompt' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const result = await generateSingleImage({
      prompt: body.prompt,
      model: body.model,
      aspectRatio: body.aspectRatio,
      imageSize: body.imageSize,
      referenceImages: body.referenceImages,
      referenceImagePaths: body.referenceImagePaths,
      sessionId: body.sessionId,
    });

    return new Response(
      JSON.stringify({
        id: result.mediaGenerationId,
        text: '',
        images: result.images,
        model: body.model || 'gemini-3-pro-image-preview',
        imageSize: body.imageSize || '1K',
        elapsedMs: result.elapsedMs,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[media/generate] Failed:', error);

    // Extract detailed info from AI SDK APICallError
    const apiError = error as { url?: string; statusCode?: number; responseBody?: string };
    if (apiError.url || apiError.responseBody) {
      console.error('[media/generate] API details:', {
        url: apiError.url,
        statusCode: apiError.statusCode,
        responseBody: apiError.responseBody?.slice(0, 2000),
      });
    }

    if (NoImageGeneratedError.isInstance(error)) {
      return new Response(
        JSON.stringify({ error: 'No images were generated. Try a different prompt.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to generate image';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
