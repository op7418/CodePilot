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
import { GeneralSection } from "./GeneralSection";
import { ProviderManager } from "./ProviderManager";
import { CliSettingsSection } from "./CliSettingsSection";

type Section = "general" | "providers" | "cli";

interface SidebarItem {
  id: Section;
  label: string;
  icon: IconSvgElement;
}

const sidebarItems: SidebarItem[] = [
  { id: "general", label: "General", icon: Settings02Icon },
  { id: "providers", label: "Providers", icon: Plug01Icon },
  { id: "cli", label: "Claude CLI", icon: CodeIcon },
];

function getInitialSection(): Section {
  if (typeof window !== "undefined") {
    const hash = window.location.hash.replace("#", "");
    if (sidebarItems.some((item) => item.id === hash)) {
      return hash as Section;
    }
  }
  return "general";
}

export function SettingsLayout() {
  const [activeSection, setActiveSection] = useState<Section>(getInitialSection);

  // Sync hash on mount and on popstate
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace("#", "");
      if (sidebarItems.some((item) => item.id === hash)) {
        setActiveSection(hash as Section);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleSectionChange = (section: Section) => {
    setActiveSection(section);
    window.history.replaceState(null, "", `/settings#${section}`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage CodePilot and Claude CLI settings
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
              {item.label}
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
