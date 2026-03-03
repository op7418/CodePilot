/**
 * Telegram-specific Markdown renderer.
 *
 * Converts Markdown → IR → Telegram-compatible HTML, with file-reference
 * wrapping and render-first chunking for long messages.
 *
 * Ported from openclaw src/telegram/format.ts.
 */

import { markdownToIR, chunkMarkdownIR, type MarkdownIR, type MarkdownLinkSpan } from './ir';
import { renderMarkdownWithMarkers } from './render';

export type TelegramChunk = {
  html: string;
  text: string;
};

// ── HTML escaping ─────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// ── File reference detection ──────────────────────────────────

/**
 * File extensions that share TLDs and commonly appear in code/documentation.
 * Wrapped in <code> tags to prevent Telegram from generating
 * spurious domain registrar previews.
 */
const FILE_EXTENSIONS_WITH_TLD = new Set([
  'md', // Markdown (Moldova)
  'go', // Go language
  'py', // Python (Paraguay)
  'pl', // Perl (Poland)
  'sh', // Shell (Saint Helena)
  'am', // Automake files (Armenia)
  'at', // Assembly (Austria)
  'be', // Backend files (Belgium)
  'cc', // C++ source (Cocos Islands)
]);

/** Detects when linkify auto-generated a link from a bare filename (e.g. README.md → http://README.md) */
function isAutoLinkedFileRef(href: string, label: string): boolean {
  const stripped = href.replace(/^https?:\/\//i, '');
  if (stripped !== label) {
    return false;
  }
  const dotIndex = label.lastIndexOf('.');
  if (dotIndex < 1) {
    return false;
  }
  const ext = label.slice(dotIndex + 1).toLowerCase();
  if (!FILE_EXTENSIONS_WITH_TLD.has(ext)) {
    return false;
  }
  // Reject if any path segment before the filename contains a dot (looks like a domain)
  const segments = label.split('/');
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i].includes('.')) {
        return false;
      }
    }
  }
  return true;
}

function buildTelegramLink(link: MarkdownLinkSpan, text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  if (link.start === link.end) {
    return null;
  }
  // Suppress auto-linkified file references (e.g. README.md → http://README.md)
  const label = text.slice(link.start, link.end);
  if (isAutoLinkedFileRef(href, label)) {
    return null;
  }
  const safeHref = escapeHtmlAttr(href);
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${safeHref}">`,
    close: '</a>',
  };
}

// ── Core rendering ────────────────────────────────────────────

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: '<b>', close: '</b>' },
      italic: { open: '<i>', close: '</i>' },
      strikethrough: { open: '<s>', close: '</s>' },
      code: { open: '<code>', close: '</code>' },
      code_block: { open: '<pre><code>', close: '</code></pre>' },
      blockquote: { open: '<blockquote>', close: '</blockquote>' },
    },
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
  });
}

// ── File reference wrapping (post-processing) ─────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FILE_EXTENSIONS_PATTERN = Array.from(FILE_EXTENSIONS_WITH_TLD).map(escapeRegex).join('|');
const AUTO_LINKED_ANCHOR_PATTERN = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
const FILE_REFERENCE_PATTERN = new RegExp(
  `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=$|[^a-zA-Z0-9_\\-/])`,
  'gi',
);
const ORPHANED_TLD_PATTERN = new RegExp(
  `([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=[^a-zA-Z0-9/]|$)`,
  'g',
);
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;

function wrapStandaloneFileRef(match: string, prefix: string, filename: string): string {
  if (filename.startsWith('//')) {
    return match;
  }
  if (/https?:\/\/$/i.test(prefix)) {
    return match;
  }
  return `${prefix}<code>${escapeHtml(filename)}</code>`;
}

function wrapSegmentFileRefs(
  text: string,
  codeDepth: number,
  preDepth: number,
  anchorDepth: number,
): string {
  if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) {
    return text;
  }
  const wrappedStandalone = text.replace(FILE_REFERENCE_PATTERN, wrapStandaloneFileRef);
  return wrappedStandalone.replace(ORPHANED_TLD_PATTERN, (match, prefix: string, tld: string) =>
    prefix === '>' ? match : `${prefix}<code>${escapeHtml(tld)}</code>`,
  );
}

/**
 * Wraps standalone file references (with TLD extensions) in <code> tags.
 * Prevents Telegram from treating them as URLs and generating
 * irrelevant domain registrar previews.
 *
 * Runs AFTER markdown→HTML conversion to avoid modifying HTML attributes.
 * Skips content inside <code>, <pre>, and <a> tags.
 */
export function wrapFileReferencesInHtml(html: string): string {
  // Safety-net: de-linkify auto-generated anchors where href="http://<label>"
  AUTO_LINKED_ANCHOR_PATTERN.lastIndex = 0;
  const deLinkified = html.replace(AUTO_LINKED_ANCHOR_PATTERN, (_match, label: string) => {
    if (!isAutoLinkedFileRef(`http://${label}`, label)) {
      return _match;
    }
    return `<code>${escapeHtml(label)}</code>`;
  });

  // Track nesting depth for tags that should not be modified
  let codeDepth = 0;
  let preDepth = 0;
  let anchorDepth = 0;
  let result = '';
  let lastIndex = 0;

  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HTML_TAG_PATTERN.exec(deLinkified)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    const isClosing = match[1] === '</';
    const tagName = match[2].toLowerCase();

    // Process text before this tag
    const textBefore = deLinkified.slice(lastIndex, tagStart);
    result += wrapSegmentFileRefs(textBefore, codeDepth, preDepth, anchorDepth);

    // Update tag depth (clamp at 0 for malformed HTML)
    if (tagName === 'code') {
      codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    } else if (tagName === 'pre') {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    } else if (tagName === 'a') {
      anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
    }

    result += deLinkified.slice(tagStart, tagEnd);
    lastIndex = tagEnd;
  }

  // Process remaining text
  const remainingText = deLinkified.slice(lastIndex);
  result += wrapSegmentFileRefs(remainingText, codeDepth, preDepth, anchorDepth);

  return result;
}

// ── IR splitting helpers (local copies for chunk splitting) ───

function sliceStyleSpans(
  styles: MarkdownIR['styles'],
  start: number,
  end: number,
): MarkdownIR['styles'] {
  return styles.flatMap((span) => {
    if (span.end <= start || span.start >= end) {
      return [];
    }
    const nextStart = Math.max(span.start, start) - start;
    const nextEnd = Math.min(span.end, end) - start;
    if (nextEnd <= nextStart) {
      return [];
    }
    return [{ ...span, start: nextStart, end: nextEnd }];
  });
}

function sliceLinkSpans(
  links: MarkdownIR['links'],
  start: number,
  end: number,
): MarkdownIR['links'] {
  return links.flatMap((link) => {
    if (link.end <= start || link.start >= end) {
      return [];
    }
    const nextStart = Math.max(link.start, start) - start;
    const nextEnd = Math.min(link.end, end) - start;
    if (nextEnd <= nextStart) {
      return [];
    }
    return [{ ...link, start: nextStart, end: nextEnd }];
  });
}

function splitMarkdownIRPreserveWhitespace(ir: MarkdownIR, limit: number): MarkdownIR[] {
  if (!ir.text) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (normalizedLimit <= 0 || ir.text.length <= normalizedLimit) {
    return [ir];
  }
  const chunks: MarkdownIR[] = [];
  let cursor = 0;
  while (cursor < ir.text.length) {
    const end = Math.min(ir.text.length, cursor + normalizedLimit);
    chunks.push({
      text: ir.text.slice(cursor, end),
      styles: sliceStyleSpans(ir.styles, cursor, end),
      links: sliceLinkSpans(ir.links, cursor, end),
    });
    cursor = end;
  }
  return chunks;
}

// ── Render-first chunking ─────────────────────────────────────

function splitTelegramChunkByHtmlLimit(
  chunk: MarkdownIR,
  htmlLimit: number,
  renderedHtmlLength: number,
): MarkdownIR[] {
  const currentTextLength = chunk.text.length;
  if (currentTextLength <= 1) {
    return [chunk];
  }
  const proportionalLimit = Math.floor(
    (currentTextLength * htmlLimit) / Math.max(renderedHtmlLength, 1),
  );
  const candidateLimit = Math.min(currentTextLength - 1, proportionalLimit);
  const splitLimit =
    Number.isFinite(candidateLimit) && candidateLimit > 0
      ? candidateLimit
      : Math.max(1, Math.floor(currentTextLength / 2));
  const split = splitMarkdownIRPreserveWhitespace(chunk, splitLimit);
  if (split.length > 1) {
    return split;
  }
  return splitMarkdownIRPreserveWhitespace(chunk, Math.max(1, Math.floor(currentTextLength / 2)));
}

function renderTelegramChunksWithinHtmlLimit(
  ir: MarkdownIR,
  limit: number,
): TelegramChunk[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const pending = chunkMarkdownIR(ir, normalizedLimit);
  const rendered: TelegramChunk[] = [];
  while (pending.length > 0) {
    const chunk = pending.shift();
    if (!chunk) {
      continue;
    }
    const html = wrapFileReferencesInHtml(renderTelegramHtml(chunk));
    if (html.length <= normalizedLimit || chunk.text.length <= 1) {
      rendered.push({ html, text: chunk.text });
      continue;
    }
    const split = splitTelegramChunkByHtmlLimit(chunk, normalizedLimit, html.length);
    if (split.length <= 1) {
      // Worst-case safety: avoid retry loops, deliver the chunk as-is.
      rendered.push({ html, text: chunk.text });
      continue;
    }
    pending.unshift(...split);
  }
  return rendered;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Full pipeline: markdown → IR → Telegram HTML with file ref wrapping.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const ir = markdownToIR(markdown ?? '', {
    linkify: true,
    headingStyle: 'bold',
    blockquotePrefix: '',
    enableTables: true,
  });
  const html = renderTelegramHtml(ir);
  return wrapFileReferencesInHtml(html);
}

/**
 * Render-first chunking: markdown → IR → chunk by IR text →
 * render each chunk → re-split if HTML exceeds limit.
 */
export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
): TelegramChunk[] {
  const ir = markdownToIR(markdown ?? '', {
    linkify: true,
    headingStyle: 'bold',
    blockquotePrefix: '',
    enableTables: true,
  });
  return renderTelegramChunksWithinHtmlLimit(ir, limit);
}
