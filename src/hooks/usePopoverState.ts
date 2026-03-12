import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import type { PopoverItem, PopoverMode } from '@/types';
import { filterItems } from '@/lib/message-input-logic';

export interface UsePopoverStateReturn {
  popoverMode: PopoverMode;
  setPopoverMode: (mode: PopoverMode) => void;
  popoverItems: PopoverItem[];
  setPopoverItems: (items: PopoverItem[]) => void;
  popoverFilter: string;
  setPopoverFilter: (filter: string) => void;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  triggerPos: number | null;
  setTriggerPos: (pos: number | null) => void;
  filteredItems: PopoverItem[];
  allDisplayedItems: PopoverItem[];
  aiSuggestions: PopoverItem[];
  aiSearchLoading: boolean;
  closePopover: () => void;
  popoverRef: React.RefObject<HTMLDivElement | null>;
}

export function usePopoverState(modelName?: string): UsePopoverStateReturn {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPos, setTriggerPos] = useState<number | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<PopoverItem[]>([]);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const aiSearchAbortRef = useRef<AbortController | null>(null);
  const aiSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
    // Clean up AI search state
    setAiSuggestions([]);
    setAiSearchLoading(false);
    if (aiSearchTimerRef.current) {
      clearTimeout(aiSearchTimerRef.current);
      aiSearchTimerRef.current = null;
    }
    if (aiSearchAbortRef.current) {
      aiSearchAbortRef.current.abort();
      aiSearchAbortRef.current = null;
    }
  }, []);

  const filteredItems = useMemo(() =>
    filterItems(popoverItems, popoverFilter),
  [popoverItems, popoverFilter]);

  // Debounced AI semantic search when substring results are insufficient
  const nonBuiltInFilteredCount = filteredItems.filter(i => !i.builtIn).length;
  useEffect(() => {
    // Only trigger for skill mode with enough input and few substring matches
    if (popoverMode !== 'skill' || popoverFilter.length < 2 || nonBuiltInFilteredCount >= 2) {
      setAiSuggestions([]);
      setAiSearchLoading(false);
      if (aiSearchTimerRef.current) {
        clearTimeout(aiSearchTimerRef.current);
        aiSearchTimerRef.current = null;
      }
      if (aiSearchAbortRef.current) {
        aiSearchAbortRef.current.abort();
        aiSearchAbortRef.current = null;
      }
      return;
    }

    // Cancel previous timer and request
    if (aiSearchTimerRef.current) {
      clearTimeout(aiSearchTimerRef.current);
    }
    if (aiSearchAbortRef.current) {
      aiSearchAbortRef.current.abort();
    }

    setAiSearchLoading(true);

    aiSearchTimerRef.current = setTimeout(async () => {
      const abortController = new AbortController();
      aiSearchAbortRef.current = abortController;

      try {
        // Collect non-built-in skills for AI search
        const skillsPayload = popoverItems
          .filter(i => !i.builtIn)
          .map(i => ({ name: i.label, description: (i.description || '').slice(0, 100) }));

        if (skillsPayload.length === 0) {
          setAiSearchLoading(false);
          return;
        }

        const res = await fetch('/api/skills/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            query: popoverFilter,
            skills: skillsPayload,
            model: modelName || 'haiku',
          }),
        });

        if (abortController.signal.aborted) return;

        if (!res.ok) {
          setAiSuggestions([]);
          setAiSearchLoading(false);
          return;
        }

        const data = await res.json();
        const suggestions: string[] = data.suggestions || [];

        // Map suggested names back to PopoverItems, deduplicating against substring results
        const filteredNames = new Set(filteredItems.map(i => i.label));
        const aiItems = suggestions
          .filter(name => !filteredNames.has(name))
          .map(name => popoverItems.find(i => i.label === name))
          .filter((item): item is PopoverItem => !!item);

        setAiSuggestions(aiItems);
      } catch {
        // Silently fail — don't show AI suggestions on error
        if (!abortController.signal.aborted) {
          setAiSuggestions([]);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setAiSearchLoading(false);
        }
      }
    }, 500);

    return () => {
      if (aiSearchTimerRef.current) {
        clearTimeout(aiSearchTimerRef.current);
        aiSearchTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popoverFilter, popoverMode, nonBuiltInFilteredCount]);

  // Combined list for keyboard navigation
  const allDisplayedItems = useMemo(
    () => [...filteredItems, ...aiSuggestions],
    [filteredItems, aiSuggestions],
  );

  // Click outside to close popover
  useEffect(() => {
    if (!popoverMode) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverMode, closePopover]);

  return {
    popoverMode,
    setPopoverMode,
    popoverItems,
    setPopoverItems,
    popoverFilter,
    setPopoverFilter,
    selectedIndex,
    setSelectedIndex,
    triggerPos,
    setTriggerPos,
    filteredItems,
    allDisplayedItems,
    aiSuggestions,
    aiSearchLoading,
    closePopover,
    popoverRef,
  };
}
