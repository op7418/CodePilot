'use client';

import { useState, useCallback } from 'react';
import { DownloadSimple, ArrowsCounterClockwise, PaintBrush } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ImageLightbox } from './ImageLightbox';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';

interface ImageGenImage {
  data: string;
  mimeType: string;
  localPath?: string;
}

interface ImageGenCardProps {
  images: ImageGenImage[];
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  model?: string;
  onRegenerate?: () => void;
  referenceImages?: Array<{ mimeType: string; data: string; localPath?: string }>;
}

function imageUrl(img: ImageGenImage): string {
  if (img.localPath) {
    return `/api/media/serve?path=${encodeURIComponent(img.localPath)}`;
  }
  return `data:${img.mimeType};base64,${img.data}`;
}

export function ImageGenCard({
  images,
  prompt,
  aspectRatio,
  imageSize,
  model,
  onRegenerate,
  referenceImages,
}: ImageGenCardProps) {
  const { t } = useTranslation();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const lightboxImages = images.map((img, i) => ({
    src: imageUrl(img),
    alt: `${t('imageGen.generated' as TranslationKey)} ${i + 1}`,
  }));

  const handlePreview = useCallback((index: number) => {
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const handleDownload = useCallback(async (img: ImageGenImage, index: number) => {
    const url = imageUrl(img);
    const ext = img.mimeType.split('/')[1] || 'png';
    const filename = `generated-${Date.now()}-${index + 1}.${ext}`;

    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Fallback: open in new tab
      window.open(url, '_blank');
    }
  }, []);

  if (images.length === 0) return null;

  const gridCols =
    images.length === 1
      ? 'grid-cols-1 max-w-sm'
      : images.length === 2
        ? 'grid-cols-2 max-w-md'
        : 'grid-cols-3 max-w-lg';

  return (
    <div className="rounded-lg border border-border/50 bg-card p-3 space-y-2.5">
      {/* Image grid */}
      <div className={cn('grid gap-2', gridCols)}>
        {images.map((img, i) => (
          <Button
            key={i}
            variant="ghost"
            onClick={() => handlePreview(i)}
            className="relative group overflow-hidden rounded-md border border-border/30 bg-muted/30 p-0 h-auto"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl(img)}
              alt={`${t('imageGen.generated' as TranslationKey)} ${i + 1}`}
              className="w-full h-auto object-cover transition-transform group-hover:scale-[1.02]"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
          </Button>
        ))}
      </div>

      {/* Prompt text */}
      <p className="text-sm text-foreground/80 leading-relaxed">{prompt}</p>

      {/* Reference images (垫图) */}
      {referenceImages && referenceImages.length > 0 && (
        <div>
          <span className="text-[10px] text-muted-foreground/60 mb-1 block">
            {t('imageGen.referenceImages' as TranslationKey)}
          </span>
          <div className="flex gap-1.5 flex-wrap">
            {referenceImages.map((ref, i) => {
              const src = ref.localPath
                ? `/api/media/serve?path=${encodeURIComponent(ref.localPath)}`
                : ref.data
                  ? `data:${ref.mimeType};base64,${ref.data}`
                  : '';
              if (!src) return null;
              return (
                <div key={i} className="w-12 h-12 rounded border border-border/30 overflow-hidden bg-muted/30">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`Reference ${i + 1}`} className="w-full h-full object-cover" />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Badges + Actions */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {model && (
            <Badge variant="secondary" className="text-[10px] gap-1">
              <PaintBrush size={12} />
              {model}
            </Badge>
          )}
          {aspectRatio && (
            <Badge variant="outline" className="text-[10px]">
              {aspectRatio}
            </Badge>
          )}
          {imageSize && (
            <Badge variant="outline" className="text-[10px]">
              {imageSize}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => handleDownload(images[0], 0)}
            title={t('imageGen.download' as TranslationKey)}
          >
            <DownloadSimple size={14} />
          </Button>
          {onRegenerate && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onRegenerate}
              title={t('imageGen.regenerate' as TranslationKey)}
            >
              <ArrowsCounterClockwise size={14} />
            </Button>
          )}
        </div>
      </div>

      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  );
}
