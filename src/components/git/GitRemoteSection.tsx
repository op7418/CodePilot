"use client";

import { useState, useEffect, useCallback } from "react";
import { Globe, ArrowClockwise, GitBranch } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import { showToast } from "@/hooks/useToast";
import type { GitRemote, GitBranch as GitBranchType } from "@/types";

interface GitRemoteSectionProps {
  cwd: string;
}

export function GitRemoteSection({ cwd }: GitRemoteSectionProps) {
  const { t } = useTranslation();
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);

  const loadData = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    try {
      const [remotesRes, branchesRes] = await Promise.all([
        fetch(`/api/git/remotes?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`),
      ]);
      const remotesData = await remotesRes.json();
      const branchesData = await branchesRes.json();
      setRemotes(remotesData.remotes || []);
      setBranches(branchesData.branches || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Listen for git-refresh events
  useEffect(() => {
    const handleRefresh = () => loadData();
    window.addEventListener('git-refresh', handleRefresh);
    return () => window.removeEventListener('git-refresh', handleRefresh);
  }, [loadData]);

  const handleFetch = async () => {
    if (!cwd || fetching) return;
    setFetching(true);
    try {
      const res = await fetch('/api/git/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Fetch failed' }));
        showToast({ type: 'error', message: data.error || 'Fetch failed' });
        return;
      }
      showToast({ type: 'success', message: t('git.fetchSuccess') });
      await loadData();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Fetch failed' });
    } finally {
      setFetching(false);
    }
  };

  const remoteBranches = branches.filter(b => b.isRemote);

  // Sort remote branches: current remote first, then alphabetically
  const sortedRemoteBranches = [...remoteBranches].sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  if (loading) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {t('git.loading')}
      </div>
    );
  }

  if (remotes.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {t('git.noRemotes')}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Remotes list */}
      <div className="space-y-1">
        {remotes.map(remote => (
          <div key={remote.name} className="px-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Globe size={12} className="text-muted-foreground shrink-0" />
              <span>{remote.name}</span>
            </div>
            <div className="ml-[18px] text-[11px] text-muted-foreground truncate">
              {formatUrl(remote.url)}
            </div>
          </div>
        ))}
      </div>

      {/* Remote branches */}
      {sortedRemoteBranches.length > 0 && (
        <div className="space-y-1">
          <div className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <GitBranch size={10} />
            {t('git.remoteBranches')}
          </div>
          <div className="max-h-[180px] overflow-y-auto">
            {sortedRemoteBranches.map(branch => (
              <div
                key={branch.name}
                className="flex items-center gap-2 px-3 py-0.5 text-[12px] hover:bg-muted/50"
              >
                <span className="truncate text-foreground/80">{branch.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fetch button */}
      <div className="px-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1.5 w-full"
          onClick={handleFetch}
          disabled={fetching}
        >
          <ArrowClockwise size={14} className={fetching ? 'animate-spin' : ''} />
          {fetching ? t('git.fetching') : t('git.fetch')}
        </Button>
      </div>
    </div>
  );
}

function formatUrl(url: string): string {
  // Strip credentials from URLs for display
  // git@github.com:user/repo.git -> github.com/user/repo
  // https://user:pass@github.com/user/repo.git -> github.com/user/repo
  try {
    // SSH format: git@github.com:user/repo.git
    const sshMatch = url.match(/^git@([^:]+):(.+?)(\.git)?$/);
    if (sshMatch) {
      return `${sshMatch[1]}/${sshMatch[2]}`;
    }

    // HTTPS format
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname.replace(/\.git$/, '')}`;
  } catch {
    return url;
  }
}
