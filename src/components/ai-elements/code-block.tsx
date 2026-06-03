"use client";

import type { ComponentProps, CSSProperties, HTMLAttributes, ReactNode } from "react";
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemedToken,
} from "shiki";
import { LRUMap } from "@/lib/lru-map";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useThemeFamily } from "@/lib/theme/context";
import { resolveShikiTheme, resolveShikiThemes, SHIKI_DEFAULT_LIGHT, SHIKI_DEFAULT_DARK } from "@/lib/theme/code-themes";
import type { Icon } from "@phosphor-icons/react";
import { Check, CaretDown, CaretUp, Hash, Terminal, Code, File, FileCode } from "@phosphor-icons/react";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import {
  createElement,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createHighlighter } from "shiki";
import { usePanel } from "@/hooks/usePanel";
import type { PreviewSource } from "@/hooks/usePanel";

// ── Collapse/expand constants ──────────────────────────────────────────
const COLLAPSE_THRESHOLD = 20;
const VISIBLE_LINES = 10;

// ── Terminal language detection ────────────────────────────────────────
const TERMINAL_LANGUAGES = new Set(["bash", "sh", "shell", "terminal", "zsh", "console"]);

// ── Language icon mapping ──────────────────────────────────────────────
function getLanguageIcon(language: string): Icon {
  const lower = language.toLowerCase();
  if (TERMINAL_LANGUAGES.has(lower)) return Terminal;
  if (["typescript", "tsx", "javascript", "jsx"].includes(lower)) return Code;
  if (["json", "yaml", "yml", "toml", "xml"].includes(lower)) return Code;
  if (["python", "ruby", "go", "rust", "java", "c", "cpp"].includes(lower)) return Hash;
  if (["css", "scss", "html"].includes(lower)) return File;
  return FileCode;
}

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// biome-ignore lint/suspicious/noBitwiseOperators: shiki bitflag check
 
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
// biome-ignore lint/suspicious/noBitwiseOperators: shiki bitflag check
 
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) =>
  // biome-ignore lint/suspicious/noBitwiseOperators: shiki bitflag check
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4;

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
interface KeyedToken {
  token: ThemedToken;
  key: string;
}
interface KeyedLine {
  tokens: KeyedToken[];
  key: string;
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }));

// Token rendering component
const TokenSpan = ({ token, stripColors }: { token: ThemedToken; stripColors?: boolean }) => (
  <span
    className={stripColors ? undefined : "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"}
    style={
      stripColors
        ? { color: "inherit" }
        : {
            backgroundColor: token.bgColor,
            color: token.color,
            fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
            fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
            textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
            ...token.htmlStyle,
          } as CSSProperties
    }
  >
    {token.content}
  </span>
);

// Line rendering component
const LineSpan = ({
  keyedLine,
  showLineNumbers,
  stripColors,
}: {
  keyedLine: KeyedLine;
  showLineNumbers: boolean;
  stripColors?: boolean;
}) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
    {keyedLine.tokens.length === 0
      ? "\n"
      : keyedLine.tokens.map(({ token, key }) => (
          <TokenSpan key={key} token={token} stripColors={stripColors} />
        ))}
  </span>
);

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage | (string & {});
  showLineNumbers?: boolean;
  filename?: string;
};

interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

interface CodeBlockContextType {
  code: string;
  language: string;
}

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
  language: "text",
});

// Highlighter cache keyed by "lang:lightTheme:darkTheme" — bounded to 10 entries
// Stats tracking enabled for monitoring cache hit rates in development
const highlighterCache = new LRUMap<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>(10, { trackStats: true });

// Token cache — bounded to 500 entries (increased from 200 for better hit rates
// in long chat sessions with many code blocks)
const tokensCache = new LRUMap<string, TokenizedCode>(500, { trackStats: true });

// Subscribers for async token updates
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

/**
 * Get cache statistics for monitoring and debugging.
 * Returns hit rates for both the highlighter and token caches.
 * Useful during development to understand cache effectiveness.
 */
export function getCodeBlockCacheStats() {
  return {
    highlighter: highlighterCache.getStats(),
    tokens: tokensCache.getStats(),
    subscribers: subscribers.size,
  };
}

/**
 * Reset all code block cache statistics.
 * Useful for starting fresh measurements.
 */
export function resetCodeBlockCacheStats() {
  highlighterCache.resetStats();
  tokensCache.resetStats();
}

/**
 * Compute a cache key for tokenized code.
 *
 * Uses a more robust key construction to reduce collision risk:
 *   - Language and themes provide the highlighting context
 *   - Code length provides a quick size check
 *   - A hash of the full code content provides uniqueness
 *   - For very long code (>500 chars), we sample from multiple positions
 *     to create a fingerprint that catches modifications anywhere in the code
 */
const getTokensCacheKey = (code: string, language: BundledLanguage, lightTheme: BundledTheme, darkTheme: BundledTheme) => {
  // For short code, use the full content as the key (exact match)
  if (code.length <= 200) {
    return `${language}:${lightTheme}:${darkTheme}:${code}`;
  }

  // For longer code, create a fingerprint by sampling from multiple positions
  // This catches modifications at the beginning, middle, and end of the code
  const len = code.length;
  const start = code.slice(0, 80);
  const mid = code.slice(Math.floor(len / 2) - 40, Math.floor(len / 2) + 40);
  const end = code.slice(-80);

  // Simple hash: combine character codes at key positions
  // This provides better uniqueness than just start+end for similar-length code
  let hash = 0;
  const samplePositions = [0, Math.floor(len / 4), Math.floor(len / 2), Math.floor(3 * len / 4), len - 1];
  for (const pos of samplePositions) {
    if (pos < len) {
      hash = ((hash << 5) - hash + code.charCodeAt(pos)) | 0;
    }
  }

  return `${language}:${lightTheme}:${darkTheme}:${len}:${hash}:${start}:${mid}:${end}`;
};

// Lazy-loaded bundledLanguages to avoid eager import of the full shiki module
let _bundledLanguages: Record<string, unknown> | null = null;
async function loadBundledLanguages(): Promise<Record<string, unknown>> {
  if (!_bundledLanguages) {
    const mod = await import("shiki");
    _bundledLanguages = mod.bundledLanguages as Record<string, unknown>;
  }
  return _bundledLanguages;
}

/**
 * Commonly used languages that should be pre-loaded for better UX.
 * These are the languages most frequently seen in chat code blocks.
 */
const COMMON_LANGUAGES: BundledLanguage[] = [
  'typescript', 'javascript', 'tsx', 'jsx',
  'python', 'bash', 'json', 'html', 'css',
  'rust', 'go', 'java', 'c', 'cpp',
];

/**
 * Warm the highlighter cache by pre-loading commonly used languages.
 * This is a fire-and-forget function that should be called during app initialization
 * to reduce the initial highlight delay for common code blocks.
 *
 * The warming is lazy — it only starts after the first code block is rendered
 * and the shiki module is loaded.
 */
export function warmCodeBlockCache(options?: {
  languages?: BundledLanguage[];
  lightTheme?: BundledTheme;
  darkTheme?: BundledTheme;
}) {
  const languages = options?.languages ?? COMMON_LANGUAGES;
  const lightTheme = options?.lightTheme ?? SHIKI_DEFAULT_LIGHT;
  const darkTheme = options?.darkTheme ?? SHIKI_DEFAULT_DARK;

  // Fire-and-forget: pre-load highlighters for common languages
  // This runs in the background and doesn't block rendering
  for (const lang of languages) {
    const cacheKey = `${lang}:${lightTheme}:${darkTheme}`;
    if (!highlighterCache.has(cacheKey)) {
      getHighlighter(lang, lightTheme, darkTheme).catch(() => {
        // Silently ignore failures — warming is best-effort
      });
    }
  }
}

const isBundledLanguage = (lang: string): lang is BundledLanguage => {
  // Synchronous check: if languages haven't been loaded yet, accept the lang
  // and let getHighlighter handle the fallback.
  if (!_bundledLanguages) return true;
  return lang in _bundledLanguages || lang === "text" || lang === "plaintext";
};

const getHighlighter = (
  language: BundledLanguage,
  lightTheme: BundledTheme = SHIKI_DEFAULT_LIGHT,
  darkTheme: BundledTheme = SHIKI_DEFAULT_DARK,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  // Kick off lazy load of bundledLanguages (fire-and-forget, resolves for future calls)
  loadBundledLanguages().catch(() => {});

  // Normalize unknown languages to "text" before hitting Shiki
  const safeLang = isBundledLanguage(language) ? language : ("text" as BundledLanguage);
  const cacheKey = `${safeLang}:${lightTheme}:${darkTheme}`;

  const cached = highlighterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const highlighterPromise = createHighlighter({
    langs: [safeLang],
    themes: [lightTheme, darkTheme],
  }).catch(() => {
    // Language or theme not supported — fall back to plain text + default themes.
    // Using default themes avoids infinite retry if the *theme* was the problem.
    highlighterCache.delete(cacheKey);
    const useFallbackThemes =
      lightTheme !== SHIKI_DEFAULT_LIGHT || darkTheme !== SHIKI_DEFAULT_DARK;
    if (useFallbackThemes) {
      return getHighlighter("text" as BundledLanguage, SHIKI_DEFAULT_LIGHT, SHIKI_DEFAULT_DARK);
    }
    return getHighlighter("text" as BundledLanguage, lightTheme, darkTheme);
  });

  highlighterCache.set(cacheKey, highlighterPromise);
  return highlighterPromise;
};

// Create raw tokens for immediate display while highlighting loads
const createRawTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ]
  ),
});

/**
 * Shim TokenizedCode (this file's internal shape) → Shiki's TokensResult
 * (the shape @streamdown/code's CodeHighlighterPlugin expects). Fills the
 * two optional metadata fields Streamdown's renderer reads when present:
 * themeName (used as a class hint on <pre>) and rootStyle (used as inline
 * styles for background/foreground on the wrapper). Phase 5.5.
 */
function toTokensResult(
  tokenized: TokenizedCode,
  darkTheme: BundledTheme,
): {
  tokens: ThemedToken[][];
  bg: string;
  fg: string;
  themeName: string;
  rootStyle: string;
} {
  return {
    ...tokenized,
    themeName: String(darkTheme),
    rootStyle: `background-color:${tokenized.bg};color:${tokenized.fg}`,
  };
}

/**
 * Create a Streamdown-compatible CodeHighlighterPlugin that routes through
 * this file's highlightCode(). Sharing the LRU + Shiki highlighter pool
 * with CodeBlockContent means chat messages and file previews don't each
 * spin up their own unbounded caches — Phase 0.2 POC showed @streamdown/
 * code's default plugin maintains its own unbounded module-level Map,
 * which long chat sessions can grow without limit.
 *
 * Shape matches @streamdown/code/dist/index.d.ts's CodeHighlighterPlugin.
 * themes prop is the [light, dark] pair; when null/undefined the caller
 * gets SHIKI_DEFAULT_LIGHT / SHIKI_DEFAULT_DARK.
 */
export function createSharedCodePlugin(options?: {
  themes?: [BundledTheme, BundledTheme];
}): {
  name: "shiki";
  type: "code-highlighter";
  highlight: (
    params: { code: string; language: BundledLanguage; themes: [string, string] },
    callback?: (result: ReturnType<typeof toTokensResult>) => void,
  ) => ReturnType<typeof toTokensResult> | null;
  supportsLanguage: (language: BundledLanguage) => boolean;
  getSupportedLanguages: () => BundledLanguage[];
  getThemes: () => [BundledTheme, BundledTheme];
} {
  const [defaultLight, defaultDark] = options?.themes ?? [SHIKI_DEFAULT_LIGHT, SHIKI_DEFAULT_DARK];
  return {
    name: "shiki" as const,
    type: "code-highlighter" as const,
    highlight(params, callback) {
      const light = (params.themes[0] as BundledTheme) ?? defaultLight;
      const dark = (params.themes[1] as BundledTheme) ?? defaultDark;
      const tokenized = highlightCode(
        params.code,
        params.language,
        callback ? (result) => callback(toTokensResult(result, dark)) : undefined,
        light,
        dark,
      );
      return tokenized ? toTokensResult(tokenized, dark) : null;
    },
    supportsLanguage: () => true,
    getSupportedLanguages: () => [] as BundledLanguage[],
    getThemes: () => [defaultLight, defaultDark],
  };
}

// Synchronous highlight with callback for async results
export const highlightCode = (
  code: string,
  language: BundledLanguage,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
  lightTheme: BundledTheme = SHIKI_DEFAULT_LIGHT,
  darkTheme: BundledTheme = SHIKI_DEFAULT_DARK,
): TokenizedCode | null => {
  const tokensCacheKey = getTokensCacheKey(code, language, lightTheme, darkTheme);

  // Return cached result if available
  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    return cached;
  }

  // Subscribe callback if provided
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  // Start highlighting in background - fire-and-forget async pattern
  getHighlighter(language, lightTheme, darkTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(language) ? language : "text";

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: {
          dark: darkTheme,
          light: lightTheme,
        },
      });

      const tokenized: TokenizedCode = {
        bg: result.bg ?? "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      // Cache the result
      tokensCache.set(tokensCacheKey, tokenized);

      // Notify all subscribers
      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
        subscribers.delete(tokensCacheKey);
      }
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      console.error("Failed to highlight code:", error);
      subscribers.delete(tokensCacheKey);
    });

  return null;
};

// Line number styles using CSS counters
const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-muted-foreground/50",
  "before:font-mono",
  "before:select-none"
);

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    className,
    isTerminal,
  }: {
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    className?: string;
    isTerminal?: boolean;
  }) => {
    const preStyle = useMemo(
      () => isTerminal
        ? {} // Terminal uses CSS variables, no inline Shiki colors
        : { backgroundColor: tokenized.bg, color: tokenized.fg },
      [tokenized.bg, tokenized.fg, isTerminal]
    );

    const keyedLines = useMemo(
      () => addKeysToTokens(tokenized.tokens),
      [tokenized.tokens]
    );

    return (
      <pre
        className={cn(
          "m-0 p-4 text-sm",
          isTerminal
            ? "!bg-[var(--terminal-bg)] !text-[var(--terminal-foreground)]"
            : "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]",
          className
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono text-sm",
            showLineNumbers && "[counter-increment:line_0] [counter-reset:line]"
          )}
        >
          {keyedLines.map((keyedLine) => (
            <LineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              showLineNumbers={showLineNumbers}
              stripColors={isTerminal}
            />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className &&
    prevProps.isTerminal === nextProps.isTerminal
);

CodeBlockBody.displayName = "CodeBlockBody";

export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
      className
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
);

export const CodeBlockHeader = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-center justify-between border-b bg-muted/80 px-3 py-2 text-muted-foreground text-xs",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
);

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("-my-1 -mr-1 flex items-center gap-2", className)}
    {...props}
  >
    {children}
  </div>
);

/** Resolve Shiki theme pair from the current theme family. */
function useShikiThemes(): { light: BundledTheme; dark: BundledTheme } {
  const { family, families } = useThemeFamily();
  const shikiTheme = resolveShikiTheme(families, family);
  return resolveShikiThemes(shikiTheme);
}

export const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
  collapsible = false,
  maxCollapsedLines = VISIBLE_LINES,
}: {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  collapsible?: boolean;
  maxCollapsedLines?: number;
}) => {
  const { light: lightTheme, dark: darkTheme } = useShikiThemes();
  const [expanded, setExpanded] = useState(false);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const [animatingHeight, setAnimatingHeight] = useState<string | undefined>(undefined);

  const lines = useMemo(() => code.split("\n"), [code]);
  const totalLines = lines.length;
  const isCollapsible = collapsible && totalLines > COLLAPSE_THRESHOLD;

  const displayCode = useMemo(() => {
    if (!isCollapsible || expanded) return code;
    return lines.slice(0, maxCollapsedLines).join("\n");
  }, [code, lines, isCollapsible, expanded, maxCollapsedLines]);

  // Memoized raw tokens for immediate display
  const rawTokens = useMemo(() => createRawTokens(displayCode), [displayCode]);

  // Try to get cached result synchronously, otherwise use raw tokens
  const syncTokenized = useMemo(
    () => highlightCode(displayCode, language, undefined, lightTheme, darkTheme) ?? rawTokens,
    [displayCode, language, rawTokens, lightTheme, darkTheme]
  );

  // Track async highlighting results keyed by code+language+themes to avoid stale state
  const [asyncResult, setAsyncResult] = useState<{ key: string; tokens: TokenizedCode } | null>(null);
  const resultKey = `${displayCode}:${language}:${lightTheme}:${darkTheme}`;

  useEffect(() => {
    let cancelled = false;

    // Subscribe to async highlighting result
    highlightCode(displayCode, language, (result) => {
      if (!cancelled) {
        setAsyncResult({ key: `${displayCode}:${language}:${lightTheme}:${darkTheme}`, tokens: result });
      }
    }, lightTheme, darkTheme);

    return () => {
      cancelled = true;
    };
  }, [displayCode, language, lightTheme, darkTheme]);

  // Only use async result if it matches the current code+language+themes
  const tokenized = (asyncResult && asyncResult.key === resultKey) ? asyncResult.tokens : syncTokenized;

  const isTerminal = TERMINAL_LANGUAGES.has(language.toLowerCase());

  const handleToggleExpand = () => {
    const container = codeContainerRef.current;
    if (!container) {
      setExpanded(!expanded);
      return;
    }
    const currentHeight = container.scrollHeight;
    if (!expanded) {
      setAnimatingHeight(`${currentHeight}px`);
      setExpanded(true);
      requestAnimationFrame(() => {
        const fullHeight = container.scrollHeight;
        setAnimatingHeight(`${fullHeight}px`);
        setTimeout(() => setAnimatingHeight(undefined), 300);
      });
    } else {
      setAnimatingHeight(`${currentHeight}px`);
      requestAnimationFrame(() => {
        const collapsedH = maxCollapsedLines * 1.5 + 1.5;
        setAnimatingHeight(`${collapsedH}rem`);
        setTimeout(() => {
          setExpanded(false);
          setAnimatingHeight(undefined);
        }, 300);
      });
    }
  };

  return (
    <>
      <div
        ref={codeContainerRef}
        className="relative transition-[max-height] duration-300 ease-in-out overflow-hidden"
        style={{
          maxHeight: animatingHeight ?? (!isCollapsible || expanded ? undefined : `${maxCollapsedLines * 1.5 + 1.5}rem`),
        }}
      >
        <div className="relative overflow-auto">
          <CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokenized} isTerminal={isTerminal} />
        </div>

        {/* Gradient overlay for collapsed state */}
        {isCollapsible && !expanded && (
          <div className={cn(
            "absolute bottom-0 left-0 right-0 h-16 pointer-events-none",
            isTerminal
              ? "bg-gradient-to-t from-[var(--terminal-gradient-from)] to-transparent"
              : "bg-gradient-to-t from-muted to-transparent"
          )} />
        )}
      </div>

      {/* Expand/Collapse button */}
      {isCollapsible && (
        <button
          onClick={handleToggleExpand}
          type="button"
          className={cn(
            "flex w-full items-center justify-center gap-1.5 py-1.5 text-xs transition-colors",
            isTerminal
              ? "bg-[var(--terminal-bg)] text-[var(--terminal-muted)] hover:text-[var(--terminal-foreground)]"
              : "bg-muted text-muted-foreground hover:text-foreground"
          )}
        >
          {expanded ? (
            <>
              <CaretUp size={12} />
              <span>Collapse</span>
            </>
          ) : (
            <>
              <CaretDown size={12} />
              <span>Expand all {totalLines} lines</span>
            </>
          )}
        </button>
      )}
    </>
  );
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  filename,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code, language }), [code, language]);
  const isTerminal = TERMINAL_LANGUAGES.has(language.toLowerCase());

  // When children are provided, use the composable API (caller controls header).
  // Otherwise, render a default header with language icon, copy, copy-as-markdown.
  const hasCustomChildren = children != null;

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer
        className={cn(
          hasCustomChildren ? undefined : "not-prose my-3",
          isTerminal && !hasCustomChildren && "border-[var(--terminal-border)]",
          className,
        )}
        language={language}
        {...props}
      >
        {hasCustomChildren ? (
          children
        ) : (
          <CodeBlockDefaultHeader
            language={language}
            filename={filename}
            isTerminal={isTerminal}
          />
        )}
        <CodeBlockContent
          code={code}
          language={language as BundledLanguage}
          showLineNumbers={showLineNumbers}
          collapsible={!hasCustomChildren}
        />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

/** Default header rendered when CodeBlock has no children (non-composable usage). */
const CodeBlockDefaultHeader = ({
  language,
  filename,
  isTerminal,
}: {
  language: string;
  filename?: string;
  isTerminal: boolean;
}) => {
  const { code: contextCode, language: contextLanguage } = useContext(CodeBlockContext);
  const [copied, setCopied] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(contextCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      const markdown = `\`\`\`${contextLanguage}\n${contextCode}\n\`\`\``;
      await navigator.clipboard.writeText(markdown);
      setCopiedMarkdown(true);
      setTimeout(() => setCopiedMarkdown(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const langIcon = getLanguageIcon(language);

  return (
    <div className={cn(
      "flex items-center justify-between px-4 py-1.5 text-xs border-b",
      isTerminal
        ? "bg-[var(--terminal-bg)] text-[var(--terminal-muted)]"
        : "bg-muted text-muted-foreground"
    )}>
      <div className="flex items-center gap-2 min-w-0">
        {createElement(langIcon, { size: 14, className: cn(
          "shrink-0",
          isTerminal ? "text-[var(--terminal-accent)]" : "text-muted-foreground",
        ) })}
        {filename && (
          <span className={cn(
            "truncate font-medium",
            isTerminal ? "text-[var(--terminal-foreground)]" : "text-foreground"
          )}>{filename}</span>
        )}
        {filename && <span className="text-muted-foreground/50">|</span>}
        <span className={cn(
          "rounded px-1.5 py-0.5",
          isTerminal
            ? "bg-[var(--terminal-hover-bg)] text-[var(--terminal-accent)]"
            : "bg-accent text-accent-foreground"
        )}>{language.toUpperCase()}</span>
      </div>
      <div className="flex items-center gap-1 ml-2 shrink-0">
        {/* Phase 4.B — Open in Artifact action. Shown only for languages
            that have a configured preview renderer. The code itself
            doesn't go through any file scope; it's an inline-* source
            so the trust-tier pipeline is bypassed (the code is already
            in the chat). HTML in particular uses inline-html → strict
            sandbox (no relative resources, no scripts) because we
            don't have a file scope to authorize. The code-fence
            Preview is for inspecting the *content*, not for running
            it as a real page. */}
        <CodeFencePreviewButton language={contextLanguage} code={contextCode} />
        <button
          onClick={handleCopy}
          type="button"
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
            isTerminal
              ? "text-[var(--terminal-muted)] hover:text-[var(--terminal-foreground)] hover:bg-[var(--terminal-hover-bg)]"
              : "text-muted-foreground hover:text-foreground hover:bg-accent"
          )}
          title="Copy code"
        >
          {copied ? (
            <>
              <Check size={12} />
              <span>Copied</span>
            </>
          ) : (
            <>
              <CodePilotIcon name="copy" size={12} aria-hidden />
              <span>Copy</span>
            </>
          )}
        </button>
        <button
          onClick={handleCopyMarkdown}
          type="button"
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
            isTerminal
              ? "text-[var(--terminal-muted)] hover:text-[var(--terminal-foreground)] hover:bg-[var(--terminal-hover-bg)]"
              : "text-muted-foreground hover:text-foreground hover:bg-accent"
          )}
          title="Copy as Markdown"
        >
          {copiedMarkdown ? (
            <>
              <Check size={12} />
              <span>Copied</span>
            </>
          ) : (
            <>
              <CodePilotIcon name="file_code" size={12} aria-hidden />
              <span>Markdown</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

/**
 * Phase 4.B — code-fence "Preview" button. Surfaces only when the
 * fence's language is one we have a renderer for. The button uses
 * usePanel (rather than dispatching a window event) so the React
 * state update flows through AppShell's setPreviewSource — same path
 * as the file-tree click and DiffSummary card.
 *
 * Mapping table:
 *   html / xml         → inline-html  (strict sandbox; no file scope)
 *   jsx / tsx          → inline-jsx   (Sandpack)
 *   json               → inline-json  (tree viewer)
 *   diff / patch       → inline-diff
 *   csv                → inline-datatable (papaparse)
 *   tsv                → inline-datatable (tab-delimited)
 *   markdown / md / mdx→ inline-markdown
 *
 * Other languages render no button — the existing Copy / Markdown
 * actions are sufficient for code that has no rendered preview form.
 */
function CodeFencePreviewButton({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const panel = usePanelOrNull();
  const source = useMemo(() => previewSourceForCodeFence(language, code), [language, code]);
  if (!source) return null;
  if (!panel) return null;
  return (
    <button
      type="button"
      onClick={() => panel.setPreviewSource(source)}
      data-codepilot-codefence-preview={language}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={`Open this ${language} in the Artifact preview`}
    >
      <CodePilotIcon name="file_code" size={12} aria-hidden />
      <span>Preview</span>
    </button>
  );
}

/**
 * usePanel() throws when used outside the PanelContext provider, but
 * the CodeBlock component is also used in places without a panel
 * (e.g. the design-system gallery). Wrapping in a safe variant lets
 * the Preview button gracefully disappear instead of crashing the
 * surrounding render.
 */
function usePanelOrNull() {
  try {
    return usePanel();
  } catch {
    return null;
  }
}

export function previewSourceForCodeFence(
  language: string,
  code: string,
): PreviewSource | null {
  const lang = language.toLowerCase();
  switch (lang) {
    case "html":
    case "xml":
      return { kind: "inline-html", html: code, virtualName: "fence.html" };
    case "jsx":
      return { kind: "inline-jsx", jsx: code, virtualName: "fence.jsx" };
    case "tsx":
      return { kind: "inline-jsx", jsx: code, virtualName: "fence.tsx" };
    case "json":
      return { kind: "inline-json", text: code, virtualName: "fence.json" };
    case "diff":
    case "patch":
      return { kind: "inline-diff", diff: code, virtualName: "fence.diff" };
    case "csv":
      return parseCsvForFence(code, ",", "fence.csv");
    case "tsv":
      return parseCsvForFence(code, "\t", "fence.tsv");
    case "markdown":
    case "md":
    case "mdx":
      return {
        kind: "inline-markdown",
        markdown: code,
        virtualName: "fence.md",
      };
    default:
      return null;
  }
}

function parseCsvForFence(
  text: string,
  delim: string,
  virtualName: string,
): PreviewSource {
  // Light CSV parser — good enough for chat-pasted tables. We don't
  // pull papaparse here because the existing DataTableViewer reads
  // raw csv text in its csv= prop; we hand it the same. For the
  // PreviewSource we still produce inline-datatable shape with
  // rows / header so the panel's existing dispatch path applies.
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return {
      kind: "inline-datatable",
      header: [],
      rows: [],
      virtualName,
    };
  }
  const split = (l: string) => l.split(delim).map((c) => c.trim());
  const header = split(lines[0]);
  const rows = lines.slice(1).map(split);
  return {
    kind: "inline-datatable",
    header,
    rows,
    virtualName,
  };
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout
        );
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? (isCopied ? <Check size={14} /> : <CodePilotIcon name="copy" size="sm" aria-hidden />)}
    </Button>
  );
};

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (
  props: CodeBlockLanguageSelectorProps
) => <Select {...props} />;

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<
  typeof SelectTrigger
>;

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn(
      "h-7 border-none bg-transparent px-2 text-xs shadow-none",
      className
    )}
    size="sm"
    {...props}
  />
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<
  typeof SelectValue
>;

export const CodeBlockLanguageSelectorValue = (
  props: CodeBlockLanguageSelectorValueProps
) => <SelectValue {...props} />;

export type CodeBlockLanguageSelectorContentProps = ComponentProps<
  typeof SelectContent
>;

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => (
  <SelectContent align={align} {...props} />
);

export type CodeBlockLanguageSelectorItemProps = ComponentProps<
  typeof SelectItem
>;

export const CodeBlockLanguageSelectorItem = (
  props: CodeBlockLanguageSelectorItemProps
) => <SelectItem {...props} />;

// ── InlineCode ─────────────────────────────────────────────────────────
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">
      {children}
    </code>
  );
}
