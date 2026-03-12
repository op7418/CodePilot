import { useState, useCallback } from 'react';
import type { CliToolItem, PopoverMode } from '@/types';

export interface UseCliToolsFetchReturn {
  cliTools: CliToolItem[];
  cliFilter: string;
  setCliFilter: (filter: string) => void;
  fetchCliTools: () => Promise<void>;
  handleCliSelect: (tool: CliToolItem) => void;
  handleOpenCliPopover: () => Promise<void>;
}

export function useCliToolsFetch(opts: {
  popoverMode: PopoverMode;
  closePopover: () => void;
  setPopoverMode: (mode: PopoverMode) => void;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  inputValue: string;
  locale: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  cliSearchRef: React.RefObject<HTMLInputElement | null>;
  setCliBadge: (badge: { id: string; name: string } | null) => void;
  setInputValue: (value: string) => void;
}): UseCliToolsFetchReturn {
  const {
    popoverMode,
    closePopover,
    setPopoverMode,
    setSelectedIndex,
    inputValue,
    locale,
    textareaRef,
    cliSearchRef,
    setCliBadge,
    setInputValue,
  } = opts;

  const [cliTools, setCliTools] = useState<CliToolItem[]>([]);
  const [cliFilter, setCliFilter] = useState('');

  const fetchCliTools = useCallback(async () => {
    try {
      const [installedRes, catalogRes] = await Promise.all([
        fetch('/api/cli-tools/installed'),
        fetch('/api/cli-tools/catalog'),
      ]);
      const installedData = await installedRes.json();
      const catalogData = await catalogRes.json();

      const catalogTools = catalogData.tools || [];
      const runtimeInfos = installedData.tools || [];
      const extraDetected = installedData.extra || [];

      // Build lookup for catalog summaries
      const catalogMap = new Map<string, { name: string; summaryZh: string; summaryEn: string }>();
      for (const ct of catalogTools) {
        catalogMap.set(ct.id, { name: ct.name, summaryZh: ct.summaryZh, summaryEn: ct.summaryEn });
      }

      // Extra well-known names lookup
      const extraNames: Record<string, string> = {};
      try {
        const { EXTRA_WELL_KNOWN_BINS } = await import('@/lib/cli-tools-catalog');
        for (const [id, name] of EXTRA_WELL_KNOWN_BINS) {
          extraNames[id] = name;
        }
      } catch { /* ignore */ }

      // Load cached AI descriptions
      let autoDesc: Record<string, { zh: string; en: string }> = {};
      try {
        const cached = localStorage.getItem('cli-tools-auto-desc');
        if (cached) autoDesc = JSON.parse(cached);
      } catch { /* ignore */ }

      const docLocale = document.documentElement.lang === 'zh' ? 'zh' : 'en';
      const items: CliToolItem[] = [];

      // Installed catalog tools
      for (const ri of runtimeInfos) {
        if (ri.status !== 'installed') continue;
        const cat = catalogMap.get(ri.id);
        const ad = autoDesc[ri.id];
        const summary = ad
          ? (docLocale === 'zh' ? ad.zh : ad.en)
          : cat
            ? (docLocale === 'zh' ? cat.summaryZh : cat.summaryEn)
            : '';
        items.push({
          id: ri.id,
          name: cat?.name || ri.id,
          version: ri.version,
          summary,
        });
      }

      // Extra detected tools
      for (const ri of extraDetected) {
        const ad = autoDesc[ri.id];
        const summary = ad ? (docLocale === 'zh' ? ad.zh : ad.en) : '';
        items.push({
          id: ri.id,
          name: extraNames[ri.id] || ri.id,
          version: ri.version,
          summary,
        });
      }

      setCliTools(items);
    } catch {
      setCliTools([]);
    }
  }, []);

  const handleCliSelect = useCallback((tool: CliToolItem) => {
    closePopover();
    setCliFilter('');

    if (!inputValue.trim()) {
      // Empty input: prefill with prompt template
      const prefix = locale === 'zh'
        ? `我想用 ${tool.name} 工具完成：`
        : `I want to use ${tool.name} to: `;
      setInputValue(prefix);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = prefix.length;
        }
      }, 0);
    } else {
      // Non-empty input: set CLI badge
      setCliBadge({ id: tool.id, name: tool.name });
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [inputValue, locale, closePopover, textareaRef, setCliBadge, setInputValue]);

  const handleOpenCliPopover = useCallback(async () => {
    if (popoverMode === 'cli') {
      closePopover();
      return;
    }
    closePopover();
    setPopoverMode('cli');
    setCliFilter('');
    setSelectedIndex(0);
    // Focus search input on next render (before fetch completes)
    setTimeout(() => cliSearchRef.current?.focus(), 0);
    fetchCliTools();
  }, [popoverMode, closePopover, fetchCliTools, setPopoverMode, setSelectedIndex, cliSearchRef]);

  return {
    cliTools,
    cliFilter,
    setCliFilter,
    fetchCliTools,
    handleCliSelect,
    handleOpenCliPopover,
  };
}
