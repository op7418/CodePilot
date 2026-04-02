import type { Metadata } from 'next';
import { getMarketingContent } from '../../../../content/marketing';
import { ScrollNav } from '@/components/marketing/ScrollNav';
import { HeroSection } from '@/components/marketing/HeroSection';
import { FeaturesSection } from '@/components/marketing/FeaturesSection';
import { IntegrationsSection } from '@/components/marketing/IntegrationsSection';
import { FAQSection } from '@/components/marketing/FAQAccordion';
import { ReleasesSection } from '@/components/marketing/ReleasesSection';
import { FinalCTA } from '@/components/marketing/FinalCTA';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { siteConfig } from '@/lib/site.config';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  const isZh = lang === 'zh';
  return {
    title: isZh
      ? 'CodePilot — Claude Code 的桌面工作空间'
      : 'CodePilot — Desktop Workspace for Claude Code',
    description: isZh
      ? '将对话、Provider、MCP、Skills 和项目上下文整合到一个桌面界面中。'
      : siteConfig.description,
    alternates: {
      canonical: isZh ? `${siteConfig.url}/zh` : siteConfig.url,
      languages: {
        en: siteConfig.url,
        zh: `${siteConfig.url}/zh`,
      },
    },
  };
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const content = getMarketingContent(lang);

  return (
    <main>
      <ScrollNav locale={lang} />
      <HeroSection content={content.hero} locale={lang} />
      <FeaturesSection content={content.features} />
      <IntegrationsSection content={content.openSource} />
      <FAQSection content={content.faq} />
      <ReleasesSection content={content.releases} />
      <FinalCTA content={content.cta} locale={lang} />
      <SiteFooter content={content.footer} />
    </main>
  );
}
