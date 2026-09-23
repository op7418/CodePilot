import Image from 'next/image';
import appIcon from '../../public/logo.png';

// The current macOS app icon includes its rounded plate and optical padding.
// Static imports give it a content hash, avoiding stale /logo.png image caches.
export function BrandLogo({ className, size = 32, priority = false }: {
  className?: string;
  size?: number;
  priority?: boolean;
}) {
  return <Image src={appIcon} alt="CodePilot" width={size} height={size} sizes={`${size}px`} className={className} priority={priority} />;
}
