import { ExternalLink } from 'lucide-react';
import { siteConfig } from '@/lib/site.config';

interface Release {
  tag_name: string;
  name: string;
  published_at: string;
  body: string;
  html_url: string;
}

interface ParsedRelease {
  version: string;
  date: string;
  url: string;
  sections: { label: string; items: string[] }[];
}

function parseReleaseBody(release: Release): ParsedRelease {
  const body = release.body || '';
  const lines = body.split('\n');

  // Extract categorized sections (### headers with bullet lists)
  const sections: { label: string; items: string[] }[] = [];
  let currentSection: { label: string; items: string[] } | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      const rawLabel = headerMatch[1].trim();
      // Only keep content sections, skip download/install/requirements/checksums
      const skipPatterns = /download|安装|install|要求|require|checksum|sha-?256/i;
      if (rawLabel && !skipPatterns.test(rawLabel)) {
        currentSection = { label: rawLabel, items: [] };
        sections.push(currentSection);
      } else {
        currentSection = null;
      }
      continue;
    }
    // Also stop at ## headers (new top-level sections like "## 下载地址")
    if (line.match(/^##\s+/) && currentSection) {
      currentSection = null;
      continue;
    }
    if (currentSection && line.match(/^-\s+/)) {
      // Strip markdown bold/links but keep text
      const item = line
        .replace(/^-\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1') // strip bold markers
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links, keep text
        .trim();
      if (item) currentSection.items.push(item);
    }
  }

  return {
    version: release.tag_name.replace(/^v/, ''),
    date: new Date(release.published_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }),
    url: release.html_url,
    sections: sections.filter(s => s.items.length > 0),
  };
}

async function getRecentReleases(): Promise<ParsedRelease[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${siteConfig.repo.owner}/${siteConfig.repo.name}/releases?per_page=5`,
      { next: { revalidate: 1800 } }
    );
    if (!res.ok) return [];
    const releases = (await res.json()) as Release[];
    return releases
      .map(parseReleaseBody)
      .filter(r => r.sections.length > 0); // Only show releases that have meaningful content
  } catch {
    return [];
  }
}

export async function ReleasesSection({
  content,
}: {
  content: { title: string; titleLight: string; viewAll: string };
}) {
  const releases = await getRecentReleases();

  if (releases.length === 0) return null;

  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[800px] px-6">
        {/* Two-tone title — matches other sections */}
        <h2 className="max-w-2xl text-2xl font-bold leading-snug md:text-3xl">
          <span className="text-foreground">{content.title}</span>{' '}
          <span className="text-muted-foreground">{content.titleLight}</span>
        </h2>

        {/* Release entries */}
        <div className="mt-14 space-y-12">
          {releases.map((release) => (
            <article key={release.version}>
              {/* Version + date header */}
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-foreground">
                  v{release.version}
                </span>
                <span className="text-sm text-muted-foreground">
                  {release.date}
                </span>
              </div>

              {/* Sections */}
              <div className="mt-4 space-y-4">
                {release.sections.map((section) => (
                  <div key={section.label}>
                    <h4 className="text-[15px] font-semibold text-foreground">
                      {section.label}
                    </h4>
                    <ul className="mt-2 space-y-1.5">
                      {section.items.map((item, i) => (
                        <li
                          key={i}
                          className="text-[15px] leading-relaxed text-muted-foreground pl-4 relative before:absolute before:left-0 before:top-[0.6em] before:h-1 before:w-1 before:rounded-full before:bg-muted-foreground/30"
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {/* Separator */}
              <div className="mt-8 border-t border-border/40" />
            </article>
          ))}
        </div>

        {/* View all link */}
        <div className="mt-8">
          <a
            href={siteConfig.repo.releases}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {content.viewAll}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </section>
  );
}
