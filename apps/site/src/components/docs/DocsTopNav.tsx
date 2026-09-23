'use client';

import { BrandLogo } from '@/components/BrandLogo';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { Globe, Github, Search } from 'lucide-react';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { siteConfig } from '@/lib/site.config';

export function DocsTopNav({ locale }: { locale: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { setOpenSearch } = useSearchContext();

  const handleLocaleChange = (newLocale: string | null) => {
    if (!newLocale) return;
    let newPath: string;
    if (locale === 'en') {
      newPath = `/${newLocale}${pathname}`;
    } else {
      newPath = newLocale === 'en'
        ? pathname.replace(`/${locale}`, '') || '/'
        : pathname.replace(`/${locale}`, `/${newLocale}`);
    }
    router.push(newPath);
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center justify-between px-6 lg:px-10">
        {/* Left: Logo + Product name */}
        <Link href={`/${locale === 'en' ? '' : locale}`} className="flex items-center gap-3">
          <BrandLogo className="h-[30px] w-[30px]" />
          <span className="text-lg font-bold">CodePilot</span>
        </Link>

        {/* Right: Search + GitHub + Language switcher */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOpenSearch(true)}
            className="inline-flex items-center rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Search className="h-[18px] w-[18px]" />
          </button>

          <a
            href={siteConfig.repo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Github className="h-[18px] w-[18px]" />
          </a>

          <Select defaultValue={locale} onValueChange={handleLocaleChange}>
            <SelectTrigger size="sm" className="ml-1 h-8 gap-1.5 rounded-md border-border bg-transparent px-2.5 text-sm">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <SelectValue>
                {locale === 'zh' ? '简体中文' : 'English'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh">简体中文</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </header>
  );
}
