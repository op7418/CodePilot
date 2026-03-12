import { parseDBDate } from "@/lib/utils";
import type { ChatSession } from "@/types";
import type { TranslationKey } from "@/i18n";

const COLLAPSED_PROJECTS_KEY = "codepilot:collapsed-projects";
export const COLLAPSED_INITIALIZED_KEY = "codepilot:collapsed-initialized";

export function loadCollapsedProjects(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

export function saveCollapsedProjects(collapsed: Set<string>) {
  localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
}

export interface ProjectGroup {
  workingDirectory: string;
  displayName: string;
  sessions: ChatSession[];
  latestUpdatedAt: number;
}

export function groupSessionsByProject(sessions: ChatSession[]): ProjectGroup[] {
  const map = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const key = session.working_directory || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(session);
  }

  const groups: ProjectGroup[] = [];
  for (const [wd, groupSessions] of map) {
    // Sort sessions within group by updated_at DESC
    groupSessions.sort(
      (a, b) =>
        parseDBDate(b.updated_at).getTime() - parseDBDate(a.updated_at).getTime()
    );
    const displayName =
      wd === ""
        ? "No Project"
        : groupSessions[0]?.project_name || wd.split("/").pop() || wd;
    const latestUpdatedAt = parseDBDate(groupSessions[0].updated_at).getTime();
    groups.push({
      workingDirectory: wd,
      displayName,
      sessions: groupSessions,
      latestUpdatedAt,
    });
  }

  // Sort groups by most recently active first
  groups.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
  return groups;
}

export function formatRelativeTime(dateStr: string, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const date = parseDBDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return t('chatList.justNow');
  if (diffMin < 60) return t('chatList.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('chatList.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('chatList.daysAgo', { n: diffDay });
  return date.toLocaleDateString();
}
