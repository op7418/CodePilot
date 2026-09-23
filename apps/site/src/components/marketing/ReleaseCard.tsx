'use client';

import type { ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowUpRight, ExternalLink, X } from 'lucide-react';
import type { MarketingContent } from '../../../content/marketing/en';

export function ReleaseCard({ tag, name, date, dateLabel, url, summary, labels, children }: {
  tag: string;
  name: string;
  date: string | null;
  dateLabel: string | null;
  url: string;
  summary: string;
  labels: MarketingContent['releases'];
  children: ReactNode;
}) {
  return (
    <article className="min-w-0">
      <Dialog.Root>
        <Dialog.Trigger className="group flex h-36 w-full cursor-pointer items-center gap-5 overflow-hidden rounded-none px-6 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground sm:h-32 sm:gap-8" aria-label={`${tag} · ${labels.readMore}`}>
          <span className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
          <span className="flex shrink-0 items-baseline gap-3 sm:w-28 sm:flex-col sm:gap-1.5">
            <span className="text-lg font-semibold text-foreground">{tag}</span>
            {date && <time dateTime={date} className="text-sm text-muted-foreground">{dateLabel}</time>}
          </span>
          <span className="line-clamp-2 min-w-0 text-sm leading-relaxed text-muted-foreground sm:text-base">{summary}</span>
          </span>
          <ArrowUpRight className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(85dvh,900px)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl" aria-describedby={undefined}>
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div className="min-w-0">
                <Dialog.Title className="break-words text-xl font-semibold">{name}</Dialog.Title>
                {date && <p className="mt-1 text-sm text-muted-foreground"><time dateTime={date}>{dateLabel}</time></p>}
              </div>
              <Dialog.Close aria-label={labels.close} className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"><X className="size-5" /></Dialog.Close>
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-6 py-6 md:px-8" data-release-body>{children}</div>
            <div className="shrink-0 border-t border-border px-6 py-4">
              <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline">{labels.source}<ExternalLink className="size-4" /></a>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </article>
  );
}
