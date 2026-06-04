"use client";

import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { X, Check, SpinnerGap } from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { exportHtmlAsLongShot, ArtifactExportError } from "@/lib/artifact-export";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import { useThemeFamily } from "@/lib/theme/context";
import { resolveCodeTheme, useHljsStyle } from "@/lib/theme/code-themes";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import type { FilePreview as FilePreviewType } from "@/types";
import type { PreviewTrust } from "@/lib/preview-source";
import {
  FILE_CHANGED_EVENT,
  dispatchFileChanged,
  isFileChangedDetail,
} from "@/lib/file-changed-event";
import {
  buildHtmlPreviewUrl,
  shouldReloadHtmlForPath,
  htmlPreviewDirname,
} from "@/lib/html-preview-url";
import { classifyPath } from "@/lib/preview-source";
import { parseFrontmatter } from "@/lib/markdown/frontmatter";
import { parseOutline, slugify } from "@/lib/markdown/outline";
import { rewriteWikilinks, resolveWikilink, parseWikilinkHref } from "@/lib/markdown/wikilink";
import { rewriteCallouts } from "@/lib/markdown/callout";
import { parseAnchor } from "@/lib/markdown/anchor";
import {
  renderPresentation,
  type PresentationTemplateId,
  type MarkdownPresentationStyle,
  MARKDOWN_PRESENTATION_STYLES,
  DEFAULT_MARKDOWN_PRESENTATION_STYLE,
} from "@/lib/markdown/presentation-templates";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildPresentationRefreshUrl } from "@/lib/markdown/presentation-refresh";
import { dispatchAddToChat } from "@/lib/add-to-chat-event";
import { injectInlineHtmlCsp } from "@/lib/inline-html-csp";
// MarkdownOutlineRail removed from the UI per Codex UX feedback —
// outline rail ate too much sidebar width and its partial background
// looked broken. The post-render heading + callout helpers stay
// imported because the rendered Markdown still uses them.
import { injectHeadingIds, applyCalloutClasses } from "@/components/editor/MarkdownOutlineRail";
import { MarkdownFrontmatterPanel } from "@/components/editor/MarkdownFrontmatterPanel";
// Phase 4 UX — PresentationPicker no longer mounted in this surface;
// the explicit HTML artifact action is a one-click save button.
// import { PresentationPicker } from "@/components/editor/PresentationPicker";

const JsonTreeViewer = dynamic(
  () => import("@/components/editor/JsonTreeViewer").then((m) => m.JsonTreeViewer),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center py-12"><SpinnerGap size={20} className="animate-spin text-muted-foreground" /></div> },
);
const DiffViewer = dynamic(
  () => import("@/components/editor/DiffViewer").then((m) => m.DiffViewer),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center py-12"><SpinnerGap size={20} className="animate-spin text-muted-foreground" /></div> },
);

// Sandpack is pulled in lazily via next/dynamic so its ~MB runtime (React
// bundler + iframe bootstrap) doesn't ship with the first-paint chunk. Only
// loaded when a .jsx/.tsx file is previewed (or inline-jsx source is set).
const SandpackPreview = dynamic(
  () => import("@/components/editor/SandpackPreview").then((m) => m.SandpackPreview),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center py-12"><SpinnerGap size={20} className="animate-spin text-muted-foreground" /></div> },
);

// CodeMirror Markdown editor (Phase 4.3 surface). Only reached when the
// user flips viewMode to "edit" on an EDITABLE_EXTENSIONS file, so the
// ~135 KB chunk stays out of first paint just like Sandpack does.
const MarkdownEditor = dynamic(
  () => import("@/components/editor/MarkdownEditor").then((m) => m.MarkdownEditor),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center py-12"><SpinnerGap size={20} className="animate-spin text-muted-foreground" /></div> },
);

// DataTable viewer (Phase 5.4). Papaparse (~15 KB gzipped) gets its own
// dynamic boundary so users who never open a .csv don't pay for it.
const DataTableViewer = dynamic(
  () => import("@/components/editor/DataTableViewer").then((m) => m.DataTableViewer),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center py-12"><SpinnerGap size={20} className="animate-spin text-muted-foreground" /></div> },
);

// Lazy-load Streamdown and plugins — only loaded when rendered markdown is needed
let _StreamdownComponent: typeof import("streamdown").Streamdown | null = null;
let _streamdownPlugins: Record<string, unknown> | null = null;
let _streamdownPromise: Promise<void> | null = null;

function loadStreamdown(): Promise<void> {
  if (_streamdownPromise) return _streamdownPromise;
  _streamdownPromise = Promise.all([
    import("streamdown"),
    import("@streamdown/cjk"),
    import("@streamdown/math"),
    import("@streamdown/mermaid"),
    import("@/components/ai-elements/code-block"),
  ]).then(([sd, cjkMod, mathMod, mermaidMod, codeBlockMod]) => {
    _StreamdownComponent = sd.Streamdown;
    // Phase 5.5 — rendered-markdown preview uses the same shared code
    // plugin the chat path uses (createSharedCodePlugin from
    // code-block.tsx). Previous implementation imported @streamdown/code
    // and used its default plugin, which maintains its own unbounded
    // module-level LRU; opening a preview after a long chat session
    // effectively doubled the Shiki highlighter footprint. Now both
    // consumers share the bounded LRUMap in code-block.tsx.
    _streamdownPlugins = {
      cjk: cjkMod.cjk,
      code: codeBlockMod.createSharedCodePlugin(),
      math: mathMod.math,
      mermaid: mermaidMod.mermaid,
    };
  }).catch((err) => {
    // Reset so next call retries instead of caching the rejected promise
    _streamdownPromise = null;
    throw err;
  });
  return _streamdownPromise;
}

type ViewMode = "source" | "rendered" | "edit";

/** Extensions that support a rendered preview */
const RENDERABLE_EXTENSIONS = new Set([".md", ".mdx", ".html", ".htm", ".jsx", ".tsx", ".csv", ".tsv"]);

/** Extensions rendered through Sandpack (React-in-iframe) */
const SANDPACK_EXTENSIONS = new Set([".jsx", ".tsx"]);

/** Extensions rendered through the DataTable viewer (Phase 5.4). */
const DATATABLE_EXTENSIONS = new Set([".csv", ".tsv"]);

/**
 * Extensions that can be edited via the CodeMirror MarkdownEditor surface.
 *
 * Gated to plain-text formats CodeMirror's markdown grammar handles well.
 * .mdx is included because lang-markdown tolerates JSX fragments fine at
 * the source level. Code extensions (.ts, .js, .json, ...) are excluded
 * because they'd want proper language grammars; adding them would also
 * invite confusion about the Save-writes-to-disk contract on files that
 * might be part of the running app.
 */
const EDITABLE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

function isSandpack(filePath: string): boolean {
  return SANDPACK_EXTENSIONS.has(getExtension(filePath));
}

function isDataTable(filePath: string): boolean {
  return DATATABLE_EXTENSIONS.has(getExtension(filePath));
}

function isEditable(filePath: string): boolean {
  return EDITABLE_EXTENSIONS.has(getExtension(filePath));
}

/** Media file extensions that get direct preview (no API fetch needed) */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".avif", ".ico"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".aac"]);

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

function isRenderable(filePath: string): boolean {
  return RENDERABLE_EXTENSIONS.has(getExtension(filePath));
}

function isImagePreview(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(filePath));
}

function isVideoPreview(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(filePath));
}

function isAudioPreview(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(getExtension(filePath));
}

function isMediaPreview(filePath: string): boolean {
  return isImagePreview(filePath) || isVideoPreview(filePath) || isAudioPreview(filePath);
}

function isHtml(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext === ".html" || ext === ".htm";
}

function isMarkdown(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext === ".md" || ext === ".mdx";
}

/**
 * Whether the file's extension already implies the language label
 * the preview API reports. Used to suppress the redundant `· {lang}`
 * suffix in the breadcrumb when, e.g., `notes.md` would otherwise
 * render as `…/notes.md · markdown`.
 *
 * Mapping is one-way (extension → expected language string). Unknown
 * extensions fall through to false, so we keep showing the language
 * when it adds information (e.g. for log files where the parser
 * picked plain-text).
 */
function filenameImpliesLanguage(filePath: string, language: string): boolean {
  const ext = getExtension(filePath);
  const lang = language.toLowerCase();
  const map: Record<string, string[]> = {
    ".md": ["markdown", "md"],
    ".mdx": ["markdown", "md", "mdx"],
    ".html": ["html"],
    ".htm": ["html"],
    ".json": ["json"],
    ".csv": ["csv"],
    ".tsv": ["tsv"],
    ".tsx": ["tsx", "typescript"],
    ".ts": ["ts", "typescript"],
    ".jsx": ["jsx", "javascript"],
    ".js": ["js", "javascript"],
    ".py": ["python"],
    ".rs": ["rust"],
    ".go": ["go"],
    ".sh": ["bash", "shell"],
    ".yaml": ["yaml"],
    ".yml": ["yaml"],
    ".toml": ["toml"],
    ".xml": ["xml"],
    ".css": ["css"],
    ".scss": ["scss"],
  };
  const expected = map[ext];
  return !!expected && expected.includes(lang);
}

const PREVIEW_MIN_WIDTH = 320;
const PREVIEW_MAX_WIDTH = 800;
const PREVIEW_DEFAULT_WIDTH = 480;

/**
 * localStorage key for the persistent Interactive Scripts mode
 * preference (Phase 4 UX v6). Stored value: `"static"` or
 * `"interactive"`. Missing or other → default to interactive.
 */
const INTERACTIVE_SCRIPTS_PREF_KEY = "codepilot.preview.interactiveScripts";

/**
 * Markdown / Artifact / file preview surface — rendered exclusively
 * as a Workspace Sidebar dynamic Tab. The shell owns resize and the
 * Tab strip's X owns close, so this component renders just the
 * header (filename / breadcrumb / view-mode toggle / save / copy /
 * export) and the content body.
 *
 * The unused `variant` param is kept on the signature so the existing
 * `<PreviewPanel variant="sidebar" />` call site in the TabPanel
 * router still type-checks; behaviour does not branch on it.
 */
export function PreviewPanel(_: { variant?: 'sidebar' } = {}) {
  const { resolvedTheme } = useTheme();
  const { workingDirectory, sessionId, previewSource, previewFile, setPreviewFile, setPreviewSource, previewViewMode, setPreviewViewMode } = usePanel();
  const isDark = resolvedTheme === "dark";
  const [preview, setPreview] = useState<FilePreviewType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [width, setWidth] = useState(PREVIEW_DEFAULT_WIDTH);

  // Phase 4 Phase 1 — trust-tier derivation.
  // Default missing `trust` to 'workspace' so pre-Phase-4 callers and
  // persisted Tabs keep working without an upgrade step. Fresh code
  // sets trust explicitly via classifyPath().
  const sourceTrust: PreviewTrust =
    previewSource?.kind === "file" ? previewSource.trust ?? "workspace" : "workspace";
  const isAgentReferenced =
    previewSource?.kind === "file" && sourceTrust === "agent-referenced";
  const isUserSelectedExternal =
    previewSource?.kind === "file" && sourceTrust === "user-selected";
  const isReadonlySource =
    previewSource?.kind === "file" &&
    (previewSource.readonly === true || sourceTrust === "user-selected");
  // baseDir the fetch must use. Workspace tier passes the working
  // directory; user-selected tier intentionally leaves baseDir undefined
  // so /api/files/preview falls back to homeDir scoping. We never trust
  // workingDirectory context when the source is external — that would
  // try to scope a /Users/foo/Desktop/x.md path to the project root and
  // fail the safety check.
  const sourceBaseDir =
    previewSource?.kind === "file"
      ? sourceTrust === "workspace"
        ? previewSource.baseDir ?? workingDirectory ?? undefined
        : previewSource.baseDir
      : undefined;

  // Reload pulse — incremented when the file-changed listener (or the
  // disk-conflict "重新载入" button) wants the load effect to re-run
  // against the same filePath. Wiring it through a state counter is
  // cleaner than refetching inline because the existing useEffect
  // already owns "show spinner, clear stale state, race-cancel" logic.
  const [reloadTick, setReloadTick] = useState(0);
  // Conflict banner state — set when a file-changed event arrives while
  // the editor buffer is dirty. We don't silently clobber edits; the
  // user picks between [Reload from disk] and [Keep my edits].
  const [diskConflict, setDiskConflict] = useState(false);

  // Phase 4 UX v6 — Interactive Scripts is a PERSISTENT user
  // preference, not a per-file flag. Default = true (interactive)
  // because that's the common case for previewing AI-generated
  // pages with scripts. If the user explicitly flips to "Static"
  // for security/privacy reasons, that choice is remembered across
  // tabs and reloads via localStorage. No file-switch reset.
  const [interactiveScripts, setInteractiveScriptsState] = useState<boolean>(
    () => {
      if (typeof window === "undefined") return true;
      try {
        const stored = window.localStorage.getItem(INTERACTIVE_SCRIPTS_PREF_KEY);
        if (stored === "static") return false;
        if (stored === "interactive") return true;
      } catch {
        // localStorage may be unavailable (private mode); fall through
      }
      return true;
    },
  );
  const setInteractiveScripts = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setInteractiveScriptsState((prev) => {
      const resolved = typeof next === "function" ? (next as (p: boolean) => boolean)(prev) : next;
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            INTERACTIVE_SCRIPTS_PREF_KEY,
            resolved ? "interactive" : "static",
          );
        } catch {
          // ignore — storage not available
        }
      }
      return resolved;
    });
  }, []);

  // Phase 4 UX — quiet refresh feedback. Set true for ~1.5s when a
  // same-file file-changed event successfully fetched new content and
  // the content actually differed from what we had. The Markdown
  // toolbar surfaces an "Updated" badge that fades out.
  const [updatedFlash, setUpdatedFlash] = useState(false);
  const updatedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerUpdatedFlash = useCallback(() => {
    setUpdatedFlash(true);
    if (updatedFlashTimerRef.current) clearTimeout(updatedFlashTimerRef.current);
    updatedFlashTimerRef.current = setTimeout(() => {
      setUpdatedFlash(false);
    }, 1500);
  }, []);

  const handleResize = useCallback((delta: number) => {
    // Left-side handle: dragging left (negative delta) = wider
    setWidth((w) => Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, w - delta)));
  }, []);

  const filePath = previewFile || "";

  // Phase 4 UX v6 — interactive-scripts is now a PERSISTENT user
  // preference (default: enabled). The previous per-file reset was
  // removed: switching files no longer zeroes the choice, and the
  // setting survives reloads via localStorage (see
  // INTERACTIVE_SCRIPTS_PREF_KEY).

  // Phase 4 Phase 1.5 — same-origin preview URL for HTML files.
  // null for non-HTML, agent-referenced (no fetch until confirm), or
  // missing scope info. Workspace tier encodes baseDir into the URL;
  // user-selected tier uses the home scope.
  //
  // `interactive` query controls the document CSP at the route level
  // (subresources don't carry it but their behaviour is governed by
  // the document's CSP anyway). `_t` is a reload nonce — bumping it
  // changes the iframe src so the browser re-fetches the document
  // and all its subresources, which is how a sibling-resource edit
  // (./style.css, ./logo.svg) propagates into the live preview.
  const htmlPreviewUrl = useMemo(() => {
    if (previewSource?.kind !== "file") return null;
    if (!isHtml(previewSource.filePath)) return null;
    if (isAgentReferenced) return null;
    try {
      if (sourceTrust === "workspace" && sourceBaseDir) {
        return buildHtmlPreviewUrl(
          previewSource.filePath,
          { kind: "workspace", baseDir: sourceBaseDir },
          { interactive: interactiveScripts, reloadNonce: reloadTick },
        );
      }
      if (sourceTrust === "user-selected") {
        return buildHtmlPreviewUrl(
          previewSource.filePath,
          { kind: "home" },
          { interactive: interactiveScripts, reloadNonce: reloadTick },
        );
      }
    } catch {
      // Non-absolute path or other URL-building error → fall back to
      // null, which makes the rendered branch use the safe srcDoc
      // path (strict sandbox, no relative resources).
      return null;
    }
    return null;
  }, [previewSource, sourceTrust, sourceBaseDir, isAgentReferenced, interactiveScripts, reloadTick]);

  // Phase 4 UX — quiet refresh discipline. Distinguish "filePath
  // changed" (cold load: clear state, show loading, fetch) from
  // "same-file reloadTick bump" (warm refresh: background fetch,
  // content-equality short-circuit, no spinner, no DOM blank).
  // prevFilePathRef tracks what the effect last fetched against; on
  // entry we read it to decide which path we're on, then update.
  const prevFilePathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!filePath || isMediaPreview(filePath)) {
      setLoading(false);
      return;
    }
    if (isAgentReferenced) {
      setLoading(false);
      setPreview(null);
      setError(null);
      setLoadedPath(null);
      setDiskConflict(false);
      return;
    }
    let cancelled = false;

    const isFilePathChange = prevFilePathRef.current !== filePath;
    if (isFilePathChange) {
      // Cold load — flip to loading state synchronously so the
      // SandpackPreview / RenderedView branches don't see stale
      // (newPath + oldContent) pairs. See the loadedPath anchor +
      // freshPreview gating below.
      setLoading(true);
      setPreview(null);
      setError(null);
      setLoadedPath(null);
      setDiskConflict(false);
    }
    // For same-file reloadTick bumps we DO NOT clear preview / set
    // loading / null out loadedPath. The user sees the existing
    // rendered DOM continuously while we fetch in the background.

    async function loadPreview() {
      try {
        const res = await fetch(
          `/api/files/preview?path=${encodeURIComponent(filePath)}${sourceBaseDir ? `&baseDir=${encodeURIComponent(sourceBaseDir)}` : ''}`
        );
        if (!res.ok) {
          const data = await res.json();
          const friendly =
            data.code === 'file_too_large' ? t('filePreview.tooLarge') :
            data.code === 'binary_not_previewable' ? t('filePreview.binaryNotPreviewable') :
            data.code === 'not_found' ? t('filePreview.notFound') :
            (data.error || t('filePreview.failedToLoad'));
          throw new Error(friendly);
        }
        const data = await res.json();
        if (cancelled) return;
        const newPreview = data.preview as FilePreviewType;
        // Phase 4 UX — content equality short-circuit on warm refresh.
        // If the route returned bytes identical to what we already
        // have rendered, swallow the update entirely. No setPreview
        // call → no React reconciliation → no DOM swap → no flash.
        // Cold loads always commit (preview was null).
        setPreview((prev) => {
          if (!isFilePathChange && prev && prev.content === newPreview.content) {
            return prev;
          }
          if (!isFilePathChange) {
            // Warm refresh that actually advanced the content —
            // surface a brief "Updated" indicator in the Markdown
            // toolbar. Cold loads don't trigger the flash; the user
            // already knows they opened a new file.
            triggerUpdatedFlash();
          }
          return newPreview;
        });
        // Phase 4 P1 (Codex review): always advance loadedPath after
        // a successful fetch, INDEPENDENT of whether the content
        // equality short-circuit kept preview unchanged. Otherwise
        // the load effect can hit a scenario where preview already
        // holds the same bytes but loadedPath is still null (or
        // stale), `loadedMatchesActive` stays false, `freshPreview`
        // stays null, and the rendered view sits on the fallback
        // spinner forever. The seed effect downstream calls
        // setLoadedPath only on preview-content/path changes — so
        // when we short-circuit setPreview, the seed effect never
        // fires, and loadedPath would never catch up without this
        // explicit advance.
        setLoadedPath(newPreview.path);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('filePreview.failedToLoad'));
        }
      } finally {
        // Phase 4 P1 (Codex review): always clear loading once the
        // fetch resolves. Previously this was gated on
        // `isFilePathChange`, which races against StrictMode's
        // double-effect cycle: the first run sets
        // prevFilePathRef.current = filePath, the second run sees
        // isFilePathChange = false and skips clearing — loading
        // stays true → spinner forever, even though the data
        // arrived. For warm refresh `setLoading(false)` is a no-op
        // (loading was never set true), so unconditional clearing
        // is safe both ways.
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadPreview();
    prevFilePathRef.current = filePath;
    return () => {
      cancelled = true;
    };
  }, [filePath, sourceBaseDir, isAgentReferenced, reloadTick, triggerUpdatedFlash]);

  const handleCopyContent = async () => {
    const text = freshPreview?.content || filePath;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const [exporting, setExporting] = useState(false);

  // Editor state for Phase 4.3 edit mode. editContent is the in-memory
  // buffer the CodeMirror surface writes to; saving pushes it to
  // /api/files/write and overwrites the on-disk content. The buffer is
  // reseeded whenever the loaded preview changes (switching files, or
  // the on-disk version updating via another path) so the editor always
  // starts from the latest source of truth.
  const [editContent, setEditContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editJustSaved, setEditJustSaved] = useState(false);
  // Phase 5.6 — the "loaded path" anchor for every stale-content check in
  // this panel. Populated when loadPreview successfully seats a new
  // preview.content; cleared synchronously on filePath changes before
  // the fetch starts. Every consumer that derives from preview.content
  // (editor buffer, export button, source/render fallbacks) gates on
  // `loadedPath === previewSource.filePath` so a freshly-mounted
  // previewSource can never be paired with the previous file's
  // content — catches autosave cross-file writes, stale Sandpack first
  // frames, and export-button-during-switch races in one place.
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const loadedMatchesActive =
    previewSource?.kind === "file" && loadedPath === previewSource.filePath;
  useEffect(() => {
    if (preview?.content !== undefined && preview.path) {
      setEditContent(preview.content);
      setSavedContent(preview.content);
      setLoadedPath(preview.path);
    }
  }, [preview?.content, preview?.path]);
  const editDirty = editContent !== savedContent && loadedMatchesActive;

  // Codex P1 follow-up. The render path below used to read `preview`
  // directly, which meant on the first frame after a file switch React
  // saw a fresh filePath paired with the *previous* file's preview.content
  // (setPreview(null) inside the effect hasn't run yet). That stale pair
  // got handed to MarkdownEditor / RenderedView / SourceView / Sandpack
  // and we re-created the same "new TSX key + old content" class of bug
  // the loadedPath anchor was introduced to prevent.
  //
  // `freshPreview` is the only shape the render path should consume:
  // non-null only when the loaded content actually belongs to the
  // currently-active file. Any time freshPreview is null we fall through
  // to the loading branch, so the UI shows a spinner instead of a
  // cross-file frankenstate.
  const freshPreview = loadedMatchesActive ? preview : null;

  // Whether the current preview source is an HTML document we can ship
  // to the Phase 3 long-shot IPC. Lit up when:
  //   • inline-html kind (html lives on the source itself), or
  //   • file kind, extension is HTML, AND the loaded-path anchor
  //     confirms preview.content belongs to the active filePath.
  // The second clause prevents a stale Export click during a mid-switch
  // frame from shipping the outgoing file's content under the incoming
  // file's name.
  const exportableHtml: string | null = useMemo(() => {
    if (previewSource?.kind === 'inline-html') return previewSource.html;
    if (
      previewSource?.kind === 'file' &&
      isHtml(filePath) &&
      freshPreview?.content
    ) {
      return freshPreview.content;
    }
    return null;
  }, [previewSource, filePath, freshPreview]);

  const handleSaveEdit = useCallback(async () => {
    if (!editDirty || savingEdit) return;
    if (previewSource?.kind !== "file") return;
    // Second hard gate — editDirty already bakes this in, but the save
    // path is sensitive enough that duplicating the check against
    // loadedPath is cheap insurance for future refactors.
    if (loadedPath !== previewSource.filePath) return;
    // Phase 4: never write to a readonly source. The UI already hides
    // the save button + autosave gate, but a future code path or
    // keyboard shortcut shouldn't be able to slip a write through.
    if (isReadonlySource) return;
    const targetPath = previewSource.filePath;
    setSavingEdit(true);
    try {
      const res = await fetch("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: targetPath,
          baseDir: sourceBaseDir,
          content: editContent,
          overwrite: true,
          createParents: false,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Save failed: ${data.error || res.statusText}`);
        return;
      }
      // Only mark clean if the current previewSource is still the file
      // we were saving. A mid-save file switch would otherwise leave
      // savedContent pointing at content that belongs to the previous
      // file — benign for persistence (the target file on disk is
      // correct) but would mislabel dirty state on the new file.
      setSavedContent((prev) =>
        previewSource?.kind === "file" && previewSource.filePath === targetPath
          ? editContent
          : prev,
      );
      setEditJustSaved(true);
      setTimeout(() => setEditJustSaved(false), 2000);
      // Phase 4: tell every other listener (and ourselves, idempotent)
      // that this path's on-disk content just changed. `originId` lets
      // our own listener skip the self-echo so we don't refetch the
      // bytes we just wrote.
      dispatchFileChanged({
        paths: [targetPath],
        source: "preview-save",
        originId: targetPath,
      });
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingEdit(false);
    }
  }, [editDirty, savingEdit, previewSource, editContent, loadedPath, sourceBaseDir, isReadonlySource]);

  // Debounced autosave. Fires 1 second after the user stops typing, as
  // long as the buffer is dirty, we're not already saving, and the
  // buffer still belongs to the active file. `editDirty` already has
  // the editContentFile === previewSource.filePath gate baked in, so
  // switching files short-circuits autosave immediately — no race
  // where the new filePath + old content could land in /api/files/write.
  useEffect(() => {
    if (!editDirty || savingEdit) return;
    if (previewSource?.kind !== "file") return;
    if (!isEditable(filePath)) return;
    // Phase 4: readonly sources never autosave. Mirror of the explicit
    // gate inside handleSaveEdit — without this we'd queue a save timer
    // that fires into the readonly guard and silently no-ops.
    if (isReadonlySource) return;
    const timer = setTimeout(() => {
      void handleSaveEdit();
    }, 1000);
    return () => clearTimeout(timer);
  }, [editContent, editDirty, savingEdit, previewSource, filePath, isReadonlySource, handleSaveEdit]);

  // Phase 4: listen for codepilot:file-changed events.
  //
  // Match rules:
  //  1. The event's paths include the active filePath itself → handle
  //     same-file change (existing contract). For editable files with
  //     a dirty buffer this surfaces the conflict banner; otherwise
  //     it bumps reloadTick so the load effect re-fetches.
  //  2. The active source is an HTML file with a same-origin preview
  //     URL AND a changed path is a static-resource dependency under
  //     the HTML's reload scope (see shouldReloadHtmlForPath) → bump
  //     reloadTick. The bump changes the iframe `src` (via the URL
  //     reloadNonce param), forcing a browser-level reload of the
  //     document AND every relative subresource it pulls. Without
  //     this branch, editing `./style.css` while `./index.html` is
  //     open would silently leave the live preview stale.
  //
  // Reload scope:
  //   - workspace HTML → workspace baseDir (the broadest reasonable
  //     floor; CSS / images can legitimately live anywhere in the
  //     project root)
  //   - user-selected (external) HTML → the active HTML's own
  //     directory. sourceBaseDir is undefined for user-selected, so
  //     using it directly would silently skip the dep-reload path for
  //     every external HTML. Codex Round 2 flagged exactly this gap.
  //     Falling back to dirname covers same-dir + subdir siblings
  //     (e.g. `./style.css`, `./assets/logo.svg`) which is what an
  //     external HTML typically references.
  //
  // HTML files don't have an editable buffer (EDITABLE_EXTENSIONS is
  // Markdown-only), so the dirty-buffer conflict path doesn't apply
  // to the HTML-dep case — we go straight to reload.
  //
  // Self-saves are skipped via originId.
  const htmlDepScope = useMemo<string | null>(() => {
    if (previewSource?.kind !== "file") return null;
    if (!isHtml(previewSource.filePath)) return null;
    if (sourceTrust === "workspace") return sourceBaseDir ?? null;
    if (sourceTrust === "user-selected") {
      return htmlPreviewDirname(previewSource.filePath) || null;
    }
    return null;
  }, [previewSource, sourceTrust, sourceBaseDir]);

  // Phase 4 UX — HTML dep-reload debounce. When the user saves a
  // workspace that triggers multiple file-changed events in rapid
  // succession (CSS + JS + image touch each fire separately), we
  // coalesce them into a single reload nonce bump so the iframe
  // doesn't strobe through 3-4 reloads in 100ms.
  //
  // Markdown self-file changes still bump immediately — the quiet
  // refresh logic above absorbs the cost without a visible flash, so
  // there's no benefit to delaying user-perceptible content updates.
  const htmlReloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHtmlDepReload = useCallback(() => {
    if (htmlReloadDebounceRef.current) return;
    htmlReloadDebounceRef.current = setTimeout(() => {
      htmlReloadDebounceRef.current = null;
      setReloadTick((tick) => tick + 1);
    }, 400);
  }, []);
  // Ensure no pending debounce fires after unmount / file switch.
  useEffect(() => {
    return () => {
      if (htmlReloadDebounceRef.current) {
        clearTimeout(htmlReloadDebounceRef.current);
        htmlReloadDebounceRef.current = null;
      }
    };
  }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    const normalizedActive = filePath.replace(/\\/g, "/");
    const activeIsHtml = isHtml(filePath);
    function handle(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (!isFileChangedDetail(detail)) return;
      if (detail.source === "preview-save" && detail.originId === filePath) return;

      const selfMatch = detail.paths.some((p) => p === normalizedActive);
      let depMatch = false;
      if (!selfMatch && activeIsHtml && htmlPreviewUrl) {
        depMatch = detail.paths.some((p) =>
          shouldReloadHtmlForPath(p, normalizedActive, htmlDepScope),
        );
      }
      if (!selfMatch && !depMatch) return;

      if (selfMatch && editDirty) {
        setDiskConflict(true);
        return;
      }
      // HTML dep matches go through the debounce; self matches +
      // non-HTML same-file refreshes bump immediately (the quiet
      // refresh logic upstream absorbs the redundant fetch if the
      // content didn't actually change).
      if (depMatch) {
        scheduleHtmlDepReload();
      } else {
        setReloadTick((tick) => tick + 1);
      }
    }
    window.addEventListener(FILE_CHANGED_EVENT, handle);
    return () => window.removeEventListener(FILE_CHANGED_EVENT, handle);
  }, [filePath, editDirty, htmlPreviewUrl, htmlDepScope, scheduleHtmlDepReload]);
  const handleExportLongShot = useCallback(async () => {
    if (!exportableHtml) return;
    setExporting(true);
    try {
      // Compute basename locally so this callback doesn't depend on the
      // `fileName` variable declared later in the component — avoids
      // a TDZ (let/const before initialization) error at mount time.
      const virtualName =
        previewSource?.kind === 'inline-html' ? previewSource.virtualName ?? 'preview.html' :
        previewSource?.kind === 'file' ? (filePath.split('/').pop() || filePath) :
        'artifact';
      await exportHtmlAsLongShot({
        html: exportableHtml,
        filename: virtualName.replace(/\.[^.]+$/, '') || 'artifact',
        width: 1024,
      });
    } catch (err) {
      if (err instanceof ArtifactExportError) {
        // Surface the code so users know whether it was a transient busy
        // state or a hard limit. Full toast/i18n wiring is Phase 3
        // polish — for now, alert() is acceptable for this short flow.
        alert(`Export failed: ${err.code} — ${err.message}`);
      } else {
        alert(`Export failed: ${String(err)}`);
      }
    } finally {
      setExporting(false);
    }
  }, [exportableHtml, filePath, previewSource]);

  // No `handleClose` here — the Workspace Sidebar Tab strip's X owns
  // close, and there's no panel chrome on this surface for the user
  // to close from.

  // Phase 4: confirm-card handlers. agent-referenced sources block
  // fetch until the user explicitly accepts; on accept we transition
  // the source to user-selected (readonly) so the next render lights
  // up the load effect with the external-path scoping. Cancel just
  // drops the preview (the Tab strip's X already closes from the rail).
  const handleConfirmExternal = useCallback(() => {
    if (previewSource?.kind !== "file") return;
    // Phase 4 P2.2 — preserve the anchor so an agent-referenced link
    // like `/abs/foo.md#L12` opens directly at the requested location
    // after confirm. Dropping it (the original bug) made the user
    // jump back to the top of the file on every external open.
    setPreviewSource({
      kind: "file",
      filePath: previewSource.filePath,
      trust: "user-selected",
      readonly: true,
      ...(previewSource.anchor ? { anchor: previewSource.anchor } : {}),
    });
  }, [previewSource, setPreviewSource]);

  const handleCancelExternal = useCallback(() => {
    setPreviewSource(null);
  }, [setPreviewSource]);

  // Reload from disk after a conflict banner — drop the conflict flag
  // and bump reloadTick so the load effect runs. Keeping the buffer
  // is just clearing the flag; editDirty stays true so the next
  // file-changed event re-opens the banner.
  const handleReloadFromDisk = useCallback(() => {
    setDiskConflict(false);
    setReloadTick((tick) => tick + 1);
  }, []);

  const handleKeepEdits = useCallback(() => {
    setDiskConflict(false);
  }, []);

  // Header title: file uses basename; inline-* sources use virtualName or
  // a kind-appropriate default ("preview.html", "preview.jsx", "table").
  const fileName =
    previewSource?.kind === "inline-html" ? (previewSource.virtualName ?? "preview.html") :
    previewSource?.kind === "inline-jsx" ? (previewSource.virtualName ?? "preview.jsx") :
    previewSource?.kind === "inline-datatable" ? (previewSource.virtualName ?? "table") :
    previewSource?.kind === "inline-json" ? (previewSource.virtualName ?? "preview.json") :
    previewSource?.kind === "inline-diff" ? (previewSource.virtualName ?? "preview.diff") :
    previewSource?.kind === "inline-markdown" ? (previewSource.virtualName ?? "preview.md") :
    filePath.split("/").pop() || filePath;

  const breadcrumb = useMemo(() => {
    // Inline sources have no filesystem path — show a zero-width breadcrumb
    // so the row layout stays consistent without misleading virtual paths.
    if (previewSource && previewSource.kind !== "file") return "";
    const segments = filePath.split("/").filter(Boolean);
    const display = segments.slice(-3);
    const prefix = display.length < segments.length ? ".../" : "";
    return prefix + display.join("/");
  }, [filePath, previewSource]);

  const canRender = isRenderable(filePath);
  const isMedia = isMediaPreview(filePath);

  // Build direct file serve URL for media files.
  // Prefer /api/files/serve (session-scoped) when sessionId is available;
  // fall back to /api/files/raw (home-scoped) for pre-session state.
  const fileServeUrl = filePath
    ? sessionId
      ? `/api/files/serve?path=${encodeURIComponent(filePath)}&sessionId=${encodeURIComponent(sessionId)}`
      : `/api/files/raw?path=${encodeURIComponent(filePath)}`
    : '';

  // Outer wrapper — fills the Workspace Sidebar's Tab body. Resize +
  // width are owned by the sidebar shell so we don't ResizeHandle here.
  //
  // NOTE (Phase 4 UX v6 — flicker root cause): this used to be defined
  // as `const Outer = ({ children }) => (...)` INSIDE the function
  // body, which created a fresh component identity on every render.
  // React sees a different component type per render and tears down
  // + remounts the entire subtree — including the Markdown body
  // streamdown tree — producing a visible flash on every quiet
  // refresh. The fix is to use a plain JSX element below (no
  // intermediate component). Same DOM, stable identity, no remount.

  // Phase 4 UX — presentation popup retired. The current Markdown
  // tab's presentationTemplate (read inside MarkdownRenderedView)
  // drives an in-place CSS theme; there's no "generate artifact"
  // step in this flow. handleRefreshPresentation below stays for
  // back-compat with any legacy inline-html sources persisted
  // before this batch landed.
  const handleRefreshPresentation = useCallback(async () => {
    if (previewSource?.kind !== "inline-html") return;
    const backlink = previewSource.sourceBacklink;
    if (!backlink) return;
    try {
      // Phase 4 P2.2 — use the source's original baseDir via the
      // shared builder. For workspace sources the stored baseDir is
      // used; for user-selected externals baseDir is intentionally
      // omitted so the route falls back to home scoping (matching
      // the original load).
      const url = buildPresentationRefreshUrl(backlink, workingDirectory);
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const fresh = data.preview?.content as string | undefined;
      if (!fresh) return;
      const { data: frontmatter, body } = parseFrontmatter(fresh);
      const html = renderPresentation({
        templateId: (backlink.templateId as PresentationTemplateId) ?? "article",
        sourcePath: backlink.sourcePath,
        body,
        frontmatter,
      });
      setPreviewSource({
        kind: "inline-html",
        html,
        virtualName: previewSource.virtualName,
        sourceBacklink: backlink,
      });
    } catch {
      // Silent — refresh failure leaves the existing artifact in place.
    }
  }, [previewSource, workingDirectory, setPreviewSource]);
  const sourceBacklink =
    previewSource?.kind === "inline-html" ? previewSource.sourceBacklink : undefined;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Header — Luma style (April 2026):
          - Single row instead of two (filename row + breadcrumb row).
            Filename + dimmer breadcrumb stack vertically inside one
            min-w-0 column so long paths truncate without pushing the
            action buttons off-screen.
          - NO `border-b` here — the Workspace Sidebar TabBar above
            this header already draws a divider. A second border 8px
            below the first looked cluttered (user feedback). The
            header just floats on the same `bg-background` surface as
            the content, so the only horizontal rule in the right rail
            is the one under the Tab strip.
          - Action buttons all `text-muted-foreground/80 hover:text-foreground
            hover:bg-muted/50` — same hover idiom as the Tab strip and
            chat composer (no border, no fill, surfaces only on hover). */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 bg-background px-3 pb-1">
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-xs font-medium text-foreground flex items-center gap-1.5">
            <span className="truncate">{fileName}</span>
            {/* Phase 4: external readonly chip — surfaces when the source's
                trust tier is user-selected (or readonly is otherwise set),
                so the user can see at a glance that this file isn't in
                the workspace and the editor surface is intentionally
                disabled. Hidden for workspace and agent-referenced (the
                latter shows the full confirm card instead). */}
            {isUserSelectedExternal && (
              <span
                className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
                title={t("filePreview.external.chipTooltip")}
              >
                {t("filePreview.external.chip")}
              </span>
            )}
            {/* Phase 4 UX v5 — "已更新" badge sits next to the
                filename, NOT between the Select and the view-mode
                Tabs. Same pill idiom as the external chip but in
                emerald; fades in for ~1.5s after a quiet refresh
                commits new content, then back to opacity-0 so the
                slot collapses cleanly. */}
            <span
              className={cn(
                "shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300 transition-opacity duration-300",
                updatedFlash ? "opacity-100" : "opacity-0 pointer-events-none",
              )}
              aria-live="polite"
              aria-hidden={!updatedFlash}
            >
              {t("filePreview.quietRefresh.updated")}
            </span>
          </p>
          {breadcrumb && (
            // Phase 4 UX v2 — cap breadcrumb width so long absolute
            // paths don't push the action controls off the right
            // edge. `truncate` clips with an ellipsis; the hover
            // title surfaces the full path when needed.
            <p
              className="truncate text-[10px] text-muted-foreground/60 max-w-[260px]"
              title={breadcrumb}
            >
              {breadcrumb}
              {/* Drop the `· {language}` suffix when the file's
                  extension already implies the language. E.g. for
                  `notes.md` we don't add `· markdown` — that's
                  redundant and eats horizontal space. Keep the
                  suffix for inline/unknown sources where the
                  filename doesn't disclose the language. */}
              {freshPreview &&
              !isMedia &&
              freshPreview.language &&
              !filenameImpliesLanguage(filePath, freshPreview.language) ? (
                <span className="ml-1.5 text-muted-foreground/40">· {freshPreview.language}</span>
              ) : null}
            </p>
          )}
        </div>

        {/* Phase 4 UX (Codex feedback) — Markdown style Select sits
            to the LEFT of the view-mode toggle in the SAME header
            row. Drops the redundant "样式" label, retires the
            separate in-content toolbar, and keeps the rendered area
            from stacking three toolbar bars. */}
        {previewSource?.kind === "file" &&
          isEditable(filePath) &&
          isMarkdown(previewSource.filePath) &&
          previewViewMode === "rendered" && (
            <PresentationStyleSelect
              value={
                previewSource.presentationTemplate ?? DEFAULT_MARKDOWN_PRESENTATION_STYLE
              }
              onChange={(style) => {
                if (previewSource?.kind !== "file") return;
                setPreviewSource({ ...previewSource, presentationTemplate: style });
              }}
            />
          )}

        {/* The Updated indicator moved next to the filename — see
            the identity row above. Keeps the controls cluster
            (Select + view-mode Tabs) compact and visually balanced. */}

        {canRender && !isMedia && !isAgentReferenced && (
          <ViewModeToggle
            value={previewViewMode}
            onChange={setPreviewViewMode}
            editable={previewSource?.kind === "file" && isEditable(filePath) && !isReadonlySource}
          />
        )}

        {/* Save button — only visible in edit mode. Mirrors the unsaved-
            dot + label affordance from SkillEditor so the two editing
            surfaces feel consistent. Cmd+S inside the editor triggers the
            same handler, so this is an alternate path for mouse users. */}
        {previewViewMode === "edit" && previewSource?.kind === "file" && isEditable(filePath) && !isReadonlySource && (
          <>
            {editDirty && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-status-warning shrink-0"
                title={t("filePreview.save.unsaved")}
              />
            )}
            <Button
              size="xs"
              variant="ghost"
              onClick={handleSaveEdit}
              disabled={!editDirty || savingEdit}
              className="h-7 gap-1 rounded-full px-2.5 text-[11px]"
            >
              {savingEdit ? (
                <SpinnerGap size={12} className="animate-spin" />
              ) : null}
              {savingEdit
                ? t("filePreview.save.saving")
                : editJustSaved
                ? t("filePreview.save.saved")
                : t("filePreview.save.idle")}
            </Button>
          </>
        )}

        {/* Phase 4.C — Markdown source-backlink chip. When the active
            preview is an inline-html artifact generated from a Markdown
            file, surface the source path + a refresh action so the user
            always knows the Markdown is authoritative and can re-render
            after edits. The chip never appears for HTML files loaded
            from disk (those aren't derived; they're sources). */}
        {sourceBacklink && (
          <>
            <span
              className="hidden shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex"
              title={sourceBacklink.sourcePath}
            >
              <span>{t("filePreview.sourceBacklink.label")}:</span>
              <code className="font-mono">
                {sourceBacklink.sourcePath.split(/[/\\]/).pop() ?? sourceBacklink.sourcePath}
              </code>
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleRefreshPresentation}
              className="h-7 px-2 text-[11px]"
              title={t("filePreview.presentation.refresh")}
            >
              <SpinnerGap size={12} />
            </Button>
          </>
        )}

        {/* Phase 4 UX v3 — HTML interactive mode collapsed into a
            single Select instead of a separate chip + toggle button
            (those were redundant — both encoded the same state).
            Default option is "静态" (scripts off; https resources
            allowed for img/style/font/media); user can switch to
            "交互" (scripts on; all https resources blocked to prevent
            URL-shaped exfiltration). The Select trigger itself
            surfaces the current mode — no second chip needed. */}
        {htmlPreviewUrl && previewViewMode === "rendered" && (
          <Select
            value={interactiveScripts ? "interactive" : "static"}
            onValueChange={(v) => setInteractiveScripts(v === "interactive")}
          >
            <SelectTrigger
              size="sm"
              data-codepilot-html-mode-select
              title={t("filePreview.interactive.modeTooltip")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="static">
                {t("filePreview.interactive.modeStatic")}
              </SelectItem>
              <SelectItem value="interactive">
                {t("filePreview.interactive.modeInteractive")}
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        {!isMedia && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleCopyContent}
            className="h-7 w-7 text-muted-foreground/80 hover:text-foreground hover:bg-muted/50"
            title={t("filePreview.copyContent")}
            aria-label={t("filePreview.copyContent")}
          >
            {copied ? (
              <Check size={14} className="text-status-success-foreground" />
            ) : (
              <CodePilotIcon name="copy" size="sm" aria-hidden />
            )}
          </Button>
        )}

        {/* Long-shot export — only surfaces when we have concrete HTML
            to ship to the IPC. Markdown and Sandpack/JSX variants need
            a serialization step (Phase 3 follow-up). */}
        {exportableHtml && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleExportLongShot}
            disabled={exporting}
            title={t("filePreview.exportLongScreenshot")}
            aria-label={t("filePreview.exportLongScreenshot")}
            className="h-7 w-7 text-muted-foreground/80 hover:text-foreground hover:bg-muted/50"
          >
            {exporting ? (
              <SpinnerGap size={14} className="animate-spin" />
            ) : (
              <CodePilotIcon name="image" size="sm" aria-hidden />
            )}
          </Button>
        )}

        {/* No close button here — the Tab strip's X owns close. */}
      </div>

      {/* Content — dispatch on previewSource.kind. The file branch preserves
          the pre-Phase-1.5 behavior (fetch via API + render via
          MediaView/RenderedView/SourceView). inline-html delegates to a
          sandboxed iframe. inline-jsx / inline-datatable render placeholders
          that Phase 2.1 / Phase 5.4 will fill in with real renderers. */}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Phase 4: conflict banner — sticks to the top of the content
            region when a file-changed event arrived while the editor
            buffer was dirty. The body keeps the user's edits visible
            underneath; the banner only adds affordances for reload vs
            keep. Banner is dismissed by either button or by switching
            files. */}
        {diskConflict && previewSource?.kind === "file" && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t("filePreview.conflict.title")}</p>
              <p className="text-amber-900/70 dark:text-amber-200/70">{t("filePreview.conflict.body")}</p>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={handleReloadFromDisk}
              className="h-6 px-2 text-[11px]"
            >
              {t("filePreview.conflict.reload")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleKeepEdits}
              className="h-6 px-2 text-[11px]"
            >
              {t("filePreview.conflict.keep")}
            </Button>
          </div>
        )}
        {isAgentReferenced ? (
          <AgentReferencedConfirm
            filePath={filePath}
            onConfirm={handleConfirmExternal}
            onCancel={handleCancelExternal}
          />
        ) : previewSource?.kind === "inline-html" ? (
          <InlineHtmlView html={previewSource.html} cspMode={previewSource.cspMode} />
        ) : previewSource?.kind === "inline-jsx" ? (
          // key forces remount when the inline JSX source changes, so
          // Sandpack boots fresh instead of recompiling on top of the
          // previous iframe state.
          <SandpackPreview
            key={`inline-${previewSource.virtualName ?? "jsx"}-${previewSource.jsx.length}`}
            content={previewSource.jsx}
            filePath={previewSource.virtualName}
          />
        ) : previewSource?.kind === "inline-datatable" ? (
          <DataTableViewer
            rows={previewSource.rows}
            header={previewSource.header}
            filename={previewSource.virtualName ?? "table"}
          />
        ) : previewSource?.kind === "inline-json" ? (
          // Phase 4.B — JSON tree viewer for ```json code-fence Previews
          // and any other inline-json source. Falls back to a syntax-
          // highlighted text view internally if the payload is malformed.
          <JsonTreeViewer text={previewSource.text} />
        ) : previewSource?.kind === "inline-diff" ? (
          // Phase 4.B — unified-diff viewer for ```diff code-fence Previews.
          <DiffViewer diff={previewSource.diff} />
        ) : previewSource?.kind === "inline-markdown" ? (
          // Phase 4.B — Markdown content with no file source. Reuses the
          // same rendering surface as file-kind Markdown but skips the
          // FrontmatterPanel + OutlineRail since chat-pasted snippets
          // typically don't carry frontmatter and the navigation rail
          // would be visual noise for a short fence.
          <InlineMarkdownView markdown={previewSource.markdown} />
        ) : isMedia ? (
          <MediaView filePath={filePath} fileServeUrl={fileServeUrl} />
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        ) : freshPreview ? (
          <>
            {isEditable(filePath) && !isReadonlySource && (previewViewMode === "edit" || previewViewMode === "source") ? (
              // Editable files: Source and Edit both route to the
              // CodeMirror surface (Edit is Source for Markdown). Cmd+S
              // calls handleSaveEdit through the editor keymap; the
              // debounce-driven autosave below is the primary path.
              // Phase 4: gated on !isReadonlySource so user-selected
              // external Markdown falls through to SourceView instead
              // of dropping the user into a write-capable editor that
              // wouldn't actually save anywhere.
              <MarkdownEditor
                value={editContent}
                onChange={setEditContent}
                onSave={handleSaveEdit}
                filename={filePath}
              />
            ) : previewViewMode === "rendered" && canRender ? (
              <RenderedView
                content={freshPreview.content}
                filePath={filePath}
                htmlPreviewUrl={htmlPreviewUrl}
                interactiveScripts={interactiveScripts}
                anchor={previewSource?.kind === "file" ? previewSource.anchor : undefined}
                workingDirectory={workingDirectory}
                setPreviewSource={setPreviewSource}
                classifyPathFn={classifyPath}
                presentationStyle={
                  (previewSource?.kind === "file" && previewSource.presentationTemplate) ||
                  DEFAULT_MARKDOWN_PRESENTATION_STYLE
                }
              />
            ) : (
              <SourceView preview={freshPreview} isDark={isDark} />
            )}
          </>
        ) : (
          // When previewSource is a file but loadedPath hasn't caught up
          // yet (mid-switch frame — loading is already set true by the
          // synchronous effect below, but React may render once more with
          // stale state between the event and the effect). Fall back to
          // the spinner instead of rendering stale content to the
          // editor/renderer/Sandpack.
          <div className="flex items-center justify-center py-12">
            <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * View-mode toggle — now a shadcn `Tabs` variant for visual
 * consistency with the rest of the app (settings tabs, runtime
 * tabs, etc.). Same value contract as before:
 *  - editable files (.md/.mdx/.txt) show [Edit | Preview]
 *  - non-editable (code/config) show [Source | Preview]
 *  - value="source" on an editable file gets normalized to "edit"
 *    so Tabs has a matching trigger to highlight
 *
 * Lays out in a compact 28px-tall pill so it fits in the panel
 * header without making the row taller than the other actions.
 */
function ViewModeToggle({
  value,
  onChange,
  editable,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
  editable: boolean;
}) {
  const { t } = useTranslation();
  // Normalize legacy "source" on editable files → "edit" so Tabs has
  // a value to attach to.
  const tabValue = editable && value === "source" ? "edit" : value;
  // Phase 4 UX v2 — uses the Tabs primitive's built-in `size="sm"`
  // (added to `src/components/ui/tabs.tsx` cva variants table).
  // No hand-rolled h-N / px-N / text-[Npx] overrides; the trigger
  // padding + text size live in the primitive.
  return (
    <Tabs value={tabValue} onValueChange={(v) => onChange(v as ViewMode)}>
      <TabsList size="sm">
        {editable ? (
          <TabsTrigger value="edit">{t("filePreview.viewMode.edit")}</TabsTrigger>
        ) : (
          <TabsTrigger value="source">{t("filePreview.viewMode.source")}</TabsTrigger>
        )}
        <TabsTrigger value="rendered">{t("filePreview.viewMode.preview")}</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/**
 * Compact in-header Select for the Markdown presentation style.
 * Sits to the LEFT of the view-mode Tabs.
 *
 * Phase 4 UX v2 — uses SelectTrigger's built-in `size="sm"` (a
 * first-class prop on the primitive, see src/components/ui/select.tsx:
 * `size?: "sm" | "default"` mapping to `data-[size=sm]:h-8` etc.).
 * No hand-rolled h-N override; we just pass `size="sm"`. The
 * "样式" label is dropped — the trigger surfaces the current style.
 */
function PresentationStyleSelect({
  value,
  onChange,
}: {
  value: MarkdownPresentationStyle;
  onChange: (style: MarkdownPresentationStyle) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as MarkdownPresentationStyle)}>
      <SelectTrigger size="sm" data-codepilot-md-style-select>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MARKDOWN_PRESENTATION_STYLES.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Resolve hljs style from the current theme family + mode. */
function useDocCodeTheme(isDark: boolean) {
  const { family, families } = useThemeFamily();
  const codeTheme = resolveCodeTheme(families, family);
  return useHljsStyle(codeTheme, isDark);
}

/** Source code view using react-syntax-highlighter */
function SourceView({ preview, isDark }: { preview: FilePreviewType; isDark: boolean }) {
  const { style: hljsStyle, loaded: hljsStyleLoaded } = useDocCodeTheme(isDark);
  return (
    <div className="text-xs">
      {hljsStyleLoaded && hljsStyle ? (
        <SyntaxHighlighter
          language={preview.language}
          style={hljsStyle}
          showLineNumbers
          customStyle={{
            margin: 0,
            padding: "8px",
            borderRadius: 0,
            fontSize: "11px",
            lineHeight: "1.5",
            background: "transparent",
          }}
          lineNumberStyle={{
            minWidth: "2.5em",
            paddingRight: "8px",
            color: "var(--muted-foreground)",
            opacity: 0.5,
            userSelect: "none",
          }}
        >
          {preview.content}
        </SyntaxHighlighter>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: "8px",
            borderRadius: 0,
            fontSize: "11px",
            lineHeight: "1.5",
            background: "transparent",
          }}
          className="overflow-auto"
        >
          {preview.content}
        </pre>
      )}
    </div>
  );
}

/**
 * Inline HTML preview — Phase 1.5 + Phase 4 CSP injection.
 *
 * Renders caller-provided HTML inside a fully sandboxed iframe with
 * `sandbox=""` (no scripts, no same-origin) AND a Round 4 CSP meta
 * injected into the document head. The route-served file previews
 * get their CSP via response headers; inline-html srcDoc didn't
 * inherit those, so a code-fence Preview / Markdown→HTML artifact
 * / localhost redirector all needed the same protection in-band.
 * See `src/lib/inline-html-csp.ts` for the directive table.
 *
 * `cspMode` defaults to `'strict'`; the localhost-artifact redirector
 * passes `'navigate'` so meta refresh navigation isn't blocked while
 * keeping every fetch / nested frame / worker closed.
 */
function InlineHtmlView({
  html,
  cspMode = 'strict',
}: {
  html: string;
  cspMode?: 'strict' | 'navigate';
}) {
  const { t } = useTranslation();
  const hardenedHtml = useMemo(() => injectInlineHtmlCsp(html, cspMode), [html, cspMode]);
  return (
    <iframe
      srcDoc={hardenedHtml}
      sandbox=""
      className="h-full w-full border-0"
      title={t("docPreview.htmlPreview")}
    />
  );
}

/**
 * Phase 4 confirm card for agent-referenced external paths.
 *
 * Shown when an AI tool reported writing or referencing a file that
 * lives outside the session's working directory. We don't auto-fetch
 * the bytes — the path could be a sensitive location (~/.ssh, system
 * config) and the AI's mention alone isn't authorization. The user
 * sees the full path and explicitly confirms before the panel calls
 * /api/files/preview.
 *
 * Confirm → caller sets the source to user-selected (readonly) which
 * triggers the load effect with homeDir scoping.
 * Cancel  → caller clears the preview source, closing the rail entry.
 */
function AgentReferencedConfirm({
  filePath,
  onConfirm,
  onCancel,
}: {
  filePath: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // Phase 4 UX — restructured as a permission gate with three distinct
  // rows: title, full path, then source + permission chips, then
  // explicit "Open read-only" + Cancel buttons. The previous copy
  // ("确认打开") didn't tell the user what they were authorizing.
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-foreground">
        {t("filePreview.external.confirm.title")}
      </p>
      <p className="max-w-md break-all text-xs font-mono text-muted-foreground/80">
        {filePath}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10px]">
        <span className="rounded-full bg-muted/70 px-2 py-0.5 text-muted-foreground">
          {t("filePreview.external.confirm.source")}
        </span>
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
          {t("filePreview.external.confirm.permission")}
        </span>
      </div>
      <p className="max-w-md text-[11px] text-muted-foreground/70">
        {t("filePreview.external.confirm.body")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        <Button size="sm" variant="default" onClick={onConfirm} className="gap-1.5">
          {t("filePreview.external.confirm.openReadOnly")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("filePreview.external.confirm.cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Placeholder for preview kinds whose real renderer lands in a later Phase.
 *
 * Showing a visible "coming soon" block (rather than null) makes two things
 * observable in Phase 1.5 smoke tests: (1) PanelZone gate actually mounts
 * the panel for inline-* sources (R1 regression detector), and (2) the
 * caller wired up setPreviewSource correctly.
 */
function InlinePlaceholder({ phase, kind }: { phase: string; kind: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-muted-foreground">
        {kind} preview lands in {phase}
      </p>
      <p className="text-xs text-muted-foreground/60">
        The data channel (PreviewSource → PreviewPanel) is wired; renderer is pending.
      </p>
    </div>
  );
}

/** Direct media preview — no API fetch needed */
function MediaView({ filePath, fileServeUrl }: { filePath: string; fileServeUrl: string }) {
  if (isImagePreview(filePath)) {
    return (
      <div className="flex items-center justify-center p-4 h-full">
        <img
          src={fileServeUrl}
          alt={filePath.split('/').pop() || ''}
          className="max-w-full max-h-full object-contain rounded"
        />
      </div>
    );
  }

  if (isVideoPreview(filePath)) {
    return (
      <div className="flex items-center justify-center p-4 h-full">
        <video
          src={fileServeUrl}
          controls
          preload="metadata"
          className="max-w-full max-h-full rounded"
        />
      </div>
    );
  }

  if (isAudioPreview(filePath)) {
    return (
      <div className="flex items-center justify-center p-8">
        <audio src={fileServeUrl} controls preload="metadata" className="w-full" />
      </div>
    );
  }

  return null;
}
function RenderedView({
  content,
  filePath,
  htmlPreviewUrl,
  interactiveScripts,
  anchor,
  workingDirectory,
  setPreviewSource,
  classifyPathFn,
  presentationStyle,
}: {
  content: string;
  filePath: string;
  /**
   * Phase 4 Phase 1.5 — when provided, the HTML branch loads from this
   * same-origin route URL instead of `srcDoc={content}`. The browser
   * uses the URL as the document base, so relative resources
   * (`./style.css`, `<img src="logo.png">`) resolve back through the
   * same route and the route serves siblings within the authorized
   * scope. Null falls back to the legacy strict-sandbox srcDoc path
   * (used when scope info is missing or the source is agent-referenced
   * and hasn't been confirmed).
   */
  htmlPreviewUrl: string | null;
  /**
   * When true, the iframe sandbox includes `allow-scripts` so HTML
   * with embedded JavaScript can execute. The iframe still gets a
   * null/opaque origin (no `allow-same-origin`), so scripts cannot
   * read parent cookies, localStorage, or call other API routes.
   */
  interactiveScripts: boolean;
  /** Phase 4.A — optional anchor target. Heading slug or line marker;
   *  the Markdown branch scrolls to the matching heading after render. */
  anchor?: string;
  workingDirectory: string | null | undefined;
  setPreviewSource: (source: ReturnType<typeof usePanel>["previewSource"]) => void;
  classifyPathFn: typeof import("@/lib/preview-source").classifyPath;
  presentationStyle: MarkdownPresentationStyle;
}) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadStreamdown().then(() => setReady(true)).catch(() => {});
  }, []);

  if (isHtml(filePath)) {
    // The interactive toggle gates allow-scripts; allow-forms is
    // bundled because forms-without-scripts is a common static-page
    // affordance the user already trusts when they click "enable
    // scripts." Same-origin is NEVER added — that's the load-bearing
    // security guarantee for this preview surface.
    const sandbox = interactiveScripts ? "allow-scripts allow-forms" : "";
    if (htmlPreviewUrl) {
      return (
        <iframe
          src={htmlPreviewUrl}
          sandbox={sandbox}
          className="h-full w-full border-0"
          title={t('docPreview.htmlPreview')}
        />
      );
    }
    // Fallback path — scope info is missing (agent-referenced or
    // build error). Show the raw HTML in a strict srcDoc so the user
    // can still see content; relative resources won't resolve but
    // that's the cost of not having an authorized scope.
    return (
      <iframe
        srcDoc={content}
        sandbox={sandbox}
        className="h-full w-full border-0"
        title={t('docPreview.htmlPreview')}
      />
    );
  }

  // .jsx / .tsx → Sandpack (React in iframe). See POC 0.5 for the s4
  // default-sandbox security posture and the upgrade path to s2 if
  // Phase 2.5 demands stricter iframe isolation.
  //
  // key ties the SandpackPreview instance to the concrete file path, so
  // clicking a different .tsx from the same folder rebuilds the preview
  // from scratch instead of serving the previously-compiled one.
  if (isSandpack(filePath)) {
    return <SandpackPreview key={filePath} filePath={filePath} content={content} />;
  }

  // .csv / .tsv → DataTable viewer (Phase 5.4). Delimiter picked from
  // the extension so tab-separated files get the right split behavior;
  // papaparse inside the viewer handles column detection.
  if (isDataTable(filePath)) {
    const delimiter = getExtension(filePath) === ".tsv" ? "\t" : ",";
    const basename = filePath.split("/").pop() || filePath;
    return <DataTableViewer key={filePath} csv={content} delimiter={delimiter} filename={basename} />;
  }

  // Markdown / MDX — Phase 4 data layer.
  // Parse frontmatter → strip from body; rewrite Obsidian-style
  // wikilinks and callouts before handing to streamdown; build an
  // outline from headings; inject heading ids after render so
  // anchor-jump + outline-rail clicks land precisely. The dispatcher
  // for codepilot://wikilink links resolves to a file PreviewSource
  // through the existing trust pipeline (workspace inside cwd,
  // agent-referenced otherwise).
  if (!ready || !_StreamdownComponent || !_streamdownPlugins) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <MarkdownRenderedView
      content={content}
      filePath={filePath}
      anchor={anchor}
      workingDirectory={workingDirectory}
      setPreviewSource={setPreviewSource}
      classifyPathFn={classifyPathFn}
      presentationStyle={presentationStyle}
    />
  );
}

/**
 * Phase 4.A — Markdown rendered view with frontmatter + outline +
 * wikilink + callout + heading-anchor support.
 *
 * Stages:
 *   1. Parse YAML frontmatter; strip from body for streamdown.
 *   2. Rewrite Obsidian callouts (> [!type]) into class-bearing
 *      blockquotes.
 *   3. Rewrite [[wikilinks]] into codepilot:// links.
 *   4. Compute outline headings (post-rewrite source).
 *   5. Render via streamdown.
 *   6. After render: inject heading ids onto the DOM nodes so the
 *      outline rail + anchor jump can target them.
 *   7. After render + when anchor changes: scrollIntoView the target.
 *
 * Wikilink + add-to-chat click handling lives on the container so
 * we don't have to walk the streamdown render tree.
 */
function MarkdownRenderedView({
  content,
  filePath,
  anchor,
  workingDirectory,
  setPreviewSource,
  classifyPathFn,
  presentationStyle,
}: {
  content: string;
  filePath: string;
  anchor?: string;
  workingDirectory: string | null | undefined;
  setPreviewSource: (source: ReturnType<typeof usePanel>["previewSource"]) => void;
  classifyPathFn: typeof import("@/lib/preview-source").classifyPath;
  /** In-place CSS theme applied via `codepilot-md-template-<id>`.
   *  Style switching + the "Updated" indicator live in the main
   *  panel header now — this component just consumes the resolved
   *  style as a class. */
  presentationStyle: MarkdownPresentationStyle;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Stage 1: frontmatter split.
  const { data: frontmatter, body } = useMemo(() => parseFrontmatter(content), [content]);

  // Stages 2–4 in one memo so we don't re-rewrite on every render.
  const { processedBody, outline } = useMemo(() => {
    const afterCallouts = rewriteCallouts(body);
    const afterWikilinks = rewriteWikilinks(afterCallouts);
    // Outline is built from the body before HTML-blockquote rewriting
    // would have eaten the heading markers; in practice the callout
    // rewriter doesn't touch headings so this is safe either order.
    const headings = parseOutline(body);
    return { processedBody: afterWikilinks, outline: headings };
  }, [body]);

  // Stage 6: post-render DOM pass. Inject heading ids (so outline rail
  // + anchor jumps land) and stamp callout classes (the rewriter
  // emits sentinel text in the first paragraph of each callout
  // blockquote that this pass converts into the styling class).
  //
  // Phase 4 UX v5 — useLayoutEffect (not useEffect) so the walks run
  // SYNCHRONOUSLY after React commits but BEFORE the browser paints.
  // With useEffect there's a frame where the new DOM is committed
  // but heading ids / callout classes haven't been stamped yet —
  // that frame contributes to the quiet-refresh "flicker" because
  // a callout block briefly renders as a plain blockquote before
  // its color class lands.
  useLayoutEffect(() => {
    injectHeadingIds(bodyRef, outline);
    applyCalloutClasses(bodyRef);
  }, [processedBody, outline]);

  // Stage 7: scroll to anchor when present.
  //
  // Phase 4 UX — anchor jump fires only on (filePath × anchor) change,
  // NOT on every processedBody change. Reason: quiet-refresh updates
  // re-run the rewriter + outline parser whenever AI edits the file,
  // which used to cause scrollIntoView to retrigger and yank the
  // user's reading position back to the heading on every keystroke
  // upstream. Now we key the effect on filePath + anchor only; the
  // outline / body changes are observed via state but don't re-jump.
  useEffect(() => {
    if (!anchor) return;
    const parsed = parseAnchor(anchor);
    if (parsed.kind !== "heading") return;
    // Wait two paint cycles so streamdown render + injectHeadingIds
    // have both committed before we query the DOM.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const root = bodyRef.current;
        if (!root) return;
        const target = root.querySelector<HTMLElement>(`#${cssIdentEscape(parsed.slug)}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [filePath, anchor]);

  // Wikilink click interception. Streamdown turns
  // [[Foo]] → <a href="#codepilot-wikilink-Foo">Foo</a> (fragment URL,
  // which streamdown's sanitizer allows). The browser would try to
  // scroll to an id of that name on the current page; we intercept
  // and route to setPreviewSource instead. Workspace-internal targets
  // open directly; externals go through the agent-referenced confirm
  // flow via classifyPath.
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchorEl = (event.target as HTMLElement | null)?.closest("a");
      if (!anchorEl) return;
      const href = anchorEl.getAttribute("href");
      const target = parseWikilinkHref(href);
      if (!target) return;
      event.preventDefault();
      const resolved = resolveWikilink(target, workingDirectory);
      if (!resolved) return;
      const cls = classifyPathFn(resolved.absolutePath, workingDirectory);
      setPreviewSource({
        kind: "file",
        filePath: resolved.absolutePath,
        trust: cls.trust,
        ...(cls.baseDir ? { baseDir: cls.baseDir } : {}),
        readonly: cls.readonly,
        ...(resolved.anchor ? { anchor: resolved.anchor } : {}),
      });
    },
    [workingDirectory, setPreviewSource, classifyPathFn],
  );

  const Sd = _StreamdownComponent!;
  // Phase 4 UX (Codex feedback):
  //   - In-content toolbar dropped: style Select + updated badge moved
  //     to the main panel header so the rendered region doesn't stack
  //     three toolbar rows.
  //   - Outline rail dropped entirely: in the narrow right-sidebar
  //     width it ate too much room and its partial-height background
  //     looked broken. Headings still get ids via `injectHeadingIds`
  //     so anchor jumps + future re-introductions of the rail keep
  //     working.
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-w-0 flex-1 overflow-auto">
        {Object.keys(frontmatter).length > 0 && (
          <MarkdownFrontmatterPanel data={frontmatter} />
        )}
        <AddToChatToolbar filePath={filePath} containerRef={bodyRef} />
        <div
          ref={bodyRef}
          onClick={onClick}
          className={`px-6 py-4 overflow-x-hidden break-words codepilot-md-body codepilot-md-template-${presentationStyle}`}
        >
          <Sd
            className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6"
            plugins={_streamdownPlugins!}
            linkSafety={{ enabled: false }}
            // Phase 4 UX v5 — mode="static" instead of the default
            // "streaming". Streaming mode wraps each parse cycle in
            // useTransition, which lets React keep showing the old
            // parsed blocks while the new ones are computed. For a
            // chat AI message that's the right behaviour; for a
            // FILE preview that just had its full content swapped,
            // it introduces a perceptible flicker between "old
            // committed" and "new committed" states. Static commits
            // the new tree synchronously.
            mode="static"
          >
            {processedBody}
          </Sd>
        </div>
      </div>
    </div>
  );
}

// MarkdownRenderedViewToolbar removed — its Select moved into the
// main panel header next to the view-mode Tabs, and the Updated
// badge moved alongside it (Codex UX feedback: three stacked toolbar
// rows looked busy in the narrow right rail).

/**
 * Phase 4.A — Add-to-chat affordance. Shown only when the user has a
 * non-empty text selection inside the markdown body. Click dispatches
 * the codepilot:add-to-chat event; MessageInput picks it up and
 * prefills the composer with a quoted blockquote + source path.
 */
function AddToChatToolbar({
  filePath,
  containerRef,
}: {
  filePath: string;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<{ text: string; heading?: string } | null>(null);
  useEffect(() => {
    const handler = () => {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (!sel || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const inside = containerRef.current?.contains(range.commonAncestorContainer);
      if (!inside) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }
      // Find the nearest heading ancestor to enrich the chat context.
      const startNode = (range.startContainer as Node).parentElement;
      const heading = closestHeading(startNode);
      setSelection({ text, heading });
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [containerRef]);

  if (!selection) return null;
  return (
    <div className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-border/40 bg-background/95 px-3 py-1.5 backdrop-blur">
      <span className="truncate text-[10px] text-muted-foreground">
        {selection.text.length} {t("filePreview.addToChat.charsLabel")}
      </span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          dispatchAddToChat({
            text: selection.text,
            sourcePath: filePath,
            sourceLabel: selection.heading,
            sourceAnchor: selection.heading ? `#${slugify(selection.heading)}` : undefined,
          });
        }}
        className="h-6 px-2 text-[11px]"
      >
        {t("filePreview.addToChat.action")}
      </Button>
    </div>
  );
}

function closestHeading(node: Element | null | undefined): string | undefined {
  let cursor: Element | null | undefined = node;
  while (cursor) {
    const tag = cursor.tagName?.toLowerCase();
    if (tag && /^h[1-6]$/.test(tag)) {
      return (cursor.textContent ?? "").trim();
    }
    cursor = cursor.previousElementSibling || cursor.parentElement;
    if (!cursor) break;
  }
  return undefined;
}

/**
 * Inline-markdown viewer for ```md/```markdown code-fence Previews.
 * No file scope → no frontmatter / outline / wikilink resolution
 * (chat-pasted snippets typically don't carry any of those).
 */
function InlineMarkdownView({ markdown }: { markdown: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    loadStreamdown().then(() => setReady(true)).catch(() => {});
  }, []);
  if (!ready || !_StreamdownComponent || !_streamdownPlugins) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }
  const Sd = _StreamdownComponent;
  return (
    <div className="px-6 py-4 overflow-x-hidden break-words">
      <Sd
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6"
        plugins={_streamdownPlugins}
        // Phase 4 UX v5 — mode="static" same reasoning as
        // MarkdownRenderedView: code-fence Preview is a one-shot
        // snapshot, not a streaming AI turn, so the useTransition
        // deferral that the streaming default applies is just
        // visible lag here.
        mode="static"
      >
        {markdown}
      </Sd>
    </div>
  );
}

function cssIdentEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^\w-]/g, (c) => `\\${c}`);
}
