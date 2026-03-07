"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Search01Icon,
  Loading02Icon,
  Plug01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import { PluginMarketplaceCard } from "./PluginMarketplaceCard";
import { PluginMarketplaceDetail } from "./PluginMarketplaceDetail";
import { cn } from "@/lib/utils";
import type { MarketplacePlugin } from "@/types";


export function PluginMarketplaceBrowser() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"marketplace" | "installed">("marketplace");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<MarketplacePlugin[]>([]);
  const [selected, setSelected] = useState<MarketplacePlugin | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const doSearch = useCallback(
    async (query: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (query) params.set("q", query);
        const res = await fetch(`/api/plugins/marketplace/browse?${params}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setResults(data.plugins || []);
      } catch (err) {
        setError((err as Error).message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Initial load
  useEffect(() => {
    doSearch("");
  }, [doSearch]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(search);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, doSearch]);

  const handleInstallComplete = useCallback(() => {
    doSearch(search);
  }, [search, doSearch]);

  const displayResults = useMemo(
    () => tab === "installed" ? results.filter((p) => p.isInstalled) : results,
    [tab, results]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Tab switcher */}
      <div className="flex items-center gap-1 mb-3">
        <button
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
            tab === "marketplace"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          )}
          onClick={() => setTab("marketplace")}
        >
          {t("pluginMarket.marketplace")}
        </button>
        <button
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
            tab === "installed"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          )}
          onClick={() => setTab("installed")}
        >
          {t("pluginMarket.installedTab")}
        </button>
      </div>

      {/* Main content */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: search + results */}
        <div className="w-64 shrink-0 flex flex-col border border-border rounded-lg overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
              />
              <Input
                placeholder={t("pluginMarket.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 h-8 text-sm"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-1">
              {loading && results.length === 0 && (
                <div className="flex items-center justify-center py-8">
                  <HugeiconsIcon
                    icon={Loading02Icon}
                    className="h-5 w-5 animate-spin text-muted-foreground"
                  />
                </div>
              )}
              {error && (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground px-3">
                  <p className="text-xs text-center text-red-500">
                    {t("pluginMarket.error")}
                  </p>
                  <p className="text-[10px] text-center">{error}</p>
                </div>
              )}
              {!loading && !error && displayResults.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                  <HugeiconsIcon
                    icon={Plug01Icon}
                    className="h-8 w-8 opacity-40"
                  />
                  <p className="text-xs">
                    {tab === "installed"
                      ? t("pluginMarket.noInstalledPlugins")
                      : search
                        ? t("pluginMarket.noResults")
                        : t("pluginMarket.noPlugins")}
                  </p>
                  {tab === "installed" ? (
                    <p className="text-[10px] text-center px-4">
                      {t("pluginMarket.noInstalledPluginsDesc")}
                    </p>
                  ) : !search ? (
                    <p className="text-[10px] text-center px-4">
                      {t("pluginMarket.noPluginsDesc")}
                    </p>
                  ) : null}
                </div>
              )}
              {displayResults.map((plugin) => (
                <PluginMarketplaceCard
                  key={`${plugin.marketplace}:${plugin.name}`}
                  plugin={plugin}
                  selected={
                    selected?.name === plugin.name &&
                    selected?.marketplace === plugin.marketplace
                  }
                  onSelect={() => setSelected(plugin)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Right: detail */}
        <div className="flex-1 min-w-0 border border-border rounded-lg overflow-hidden">
          {selected ? (
            <PluginMarketplaceDetail
              key={`${selected.marketplace}:${selected.name}`}
              plugin={selected}
              onInstallComplete={handleInstallComplete}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <HugeiconsIcon
                icon={Plug01Icon}
                className="h-12 w-12 opacity-30"
              />
              <div className="text-center">
                <p className="text-sm font-medium">
                  {t("pluginMarket.browseHint")}
                </p>
                <p className="text-xs">
                  {t("pluginMarket.browseHintDesc")}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
