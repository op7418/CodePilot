'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ImageGenCard } from './ImageGenCard';
import { useTranslation } from '@/hooks/useTranslation';
import { usePanel } from '@/hooks/usePanel';
import type { TranslationKey } from '@/i18n';
import type { ReferenceImage } from '@/types';
import type { ImageGenResult } from '@/hooks/useImageGen';

const ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '21:9',
] as const;

const RESOLUTIONS = ['1K', '2K', '4K'] as const;

interface ImageGenConfirmationProps {
  messageId?: string;
  initialPrompt: string;
  initialAspectRatio: string;
  initialResolution: string;
  referenceImages?: ReferenceImage[];
}

type Status = 'idle' | 'generating' | 'completed' | 'error';

/** Stable key for persisting generation results in localStorage */
function storageKey(prompt: string, sessionId?: string): string {
  const prefix = sessionId ? `${sessionId}:` : '';
  return `imggen:${prefix}${prompt.slice(0, 80)}`;
}

export function ImageGenConfirmation({
  messageId,
  initialPrompt,
  initialAspectRatio,
  initialResolution,
  referenceImages,
}: ImageGenConfirmationProps) {
  const { t } = useTranslation();
  const { sessionId } = usePanel();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [aspectRatio, setAspectRatio] = useState(
    ASPECT_RATIOS.includes(initialAspectRatio as typeof ASPECT_RATIOS[number])
      ? initialAspectRatio
      : '1:1'
  );
  const [resolution, setResolution] = useState(
    RESOLUTIONS.includes(initialResolution as typeof RESOLUTIONS[number])
      ? initialResolution
      : '1K'
  );
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ImageGenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Restore completed result from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey(initialPrompt, sessionId));
      if (saved) {
        const parsed: ImageGenResult = JSON.parse(saved);
        if (parsed.images && parsed.images.length > 0) {
          setResult(parsed);
          setStatus('completed');
        }
      }
    } catch {
      // ignore
    }
  }, [initialPrompt, sessionId]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStatus('idle');
  }, []);

  const handleGenerate = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('generating');
    setError(null);

    try {
      // Split unified ReferenceImage[] back into base64 data vs file paths for the API
      const refData = referenceImages?.filter(r => r.data).map(r => ({ mimeType: r.mimeType, data: r.data! }));
      const refPaths = referenceImages?.filter(r => r.localPath).map(r => r.localPath!);

      const res = await fetch('/api/media/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          aspectRatio,
          imageSize: resolution,
          sessionId,
          ...(refData && refData.length > 0
            ? { referenceImages: refData }
            : {}),
          ...(refPaths && refPaths.length > 0
            ? { referenceImagePaths: refPaths }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Generation failed' }));
        throw new Error(err.error || 'Generation failed');
      }

      const data = await res.json();
      const genResult: ImageGenResult = {
        id: data.id,
        text: data.text,
        images: data.images || [],
      };

      if (genResult.images.length > 0) {
        setResult(genResult);
        setStatus('completed');

        // Store lightweight version in localStorage
        try {
          const storable = {
            id: genResult.id,
            text: genResult.text,
            images: genResult.images.map(img => ({
              mimeType: img.mimeType,
              localPath: img.localPath,
              data: '',
            })),
          };
          localStorage.setItem(storageKey(initialPrompt, sessionId), JSON.stringify(storable));
        } catch {
          // storage full
        }

        // Persist result to DB by replacing image-gen-request with image-gen-result
        {
          const resultBlock = JSON.stringify({
            status: 'completed',
            prompt,
            aspectRatio,
            resolution,
            images: genResult.images.map(img => ({
              mimeType: img.mimeType,
              localPath: img.localPath,
            })),
          });
          fetch('/api/chat/messages', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message_id: messageId || '',
              content: '```image-gen-result\n' + resultBlock + '\n```',
              session_id: sessionId,
              prompt_hint: initialPrompt,
            }),
          }).catch(() => {});
        }

        // Defer event dispatch so React commits setResult/setStatus before
        // ChatView's handler calls sendMessage and triggers a re-render
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('image-gen-completed', {
            detail: {
              prompt,
              aspectRatio,
              resolution,
              id: genResult.id,
              images: genResult.images,
            },
          }));
        }, 0);
      } else {
        setError('No images were generated');
        setStatus('error');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setStatus('idle');
        return;
      }
      setError((err as Error).message || 'Generation failed');
      setStatus('error');
    } finally {
      abortRef.current = null;
    }
  }, [prompt, aspectRatio, resolution, initialPrompt, sessionId, messageId, referenceImages]);

  const handleRegenerate = useCallback(() => {
    setResult(null);
    setStatus('idle');
    try {
      localStorage.removeItem(storageKey(initialPrompt, sessionId));
    } catch {
      // ignore
    }
  }, [initialPrompt, sessionId]);

  // ── Completed: show result only ──
  if (status === 'completed' && result && result.images.length > 0) {
    return (
      <div className="my-2">
        <ImageGenCard
          images={result.images}
          prompt={prompt}
          aspectRatio={aspectRatio}
          imageSize={resolution}
          onRegenerate={handleRegenerate}
          referenceImages={referenceImages?.filter(r => r.data).map(r => ({ mimeType: r.mimeType, data: r.data! }))}
        />
      </div>
    );
  }

  // ── Idle / Generating / Error: show params card ──
  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden my-2">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30 bg-muted/30">
        <span className="text-sm font-medium">{t('imageGen.confirmTitle' as TranslationKey)}</span>
      </div>

      <div className="p-4 space-y-3">
        {/* Reference images preview — unified loop over all reference images */}
        {referenceImages && referenceImages.length > 0 && (
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              {t('imageGen.referenceImages' as TranslationKey)}
            </label>
            <div className="flex gap-2 flex-wrap">
              {referenceImages.map((img, i) => (
                <div key={i} className="w-16 h-16 rounded-md border border-border/30 overflow-hidden bg-muted/30">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.data
                      ? `data:${img.mimeType};base64,${img.data}`
                      : `/api/uploads?path=${encodeURIComponent(img.localPath!)}`}
                    alt={`Reference ${i + 1}`}
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Prompt textarea */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            {t('imageGen.prompt' as TranslationKey)}
          </label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={status === 'generating'}
            rows={3}
            className={cn(
              'resize-none',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          />
        </div>

        {/* Aspect Ratio */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            {t('imageGen.aspectRatio' as TranslationKey)}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {ASPECT_RATIOS.map((ratio) => (
              <Button
                key={ratio}
                variant="outline"
                size="xs"
                disabled={status === 'generating'}
                onClick={() => setAspectRatio(ratio)}
                className={cn(
                  aspectRatio === ratio
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/30'
                )}
              >
                {ratio}
              </Button>
            ))}
          </div>
        </div>

        {/* Resolution */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            {t('imageGen.resolution' as TranslationKey)}
          </label>
          <div className="flex items-center gap-1.5">
            {RESOLUTIONS.map((res) => (
              <Button
                key={res}
                variant="outline"
                size="xs"
                disabled={status === 'generating'}
                onClick={() => setResolution(res)}
                className={cn(
                  resolution === res
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/30'
                )}
              >
                {res}
              </Button>
            ))}
          </div>
        </div>

        {/* Generate button */}
        {status === 'idle' && (
          <div className="pt-1">
            <Button
              onClick={handleGenerate}
              disabled={!prompt.trim()}
              size="sm"
              className="gap-1.5"
            >
              {t('imageGen.generateButton' as TranslationKey)}
            </Button>
          </div>
        )}

        {/* Generating: spinner + stop */}
        {status === 'generating' && (
          <div className="pt-1">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span className="text-sm text-muted-foreground">
                  {t('imageGen.generatingStatus' as TranslationKey)}
                </span>
              </div>
              <Button onClick={handleStop} variant="outline" size="sm">
                {t('imageGen.stopButton' as TranslationKey)}
              </Button>
            </div>
          </div>
        )}

        {/* Error */}
        {status === 'error' && error && (
          <div className="space-y-2">
            <p className="text-sm text-status-error-foreground">{error}</p>
            <Button onClick={handleGenerate} variant="outline" size="sm">
              {t('imageGen.retryButton' as TranslationKey)}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
