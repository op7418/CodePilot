"use client";

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  Settings02Icon,
  CodeIcon,
} from "@hugeicons/core-free-icons";
import { Plug01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { GeneralSection } from "./GeneralSection";
import { ProviderManager } from "./ProviderManager";
import { CliSettingsSection } from "./CliSettingsSection";

type Section = "general" | "providers" | "cli";

interface SidebarItem {
  id: Section;
  labelKey: TranslationKey;
  icon: IconSvgElement;
}

const sidebarItems: SidebarItem[] = [
  { id: "general", labelKey: "settings.sidebarGeneral", icon: Settings02Icon },
  { id: "providers", labelKey: "settings.sidebarProviders", icon: Plug01Icon },
  { id: "cli", labelKey: "settings.sidebarCli", icon: CodeIcon },
];

export function SettingsLayout() {
  const [activeSection, setActiveSection] = useState<Section>("general");
  const { t } = useTranslation();

  // Sync hash on mount and on popstate
  useEffect(() => {
    const syncHash = () => {
      const hash = window.location.hash.replace("#", "");
      if (sidebarItems.some((item) => item.id === hash)) {
        setActiveSection(hash as Section);
      }
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  const handleSectionChange = (section: Section) => {
    setActiveSection(section);
    window.history.replaceState(null, "", `/settings#${section}`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">{t("settings.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("settings.subtitle")}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
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
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeSection === "general" && <GeneralSection />}
          {activeSection === "providers" && <ProviderManager />}
          {activeSection === "cli" && <CliSettingsSection />}
        </div>
      </div>
    </div>
  );
}
