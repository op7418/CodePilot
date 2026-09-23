import { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';

const RELEASE_NOTES_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

/**
 * GitHub's Atom feed supplies release notes as untrusted HTML. Keep the
 * useful prose/table subset, but drop active content, remote images, styling,
 * DOM-clobbering ids/names, and every attribute except a bounded link target.
 */
export const releaseNotesSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  allowComments: false,
  allowDoctypes: false,
  tagNames: [...RELEASE_NOTES_TAGS],
  attributes: {
    a: ['href', 'title'],
    th: [['align', 'left', 'center', 'right']],
    td: [['align', 'left', 'center', 'right']],
  },
  protocols: {
    href: ['http', 'https'],
  },
  strip: [
    'button',
    'embed',
    'form',
    'iframe',
    'img',
    'input',
    'math',
    'object',
    'script',
    'style',
    'svg',
  ],
};

/** ReactMarkdown URL gate. Relative, credential-bearing and non-web URLs are
 * intentionally non-clickable in release notes. */
export function releaseNotesUrlTransform(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}
