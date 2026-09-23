import { ExternalLink } from 'lucide-react';
import { siteConfig } from '@/lib/site.config';
import { normalizeReleases, releaseSummary } from '@/lib/releases';
import type { MarketingContent } from '../../../content/marketing/en';
import { ReleaseCard } from './ReleaseCard';
import { ReleaseMarkdown } from './ReleaseMarkdown';

async function getRecentReleases() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${siteConfig.repo.owner}/${siteConfig.repo.name}/releases?per_page=10`,
      { next: { revalidate: 1800 }, signal: AbortSignal.timeout(5000) },
    );
    return res.ok ? normalizeReleases(await res.json()) : [];
  } catch { return []; }
}

export async function ReleasesSection({ content, locale }: { content: MarketingContent['releases']; locale: string }) {
  const releases = await getRecentReleases();
  const formatter = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[800px] px-6">
        <h2 className="max-w-2xl text-2xl font-bold leading-snug md:text-3xl">
          <span className="text-foreground">{content.title}</span>{' '}
          <span className="text-muted-foreground">{content.titleLight}</span>
        </h2>
        {releases.length ? <div className="mt-10 divide-y divide-border border border-border">
          {releases.map(release => <ReleaseCard
            key={release.tag}
            tag={release.tag}
            name={release.name}
            date={release.date}
            dateLabel={release.date ? formatter.format(new Date(release.date)) : null}
            url={release.url}
            summary={releaseSummary(release.body) || content.emptyBody}
            labels={content}
          >
            <ReleaseMarkdown body={release.body || content.emptyBody} />
          </ReleaseCard>)}
        </div> : <p className="mt-8 border border-border p-6 text-base text-muted-foreground">{content.unavailable}</p>}
        <div className="mt-8">
          <a href={siteConfig.repo.releases} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            {content.viewAll}<ExternalLink className="size-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
