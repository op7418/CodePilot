import { Star } from 'lucide-react';
import { CapabilityIcon } from './IconMap';
import type { MarketingContent } from '../../../content/marketing/en';

async function getStarCount(): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/repos/op7418/CodePilot', {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const count = data.stargazers_count;
    if (!Number.isSafeInteger(count) || count < 0) return null;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return String(count);
  } catch {
    return null;
  }
}

export async function IntegrationsSection({
  content,
}: {
  content: MarketingContent['openSource'];
  locale?: string;
}) {
  const stars = await getStarCount();

  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[800px] px-6">
        {/* Two-tone title */}
        <h2 className="max-w-2xl text-2xl font-bold leading-snug md:text-3xl">
          <span className="text-foreground">{content.title}</span>{' '}
          <span className="text-muted-foreground">{content.titleLight}</span>
        </h2>

        {/* GitHub Star button */}
        <div className="mt-8">
          <a
            href={content.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground shadow-sm transition-shadow hover:shadow-md"
          >
            <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            {content.githubCta}
            {stars !== null && <span className="ml-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-bold text-muted-foreground">
              {stars}
            </span>}
          </a>
        </div>

        {/* Highlight cards */}
        <div className="mt-14 grid gap-x-12 gap-y-10 sm:grid-cols-3">
          {content.highlights.map((item) => (
            <div key={item.title}>
              <CapabilityIcon
                name={item.icon}
                className="h-7 w-7 text-foreground"
              />
              <h3 className="mt-4 text-lg font-semibold text-foreground">
                {item.title}
              </h3>
              <p className="mt-2 text-[17px] font-semibold leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
