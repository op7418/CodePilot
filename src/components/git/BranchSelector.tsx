"use client";

import { useState, useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GitBranchIcon, ArrowDown01Icon, PlusSignIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitBranch } from "@/types/git";

interface BranchSelectorProps {
  repoPath: string;
  currentBranch: string;
  onBranchChange: () => void;
}

export function BranchSelector({ repoPath, currentBranch, onBranchChange }: BranchSelectorProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [branches, setBranches] = useState<{ local: GitBranch[]; remote: GitBranch[] }>({
    local: [],
    remote: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch branches when dropdown opens
  useEffect(() => {
    if (isOpen) {
      fetchBranches();
    }
  }, [isOpen, repoPath]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowCreateInput(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const fetchBranches = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/git/branches?path=${encodeURIComponent(repoPath)}`);
      const data = await res.json();
      setBranches({ local: data.local || [], remote: data.remote || [] });
    } catch (error) {
      console.error("Failed to fetch branches:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCheckout = async (branch: string) => {
    try {
      await fetch("/api/git/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoPath, branch }),
      });
      setIsOpen(false);
      onBranchChange();
    } catch (error) {
      console.error("Failed to checkout branch:", error);
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    try {
      await fetch("/api/git/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoPath, name: newBranchName }),
      });
      setNewBranchName("");
      setShowCreateInput(false);
      await handleCheckout(newBranchName);
    } catch (error) {
      console.error("Failed to create branch:", error);
    }
  };

  const handleDeleteBranch = async (branch: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t("git.deleteBranchConfirm", { branch }))) return;
    try {
      await fetch(`/api/git/branches?path=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(branch)}`, {
        method: "DELETE",
      });
      fetchBranches();
    } catch (error) {
      console.error("Failed to delete branch:", error);
    }
  };

  return (
    <div ref={dropdownRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="gap-2"
      >
        <HugeiconsIcon icon={GitBranchIcon} className="h-4 w-4" />
        <span className="max-w-[120px] truncate">{currentBranch}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} className="h-3 w-3 opacity-50" />
      </Button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-popover shadow-lg">
          {/* Create Branch */}
          <div className="border-b border-border/50 p-2">
            {showCreateInput ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder={t("git.newBranchName")}
                  className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateBranch();
                    if (e.key === "Escape") setShowCreateInput(false);
                  }}
                />
                <Button size="sm" onClick={handleCreateBranch}>
                  {t("common.create")}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => setShowCreateInput(true)}
              >
                <HugeiconsIcon icon={PlusSignIcon} className="h-4 w-4" />
                {t("git.createBranch")}
              </Button>
            )}
          </div>

          {/* Branch List */}
          <div className="max-h-60 overflow-auto p-1">
            {isLoading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : (
              <>
                {/* Local Branches */}
                <div className="mb-2">
                  <div className="px-2 py-1 text-xs font-medium uppercase text-muted-foreground">
                    {t("git.localBranches")}
                  </div>
                  {branches.local.map((branch) => (
                    <button
                      key={branch.name}
                      onClick={() => handleCheckout(branch.name)}
                      className={cn(
                        "group flex w-full items-center justify-between rounded px-2 py-1.5 text-sm",
                        branch.current
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {branch.current && (
                          <span className="text-primary">●</span>
                        )}
                        <span className="truncate">{branch.name}</span>
                      </span>
                      {!branch.current && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 opacity-0 group-hover:opacity-100"
                          onClick={(e) => handleDeleteBranch(branch.name, e)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} className="h-3 w-3 text-red-500" />
                        </Button>
                      )}
                    </button>
                  ))}
                </div>

                {/* Remote Branches */}
                {branches.remote.length > 0 && (
                  <div>
                    <div className="px-2 py-1 text-xs font-medium uppercase text-muted-foreground">
                      {t("git.remoteBranches")}
                    </div>
                    {branches.remote.slice(0, 10).map((branch) => (
                      <button
                        key={branch.name}
                        onClick={() => handleCheckout(branch.name)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                      >
                        <span className="truncate text-muted-foreground">{branch.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
