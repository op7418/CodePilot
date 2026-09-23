export interface SiteRelease {
  tag: string;
  name: string;
  date: string | null;
  url: string;
  body: string;
}

/** Public stable releases only; an empty body is still a real release. */
export function normalizeReleases(data: unknown): SiteRelease[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item): SiteRelease[] => {
    if (!item || typeof item !== 'object' || item.draft || item.prerelease) return [];
    if (typeof item.tag_name !== 'string' || !item.tag_name.trim() || typeof item.html_url !== 'string') return [];
    try {
      const url = new URL(item.html_url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/op7418/CodePilot/releases/')) return [];
    } catch { return []; }
    const date = typeof item.published_at === 'string' && Number.isFinite(Date.parse(item.published_at)) ? item.published_at : null;
    return [{
      tag: item.tag_name,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : item.tag_name,
      date,
      url: item.html_url,
      body: typeof item.body === 'string' ? item.body : '',
    }];
  }).slice(0, 4);
}

/** A deliberately short plain-text teaser; the dialog retains the full Markdown. */
export function releaseSummary(body: string): string {
  return body
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^[\s>*+-]+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
