import type { MetadataRoute } from 'next';
import { siteConfig } from '@/lib/site.config';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CodePilot',
    short_name: 'CodePilot',
    description: siteConfig.description,
    start_url: '/',
    display: 'browser',
    background_color: '#ffffff',
    theme_color: '#171717',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
