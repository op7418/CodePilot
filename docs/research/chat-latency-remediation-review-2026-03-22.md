# Chat Latency Remediation — Code Review Report

> Date: 2026-03-22
> Author: Claude (implementation) / pending Codex review
> Related: [investigation](./chat-latency-investigation-2026-03-20.md) | exec plan

## Summary

15 files changed, +100 / -45 lines. Covers exec plan Phase 1 (mode convergence) + Phase 2 (MCP persistent toggle) + Phase 3 (first-token latency optimization). Phase 4 (observability) deferred.

## Changes by Category

### P0 Fix: Prevent user-level Claude settings from injecting high effort

**File:** `src/lib/claude-client.ts`

```diff
- if (effort) {
-   queryOptions.effort = effort;
- }
+ queryOptions.effort = effort || 'medium';
```

- **Why:** `~/.claude/settings.json` has `effortLevel: "high"` + `alwaysThinkingEnabled: true`. SDK inherits these via `settingSources: ['user', 'project', 'local']`. Without explicit override, all providers run at high effort.
- **Behavior change:** Default effort is now `medium` for all chats. User-selected effort from UI still takes priority.
- **Not changed:** `thinking` config not overridden this round — more complex interaction with UI states.

### P1 Fix: MCP persistent enable/disable toggle

| File | Change |
|------|--------|
| `src/types/index.ts` | Added `enabled?: boolean` to `MCPServerConfig` |
| `src/app/api/chat/route.ts` | `loadMcpServers()` filters `enabled === false` |
| `src/lib/bridge/conversation-engine.ts` | Same filter in bridge's `loadMcpServers()` |
| `src/app/api/plugins/mcp/route.ts` | No change needed — PUT handler's `{ _source, ...cleanServer }` already preserves `enabled` |
| `src/components/plugins/McpServerList.tsx` | Added `Switch` toggle per server card; `opacity-50` when disabled |
| `src/components/plugins/McpManager.tsx` | Added `handlePersistentToggle()` → `PUT /api/plugins/mcp` |
| `src/i18n/en.ts` + `zh.ts` | Added `mcp.enabled` / `mcp.disabled` keys |

- **Semantics:** `enabled: undefined` and `enabled: true` both mean enabled. Only explicit `false` = disabled. Zero-migration.
- **Scope:** Persistent toggle writes to `~/.claude/settings.json` or `~/.claude.json` (respects `_source`). Runtime toggle (`/api/plugins/mcp/toggle`) kept separate for live reconnect.
- **Note:** Project-level `.mcp.json` servers (like `chrome-devtools`) are not shown in the MCP management UI — they're only managed by editing the file. The filter still applies to them.

### P1 Fix: Pin .mcp.json version

```diff
- "chrome-devtools-mcp@latest"
+ "chrome-devtools-mcp@0.20.3",
+ "--headless"
```

- **Why:** `npx -y ...@latest` triggers npm registry check on every cold start (measured 10s+).
- **Note:** `--headless` flag was already in the original but lost in a previous edit — restored here.

### P2 Fix: Resume visible status event

**File:** `src/lib/claude-client.ts`

```typescript
if (shouldResume) {
  controller.enqueue(formatSSE({
    type: 'status',
    data: JSON.stringify({
      title: 'Resuming session',
      message: 'Reconnecting to previous conversation...',
    }),
  }));
  queryOptions.resume = sdkSessionId;
}
```

- **Why:** Resume path blocks on `await iter.next()` with zero UI feedback. Users see "sent message, nothing happening" for 10+ seconds.
- **No `_internal: true`** — event passes through `useSSEStream.ts` filter and is shown to user.

### P3 Fix: Defer capability capture

**File:** `src/lib/agent-sdk-capabilities.ts`

```typescript
const CACHE_TTL_MS = 5 * 60 * 1000;
export function isCacheFresh(providerId: string = 'env'): boolean { ... }
```

**File:** `src/lib/claude-client.ts`

- `captureCapabilities()` moved from immediately after `registerConversation()` to inside the `for await` loop's first `'assistant'` case.
- Skipped entirely if cache is fresh (within 5-minute TTL).
- **Trade-off:** Model selector may show stale data for up to 5 minutes after provider switch. Acceptable because users rarely switch providers mid-conversation.

### Phase 1: Chat mode entry convergence

| File | Change |
|------|--------|
| `src/components/chat/ChatView.tsx` | Removed `initialMode` prop; hardcoded `useState('code')`; removed `useEffect` syncing `initialMode` |
| `src/app/chat/[id]/page.tsx` | Removed `sessionMode` state; removed `initialMode` prop passing |
| `src/components/layout/SplitColumn.tsx` | Same as above |
| `src/app/api/chat/route.ts` | Replaced `effectiveMode` switch with hardcoded `permissionMode = 'acceptEdits'`; `enableFileCheckpointing` defaults to `true` |
| `src/i18n/en.ts` + `zh.ts` | Commented out `messageInput.modeCode` / `messageInput.modePlan` (not deleted, in case bridge UI references them) |

- **Kept:** `handleModeChange` callback in ChatView (SDK can still push mode changes). `mode/route.ts` API kept for bridge. DB schema unchanged.
- **Kept:** `mode` field in request body parsing (bridge still sends it).

## What Was NOT Changed

- DB `mode` column schema (`CHECK(mode IN ('code', 'plan', 'ask'))`)
- Bridge `/mode` command and `conversation-engine.ts` mode handling
- `thinking` config override (only `effort` overridden)
- `settingSources` in `provider-resolver.ts` (SDK still reads user config for plugins/hooks)
- `useSSEStream.ts` `_internal` filter (no change needed)
- Runtime MCP toggle route (`/api/plugins/mcp/toggle`)

## Test Results

- **Typecheck:** Pass
- **Unit tests:** 444/444 pass, 0 fail
- **Playwright verification (headless):**
  - Chat page: No mode selector (Plan button count: 0) ✅
  - MCP page: 2 switch toggles visible, both `checked` state ✅
  - Server cards display correctly with toggle ✅

## Risk Areas for Review

1. **`effort || 'medium'` override** — If SDK internally applies effort before our explicit value, we might double-set. Verify SDK precedence: explicit `queryOptions.effort` > `settingSources` inheritance.

2. **`handlePersistentToggle` optimistic update** — Sets state before API call, reverts via `fetchServers()` on failure. Race condition possible if user toggles rapidly. Low severity — worst case is a stale UI state that corrects on next fetch.

3. **i18n commented keys** — `messageInput.modeCode` / `messageInput.modePlan` are commented out, not deleted. If `TranslationKey` type is derived from the object keys, the type is already removed. Any runtime reference to these keys would return the key itself. Grep confirms no runtime references exist outside i18n files.

4. **`enableFileCheckpointing` default changed** — From `effectiveMode === 'code'` to `true`. Since desktop chat is now always 'code', this is semantically identical. But if the request body explicitly sends `enableFileCheckpointing: false`, it's still respected.

5. **Bridge path unaffected** — `conversation-engine.ts` has its own mode resolution at lines 189-194. The `route.ts` mode convergence only affects desktop `/api/chat`. Verify bridge still receives and applies `mode` from IM messages.

## Diff Stats

```
15 files changed, 100 insertions(+), 45 deletions(-)

.mcp.json                                  3 ++-
src/app/api/chat/route.ts                 29 +++-------
src/app/chat/[id]/page.tsx                 5 +---
src/components/chat/ChatView.tsx           6 ++--
src/components/layout/SplitColumn.tsx      3 ---
src/components/plugins/McpManager.tsx     18 +++++++
src/components/plugins/McpServerList.tsx  15 +++++++-
src/i18n/en.ts                             6 ++--
src/i18n/zh.ts                             6 ++--
src/lib/agent-sdk-capabilities.ts         12 ++++++
src/lib/bridge/conversation-engine.ts      6 +++
src/lib/claude-client.ts                  32 +++++++++++------
src/types/index.ts                         2 ++
docs/exec-plans/README.md                  1 +
docs/research/README.md                    1 +
```
