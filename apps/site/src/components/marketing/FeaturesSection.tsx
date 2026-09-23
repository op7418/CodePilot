import { CapabilityIcon } from './IconMap';
import type { MarketingContent } from '../../../content/marketing/en';

export function FeaturesSection({
  content,
}: {
  content: MarketingContent['features'];
}) {
  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[800px] px-6">
        {/* Two-tone title: dark + light */}
        <h2 className="max-w-2xl text-2xl font-bold leading-snug md:text-3xl">
          <span className="text-foreground">{content.title}</span>{' '}
          <span className="text-muted-foreground">{content.titleLight}</span>
        </h2>

        {/* Feature cards — no border, larger description, larger icon without bg */}
        <div className="mt-14 grid gap-x-12 gap-y-10 sm:grid-cols-2">
          {content.items.map((item) => (
            <div key={item.title} className="group min-w-0">
              <CapabilityIcon
                name={item.icon}
                className="h-7 w-7 text-foreground"
              />
              <h3 className="mt-4 text-lg font-semibold text-foreground">
                {item.title}
                {item.badge && (
                  <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {item.badge}
                  </span>
                )}
              </h3>
              <p className="mt-2 max-w-[18rem] break-words text-balance text-[17px] font-semibold leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
