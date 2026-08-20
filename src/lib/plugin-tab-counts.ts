/**
 * Lightweight /plugins tab-count helpers.
 *
 * The unified ExtensionsPage only mounts the active manager, so Skills /
 * MCP / CLI pills would otherwise stay blank until the user visits each
 * tab. These GETs reuse the same endpoints the managers already hit and
 * cache the last known totals so a revisit paints immediately.
 */

import { BUILTIN_MCP_CATALOG } from "@/lib/builtin-mcp-catalog";

export const PLUGIN_COUNTS_STORAGE_KEY = "codepilot.plugins.counts";

export type PluginTabCounts = {
  skills?: number;
  mcp?: number;
  cli?: number;
};

let memoryCache: PluginTabCounts = {};

function isFiniteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sanitizeCounts(raw: unknown): PluginTabCounts {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const next: PluginTabCounts = {};
  if (isFiniteCount(src.skills)) next.skills = src.skills;
  if (isFiniteCount(src.mcp)) next.mcp = src.mcp;
  if (isFiniteCount(src.cli)) next.cli = src.cli;
  return next;
}

function persistCache() {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(PLUGIN_COUNTS_STORAGE_KEY, JSON.stringify(memoryCache));
  } catch {
    // quota / private mode — memory cache still works for this session
  }
}

export function hydratePluginCountsFromSession(): PluginTabCounts {
  if (typeof sessionStorage === "undefined") return { ...memoryCache };
  try {
    const raw = sessionStorage.getItem(PLUGIN_COUNTS_STORAGE_KEY);
    if (raw) {
      memoryCache = { ...sanitizeCounts(JSON.parse(raw)), ...memoryCache };
    }
  } catch {
    // ignore malformed cache
  }
  return { ...memoryCache };
}

export function readCachedPluginCounts(): PluginTabCounts {
  return { ...memoryCache };
}

export function writeCachedPluginCounts(partial: PluginTabCounts): PluginTabCounts {
  memoryCache = { ...memoryCache, ...sanitizeCounts(partial) };
  persistCache();
  return { ...memoryCache };
}

export async function fetchSkillsCount(opts?: {
  cwd?: string;
  sessionId?: string;
}): Promise<number | undefined> {
  const params = new URLSearchParams();
  if (opts?.cwd) params.set("cwd", opts.cwd);
  if (opts?.sessionId) params.set("sessionId", opts.sessionId);
  const qs = params.toString();
  const res = await fetch(`/api/skills${qs ? `?${qs}` : ""}`);
  if (!res.ok) return undefined;
  const data = await res.json();
  return Array.isArray(data?.skills) ? data.skills.length : undefined;
}

export async function fetchMcpCount(): Promise<number | undefined> {
  const res = await fetch("/api/plugins/mcp");
  if (!res.ok) return undefined;
  const data = await res.json();
  if (!data?.mcpServers || typeof data.mcpServers !== "object") return undefined;
  return BUILTIN_MCP_CATALOG.length + Object.keys(data.mcpServers).length;
}

export async function fetchCliCount(): Promise<number | undefined> {
  const res = await fetch("/api/cli-tools/installed");
  if (!res.ok) return undefined;
  const data = await res.json();
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  const extra = Array.isArray(data?.extra) ? data.extra : [];
  const custom = Array.isArray(data?.custom) ? data.custom : [];
  const catalogInstalled = tools.filter(
    (t: { status?: string }) => t && t.status !== "not_installed",
  ).length;
  return catalogInstalled + extra.length + custom.length;
}

export async function prefetchPluginTabCounts(opts?: {
  cwd?: string;
  sessionId?: string;
}): Promise<PluginTabCounts> {
  const [skills, mcp, cli] = await Promise.all([
    fetchSkillsCount(opts).catch(() => undefined),
    fetchMcpCount().catch(() => undefined),
    fetchCliCount().catch(() => undefined),
  ]);
  const next: PluginTabCounts = {};
  if (isFiniteCount(skills)) next.skills = skills;
  if (isFiniteCount(mcp)) next.mcp = mcp;
  if (isFiniteCount(cli)) next.cli = cli;
  return writeCachedPluginCounts(next);
}
