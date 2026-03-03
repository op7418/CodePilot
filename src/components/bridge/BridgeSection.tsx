"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, CheckmarkCircle02Icon, Alert02Icon, TelegramIcon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { ProviderModelGroup } from "@/types";

interface AdapterStatus {
  channelType: string;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

interface BridgeSettings {
  remote_bridge_enabled: string;
  bridge_telegram_enabled: string;
  bridge_auto_start: string;
  bridge_default_work_dir: string;
  bridge_default_model: string;
  bridge_default_provider_id: string;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  remote_bridge_enabled: "",
  bridge_telegram_enabled: "",
  bridge_auto_start: "",
  bridge_default_work_dir: "",
  bridge_default_model: "",
  bridge_default_provider_id: "",
};

export function BridgeSection() {
  const [settings, setSettings] = useState<BridgeSettings>(DEFAULT_SETTINGS);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [workDir, setWorkDir] = useState("");
  const [model, setModel] = useState("");
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { t } = useTranslation();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/bridge/settings");
      if (res.ok) {
        const data = await res.json();
        const s = { ...DEFAULT_SETTINGS, ...data.settings };
        setSettings(s);
        setWorkDir(s.bridge_default_work_dir);
        // Build composite value for Select: "provider_id::model"
        if (s.bridge_default_provider_id && s.bridge_default_model) {
          setModel(`${s.bridge_default_provider_id}::${s.bridge_default_model}`);
        } else if (s.bridge_default_model) {
          setModel(s.bridge_default_model);
        } else {
          setModel("");
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/bridge");
      if (res.ok) {
        const data = await res.json();
        setBridgeStatus(data);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch("/api/providers/models");
      if (res.ok) {
        const data = await res.json();
        if (data.groups && data.groups.length > 0) {
          setProviderGroups(data.groups);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchStatus();
    fetchModels();
  }, [fetchSettings, fetchStatus, fetchModels]);

  // Poll bridge status while bridge is running
  useEffect(() => {
    if (bridgeStatus?.running) {
      pollRef.current = setInterval(fetchStatus, 5000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [bridgeStatus?.running, fetchStatus]);

  const saveSettings = async (updates: Partial<BridgeSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/bridge/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updates }),
      });
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = (checked: boolean) => {
    saveSettings({ remote_bridge_enabled: checked ? "true" : "" });
  };

  const handleToggleTelegram = (checked: boolean) => {
    saveSettings({ bridge_telegram_enabled: checked ? "true" : "" });
  };

  const handleSaveDefaults = () => {
    // Split composite "provider_id::model" value
    const parts = model.split("::");
    const providerId = parts.length === 2 ? parts[0] : "";
    const modelValue = parts.length === 2 ? parts[1] : model;
    saveSettings({
      bridge_default_work_dir: workDir,
      bridge_default_model: modelValue,
      bridge_default_provider_id: providerId,
    });
  };

  const handleBrowseFolder = async () => {
    try {
      const api = (window as unknown as Record<string, unknown>).electronAPI as
        | { dialog: { openFolder: (opts?: { defaultPath?: string; title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }> } }
        | undefined;
      if (api?.dialog?.openFolder) {
        const result = await api.dialog.openFolder({
          defaultPath: workDir || undefined,
          title: t("bridge.defaultWorkDir"),
        });
        if (!result.canceled && result.filePaths[0]) {
          setWorkDir(result.filePaths[0]);
        }
      }
    } catch {
      // Not in Electron or dialog unavailable
    }
  };

  const handleStartBridge = async () => {
    setStarting(true);
    try {
      await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      await fetchStatus();
    } catch {
      // ignore
    } finally {
      setStarting(false);
    }
  };

  const handleStopBridge = async () => {
    setStopping(true);
    try {
      await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await fetchStatus();
    } catch {
      // ignore
    } finally {
      setStopping(false);
    }
  };

  const handleToggleAutoStart = (checked: boolean) => {
    saveSettings({ bridge_auto_start: checked ? "true" : "" });
  };

  const isEnabled = settings.remote_bridge_enabled === "true";
  const isTelegramEnabled = settings.bridge_telegram_enabled === "true";
  const isAutoStart = settings.bridge_auto_start === "true";
  const isRunning = bridgeStatus?.running ?? false;
  const adapterCount = bridgeStatus?.adapters?.length ?? 0;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Enable/Disable Master Toggle */}
      <div
        className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${
          isEnabled
            ? "border-blue-500/50 bg-blue-500/5"
            : "border-border/50"
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.title")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.description")}
            </p>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={handleToggleEnabled}
            disabled={saving}
          />
        </div>
        {isEnabled && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
            {t("bridge.activeHint")}
          </div>
        )}
      </div>

      {/* Bridge Status + Start/Stop */}
      {isEnabled && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium">{t("bridge.status")}</h2>
              <p className="text-xs text-muted-foreground">
                {isRunning
                  ? t("bridge.activeBindings", { count: String(adapterCount) })
                  : t("bridge.noBindings")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs ${
                  isRunning
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <HugeiconsIcon
                  icon={isRunning ? CheckmarkCircle02Icon : Alert02Icon}
                  className="h-3.5 w-3.5 shrink-0"
                />
                {isRunning
                  ? t("bridge.statusConnected")
                  : t("bridge.statusDisconnected")}
              </div>
              {isRunning ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleStopBridge}
                  disabled={stopping}
                >
                  {stopping ? (
                    <HugeiconsIcon
                      icon={Loading02Icon}
                      className="h-3.5 w-3.5 animate-spin mr-1.5"
                    />
                  ) : null}
                  {stopping ? t("bridge.stopping") : t("bridge.stop")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleStartBridge}
                  disabled={starting}
                >
                  {starting ? (
                    <HugeiconsIcon
                      icon={Loading02Icon}
                      className="h-3.5 w-3.5 animate-spin mr-1.5"
                    />
                  ) : null}
                  {starting ? t("bridge.starting") : t("bridge.start")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Channel Toggles */}
      {isEnabled && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.channels")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.channelsDesc")}
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <HugeiconsIcon
                  icon={TelegramIcon}
                  className="h-4 w-4 text-muted-foreground"
                />
                <div>
                  <p className="text-sm">{t("bridge.telegramChannel")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.telegramChannelDesc")}
                  </p>
                </div>
              </div>
              <Switch
                checked={isTelegramEnabled}
                onCheckedChange={handleToggleTelegram}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/30 pt-3">
              <div>
                <p className="text-sm">{t("bridge.autoStart")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("bridge.autoStartDesc")}
                </p>
              </div>
              <Switch
                checked={isAutoStart}
                onCheckedChange={handleToggleAutoStart}
                disabled={saving}
              />
            </div>
          </div>
        </div>
      )}

      {/* Adapter Status */}
      {isEnabled && isRunning && adapterCount > 0 && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.adapters")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.adaptersDesc")}
            </p>
          </div>

          <div className="space-y-2">
            {bridgeStatus?.adapters.map((adapter) => (
              <div
                key={adapter.channelType}
                className="rounded-md border border-border/30 px-3 py-2 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium capitalize">
                    {adapter.channelType}
                  </span>
                  <div
                    className={`rounded px-2 py-0.5 text-xs ${
                      adapter.running
                        ? "bg-green-500/10 text-green-600 dark:text-green-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {adapter.running
                      ? t("bridge.adapterRunning")
                      : t("bridge.adapterStopped")}
                  </div>
                </div>
                {adapter.lastMessageAt && (
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.adapterLastMessage")}: {new Date(adapter.lastMessageAt).toLocaleString()}
                  </p>
                )}
                {adapter.error && (
                  <p className="text-xs text-red-500">
                    {t("bridge.adapterLastError")}: {adapter.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Default Settings */}
      {isEnabled && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.defaults")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.defaultsDesc")}
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("bridge.defaultWorkDir")}
              </label>
              <div className="flex gap-2">
                <Input
                  value={workDir}
                  onChange={(e) => setWorkDir(e.target.value)}
                  placeholder="/path/to/project"
                  className="font-mono text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBrowseFolder}
                  className="shrink-0"
                >
                  {t("bridge.browse")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("bridge.defaultWorkDirHint")}
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("bridge.defaultModel")}
              </label>
              {providerGroups.length > 0 ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="w-full text-sm font-mono">
                    <SelectValue placeholder={t("bridge.defaultModelHint")} />
                  </SelectTrigger>
                  <SelectContent>
                    {providerGroups.map((group) => (
                      <SelectGroup key={group.provider_id}>
                        <SelectLabel>{group.provider_name}</SelectLabel>
                        {group.models.map((m) => (
                          <SelectItem
                            key={`${group.provider_id}::${m.value}`}
                            value={`${group.provider_id}::${m.value}`}
                          >
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="sonnet"
                  className="font-mono text-sm"
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {t("bridge.defaultModelHint")}
              </p>
            </div>
          </div>

          <Button
            size="sm"
            onClick={handleSaveDefaults}
            disabled={saving}
          >
            {saving ? t("common.loading") : t("common.save")}
          </Button>
        </div>
      )}
    </div>
  );
}
