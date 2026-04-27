/**
 * Telegram Media — download and process images and documents from Telegram messages.
 *
 * Handles photo[] size selection, file download via Bot API, base64 conversion,
 * image validation, and arbitrary document attachments. Produces FileAttachment
 * objects that plug directly into the streamClaude pipeline (vision for images,
 * Read-tool path for non-image files via claude-client.ts).
 */

import type { FileAttachment } from '@/types';
import { getSetting } from '../../db';

const TELEGRAM_API = 'https://api.telegram.org';

/** Claude vision optimal long-edge size (px). */
const OPTIMAL_LONG_EDGE = 1568;

/** Default max image size in bytes (20 MB). */
const DEFAULT_MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Default max non-image file size in bytes (20 MB — Telegram Bot API ceiling). */
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;

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
 * Check whether the Telegram non-image document feature is enabled.
 */
export function isDocumentEnabled(): boolean {
  const setting = getSetting('bridge_telegram_document_enabled');
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
 * Get the configured max non-image file size in bytes.
 */
function getMaxFileSize(): number {
  const setting = getSetting('bridge_telegram_max_document_size');
  if (setting) {
    const parsed = parseInt(setting, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_FILE_SIZE;
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
  return downloadFileById(botToken, selected.file_id, messageId, {
    maxSize: getMaxImageSize(),
    mimeFallback: 'image/jpeg',
    nameFallback: `image_${messageId}`,
    kind: 'image',
  });
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
      rejectedMessage: formatSizeError(doc.file_size, maxSize, 'image'),
    };
  }

  return downloadFileById(botToken, doc.file_id, messageId, {
    maxSize,
    mimeOverride: mime,
    nameOverride: doc.file_name,
    mimeFallback: 'image/jpeg',
    nameFallback: `image_${messageId}`,
    kind: 'image',
  });
}

/**
 * Download a non-image document from Telegram.
 *
 * Preserves the user-supplied filename and Telegram-reported MIME so Claude
 * can recognize the file format when reading via its Read tool. Pre-checks
 * file_size against the max limit before initiating download.
 */
export async function downloadDocument(
  botToken: string,
  doc: TelegramDocument,
  messageId: string,
): Promise<MediaDownloadResult> {
  const maxSize = getMaxFileSize();
  if (doc.file_size && doc.file_size > maxSize) {
    return {
      attachment: null,
      rejected: 'too_large',
      rejectedMessage: formatSizeError(doc.file_size, maxSize, 'file'),
    };
  }

  return downloadFileById(botToken, doc.file_id, messageId, {
    maxSize,
    mimeOverride: doc.mime_type,
    nameOverride: doc.file_name,
    mimeFallback: 'application/octet-stream',
    nameFallback: `file_${messageId}`,
    kind: 'file',
  });
}

// ── Internal ─────────────────────────────────────────────────

interface DownloadFileOptions {
  /** Maximum allowed size in bytes. */
  maxSize: number;
  /** Pre-known MIME (e.g. from TelegramDocument.mime_type). Skips inference. */
  mimeOverride?: string;
  /** Pre-known filename (e.g. from TelegramDocument.file_name). Skips path basename. */
  nameOverride?: string;
  /** MIME used when neither override nor inferMimeType yields a value. */
  mimeFallback: string;
  /** Filename used when neither override nor path basename yields a value. */
  nameFallback: string;
  /** Used to format the size-exceeded error message with appropriate hint. */
  kind: 'image' | 'file';
}

/**
 * Download a file by its Telegram file_id.
 * Calls getFile → download URL → binary → base64 FileAttachment.
 * Retries up to MAX_RETRIES with exponential backoff.
 */
async function downloadFileById(
  botToken: string,
  fileId: string,
  messageId: string,
  opts: DownloadFileOptions,
): Promise<MediaDownloadResult> {
  const { maxSize, mimeOverride, nameOverride, mimeFallback, nameFallback, kind } = opts;
  const downloadFailMessage = kind === 'image'
    ? 'Failed to download image from Telegram.'
    : 'Failed to download file from Telegram.';
  const retriesExhaustedMessage = kind === 'image'
    ? 'Image download failed after retries.'
    : 'File download failed after retries.';

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
        return { attachment: null, rejected: 'too_large', rejectedMessage: formatSizeError(fileSize, maxSize, kind) };
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
        return { attachment: null, rejected: 'download_failed', rejectedMessage: downloadFailMessage };
      }

      // Check Content-Length header
      const contentLength = downloadRes.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSize) {
        console.warn(`[telegram-media] Content-Length exceeds max: ${contentLength}`);
        return { attachment: null, rejected: 'too_large', rejectedMessage: formatSizeError(parseInt(contentLength, 10), maxSize, kind) };
      }

      // Step 3: Read buffer and validate actual size
      const buffer = Buffer.from(await downloadRes.arrayBuffer());
      if (buffer.length > maxSize) {
        console.warn(`[telegram-media] Downloaded buffer too large: ${buffer.length} bytes`);
        return { attachment: null, rejected: 'too_large', rejectedMessage: formatSizeError(buffer.length, maxSize, kind) };
      }

      // Step 4: Determine MIME and filename — prefer overrides (Telegram-reported metadata),
      // then infer from path, then fall back. This preserves original document filenames
      // and accurate MIMEs (e.g. application/pdf) so Claude can read them correctly.
      const mime = mimeOverride || inferMimeType(filePath) || mimeFallback;
      const fileName = nameOverride || filePath.split('/').pop() || nameFallback;

      // Step 5: Convert to base64 and build FileAttachment
      const base64 = buffer.toString('base64');

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
      return { attachment: null, rejected: 'download_failed', rejectedMessage: retriesExhaustedMessage };
    }
  }

  return { attachment: null, rejected: 'download_failed', rejectedMessage: retriesExhaustedMessage };
}

/** Format a human-readable size-exceeded error message. */
function formatSizeError(actualBytes: number, limitBytes: number, kind: 'image' | 'file'): string {
  const actualMB = (actualBytes / (1024 * 1024)).toFixed(1);
  const limitMB = (limitBytes / (1024 * 1024)).toFixed(0);
  if (kind === 'image') {
    return `Image too large (${actualMB} MB, limit ${limitMB} MB). Please send as a photo instead of a file.`;
  }
  return `File too large (${actualMB} MB, limit ${limitMB} MB).`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
