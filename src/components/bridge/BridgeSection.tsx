"use client";

import { useState, useCallback, useEffect } from "react";
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
import { SpinnerGap, CheckCircle, Warning, TelegramLogo, ChatTeardrop, GameController, ChatsCircle } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { SettingsCard } from "@/components/patterns/SettingsCard";
import { FieldRow } from "@/components/patterns/FieldRow";
import { StatusBanner } from "@/components/patterns/StatusBanner";
import type { ProviderModelGroup } from "@/types";

interface BridgeSettings {
  remote_bridge_enabled: string;
  bridge_telegram_enabled: string;
  bridge_feishu_enabled: string;
  bridge_discord_enabled: string;
  bridge_qq_enabled: string;
  bridge_auto_start: string;
  bridge_default_work_dir: string;
  bridge_default_model: string;
  bridge_default_provider_id: string;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  remote_bridge_enabled: "",
  bridge_telegram_enabled: "",
  bridge_feishu_enabled: "",
  bridge_discord_enabled: "",
  bridge_qq_enabled: "",
  bridge_auto_start: "",
  bridge_default_work_dir: "",
  bridge_default_model: "",
  bridge_default_provider_id: "",
};

export function BridgeSection() {
  const [settings, setSettings] = useState<BridgeSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [workDir, setWorkDir] = useState("");
  const [model, setModel] = useState("");
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  const { bridgeStatus, starting, stopping, startBridge, stopBridge } = useBridgeStatus();
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
    fetchModels();
  }, [fetchSettings, fetchModels]);

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

  const handleToggleFeishu = (checked: boolean) => {
    saveSettings({ bridge_feishu_enabled: checked ? "true" : "" });
  };

  const handleToggleDiscord = (checked: boolean) => {
    saveSettings({ bridge_discord_enabled: checked ? "true" : "" });
  };

  const handleToggleQQ = (checked: boolean) => {
    saveSettings({ bridge_qq_enabled: checked ? "true" : "" });
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

  const handleToggleAutoStart = (checked: boolean) => {
    saveSettings({ bridge_auto_start: checked ? "true" : "" });
  };

  const isEnabled = settings.remote_bridge_enabled === "true";
  const isTelegramEnabled = settings.bridge_telegram_enabled === "true";
  const isFeishuEnabled = settings.bridge_feishu_enabled === "true";
  const isDiscordEnabled = settings.bridge_discord_enabled === "true";
  const isQQEnabled = settings.bridge_qq_enabled === "true";
  const isAutoStart = settings.bridge_auto_start === "true";
  const isRunning = bridgeStatus?.running ?? false;
  const adapterCount = bridgeStatus?.adapters?.length ?? 0;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Enable/Disable Master Toggle */}
      <SettingsCard className={isEnabled ? "border-primary/50 bg-primary/5" : undefined}>
        <FieldRow
          label={t("bridge.title")}
          description={t("bridge.description")}
        >
          <Switch
            checked={isEnabled}
            onCheckedChange={handleToggleEnabled}
            disabled={saving}
          />
        </FieldRow>
        {isEnabled && (
          <StatusBanner variant="info" className="bg-primary/10 text-primary">
            <span className="h-2 w-2 shrink-0 rounded-full bg-primary inline-block mr-1" />
            {t("bridge.activeHint")}
          </StatusBanner>
        )}
      </SettingsCard>

      {/* Bridge Status + Start/Stop */}
      {isEnabled && (
        <SettingsCard>
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
                    ? "bg-status-success-muted text-status-success-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {isRunning ? <CheckCircle size={14} className="shrink-0" /> : <Warning size={14} className="shrink-0" />}
                {isRunning
                  ? t("bridge.statusConnected")
                  : t("bridge.statusDisconnected")}
              </div>
              {isRunning ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={stopBridge}
                  disabled={stopping}
                >
                  {stopping ? (
                    <SpinnerGap
                      size={14}
                      className="animate-spin mr-1.5"
                    />
                  ) : null}
                  {stopping ? t("bridge.stopping") : t("bridge.stop")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={startBridge}
                  disabled={starting}
                >
                  {starting ? (
                    <SpinnerGap
                      size={14}
                      className="animate-spin mr-1.5"
                    />
                  ) : null}
                  {starting ? t("bridge.starting") : t("bridge.start")}
                </Button>
              )}
            </div>
          </div>
        </SettingsCard>
      )}

      {/* Channel Toggles */}
      {isEnabled && (
        <SettingsCard
          title={t("bridge.channels")}
          description={t("bridge.channelsDesc")}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TelegramLogo size={16} className="text-muted-foreground" />
                <div>
                  <p className="text-sm">{t("bridge.telegramChannel")}</p>
                  <p className="text-xs text-muted-foreground">{t("bridge.telegramChannelDesc")}</p>
                </div>
              </div>
              <Switch
                checked={isTelegramEnabled}
                onCheckedChange={handleToggleTelegram}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/30 pt-3">
              <div className="flex items-center gap-3">
                <ChatTeardrop size={16} className="text-muted-foreground" />
                <div>
                  <p className="text-sm">{t("bridge.feishuChannel")}</p>
                  <p className="text-xs text-muted-foreground">{t("bridge.feishuChannelDesc")}</p>
                </div>
              </div>
              <Switch
                checked={isFeishuEnabled}
                onCheckedChange={handleToggleFeishu}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/30 pt-3">
              <div className="flex items-center gap-3">
                <GameController size={16} className="text-muted-foreground" />
                <div>
                  <p className="text-sm">{t("bridge.discordChannel")}</p>
                  <p className="text-xs text-muted-foreground">{t("bridge.discordChannelDesc")}</p>
                </div>
              </div>
              <Switch
                checked={isDiscordEnabled}
                onCheckedChange={handleToggleDiscord}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/30 pt-3">
              <div className="flex items-center gap-3">
                <ChatsCircle size={16} className="text-muted-foreground" />
                <div>
                  <p className="text-sm">{t("bridge.qqChannel")}</p>
                  <p className="text-xs text-muted-foreground">{t("bridge.qqChannelDesc")}</p>
                </div>
              </div>
              <Switch
                checked={isQQEnabled}
                onCheckedChange={handleToggleQQ}
                disabled={saving}
              />
            </div>

            <FieldRow
              label={t("bridge.autoStart")}
              description={t("bridge.autoStartDesc")}
              separator
            >
              <Switch
                checked={isAutoStart}
                onCheckedChange={handleToggleAutoStart}
                disabled={saving}
              />
            </FieldRow>
          </div>
        </SettingsCard>
      )}

      {/* Adapter Status */}
      {isEnabled && isRunning && adapterCount > 0 && (
        <SettingsCard
          title={t("bridge.adapters")}
          description={t("bridge.adaptersDesc")}
        >
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
                        ? "bg-status-success-muted text-status-success-foreground"
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
                  <p className="text-xs text-status-error-foreground">
                    {t("bridge.adapterLastError")}: {adapter.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}

      {/* Default Settings */}
      {isEnabled && (
        <SettingsCard
          title={t("bridge.defaults")}
          description={t("bridge.defaultsDesc")}
        >
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
        </SettingsCard>
      )}
    </div>
  );
}
