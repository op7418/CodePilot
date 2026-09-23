'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BrandLogo } from '@/components/BrandLogo';
import { Github } from 'lucide-react';

export function ScrollNav({ locale }: { locale: string }) {
  const [visible, setVisible] = useState(false);
  const [stars, setStars] = useState<string | null>(null);
  const prefix = locale === 'en' ? '' : `/${locale}`;

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 80);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    fetch('https://api.github.com/repos/op7418/CodePilot', { next: { revalidate: 3600 } } as RequestInit)
      .then((r) => r.json())
      .then((d) => {
        if (d.stargazers_count != null) {
          const count = Number(d.stargazers_count);
          setStars(count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
        }
      })
      .catch(() => {});
  }, []);

  return (
    <nav
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        visible
          ? 'translate-y-0'
          : '-translate-y-full'
      }`}
      style={{
        background: 'linear-gradient(to bottom, var(--color-background) 0%, transparent 100%)',
      }}
    >
      <div className="mx-auto flex h-14 items-center justify-between gap-3 px-4 sm:px-6 lg:px-10">
        {/* Left: Logo + Name */}
        <Link
          href={`${prefix}/`}
          className="flex shrink-0 items-center gap-2"
        >
          <BrandLogo className="h-7 w-7" />
          <span className="text-[15px] font-bold text-foreground">
            CodePilot
          </span>
        </Link>

        {/* Right: Links + Download pill */}
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap sm:gap-5">
          <Link
            href={`${prefix}/docs`}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {locale === 'zh' ? '文档' : 'Docs'}
          </Link>

          {/* Language switcher */}
          <Link
            href={locale === 'en' ? '/zh' : '/en'}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {locale === 'en' ? '中文' : 'EN'}
          </Link>

          {/* GitHub + stars */}
          <a
            href="https://github.com/op7418/CodePilot"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Github className="h-4 w-4" />
            {stars && <span className="hidden sm:inline">{stars}</span>}
          </a>

          {/* Download pill button */}
          <Link
            href={`${prefix}/docs/installation`}
            className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-80"
          >
            {locale === 'zh' ? '下载' : 'Download'}
          </Link>
        </div>
      </div>
    </nav>
  );
}
