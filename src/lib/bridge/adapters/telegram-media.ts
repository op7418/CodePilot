/**
 * Telegram Media — download and process images from Telegram messages.
 *
 * Handles photo[] size selection, file download via Bot API, base64 conversion,
 * and document-type image validation. Produces FileAttachment objects that plug
 * directly into the existing streamClaude vision pipeline.
 */

import type { FileAttachment } from '@/types';
import { getSetting } from '../../db';

const TELEGRAM_API = 'https://api.telegram.org';

/** Claude vision optimal long-edge size (px). */
const OPTIMAL_LONG_EDGE = 1568;

/** Default max image size in bytes (20 MB). */
const DEFAULT_MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Max retry attempts for download. */
const MAX_RETRIES = 3;

/** Supported image MIME types for Claude vision. */
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// ── Telegram Photo Types ─────────────────────────────────────

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

// ── Download Result ──────────────────────────────────────────

export type MediaRejectCode = 'too_large' | 'unsupported_type' | 'download_failed';

/** Unified result for all media download attempts. */
export interface MediaDownloadResult {
  attachment: FileAttachment | null;
  /** Rejection code — set when attachment is null and failure is user-actionable. */
  rejected?: MediaRejectCode;
  /** Human-readable rejection message for display in Telegram. */
  rejectedMessage?: string;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Check whether the Telegram image feature is enabled.
 */
export function isImageEnabled(): boolean {
  const setting = getSetting('bridge_telegram_image_enabled');
  // Default to true if not explicitly set to 'false'
  return setting !== 'false';
}

/**
 * Get the configured max image size in bytes.
 */
function getMaxImageSize(): number {
  const setting = getSetting('bridge_telegram_max_image_size');
  if (setting) {
    const parsed = parseInt(setting, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_IMAGE_SIZE;
}

/**
 * Check if a MIME type is a supported image format.
 */
export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime.toLowerCase());
}

/**
 * Infer MIME type from a file path/name extension.
 * Returns undefined if the extension is not a recognized image type.
 */
export function inferMimeType(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return undefined;
  }
}

/**
 * Select the optimal photo size from Telegram's photo[] array.
 *
 * Strategy: sort by long edge ascending, pick the smallest version whose
 * long edge >= OPTIMAL_LONG_EDGE (1568px, Claude vision optimal). If none
 * are large enough, take the largest available.
 */
export function selectOptimalPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize {
  if (photos.length === 1) return photos[0];

  // Sort by long edge ascending
  const sorted = [...photos].sort((a, b) => {
    const aLong = Math.max(a.width, a.height);
    const bLong = Math.max(b.width, b.height);
    return aLong - bLong;
  });

  // Find smallest version with long edge >= optimal
  for (const photo of sorted) {
    const longEdge = Math.max(photo.width, photo.height);
    if (longEdge >= OPTIMAL_LONG_EDGE) {
      return photo;
    }
  }

  // None large enough — take the largest
  return sorted[sorted.length - 1];
}

/**
 * Download a photo from Telegram's photo[] array.
 *
 * Selects the optimal size, calls getFile API, downloads the binary,
 * and converts to base64.
 */
export async function downloadPhoto(
  botToken: string,
  photos: TelegramPhotoSize[],
  messageId: string,
): Promise<MediaDownloadResult> {
  const selected = selectOptimalPhoto(photos);
  return downloadFileById(botToken, selected.file_id, messageId);
}

/**
 * Download a document-type image from Telegram.
 *
 * Pre-checks file_size against the max limit before initiating download.
 */
export async function downloadDocumentImage(
  botToken: string,
  doc: TelegramDocument,
  messageId: string,
): Promise<MediaDownloadResult> {
  // Check MIME type
  const mime = doc.mime_type || inferMimeType(doc.file_name || '');
  if (!mime || !isSupportedImageMime(mime)) {
    return { attachment: null, rejected: 'unsupported_type' };
  }

  // Pre-check file size before downloading
  const maxSize = getMaxImageSize();
  if (doc.file_size && doc.file_size > maxSize) {
    return {
      attachment: null,
      rejected: 'too_large',
      rejectedMessage: formatSizeError(doc.file_size, maxSize),
    };
  }

  return downloadFileById(botToken, doc.file_id, messageId);
}

// ── Internal ─────────────────────────────────────────────────

/**
 * Download a file by its Telegram file_id.
 * Calls getFile → download URL → binary → base64 FileAttachment.
 * Retries up to MAX_RETRIES with exponential backoff.
 */
async function downloadFileById(
  botToken: string,
  fileId: string,
  messageId: string,
): Promise<MediaDownloadResult> {
  const maxSize = getMaxImageSize();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Step 1: Get file path from Telegram
      const getFileUrl = `${TELEGRAM_API}/bot${botToken}/getFile`;
      const getFileRes = await fetch(getFileUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(15_000),
      });

      const getFileData = await getFileRes.json();
      if (!getFileData.ok || !getFileData.result?.file_path) {
        console.warn(`[telegram-media] getFile failed for ${fileId}:`, getFileData.description);
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * Math.pow(2, attempt - 1));
          continue;
        }
        return { attachment: null, rejected: 'download_failed', rejectedMessage: 'Failed to get file info from Telegram.' };
      }

      const filePath: string = getFileData.result.file_path;
      const fileSize: number | undefined = getFileData.result.file_size;

      // Pre-check size from API response
      if (fileSize && fileSize > maxSize) {
        console.warn(`[telegram-media] File too large: ${fileSize} bytes (max ${maxSize})`);
        return { attachment: null, rejected: 'too_large', rejectedMessage: formatSizeError(fileSize, maxSize) };
      }

      // Step 2: Download the file
      const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
      const downloadRes = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(60_000),
      });

      if (!downloadRes.ok) {
        console.warn(`[telegram-media] Download failed: HTTP ${downloadRes.status}`);
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * Math.pow(2, attempt - 1));
          continue;
        }
        return { attachment: null, rejected: 'download_failed', rejectedMessage: 'Failed to download image from Telegram.' };
      }

      // Check Content-Length header
      const contentLength = downloadRes.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSize) {
        console.warn(`[telegram-media] Content-Length exceeds max: ${contentLength}`);
        return { attachment: null, rejected: 'too_large', rejectedMessage: formatSizeError(parseInt(contentLength, 10), maxSize) };
      }

      // Step 3: Read buffer and validate actual size
      const buffer = Buffer.from(await downloadRes.arrayBuffer());
      if (buffer.length > maxSize) {
        console.warn(`[telegram-media] Downloaded buffer too large: ${buffer.length} bytes`);
        return { attachment: null, rejected: 'too_large', rejectedMessage: formatSizeError(buffer.length, maxSize) };
      }

      // Step 4: Determine MIME type
      const mime = inferMimeType(filePath) || 'image/jpeg';

      // Step 5: Convert to base64 and build FileAttachment
      const base64 = buffer.toString('base64');
      const fileName = filePath.split('/').pop() || `image_${messageId}`;

      return {
        attachment: {
          id: `tg-${messageId}-${fileId.slice(0, 8)}`,
          name: fileName,
          type: mime,
          size: buffer.length,
          data: base64,
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[telegram-media] Download attempt ${attempt}/${MAX_RETRIES} failed:`, errMsg);

      if (attempt < MAX_RETRIES) {
        await sleep(1000 * Math.pow(2, attempt - 1));
        continue;
      }
      return { attachment: null, rejected: 'download_failed', rejectedMessage: 'Image download failed after retries.' };
    }
  }

  return { attachment: null, rejected: 'download_failed', rejectedMessage: 'Image download failed after retries.' };
}

/** Format a human-readable size-exceeded error message. */
function formatSizeError(actualBytes: number, limitBytes: number): string {
  const actualMB = (actualBytes / (1024 * 1024)).toFixed(1);
  const limitMB = (limitBytes / (1024 * 1024)).toFixed(0);
  return `Image too large (${actualMB} MB, limit ${limitMB} MB). Please send as a photo instead of a file.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
