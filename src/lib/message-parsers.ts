/**
 * Shared message content parsers.
 *
 * Extracted from MessageItem.tsx and StreamingMessage.tsx to:
 *   1. Eliminate duplicate parsing logic across components
 *   2. Enable module-level caching (parsers are pure functions)
 *   3. Reduce bundle size by deduplicating identical regex + JSON logic
 *
 * These parsers detect structured content blocks (image-gen requests,
 * batch plans, show-widget fences) embedded in assistant message text.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ImageGenRequest {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  referenceImages?: string[];
  useLastGenerated?: boolean;
}

export interface ImageGenResultData {
  status: 'generating' | 'completed' | 'error';
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  model?: string;
  images?: Array<{ mimeType: string; localPath?: string; data?: string }>;
  error?: string;
}

export interface ShowWidgetData {
  title?: string;
  widget_code: string;
}

export type WidgetSegment =
  | { type: 'text'; content: string }
  | { type: 'widget'; data: ShowWidgetData }
  | { type: 'malformed_widget'; reason: string; raw: string };

export interface ParsedImageGenRequest {
  beforeText: string;
  request: ImageGenRequest;
  afterText: string;
  rawBlock: string;
}

export interface ParsedImageGenResult {
  beforeText: string;
  result: ImageGenResultData;
  afterText: string;
}

export interface ParsedBatchPlan {
  beforeText: string;
  plan: {
    summary: string;
    items: Array<{
      prompt: string;
      aspectRatio: string;
      resolution: string;
      tags: string[];
      sourceRefs: string[];
    }>;
  };
  afterText: string;
}

// ── Cache for parsed results ───────────────────────────────────────────

/**
 * WeakMap cache keyed on the string reference identity.
 * When the same string reference is passed (common during React re-renders
 * where message.content hasn't changed), the cached result is returned.
 * The WeakMap allows GC to collect entries when strings are no longer referenced.
 */
const parseCache = new WeakMap<object, Map<string, unknown>>();

function cachedParse<T>(text: string, parser: () => T, parserKey: string): T {
  let textCache = parseCache.get(text as unknown as object);
  if (!textCache) {
    textCache = new Map();
    parseCache.set(text as unknown as object, textCache);
  }
  const cached = textCache.get(parserKey) as T | undefined;
  if (cached !== undefined) return cached;
  const result = parser();
  textCache.set(parserKey, result);
  return result;
}

// ── Image Gen Request Parser ───────────────────────────────────────────

const IMAGE_GEN_REQUEST_RE = /```image-gen-request\s*\n?([\s\S]*?)\n?\s*```/;

export function parseImageGenRequest(text: string): ParsedImageGenRequest | null {
  return cachedParse(text, () => {
    const match = text.match(IMAGE_GEN_REQUEST_RE);
    if (!match) return null;
    try {
      let raw = match[1].trim();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw);
      } catch {
        // Attempt to fix common model output issues: unescaped quotes in values
        raw = raw.replace(/"prompt"\s*:\s*"([\s\S]*?)"\s*([,}])/g, (_m, val, tail) => {
          const escaped = val.replace(/(?<!\\)"/g, '\\"');
          return `"prompt": "${escaped}"${tail}`;
        });
        json = JSON.parse(raw);
      }
      const beforeText = text.slice(0, match.index).trim();
      const afterText = text.slice((match.index || 0) + match[0].length).trim();
      return {
        beforeText,
        request: {
          prompt: String(json.prompt || ''),
          aspectRatio: String(json.aspectRatio || '1:1'),
          resolution: String(json.resolution || '1K'),
          referenceImages: Array.isArray(json.referenceImages) ? json.referenceImages : undefined,
          useLastGenerated: json.useLastGenerated === true,
        },
        afterText,
        rawBlock: match[0],
      };
    } catch {
      return null;
    }
  }, 'image-gen-request');
}

// ── Image Gen Result Parser ────────────────────────────────────────────

const IMAGE_GEN_RESULT_RE = /```image-gen-result\s*\n?([\s\S]*?)\n?\s*```/;

export function parseImageGenResult(text: string): ParsedImageGenResult | null {
  return cachedParse(text, () => {
    const match = text.match(IMAGE_GEN_RESULT_RE);
    if (!match) return null;
    try {
      const json = JSON.parse(match[1]);
      const beforeText = text.slice(0, match.index).trim();
      const afterText = text.slice((match.index || 0) + match[0].length).trim();
      return {
        beforeText,
        result: {
          status: json.status || 'completed',
          prompt: String(json.prompt || ''),
          aspectRatio: json.aspectRatio,
          resolution: json.resolution,
          model: json.model,
          images: Array.isArray(json.images) ? json.images : undefined,
          error: json.error,
        },
        afterText,
      };
    } catch {
      return null;
    }
  }, 'image-gen-result');
}

// ── Batch Plan Parser ──────────────────────────────────────────────────

const BATCH_PLAN_RE = /```batch-plan\s*\n?([\s\S]*?)\n?\s*```/;

export function parseBatchPlan(text: string): ParsedBatchPlan | null {
  return cachedParse(text, () => {
    const match = text.match(BATCH_PLAN_RE);
    if (!match) return null;
    try {
      const json = JSON.parse(match[1]);
      const beforeText = text.slice(0, match.index).trim();
      const afterText = text.slice((match.index || 0) + match[0].length).trim();
      return {
        beforeText,
        plan: {
          summary: json.summary || '',
          items: Array.isArray(json.items) ? json.items.map((item: Record<string, unknown>) => ({
            prompt: String(item.prompt || ''),
            aspectRatio: String(item.aspectRatio || '1:1'),
            resolution: String(item.resolution || '1K'),
            tags: Array.isArray(item.tags) ? item.tags : [],
            sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs : [],
          })) : [],
        },
        afterText,
      };
    } catch {
      return null;
    }
  }, 'batch-plan');
}

// ── Show Widget Parser ─────────────────────────────────────────────────

/** Find the end of a JSON object starting at `{`, accounting for nested braces and strings. */
function findJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1; // unclosed
}

/** Cap raw fence body before surfacing in a malformed-widget UI segment. */
function clipMalformedRaw(raw: string): string {
  const MAX = 2048;
  if (raw.length <= MAX) return raw;
  return raw.slice(0, MAX) + '\n[…truncated…]';
}

/** Extract widget_code from truncated/incomplete JSON (no closing fence). */
function extractTruncatedWidget(fenceBody: string): ShowWidgetData | null {
  try {
    const json = JSON.parse(fenceBody);
    if (json.widget_code) return { title: json.title || undefined, widget_code: String(json.widget_code) };
  } catch { /* expected — JSON is truncated */ }

  const keyIdx = fenceBody.indexOf('"widget_code"');
  if (keyIdx === -1) return null;
  const colonIdx = fenceBody.indexOf(':', keyIdx + 13);
  if (colonIdx === -1) return null;
  const quoteIdx = fenceBody.indexOf('"', colonIdx + 1);
  if (quoteIdx === -1) return null;

  let raw = fenceBody.slice(quoteIdx + 1);
  raw = raw.replace(/"\s*\}\s*$/, '');
  if (raw.endsWith('\\')) raw = raw.slice(0, -1);
  try {
    const widgetCode = raw
      .replace(/\\\\/g, '\x00BACKSLASH\x00')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\x00BACKSLASH\x00/g, '\\');
    if (widgetCode.length < 10) return null;

    let title: string | undefined;
    const titleMatch = fenceBody.match(/"title"\s*:\s*"([^"]*?)"/);
    if (titleMatch) title = titleMatch[1];
    return { title, widget_code: widgetCode };
  } catch {
    return null;
  }
}

/**
 * Parse ALL show-widget blocks in text, returning alternating text/widget segments.
 */
export function parseAllShowWidgets(text: string): WidgetSegment[] {
  const segments: WidgetSegment[] = [];
  const markerRegex = /`{1,3}show-widget`{0,3}\s*(?:\n\s*`{3}(?:json)?\s*)?\n?/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let foundAny = false;

  const flushBeforeText = (markerStart: number) => {
    const before = text.slice(lastIndex, markerStart).trim();
    if (before) segments.push({ type: 'text', content: before });
  };

  while ((match = markerRegex.exec(text)) !== null) {
    const afterMarker = match.index + match[0].length;
    const jsonStart = text.indexOf('{', afterMarker);
    if (jsonStart === -1 || jsonStart > afterMarker + 20) {
      const fenceClose = text.indexOf('```', afterMarker);
      const bodyEnd = fenceClose !== -1 && fenceClose < afterMarker + 4096
        ? fenceClose
        : Math.min(text.length, afterMarker + 4096);
      const raw = text.slice(afterMarker, bodyEnd).trim();
      foundAny = true;
      flushBeforeText(match.index);
      segments.push({
        type: 'malformed_widget',
        reason: 'No JSON wrapper found inside `show-widget` fence — the body looked like raw HTML / SVG. Widgets must be wrapped as `{"title":"…","widget_code":"…"}` so the runtime can sandbox them.',
        raw: clipMalformedRaw(raw),
      });
      if (fenceClose !== -1) {
        lastIndex = fenceClose + 3;
        markerRegex.lastIndex = fenceClose + 3;
      } else {
        lastIndex = bodyEnd;
        markerRegex.lastIndex = bodyEnd;
      }
      continue;
    }

    const jsonEnd = findJsonEnd(text, jsonStart);
    if (jsonEnd === -1) {
      const partialBody = text.slice(jsonStart);
      const widget = extractTruncatedWidget(partialBody);
      if (widget) {
        foundAny = true;
        flushBeforeText(match.index);
        segments.push({ type: 'widget', data: widget });
        lastIndex = text.length;
      }
      break;
    }

    const jsonStr = text.slice(jsonStart, jsonEnd + 1);
    try {
      const json = JSON.parse(jsonStr);
      if (json.widget_code) {
        foundAny = true;
        flushBeforeText(match.index);
        segments.push({ type: 'widget', data: { title: json.title || undefined, widget_code: String(json.widget_code) } });
        let endPos = jsonEnd + 1;
        const trailing = text.slice(endPos, endPos + 10);
        const trailingFence = trailing.match(/^\s*\n?`{1,3}\s*/);
        if (trailingFence) endPos += trailingFence[0].length;
        lastIndex = endPos;
        markerRegex.lastIndex = endPos;
      } else {
        const fenceClose = text.indexOf('```', jsonEnd + 1);
        const bodyEnd = fenceClose !== -1 ? fenceClose : text.length;
        foundAny = true;
        flushBeforeText(match.index);
        segments.push({
          type: 'malformed_widget',
          reason: 'The `show-widget` JSON parsed but did not include a `widget_code` field. The minimal shape is `{"title":"…","widget_code":"<escaped HTML>"}`.',
          raw: clipMalformedRaw(text.slice(afterMarker, bodyEnd).trim()),
        });
        lastIndex = fenceClose !== -1 ? fenceClose + 3 : text.length;
        markerRegex.lastIndex = lastIndex;
      }
    } catch (parseErr) {
      const fenceClose = text.indexOf('```', jsonStart);
      const bodyEnd = fenceClose !== -1 ? fenceClose : text.length;
      foundAny = true;
      flushBeforeText(match.index);
      const errText = parseErr instanceof Error ? parseErr.message : String(parseErr);
      segments.push({
        type: 'malformed_widget',
        reason: `The \`show-widget\` JSON failed to parse: ${errText}. Common causes: unescaped quotes inside \`widget_code\`, unescaped newlines, trailing commas.`,
        raw: clipMalformedRaw(text.slice(afterMarker, bodyEnd).trim()),
      });
      lastIndex = fenceClose !== -1 ? fenceClose + 3 : text.length;
      markerRegex.lastIndex = lastIndex;
    }
  }

  if (!foundAny) return [];

  const remaining = text.slice(lastIndex).trim();
  if (remaining) {
    segments.push({ type: 'text', content: remaining });
  }

  return segments;
}

/**
 * Legacy single-widget parser. Returns the first successful widget match.
 * Kept for backward compatibility with call sites that only need one widget.
 */
export function parseShowWidget(text: string): { beforeText: string; widget: ShowWidgetData; afterText: string } | null {
  const segments = parseAllShowWidgets(text);
  if (segments.length === 0) return null;
  let beforeText = '';
  let widget: ShowWidgetData | null = null;
  const afterParts: string[] = [];
  let foundWidget = false;
  for (const seg of segments) {
    if (!foundWidget) {
      if (seg.type === 'text') { beforeText = seg.content; }
      else if (seg.type === 'widget') { widget = seg.data; foundWidget = true; }
    } else {
      if (seg.type === 'text') afterParts.push(seg.content);
      else afterParts.push('');
    }
  }
  if (!widget) return null;
  return { beforeText, widget, afterText: afterParts.join('\n') };
}

/**
 * Compute the React key for a partial (still-streaming) widget so that it
 * matches the key it will receive once its fence closes.
 */
export function computePartialWidgetKey(content: string): string {
  const markers = [...content.matchAll(/`{1,3}show-widget/g)];
  if (markers.length === 0) return 'w-0';
  const lastMarker = markers[markers.length - 1];
  const beforePart = content.slice(0, lastMarker.index).trim();
  const hasCompletedFences = beforePart.length > 0 && /`{1,3}show-widget/.test(beforePart);
  const completedSegments = hasCompletedFences ? parseAllShowWidgets(beforePart) : [];
  return `w-${hasCompletedFences ? completedSegments.length : (beforePart ? 1 : 0)}`;
}

/**
 * Strip all known structured fence blocks from text, returning clean markdown.
 * Useful for rendering plain text content without embedded structured blocks.
 */
export function stripStructuredBlocks(text: string): string {
  return text
    .replace(/```image-gen-request[\s\S]*?```/g, '')
    .replace(/```image-gen-result[\s\S]*?```/g, '')
    .replace(/```batch-plan[\s\S]*?```/g, '')
    .replace(/```show-widget[\s\S]*?(```|$)/g, '')
    .trim();
}
