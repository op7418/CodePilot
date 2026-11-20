"use client";

/**
 * Floating card layout primitives — Phase 7c.
 *
 * See `docs/exec-plans/active/phase-7c-card-primitive.md` for the full
 * rationale. The short version: macOS Tahoe-style floating cards
 * collapsed into three single-responsibility components so the
 * shadow / clip / gutter concerns can't drift across panels.
 *
 *   CardFrame   — shadow + radius + isolation + layout. Does NOT clip.
 *   CardSurface — bg + clip-path + backdrop-filter + content slot.
 *                 Does NOT paint outer shadow.
 *   ResizeGutter — 8px-wide row-level child that sits ONLY between
 *                  two adjacent visible CardFrames. Its visible 2px
 *                  line is centered inside the 8px gutter so it
 *                  always lands on the gap's geometric mid-line.
 *
 * Hard constraints (enforced by these components, not by globals.css):
 *   • ResizeGutter never lives inside a CardFrame.
 *   • CardFrame and CardSurface attribute marks (data-platform-*) are
 *     emitted by these components — call sites do not handwrite them.
 *   • Width state stays with the consumer panel; the primitives only
 *     accept a `width` prop and forward `onResize/...` callbacks.
 */

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type CardKind = "sidebar" | "main" | "workspace" | "assistant";

const CARD_FRAME_ATTR = "data-platform-card-frame";

/** kind → the legacy data-attribute name we still emit on the surface
 *  so existing CSS selectors in globals.css keep matching. Adding new
 *  attribute names is fine — these are the load-bearing ones. */
const SURFACE_ATTR_BY_KIND: Record<CardKind, string> = {
  sidebar: "data-platform-sidebar",
  main: "data-platform-main-content",
  workspace: "data-workspace-sidebar",
  assistant: "data-platform-assistant",
};

const FRAME_VALUE_BY_KIND: Record<CardKind, string> = {
  sidebar: "sidebar",
  main: "main",
  workspace: "workspace",
  assistant: "assistant",
};

/* -------------------------------------------------------------------------- */
/* CardFrame                                                                  */
/* -------------------------------------------------------------------------- */

interface CardFrameProps {
  kind: CardKind;
  /**
   * Fixed pixel width. Provide for sidebar / workspace where
   * the panel owns its own width state. Leave undefined for `kind="main"`
   * so the frame expands via `flex-1` to fill the remaining row space.
   */
  width?: number;
  className?: string;
  children: React.ReactNode;
}

/**
 * Outer floating-card frame. Carries the shadow and the layout slot in
 * the row's flex layout. Does NOT clip — overflow stays visible so the
 * frame's box-shadow paints freely past the surface's rounded silhouette.
 *
 * The frame's `border-radius` exists so the shadow follows the card's
 * silhouette (per CSS shadow spec, box-shadow follows the element's
 * computed border-radius). It is NOT used to clip anything.
 */
export function CardFrame({ kind, width, className, children }: CardFrameProps) {
  const attrs: Record<string, string> = {
    [CARD_FRAME_ATTR]: FRAME_VALUE_BY_KIND[kind],
  };
  const isMain = kind === "main";
  return (
    <div
      {...attrs}
      className={cn(
        "h-full shrink-0",
        isMain && "flex-1 min-w-0",
        className,
      )}
      style={width !== undefined ? { width } : undefined}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* CardSurface                                                                */
/* -------------------------------------------------------------------------- */

interface CardSurfaceProps {
  kind: CardKind;
  /**
   * Optional sub-variant. For `kind="sidebar"` use `"chat-list"` or
   * `"settings"` so DOM inspector can tell them apart; current CSS
   * matches the attribute by name (any value), so this is purely
   * debug-flavored.
   */
  variant?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Inner surface — paints the card's background, clips its children to
 * the rounded silhouette, and provides the optional backdrop-filter
 * stack for the translucent kinds (sidebar / workspace). Does NOT paint
 * an outer shadow — that belongs to CardFrame.
 *
 * The `clip-path: inset(0 round 14px)` and `border-radius: 14px` live in
 * globals.css under the darwin profile. Off-mac the radius is 0 and the
 * clip is a no-op, so the same DOM still works as a plain block on
 * web / windows / linux.
 */
export function CardSurface({ kind, variant, className, children }: CardSurfaceProps) {
  const attrName = SURFACE_ATTR_BY_KIND[kind];
  const attrs: Record<string, string> = { [attrName]: variant ?? "" };
  return (
    <div
      {...attrs}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden",
        // The sidebar / workspace kinds need an inline background so
        // the translucent fill shows up everywhere off-mac too (web
        // sidebars get the legacy `--platform-surface-sidebar` token).
        kind === "sidebar" && "bg-[var(--platform-surface-sidebar)] backdrop-blur-xl",
        kind === "workspace" && "bg-background",
        kind === "main" && "bg-background",
        // Assistant rail is opaque by deliberate user request (see
        // AssistantPanel's "Round 5" note).
        kind === "assistant" && "bg-background",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ResizeGutter                                                               */
/* -------------------------------------------------------------------------- */

interface ResizeGutterProps {
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
  /** Double-click handler — usually "reset to default width". */
  onReset?: () => void;
  /** Accessible name for keyboard and assistive-technology users. */
  ariaLabel?: string;
  className?: string;
}

/**
 * 8px-wide row-level gutter that hosts the visible resize line. Placed
 * as a sibling between two CardFrames (NEVER inside a frame). Owns the
 * pointer math and gradient; consumer panels just plug in callbacks.
 *
 * Geometry contract — verified by the real-DOM e2e
 * `src/__tests__/e2e/card-gutter-geometry.spec.ts`:
 *   gutter.boundingClientRect().width === 8
 *   line centerX === gutter centerX (the 2px line sits in the middle
 *   of the 8px gutter, so it lands on the geometric mid-line between
 *   the two adjacent cards).
 *
 * Hover paints a cursor-following gradient (the cursor row is the
 * brightest, fading to transparent toward the top/bottom of the card).
 * Mirrors Craft Agent's `useResizeGradient` (see
 * craft-agents-oss `apps/electron/src/renderer/hooks/useResizeGradient.ts`).
 */
export const RESIZE_GUTTER_WIDTH_PX = 8;

export function ResizeGutter({ onResize, onResizeEnd, onReset, ariaLabel = "Resize panel", className }: ResizeGutterProps) {
  const isDragging = useRef(false);
  const startX = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [gutterHeight, setGutterHeight] = useState(0);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    setGutterHeight(e.currentTarget.getBoundingClientRect().height);
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setHoverY(e.clientY - rect.top);
      setGutterHeight(rect.height);
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      startX.current = e.clientX;
      onResize(delta);
    },
    [onResize],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setDragging(false);
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEnd?.();
    },
    [onResizeEnd],
  );

  const handlePointerLeave = useCallback(() => {
    if (!isDragging.current) setHoverY(null);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onResize(e.key === "ArrowLeft" ? -16 : 16);
    onResizeEnd?.();
  }, [onResize, onResizeEnd]);

  const gradientBg = (() => {
    if ((!dragging && hoverY === null) || gutterHeight <= 0) return undefined;
    const h = gutterHeight;
    const cy = dragging ? h / 2 : (hoverY ?? h / 2);
    const edge = Math.min(64, h / 2);
    const center = Math.max(edge, Math.min(h - edge, cy));
    const near = Math.max(20, edge * 0.22);
    const far = Math.max(56, edge * 0.75);
    const alphaPeak = dragging ? 0.36 : 0.24;
    const alphaMid = dragging ? 0.18 : 0.12;
    const alphaEdge = dragging ? 0.10 : 0.06;
    return {
      background: `linear-gradient(
        to bottom,
        transparent 0px,
        color-mix(in oklch, var(--foreground) ${Math.round(alphaEdge * 100)}%, transparent) ${center - far}px,
        color-mix(in oklch, var(--foreground) ${Math.round(alphaMid * 100)}%, transparent) ${center - near}px,
        color-mix(in oklch, var(--foreground) ${Math.round(alphaPeak * 100)}%, transparent) ${center}px,
        color-mix(in oklch, var(--foreground) ${Math.round(alphaMid * 100)}%, transparent) ${center + near}px,
        color-mix(in oklch, var(--foreground) ${Math.round(alphaEdge * 100)}%, transparent) ${center + far}px,
        transparent ${h}px
      )`,
    };
  })();

  return (
    <div
      data-resize-gutter
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative z-10 flex h-full shrink-0 cursor-col-resize items-stretch justify-center touch-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      style={{ width: RESIZE_GUTTER_WIDTH_PX }}
    >
      <div
        className="pointer-events-none w-0.5 transition-opacity duration-150"
        style={{
          opacity: dragging || hoverY !== null ? 1 : 0,
          ...gradientBg,
        }}
      />
    </div>
  );
}
