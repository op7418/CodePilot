"use client";

import type { ComponentProps, CSSProperties, HTMLAttributes, ReactNode } from "react";
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemedToken,
} from "shiki";
import { bundledLanguages } from "shiki";

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
import {
  Check,
  Copy,
  CaretDown,
  CaretUp,
  FileCode,
  Terminal,
  Code,
  File,
  Hash,
} from "@phosphor-icons/react";
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
const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
    style={
      {
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
}: {
  keyedLine: KeyedLine;
  showLineNumbers: boolean;
}) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
    {keyedLine.tokens.length === 0
      ? "\n"
      : keyedLine.tokens.map(({ token, key }) => (
          <TokenSpan key={key} token={token} />
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

// Highlighter cache keyed by "lang:lightTheme:darkTheme"
const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();

// Token cache
const tokensCache = new Map<string, TokenizedCode>();

// Subscribers for async token updates
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

const getTokensCacheKey = (code: string, language: BundledLanguage, lightTheme: BundledTheme, darkTheme: BundledTheme) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${language}:${lightTheme}:${darkTheme}:${code.length}:${start}:${end}`;
};

const isBundledLanguage = (lang: string): lang is BundledLanguage =>
  lang in bundledLanguages || lang === "text" || lang === "plaintext";

const getHighlighter = (
  language: BundledLanguage,
  lightTheme: BundledTheme = SHIKI_DEFAULT_LIGHT,
  darkTheme: BundledTheme = SHIKI_DEFAULT_DARK,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
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
  }: {
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    className?: string;
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg]
    );

    const keyedLines = useMemo(
      () => addKeysToTokens(tokenized.tokens),
      [tokenized.tokens]
    );

    return (
      <pre
        className={cn(
          "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)] m-0 p-4 text-sm",
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
            />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className
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
          <CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokenized} />
        </div>

        {/* Gradient overlay for collapsed state */}
        {isCollapsible && !expanded && (
          <div className={cn(
            "absolute bottom-0 left-0 right-0 h-16 pointer-events-none",
            isTerminal
              ? "bg-gradient-to-t from-[#0a0a0a] to-transparent"
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
              ? "bg-zinc-950 text-zinc-400 hover:text-zinc-200"
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
          isTerminal && !hasCustomChildren && "border-zinc-700/50",
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
        ? "bg-zinc-950 text-zinc-400"
        : "bg-muted text-muted-foreground"
    )}>
      <div className="flex items-center gap-2 min-w-0">
        {createElement(langIcon, { size: 14, className: cn(
          "shrink-0",
          isTerminal ? "text-green-400" : "text-muted-foreground",
        ) })}
        {filename && (
          <span className={cn(
            "truncate font-medium",
            isTerminal ? "text-zinc-300" : "text-foreground"
          )}>{filename}</span>
        )}
        {filename && <span className="text-muted-foreground/50">|</span>}
        <span className={cn(
          "rounded px-1.5 py-0.5",
          isTerminal
            ? "bg-zinc-700/50 text-green-400"
            : "bg-accent text-accent-foreground"
        )}>{language.toUpperCase()}</span>
      </div>
      <div className="flex items-center gap-1 ml-2 shrink-0">
        <button
          onClick={handleCopy}
          type="button"
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
            isTerminal
              ? "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
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
              <Copy size={12} />
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
              ? "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
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
              <FileCode size={12} />
              <span>Markdown</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

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

  const Icon = isCopied ? Check : Copy;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
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
