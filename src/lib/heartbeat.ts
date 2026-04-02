/**
 * Heartbeat system — HEARTBEAT_OK protocol, active hours, deduplication.
 * Only applies to assistant workspace sessions.
 */

export const HEARTBEAT_TOKEN = 'HEARTBEAT_OK';
export const MAX_ACK_CHARS = 300;

/**
 * Strip HEARTBEAT_OK token from AI reply. Handles HTML/Markdown wrapping.
 * Returns shouldSkip=true if reply is just the token (or ≤300 chars after stripping).
 */
export function stripHeartbeatToken(raw: string): { shouldSkip: boolean; text: string; didStrip: boolean } {
  if (!raw?.trim()) return { shouldSkip: true, text: '', didStrip: false };

  const text = raw.trim();

  // Unwrap HTML/Markdown: AI may output **HEARTBEAT_OK** or <b>HEARTBEAT_OK</b>
  const unwrapped = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/^[*`~_]+/, '')
    .replace(/[*`~_]+$/, '')
    .trim();

  for (const candidate of [text, unwrapped]) {
    if (!candidate.includes(HEARTBEAT_TOKEN)) continue;

    let stripped = candidate.trim();
    let didStrip = false;
    let changed = true;

    while (changed) {
      changed = false;

      // Strip from start
      if (stripped.startsWith(HEARTBEAT_TOKEN)) {
        stripped = stripped.slice(HEARTBEAT_TOKEN.length).trimStart();
        didStrip = true;
        changed = true;
        continue;
      }

      // Strip from end (allow up to 4 trailing non-word chars like . ! -)
      const tailPattern = new RegExp(`${escapeRegExp(HEARTBEAT_TOKEN)}[^\\w]{0,4}$`);
      if (tailPattern.test(stripped)) {
        const idx = stripped.lastIndexOf(HEARTBEAT_TOKEN);
        stripped = stripped.slice(0, idx).trimEnd();
        didStrip = true;
        changed = true;
      }
    }

    if (didStrip) {
      const collapsed = stripped.replace(/\s+/g, ' ').trim();
      if (!collapsed || collapsed.length <= MAX_ACK_CHARS) {
        return { shouldSkip: true, text: '', didStrip: true };
      }
      return { shouldSkip: false, text: collapsed, didStrip: true };
    }
  }

  return { shouldSkip: false, text, didStrip: false };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if HEARTBEAT.md content is effectively empty.
 * Returns true for files with only headings, empty checklists, and comments.
 */
export function isHeartbeatContentEmpty(content: string | null | undefined): boolean {
  if (!content?.trim()) return true;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#+(\s|$)/.test(trimmed)) continue;
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('<!--')) continue;
    return false;
  }
  return true;
}

/**
 * Check if current time is within active hours window.
 * Uses local time. Returns true if no config provided.
 */
export function isWithinActiveHours(config: { start?: string; end?: string } | undefined): boolean {
  if (!config?.start || !config?.end) return true;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const parseTime = (t: string) => {
    const parts = t.split(':').map(Number);
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  };

  const startMinutes = parseTime(config.start);
  const endMinutes = parseTime(config.end);

  if (endMinutes > startMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Wrap around midnight (e.g., 22:00 - 08:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Check if heartbeat reply is a duplicate of the last one within 24 hours.
 */
export function shouldSkipDuplicate(
  text: string,
  state: { lastHeartbeatText?: string; lastHeartbeatSentAt?: number },
): boolean {
  if (!state.lastHeartbeatText || !state.lastHeartbeatSentAt) return false;
  if (state.lastHeartbeatText !== text) return false;
  return Date.now() - state.lastHeartbeatSentAt < 24 * 60 * 60 * 1000;
}

/** Default HEARTBEAT.md template content */
export const HEARTBEAT_TEMPLATE = `# 心跳检查清单

每次心跳时按以下清单检查，如果都没有需要关注的事项，回复 HEARTBEAT_OK。

- [ ] 最近的 daily memory 中有没有未完成的事项或待跟进的事情
- [ ] 用户上次提到的 deadline 或计划是否临近
- [ ] 是否超过 3 天没有互动（如果是，轻量问候）
- [ ] 工作区中是否有新增或变动的文件需要更新索引

## 不要做的事
- 不要重复上次已经讨论过的内容
- 不要问固定的问卷问题
- 不要在深夜时段（23:00-08:00）打扰，除非有紧急事项
- 如果用户上次明确说"今天不需要了"，今天就不要再触发
`;
