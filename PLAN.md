# Fix Plan: Mobile Sidebar + Task Interruption

## Problem 1: Mobile sidebar cannot be opened
- **Root cause**: `NavRail` component was removed, which contained the sidebar toggle button. No replacement toggle was added.
- **Orphaned `left-14`**: ChatListPanel still offsets 56px for the removed NavRail.

## Problem 2: Tasks interrupted on browser disconnect
- **Root cause**: `/api/chat/route.ts:189-191` forwards `request.signal` abort to the SDK subprocess `abortController`, killing it when the browser disconnects.
- **Solution**: Remove `request.signal` forwarding; intentional stops already use `/api/chat/interrupt` via `conversation-registry`.

## Changes

### Phase 1: Fix mobile sidebar toggle
- [ ] `ChatListPanel.tsx`: Fix `left-14` → `left-0`
- [ ] `usePanel.ts`: Add `chatListOpen` + `setChatListOpen` to context interface
- [ ] `AppShell.tsx`: Provide `chatListOpen` + `setChatListOpen` via PanelContext
- [ ] `UnifiedTopBar.tsx`: Add hamburger toggle button (visible on mobile when sidebar closed)

### Phase 2: Fix task interruption on disconnect
- [ ] `api/chat/route.ts`: Remove `request.signal` → `abortController` forwarding

## Verification
- [ ] Build passes (`npm run typecheck`)
- [ ] Test sidebar toggle on mobile viewport
- [ ] Test task continues after browser disconnect
