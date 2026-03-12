"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SpinnerGap, CheckCircle, X } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";

interface InstallProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: "install" | "uninstall";
  source: string;
  skillName: string;
  onComplete: () => void;
}

type Phase = "running" | "success" | "error";

export function InstallProgressDialog({
  open,
  onOpenChange,
  action,
  source,
  skillName,
  onComplete,
}: InstallProgressDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("running");
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startProcess = useCallback(async () => {
    setPhase("running");
    setLogs([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const endpoint =
        action === "install"
          ? "/api/skills/marketplace/install"
          : "/api/skills/marketplace/remove";

      const body =
        action === "install"
          ? { source, global: true }
          : { skill: skillName, global: true };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setPhase("error");
        setLogs((prev) => [...prev, `HTTP ${res.status}: ${res.statusText}`]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const raw = line.slice(6);
            let data: string;
            try {
              data = JSON.parse(raw);
            } catch {
              data = raw;
            }

            if (currentEvent === "output") {
              setLogs((prev) => [...prev, data]);
            } else if (currentEvent === "done") {
              setPhase("success");
            } else if (currentEvent === "error") {
              setPhase("error");
              setLogs((prev) => [...prev, `Error: ${data}`]);
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setPhase("error");
        setLogs((prev) => [...prev, (err as Error).message]);
      }
    }
  }, [action, source, skillName]);

  useEffect(() => {
    if (open) {
      startProcess();
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [open, startProcess]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleClose = () => {
    abortRef.current?.abort();
    if (phase === "success") {
      onComplete();
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {phase === "running" && (
              <SpinnerGap size={20} className="animate-spin text-primary" />
            )}
            {phase === "success" && (
              <CheckCircle size={20} className="text-status-success-foreground" />
            )}
            {phase === "error" && (
              <X size={20} className="text-status-error-foreground" />
            )}
            {phase === "running"
              ? t('skills.installing')
              : phase === "success"
                ? t('skills.installSuccess')
                : t('skills.installFailed')}
          </DialogTitle>
        </DialogHeader>

        <div className="bg-muted/50 rounded-md p-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed">
          {logs.length === 0 && phase === "running" && (
            <span className="text-muted-foreground">{t('skills.installing')}</span>
          )}
          {logs.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>

        <DialogFooter>
          <Button onClick={handleClose}>
            {phase === "running" ? t('common.cancel') : t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
