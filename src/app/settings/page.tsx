"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  ReloadIcon,
  CodeIcon,
  SlidersHorizontalIcon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";

interface SettingsData {
  [key: string]: unknown;
}

// Structured known fields from ~/.claude/settings.json
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

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SettingsPageInner />
    </Suspense>
  );
}

// --- API Configuration Section (CodePilot app settings, stored in SQLite) ---
function ApiConfigSection() {
  const [provider, setProvider] = useState<"claude_code" | "openrouter">("claude_code");
  // Claude Code settings
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  // OpenRouter settings
  const [orApiKey, setOrApiKey] = useState("");
  const [orBaseUrl, setOrBaseUrl] = useState("");
  const [orModel, setOrModel] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    fetch("/api/settings/app")
      .then((r) => r.json())
      .then((data) => {
        const s = data.settings || {};
        setProvider((s.api_provider as "claude_code" | "openrouter") || "claude_code");
        setToken(s.anthropic_auth_token || "");
        setBaseUrl(s.anthropic_base_url || "");
        setOrApiKey(s.openrouter_api_key || "");
        setOrBaseUrl(s.openrouter_base_url || "");
        setOrModel(s.openrouter_model || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatus("idle");
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            api_provider: provider,
            anthropic_auth_token: token,
            anthropic_base_url: baseUrl,
            openrouter_api_key: orApiKey,
            openrouter_base_url: orBaseUrl,
            openrouter_model: orModel,
          },
        }),
      });
      if (res.ok) {
        setStatus("saved");
        // Dispatch event so other components (e.g. MessageInput) can react
        window.dispatchEvent(new CustomEvent("provider-changed", { detail: { provider } }));
        setTimeout(() => setStatus("idle"), 2000);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-4">
      <div>
        <Label className="text-sm font-medium">API Configuration</Label>
        <p className="text-xs text-muted-foreground">
          Choose your API provider and configure the connection settings.
        </p>
      </div>

      {/* Provider selector */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Provider</Label>
        <div className="flex gap-2">
          <button
            onClick={() => setProvider("claude_code")}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
              provider === "claude_code"
                ? "border-primary bg-primary/10 text-primary font-medium"
                : "border-border hover:border-primary/50"
            }`}
          >
            <div className="font-medium">Claude Code</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Uses Claude CLI (requires claude login)
            </div>
          </button>
          <button
            onClick={() => setProvider("openrouter")}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
              provider === "openrouter"
                ? "border-primary bg-primary/10 text-primary font-medium"
                : "border-border hover:border-primary/50"
            }`}
          >
            <div className="font-medium">OpenRouter</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              OpenAI-compatible API, supports many models
            </div>
          </button>
        </div>
      </div>

      {/* Claude Code settings */}
      {provider === "claude_code" && (
        <div className="space-y-3 rounded-lg border border-border/30 p-3">
          <p className="text-xs text-muted-foreground">
            Optional. Leave empty to use default authentication (claude login).
          </p>
          <div>
            <Label htmlFor="api-base-url" className="text-xs text-muted-foreground">
              API Base URL
            </Label>
            <Input
              id="api-base-url"
              placeholder="https://api.anthropic.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div>
            <Label htmlFor="api-token" className="text-xs text-muted-foreground">
              API Token (ANTHROPIC_AUTH_TOKEN)
            </Label>
            <Input
              id="api-token"
              type="password"
              placeholder="sk-ant-..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
        </div>
      )}

      {/* OpenRouter settings */}
      {provider === "openrouter" && (
        <div className="space-y-3 rounded-lg border border-border/30 p-3">
          <p className="text-xs text-muted-foreground">
            Configure your OpenRouter API key. Get one at{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              openrouter.ai/keys
            </a>
          </p>
          <div>
            <Label htmlFor="or-api-key" className="text-xs text-muted-foreground">
              API Key
            </Label>
            <Input
              id="or-api-key"
              type="password"
              placeholder="sk-or-v1-..."
              value={orApiKey}
              onChange={(e) => setOrApiKey(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div>
            <Label htmlFor="or-base-url" className="text-xs text-muted-foreground">
              Base URL (optional)
            </Label>
            <Input
              id="or-base-url"
              placeholder="https://openrouter.ai/api/v1"
              value={orBaseUrl}
              onChange={(e) => setOrBaseUrl(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div>
            <Label htmlFor="or-model" className="text-xs text-muted-foreground">
              Default Model
            </Label>
            <Input
              id="or-model"
              placeholder="anthropic/claude-sonnet-4"
              value={orModel}
              onChange={(e) => setOrModel(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Browse models at{" "}
              <a
                href="https://openrouter.ai/models"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                openrouter.ai/models
              </a>
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving} size="sm" className="gap-2">
          {saving ? (
            <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
          ) : (
            <HugeiconsIcon icon={FloppyDiskIcon} className="h-4 w-4" />
          )}
          {saving ? "Saving..." : "Save API Config"}
        </Button>
        {status === "saved" && (
          <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
        )}
        {status === "error" && (
          <span className="text-sm text-destructive">Failed to save</span>
        )}
      </div>
    </div>
  );
}

// --- Claude CLI Settings Section (manages ~/.claude/settings.json) ---
function SettingsPageInner() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [originalSettings, setOriginalSettings] = useState<SettingsData>({});
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingSaveAction, setPendingSaveAction] = useState<
    "form" | "json" | null
  >(null);

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

  const hasChanges =
    JSON.stringify(settings) !== JSON.stringify(originalSettings);

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
      setJsonError("Cannot format: invalid JSON");
    }
  };

  const confirmSave = (source: "form" | "json") => {
    setPendingSaveAction(source);
    setShowConfirmDialog(true);
  };

  const updateField = (key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage CodePilot and Claude CLI settings
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl space-y-6">
          <ApiConfigSection />

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                Loading settings...
              </span>
            </div>
          ) : (
            <Tabs defaultValue="form">
              <TabsList className="mb-4">
                <TabsTrigger value="form" className="gap-2">
                  <HugeiconsIcon icon={SlidersHorizontalIcon} className="h-4 w-4" />
                  Visual Editor
                </TabsTrigger>
                <TabsTrigger value="json" className="gap-2">
                  <HugeiconsIcon icon={CodeIcon} className="h-4 w-4" />
                  JSON Editor
                </TabsTrigger>
              </TabsList>

              <TabsContent value="form">
                <div className="space-y-6">
                  {KNOWN_FIELDS.map((field) => (
                    <div
                      key={field.key}
                      className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
                    >
                      <Label className="text-sm font-medium">
                        {field.label}
                      </Label>
                      <p className="mb-2 text-xs text-muted-foreground">
                        {field.description}
                      </p>
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
                    .filter(
                      ([key]) => !KNOWN_FIELDS.some((f) => f.key === key)
                    )
                    .map(([key, value]) => (
                      <div
                        key={key}
                        className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
                      >
                        <Label className="text-sm font-medium">{key}</Label>
                        {typeof value === "boolean" ? (
                          <div className="mt-2 flex items-center gap-2">
                            <Switch
                              checked={value}
                              onCheckedChange={(checked) =>
                                updateField(key, checked)
                              }
                            />
                            <span className="text-sm text-muted-foreground">
                              {value ? "Enabled" : "Disabled"}
                            </span>
                          </div>
                        ) : typeof value === "string" ? (
                          <Input
                            value={value}
                            onChange={(e) =>
                              updateField(key, e.target.value)
                            }
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
                    <Button
                      onClick={() => confirmSave("form")}
                      disabled={!hasChanges || saving}
                      className="gap-2"
                    >
                      {saving ? (
                        <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                      ) : (
                        <HugeiconsIcon icon={FloppyDiskIcon} className="h-4 w-4" />
                      )}
                      {saving ? "Saving..." : "Save Changes"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleReset}
                      disabled={!hasChanges}
                      className="gap-2"
                    >
                      <HugeiconsIcon icon={ReloadIcon} className="h-4 w-4" />
                      Reset
                    </Button>
                    {saveSuccess && (
                      <span className="text-sm text-green-600 dark:text-green-400">
                        Settings saved successfully
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
                  {jsonError && (
                    <p className="text-sm text-destructive">{jsonError}</p>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      onClick={() => confirmSave("json")}
                      disabled={saving}
                      className="gap-2"
                    >
                      {saving ? (
                        <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                      ) : (
                        <HugeiconsIcon icon={FloppyDiskIcon} className="h-4 w-4" />
                      )}
                      {saving ? "Saving..." : "Save JSON"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleFormatJson}
                      className="gap-2"
                    >
                      <HugeiconsIcon icon={CodeIcon} className="h-4 w-4" />
                      Format
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleReset}
                      className="gap-2"
                    >
                      <HugeiconsIcon icon={ReloadIcon} className="h-4 w-4" />
                      Reset
                    </Button>
                    {saveSuccess && (
                      <span className="text-sm text-green-600 dark:text-green-400">
                        Settings saved successfully
                      </span>
                    )}
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>

      {/* Confirmation dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Save</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite your current ~/.claude/settings.json file. Are
              you sure you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingSaveAction && handleSave(pendingSaveAction)}
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
