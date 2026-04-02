'use client';

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { resolveThemeVars, getWidgetIframeStyleBlock } from '@/lib/widget-css-bridge';
import { sanitizeForStreaming, sanitizeForIframe, buildReceiverSrcdoc } from '@/lib/widget-sanitizer';
import { Code } from '@/components/ui/icon';
import { WidgetErrorBoundary } from './WidgetErrorBoundary';

interface WidgetRendererProps {
  widgetCode: string;
  isStreaming: boolean;
  title?: string;
  /** Show shimmer overlay (e.g. while scripts are still streaming). */
  showOverlay?: boolean;
  /** Extra buttons rendered alongside the "show code" button (top-right toolbar). */
  extraButtons?: React.ReactNode;
}

/** Max iframe height to prevent runaway widgets. */
const MAX_IFRAME_HEIGHT = 2000;

/** Debounce delay for streaming updates (ms). */
const STREAM_DEBOUNCE = 120;

/** CDN hosts that indicate a complex widget needing load time. */
const CDN_PATTERN = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh/;

/**
 * Module-level height cache: preserves widget heights across component remounts.
 * When StreamingMessage is replaced by MessageItem, the WidgetRenderer is remounted.
 * Without this cache, iframe height would reset to 0 → scroll jump.
 * Keyed by first 200 chars of widgetCode (stable across streaming→persisted).
 */
const _heightCache = new Map<string, number>();
function getHeightCacheKey(code: string): string {
  return code.slice(0, 200);
}

function WidgetRendererInner({ widgetCode, isStreaming, title, showOverlay, extraButtons }: WidgetRendererProps) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef<string>('');
  const [iframeReady, setIframeReady] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(() => {
    // Restore cached height to avoid 0→actual jump on remount
    return _heightCache.get(getHeightCacheKey(widgetCode)) || 0;
  });
  const [showCode, setShowCode] = useState(false);
  const [finalized, setFinalized] = useState(false);
  // If we restored from cache, treat as already having received first height
  const hasReceivedFirstHeight = useRef(
    (_heightCache.get(getHeightCacheKey(widgetCode)) || 0) > 0
  );
  // Lock height during finalization to prevent flash (innerHTML swap briefly empties DOM)
  const heightLockedRef = useRef(false);

  // Detect if this widget has CDN scripts (Chart.js, etc.) — only these get a loading overlay
  const hasCDN = useMemo(() => CDN_PATTERN.test(widgetCode), [widgetCode]);

  // Build receiver srcdoc once
  const srcdoc = useMemo(() => {
    const isDark = typeof document !== 'undefined'
      && document.documentElement.classList.contains('dark');
    const resolvedVars = resolveThemeVars();
    const styleBlock = getWidgetIframeStyleBlock(resolvedVars);
    return buildReceiverSrcdoc(styleBlock, isDark);
  }, []);

  // ── postMessage handler ────────────────────────────────────────────────
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (!e.data || typeof e.data.type !== 'string') return;
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;

      switch (e.data.type) {
        case 'widget:ready':
          setIframeReady(true);
          break;

        case 'widget:hatch-buddy':
          // Widget requested buddy hatching — call API from parent (widgets can't fetch due to sandbox)
          fetch('/api/workspace/hatch-buddy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buddyName: e.data.buddyName || '' }),
          })
            .then(r => r.json())
            .then(data => {
              if (data.buddy) {
                // Reload to show the celebration message + new widget that the API inserted into chat
                setTimeout(() => window.location.reload(), 500);
              }
            })
            .catch(() => {});
          break;

        case 'widget:name-buddy':
          fetch('/api/workspace/hatch-buddy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buddyName: e.data.buddyName || '' }),
          })
            .then(() => setTimeout(() => window.location.reload(), 500))
            .catch(() => {});
          break;

        case 'widget:resize':
          if (typeof e.data.height === 'number' && e.data.height > 0) {
            const newH = Math.min(e.data.height + 2, MAX_IFRAME_HEIGHT);
            const cacheKey = getHeightCacheKey(widgetCode);
            // During finalization, only allow height to grow (innerHTML swap
            // briefly empties DOM causing a near-zero resize report)
            if (heightLockedRef.current) {
              setIframeHeight(prev => {
                const h = Math.max(prev, newH);
                _heightCache.set(cacheKey, h);
                return h;
              });
              break;
            }
            _heightCache.set(cacheKey, newH);
            if (!hasReceivedFirstHeight.current) {
              // First height report on a fresh mount (no cache): skip transition
              hasReceivedFirstHeight.current = true;
              const el = iframeRef.current;
              if (el) {
                el.style.transition = 'none';
                void el.offsetHeight;
              }
              setIframeHeight(newH);
              requestAnimationFrame(() => {
                if (el) el.style.transition = 'height 0.3s ease-out';
              });
            } else {
              setIframeHeight(newH);
            }
          }
          break;

        case 'widget:link': {
          const href = String(e.data.href || '');
          if (href && !/^\s*(javascript|data)\s*:/i.test(href)) {
            window.open(href, '_blank', 'noopener,noreferrer');
          }
          break;
        }

        case 'widget:sendMessage': {
          const text = String(e.data.text || '');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fn = (window as any).__widgetSendMessage;
          if (text && text.length <= 500 && typeof fn === 'function') {
            fn(text);
          }
          break;
        }

        case 'widget:publish': {
          // Bubble up to parent window for cross-widget relay
          window.dispatchEvent(new CustomEvent('widget-cross-publish', {
            detail: { topic: e.data.topic, data: e.data.data, sourceIframe: iframeRef.current },
          }));
          break;
        }
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // ── Streaming updates ──────────────────────────────────────────────────
  const sendUpdate = useCallback((html: string) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (html === lastSentRef.current) return;
    lastSentRef.current = html;
    iframe.contentWindow.postMessage({ type: 'widget:update', html }, '*');
  }, []);

  useEffect(() => {
    if (!isStreaming || !iframeReady) return;
    const sanitized = sanitizeForStreaming(widgetCode);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => sendUpdate(sanitized), STREAM_DEBOUNCE);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [widgetCode, isStreaming, iframeReady, sendUpdate]);

  // ── Finalize ───────────────────────────────────────────────────────────
  // Track which widgetCode was last finalized to detect prop changes (dashboard refresh).
  const finalizedCodeRef = useRef('');
  useEffect(() => {
    if (isStreaming || !iframeReady) return;
    if (finalizedCodeRef.current === widgetCode) return; // already finalized this code
    const sanitized = sanitizeForIframe(widgetCode);
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    finalizedCodeRef.current = widgetCode;
    lastSentRef.current = sanitized;
    // Lock height to prevent flash: innerHTML swap briefly empties DOM,
    // causing ResizeObserver to report near-zero height before scripts run.
    heightLockedRef.current = true;
    iframe.contentWindow.postMessage({ type: 'widget:finalize', html: sanitized }, '*');
    // Unlock after scripts have had time to execute and resize
    setTimeout(() => {
      heightLockedRef.current = false;
      setFinalized(true);
    }, 400);
  }, [isStreaming, iframeReady, widgetCode]);

  // ── Theme sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!iframeReady) return;
    const observer = new MutationObserver(() => {
      const nowDark = document.documentElement.classList.contains('dark');
      const vars = resolveThemeVars();
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'widget:theme', vars, isDark: nowDark }, '*',
      );
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [iframeReady]);

  // Show semi-transparent loading overlay ONLY for CDN-dependent widgets
  // while scripts are loading (between iframe ready and finalize complete)
  const showLoadingOverlay = hasCDN && !isStreaming && iframeReady && !finalized;

  return (
    <div className="group/widget relative my-1">
      {/* iframe — always visible, no skeleton, no hiding */}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        title={title || 'Widget'}
        // Fallback for missed widget:ready postMessage (race with useEffect listener setup).
        // By the time onLoad fires, the receiver script has executed and is ready.
        onLoad={() => setIframeReady(true)}
        style={{
          width: '100%',
          height: iframeHeight,
          border: 'none',
          display: showCode ? 'none' : 'block',
          overflow: 'hidden',
          colorScheme: 'auto',
        }}
      />

      {/* Shimmer overlay — shown for CDN script loading OR when parent requests it (script streaming phase) */}
      {(showLoadingOverlay || showOverlay) && (
        <div
          className="absolute inset-0 pointer-events-none rounded-lg"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, var(--color-muted, rgba(128,128,128,0.08)) 50%, transparent 100%)',
            backgroundSize: '200% 100%',
            animation: 'widget-shimmer 1.5s ease-in-out infinite',
          }}
        />
      )}

      {showCode && (
        <pre className="p-3 text-xs rounded-lg bg-muted/30 overflow-x-auto max-h-80 overflow-y-auto border border-border/30">
          <code>{widgetCode}</code>
        </pre>
      )}

      {/* Toolbar — top-right, visible on hover */}
      <div className="absolute top-1 right-1 opacity-0 group-hover/widget:opacity-100 transition-opacity flex items-center gap-1">
        {extraButtons}
        <button
          onClick={() => setShowCode(!showCode)}
          className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 flex items-center gap-0.5"
        >
          <Code size={12} />
          {showCode ? t('widget.hideCode') : t('widget.showCode')}
        </button>
      </div>
    </div>
  );
}

export function WidgetRenderer(props: WidgetRendererProps) {
  return (
    <WidgetErrorBoundary>
      <WidgetRendererInner {...props} />
    </WidgetErrorBoundary>
  );
}
