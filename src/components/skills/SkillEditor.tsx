"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  FloppyDisk,
  Trash,
  Eye,
  PencilLine,
  Globe,
  FolderOpen,
  SpinnerGap,
  Columns,
} from "@/components/ui/icon";
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
  const { t } = useTranslation();
  const [content, setContent] = useState(skill.content);
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
              className="h-2 w-2 rounded-full bg-status-warning shrink-0"
              title="Unsaved changes"
            />
          )}
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 shrink-0",
              skill.source === "global"
                ? "border-status-success-border text-status-success-foreground"
                : skill.source === "installed"
                  ? "border-status-warning-border text-status-warning-foreground"
                  : skill.source === "plugin"
                    ? "border-primary/40 text-primary"
                    : "border-primary/40 text-primary"
            )}
          >
            {skill.source === "global" ? (
              <Globe size={10} className="mr-0.5" />
            ) : skill.source === "installed" ? (
              <FolderOpen size={10} className="mr-0.5" />
            ) : (
              <FolderOpen size={10} className="mr-0.5" />
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
                <PencilLine size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('skills.edit')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "preview" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("preview")}
              >
                <Eye size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('skills.preview')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "split" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("split")}
              >
                <Columns size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('skills.splitView')}</TooltipContent>
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
              <SpinnerGap size={12} className="animate-spin" />
            ) : (
              <FloppyDisk size={12} />
            )}
            {saving ? "Saving" : saved ? t('skills.saved') : t('skills.save')}
          </Button>

          {/* Delete */}
          <Button
            variant={confirmDelete ? "destructive" : "ghost"}
            size="icon-xs"
            onClick={handleDelete}
          >
            <Trash size={12} />
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
            placeholder={t('skills.placeholder')}
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
                placeholder={t('skills.placeholder')}
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
