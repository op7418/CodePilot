"use client";

import { PluginMarketplaceBrowser } from "@/components/plugins/marketplace/PluginMarketplaceBrowser";
import { useTranslation } from "@/hooks/useTranslation";

export default function PluginsMarketPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden p-6 flex flex-col min-h-0">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-lg font-semibold">{t("pluginMarket.title")}</h3>
          <span className="text-xs text-muted-foreground">{t("pluginMarket.subtitle")}</span>
        </div>
        <PluginMarketplaceBrowser />
      </div>
    </div>
  );
}
