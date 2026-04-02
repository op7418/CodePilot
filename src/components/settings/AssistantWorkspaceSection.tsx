"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getLocalDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpinnerGap, CheckCircle, X, Trash } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { WorkspaceInspectResult, ScheduledTask } from "@/types";
import { FilesTabPanel, TaxonomyTabPanel, IndexTabPanel, OrganizeTabPanel } from "./WorkspaceTabPanels";
import { WorkspaceConfirmDialogs, type ConfirmDialogType } from "./WorkspaceConfirmDialogs";
import { OnboardingCard, CheckInCard } from "./WorkspaceStatusCards";
import { OnboardingWizard } from "@/components/assistant/OnboardingWizard";
import { AssistantAvatar } from "@/components/ui/AssistantAvatar";
import type { TranslationKey } from "@/i18n/en";
import type { TaxonomyCategoryInfo, IndexStats, WorkspaceInfo, TabId, PathValidationStatus } from "./workspace-types";

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
  const [pathValidation, setPathValidation] = useState<PathValidationStatus>('idle');
  const [pathError, setPathError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogType | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/list");
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch { /* ignore */ }
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
      fetchTasks();
    }
  }, [workspace?.path, workspace?.valid, fetchSummary, fetchTasks]);

  useEffect(() => {
    if (workspace?.path && activeTab === 'taxonomy') fetchTaxonomy();
    if (workspace?.path && activeTab === 'index') fetchIndexStats();
  }, [workspace?.path, activeTab, fetchTaxonomy, fetchIndexStats]);

  // Debounced path validation
  const validatePath = useCallback((path: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setPathError(null);

    if (!path.trim()) {
      setPathValidation('idle');
      return;
    }

    setPathValidation('checking');
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/workspace/inspect?path=${encodeURIComponent(path.trim())}`);
        if (!res.ok) {
          setPathValidation('invalid');
          setPathError(t('assistant.inspectFailed'));
          return;
        }
        const data: WorkspaceInspectResult = await res.json();
        if (!data.exists) {
          setPathValidation('valid');
        } else if (!data.isDirectory) {
          setPathValidation('invalid');
          setPathError(t('assistant.pathNotDirectory'));
        } else if (!data.readable) {
          setPathValidation('invalid');
          setPathError(t('assistant.pathNotReadable'));
        } else if (!data.writable) {
          setPathValidation('invalid');
          setPathError(t('assistant.pathNotWritable'));
        } else {
          setPathValidation('valid');
        }
      } catch {
        setPathValidation('invalid');
        setPathError(t('assistant.inspectFailed'));
      }
    }, 500);
  }, [t]);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handlePathInputChange = useCallback((value: string) => {
    setPathInput(value);
    validatePath(value);
  }, [validatePath]);

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

  // Inspect path and show confirmation dialog
  const handleSaveClick = useCallback(async () => {
    if (!pathInput.trim()) return;
    if (pathInput.trim() === workspace?.path) return;

    setInspecting(true);
    try {
      const res = await fetch(`/api/workspace/inspect?path=${encodeURIComponent(pathInput.trim())}`);
      if (!res.ok) {
        setPathValidation('invalid');
        setPathError(t('assistant.inspectFailed'));
        return;
      }
      const data: WorkspaceInspectResult = await res.json();

      if (!data.exists) {
        setConfirmDialog({ kind: 'not_found' });
        return;
      }
      if (!data.isDirectory) {
        setPathValidation('invalid');
        setPathError(t('assistant.pathNotDirectory'));
        return;
      }
      if (!data.readable) {
        setPathValidation('invalid');
        setPathError(t('assistant.pathNotReadable'));
        return;
      }
      if (!data.writable) {
        setPathValidation('invalid');
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
          setPathValidation('invalid');
          setPathError(t('assistant.pathInvalid'));
      }
    } catch (e) {
      console.error("Failed to inspect workspace:", e);
      setPathValidation('invalid');
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
          setPathInput(result.filePaths[0]);
          validatePath(result.filePaths[0]);
        }
      } else {
        const input = prompt("Enter workspace directory path:");
        if (input) {
          setPathInput(input);
          validatePath(input);
        }
      }
    } catch (e) {
      console.error("Failed to select folder:", e);
    }
  }, [validatePath, t]);

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

  const handleDeleteTask = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (res.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
      }
    } catch (e) {
      console.error("Failed to delete task:", e);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const today = getLocalDateString();
  const checkInDoneToday = workspace?.state?.lastHeartbeatDate === today;

  const defaultTab: { id: TabId; label: string } = { id: 'files', label: t('assistant.fileStatus') };
  const advancedTabs: Array<{ id: TabId; label: string }> = [
    { id: 'taxonomy', label: t('assistant.taxonomyTitle') },
    { id: 'index', label: t('assistant.indexTitle') },
    { id: 'organize', label: t('assistant.organizeTitle') },
  ];

  // Render path validation indicator
  const renderValidationIcon = () => {
    switch (pathValidation) {
      case 'checking':
        return <SpinnerGap size={16} className="animate-spin text-muted-foreground" />;
      case 'valid':
        return <CheckCircle size={16} className="text-status-success-foreground" />;
      case 'invalid':
        return <X size={16} className="text-status-error-foreground" />;
      default:
        return null;
    }
  };

  const assistantName = summary?.name || t('assistant.defaultName');

  return (
    <div className="space-y-4">
      {/* Workspace Path Card */}
      <div className="rounded-lg border border-border/50 p-4">
        <h2 className="text-sm font-medium">{t('assistant.workspacePath')}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t('assistant.workspacePathHint')}</p>
        <div className="flex items-center gap-2 mt-3">
          <div className="relative flex-1">
            <Input
              type="text"
              value={pathInput}
              onChange={(e) => handlePathInputChange(e.target.value)}
              placeholder="/path/to/workspace"
              className="pr-8"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              {renderValidationIcon()}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleSelectFolder}>
            {t('assistant.selectFolder')}
          </Button>
        </div>
        {pathError && (
          <p className="text-xs text-status-error-foreground mt-1">{pathError}</p>
        )}
        <div className="flex items-center gap-2 mt-2">
          <Button
            size="sm"
            onClick={handleSaveClick}
            disabled={!pathInput.trim() || inspecting || pathValidation === 'invalid'}
          >
            {inspecting ? (
              <>
                <SpinnerGap size={14} className="animate-spin mr-1" />
                {t('assistant.inspecting')}
              </>
            ) : (
              t('common.save')
            )}
          </Button>
        </div>
      </div>

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
        <div className="rounded-lg border border-border/50 p-4">
          <h2 className="text-sm font-medium mb-3">{t('assistant.personality')}</h2>
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
          <p className="text-[11px] text-muted-foreground mt-2">
            {t('assistant.editSoulHint')}
          </p>
        </div>
      )}

      {/* Daily Check-in Card */}
      {workspace?.path && workspace.valid !== false && workspace.state?.onboardingComplete && (
        <CheckInCard
          lastCheckInDate={workspace.state?.lastHeartbeatDate ?? null}
          checkInDoneToday={checkInDoneToday}
          autoTriggerEnabled={workspace.state?.heartbeatEnabled === true}
          onAutoTriggerChange={async (enabled) => {
            try {
              const res = await fetch('/api/settings/workspace', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ heartbeatEnabled: enabled }),
              });
              if (!res.ok) return; // don't flip UI on failure
              setWorkspace((prev) => prev && prev.state ? {
                ...prev,
                state: { ...prev.state, heartbeatEnabled: enabled },
              } : prev);
            } catch { /* network error — leave UI unchanged */ }
          }}
        />
      )}

      {/* Scheduled Tasks */}
      {workspace?.path && workspace.valid !== false && (
        <div className="rounded-lg border border-border/50 p-4">
          <h2 className="text-sm font-medium mb-2">{t('assistant.scheduledTasks')}</h2>
          {tasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('assistant.noTasks')}</p>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <div key={task.id} className="flex items-center justify-between text-xs border border-border/30 rounded px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium truncate block">{task.name}</span>
                    <span className="text-muted-foreground">
                      {task.schedule_value}
                      {task.next_run && (
                        <> &middot; {t('assistant.taskNextRun')}: {new Date(task.next_run).toLocaleString()}</>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 ml-2 shrink-0">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      task.status === 'active' ? 'bg-status-success-muted text-status-success-foreground' :
                      task.status === 'paused' ? 'bg-status-warning-muted text-status-warning-foreground' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {task.status}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-1 text-muted-foreground hover:text-status-error-foreground"
                      onClick={() => handleDeleteTask(task.id)}
                      title={t('assistant.taskDelete')}
                    >
                      <Trash size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tabbed Section: Files (default) + Advanced (Taxonomy / Index / Organize) */}
      {workspace?.path && workspace.valid !== false && (
        <div className="rounded-lg border border-border/50 p-4">
          <div className="flex gap-1 border-b border-border/50 mb-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab('files')}
              className={`px-3 py-1.5 text-xs font-medium rounded-t rounded-b-none h-auto ${
                activeTab === 'files'
                  ? 'bg-background text-foreground border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {defaultTab.label}
            </Button>
            {showAdvanced && advancedTabs.map(tab => (
              <Button
                key={tab.id}
                variant="ghost"
                size="sm"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-t rounded-b-none h-auto ${
                  activeTab === tab.id
                    ? 'bg-background text-foreground border-b-2 border-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 h-auto"
              onClick={() => {
                setShowAdvanced((prev) => !prev);
                if (showAdvanced && activeTab !== 'files') setActiveTab('files');
              }}
            >
              {showAdvanced ? '−' : '+'} {t('assistant.advanced')}
            </Button>
          </div>

          {activeTab === 'files' && (
            <FilesTabPanel
              files={workspace.files}
              refreshingDocs={refreshingDocs}
              onRefreshDocs={handleRefreshDocs}
            />
          )}
          {showAdvanced && activeTab === 'taxonomy' && (
            <TaxonomyTabPanel taxonomy={taxonomy} />
          )}
          {showAdvanced && activeTab === 'index' && (
            <IndexTabPanel
              indexStats={indexStats}
              reindexing={reindexing}
              onReindex={handleReindex}
            />
          )}
          {showAdvanced && activeTab === 'organize' && (
            <OrganizeTabPanel
              archiving={archiving}
              onArchive={handleArchive}
            />
          )}
        </div>
      )}

      {/* Confirmation Dialogs */}
      <WorkspaceConfirmDialogs
        confirmDialog={confirmDialog}
        initializing={initializing}
        onClose={() => setConfirmDialog(null)}
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
    </div>
  );
}
