'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  DownloadSimple,
  Trash,
  PaintBrush,
  ChatCircle,
  ArrowLeft,
  ArrowRight,
  Heart,
} from '@/components/ui/icon';
import { cn, parseDBDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { GalleryItem } from './GalleryGrid';

interface GalleryDetailProps {
  item: GalleryItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete?: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
}

function imageUrl(img: GalleryItem['images'][0]): string {
  if (img.localPath) {
    return `/api/media/serve?path=${encodeURIComponent(img.localPath)}`;
  }
  if (img.data) {
    return `data:${img.mimeType};base64,${img.data}`;
  }
  return '';
}

function formatDate(dateStr: string): string {
  try {
    const date = parseDBDate(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export function GalleryDetail({
  item,
  open,
  onOpenChange,
  onDelete,
  onToggleFavorite,
}: GalleryDetailProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset state when item changes (React-recommended ref pattern instead of useEffect+setState)
  const prevItemId = useRef(item?.id);
  if (item?.id !== prevItemId.current) {
    prevItemId.current = item?.id;
    setCurrentImageIndex(0);
    setConfirmDelete(false);
  }

  const handleDownload = useCallback(async () => {
    if (!item) return;
    const img = item.images[currentImageIndex];
    if (!img) return;

    const url = imageUrl(img);
    const ext = img.mimeType.split('/')[1] || 'png';
    const filename = `generated-${item.id}-${currentImageIndex + 1}.${ext}`;

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
      window.open(url, '_blank');
    }
  }, [item, currentImageIndex]);

  const handleDelete = useCallback(() => {
    if (!item) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete?.(item.id);
    onOpenChange(false);
    setConfirmDelete(false);
  }, [item, confirmDelete, onDelete, onOpenChange]);

  if (!item) return null;

  const currentImage = item.images[currentImageIndex];
  const hasMultipleImages = item.images.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-4rem)] sm:max-w-[calc(100vw-4rem)] max-h-[calc(100vh-4rem)] w-full h-[calc(100vh-4rem)] overflow-hidden p-0 gap-0 border-0" showCloseButton>
        <DialogTitle className="sr-only">
          {t('gallery.imageDetail' as TranslationKey)}
        </DialogTitle>

        <div className="flex flex-row h-full">
          {/* Left: Image preview */}
          <div className="relative w-[70%] shrink-0 bg-black">
            <div className="absolute inset-0 flex items-center justify-center">
              {currentImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl(currentImage)}
                  alt={item.prompt}
                  className="max-w-full max-h-full object-contain"
                />
              )}
            </div>

            {hasMultipleImages && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setCurrentImageIndex((i) => (i > 0 ? i - 1 : item.images.length - 1))}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 z-10"
                >
                  <ArrowLeft size={20} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setCurrentImageIndex((i) => (i < item.images.length - 1 ? i + 1 : 0))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 z-10"
                >
                  <ArrowRight size={20} />
                </Button>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white z-10">
                  {currentImageIndex + 1} / {item.images.length}
                </div>
              </>
            )}
          </div>

          {/* Right: Info panel */}
          <div className="flex-1 min-w-0 border-l border-border/50 overflow-y-auto p-6 space-y-5">
            {/* Favorite button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onToggleFavorite?.(item.id)}
              className={cn(
                'gap-1.5',
                item.favorited
                  ? 'text-status-error-foreground'
                  : 'text-muted-foreground hover:text-status-error-foreground',
              )}
            >
              <Heart
                size={20}
                weight={item.favorited ? 'fill' : 'regular'}
              />
              {item.favorited
                ? t('gallery.removeFromFavorites' as TranslationKey)
                : t('gallery.addToFavorites' as TranslationKey)}
            </Button>

            {/* Prompt */}
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                {t('gallery.prompt' as TranslationKey)}
              </div>
              <p className="text-sm text-foreground leading-relaxed">{item.prompt}</p>
            </div>

            {/* Metadata badges */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {item.model && (
                <Badge variant="secondary" className="text-[10px] gap-1">
                  <PaintBrush size={12} />
                  {item.model}
                </Badge>
              )}
              {item.aspectRatio && (
                <Badge variant="outline" className="text-[10px]">
                  {item.aspectRatio}
                </Badge>
              )}
              {item.imageSize && (
                <Badge variant="outline" className="text-[10px]">
                  {item.imageSize}
                </Badge>
              )}
            </div>

            {/* Reference images */}
            {item.referenceImages && item.referenceImages.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1.5">
                  {t('imageGen.referenceImages' as TranslationKey)}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {item.referenceImages.map((ref, i) => {
                    const src = ref.localPath
                      ? `/api/media/serve?path=${encodeURIComponent(ref.localPath)}`
                      : '';
                    if (!src) return null;
                    return (
                      <div key={i} className="w-14 h-14 rounded-md border border-border/30 overflow-hidden bg-muted/30">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`Reference ${i + 1}`} className="w-full h-full object-cover" />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Date */}
            <div className="text-xs text-muted-foreground">
              {formatDate(item.created_at)}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2 border-t border-border/50 flex-wrap">
              {item.session_id && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    router.push(`/chat/${item.session_id}`);
                  }}
                >
                  <ChatCircle size={14} />
                  {t('gallery.openChat' as TranslationKey)}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <DownloadSimple size={14} />
                {t('gallery.download' as TranslationKey)}
              </Button>
              <div className="ml-auto">
                <Button
                  variant={confirmDelete ? 'destructive' : 'ghost'}
                  size="sm"
                  onClick={handleDelete}
                >
                  <Trash size={14} />
                  {confirmDelete
                    ? t('gallery.confirmDelete' as TranslationKey)
                    : t('gallery.delete' as TranslationKey)}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
