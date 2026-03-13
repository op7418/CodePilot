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
import {
  SpinnerGap,
  CheckCircle,
  Warning,
} from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";

interface WecomBridgeSettings {
  bridge_wecom_bot_id: string;
  bridge_wecom_secret: string;
  bridge_wecom_allowed_users: string;
  bridge_wecom_group_policy: string;
  bridge_wecom_group_allow_from: string;
}

const DEFAULT_SETTINGS: WecomBridgeSettings = {
  bridge_wecom_bot_id: "",
  bridge_wecom_secret: "",
  bridge_wecom_allowed_users: "",
  bridge_wecom_group_policy: "open",
  bridge_wecom_group_allow_from: "",
};

export function WecomBridgeSection() {
  const [, setSettings] = useState<WecomBridgeSettings>(DEFAULT_SETTINGS);
  const [botId, setBotId] = useState("");
  const [secret, setSecret] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [groupPolicy, setGroupPolicy] = useState("open");
  const [groupAllowFrom, setGroupAllowFrom] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const { t } = useTranslation();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/wecom");
      if (!res.ok) return;

      const data = await res.json();
      const s = { ...DEFAULT_SETTINGS, ...data.settings };
      setSettings(s);
      setBotId(s.bridge_wecom_bot_id);
      setSecret(s.bridge_wecom_secret);
      setAllowedUsers(s.bridge_wecom_allowed_users);
      setGroupPolicy(s.bridge_wecom_group_policy || "open");
      setGroupAllowFrom(s.bridge_wecom_group_allow_from);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async (updates: Partial<WecomBridgeSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/wecom", {
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
    const updates: Partial<WecomBridgeSettings> = {
      bridge_wecom_bot_id: botId,
    };
    if (secret && !secret.startsWith("***")) {
      updates.bridge_wecom_secret = secret;
    }
    saveSettings(updates);
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      if (!botId || !secret) {
        setVerifyResult({
          ok: false,
          message: t("wecom.enterCredentialsFirst"),
        });
        return;
      }

      const res = await fetch("/api/settings/wecom/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_id: botId,
          secret,
        }),
      });
      const data = await res.json();

      if (data.verified) {
        setVerifyResult({
          ok: true,
          message: data.botId
            ? t("wecom.verifiedAs", { name: data.botId })
            : t("wecom.verified"),
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || t("wecom.verifyFailed"),
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: t("wecom.verifyFailed") });
    } finally {
      setVerifying(false);
    }
  };

  const handleSaveAllowedUsers = () => {
    saveSettings({
      bridge_wecom_allowed_users: allowedUsers,
    });
  };

  const handleSaveAccessSettings = () => {
    saveSettings({
      bridge_wecom_group_policy: groupPolicy,
      bridge_wecom_group_allow_from: groupAllowFrom,
    });
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("wecom.credentials")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("wecom.credentialsDesc")}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("wecom.botId")}
            </label>
            <Input
              value={botId}
              onChange={(e) => setBotId(e.target.value)}
              placeholder="wbot-xxxxxxxxxxxxxxxx"
              className="font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("wecom.secret")}
            </label>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
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
            disabled={verifying || !botId}
          >
            {verifying ? (
              <SpinnerGap
                size={14}
                className="animate-spin mr-1.5"
              />
            ) : null}
            {t("wecom.verify")}
          </Button>
        </div>

        {verifyResult && (
          <div
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
              verifyResult.ok
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-red-500/10 text-red-600 dark:text-red-400"
            }`}
          >
            {verifyResult.ok ? (
              <CheckCircle size={16} className="shrink-0" />
            ) : (
              <Warning size={16} className="shrink-0" />
            )}
            {verifyResult.message}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("wecom.allowedUsers")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("wecom.allowedUsersDesc")}
          </p>
        </div>

        <div>
          <Input
            value={allowedUsers}
            onChange={(e) => setAllowedUsers(e.target.value)}
            placeholder="zhangsan, chat_123456"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t("wecom.allowedUsersHint")}
          </p>
        </div>

        <Button size="sm" onClick={handleSaveAllowedUsers} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </div>

      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("wecom.groupSettings")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("wecom.groupSettingsDesc")}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("wecom.groupPolicy")}
            </label>
            <Select value={groupPolicy} onValueChange={setGroupPolicy}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">{t("wecom.groupPolicyOpen")}</SelectItem>
                <SelectItem value="allowlist">{t("wecom.groupPolicyAllowlist")}</SelectItem>
                <SelectItem value="disabled">{t("wecom.groupPolicyDisabled")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {groupPolicy === "allowlist" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("wecom.groupAllowFrom")}
              </label>
              <Input
                value={groupAllowFrom}
                onChange={(e) => setGroupAllowFrom(e.target.value)}
                placeholder="chat_123456, chat_789012"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("wecom.groupAllowFromHint")}
              </p>
            </div>
          )}
        </div>

        <Button size="sm" onClick={handleSaveAccessSettings} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </div>

      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <h2 className="text-sm font-medium mb-2">{t("wecom.setupGuide")}</h2>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
          <li>{t("wecom.step1")}</li>
          <li>{t("wecom.step2")}</li>
          <li>{t("wecom.step3")}</li>
          <li>{t("wecom.step4")}</li>
          <li>{t("wecom.step5")}</li>
          <li>{t("wecom.step6")}</li>
        </ol>
      </div>
    </div>
  );
}