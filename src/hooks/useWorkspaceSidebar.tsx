'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  initialState,
  openDynamicTab as pureOpen,
  closeTab as pureClose,
  setActiveTab as pureSetActive,
  setOpen as pureSetOpen,
  setWidth as pureSetWidth,
  parse,
  serialize,
  storageKey,
  tabFromPreviewSource,
  type DynamicTab,
  type WorkspaceSidebarState,
} from '@/lib/workspace-sidebar';
import type { PreviewSource } from '@/hooks/usePanel';

/**
 * Window event other parts of the app dispatch to ask the sidebar to
 * open or focus a Tab for a given PreviewSource. Lets AppShell /
 * MessageItem / FileTreePanel stay decoupled from the sidebar's
 * imperative API while still routing previews through it.
 */
export const WORKSPACE_TAB_OPEN_EVENT = 'workspace-tab-open-request';

export interface WorkspaceTabOpenDetail {
  source: PreviewSource;
}

interface WorkspaceSidebarContextValue {
  state: WorkspaceSidebarState;
  openTab: (tab: DynamicTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
}

export const WorkspaceSidebarContext = createContext<WorkspaceSidebarContextValue | null>(null);

interface ProviderProps {
  workingDirectory: string;
  sessionId: string;
  children: React.ReactNode;
}

/**
 * Provider for the right-side Workspace Sidebar. Persists the
 * (open, width, activeTabId, dynamicTabs) tuple to localStorage
 * keyed by `workspace::cwd::sessionId`, so two projects (or two
 * sessions in the same project) don't share Tab lists.
 *
 * SSR safety: localStorage isn't read until after mount, so the
 * server and the client's first paint both see `initialState()`
 * (closed, fixed Tabs only). The persisted state then hydrates in
 * a follow-up effect — this matches React's "don't read browser
 * state during render" rule and avoids hydration mismatches.
 */
export function WorkspaceSidebarProvider({ workingDirectory, sessionId, children }: ProviderProps) {
  const key = storageKey(workingDirectory, sessionId);
  const [state, setState] = useState<WorkspaceSidebarState>(() => initialState());

  // Hydrate from storage when the scope (workspace + session) changes.
  // Without this, switching chats inside the same workspace would keep
  // the previous chat's dynamic Tabs around.
  useEffect(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
      setState(parse(raw));
    } catch {
      setState(initialState());
    }
  }, [key]);

  // Persist with a trailing-edge debounce so rapid state mutations
  // (tab open / close / activate / resize handle drag) are batched
  // into a single synchronous localStorage write instead of blocking
  // the main thread on every individual state tick. The debounce is
  // short enough (150ms) that losing the very last mutation before
  // a refresh is extremely unlikely in practice.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(key, JSON.stringify(serialize(state)));
      } catch {
        // Quota / disabled storage: ignore. The in-memory state still works.
      }
    }, 150);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [key, state]);

  const openTab = useCallback((tab: DynamicTab) => {
    setState((prev) => pureOpen(prev, tab));
  }, []);

  // Bridge: callers who only know about PreviewSource (AppShell's
  // setPreviewSource, the file-tree click path, the DiffSummary card)
  // dispatch a window event; we translate it into an openTab call so
  // they don't need to import this hook directly.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<WorkspaceTabOpenDetail>).detail;
      if (!detail || !detail.source) return;
      try {
        const tab = tabFromPreviewSource(detail.source);
        setState((prev) => pureOpen(prev, tab));
      } catch {
        // Defensive — a malformed source should never break the chat.
      }
    };
    window.addEventListener(WORKSPACE_TAB_OPEN_EVENT, handler);
    return () => window.removeEventListener(WORKSPACE_TAB_OPEN_EVENT, handler);
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((prev) => pureClose(prev, id));
  }, []);
  const setActiveTab = useCallback((id: string) => {
    setState((prev) => pureSetActive(prev, id));
  }, []);
  const setOpen = useCallback((open: boolean) => {
    setState((prev) => pureSetOpen(prev, open));
  }, []);
  const setWidth = useCallback((width: number) => {
    setState((prev) => pureSetWidth(prev, width));
  }, []);

  const value = useMemo(
    () => ({ state, openTab, closeTab, setActiveTab, setOpen, setWidth }),
    [state, openTab, closeTab, setActiveTab, setOpen, setWidth],
  );

  return (
    <WorkspaceSidebarContext.Provider value={value}>
      {children}
    </WorkspaceSidebarContext.Provider>
  );
}

export function useWorkspaceSidebar(): WorkspaceSidebarContextValue {
  const ctx = useContext(WorkspaceSidebarContext);
  if (!ctx) {
    throw new Error('useWorkspaceSidebar must be used inside <WorkspaceSidebarProvider>');
  }
  return ctx;
}

/**
 * Optional variant that returns null when no provider is mounted.
 * Useful for components that may render either inside the chat shell
 * (provider present) or in older surfaces that haven't been migrated.
 */
export function useWorkspaceSidebarOptional(): WorkspaceSidebarContextValue | null {
  return useContext(WorkspaceSidebarContext);
}
