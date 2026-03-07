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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  CheckmarkCircle02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";

interface PluginInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: "install" | "uninstall";
  pluginName: string;
  marketplace: string;
  onComplete: () => void;
}

type Phase = "running" | "success" | "error";

export function PluginInstallDialog({
  open,
  onOpenChange,
  action,
  pluginName,
  marketplace,
  onComplete,
}: PluginInstallDialogProps) {
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
          ? "/api/plugins/marketplace/install"
          : "/api/plugins/marketplace/uninstall";

      const body =
        action === "install"
          ? { name: pluginName, marketplace, scope: "user" }
          : { name: pluginName, marketplace, scope: "user" };

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
  }, [action, pluginName, marketplace]);

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
              <HugeiconsIcon
                icon={Loading02Icon}
                className="h-5 w-5 animate-spin text-blue-500"
              />
            )}
            {phase === "success" && (
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                className="h-5 w-5 text-green-500"
              />
            )}
            {phase === "error" && (
              <HugeiconsIcon
                icon={Cancel01Icon}
                className="h-5 w-5 text-red-500"
              />
            )}
            {phase === "running"
              ? action === "install"
                ? t("pluginMarket.installing")
                : t("pluginMarket.uninstalling")
              : phase === "success"
                ? action === "install"
                  ? t("pluginMarket.installSuccess")
                  : t("pluginMarket.uninstallSuccess")
                : action === "install"
                  ? t("pluginMarket.installFailed")
                  : t("pluginMarket.uninstallFailed")}
          </DialogTitle>
        </DialogHeader>

        <div className="bg-muted/50 rounded-md p-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed">
          {logs.length === 0 && phase === "running" && (
            <span className="text-muted-foreground">
              {action === "install"
                ? t("pluginMarket.installing")
                : t("pluginMarket.uninstalling")}
            </span>
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
            {phase === "running" ? t("common.cancel") : t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
