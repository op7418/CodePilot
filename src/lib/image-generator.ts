import { generateImage, NoImageGeneratedError } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { getDb, getSession } from '@/lib/db';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
const MEDIA_DIR = path.join(dataDir, '.codepilot-media');

export interface GenerateSingleImageParams {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  referenceImages?: { mimeType: string; data: string }[];
  referenceImagePaths?: string[];
  sessionId?: string;
  abortSignal?: AbortSignal;
}

export interface GenerateSingleImageResult {
  mediaGenerationId: string;
  images: Array<{ mimeType: string; localPath: string }>;
  elapsedMs: number;
}

/**
 * Shared image generation function.
 * Handles: Provider lookup → Gemini API call → file save → project dir copy → DB record.
 */
export async function generateSingleImage(params: GenerateSingleImageParams): Promise<GenerateSingleImageResult> {
  const startTime = Date.now();

  const db = getDb();
  const provider = db.prepare(
    "SELECT api_key, base_url, extra_env FROM api_providers WHERE provider_type = 'gemini-image' AND api_key != '' LIMIT 1"
  ).get() as { api_key: string; base_url?: string; extra_env?: string } | undefined;

  if (!provider) {
    throw new Error('No Gemini Image provider configured. Please add a provider with type "gemini-image" in Settings.');
  }

  // Read configured model from extra_env, fall back to default
  let configuredModel = 'gemini-3.1-flash-image-preview';
  try {
    const env = JSON.parse(provider.extra_env || '{}');
    if (env.GEMINI_IMAGE_MODEL) configuredModel = env.GEMINI_IMAGE_MODEL;
  } catch { /* use default */ }

  const requestedModel = params.model || configuredModel;
  const aspectRatio = (params.aspectRatio || '1:1') as `${number}:${number}`;
  const imageSize = params.imageSize || '1K';

  const google = createGoogleGenerativeAI({
    apiKey: provider.api_key,
    baseURL: provider.base_url || undefined,
  });

  // Build prompt: plain string or { text, images } for reference images
  // Combine both base64 data and file paths — both can be provided simultaneously
  const refImageData: string[] = [];
  if (params.referenceImagePaths && params.referenceImagePaths.length > 0) {
    for (const filePath of params.referenceImagePaths) {
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        refImageData.push(buf.toString('base64'));
      }
    }
  }
  if (params.referenceImages && params.referenceImages.length > 0) {
    refImageData.push(...params.referenceImages.map(img => img.data));
  }
  const prompt = refImageData.length > 0
    ? { text: params.prompt, images: refImageData }
    : params.prompt;

  const { images } = await generateImage({
    model: google.image(requestedModel),
    prompt,
    providerOptions: {
      google: {
        imageConfig: { aspectRatio, imageSize },
      },
    },
    maxRetries: 3,
    abortSignal: params.abortSignal || AbortSignal.timeout(300_000),
  });

  const elapsed = Date.now() - startTime;
  console.log(`[image-generator] ${requestedModel} ${imageSize} completed in ${elapsed}ms`);

  // Ensure media directory exists
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }

  // Write images to disk
  const savedImages: Array<{ mimeType: string; localPath: string }> = [];
  for (const img of images) {
    const ext = img.mediaType === 'image/jpeg' ? '.jpg'
      : img.mediaType === 'image/webp' ? '.webp'
      : '.png';
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const filePath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(img.uint8Array));
    savedImages.push({ mimeType: img.mediaType, localPath: filePath });
  }

  // Copy images to project directory if sessionId is provided
  if (params.sessionId) {
    try {
      const session = getSession(params.sessionId);
      if (session?.working_directory) {
        const projectImgDir = path.join(session.working_directory, '.codepilot-images');
        if (!fs.existsSync(projectImgDir)) {
          fs.mkdirSync(projectImgDir, { recursive: true });
        }
        for (const saved of savedImages) {
          const destPath = path.join(projectImgDir, path.basename(saved.localPath));
          fs.copyFileSync(saved.localPath, destPath);
        }
        console.log(`[image-generator] Copied ${savedImages.length} image(s) to ${projectImgDir}`);
      }
    } catch (copyErr) {
      console.warn('[image-generator] Failed to copy images to project directory:', copyErr);
    }
  }

  // Save reference images to disk for gallery display
  const savedRefImages: Array<{ mimeType: string; localPath: string }> = [];
  if (refImageData.length > 0) {
    const refMimeTypes = params.referenceImages
      ? params.referenceImages.map(img => img.mimeType)
      : params.referenceImagePaths
        ? params.referenceImagePaths.map(() => 'image/png')
        : [];
    for (let i = 0; i < refImageData.length; i++) {
      const mime = refMimeTypes[i] || 'image/png';
      const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
      const filename = `ref-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const filePath = path.join(MEDIA_DIR, filename);
      fs.writeFileSync(filePath, Buffer.from(refImageData[i], 'base64'));
      savedRefImages.push({ mimeType: mime, localPath: filePath });
    }
  }

  // DB record
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const localPath = savedImages.length > 0 ? savedImages[0].localPath : '';

  const metadata: Record<string, unknown> = {
    imageCount: savedImages.length,
    elapsedMs: elapsed,
    model: requestedModel,
  };
  if (savedRefImages.length > 0) {
    metadata.referenceImages = savedRefImages;
  }

  db.prepare(
    `INSERT INTO media_generations (id, type, status, provider, model, prompt, aspect_ratio, image_size, local_path, thumbnail_path, session_id, message_id, tags, metadata, error, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, 'image', 'completed', 'gemini', requestedModel, params.prompt,
    aspectRatio, imageSize, localPath, '',
    params.sessionId || null, null,
    '[]', JSON.stringify(metadata),
    null, now, now
  );

  return {
    mediaGenerationId: id,
    images: savedImages,
    elapsedMs: elapsed,
  };
}

// Re-export for backward compatibility in error handling
export { NoImageGeneratedError };
