"use client";

/**
 * Extensions page (`/plugins`) — Phase 2D.4 P2 round 6 IA refactor
 * (2026-05-02).
 *
 * Two-layer header:
 *   Row 1: Tabs only (Skills / MCP / CLI), each with its visible count.
 *   Row 2: Current-tab action bar — search + the primary actions of the
 *          active tab. Skills gets 新建 Skill + 技能商店, MCP gets 添加
 *          MCP + JSON 配置, CLI gets 添加 CLI 工具. No global Create
 *          dropdown — each tab's primary action lives in its own bar.
 *
 * Page-level title / description are removed: this is a Settings inner
 * page reached from the left rail; the `nav.plugins` label already
 * tells the user where they are. Repeating "扩展能力" + a paragraph
 * description here adds noise without anchoring information.
 *
 * Filter selection lives in `window.location.hash` so deep links and
 * the legacy `/skills` `/mcp` `/cli-tools` redirects still land on the
 * right view.
 *
 * Session context (cwd / sessionId) for SkillsManager:
 *   1. Prefer `usePanel()` — populated when navigating from a chat session.
 *   2. Fall back to `/api/chat/sessions[0]` (sorted by updated_at DESC).
 *   3. SkillsManager re-fetches when those props change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  MagnifyingGlass,
  Plus,
  Code,
  Storefront,
} from "@/components/ui/icon";
import { CodePilotIcon, type CodePilotIconName } from "@/components/ui/semantic-icon";
import { SkillsManager, type SkillsManagerHandle } from "@/components/skills/SkillsManager";
import { CreateSkillDialog } from "@/components/skills/CreateSkillDialog";
import { MarketplaceBrowser } from "@/components/skills/MarketplaceBrowser";
import { McpManager, type McpManagerHandle } from "@/components/plugins/McpManager";
import { CliToolsManager, type CliToolsManagerHandle } from "@/components/cli-tools/CliToolsManager";
import type { SkillSource } from "@/components/skills/SkillListItem";
import { McpJsonConfigDialog } from "@/components/plugins/McpJsonConfigDialog";
import { useTranslation } from "@/hooks/useTranslation";
import { useTabFromHash } from "@/hooks/useTabFromHash";
import { usePanel } from "@/hooks/usePanel";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  hydratePluginCountsFromSession,
  prefetchPluginTabCounts,
  readCachedPluginCounts,
  writeCachedPluginCounts,
  type PluginTabCounts,
} from "@/lib/plugin-tab-counts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TranslationKey } from "@/i18n";

const PLUGIN_FILTERS = ["skills", "mcp", "cli"] as const;
type PluginFilter = (typeof PLUGIN_FILTERS)[number];

interface RecentSessionContext {
  cwd?: string;
  sessionId?: string;
}

const FILTER_META: Record<PluginFilter, { labelKey: TranslationKey; icon: CodePilotIconName }> = {
  skills: { labelKey: "plugins.tab.skills", icon: "skill" },
  mcp: { labelKey: "plugins.tab.mcp", icon: "mcp" },
  cli: { labelKey: "plugins.tab.cli", icon: "cli" },
};

export default function ExtensionsPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useTabFromHash<PluginFilter>({
    validTabs: PLUGIN_FILTERS,
    defaultTab: "skills",
  });

  const { workingDirectory, sessionId } = usePanel();
  const panelCwd = workingDirectory || undefined;
  const panelSessionId = sessionId || undefined;

  // Fallback session context for cold visits / refreshes.
  const [fallback, setFallback] = useState<RecentSessionContext>({});
  const needsFallback = !panelCwd || !panelSessionId;
  useEffect(() => {
    if (!needsFallback) return;
    let cancelled = false;
    fetch("/api/chat/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const list = Array.isArray(data) ? data : data.sessions;
        if (!Array.isArray(list) || list.length === 0) return;
        const latest = list[0];
        setFallback({
          cwd: typeof latest?.working_directory === "string" && latest.working_directory ? latest.working_directory : undefined,
          sessionId: typeof latest?.id === "string" && latest.id ? latest.id : undefined,
        });
      })
      .catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, [needsFallback]);

  const cwd = panelCwd ?? fallback.cwd;
  const activeSessionId = panelSessionId ?? fallback.sessionId;

  // Tab-scoped search: each manager filters its own data set. Switch
  // filter clears the box so the user doesn't see "0 results" because
  // their query was scoped to a different list. Adjust during render
  // (React's "reset state when a prop changes" pattern) instead of a
  // setState-in-effect — React-Compiler-friendly and avoids a one-frame
  // stale-search flash. https://react.dev/learn/you-might-not-need-an-effect
  const [search, setSearch] = useState("");
  const [prevFilter, setPrevFilter] = useState(filter);
  const [prefetchCounts, setPrefetchCounts] = useState<PluginTabCounts>(
    () => readCachedPluginCounts(),
  );
  const [liveCounts, setLiveCounts] = useState<PluginTabCounts>({});
  if (filter !== prevFilter) {
    setPrevFilter(filter);
    setSearch("");
    // Drop the tab we left so a stale search-filtered total cannot
    // paint when we come back; inactive pills use unfiltered last-known.
    setLiveCounts((prev) => {
      if (prev[prevFilter] === undefined) return prev;
      const next = { ...prev };
      delete next[prevFilter];
      return next;
    });
  }

  // Per-filter counts for the Tab labels ("Skills 35 / MCP 9 / CLI 11").
  // Prefetch all three on mount so unvisited pills are not blank.
  // `undefined` = not yet known — we still render a reserved slot with
  // a muted en-dash, never omit the span and never flash a "0".
  // Active tab prefers the mounted manager (search-filtered); inactive
  // tabs keep the unfiltered prefetch / last-known number.
  useEffect(() => {
    const stored = hydratePluginCountsFromSession();
    if (stored.skills != null || stored.mcp != null || stored.cli != null) {
      setPrefetchCounts((prev) => ({ ...stored, ...prev }));
    }
    let cancelled = false;
    prefetchPluginTabCounts({ cwd, sessionId: activeSessionId }).then((next) => {
      if (cancelled) return;
      setPrefetchCounts((prev) => ({ ...prev, ...next }));
    });
    return () => {
      cancelled = true;
    };
    // Mount-only: do not re-prefetch when cwd fallback arrives.
    // SkillsManager already refetches on cwd; a second host GET would
    // add another wave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rememberUnfiltered = useCallback((key: PluginFilter, value: number) => {
    writeCachedPluginCounts({ [key]: value });
    setPrefetchCounts((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const handleSkillsCounts = useCallback((counts: Record<SkillSource, number>) => {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    setLiveCounts((prev) => (prev.skills === total ? prev : { ...prev, skills: total }));
    if (!search) rememberUnfiltered("skills", total);
  }, [search, rememberUnfiltered]);

  const handleMcpCount = useCallback((count: number) => {
    setLiveCounts((prev) => (prev.mcp === count ? prev : { ...prev, mcp: count }));
    if (!search) rememberUnfiltered("mcp", count);
  }, [search, rememberUnfiltered]);

  const handleCliCount = useCallback((count: number) => {
    setLiveCounts((prev) => (prev.cli === count ? prev : { ...prev, cli: count }));
    if (!search) rememberUnfiltered("cli", count);
  }, [search, rememberUnfiltered]);

  const filterCounts: Record<PluginFilter, number | undefined> = {
    skills: filter === "skills" && liveCounts.skills !== undefined ? liveCounts.skills : prefetchCounts.skills,
    mcp: filter === "mcp" && liveCounts.mcp !== undefined ? liveCounts.mcp : prefetchCounts.mcp,
    cli: filter === "cli" && liveCounts.cli !== undefined ? liveCounts.cli : prefetchCounts.cli,
  };

  // Imperative refs into each manager so the per-tab action bar can
  // trigger their internal flows (add server, add tool) without the
  // manager rendering its own button.
  const skillsRef = useRef<SkillsManagerHandle>(null);
  const mcpRef = useRef<McpManagerHandle>(null);
  const cliRef = useRef<CliToolsManagerHandle>(null);

  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [jsonConfigOpen, setJsonConfigOpen] = useState(false);

  const handleCreateSkill = async (
    name: string,
    scope: "global" | "project",
    content: string,
  ) => {
    const res = await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content, scope, cwd: cwd || undefined }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to create skill");
    }
    skillsRef.current?.refresh();
  };

  // Body picker — single-filter views render only that manager.
  const body = useMemo(() => {
    if (filter === "skills") {
      return (
        <SkillsManager
          ref={skillsRef}
          cwd={cwd}
          sessionId={activeSessionId}
          search={search}
          onCreateSkill={() => setCreateSkillOpen(true)}
          onCountsChange={handleSkillsCounts}
        />
      );
    }
    if (filter === "mcp") {
      return <McpManager ref={mcpRef} variant="embedded" onCountChange={handleMcpCount} search={search} />;
    }
    return <CliToolsManager ref={cliRef} variant="embedded" onCountChange={handleCliCount} search={search} />;
  }, [filter, cwd, activeSessionId, search, handleSkillsCounts, handleMcpCount, handleCliCount]);

  return (
    <div className="flex h-full flex-col">
      {/* Two-layer header: Row 1 = Tabs only; Row 2 = current tab's
          action bar (search + primary actions). No global title /
          description / Create dropdown — this is a Settings inner page,
          and tabs already say what's here. No bottom divider — the
          gap to the body grid is enough visual separation. */}
      <header className="shrink-0 px-6 pt-4 pb-3 space-y-3">
        {/* Row 1 — shadcn <Tabs>/<TabsList>/<TabsTrigger>. We don't use
            <TabsContent> because the body is rendered separately based
            on `filter` (refs / count callbacks need to live outside the
            tabs context); the Root + List + Triggers give us the
            project-standard pill shape (rounded-full, h-9, size-4
            icons, data-state active styling) without one-off radii. */}
        <Tabs value={filter} onValueChange={(v) => setFilter(v as PluginFilter)}>
          <TabsList>
            {PLUGIN_FILTERS.map((key) => {
              const meta = FILTER_META[key];
              const count = filterCounts[key];
              return (
                <TabsTrigger key={key} value={key}>
                  <CodePilotIcon name={meta.icon} size="md" className="text-inherit" aria-hidden />
                  {t(meta.labelKey)}
                  <span className="inline-block min-w-[1.5rem] text-center tabular-nums text-xs text-muted-foreground">
                    {typeof count === "number" ? count : "–"}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        {/* Row 2 — Current tab's action bar. Search on the left, primary
            actions on the right. Wraps onto its own line at narrow
            widths so the search input never collides with the buttons. */}
        <CurrentTabToolbar
          filter={filter}
          search={search}
          onSearchChange={setSearch}
          onNewSkill={() => setCreateSkillOpen(true)}
          onOpenMarketplace={() => setMarketplaceOpen(true)}
          onAddMcp={() => mcpRef.current?.addServer()}
          onOpenMcpJson={() => setJsonConfigOpen(true)}
          onAddCli={() => cliRef.current?.addTool()}
        />
      </header>

      {/* Body — single scroll container shared across filters */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">{body}</div>

      <CreateSkillDialog
        open={createSkillOpen}
        onOpenChange={setCreateSkillOpen}
        onCreate={handleCreateSkill}
      />

      <MarketplaceDialog
        open={marketplaceOpen}
        onOpenChange={setMarketplaceOpen}
        onInstalled={() => skillsRef.current?.refresh()}
      />

      <McpJsonConfigDialog
        open={jsonConfigOpen}
        onOpenChange={setJsonConfigOpen}
        onSaved={() => mcpRef.current?.refresh()}
      />
    </div>
  );
}

/**
 * Per-tab action bar. Renders search + the primary actions for the
 * active tab. Layout: search box flexes to fill, action buttons sit on
 * the right; flex-wrap lets buttons drop onto a new line below the
 * search at narrow viewports.
 */
function CurrentTabToolbar({
  filter,
  search,
  onSearchChange,
  onNewSkill,
  onOpenMarketplace,
  onAddMcp,
  onOpenMcpJson,
  onAddCli,
}: {
  filter: PluginFilter;
  search: string;
  onSearchChange: (value: string) => void;
  onNewSkill: () => void;
  onOpenMarketplace: () => void;
  onAddMcp: () => void;
  onOpenMcpJson: () => void;
  onAddCli: () => void;
}) {
  const { t } = useTranslation();

  const placeholderKey: TranslationKey =
    filter === "skills" ? "plugins.search.placeholder.skills" :
    filter === "mcp" ? "plugins.search.placeholder.mcp" :
    "plugins.search.placeholder.cli";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative flex-1 min-w-[180px] max-w-md">
        <MagnifyingGlass
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
        <Input
          placeholder={t(placeholderKey)}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9 h-8 text-sm"
        />
      </div>

      <div className="flex items-center gap-1.5 ml-auto shrink-0">
        {filter === "skills" && (
          <>
            <Button size="sm" className="h-8 gap-1.5" onClick={onNewSkill}>
              <Plus size={14} />
              {t("plugins.create.newSkill" as TranslationKey)}
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={onOpenMarketplace}>
              <Storefront size={14} />
              {t("skills.marketplace" as TranslationKey)}
            </Button>
          </>
        )}
        {filter === "mcp" && (
          <>
            <Button size="sm" className="h-8 gap-1.5" onClick={onAddMcp}>
              <Plus size={14} />
              {t("plugins.create.addMcp" as TranslationKey)}
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={onOpenMcpJson}>
              <Code size={14} />
              {t("plugins.more.mcpJson" as TranslationKey)}
            </Button>
          </>
        )}
        {filter === "cli" && (
          <Button size="sm" className="h-8 gap-1.5" onClick={onAddCli}>
            <Plus size={14} />
            {t("plugins.create.addCli" as TranslationKey)}
          </Button>
        )}
      </div>
    </div>
  );
}

function MarketplaceDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed height (h-[80vh]) so the dialog never resizes when the
          search list shrinks/grows or the user navigates into a skill
          detail. The wrapper title stays visible across both views;
          the back button inside the detail panel returns to list. */}
      <DialogContent className="sm:max-w-3xl h-[80vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/50">
          <DialogTitle className="text-base font-medium">
            {t("skills.marketplace" as TranslationKey)}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("skills.marketplaceDescription" as TranslationKey)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-hidden">
          <MarketplaceBrowser onInstalled={onInstalled} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
