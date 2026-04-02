'use client';

import { PaintBrush, Heart, Play } from '@/components/ui/icon';

export interface GalleryItem {
  id: string;
  prompt: string;
  images: Array<{ data?: string; mimeType: string; localPath?: string }>;
  type?: 'image' | 'video' | 'audio';
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  tags: string[];
  favorited?: boolean;
  created_at: string;
  session_id?: string;
  referenceImages?: Array<{ mimeType: string; localPath: string }>;
}

interface GalleryGridProps {
  items: GalleryItem[];
  onSelect: (item: GalleryItem) => void;
}

function thumbnailUrl(item: GalleryItem): string {
  const img = item.images[0];
  if (!img) return '';
  if (img.localPath) {
    return `/api/media/serve?path=${encodeURIComponent(img.localPath)}`;
  }
  if (img.data) {
    return `data:${img.mimeType};base64,${img.data}`;
  }
  return '';
}

function isVideoItem(item: GalleryItem): boolean {
  if (item.type === 'video') return true;
  const img = item.images[0];
  return !!img?.mimeType?.startsWith('video/');
}

export function GalleryGrid({ items, onSelect }: GalleryGridProps) {
  return (
    <div
      className="gap-3"
      style={{
        columnCount: 6,
        columnGap: '12px',
      }}
    >
      {items.map((item) => {
        const url = thumbnailUrl(item);
        const isVideo = isVideoItem(item);

        return (
          <div
            key={item.id}
            className="mb-3 cursor-pointer rounded-lg overflow-hidden ring-0 hover:ring-2 hover:ring-border transition-all"
            style={{ breakInside: 'avoid' }}
            onClick={() => onSelect(item)}
          >
            <div className="relative bg-muted/30">
              {url ? (
                isVideo ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video
                    src={url}
                    muted
                    preload="metadata"
                    className="block w-full h-auto"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt={item.prompt}
                    className="block w-full h-auto"
                    loading="lazy"
                  />
                )
              ) : (
                <div className="flex aspect-square items-center justify-center">
                  <PaintBrush size={32} className="text-muted-foreground/30" />
                </div>
              )}
              {isVideo && url && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm">
                    <Play size={20} weight="fill" className="text-white ml-0.5" />
                  </span>
                </span>
              )}
              {item.images.length > 1 && (
                <span className="absolute top-1.5 right-1.5 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] text-white font-medium">
                  {item.images.length}
                </span>
              )}
              {item.favorited && (
                <span className="absolute top-1.5 left-1.5">
                  <Heart size={16} className="text-status-error-foreground drop-shadow" weight="fill" />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
