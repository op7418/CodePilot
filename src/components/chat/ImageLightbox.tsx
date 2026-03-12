'use client';

import { useState, useCallback } from 'react';
import { ArrowLeft, ArrowRight } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';

interface LightboxImage {
  src: string;
  alt: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageLightbox({ images, initialIndex, open, onOpenChange }: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const goToPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
  }, [images.length]);

  const goToNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
  }, [images.length]);

  // Reset index when dialog opens with a new initialIndex
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (newOpen) {
      setCurrentIndex(initialIndex);
    }
    onOpenChange(newOpen);
  }, [initialIndex, onOpenChange]);

  if (images.length === 0) return null;

  const current = images[currentIndex];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-[95vw] max-h-[95vh] p-0 border-none bg-black/90 shadow-none sm:max-w-[95vw]"
        showCloseButton
      >
        <DialogTitle className="sr-only">Image preview</DialogTitle>
        <div className="relative flex items-center justify-center min-h-[50vh]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.src}
            alt={current.alt}
            className="max-w-[90vw] max-h-[90vh] object-contain"
          />

          {images.length > 1 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={goToPrev}
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition"
              >
                <ArrowLeft size={24} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={goToNext}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition"
              >
                <ArrowRight size={24} />
              </Button>
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-white/70 text-sm">
                {currentIndex + 1} / {images.length}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
