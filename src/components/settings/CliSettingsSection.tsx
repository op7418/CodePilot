"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  FloppyDisk,
  ArrowClockwise,
  Code,
  SlidersHorizontal,
  SpinnerGap,
} from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

interface SettingsData {
  [key: string]: unknown;
}

const KNOWN_FIELDS = [
  {
    key: "permissions",
    label: "Permissions",
    description: "Configure permission settings for Claude CLI",
    type: "object" as const,
  },
  {
    key: "env",
    label: "Environment Variables",
    description: "Environment variables passed to Claude",
    type: "object" as const,
  },
] as const;

export function CliSettingsSection() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [originalSettings, setOriginalSettings] = useState<SettingsData>({});
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingSaveAction, setPendingSaveAction] = useState<"form" | "json" | null>(null);
  const { t } = useTranslation();

  const knownFieldKeys: Record<string, { label: TranslationKey; description: TranslationKey }> = {
    permissions: { label: 'cli.permissions', description: 'cli.permissionsDesc' },
    env: { label: 'cli.envVars', description: 'cli.envVarsDesc' },
  };

  // Map dynamic CLI settings keys to translation keys (for fields not in KNOWN_FIELDS)
  const dynamicFieldLabels: Record<string, TranslationKey> = {
    skipDangerousModePermissionPrompt: 'cli.field.skipDangerousModePermissionPrompt',
    verbose: 'cli.field.verbose',
    theme: 'cli.field.theme',
  };

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        const s = data.settings || {};
        setSettings(s);
        setOriginalSettings(s);
        setJsonText(JSON.stringify(s, null, 2));
      }
    } catch {
      setSettings({});
      setOriginalSettings({});
      setJsonText("{}");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(originalSettings);

  const handleSave = async (source: "form" | "json") => {
    let dataToSave: SettingsData;

    if (source === "json") {
      try {
        dataToSave = JSON.parse(jsonText);
        setJsonError("");
      } catch {
        setJsonError("Invalid JSON format");
        return;
      }
    } else {
      dataToSave = settings;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: dataToSave }),
      });

      if (res.ok) {
        setSettings(dataToSave);
        setOriginalSettings(dataToSave);
        setJsonText(JSON.stringify(dataToSave, null, 2));
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      // Handle error silently
    } finally {
      setSaving(false);
      setShowConfirmDialog(false);
      setPendingSaveAction(null);
    }
  };

  const handleReset = () => {
    setSettings(originalSettings);
    setJsonText(JSON.stringify(originalSettings, null, 2));
    setJsonError("");
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch {
      setJsonError(t('cli.formatError'));
    }
  };

  const confirmSave = (source: "form" | "json") => {
    setPendingSaveAction(source);
    setShowConfirmDialog(true);
  };

  const updateField = (key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">{t('cli.loadingSettings')}</span>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <Tabs defaultValue="form">
        <TabsList className="mb-4">
          <TabsTrigger value="form" className="gap-2">
            <SlidersHorizontal size={16} />
            {t('cli.form')}
          </TabsTrigger>
          <TabsTrigger value="json" className="gap-2">
            <Code size={16} />
            {t('cli.json')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="form">
          <div className="space-y-6">
            {KNOWN_FIELDS.map((field) => (
              <div
                key={field.key}
                className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
              >
                <Label className="text-sm font-medium">{t(knownFieldKeys[field.key]?.label ?? field.label as TranslationKey)}</Label>
                <p className="mb-2 text-xs text-muted-foreground">{t(knownFieldKeys[field.key]?.description ?? field.description as TranslationKey)}</p>
                <Textarea
                  value={
                    typeof settings[field.key] === "object"
                      ? JSON.stringify(settings[field.key], null, 2)
                      : String(settings[field.key] ?? "")
                  }
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      updateField(field.key, parsed);
                    } catch {
                      updateField(field.key, e.target.value);
                    }
                  }}
                  className="font-mono text-sm"
                  rows={4}
                />
              </div>
            ))}

            {Object.entries(settings)
              .filter(([key]) => !KNOWN_FIELDS.some((f) => f.key === key))
              .map(([key, value]) => (
                <div
                  key={key}
                  className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
                >
                  <Label className="text-sm font-medium">{dynamicFieldLabels[key] ? t(dynamicFieldLabels[key]) : key}</Label>
                  {typeof value === "boolean" ? (
                    <div className="mt-2 flex items-center gap-2">
                      <Switch
                        checked={value}
                        onCheckedChange={(checked) => updateField(key, checked)}
                      />
                      <span className="text-sm text-muted-foreground">
                        {value ? t('common.enabled') : t('common.disabled')}
                      </span>
                    </div>
                  ) : typeof value === "string" ? (
                    <Input
                      value={value}
                      onChange={(e) => updateField(key, e.target.value)}
                      className="mt-2"
                    />
                  ) : (
                    <Textarea
                      value={JSON.stringify(value, null, 2)}
                      onChange={(e) => {
                        try {
                          updateField(key, JSON.parse(e.target.value));
                        } catch {
                          updateField(key, e.target.value);
                        }
                      }}
                      className="mt-2 font-mono text-sm"
                      rows={4}
                    />
                  )}
                </div>
              ))}

            <div className="flex items-center gap-3">
              <Button onClick={() => confirmSave("form")} disabled={!hasChanges || saving} className="gap-2">
                {saving ? (
                  <SpinnerGap size={16} className="animate-spin" />
                ) : (
                  <FloppyDisk size={16} />
                )}
                {saving ? t('provider.saving') : t('cli.save')}
              </Button>
              <Button variant="outline" onClick={handleReset} disabled={!hasChanges} className="gap-2">
                <ArrowClockwise size={16} />
                {t('cli.reset')}
              </Button>
              {saveSuccess && (
                <span className="text-sm text-status-success-foreground">
                  {t('cli.settingsSaved')}
                </span>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="json">
          <div className="space-y-4">
            <Textarea
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonError("");
              }}
              className="min-h-[400px] font-mono text-sm"
              placeholder='{"key": "value"}'
            />
            {jsonError && <p className="text-sm text-destructive">{jsonError}</p>}

            <div className="flex items-center gap-3">
              <Button onClick={() => confirmSave("json")} disabled={saving} className="gap-2">
                {saving ? (
                  <SpinnerGap size={16} className="animate-spin" />
                ) : (
                  <FloppyDisk size={16} />
                )}
                {saving ? t('provider.saving') : t('cli.save')}
              </Button>
              <Button variant="outline" onClick={handleFormatJson} className="gap-2">
                <Code size={16} />
                {t('cli.format')}
              </Button>
              <Button variant="outline" onClick={handleReset} className="gap-2">
                <ArrowClockwise size={16} />
                {t('cli.reset')}
              </Button>
              {saveSuccess && (
                <span className="text-sm text-status-success-foreground">
                  {t('cli.settingsSaved')}
                </span>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Confirmation dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cli.confirmSaveTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cli.confirmSaveDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingSaveAction && handleSave(pendingSaveAction)}>
              {t('common.save')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
