"use client";

import { useState, useCallback, useSyncExternalStore } from "react";
import { type Icon, Gear, Code, UserCircle, Plug, ChartBar } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { GeneralSection } from "./GeneralSection";
import { ProviderManager } from "./ProviderManager";
import { CliSettingsSection } from "./CliSettingsSection";
import { UsageStatsSection } from "./UsageStatsSection";
import { AssistantWorkspaceSection } from "./AssistantWorkspaceSection";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

type Section = "general" | "providers" | "cli" | "usage" | "assistant";

interface SidebarItem {
  id: Section;
  label: string;
  icon: Icon;
}

const sidebarItems: SidebarItem[] = [
  { id: "general", label: "General", icon: Gear },
  { id: "providers", label: "Providers", icon: Plug },
  { id: "cli", label: "Claude CLI", icon: Code },
  { id: "usage", label: "Usage", icon: ChartBar },
  { id: "assistant", label: "Assistant", icon: UserCircle },
];

function getSectionFromHash(): Section {
  if (typeof window === "undefined") return "general";
  const hash = window.location.hash.replace("#", "");
  if (sidebarItems.some((item) => item.id === hash)) {
    return hash as Section;
  }
  return "general";
}

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function SettingsLayout() {
  // useSyncExternalStore subscribes to hash changes without triggering
  // the react-hooks/set-state-in-effect lint rule.
  const hashSection = useSyncExternalStore(subscribeToHash, getSectionFromHash, () => "general" as Section);

  // Local state allows immediate UI update on click before the hash updates.
  const [overrideSection, setOverrideSection] = useState<Section | null>(null);
  const activeSection = overrideSection ?? hashSection;

  const { t } = useTranslation();

  const settingsLabelKeys: Record<string, TranslationKey> = {
    'General': 'settings.general',
    'Providers': 'settings.providers',
    'Claude CLI': 'settings.claudeCli',
    'Usage': 'settings.usage',
    'Assistant': 'settings.assistant',
  };

  const handleSectionChange = useCallback((section: Section) => {
    setOverrideSection(section);
    window.history.replaceState(null, "", `/settings#${section}`);
    // Clear override so subsequent hash changes take effect
    queueMicrotask(() => setOverrideSection(null));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('settings.description')}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-border/50 p-3">
          {sidebarItems.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              onClick={() => handleSectionChange(item.id)}
              className={cn(
                "justify-start gap-3 px-3 py-2 text-sm font-medium text-left w-full",
                activeSection === item.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              <item.icon size={16} className="shrink-0" />
              {t(settingsLabelKeys[item.label])}
            </Button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeSection === "general" && <GeneralSection />}
          {activeSection === "providers" && <ProviderManager />}
          {activeSection === "cli" && <CliSettingsSection />}
          {activeSection === "usage" && <UsageStatsSection />}
          {activeSection === "assistant" && <AssistantWorkspaceSection />}
        </div>
      </div>
    </div>
  );
}
