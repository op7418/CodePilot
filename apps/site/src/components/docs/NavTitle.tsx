import { BrandLogo } from '@/components/BrandLogo';

export function NavTitle() {
  return (
    <span className="flex items-center gap-2.5">
      <BrandLogo className="h-6 w-6" />
      <span className="text-[15px] font-bold">CodePilot</span>
    </span>
  );
}
