"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { ReloadIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { useUpdate } from "@/hooks/useUpdate";

function UpdateCard() {
  const { updateInfo, checking, checkForUpdates } = useUpdate();
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

  return (
    <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">CodePilot</h2>
          <p className="text-xs text-muted-foreground">Version {currentVersion}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={checkForUpdates}
          disabled={checking}
          className="gap-2"
        >
          {checking ? (
            <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <HugeiconsIcon icon={ReloadIcon} className="h-3.5 w-3.5" />
          )}
          {checking ? "Checking..." : "Check for Updates"}
        </Button>
      </div>

      {updateInfo && !checking && (
        <div className="mt-3">
          {updateInfo.updateAvailable ? (
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              <span className="text-sm">
                Update available: <span className="font-medium">v{updateInfo.latestVersion}</span>
              </span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-sm"
                onClick={() => window.open(updateInfo.releaseUrl, "_blank")}
              >
                View Release
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">You&apos;re on the latest version.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function GeneralSection() {
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);

  const fetchAppSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const appSettings = data.settings || {};
        setSkipPermissions(appSettings.dangerously_skip_permissions === "true");
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAppSettings();
  }, [fetchAppSettings]);

  const handleSkipPermToggle = (checked: boolean) => {
    if (checked) {
      setShowSkipPermWarning(true);
    } else {
      saveSkipPermissions(false);
    }
  };

  const saveSkipPermissions = async (enabled: boolean) => {
    setSkipPermSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { dangerously_skip_permissions: enabled ? "true" : "" },
        }),
      });
      if (res.ok) {
        setSkipPermissions(enabled);
      }
    } catch {
      // ignore
    } finally {
      setSkipPermSaving(false);
      setShowSkipPermWarning(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <UpdateCard />

      {/* Auto-approve toggle */}
      <div className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${skipPermissions ? "border-orange-500/50 bg-orange-500/5" : "border-border/50"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">Auto-approve All Actions</h2>
            <p className="text-xs text-muted-foreground">
              Skip all permission checks and auto-approve every tool action.
              This is dangerous and should only be used for trusted tasks.
            </p>
          </div>
          <Switch
            checked={skipPermissions}
            onCheckedChange={handleSkipPermToggle}
            disabled={skipPermSaving}
          />
        </div>
        {skipPermissions && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-orange-500/10 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />
            All tool actions will be auto-approved without confirmation. Use with caution.
          </div>
        )}
      </div>

      {/* Skip-permissions warning dialog */}
      <AlertDialog open={showSkipPermWarning} onOpenChange={setShowSkipPermWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Auto-approve All Actions?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will bypass all permission checks. Claude will be able to
                  execute any tool action without asking for your confirmation,
                  including:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Running arbitrary shell commands</li>
                  <li>Reading, writing, and deleting files</li>
                  <li>Making network requests</li>
                </ul>
                <p className="font-medium text-orange-600 dark:text-orange-400">
                  Only enable this if you fully trust the task at hand. This
                  setting applies to all new chat sessions.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => saveSkipPermissions(true)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              Enable Auto-approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
