'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import Image from 'next/image';
import type { MarketingContent } from '../../../content/marketing/en';

type Hero = MarketingContent['hero'];
type SlideMotion = { direction: number; reducedMotion: boolean };

const imageSizes = '(max-width: 640px) calc(100vw - 96px), (max-width: 1120px) calc(100vw - 192px), 928px';
const slideVariants = {
  enter: ({ direction, reducedMotion }: SlideMotion) => ({ x: reducedMotion ? 0 : `${direction * 100}%` }),
  center: { x: 0 },
  exit: ({ direction, reducedMotion }: SlideMotion) => ({ x: reducedMotion ? 0 : `${direction * -100}%` }),
};

function continuousRect(width: number, height: number, extent: number) {
  const r = Math.min(extent, width / 2, height / 2);
  // Mirrored cubic pairs: collinear controls give zero curvature at each straight edge.
  // The diagonal joins share a tangent and curvature, avoiding a circular-arc seam.
  return `M ${r} 0 H ${width - r}
    C ${width - r * .5} 0 ${width - r * .28} 0 ${width - r * .14} ${r * .14}
    C ${width} ${r * .28} ${width} ${r * .5} ${width} ${r}
    V ${height - r}
    C ${width} ${height - r * .5} ${width} ${height - r * .28} ${width - r * .14} ${height - r * .14}
    C ${width - r * .28} ${height} ${width - r * .5} ${height} ${width - r} ${height}
    H ${r}
    C ${r * .5} ${height} ${r * .28} ${height} ${r * .14} ${height - r * .14}
    C 0 ${height - r * .28} 0 ${height - r * .5} 0 ${height - r}
    V ${r}
    C 0 ${r * .5} 0 ${r * .28} ${r * .14} ${r * .14}
    C ${r * .28} 0 ${r * .5} 0 ${r} 0 Z`.replace(/\s+/g, ' ');
}

function useContinuousCorners() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const extent = Number.parseFloat(getComputedStyle(element).getPropertyValue('--corner-extent'));
      element.style.clipPath = `path('${continuousRect(width, height, extent)}')`;
      element.dataset.cornersReady = 'true';
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function subscribeReducedMotion(onChange: () => void) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  preference.addEventListener('change', onChange);
  return () => preference.removeEventListener('change', onChange);
}

function ScreenshotImage({ item, priority = false }: { item: Hero['screenshots'][number]; priority?: boolean }) {
  return <Image src={item.src} alt={item.alt} width={2560} height={1720} sizes={imageSizes} quality={90} className="aspect-[64/43] w-full object-contain" priority={priority} loading={priority ? undefined : 'eager'} />;
}

function Slide({ item, index, count, animation }: { item: Hero['screenshots'][number]; index: number; count: number; animation: SlideMotion }) {
  const isPresent = useIsPresent();
  return (
    <motion.figure
      className="absolute inset-0 bg-card"
      custom={animation}
      variants={slideVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: animation.reducedMotion ? 0 : 0.6, ease: [0.22, 1, 0.36, 1] }}
      role="group"
      aria-roledescription="slide"
      aria-label={`${index + 1} / ${count}`}
      aria-hidden={!isPresent}
      data-active={isPresent}
    >
      <ScreenshotImage item={item} priority={index === 0} />
    </motion.figure>
  );
}

export function ScreenshotCarousel({ items, labels }: { items: Hero['screenshots']; labels: Hero['carousel'] }) {
  const stageRef = useContinuousCorners();
  const frameRef = useContinuousCorners();
  const [{ index: activeIndex, direction }, setSlide] = useState({ index: 0, direction: 1 });
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touching, setTouching] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const dots = useRef<(HTMLButtonElement | null)[]>([]);
  const currentIndex = activeIndex % Math.max(1, items.length);
  const paused = hovered || focused || touching;

  useEffect(() => {
    if (items.length < 2 || paused) return;
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      clearTimeout(timer);
      if (!document.hidden && !motionPreference.matches) {
        timer = setTimeout(() => setSlide(slide => ({ index: (slide.index + 1) % items.length, direction: 1 })), 5000);
      }
    }
    schedule();
    document.addEventListener('visibilitychange', schedule);
    motionPreference.addEventListener('change', schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
      motionPreference.removeEventListener('change', schedule);
    };
  }, [activeIndex, items.length, paused]);

  if (!items.length) return null;

  function select(index: number, focus = false) {
    const next = (index + items.length) % items.length;
    if (next !== currentIndex) setSlide({ index: next, direction: index > currentIndex ? 1 : -1 });
    if (focus) dots.current[next]?.focus();
  }

  return (
    <div className="screenshot-stage-shadow">
      <div
        ref={stageRef}
        className="screenshot-stage continuous-corners relative overflow-hidden px-4 pt-4 sm:px-10 sm:pt-10 md:px-14 md:pt-14"
        role="region"
        aria-roledescription="carousel"
        aria-label={labels.label}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          select(currentIndex + (event.key === 'ArrowRight' ? 1 : -1), true);
        }}
        onTouchStart={event => {
          setTouching(true);
          const touch = event.touches[0];
          touchStart.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={event => {
          setTouching(false);
          if (!touchStart.current) return;
          const dx = event.changedTouches[0].clientX - touchStart.current.x;
          const dy = event.changedTouches[0].clientY - touchStart.current.y;
          touchStart.current = null;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) select(currentIndex + (dx < 0 ? 1 : -1));
        }}
        onTouchCancel={() => { touchStart.current = null; setTouching(false); }}
      >
        <div className="screenshot-window-shadow">
        <div ref={frameRef} className="screenshot-window continuous-corners relative aspect-[64/43] overflow-hidden bg-card" data-screenshot-frame>
          <AnimatePresence initial={false} custom={{ direction, reducedMotion }}>
            <Slide key={items[currentIndex].src} item={items[currentIndex]} index={currentIndex} count={items.length} animation={{ direction, reducedMotion }} />
          </AnimatePresence>
        </div>
        </div>
        {/* Keep every optimized screenshot warm while AnimatePresence mounts only the current slide. */}
        <div hidden aria-hidden="true">{items.map(item => <ScreenshotImage key={item.src} item={item} />)}</div>
        <p className="sr-only" aria-live={paused ? 'polite' : 'off'} aria-atomic="true">{items[currentIndex].alt}. {items[currentIndex].caption}</p>
        <div className="relative flex h-12 items-center justify-center sm:h-16">
          {items.length > 1 && items.map((item, index) => (
            <button
              key={item.src}
              ref={element => { dots.current[index] = element; }}
              type="button"
              className="flex size-8 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
              aria-label={item.alt}
              aria-current={index === currentIndex ? 'true' : undefined}
              onClick={() => select(index)}
            >
              <span className={`size-1.5 rounded-full transition-colors ${index === currentIndex ? 'bg-neutral-900' : 'bg-neutral-900/30'}`} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
