'use client';

import { useState } from 'react';
import type { MediaBlock } from '@/types';
import { ImageLightbox } from './ImageLightbox';

function mediaUrl(block: MediaBlock): string {
  if (block.localPath) {
    return `/api/media/serve?path=${encodeURIComponent(block.localPath)}`;
  }
  if (block.data) {
    return `data:${block.mimeType};base64,${block.data}`;
  }
  return '';
}

interface MediaPreviewProps {
  media: MediaBlock[];
}

export function MediaPreview({ media }: MediaPreviewProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  if (!media || media.length === 0) return null;

  const images = media.filter(m => m.type === 'image');
  const videos = media.filter(m => m.type === 'video');
  const audios = media.filter(m => m.type === 'audio');

  const lightboxImages = images.map((img, i) => ({
    src: mediaUrl(img),
    alt: `Media ${i + 1}`,
  }));

  return (
    <div className="mt-2 space-y-2">
      {/* Images */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => {
            const url = mediaUrl(img);
            return url ? (
              <img
                key={i}
                src={url}
                alt={`Generated image ${i + 1}`}
                loading="lazy"
                className="max-w-xs max-h-64 rounded-md border border-border/50 cursor-pointer hover:opacity-90 transition-opacity object-contain"
                onClick={() => {
                  setLightboxIndex(i);
                  setLightboxOpen(true);
                }}
              />
            ) : null;
          })}
        </div>
      )}

      {/* Videos */}
      {videos.map((vid, i) => {
        const url = mediaUrl(vid);
        return url ? (
          <video
            key={`video-${i}`}
            src={url}
            controls
            preload="metadata"
            className="max-w-md max-h-80 rounded-md border border-border/50"
          />
        ) : null;
      })}

      {/* Audio */}
      {audios.map((aud, i) => {
        const url = mediaUrl(aud);
        return url ? (
          <audio
            key={`audio-${i}`}
            src={url}
            controls
            preload="metadata"
            className="w-full max-w-md"
          />
        ) : null;
      })}

      {/* Lightbox for images */}
      {lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
        />
      )}
    </div>
  );
}
