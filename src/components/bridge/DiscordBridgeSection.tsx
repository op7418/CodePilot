"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SpinnerGap, CheckCircle, Warning } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { SettingsCard } from "@/components/patterns/SettingsCard";
import { FieldRow } from "@/components/patterns/FieldRow";
import { StatusBanner } from "@/components/patterns/StatusBanner";

interface DiscordBridgeSettings {
  bridge_discord_bot_token: string;
  bridge_discord_allowed_users: string;
  bridge_discord_allowed_channels: string;
  bridge_discord_allowed_guilds: string;
  bridge_discord_group_policy: string;
  bridge_discord_require_mention: string;
  bridge_discord_stream_enabled: string;
  bridge_discord_max_attachment_size: string;
  bridge_discord_image_enabled: string;
}

const DEFAULT_SETTINGS: DiscordBridgeSettings = {
  bridge_discord_bot_token: "",
  bridge_discord_allowed_users: "",
  bridge_discord_allowed_channels: "",
  bridge_discord_allowed_guilds: "",
  bridge_discord_group_policy: "open",
  bridge_discord_require_mention: "false",
  bridge_discord_stream_enabled: "true",
  bridge_discord_max_attachment_size: "",
  bridge_discord_image_enabled: "true",
};

export function DiscordBridgeSection() {
  const [, setSettings] =
    useState<DiscordBridgeSettings>(DEFAULT_SETTINGS);
  const [botToken, setBotToken] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [allowedChannels, setAllowedChannels] = useState("");
  const [allowedGuilds, setAllowedGuilds] = useState("");
  const [groupPolicy, setGroupPolicy] = useState("open");
  const [requireMention, setRequireMention] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const { t } = useTranslation();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/discord");
      if (res.ok) {
        const data = await res.json();
        const s = { ...DEFAULT_SETTINGS, ...data.settings };
        setSettings(s);
        setBotToken(s.bridge_discord_bot_token);
        setAllowedUsers(s.bridge_discord_allowed_users);
        setAllowedChannels(s.bridge_discord_allowed_channels);
        setAllowedGuilds(s.bridge_discord_allowed_guilds);
        setGroupPolicy(s.bridge_discord_group_policy || "open");
        setRequireMention(s.bridge_discord_require_mention === "true");
        setStreamEnabled(s.bridge_discord_stream_enabled !== "false");
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async (updates: Partial<DiscordBridgeSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/discord", {
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

  const handleSaveCredentials = () => {
    const updates: Partial<DiscordBridgeSettings> = {};
    if (botToken && !botToken.startsWith("***")) {
      updates.bridge_discord_bot_token = botToken;
    }
    saveSettings(updates);
  };

  const handleSaveGroupSettings = () => {
    saveSettings({
      bridge_discord_allowed_users: allowedUsers,
      bridge_discord_allowed_channels: allowedChannels,
      bridge_discord_allowed_guilds: allowedGuilds,
      bridge_discord_group_policy: groupPolicy,
      bridge_discord_require_mention: requireMention ? "true" : "false",
      bridge_discord_stream_enabled: streamEnabled ? "true" : "false",
    });
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      if (!botToken) {
        setVerifyResult({
          ok: false,
          message: t("discord.enterTokenFirst"),
        });
        return;
      }

      const res = await fetch("/api/settings/discord/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_token: botToken }),
      });
      const data = await res.json();

      if (data.verified) {
        setVerifyResult({
          ok: true,
          message: data.botName
            ? t("discord.verifiedAs", { name: data.botName })
            : t("discord.verified"),
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || t("discord.verifyFailed"),
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: t("discord.verifyFailed") });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* Bot Token */}
      <SettingsCard
        title={t("discord.credentials")}
        description={t("discord.credentialsDesc")}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("discord.botToken")}
            </label>
            <Input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXXXXXXXXX"
              className="font-mono text-sm"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSaveCredentials} disabled={saving}>
            {saving ? t("common.loading") : t("common.save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleVerify}
            disabled={verifying || !botToken}
          >
            {verifying ? (
              <SpinnerGap
                size={14}
                className="animate-spin mr-1.5"
              />
            ) : null}
            {t("discord.verify")}
          </Button>
        </div>

        {verifyResult && (
          <StatusBanner
            variant={verifyResult.ok ? "success" : "error"}
            icon={verifyResult.ok ? <CheckCircle size={16} className="shrink-0" /> : <Warning size={16} className="shrink-0" />}
          >
            {verifyResult.message}
          </StatusBanner>
        )}
      </SettingsCard>

      {/* Allowed Users / Channels */}
      <SettingsCard
        title={t("discord.allowedUsers")}
        description={t("discord.allowedUsersDesc")}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("discord.allowedUserIds")}
            </label>
            <Input
              value={allowedUsers}
              onChange={(e) => setAllowedUsers(e.target.value)}
              placeholder="123456789012345678"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("discord.allowedUsersHint")}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("discord.allowedChannelIds")}
            </label>
            <Input
              value={allowedChannels}
              onChange={(e) => setAllowedChannels(e.target.value)}
              placeholder="123456789012345678"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("discord.allowedChannelsHint")}
            </p>
          </div>
        </div>
      </SettingsCard>

      {/* Guild & Group Settings */}
      <SettingsCard
        title={t("discord.guildSettings")}
        description={t("discord.guildSettingsDesc")}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("discord.allowedGuilds")}
            </label>
            <Input
              value={allowedGuilds}
              onChange={(e) => setAllowedGuilds(e.target.value)}
              placeholder="123456789012345678"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("discord.allowedGuildsHint")}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("discord.groupPolicy")}
            </label>
            <Select value={groupPolicy} onValueChange={setGroupPolicy}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">
                  {t("discord.groupPolicyOpen")}
                </SelectItem>
                <SelectItem value="disabled">
                  {t("discord.groupPolicyDisabled")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <FieldRow
            label={t("discord.requireMention")}
            description={t("discord.requireMentionDesc")}
          >
            <Switch
              checked={requireMention}
              onCheckedChange={setRequireMention}
            />
          </FieldRow>

          <FieldRow
            label={t("discord.streamPreview")}
            description={t("discord.streamPreviewDesc")}
            separator
          >
            <Switch
              checked={streamEnabled}
              onCheckedChange={setStreamEnabled}
            />
          </FieldRow>
        </div>

        <Button size="sm" onClick={handleSaveGroupSettings} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </SettingsCard>

      {/* Setup Guide */}
      <SettingsCard title={t("discord.setupGuide")}>
        <div>
          <h3 className="text-xs font-medium mb-1.5">
            {t("discord.setupBotTitle")}
          </h3>
          <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
            <li>{t("discord.step1")}</li>
            <li>{t("discord.step2")}</li>
            <li>{t("discord.step3")}</li>
            <li>{t("discord.step4")}</li>
            <li>{t("discord.step5")}</li>
            <li>{t("discord.step6")}</li>
            <li>{t("discord.step7")}</li>
          </ol>
        </div>

        <div className="border-t border-border/30 pt-3">
          <h3 className="text-xs font-medium mb-1.5">
            {t("discord.setupIdTitle")}
          </h3>
          <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
            <li>{t("discord.stepDevMode")}</li>
            <li>{t("discord.stepUserId")}</li>
            <li>{t("discord.stepChannelId")}</li>
            <li>{t("discord.stepGuildId")}</li>
          </ol>
        </div>
      </SettingsCard>
    </div>
  );
}
