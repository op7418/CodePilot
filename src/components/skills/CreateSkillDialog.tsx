"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, GlobeIcon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";

interface CreateSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, scope: "global" | "project", content: string) => Promise<void>;
}

const TEMPLATES: { label: string; content: string }[] = [
  { label: "Blank", content: "" },
  {
    label: "Commit Helper",
    content: `# Commit Helper

Review the staged changes and generate a concise, descriptive commit message following conventional commit format.

Rules:
- Use conventional commit prefixes: feat, fix, refactor, docs, test, chore
- Keep the first line under 72 characters
- Add a blank line and detailed description if needed
- Reference relevant issue numbers if applicable
`,
  },
  {
    label: "Code Reviewer",
    content: `# Code Reviewer

Review the provided code and give feedback on:

1. **Correctness** - Logic errors, edge cases, potential bugs
2. **Performance** - Inefficiencies, unnecessary allocations
3. **Readability** - Naming, structure, comments where needed
4. **Security** - Input validation, injection risks, data exposure

Be specific with line references. Suggest concrete improvements, not just problems.
`,
  },
];

export function CreateSkillDialog({
  open,
  onOpenChange,
  onCreate,
}: CreateSkillDialogProps) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [templateIdx, setTemplateIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const { t } = useTranslation();

  const templateLabels = [
    t('createSkill.templateBlank'),
    t('createSkill.templateCommit'),
    t('createSkill.templateReviewer'),
  ];

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('createSkill.nameRequired'));
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError(t('createSkill.nameInvalid'));
      return;
    }

    setCreating(true);
    setError("");
    try {
      await onCreate(trimmed, scope, TEMPLATES[templateIdx].content);
      // Reset on success
      setName("");
      setScope("project");
      setTemplateIdx(0);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('createSkill.failed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('createSkill.title')}</DialogTitle>
          <DialogDescription>
            {t('createSkill.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name input */}
          <div className="space-y-2">
            <Label htmlFor="skill-name">{t('createSkill.name')}</Label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">/</span>
              <Input
                id="skill-name"
                placeholder={t('createSkill.namePlaceholder')}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
            </div>
          </div>

          {/* Scope selection */}
          <div className="space-y-2">
            <Label>{t('createSkill.scope')}</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setScope("project")}
                className={cn(
                  "flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  scope === "project"
                    ? "border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "border-border hover:bg-accent"
                )}
              >
                <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
                {t('createSkill.scopeProject')}
              </button>
              <button
                type="button"
                onClick={() => setScope("global")}
                className={cn(
                  "flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  scope === "global"
                    ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400"
                    : "border-border hover:bg-accent"
                )}
              >
                <HugeiconsIcon icon={GlobeIcon} className="h-4 w-4" />
                {t('createSkill.scopeGlobal')}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {scope === "project"
                ? t('createSkill.scopeProjectDesc')
                : t('createSkill.scopeGlobalDesc')}
            </p>
          </div>

          {/* Template selection */}
          <div className="space-y-2">
            <Label>{t('createSkill.template')}</Label>
            <div className="flex gap-2 flex-wrap">
              {TEMPLATES.map((tmpl, i) => (
                <button
                  key={tmpl.label}
                  type="button"
                  onClick={() => setTemplateIdx(i)}
                  className={cn(
                    "rounded-md border px-3 py-1 text-xs transition-colors",
                    templateIdx === i
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent"
                  )}
                >
                  {templateLabels[i]}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            {t('createSkill.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={creating} className="gap-2">
            {creating && <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />}
            {t('createSkill.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
