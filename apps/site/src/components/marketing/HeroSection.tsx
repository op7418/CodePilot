import Image from 'next/image';
import type { MarketingContent } from '../../../content/marketing/en';
import { ChatDemo } from './ChatDemo';
import { TypewriterWords } from './TypewriterWords';
import { RainbowButton } from '@/components/ui/rainbow-button';
import { FlickeringGrid } from '@/components/ui/flickering-grid';

export function HeroSection({
  content,
  locale,
}: {
  content: MarketingContent['hero'];
  locale: string;
}) {
  const prefix = locale === 'en' ? '' : `/${locale}`;

  return (
    <section className="relative overflow-hidden">
      {/* Blue-gray gradient background */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-muted" />

      <div className="relative">
        {/* Logo + Title + CTA */}
        <div className="mx-auto max-w-[800px] px-6 pt-8 text-center md:pt-10 lg:pt-12">
          <Image
            src="/logo.png"
            alt="CodePilot"
            width={80}
            height={80}
            className="mx-auto h-24 w-24 md:h-28 md:w-28"
            priority
          />

          <h1 className="mt-5 text-[28px] font-semibold leading-snug text-foreground md:text-[34px] lg:text-[40px]">
            {content.tagline}{' '}
            <TypewriterWords locale={locale} />
          </h1>

          <div className="mt-7 flex items-center justify-center">
            <a href="https://github.com/op7418/CodePilot/releases/latest" target="_blank" rel="noopener noreferrer">
              <RainbowButton className="h-14 rounded-full px-14 text-lg">
                {content.cta}
              </RainbowButton>
            </a>
          </div>
        </div>

        {/* Animated chat demo with flickering grid background */}
        <div className="relative mx-auto mt-12 max-w-[1000px] px-6 md:mt-14">
          {/* FlickeringGrid — shifted down, masked with radial gradient for soft edges */}
          <div
            className="absolute -inset-x-24 -bottom-32 top-24 z-0"
            style={{
              maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
              WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
            }}
          >
            <FlickeringGrid
              className="absolute inset-0 size-full"
              squareSize={4}
              gridGap={6}
              color="#6B7280"
              maxOpacity={0.4}
              flickerChance={0.1}
            />
          </div>
          <div className="relative z-10">
            <ChatDemo />
          </div>
        </div>
      </div>
    </section>
  );
}
