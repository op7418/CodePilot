"use client";

import { useState, useCallback, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { Wifi01Icon, TelegramIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { BridgeSection } from "./BridgeSection";
import { TelegramBridgeSection } from "./TelegramBridgeSection";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

type Section = "bridge" | "telegram";

interface SidebarItem {
  id: Section;
  label: string;
  icon: IconSvgElement;
}

const sidebarItems: SidebarItem[] = [
  { id: "bridge", label: "Bridge", icon: Wifi01Icon },
  { id: "telegram", label: "Telegram", icon: TelegramIcon },
];

function getSectionFromHash(): Section {
  if (typeof window === "undefined") return "bridge";
  const hash = window.location.hash.replace("#", "");
  if (sidebarItems.some((item) => item.id === hash)) {
    return hash as Section;
  }
  return "bridge";
}

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function BridgeLayout() {
  const hashSection = useSyncExternalStore(subscribeToHash, getSectionFromHash, () => "bridge" as Section);
  const [overrideSection, setOverrideSection] = useState<Section | null>(null);
  const activeSection = overrideSection ?? hashSection;

  const { t } = useTranslation();

  const bridgeLabelKeys: Record<string, TranslationKey> = {
    'Bridge': 'bridge.title',
    'Telegram': 'bridge.telegramSettings',
  };

  const handleSectionChange = useCallback((section: Section) => {
    setOverrideSection(section);
    window.history.replaceState(null, "", `/bridge#${section}`);
    queueMicrotask(() => setOverrideSection(null));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">{t('bridge.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('bridge.description')}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-border/50 p-3">
          {sidebarItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleSectionChange(item.id)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors text-left",
                activeSection === item.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              <HugeiconsIcon icon={item.icon} className="h-4 w-4 shrink-0" />
              {t(bridgeLabelKeys[item.label])}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-auto p-6">
          {activeSection === "bridge" && <BridgeSection />}
          {activeSection === "telegram" && <TelegramBridgeSection />}
        </div>
      </div>
    </div>
  );
}
