"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  Delete02Icon,
  EyeIcon,
  Edit02Icon,
  GlobeIcon,
  FolderOpenIcon,
  Loading02Icon,
  LayoutTwoColumnIcon,
} from "@hugeicons/core-free-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "@/hooks/useTranslation";
import type { SkillItem } from "./SkillListItem";

type ViewMode = "edit" | "preview" | "split";

interface SkillEditorProps {
  skill: SkillItem;
  onSave: (skill: SkillItem, content: string) => Promise<void>;
  onDelete: (skill: SkillItem) => void;
}

export function SkillEditor({ skill, onSave, onDelete }: SkillEditorProps) {
  const [content, setContent] = useState(skill.content);
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();

  const isDirty = content !== skill.content;

  // Reset content when skill changes
  useEffect(() => {
    setContent(skill.content);
    setConfirmDelete(false);
    setSaved(false);
  }, [skill.name, skill.filePath, skill.content]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(skill, content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [skill, content, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Tab indentation
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          content.substring(0, start) + "  " + content.substring(end);
        setContent(newContent);
        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          textarea.selectionStart = start + 2;
          textarea.selectionEnd = start + 2;
        });
      }
      // Ctrl/Cmd + S to save
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty) handleSave();
      }
    },
    [content, isDirty, handleSave]
  );

  const handleDelete = () => {
    if (confirmDelete) {
      onDelete(skill);
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  const markdownContent = (
    <div className="prose prose-sm dark:prose-invert max-w-none p-4 overflow-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-semibold truncate">/{skill.name}</span>
          {isDirty && (
            <span
              className="h-2 w-2 rounded-full bg-orange-400 shrink-0"
              title={t('skillEditor.unsavedChanges')}
            />
          )}
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 shrink-0",
              skill.source === "global"
                ? "border-green-500/40 text-green-600 dark:text-green-400"
                : skill.source === "installed"
                  ? "border-orange-500/40 text-orange-600 dark:text-orange-400"
                  : skill.source === "plugin"
                    ? "border-indigo-500/40 text-indigo-600 dark:text-indigo-400"
                    : "border-blue-500/40 text-blue-600 dark:text-blue-400"
            )}
          >
            {skill.source === "global" ? (
              <HugeiconsIcon icon={GlobeIcon} className="h-2.5 w-2.5 mr-0.5" />
            ) : skill.source === "installed" ? (
              <HugeiconsIcon icon={FolderOpenIcon} className="h-2.5 w-2.5 mr-0.5" />
            ) : (
              <HugeiconsIcon icon={FolderOpenIcon} className="h-2.5 w-2.5 mr-0.5" />
            )}
            {skill.source === "installed" && skill.installedSource
              ? `installed:${skill.installedSource}`
              : skill.source}
          </Badge>
        </div>

        <div className="flex items-center gap-1">
          {/* View mode toggles */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "edit" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("edit")}
              >
                <HugeiconsIcon icon={Edit02Icon} className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('skillEditor.edit')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "preview" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("preview")}
              >
                <HugeiconsIcon icon={EyeIcon} className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('skillEditor.preview')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "split" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("split")}
              >
                <HugeiconsIcon icon={LayoutTwoColumnIcon} className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('skillEditor.split')}</TooltipContent>
          </Tooltip>

          <div className="w-px h-4 bg-border mx-1" />

          {/* Save */}
          <Button
            size="xs"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="gap-1"
          >
            {saving ? (
              <HugeiconsIcon icon={Loading02Icon} className="h-3 w-3 animate-spin" />
            ) : (
              <HugeiconsIcon icon={FloppyDiskIcon} className="h-3 w-3" />
            )}
            {saving ? t('skillEditor.saving') : saved ? t('skillEditor.saved') : t('skillEditor.save')}
          </Button>

          {/* Delete */}
          <Button
            variant={confirmDelete ? "destructive" : "ghost"}
            size="icon-xs"
            onClick={handleDelete}
          >
            <HugeiconsIcon icon={Delete02Icon} className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {viewMode === "edit" && (
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-full w-full resize-none rounded-none border-0 font-mono text-sm focus-visible:ring-0 focus-visible:ring-offset-0 min-h-[400px]"
            placeholder={t('skillEditor.placeholder')}
          />
        )}
        {viewMode === "preview" && (
          <div className="h-full overflow-auto">{markdownContent}</div>
        )}
        {viewMode === "split" && (
          <div className="flex h-full divide-x divide-border">
            <div className="flex-1 min-w-0">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-full w-full resize-none rounded-none border-0 font-mono text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
                placeholder={t('skillEditor.placeholder')}
              />
            </div>
            <div className="flex-1 min-w-0 overflow-auto">
              {markdownContent}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-border px-4 py-1.5 shrink-0">
        <span className="text-xs text-muted-foreground truncate">
          {skill.filePath}
        </span>
      </div>
    </div>
  );
}
