'use client';

import { useId, useState } from 'react';
import { Plus, Minus } from 'lucide-react';
import type { MarketingContent } from '../../../content/marketing/en';

function FAQItem({ item, isOpen, onToggle, isLast }: {
  item: MarketingContent['faq']['items'][number];
  isOpen: boolean;
  onToggle: () => void;
  isLast: boolean;
}) {
  const id = useId();
  return (
    <div className={!isLast ? 'border-b border-border' : ''}>
      <button
        type="button"
        id={`${id}-question`}
        aria-expanded={isOpen}
        aria-controls={`${id}-answer`}
        onClick={onToggle}
        className="flex w-full items-center justify-between py-6 text-left"
      >
        <span className="text-base font-semibold text-foreground">
          {item.q}
        </span>
        {isOpen ? (
          <Minus className="h-5 w-5 shrink-0 text-muted-foreground" />
        ) : (
          <Plus className="h-5 w-5 shrink-0 text-muted-foreground" />
        )}
      </button>
      <div
        id={`${id}-answer`}
        role="region"
        aria-labelledby={`${id}-question`}
        aria-hidden={!isOpen}
        inert={!isOpen}
        className="grid transition-[grid-template-rows] duration-200"
        style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <p className="pb-6 text-base font-semibold leading-relaxed text-muted-foreground">
            {item.a}
            {item.link && <>{' '}<a href={item.link.href} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:opacity-70">{item.link.label}</a></>}
          </p>
        </div>
      </div>
    </div>
  );
}

export function FAQSection({
  content,
}: {
  content: MarketingContent['faq'];
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[800px] px-6">
        {/* Two-tone title */}
        <h2 className="max-w-2xl text-2xl font-bold leading-snug md:text-3xl">
          <span className="text-foreground">{content.title}</span>{' '}
          <span className="text-muted-foreground">{content.titleLight}</span>
        </h2>

        <div className="mt-10 border border-border px-6">
          {content.items.map((item, i) => (
            <FAQItem
              key={i}
              item={item}
              isOpen={openIndex === i}
              isLast={i === content.items.length - 1}
              onToggle={() => setOpenIndex(openIndex === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
