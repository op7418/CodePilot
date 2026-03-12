"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SpinnerGap, CheckCircle, Warning } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { SettingsCard } from "@/components/patterns/SettingsCard";
import { FieldRow } from "@/components/patterns/FieldRow";
import { StatusBanner } from "@/components/patterns/StatusBanner";

interface QqBridgeSettings {
  bridge_qq_app_id: string;
  bridge_qq_app_secret: string;
  bridge_qq_allowed_users: string;
  bridge_qq_image_enabled: string;
  bridge_qq_max_image_size: string;
}

const DEFAULT_SETTINGS: QqBridgeSettings = {
  bridge_qq_app_id: "",
  bridge_qq_app_secret: "",
  bridge_qq_allowed_users: "",
  bridge_qq_image_enabled: "true",
  bridge_qq_max_image_size: "20",
};

export function QqBridgeSection() {
  const [, setSettings] = useState<QqBridgeSettings>(DEFAULT_SETTINGS);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [imageEnabled, setImageEnabled] = useState(true);
  const [maxImageSize, setMaxImageSize] = useState("20");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const { t } = useTranslation();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/qq");
      if (res.ok) {
        const data = await res.json();
        const s = { ...DEFAULT_SETTINGS, ...data.settings };
        setSettings(s);
        setAppId(s.bridge_qq_app_id);
        setAppSecret(s.bridge_qq_app_secret);
        setAllowedUsers(s.bridge_qq_allowed_users);
        setImageEnabled(s.bridge_qq_image_enabled !== "false");
        setMaxImageSize(s.bridge_qq_max_image_size || "20");
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async (updates: Partial<QqBridgeSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/qq", {
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
    const updates: Partial<QqBridgeSettings> = {
      bridge_qq_app_id: appId,
    };
    if (appSecret && !appSecret.startsWith("***")) {
      updates.bridge_qq_app_secret = appSecret;
    }
    saveSettings(updates);
  };

  const handleSaveAllowedUsers = () => {
    saveSettings({
      bridge_qq_allowed_users: allowedUsers,
    });
  };

  const handleSaveImageSettings = () => {
    saveSettings({
      bridge_qq_image_enabled: imageEnabled ? "true" : "false",
      bridge_qq_max_image_size: maxImageSize,
    });
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      if (!appId) {
        setVerifyResult({
          ok: false,
          message: t("qq.enterCredentialsFirst"),
        });
        return;
      }

      const res = await fetch("/api/settings/qq/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          app_secret: appSecret,
        }),
      });
      const data = await res.json();

      if (data.verified) {
        setVerifyResult({
          ok: true,
          message: t("qq.verified"),
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || t("qq.verifyFailed"),
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: t("qq.verifyFailed") });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* App Credentials */}
      <SettingsCard
        title={t("qq.credentials")}
        description={t("qq.credentialsDesc")}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("qq.appId")}
            </label>
            <Input
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="xxxxxxxxxx"
              className="font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("qq.appSecret")}
            </label>
            <Input
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
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
            disabled={verifying || !appId}
          >
            {verifying ? (
              <SpinnerGap
                size={14}
                className="animate-spin mr-1.5"
              />
            ) : null}
            {t("qq.verify")}
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

      {/* Allowed Users */}
      <SettingsCard
        title={t("qq.allowedUsers")}
        description={t("qq.allowedUsersDesc")}
      >
        <div>
          <Input
            value={allowedUsers}
            onChange={(e) => setAllowedUsers(e.target.value)}
            placeholder="user_openid_1, user_openid_2"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t("qq.allowedUsersHint")}
          </p>
        </div>

        <Button size="sm" onClick={handleSaveAllowedUsers} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </SettingsCard>

      {/* Image Settings */}
      <SettingsCard
        title={t("qq.imageSettings")}
        description={t("qq.imageSettingsDesc")}
      >
        <div className="space-y-3">
          <FieldRow
            label={t("qq.imageEnabled")}
            description={t("qq.imageEnabledDesc")}
          >
            <Switch
              checked={imageEnabled}
              onCheckedChange={setImageEnabled}
            />
          </FieldRow>

          {imageEnabled && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("qq.maxImageSize")}
              </label>
              <Input
                type="number"
                value={maxImageSize}
                onChange={(e) => setMaxImageSize(e.target.value)}
                placeholder="20"
                className="w-32 text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("qq.maxImageSizeHint")}
              </p>
            </div>
          )}
        </div>

        <Button size="sm" onClick={handleSaveImageSettings} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </SettingsCard>

      {/* Setup Guide */}
      <SettingsCard title={t("qq.setupGuide")}>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
          <li>{t("qq.step1")}</li>
          <li>{t("qq.step2")}</li>
          <li>{t("qq.step3")}</li>
          <li>{t("qq.step4")}</li>
          <li>{t("qq.step5")}</li>
        </ol>
      </SettingsCard>
    </div>
  );
}
