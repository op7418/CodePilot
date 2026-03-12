"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpinnerGap, CheckCircle, Warning } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { SettingsCard } from "@/components/patterns/SettingsCard";
import { StatusBanner } from "@/components/patterns/StatusBanner";

interface TelegramBridgeSettings {
  telegram_bot_token: string;
  telegram_chat_id: string;
  telegram_bridge_allowed_users: string;
}

const DEFAULT_SETTINGS: TelegramBridgeSettings = {
  telegram_bot_token: "",
  telegram_chat_id: "",
  telegram_bridge_allowed_users: "",
};

export function TelegramBridgeSection() {
  const [, setSettings] = useState<TelegramBridgeSettings>(DEFAULT_SETTINGS);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const { t } = useTranslation();

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/telegram");
      if (res.ok) {
        const data = await res.json();
        const s = { ...DEFAULT_SETTINGS, ...data.settings };
        setSettings(s);
        setBotToken(s.telegram_bot_token);
        setChatId(s.telegram_chat_id);
        setAllowedUsers(s.telegram_bridge_allowed_users);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async (updates: Partial<TelegramBridgeSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/telegram", {
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
    const updates: Partial<TelegramBridgeSettings> = {};
    if (botToken && !botToken.startsWith("***")) {
      updates.telegram_bot_token = botToken;
    }
    updates.telegram_chat_id = chatId;
    updates.telegram_bridge_allowed_users = allowedUsers;
    saveSettings(updates);
  };

  const handleDetectChatId = async () => {
    if (!botToken) {
      setVerifyResult({
        ok: false,
        message: t("telegram.enterTokenFirst"),
      });
      return;
    }

    setDetecting(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/settings/telegram/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "detect_chat_id",
          bot_token: botToken,
        }),
      });
      const data = await res.json();

      if (data.ok && data.chatId) {
        setChatId(data.chatId);
        setVerifyResult({
          ok: true,
          message: t("telegram.chatIdDetected", {
            id: data.chatId,
            name: data.chatTitle || data.chatId,
          }),
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || t("telegram.chatIdDetectFailed"),
        });
      }
    } catch {
      setVerifyResult({
        ok: false,
        message: t("telegram.chatIdDetectFailed"),
      });
    } finally {
      setDetecting(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      if (!botToken) {
        setVerifyResult({
          ok: false,
          message: t("telegram.enterTokenFirst"),
        });
        return;
      }

      const res = await fetch("/api/settings/telegram/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_token: botToken,
          chat_id: chatId || undefined,
        }),
      });
      const data = await res.json();

      if (data.verified) {
        setVerifyResult({
          ok: true,
          message: data.botName
            ? t("telegram.verifiedAs", { name: data.botName })
            : t("telegram.verified"),
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || t("telegram.verifyFailed"),
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: t("telegram.verifyFailed") });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* Bot Credentials */}
      <SettingsCard
        title={t("telegram.credentials")}
        description={t("telegram.credentialsDesc")}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("telegram.botToken")}
            </label>
            <Input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-DEF..."
              className="font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("telegram.chatId")}
            </label>
            <div className="flex gap-2">
              <Input
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="-1001234567890"
                className="font-mono text-sm"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleDetectChatId}
                disabled={detecting || !botToken}
                className="shrink-0"
              >
                {detecting ? (
                  <SpinnerGap
                    size={14}
                    className="animate-spin mr-1.5"
                  />
                ) : null}
                {t("telegram.detectChatId")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("telegram.chatIdHint")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveCredentials}
            disabled={saving}
          >
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
            {t("telegram.verify")}
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
        title={t("bridge.allowedUsers")}
        description={t("bridge.allowedUsersDesc")}
      >
        <div>
          <Input
            value={allowedUsers}
            onChange={(e) => setAllowedUsers(e.target.value)}
            placeholder="123456789, 987654321"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t("bridge.allowedUsersHint")}
          </p>
        </div>
      </SettingsCard>

      {/* Setup Guide */}
      <SettingsCard title={t("telegram.setupGuide")}>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
          <li>{t("telegram.step1")}</li>
          <li>{t("telegram.step2")}</li>
          <li>{t("telegram.step3")}</li>
          <li>{t("telegram.step4")}</li>
          <li>{t("telegram.step5")}</li>
          <li>{t("telegram.step6")}</li>
        </ol>
      </SettingsCard>
    </div>
  );
}
