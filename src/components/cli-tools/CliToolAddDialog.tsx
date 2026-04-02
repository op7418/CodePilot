"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpinnerGap, CheckCircle, XCircle, Terminal } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

interface CliToolAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

type ValidateStatus = "idle" | "validating" | "valid" | "invalid";

export function CliToolAddDialog({
  open,
  onOpenChange,
  onComplete,
}: CliToolAddDialogProps) {
  const { t } = useTranslation();
  const [binPath, setBinPath] = useState("");
  const [name, setName] = useState("");
  const [validateStatus, setValidateStatus] = useState<ValidateStatus>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setBinPath("");
      setName("");
      setValidateStatus("idle");
      setSubmitting(false);
      setError(null);
      setTimeout(() => pathInputRef.current?.focus(), 100);
    }
  }, [open]);

  const handlePathChange = useCallback((value: string) => {
    setBinPath(value);
    setError(null);
    setValidateStatus("idle");
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmedPath = binPath.trim();
    if (!trimmedPath) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/cli-tools/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          binPath: trimmedPath,
          name: name.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onComplete();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add tool");
      setValidateStatus("invalid");
    } finally {
      setSubmitting(false);
    }
  }, [binPath, name, onComplete, onOpenChange]);

  const basename = binPath.trim().split("/").pop() || "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal size={18} />
            {t("cliTools.addToolTitle" as TranslationKey)}
          </DialogTitle>
          <DialogDescription>
            {t("cliTools.description" as TranslationKey)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Binary path input */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("cliTools.addToolBinPath" as TranslationKey)}
            </label>
            <div className="relative">
              <Input
                ref={pathInputRef}
                value={binPath}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder={t("cliTools.addToolBinPathPlaceholder" as TranslationKey)}
                className="font-mono pr-8"
                spellCheck={false}
                autoComplete="off"
              />
              {validateStatus === "validating" && (
                <SpinnerGap
                  size={16}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
                />
              )}
              {validateStatus === "valid" && (
                <CheckCircle
                  size={16}
                  weight="fill"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-status-success-foreground"
                />
              )}
              {validateStatus === "invalid" && (
                <XCircle
                  size={16}
                  weight="fill"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-destructive"
                />
              )}
            </div>
          </div>

          {/* Name input */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("cliTools.addToolName" as TranslationKey)}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={basename || t("cliTools.addToolNamePlaceholder" as TranslationKey)}
            />
          </div>

          {/* Error message */}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("cliTools.cancel" as TranslationKey)}
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!binPath.trim() || submitting}
            className="gap-1.5"
          >
            {submitting && <SpinnerGap size={14} className="animate-spin" />}
            {t("cliTools.addToolAdd" as TranslationKey)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
