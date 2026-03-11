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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  CheckmarkCircle02Icon,
  Alert02Icon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";

interface FeishuBridgeSettings {
  bridge_feishu_app_id: string;
  bridge_feishu_app_secret: string;
  bridge_feishu_domain: string;
  bridge_feishu_mode: string;
  bridge_feishu_webhook_port: string;
  bridge_feishu_webhook_verification_token: string;
  bridge_feishu_allowed_users: string;
  bridge_feishu_group_policy: string;
  bridge_feishu_group_allow_from: string;
  bridge_feishu_require_mention: string;
}

const DEFAULT_SETTINGS: FeishuBridgeSettings = {
  bridge_feishu_app_id: "",
  bridge_feishu_app_secret: "",
  bridge_feishu_domain: "feishu",
  bridge_feishu_mode: "websocket",
  bridge_feishu_webhook_port: "9898",
  bridge_feishu_webhook_verification_token: "",
  bridge_feishu_allowed_users: "",
  bridge_feishu_group_policy: "open",
  bridge_feishu_group_allow_from: "",
  bridge_feishu_require_mention: "false",
};

export function FeishuBridgeSection() {
  const [, setSettings] =
    useState<FeishuBridgeSettings>(DEFAULT_SETTINGS);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [domain, setDomain] = useState("feishu");
  const [mode, setMode] = useState("websocket");
  const [webhookPort, setWebhookPort] = useState("9898");
  const [verificationToken, setVerificationToken] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [groupPolicy, setGroupPolicy] = useState("open");
  const [groupAllowFrom, setGroupAllowFrom] = useState("");
  const [requireMention, setRequireMention] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const { t } = useTranslation();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/feishu");
      if (res.ok) {
        const data = await res.json();
        const s = { ...DEFAULT_SETTINGS, ...data.settings };
        setSettings(s);
        setAppId(s.bridge_feishu_app_id);
        setAppSecret(s.bridge_feishu_app_secret);
        setDomain(s.bridge_feishu_domain || "feishu");
        setMode(s.bridge_feishu_mode || "websocket");
        setWebhookPort(s.bridge_feishu_webhook_port || "9898");
        setVerificationToken(s.bridge_feishu_webhook_verification_token || "");
        setAllowedUsers(s.bridge_feishu_allowed_users);
        setGroupPolicy(s.bridge_feishu_group_policy || "open");
        setGroupAllowFrom(s.bridge_feishu_group_allow_from);
        setRequireMention(s.bridge_feishu_require_mention === "true");
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async (updates: Partial<FeishuBridgeSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/feishu", {
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
    const updates: Partial<FeishuBridgeSettings> = {
      bridge_feishu_app_id: appId,
      bridge_feishu_domain: domain,
      bridge_feishu_mode: mode,
      bridge_feishu_webhook_port: webhookPort,
    };
    if (appSecret && !appSecret.startsWith("***")) {
      updates.bridge_feishu_app_secret = appSecret;
    }
    if (verificationToken && !verificationToken.startsWith("***")) {
      updates.bridge_feishu_webhook_verification_token = verificationToken;
    }
    saveSettings(updates);
  };

  const handleSaveGroupSettings = () => {
    saveSettings({
      bridge_feishu_allowed_users: allowedUsers,
      bridge_feishu_group_policy: groupPolicy,
      bridge_feishu_group_allow_from: groupAllowFrom,
      bridge_feishu_require_mention: requireMention ? "true" : "false",
    });
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      if (!appId) {
        setVerifyResult({
          ok: false,
          message: t("feishu.enterCredentialsFirst"),
        });
        return;
      }

      const res = await fetch("/api/settings/feishu/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          app_secret: appSecret,
          domain,
        }),
      });
      const data = await res.json();

      if (data.verified) {
        setVerifyResult({
          ok: true,
          message: data.botName
            ? t("feishu.verifiedAs", { name: data.botName })
            : t("feishu.verified"),
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || t("feishu.verifyFailed"),
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: t("feishu.verifyFailed") });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* App Credentials */}
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("feishu.credentials")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("feishu.credentialsDesc")}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("feishu.appId")}
            </label>
            <Input
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="cli_xxxxxxxxxx"
              className="font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("feishu.appSecret")}
            </label>
            <Input
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
              className="font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("feishu.domain")}
            </label>
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feishu">
                  {t("feishu.domainFeishu")}
                </SelectItem>
                <SelectItem value="lark">
                  {t("feishu.domainLark")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {t("feishu.domainHint")}
            </p>
          </div>

          {/* Connection Mode */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("feishu.mode")}
            </label>
            <Select value={mode} onValueChange={(v) => {
              setMode(v);
              if (v === 'webhook' && domain === 'feishu') {
                setDomain('lark');
              }
            }}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="websocket">
                  {t("feishu.modeWebsocket")}
                </SelectItem>
                <SelectItem value="webhook">
                  {t("feishu.modeWebhook")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {t("feishu.modeHint")}
            </p>
          </div>

          {mode === "webhook" && (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {t("feishu.webhookPort")}
                </label>
                <Input
                  value={webhookPort}
                  onChange={(e) => setWebhookPort(e.target.value)}
                  placeholder="9898"
                  className="font-mono text-sm w-32"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t("feishu.webhookPortDesc")}
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {t("feishu.verificationToken")}
                </label>
                <Input
                  type="password"
                  value={verificationToken}
                  onChange={(e) => setVerificationToken(e.target.value)}
                  placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t("feishu.verificationTokenDesc")}
                </p>
              </div>
            </>
          )}
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
              <HugeiconsIcon
                icon={Loading02Icon}
                className="h-3.5 w-3.5 animate-spin mr-1.5"
              />
            ) : null}
            {t("feishu.verify")}
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
            <HugeiconsIcon
              icon={verifyResult.ok ? CheckmarkCircle02Icon : Alert02Icon}
              className="h-4 w-4 shrink-0"
            />
            {verifyResult.message}
          </div>
        )}
      </div>

      {/* Allowed Users */}
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">
            {t("feishu.allowedUsers")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("feishu.allowedUsersDesc")}
          </p>
        </div>

        <div>
          <Input
            value={allowedUsers}
            onChange={(e) => setAllowedUsers(e.target.value)}
            placeholder="ou_xxxxxxxxxx, ou_yyyyyyyyyy"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t("feishu.allowedUsersHint")}
          </p>
        </div>
      </div>

      {/* Group Chat Settings */}
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">
            {t("feishu.groupSettings")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("feishu.groupSettingsDesc")}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("feishu.groupPolicy")}
            </label>
            <Select value={groupPolicy} onValueChange={setGroupPolicy}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">
                  {t("feishu.groupPolicyOpen")}
                </SelectItem>
                <SelectItem value="allowlist">
                  {t("feishu.groupPolicyAllowlist")}
                </SelectItem>
                <SelectItem value="disabled">
                  {t("feishu.groupPolicyDisabled")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {groupPolicy === "allowlist" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("feishu.groupAllowFrom")}
              </label>
              <Input
                value={groupAllowFrom}
                onChange={(e) => setGroupAllowFrom(e.target.value)}
                placeholder="oc_xxxxxxxxxx, oc_yyyyyyyyyy"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("feishu.groupAllowFromHint")}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">{t("feishu.requireMention")}</p>
              <p className="text-xs text-muted-foreground">
                {t("feishu.requireMentionDesc")}
              </p>
            </div>
            <Switch
              checked={requireMention}
              onCheckedChange={setRequireMention}
            />
          </div>
        </div>

        <Button size="sm" onClick={handleSaveGroupSettings} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </div>

      {/* Setup Guide */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <h2 className="text-sm font-medium mb-2">
          {mode === "webhook" ? t("feishu.webhookSetupGuide") : t("feishu.setupGuide")}
        </h2>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
          {mode === "webhook" ? (
            <>
              <li>{t("feishu.webhookStep1")}</li>
              <li>{t("feishu.webhookStep2")}</li>
              <li>{t("feishu.webhookStep3")}</li>
              <li>{t("feishu.webhookStep4")}</li>
            </>
          ) : (
            <>
              <li>{t("feishu.step1")}</li>
              <li>{t("feishu.step2")}</li>
              <li>{t("feishu.step3")}</li>
              <li>{t("feishu.step4")}</li>
              <li>{t("feishu.step5")}</li>
              <li>{t("feishu.step6")}</li>
            </>
          )}
        </ol>
      </div>
    </div>
  );
}
