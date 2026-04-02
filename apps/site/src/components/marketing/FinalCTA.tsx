import Link from 'next/link';
import type { MarketingContent } from '../../../content/marketing/en';
import { RainbowButton } from '@/components/ui/rainbow-button';

export function FinalCTA({
  content,
  locale,
}: {
  content: MarketingContent['cta'];
  locale: string;
}) {
  const prefix = locale === 'en' ? '' : `/${locale}`;

  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[800px] px-6">
        <h2 className="max-w-2xl text-2xl font-bold leading-snug md:text-3xl">
          <span className="text-foreground">{content.title}</span>{' '}
          <span className="text-muted-foreground">{content.description}</span>
        </h2>

        <div className="mt-8 flex items-center gap-4">
          <a href="https://github.com/op7418/CodePilot/releases/latest" target="_blank" rel="noopener noreferrer">
            <RainbowButton className="h-12 rounded-full px-10 text-base">
              {content.primary}
            </RainbowButton>
          </a>
          <Link
            href={`${prefix}/docs`}
            className="text-base font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            {content.secondary}
          </Link>
        </div>
      </div>
    </section>
  );
}
