import { generateImage, NoImageGeneratedError } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { getAllProviders, getDb, getSession, getSetting } from '@/lib/db';
import {
  findActiveAssetIdsByStablePaths,
  registerMediaGenerationAsset,
} from '@/lib/assets/service';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveCodePilotDataDir } from '@/lib/codepilot-data-dir';
import { isXaiOAuthUsable } from '@/lib/xai-oauth-manager';
import {
  readGrokReferenceImages,
  requestGrokImagineImage,
  XAI_IMAGINE_IMAGE_MODEL,
} from '@/lib/xai-imagine';
import { MediaUserActionError } from '@/lib/media-error';

const dataDir = resolveCodePilotDataDir();
const MEDIA_DIR = path.join(dataDir, '.codepilot-media');

export interface GenerateSingleImageParams {
  prompt: string;
  model?: string;
  /** Optional explicit provider row id. When present, forces that provider and overrides family inference. */
  providerId?: string;
  aspectRatio?: string;
  imageSize?: string;
  referenceImages?: { mimeType: string; data: string }[];
  referenceImagePaths?: string[];
  sessionId?: string;
  abortSignal?: AbortSignal;
  /** When true, skip disk write / project copy / DB insert — caller (MCP pipeline) handles persistence */
  skipSave?: boolean;
  /** Working directory for resolving relative referenceImagePaths */
  cwd?: string;
}

export interface GenerateSingleImageResult {
  mediaGenerationId: string;
  images: Array<{ mimeType: string; localPath: string; rawData?: Buffer }>;
  elapsedMs: number;
  /** Actual upstream model id used (resolved from params / extra_env / default) */
  model: string;
  /** Which provider family actually ran */
  family: 'gemini' | 'openai' | 'xai';
}

type ImageFamily = 'gemini' | 'openai' | 'xai';

interface XaiImageProviderSelection {
  providerId?: string;
  requestedFamily?: ImageFamily;
  activeProviderId?: string;
}

/**
 * Resolve whether image generation should use the Grok Build OAuth media
 * transport. Explicit media provider wins first, then an explicit image-model
 * family, and finally the Settings media default. The chat model/provider is
 * deliberately irrelevant: selecting Grok for text must not silently change
 * the provider shown in the image confirmation card or bill a different media
 * account.
 */
export function shouldUseXaiOAuthImageProvider(selection: XaiImageProviderSelection): boolean {
  if (selection.providerId) return selection.providerId === 'xai-oauth';
  if (selection.requestedFamily) return selection.requestedFamily === 'xai';
  return selection.activeProviderId === 'xai-oauth';
}

/** Infer which image family a model id belongs to. gpt-image-* / chatgpt-image-* → OpenAI; otherwise Gemini. */
function detectFamily(modelId: string | undefined): ImageFamily | undefined {
  if (!modelId) return undefined;
  if (/^grok-imagine-image/i.test(modelId)) return 'xai';
  if (/^gpt-image|^chatgpt-image/i.test(modelId)) return 'openai';
  if (/^gemini/i.test(modelId)) return 'gemini';
  return undefined;
}

// GPT Image 2 hard constraints from the OpenAI docs. Every WxH the mapper
// returns must satisfy all four; the test suite asserts this exhaustively.
const GPT_IMAGE_2_MAX_EDGE = 3840;
const GPT_IMAGE_2_MIN_PIXELS = 655_360;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_2_EDGE_STEP = 16;

// Per-tier anchors matching the "popular sizes" table in the Image generation
// guide. Non-square uses LONG edge (so "2K landscape" keeps long=2048, short
// derives from the selected ratio — e.g. 2048x1152 for 16:9, 2048x1536 for
// 4:3). Square uses a separate anchor because the popular sizes diverge
// there (1024/2048 at 1K/2K but 2880 at 4K to stay inside the pixel budget).
const TIER_LONG_EDGE: Record<string, number> = {
  '1K': 1536,
  '2K': 2048,
  '4K': GPT_IMAGE_2_MAX_EDGE,
};
const TIER_SQUARE_EDGE: Record<string, number> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 2880, // 2880² = 8,294,400 — exactly the pixel-budget ceiling.
};

function parseRatio(aspectRatio: string): { w: number; h: number } | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // GPT Image 2 rejects anything wider than 3:1 — same threshold the UI
  // ratios stay within (max is 21:9 = 2.33). If a future UI value violates
  // this, we fall through to the square default rather than send a size the
  // API will reject.
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > 3) return null;
  return { w, h };
}

const snap = (v: number) => Math.round(v / GPT_IMAGE_2_EDGE_STEP) * GPT_IMAGE_2_EDGE_STEP;

/**
 * Compute a valid GPT Image 2 size as close to the requested ratio + tier as
 * the constraints allow. Guarantees the returned pair is:
 *  • each edge a multiple of 16
 *  • each edge ≤ 3840
 *  • total pixels within [655,360, 8,294,400]
 *
 * Returns null if no valid size exists (shouldn't happen for UI inputs).
 */
function computeGptImage2Size(
  ratio: { w: number; h: number },
  tier: string,
): { width: number; height: number } | null {
  const r = ratio.w / ratio.h;
  const aspect = Math.max(r, 1 / r); // long:short, always ≥ 1

  // Square fast path — uses a separate tier table because the popular
  // square sizes don't follow the non-square anchors.
  if (aspect === 1) {
    const s = TIER_SQUARE_EDGE[tier] ?? TIER_SQUARE_EDGE['1K'];
    return { width: s, height: s };
  }

  // Non-square: anchor the long edge to the tier's long-edge target, derive
  // the short edge from the requested aspect.
  let longEdge = TIER_LONG_EDGE[tier] ?? TIER_LONG_EDGE['1K'];
  let shortEdge = longEdge / aspect;

  // Pixel-budget cap before snapping — at 4K, aspects close to 1:1 (e.g.
  // 4:3 / 4:5) drive long*short above 8,294,400. Scale both down
  // proportionally so the ratio is preserved.
  if (longEdge * shortEdge > GPT_IMAGE_2_MAX_PIXELS) {
    const scale = Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / (longEdge * shortEdge));
    longEdge = longEdge * scale;
    shortEdge = shortEdge * scale;
  }

  let long = Math.max(GPT_IMAGE_2_EDGE_STEP, snap(longEdge));
  let short = Math.max(GPT_IMAGE_2_EDGE_STEP, snap(shortEdge));
  if (long > GPT_IMAGE_2_MAX_EDGE) long = GPT_IMAGE_2_MAX_EDGE;
  if (short > GPT_IMAGE_2_MAX_EDGE) short = GPT_IMAGE_2_MAX_EDGE;

  // Claw back if snap-up overshot the pixel budget — shrink whichever edge
  // is further above its ideal (keeps output ratio close to the request).
  while (long * short > GPT_IMAGE_2_MAX_PIXELS) {
    if (long > short) long -= GPT_IMAGE_2_EDGE_STEP;
    else short -= GPT_IMAGE_2_EDGE_STEP;
    if (long < GPT_IMAGE_2_EDGE_STEP || short < GPT_IMAGE_2_EDGE_STEP) return null;
  }
  // Grow if snap-down pushed us below the minimum pixel count. Bias growth
  // toward whichever edge is shorter relative to the target ratio.
  while (long * short < GPT_IMAGE_2_MIN_PIXELS) {
    if (short < GPT_IMAGE_2_MAX_EDGE) short += GPT_IMAGE_2_EDGE_STEP;
    else if (long < GPT_IMAGE_2_MAX_EDGE) long += GPT_IMAGE_2_EDGE_STEP;
    else return null;
  }

  // Orient based on the original ratio (portrait keeps the long edge vertical).
  if (r < 1) return { width: short, height: long };
  return { width: long, height: short };
}

/**
 * Map UI aspectRatio + imageSize to a GPT Image size string "WxH".
 *
 * GPT Image 2 computes a ratio-faithful size per the constraints above —
 * 3:2 / 4:5 / 5:4 / 21:9 each get a distinct, valid output rather than
 * collapsing to landscape/portrait/square buckets.
 *
 * GPT Image 1 / 1-mini / 1.5 only accept the legacy trio
 * (1024x1024 / 1536x1024 / 1024x1536), so any other ratio/tier collapses to
 * the trio entry whose aspect is closest to the request.
 */
export function mapAspectToOpenAISize(
  aspectRatio: string,
  imageSize: string,
  modelId?: string,
): `${number}x${number}` {
  // Legacy matches: gpt-image-1, gpt-image-1-mini, gpt-image-1.5.
  // Unknown model ids assume the latest (gpt-image-2) to avoid silently
  // stripping 2K/4K from a correctly-configured new provider.
  const isLegacy = !!modelId && /^gpt-image-1(?:$|[-.])/i.test(modelId);

  const parsed = parseRatio(aspectRatio);

  if (isLegacy) {
    if (!parsed) return '1024x1024';
    const r = parsed.w / parsed.h;
    // Use 1.1 / 0.91 as a soft deadband around square — 4:3 / 3:4 still
    // round to the rectangular trio entries (4/3 ≈ 1.33, 3/4 ≈ 0.75).
    if (r > 1.1) return '1536x1024';
    if (r < 0.91) return '1024x1536';
    return '1024x1024';
  }

  if (!parsed) {
    // Unrecognized ratio string — fall through to a safe square at tier.
    if (imageSize === '4K') return '2880x2880';
    if (imageSize === '2K') return '2048x2048';
    return '1024x1024';
  }

  const size = computeGptImage2Size(parsed, imageSize);
  if (!size) {
    // Should be unreachable for any UI input; fall back to a safe default.
    return '1024x1024';
  }
  return `${size.width}x${size.height}` as `${number}x${number}`;
}

interface ProviderRow {
  id: string;
  provider_type: string;
  api_key: string;
  base_url: string;
  extra_env?: string;
}

/**
 * Select an image-generation provider row.
 *
 * Resolution order:
 *   1. If `providerId` is provided, match by id (must match a media provider with a key).
 *   2. If `family` is known (model prefix disambiguates OpenAI vs Gemini), match by provider_type.
 *   3. Fall back to the `active_image_provider_id` setting (user's explicit choice in settings).
 *   4. Prefer whichever family is configured, with Gemini winning when both exist (back-compat).
 */
function pickImageProvider(
  family: ImageFamily | undefined,
  providerId: string | undefined,
): { row: ProviderRow; family: ImageFamily } {
  // Provider secrets may be envelope-encrypted at rest. Always use the DB
  // accessor so selection sees the authenticated, in-memory plaintext and
  // never depends on the legacy api_key column.
  const rows = getAllProviders().filter(
    provider => (provider.provider_type === 'gemini-image' || provider.provider_type === 'openai-image')
      && !!provider.api_key,
  ) as ProviderRow[];

  if (rows.length === 0) {
    throw new MediaUserActionError(
      'MEDIA_PROVIDER_NOT_CONFIGURED',
      'No image provider configured. Please add a Gemini Image or OpenAI Image provider in Settings.',
    );
  }

  const toFamily = (pt: string): ImageFamily => (pt === 'openai-image' ? 'openai' : 'gemini');
  const byFamily = (f: ImageFamily) => rows.find(r => toFamily(r.provider_type) === f);

  // 1) Explicit provider id takes precedence over everything else.
  if (providerId) {
    const match = rows.find(r => r.id === providerId);
    if (!match) {
      throw new MediaUserActionError(
        'MEDIA_PROVIDER_UNAVAILABLE',
        `Image provider '${providerId}' is not configured or has no API key. Check Settings → Media Providers.`,
      );
    }
    return { row: match, family: toFamily(match.provider_type) };
  }

  // 2) Family hint from the model id (e.g. user passed model='gpt-image-2').
  if (family) {
    const match = byFamily(family);
    if (match) return { row: match, family };
    throw new MediaUserActionError(
      'MEDIA_PROVIDER_UNAVAILABLE',
      `No ${family === 'openai' ? 'OpenAI Image' : 'Gemini Image'} provider configured. Please add one in Settings.`,
    );
  }

  // 3) User-chosen active provider from settings.
  const activeId = getSetting('active_image_provider_id');
  if (activeId) {
    const match = rows.find(r => r.id === activeId);
    if (match) return { row: match, family: toFamily(match.provider_type) };
    // Stored id no longer valid (provider deleted / key cleared) — fall through
    // to the implicit picker rather than throwing, so callers aren't broken.
  }

  // 4) Fallback: prefer gemini for back-compat when both are configured.
  const gemini = byFamily('gemini');
  if (gemini) return { row: gemini, family: 'gemini' };
  const openai = byFamily('openai');
  if (openai) return { row: openai, family: 'openai' };
  // rows.length > 0 guarantees we won't reach here, but TypeScript wants it
  return { row: rows[0], family: toFamily(rows[0].provider_type) };
}

/**
 * Shared image generation function.
 * Handles: Provider lookup → Gemini / OpenAI API call → file save → project dir copy → DB record.
 */
export async function generateSingleImage(params: GenerateSingleImageParams): Promise<GenerateSingleImageResult> {
  const startTime = Date.now();

  const requestedFamily = detectFamily(params.model);
  const activeProviderId = getSetting('active_image_provider_id') || undefined;
  const useXaiOAuth = shouldUseXaiOAuthImageProvider({
    providerId: params.providerId,
    requestedFamily,
    activeProviderId,
  });
  if (useXaiOAuth && !isXaiOAuthUsable()) {
    throw new MediaUserActionError(
      'MEDIA_AUTH_REQUIRED',
      'Grok Imagine requires an active Grok Build OAuth login. Reconnect in Settings.',
    );
  }
  const selected = useXaiOAuth
    ? undefined
    : pickImageProvider(requestedFamily, params.providerId);
  const provider = selected?.row;
  const family: ImageFamily = useXaiOAuth ? 'xai' : selected!.family;

  // Read configured model from extra_env, fall back to family default
  let configuredModel = family === 'xai'
    ? XAI_IMAGINE_IMAGE_MODEL
    : family === 'openai'
      ? 'gpt-image-2'
      : 'gemini-3.1-flash-image-preview';
  if (provider) {
    try {
      const env = JSON.parse(provider.extra_env || '{}');
      const key = family === 'openai' ? 'OPENAI_IMAGE_MODEL' : 'GEMINI_IMAGE_MODEL';
      if (env[key]) configuredModel = env[key];
    } catch { /* use default */ }
  }

  let requestedModel = params.model || configuredModel;
  const aspectRatio = (params.aspectRatio || '1:1') as `${number}:${number}`;
  const imageSize = params.imageSize || '1K';
  if (family === 'xai' && imageSize !== '1K' && imageSize !== '2K') {
    throw new MediaUserActionError(
      'MEDIA_INPUT_UNSUPPORTED',
      'Grok Imagine Image 2.0 supports 1K or 2K resolution.',
    );
  }

  // Collect reference images (base64 strings). Both referenceImagePaths and
  // referenceImages may be provided together.
  const refImageData: string[] = [];
  const refImagePayloads: Array<{ mimeType: string; data: string }> = [];
  const resolvedReferencePaths: string[] = [];
  if (params.referenceImagePaths && params.referenceImagePaths.length > 0) {
    for (const fp of params.referenceImagePaths) {
      // Resolve relative paths against session working directory
      const resolved = path.isAbsolute(fp) ? fp : path.resolve(params.cwd || process.cwd(), fp);
      if (fs.existsSync(resolved)) {
        const buf = fs.readFileSync(resolved);
        const data = buf.toString('base64');
        refImageData.push(data);
        if (family === 'xai') {
          refImagePayloads.push(...readGrokReferenceImages([resolved]));
        }
        resolvedReferencePaths.push(resolved);
      }
    }
  }
  if (params.referenceImages && params.referenceImages.length > 0) {
    refImageData.push(...params.referenceImages.map(img => img.data));
    if (family === 'xai') refImagePayloads.push(...params.referenceImages);
  }

  let images: { mediaType: string; uint8Array: Uint8Array }[];

  if (family === 'xai') {
    const result = await requestGrokImagineImage({
      prompt: params.prompt,
      aspectRatio,
      resolution: imageSize === '2K' ? '2k' : '1k',
      referenceImages: refImagePayloads,
      abortSignal: params.abortSignal,
    });
    requestedModel = result.model;
    images = [{ mediaType: result.mimeType, uint8Array: result.bytes }];
  } else if (family === 'openai') {
    const openai = createOpenAI({
      apiKey: provider!.api_key,
      baseURL: provider!.base_url || undefined,
    });
    const size = mapAspectToOpenAISize(aspectRatio, imageSize, requestedModel);
    // When reference images are present, pass them as `prompt.images` — the
    // ai SDK routes this to /images/edits for OpenAI (see @ai-sdk/openai
    // image doGenerate) and supplies them as `input_image` for Gemini.
    const prompt = refImageData.length > 0
      ? { text: params.prompt, images: refImageData }
      : params.prompt;
    const result = await generateImage({
      model: openai.image(requestedModel),
      prompt,
      size,
      maxRetries: 3,
      abortSignal: params.abortSignal || AbortSignal.timeout(300_000),
    });
    images = result.images.map(img => ({ mediaType: img.mediaType, uint8Array: img.uint8Array }));
  } else {
    const google = createGoogleGenerativeAI({
      apiKey: provider!.api_key,
      baseURL: provider!.base_url || undefined,
    });
    const prompt = refImageData.length > 0
      ? { text: params.prompt, images: refImageData }
      : params.prompt;
    const result = await generateImage({
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
    images = result.images.map(img => ({ mediaType: img.mediaType, uint8Array: img.uint8Array }));
  }

  const elapsed = Date.now() - startTime;
  console.log(`[image-generator] ${family}:${requestedModel} ${imageSize} completed in ${elapsed}ms`);

  // skipSave mode: return raw image data without writing to disk or DB.
  // The MCP media pipeline (collectStreamResponse → saveMediaToLibrary) handles persistence.
  if (params.skipSave) {
    const rawImages = images.map(img => ({
      mimeType: img.mediaType,
      localPath: '',
      rawData: Buffer.from(img.uint8Array),
    }));
    return { mediaGenerationId: '', images: rawImages, elapsedMs: elapsed, model: requestedModel, family };
  }

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

  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO media_generations (id, type, status, provider, model, prompt, aspect_ratio, image_size, local_path, thumbnail_path, session_id, message_id, tags, metadata, error, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, 'image', 'completed', family, requestedModel, params.prompt,
      aspectRatio, imageSize, localPath, '',
      params.sessionId || null, null,
      '[]', JSON.stringify(metadata),
      null, now, now
    );
    registerMediaGenerationAsset({
      mediaGenerationId: id,
      producerId: 'image-generator',
      parentAssetIds: findActiveAssetIdsByStablePaths(resolvedReferencePaths),
    });
  })();

  return {
    mediaGenerationId: id,
    images: savedImages,
    elapsedMs: elapsed,
    model: requestedModel,
    family,
  };
}

// Re-export for backward compatibility in error handling
export { NoImageGeneratedError };
