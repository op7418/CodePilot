"use client";

import { useState, useCallback } from "react";
import { CaretDown, CaretRight } from "@/components/ui/icon";
import { usePanel } from "@/hooks/usePanel";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useTranslation } from "@/hooks/useTranslation";
import { GitStatusSection } from "./GitStatusSection";
import { GitBranchSelector } from "./GitBranchSelector";
import { GitHistorySection } from "./GitHistorySection";
import { GitWorktreeSection } from "./GitWorktreeSection";
import { GitRemoteSection } from "./GitRemoteSection";
import { GitCommitDetailDialog } from "./GitCommitDetailDialog";
import { DeriveWorktreeDialog } from "./DeriveWorktreeDialog";

export function GitPanel() {
  const { workingDirectory, sessionId } = usePanel();
  const { t } = useTranslation();
  const { status, refresh } = useGitStatus(workingDirectory);

  // Collapsible sections
  const [statusOpen, setStatusOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [worktreeOpen, setWorktreeOpen] = useState(false);

  // Dialogs
  const [commitDetailSha, setCommitDetailSha] = useState<string | null>(null);
  const [showDeriveDialog, setShowDeriveDialog] = useState(false);

  const handleCheckout = useCallback(async (branch: string) => {
    const res = await fetch('/api/git/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: workingDirectory, branch }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Checkout failed' }));
      throw new Error(data.error || 'Checkout failed');
    }
    refresh();
  }, [workingDirectory, refresh]);

  const repoName = workingDirectory.split('/').pop() || '';

  if (!status?.isRepo) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground p-4">
        {t('git.notARepo')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Status section */}
      <CollapsibleSection
        title={t('git.statusSection')}
        open={statusOpen}
        onToggle={() => setStatusOpen(!statusOpen)}
      >
        <GitStatusSection status={status} />
      </CollapsibleSection>

      {/* Remote section */}
      <CollapsibleSection
        title={t('git.remoteSection')}
        open={remoteOpen}
        onToggle={() => setRemoteOpen(!remoteOpen)}
      >
        <GitRemoteSection cwd={workingDirectory} />
      </CollapsibleSection>

      {/* Branch section */}
      <CollapsibleSection
        title={t('git.branchSection')}
        open={branchOpen}
        onToggle={() => setBranchOpen(!branchOpen)}
      >
        <GitBranchSelector
          cwd={workingDirectory}
          currentBranch={status.branch}
          dirty={status.dirty}
          onCheckout={handleCheckout}
        />
      </CollapsibleSection>

      {/* History section */}
      <CollapsibleSection
        title={t('git.historySection')}
        open={historyOpen}
        onToggle={() => setHistoryOpen(!historyOpen)}
      >
        <GitHistorySection
          cwd={workingDirectory}
          onSelectCommit={(sha) => setCommitDetailSha(sha)}
        />
      </CollapsibleSection>

      {/* Worktree section */}
      <CollapsibleSection
        title={t('git.worktreeSection')}
        open={worktreeOpen}
        onToggle={() => setWorktreeOpen(!worktreeOpen)}
      >
        <GitWorktreeSection
          cwd={workingDirectory}
          onDeriveWorktree={() => setShowDeriveDialog(true)}
        />
      </CollapsibleSection>

      {/* Dialogs */}
      {commitDetailSha && (
        <GitCommitDetailDialog
          cwd={workingDirectory}
          sha={commitDetailSha}
          onClose={() => setCommitDetailSha(null)}
        />
      )}
      {showDeriveDialog && (
        <DeriveWorktreeDialog
          cwd={workingDirectory}
          repoName={repoName}
          sessionId={sessionId}
          onClose={() => setShowDeriveDialog(false)}
        />
      )}
    </div>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/40">
      <button
        className="flex items-center gap-1.5 w-full px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/30"
        onClick={onToggle}
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        {title}
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}
