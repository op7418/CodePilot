"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  FolderIcon,
  PlusSignIcon,
  CheckmarkCircle02Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitRepoWithStatus } from "@/types/git";

interface RepoSelectorProps {
  repos: GitRepoWithStatus[];
  selectedRepoId: string | null;
  onSelectRepo: (id: string) => void;
  onAddRepo: () => void;
}

export function RepoSelector({
  repos,
  selectedRepoId,
  onSelectRepo,
  onAddRepo,
}: RepoSelectorProps) {
  const { t } = useTranslation();

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 max-w-[280px]">
          <HugeiconsIcon icon={FolderIcon} className="h-4 w-4 shrink-0" />
          <span className="truncate">{selectedRepo?.name || t("git.selectRepo")}</span>
          {selectedRepo?.isPrivate !== undefined && (
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded shrink-0",
              selectedRepo.isPrivate
                ? "bg-orange-500/15 text-orange-600"
                : "bg-green-500/15 text-green-600"
            )}>
              {selectedRepo.isPrivate ? t("git.visibilityPrivate") : t("git.visibilityPublic")}
            </span>
          )}
          <HugeiconsIcon icon={ArrowDown01Icon} className="h-3.5 w-3.5 shrink-0 ml-auto" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" align="start">
        {repos.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            {t("git.noRepos")}
            <div className="mt-2">
              <Button
                variant="link"
                size="sm"
                onClick={onAddRepo}
              >
                {t("git.addRepository")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {repos.map((repo) => (
              <DropdownMenuItem
                key={repo.id}
                onClick={() => onSelectRepo(repo.id)}
                className={cn(
                  "flex items-center gap-2 cursor-pointer py-2",
                  selectedRepoId === repo.id && "bg-accent"
                )}
              >
                <HugeiconsIcon
                  icon={FolderIcon}
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{repo.name}</span>
                    {repo.isPrivate !== undefined && (
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded shrink-0",
                        repo.isPrivate
                          ? "bg-orange-500/15 text-orange-600"
                          : "bg-green-500/15 text-green-600"
                      )}>
                        {repo.isPrivate ? t("git.visibilityPrivate") : t("git.visibilityPublic")}
                      </span>
                    )}
                  </div>
                  {repo.branch && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{repo.branch}</span>
                      {(repo.changes ?? 0) > 0 && (
                        <span className="rounded bg-yellow-500/20 px-1 text-[10px] font-medium text-yellow-600">
                          {repo.changes}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {selectedRepoId === repo.id && (
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    className="h-4 w-4 shrink-0 text-primary"
                  />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onAddRepo} className="gap-2">
              <HugeiconsIcon icon={PlusSignIcon} className="h-4 w-4" />
              {t("git.addRepository")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
