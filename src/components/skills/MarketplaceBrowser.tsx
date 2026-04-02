"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { MagnifyingGlass, SpinnerGap, Storefront } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { MarketplaceSkillCard } from "./MarketplaceSkillCard";
import { MarketplaceSkillDetail } from "./MarketplaceSkillDetail";
import type { MarketplaceSkill } from "@/types";

interface MarketplaceBrowserProps {
  onInstalled: () => void;
}

export function MarketplaceBrowser({ onInstalled }: MarketplaceBrowserProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<MarketplaceSkill[]>([]);
  const [selected, setSelected] = useState<MarketplaceSkill | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const doSearch = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("limit", "20");
      const res = await fetch(`/api/skills/marketplace/search?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResults(data.skills || []);
    } catch (err) {
      setError((err as Error).message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load — fetch popular skills
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
    // Refresh results to update installed status
    doSearch(search);
    onInstalled();
  }, [search, doSearch, onInstalled]);

  return (
    <div className="flex flex-1 min-h-0">
      {/* Left: search + results */}
      <div className="w-64 shrink-0 flex flex-col overflow-hidden pl-4">
        <div className="px-2 pt-4 pb-2">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              placeholder={t('skills.marketplaceSearch')}
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
                <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
              </div>
            )}
            {error && (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground px-3">
                <p className="text-xs text-center text-status-error-foreground">{t('skills.marketplaceError')}</p>
                <p className="text-[10px] text-center">{error}</p>
              </div>
            )}
            {!loading && !error && results.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                <Storefront size={32} className="opacity-40" />
                <p className="text-xs">{t('skills.searchNoResults')}</p>
              </div>
            )}
            {results.map((skill) => (
              <MarketplaceSkillCard
                key={skill.id}
                skill={skill}
                selected={selected?.id === skill.id}
                onSelect={() => setSelected(skill)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="shrink-0 w-px bg-border/50" />

      {/* Right: detail */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {selected ? (
          <MarketplaceSkillDetail
            key={selected.id}
            skill={selected}
            onInstallComplete={handleInstallComplete}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <Storefront size={48} className="opacity-30" />
            <div className="text-center">
              <p className="text-sm font-medium">{t('skills.marketplaceHint')}</p>
              <p className="text-xs">{t('skills.marketplaceHintDesc')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
