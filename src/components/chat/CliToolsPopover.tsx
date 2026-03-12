'use client';

import { useCallback } from 'react';
import { Terminal } from '@/components/ui/icon';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { CliToolItem } from '@/types';
import {
  CommandList,
  CommandListSearch,
  CommandListItems,
  CommandListItem,
  CommandListEmpty,
  CommandListFooter,
  CommandListFooterAction,
} from '@/components/patterns';

export type { CliToolItem } from '@/types';

interface CliToolsPopoverProps {
  popoverRef: React.RefObject<HTMLDivElement | null>;
  cliTools: CliToolItem[];
  cliFilter: string;
  selectedIndex: number;
  cliSearchRef: React.RefObject<HTMLInputElement | null>;
  onSetCliFilter: (filter: string) => void;
  onSetSelectedIndex: (index: number) => void;
  onCliSelect: (tool: CliToolItem) => void;
  onClosePopover: () => void;
  onFocusTextarea: () => void;
}

export function CliToolsPopover({
  popoverRef,
  cliTools,
  cliFilter,
  selectedIndex,
  cliSearchRef,
  onSetCliFilter,
  onSetSelectedIndex,
  onCliSelect,
  onClosePopover,
  onFocusTextarea,
}: CliToolsPopoverProps) {
  const { t } = useTranslation();

  const q = cliFilter.toLowerCase();
  const filtered = cliTools.filter(tool =>
    tool.name.toLowerCase().includes(q) || tool.summary.toLowerCase().includes(q)
  );

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onSetSelectedIndex(Math.min(selectedIndex + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onSetSelectedIndex(Math.max(selectedIndex - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) onCliSelect(filtered[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClosePopover();
      onFocusTextarea();
    }
  }, [selectedIndex, filtered, onSetSelectedIndex, onCliSelect, onClosePopover, onFocusTextarea]);

  return (
    <div ref={popoverRef}>
      <CommandList className="w-full max-w-2xl">
        <CommandListSearch
          inputRef={cliSearchRef}
          placeholder={t('cliTools.searchPlaceholder' as TranslationKey)}
          value={cliFilter}
          onChange={(val) => { onSetCliFilter(val); onSetSelectedIndex(0); }}
          onKeyDown={handleSearchKeyDown}
        />
        <CommandListItems className="max-h-48">
          {filtered.length > 0 ? (
            filtered.map((tool, idx) => (
              <CommandListItem
                key={tool.id}
                active={idx === selectedIndex}
                itemRef={idx === selectedIndex ? (el) => { el?.scrollIntoView({ block: 'nearest' }); } : undefined}
                onClick={() => onCliSelect(tool)}
                onMouseEnter={() => onSetSelectedIndex(idx)}
              >
                <Terminal size={16} className="shrink-0 text-muted-foreground" />
                <span className="font-medium text-xs truncate">{tool.name}</span>
                {tool.version && (
                  <span className="text-[10px] text-muted-foreground shrink-0">v{tool.version}</span>
                )}
                {tool.summary && (
                  <span className="text-xs text-muted-foreground truncate ml-auto max-w-[200px]">{tool.summary}</span>
                )}
              </CommandListItem>
            ))
          ) : (
            <CommandListEmpty>
              <p className="text-sm text-muted-foreground">{t('cliTools.noToolsDetected' as TranslationKey)}</p>
              <CommandListFooterAction onClick={() => { onClosePopover(); window.location.href = '/cli-tools'; }}>
                <span className="mt-2 text-xs text-primary hover:underline">
                  {t('cliTools.goInstall' as TranslationKey)}
                </span>
              </CommandListFooterAction>
            </CommandListEmpty>
          )}
        </CommandListItems>
        {/* Footer: manage CLI tools */}
        <CommandListFooter>
          <CommandListFooterAction onClick={() => { onClosePopover(); window.location.href = '/cli-tools'; }}>
            <Terminal size={14} />
            {t('cliTools.manageCli' as TranslationKey)}
          </CommandListFooterAction>
        </CommandListFooter>
      </CommandList>
    </div>
  );
}
