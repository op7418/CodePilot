"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/useTranslation";

import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, Search01Icon, ZapIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { SkillListItem } from "./SkillListItem";
import { SkillEditor } from "./SkillEditor";
import { CreateSkillDialog } from "./CreateSkillDialog";
import type { SkillItem } from "./SkillListItem";

export function SkillsManager() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selected, setSelected] = useState<SkillItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const { t } = useTranslation();

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleCreate = useCallback(
    async (name: string, scope: "global" | "project", content: string) => {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content, scope }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create skill");
      }
      const data = await res.json();
      setSkills((prev) => [...prev, data.skill]);
      setSelected(data.skill);
    },
    []
  );

  const buildSkillUrl = useCallback((skill: SkillItem) => {
    const base = `/api/skills/${encodeURIComponent(skill.name)}`;
    if (skill.source === "installed" && skill.installedSource) {
      return `${base}?source=${skill.installedSource}`;
    }
    return base;
  }, []);

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
  const projectSkills = filtered.filter((s) => s.source === "project");
  const installedSkills = filtered.filter((s) => s.source === "installed");
  const pluginSkills = filtered.filter((s) => s.source === "plugin");

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          {t('skills.loading')}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold flex-1">{t('skills.title')}</h3>
        <Button size="sm" onClick={() => setShowCreate(true)} className="gap-1">
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          {t('skills.newSkill')}
        </Button>
      </div>

      {/* Main content */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: skill list */}
        <div className="w-64 shrink-0 flex flex-col border border-border rounded-lg overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <HugeiconsIcon icon={Search01Icon} className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('skills.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 h-8 text-sm"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-1">
              {projectSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    {t('skills.project')}
                  </span>
                  {projectSkills.map((skill) => (
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
              {globalSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    {t('skills.global')}
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
                    {t('skills.installed')}
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
                    {t('skills.plugins')}
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
                  <HugeiconsIcon icon={ZapIcon} className="h-8 w-8 opacity-40" />
                  <p className="text-xs">
                    {search ? t('skills.noMatch') : t('skills.noSkills')}
                  </p>
                  {!search && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setShowCreate(true)}
                      className="gap-1"
                    >
                      <HugeiconsIcon icon={PlusSignIcon} className="h-3 w-3" />
                      {t('skills.createOne')}
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
              <HugeiconsIcon icon={ZapIcon} className="h-12 w-12 opacity-30" />
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
                <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
                {t('skills.newSkill')}
              </Button>
            </div>
          )}
        </div>
      </div>

      <CreateSkillDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreate={handleCreate}
      />
    </div>
  );
}
