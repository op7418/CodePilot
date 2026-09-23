"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SpinnerGap } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { SettingsCard } from "@/components/patterns/SettingsCard";
import type { WorkspaceInspectResult } from "@/types";
import { FilesTabPanel, TaxonomyTabPanel, IndexTabPanel, OrganizeTabPanel } from "./WorkspaceTabPanels";
import { WorkspaceConfirmDialogs, type ConfirmDialogType } from "./WorkspaceConfirmDialogs";
import { OnboardingCard, CheckInCard } from "./WorkspaceStatusCards";
import { OnboardingWizard } from "@/components/assistant/OnboardingWizard";
import { AssistantAvatar } from "@/components/ui/AssistantAvatar";
import { MemoryRecordsPanel } from "./MemoryRecordsPanel";
import type { TranslationKey } from "@/i18n/en";
import type { TaxonomyCategoryInfo, IndexStats, WorkspaceInfo, TabId } from "./workspace-types";

interface WorkspaceSummary {
  configured: boolean;
  name?: string;
  styleHint?: string;
  buddy?: {
    species: string;
    rarity: string;
    stats: Record<string, number>;
    emoji: string;
    peakStat: string;
    hatchedAt: string;
  };
}

export function AssistantWorkspaceSection() {
  const { t } = useTranslation();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [refreshingDocs, setRefreshingDocs] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>('files');
  const [taxonomy, setTaxonomy] = useState<TaxonomyCategoryInfo[]>([]);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogType | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // Web fallback for the native folder picker. Used when window.electronAPI
  // isn't available (e.g. running the Next.js dev server in a browser tab).
  // In Electron proper, handleSelectFolder always takes the electronAPI
  // branch and this dialog is never shown.
  const [pathPromptOpen, setPathPromptOpen] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [runningHeartbeat, setRunningHeartbeat] = useState(false);
  const [testingNotification, setTestingNotification] = useState(false);
  const [testNotificationStatus, setTestNotificationStatus] = useState<{
    status: 'queued' | 'delivered' | 'error';
    error?: string | null;
    attemptCount?: number;
    acceptedAt?: string | null;
  } | null>(null);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);

  const fetchWorkspace = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/workspace");
      if (res.ok) {
        const data = await res.json();
        setWorkspace(data);
        if (data.path) setPathInput(data.path);
      }
    } catch (e) {
      console.error("Failed to fetch workspace:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/summary");
      if (res.ok) {
        const data = await res.json();
        setSummary(data);
      }
    } catch { /* ignore */ }
  }, []);

  const handleTestNotification = useCallback(async () => {
    setTestingNotification(true);
    setTestNotificationStatus(null);
    try {
      const created = await fetch('/api/tasks/notify/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!created.ok) throw new Error(`HTTP ${created.status}`);
      const payload = await created.json() as { event_id: string };
      setTestNotificationStatus({ status: 'queued' });

      // Electron Main polls every two seconds. Keep this bounded and report
      // only the durable row's real terminal state; a timeout remains queued.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await fetch(
          `/api/tasks/notify/test?event_id=${encodeURIComponent(payload.event_id)}`,
        );
        if (!response.ok) continue;
        const result = await response.json() as {
          delivery?: {
            status: string;
            error?: string | null;
            attempt_count?: number;
            acked_at?: string | null;
          } | null;
        };
        const delivery = result.delivery;
        if (delivery?.status === 'delivered' || delivery?.status === 'error') {
          setTestNotificationStatus({
            status: delivery.status,
            error: delivery.error,
            attemptCount: delivery.attempt_count,
            acceptedAt: delivery.acked_at,
          });
          return;
        }
      }
    } catch (error) {
      setTestNotificationStatus({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingNotification(false);
    }
  }, []);

  const fetchTaxonomy = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/workspace");
      if (res.ok) {
        const data = await res.json();
        if (data.taxonomy) setTaxonomy(data.taxonomy);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchIndexStats = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/index");
      if (res.ok) {
        const data = await res.json();
        setIndexStats(data);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchWorkspace();
  }, [fetchWorkspace]);

  useEffect(() => {
    if (workspace?.path && workspace.valid !== false) {
      fetchSummary();
    }
  }, [workspace?.path, workspace?.valid, fetchSummary]);

  useEffect(() => {
    if (workspace?.path && activeTab === 'taxonomy') fetchTaxonomy();
    if (workspace?.path && activeTab === 'index') fetchIndexStats();
  }, [workspace?.path, activeTab, fetchTaxonomy, fetchIndexStats]);

  // Execute the actual save + optional auto-navigate
  const executeSave = useCallback(async (initialize: boolean, resetOnboarding?: boolean, navigateMode: 'new' | 'reuse' = 'new') => {
    if (!pathInput.trim()) return;
    const oldPath = workspace?.path || null;
    const newPath = pathInput.trim();
    if (initialize) setInitializing(true);
    try {
      const body: Record<string, unknown> = { path: newPath, initialize };
      if (resetOnboarding) body.resetOnboarding = true;
      const res = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await fetchWorkspace();

        if (oldPath && oldPath !== newPath) {
          window.dispatchEvent(new CustomEvent('assistant-workspace-switched', {
            detail: { oldPath, newPath },
          }));
        }

        try {
          const model = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') || '' : '';
          const provider_id = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') || '' : '';
          const sessionMode = navigateMode === 'reuse' ? 'checkin' : 'onboarding';
          const sessionRes = await fetch("/api/workspace/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: sessionMode, model, provider_id }),
          });
          if (sessionRes.ok) {
            const sessionData = await sessionRes.json();
            window.dispatchEvent(new CustomEvent("session-created"));
            router.push(`/chat/${sessionData.session.id}`);
          }
        } catch (navErr) {
          console.error("Failed to auto-navigate to session:", navErr);
        }
      }
    } catch (e) {
      console.error("Failed to save workspace path:", e);
    } finally {
      setInitializing(false);
      setConfirmDialog(null);
    }
  }, [pathInput, fetchWorkspace, workspace?.path, router]);

  // Inspect the freshly-picked path before any workspace setting changes.
  const handleSaveClick = useCallback(async (explicitPath?: string) => {
    const target = (explicitPath ?? pathInput).trim();
    if (!target) return;
    if (target === workspace?.path) return;

    setInspecting(true);
    setPathError(null);
    try {
      const res = await fetch(`/api/workspace/inspect?path=${encodeURIComponent(target)}`);
      if (!res.ok) {
        setPathError(t('assistant.inspectFailed'));
        return;
      }
      const data: WorkspaceInspectResult = await res.json();

      if (!data.exists) {
        setConfirmDialog({ kind: 'not_found' });
        return;
      }
      if (!data.isDirectory) {
        setPathError(t('assistant.pathNotDirectory'));
        return;
      }
      if (!data.readable) {
        setPathError(t('assistant.pathNotReadable'));
        return;
      }
      if (!data.writable) {
        setPathError(t('assistant.pathNotWritable'));
        return;
      }

      switch (data.workspaceStatus) {
        case 'empty':
          setConfirmDialog({ kind: 'empty' });
          break;
        case 'normal_directory':
          setConfirmDialog({ kind: 'normal_directory' });
          break;
        case 'existing_workspace':
          setConfirmDialog({
            kind: 'existing_workspace',
            summary: data.summary || { onboardingComplete: false, lastHeartbeatDate: null, fileCount: 0 },
          });
          break;
        case 'partial_workspace':
          setConfirmDialog({ kind: 'partial_workspace' });
          break;
        default:
          setPathError(t('assistant.pathInvalid'));
      }
    } catch (e) {
      console.error("Failed to inspect workspace:", e);
      setPathError(t('assistant.inspectFailed'));
    } finally {
      setInspecting(false);
    }
  }, [pathInput, workspace?.path, t]);

  const handleSelectFolder = useCallback(async () => {
    try {
      if (window.electronAPI?.dialog?.openFolder) {
        const result = await window.electronAPI.dialog.openFolder({ title: t('assistant.selectFolder') });
        if (!result.canceled && result.filePaths[0]) {
          const picked = result.filePaths[0];
          setPathInput(picked);
          // The pre-picker warning has already been accepted. Keep the
          // target-specific empty / partial / existing-workspace safety
          // check before changing the persisted workspace.
          handleSaveClick(picked);
        }
      } else {
        // Web fallback (no Electron) — open the PromptDialog. Previously
        // used window.prompt(), which throws TypeError in Electron renderers
        // (see docs/exec-plans/active/v0.48-post-release-issues.md §5.6).
        setPathPromptOpen(true);
      }
    } catch (e) {
      console.error("Failed to select folder:", e);
    }
  }, [handleSaveClick, t]);

  const handleRequestFolderChange = useCallback(() => {
    setPathError(null);
    setConfirmDialog({ kind: 'switch_path' });
  }, []);

  const handleConfirmFolderChange = useCallback(() => {
    // Close the in-app alert before opening the native modal. Deferring by
    // one task also prevents Radix's close callback from clearing the
    // target-specific confirmation created after the user picks a folder.
    setConfirmDialog(null);
    window.setTimeout(() => { void handleSelectFolder(); }, 0);
  }, [handleSelectFolder]);

  const handleRefreshDocs = useCallback(async () => {
    setRefreshingDocs(true);
    try {
      await fetch("/api/workspace/docs", { method: "POST" });
    } catch (e) {
      console.error("Failed to refresh docs:", e);
    } finally {
      setRefreshingDocs(false);
    }
  }, []);

  const handleStartOnboarding = useCallback(() => {
    if (workspace?.path) {
      setShowWizard(true);
    }
  }, [workspace?.path]);
  // handleStartCheckIn removed — heartbeat triggers automatically on session open

  const handleReindex = useCallback(async () => {
    setReindexing(true);
    try {
      await fetch("/api/workspace/index", { method: "POST" });
      await fetchIndexStats();
    } catch (e) {
      console.error("Failed to reindex:", e);
    } finally {
      setReindexing(false);
    }
  }, [fetchIndexStats]);

  const handleArchive = useCallback(async () => {
    setArchiving(true);
    try {
      await fetch("/api/workspace/organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: 'archive' }),
      });
    } catch (e) {
      console.error("Failed to archive:", e);
    } finally {
      setArchiving(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }


  const defaultTab: { id: TabId; label: string } = { id: 'files', label: t('assistant.fileStatus') };
  const advancedTabs: Array<{ id: TabId; label: string }> = [
    { id: 'taxonomy', label: t('assistant.taxonomyTitle') },
    { id: 'index', label: t('assistant.indexTitle') },
    { id: 'organize', label: t('assistant.organizeTitle') },
  ];

  const assistantName = summary?.name || t('assistant.defaultName');

  const currentPath = workspace?.path || "";

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page title — matches the style of other Settings sub-pages. */}
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('settings.assistant' as TranslationKey)}</h2>
      </div>
      {/* The workspace is an identity boundary, not a recent-project
          selector. Show the active source of truth and make replacement an
          explicit, warned action followed by the native folder picker. */}
      <SettingsCard
        title={t('assistant.workspacePath')}
        description={t('assistant.workspacePathHint')}
      >
        <div className="space-y-3">
          <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2.5">
            <p className="text-xs font-mono leading-5 break-all text-foreground">
              {currentPath || t('assistant.pathNotSet')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleRequestFolderChange} disabled={inspecting}>
            {inspecting ? (
              <SpinnerGap size={14} className="animate-spin" />
            ) : null}
            {t('assistant.changeWorkspacePath')}
          </Button>
        </div>
        {pathError && (
          <p className="text-xs text-status-error-foreground mt-1">{pathError}</p>
        )}
      </SettingsCard>

      {/* Invalid workspace path warning */}
      {workspace?.path && workspace.valid === false && (
        <div className="rounded-lg border border-status-error-border bg-status-error-muted p-4">
          <p className="text-sm text-status-error-foreground">
            {t('assistant.workspaceInvalid')}: {workspace.reason === 'path_not_found'
              ? t('assistant.pathNotExist')
              : workspace.reason === 'not_a_directory'
              ? t('assistant.pathNotDirectory')
              : workspace.reason === 'not_readable'
              ? t('assistant.pathNotReadable')
              : workspace.reason === 'not_writable'
              ? t('assistant.pathNotWritable')
              : t('assistant.pathInvalid')
            }
          </p>
        </div>
      )}

      {workspace?.path
        && workspace.valid !== false
        && (workspace.instructionMirrors?.conflicts.length ?? 0) > 0 && (
        <div className="rounded-lg border border-status-warning-border bg-status-warning-muted p-4">
          <p className="text-sm font-medium text-status-warning-foreground">
            {t('assistant.rulesMirrorConflictTitle')}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('assistant.rulesMirrorConflictDesc')}
          </p>
          <p className="mt-2 text-xs font-medium text-status-warning-foreground">
            {workspace.instructionMirrors?.conflicts.join(' · ')}
          </p>
        </div>
      )}

      {/* Onboarding Status Card */}
      {workspace?.path && workspace.valid !== false && (
        <OnboardingCard
          onboardingComplete={!!workspace.state?.onboardingComplete}
          creatingSession={false}
          onStartOnboarding={handleStartOnboarding}
        />
      )}

      {/* Personality / Buddy Preview */}
      {workspace?.path && workspace.valid !== false && summary?.configured && (
        <SettingsCard title={t('assistant.personality')}>
          <div className="flex items-center gap-3">
            <span className="text-3xl">{summary?.buddy?.emoji || '🥚'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium truncate">{assistantName}</p>
                {summary?.buddy && (
                  <span className="text-[10px] text-muted-foreground">
                    {summary.buddy.rarity === 'common' ? '★' : summary.buddy.rarity === 'uncommon' ? '★★' : summary.buddy.rarity === 'rare' ? '★★★' : summary.buddy.rarity === 'epic' ? '★★★★' : '★★★★★'}
                  </span>
                )}
              </div>
              {summary.styleHint && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{summary.styleHint}</p>
              )}
            </div>
          </div>
          {!summary?.buddy && (
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-3 gap-2"
              onClick={async () => {
                try {
                  await fetch('/api/workspace/hatch-buddy', { method: 'POST' });
                  fetchSummary();
                } catch { /* ignore */ }
              }}
            >
              🥚 {t('buddy.hatch')}
            </Button>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t('assistant.editSoulHint')}
          </p>
        </SettingsCard>
      )}

      {/* Heartbeat is optional and independent from onboarding. */}
      {workspace?.path && workspace.valid !== false && workspace.state && (
        <CheckInCard
          autoTriggerEnabled={workspace.state?.heartbeatEnabled === true}
          onAutoTriggerChange={async (enabled) => {
            try {
              const res = await fetch('/api/settings/workspace', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ heartbeatEnabled: enabled }),
              });
              if (!res.ok) return; // don't flip UI on failure
              await fetchWorkspace();
            } catch { /* network error — leave UI unchanged */ }
          }}
          intervalHours={workspace.state?.heartbeatIntervalHours ?? 24}
          onIntervalChange={async (hours) => {
            try {
              const res = await fetch('/api/settings/workspace', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ heartbeatIntervalHours: hours }),
              });
              if (!res.ok) return;
              await fetchWorkspace();
            } catch { /* network error — leave UI unchanged */ }
          }}
          heartbeatStatus={workspace.heartbeat}
          runningNow={runningHeartbeat}
          onRunNow={workspace.heartbeat?.taskId ? async () => {
            setRunningHeartbeat(true);
            try {
              await fetch(`/api/tasks/${workspace.heartbeat!.taskId}/run`, { method: 'POST' });
              await fetchWorkspace();
            } finally {
              setRunningHeartbeat(false);
            }
          } : undefined}
          onTestNotification={handleTestNotification}
          testingNotification={testingNotification}
          testNotificationStatus={testNotificationStatus}
        />
      )}

      {/* v12 — Scheduled tasks block removed entirely.
          Phase 3 IA: Settings → Tasks (`/settings/tasks`) is the
          single home for all scheduled tasks (list + run + pause +
          delete + delivery log). The Assistant page has no entry of
          its own — neither inline list (v9 retired that) nor a link
          card (v12 retired even the link, since the global Tasks
          entry already exists in the sidebar nav and a redundant
          Assistant-page link added IA noise without surfacing
          assistant-specific information). */}

      {/* Tabbed Section: Files + Taxonomy / Index / Organize. All tabs
          render in the tab strip — the prior "+/−" toggle that hid the
          advanced three behind a collapse was extra friction with no
          payoff. */}
      {workspace?.path && workspace.valid !== false && (
        <SettingsCard>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="mb-1">
            <TabsList>
              <TabsTrigger value="files">{defaultTab.label}</TabsTrigger>
              {advancedTabs.map(tab => (
                <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {activeTab === 'files' && (
            <FilesTabPanel
              files={workspace.files}
              refreshingDocs={refreshingDocs}
              onRefreshDocs={handleRefreshDocs}
            />
          )}
          {activeTab === 'taxonomy' && (
            <TaxonomyTabPanel taxonomy={taxonomy} />
          )}
          {activeTab === 'index' && (
            <IndexTabPanel
              indexStats={indexStats}
              reindexing={reindexing}
              onReindex={handleReindex}
            />
          )}
          {activeTab === 'organize' && (
            <OrganizeTabPanel
              archiving={archiving}
              onArchive={handleArchive}
            />
          )}
        </SettingsCard>
      )}

      {workspace?.path && workspace.valid !== false && <SettingsCard><MemoryRecordsPanel key={workspace.path} /></SettingsCard>}

      {/* Confirmation Dialogs */}
      <WorkspaceConfirmDialogs
        confirmDialog={confirmDialog}
        initializing={initializing}
        onClose={() => setConfirmDialog(null)}
        onConfirmSwitchPath={handleConfirmFolderChange}
        onExecuteSave={executeSave}
      />

      {/* Onboarding Wizard Overlay */}
      {showWizard && workspace?.path && (
        <OnboardingWizard
          workspacePath={workspace.path}
          onComplete={(session) => {
            setShowWizard(false);
            fetchWorkspace(); // reload workspace state
            router.push(`/chat/${session.id}`);
          }}
        />
      )}

      {/* Web fallback for the folder picker — only reachable when the page
          is accessed outside Electron (no electronAPI). In Electron proper,
          handleSelectFolder takes the native dialog branch. Replaces an old
          window.prompt() call that threw TypeError in Electron renderers
          even though the branch was never expected to fire there — keeping
          the component robust across dev-server and packaged builds. */}
      <PromptDialog
        open={pathPromptOpen}
        onOpenChange={setPathPromptOpen}
        title={t('prompt.workspacePath.title' as TranslationKey)}
        description={t('prompt.workspacePath.description' as TranslationKey)}
        placeholder={t('prompt.workspacePath.placeholder' as TranslationKey)}
        confirmLabel={t('common.confirm' as TranslationKey)}
        cancelLabel={t('common.cancel' as TranslationKey)}
        onConfirm={(value) => {
          setPathInput(value);
          handleSaveClick(value);
        }}
      />
    </div>
  );
}
