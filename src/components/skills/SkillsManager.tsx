"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePanel } from "@/hooks/usePanel";

import { Plus, MagnifyingGlass, Lightning, SpinnerGap } from "@/components/ui/icon";
import { SkillListItem } from "./SkillListItem";
import { SkillEditor } from "./SkillEditor";
import { CreateSkillDialog } from "./CreateSkillDialog";
import { MarketplaceBrowser } from "./MarketplaceBrowser";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import type { SkillItem } from "./SkillListItem";

type ViewTab = "local" | "marketplace";

export function SkillsManager() {
  const { workingDirectory } = usePanel();
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selected, setSelected] = useState<SkillItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [viewTab, setViewTab] = useState<ViewTab>("local");

  const fetchSkills = useCallback(async () => {
    try {
      const cwdParam = workingDirectory ? `?cwd=${encodeURIComponent(workingDirectory)}` : '';
      const res = await fetch(`/api/skills${cwdParam}`);
      if (res.ok) {
        const data = await res.json();
        setSkills((data.skills || []).filter((s: SkillItem) => s.source !== "project"));
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleCreate = useCallback(
    async (name: string, scope: "global" | "project", content: string) => {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content, scope, cwd: workingDirectory || undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create skill");
      }
      const data = await res.json();
      setSkills((prev) => [...prev, data.skill]);
      setSelected(data.skill);
    },
    [workingDirectory]
  );

  const buildSkillUrl = useCallback((skill: SkillItem) => {
    const params = new URLSearchParams();
    if (skill.source === "installed" && skill.installedSource) {
      params.set("source", skill.installedSource);
    }
    if (workingDirectory) {
      params.set("cwd", workingDirectory);
    }
    const qs = params.toString();
    return `/api/skills/${encodeURIComponent(skill.name)}${qs ? `?${qs}` : ""}`;
  }, [workingDirectory]);

  const handleSave = useCallback(
    async (skill: SkillItem, content: string) => {
      const res = await fetch(buildSkillUrl(skill), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save skill");
      }
      const data = await res.json();
      // Update in list
      setSkills((prev) =>
        prev.map((s) =>
          s.name === skill.name &&
          s.source === data.skill.source &&
          s.installedSource === data.skill.installedSource
            ? data.skill
            : s
        )
      );
      // Update selected
      setSelected(data.skill);
    },
    [buildSkillUrl]
  );

  const handleDelete = useCallback(
    async (skill: SkillItem) => {
      const res = await fetch(buildSkillUrl(skill), { method: "DELETE" });
      if (res.ok) {
        setSkills((prev) =>
          prev.filter(
            (s) =>
              !(
                s.name === skill.name &&
                s.source === skill.source &&
                s.installedSource === skill.installedSource
              )
          )
        );
        if (
          selected?.name === skill.name &&
          selected?.source === skill.source &&
          selected?.installedSource === skill.installedSource
        ) {
          setSelected(null);
        }
      }
    },
    [buildSkillUrl, selected]
  );

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase())
  );

  const globalSkills = filtered.filter((s) => s.source === "global");
  const installedSkills = filtered.filter((s) => s.source === "installed");
  const pluginSkills = filtered.filter((s) => s.source === "plugin");

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          {t('skills.loadingSkills')}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold">{t('extensions.skills')}</h3>
        {/* Segmented control */}
        <div className="flex items-center bg-muted rounded-md p-0.5">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "px-3 py-1 text-xs font-medium rounded h-auto",
              viewTab === "local"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setViewTab("local")}
          >
            {t('skills.mySkills')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "px-3 py-1 text-xs font-medium rounded h-auto",
              viewTab === "marketplace"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setViewTab("marketplace")}
          >
            {t('skills.marketplace')}
          </Button>
        </div>
        <div className="flex-1" />
        {viewTab === "local" && (
          <Button size="sm" onClick={() => setShowCreate(true)} className="gap-1">
            <Plus size={14} />
            {t('skills.newSkill')}
          </Button>
        )}
      </div>

      {/* Main content */}
      {viewTab === "marketplace" ? (
        <MarketplaceBrowser onInstalled={fetchSkills} />
      ) : (
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: skill list */}
        <div className="w-64 shrink-0 flex flex-col border border-border rounded-lg overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <MagnifyingGlass size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t('skills.searchSkills')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 h-8 text-sm"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-1">
              {globalSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Global
                  </span>
                  {globalSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {installedSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Installed
                  </span>
                  {installedSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {pluginSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Plugins
                  </span>
                  {pluginSkills.map((skill) => (
                    <SkillListItem
                      key={skill.filePath || `${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {filtered.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                  <Lightning size={32} className="opacity-40" />
                  <p className="text-xs">
                    {search ? t('skills.noSkillsFound') : t('skills.noSkillsFound')}
                  </p>
                  {!search && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setShowCreate(true)}
                      className="gap-1"
                    >
                      <Plus size={12} />
                      Create one
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: editor */}
        <div className="flex-1 min-w-0 border border-border rounded-lg overflow-hidden">
          {selected ? (
            <SkillEditor
              key={`${selected.source}:${selected.name}`}
              skill={selected}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <Lightning size={48} className="opacity-30" />
              <div className="text-center">
                <p className="text-sm font-medium">{t('skills.noSelected')}</p>
                <p className="text-xs">
                  {t('skills.selectOrCreate')}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreate(true)}
                className="gap-1"
              >
                <Plus size={14} />
                {t('skills.newSkill')}
              </Button>
            </div>
          )}
        </div>
      </div>
      )}

      <CreateSkillDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreate={handleCreate}
      />
    </div>
  );
}
