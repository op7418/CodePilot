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
  const content = getMarketingContent(lang);
  const socialImage = `/screenshots/${isZh ? 'zh' : 'en'}/chat-window.webp`;
  const title = isZh ? 'CodePilot — 你的 AI 桌面工作台' : 'CodePilot — Your Desktop AI Workspace';
  return {
    title: { absolute: title },
    description: content.hero.description,
    openGraph: {
      title,
      description: content.hero.description,
      locale: isZh ? 'zh_CN' : 'en_US',
      url: isZh ? `${siteConfig.url}/zh` : siteConfig.url,
      images: [{ url: socialImage, width: 2560, height: 1720, alt: title }],
    },
    twitter: { card: 'summary_large_image', title, description: content.hero.description, images: [socialImage] },
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
      <ReleasesSection content={content.releases} locale={lang} />
      <FinalCTA content={content.cta} locale={lang} />
      <SiteFooter content={content.footer} />
    </main>
  );
}
