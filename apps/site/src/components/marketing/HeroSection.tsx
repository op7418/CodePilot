import { BrandLogo } from '@/components/BrandLogo';
import type { MarketingContent } from '../../../content/marketing/en';
import { ScreenshotCarousel } from './ScreenshotCarousel';
import { TypewriterWords } from './TypewriterWords';
import { buttonVariants } from '@/components/ui/button-variants';
import { cn } from '@/lib/utils';

export function HeroSection({
  content,
  locale,
}: {
  content: MarketingContent['hero'];
  locale: string;
}) {
  return (
    <section className="relative mx-4 overflow-hidden sm:mx-6 lg:mx-10">
      {/* Neutral surface keeps the product screenshots in focus. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-muted" />

      <div className="relative">
        {/* Logo + Title + CTA */}
        <div className="mx-auto max-w-[800px] px-6 pt-8 text-center md:pt-10 lg:pt-12">
          {content.notice ? (
            <a
              href={content.notice.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group mx-auto mb-7 block max-w-3xl rounded-lg border border-border bg-muted p-px text-left shadow-sm transition-transform hover:-translate-y-0.5"
            >
              <div className="rounded-[7px] bg-background/95 px-5 py-4 backdrop-blur">
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm font-semibold text-foreground sm:justify-start">
                  <span aria-hidden="true">🚧</span>
                  <span>{content.notice.label}</span>
                  <span className="text-primary transition-colors group-hover:text-foreground">
                    {content.notice.cta}
                  </span>
                </div>
                <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground">EN</span>{' '}
                  {content.notice.english}
                </p>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground">中文</span>{' '}
                  {content.notice.chinese}
                </p>
              </div>
            </a>
          ) : null}

          <BrandLogo size={96} priority className="mx-auto h-20 w-20 md:h-24 md:w-24" />

          <h1 className="mt-5 text-[28px] font-semibold leading-snug text-foreground md:text-[34px] lg:text-[40px]">
            {content.tagline}{' '}
            <TypewriterWords locale={locale} />
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
            {content.description}
          </p>

          <div className="mt-7 flex items-center justify-center">
            <a href="https://github.com/op7418/CodePilot/releases/latest" target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), 'rainbow-glow h-14 rounded-full px-14 text-lg')}>
              {content.cta}
            </a>
          </div>
        </div>

        <div className="relative mx-auto mt-12 max-w-[1120px] px-4 pb-16 md:mt-14 md:px-10 md:pb-24">
          <ScreenshotCarousel items={content.screenshots} labels={content.carousel} />
        </div>
      </div>
    </section>
  );
}
