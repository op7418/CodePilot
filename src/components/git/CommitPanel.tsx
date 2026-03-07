"use client";

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, SparklesIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/useTranslation";

interface CommitPanelProps {
  message: string;
  onChangeMessage: (message: string) => void;
  onCommit: () => void;
  isCommitting: boolean;
  stagedCount: number;
  repoPath: string;
}

// Parse commit message into subject and body
function parseCommitMessage(message: string): { subject: string; body: string } {
  const lines = message.split('\n');
  const subject = lines[0] || '';
  const body = lines.slice(1).join('\n').trim();
  return { subject, body };
}

// Combine subject and body into commit message
function combineCommitMessage(subject: string, body: string): string {
  if (!body.trim()) {
    return subject.trim();
  }
  return `${subject.trim()}\n\n${body.trim()}`;
}

export function CommitPanel({
  message,
  onChangeMessage,
  onCommit,
  isCommitting,
  stagedCount,
  repoPath,
}: CommitPanelProps) {
  const { t } = useTranslation();
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse message into subject and body
  const { subject, body } = parseCommitMessage(message);
  const [localSubject, setLocalSubject] = useState(subject);
  const [localBody, setLocalBody] = useState(body);

  // Sync local state when external message changes (e.g., from AI generation)
  useEffect(() => {
    const parsed = parseCommitMessage(message);
    setLocalSubject(parsed.subject);
    setLocalBody(parsed.body);
  }, [message]);

  const handleSubjectChange = (value: string) => {
    setLocalSubject(value);
    onChangeMessage(combineCommitMessage(value, localBody));
  };

  const handleBodyChange = (value: string) => {
    setLocalBody(value);
    onChangeMessage(combineCommitMessage(localSubject, value));
  };

  const canCommit = stagedCount > 0 && localSubject.trim().length > 0;

  const handleGenerateMessage = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/git/ai-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoPath }),
      });
      const data = await res.json();
      if (data.message) {
        onChangeMessage(data.message);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError(t("git.aiGenerateFailed"));
      console.error("Failed to generate commit message:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
      e.preventDefault();
      onCommit();
    }
  };

  return (
    <div className="border-t border-border/50 p-3 space-y-3">
      {/* Subject (title) input */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">
            {t("git.commitSubject")}
          </Label>
          <span className="text-[10px] text-muted-foreground">⌘/Ctrl + Enter</span>
        </div>
        <div className="flex gap-2">
          <Input
            value={localSubject}
            onChange={(e) => handleSubjectChange(e.target.value)}
            placeholder={t("git.commitSubjectPlaceholder")}
            className="flex-1 text-sm"
            disabled={isCommitting}
          />
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={handleGenerateMessage}
              disabled={isGenerating || stagedCount === 0}
              title={t("git.aiGenerate")}
            >
              {isGenerating ? (
                <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              ) : (
                <HugeiconsIcon icon={SparklesIcon} className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              className="h-9 w-9"
              onClick={onCommit}
              disabled={!canCommit || isCommitting}
              title={t("git.commit")}
            >
              <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Body (description) input */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-muted-foreground">
          {t("git.commitBody")}
        </Label>
        <textarea
          value={localBody}
          onChange={(e) => handleBodyChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("git.commitBodyPlaceholder")}
          className={cn(
            "min-h-15 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          disabled={isCommitting}
        />
      </div>

      {error && (
        <div className="text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
