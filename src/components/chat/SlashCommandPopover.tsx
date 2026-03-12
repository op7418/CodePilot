'use client';

import { useCallback } from 'react';
import { At, Terminal, NotePencil, Brain, GlobeSimple, Lightning } from '@/components/ui/icon';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { PopoverItem, PopoverMode } from '@/types';
import {
  CommandList,
  CommandListSearch,
  CommandListItems,
  CommandListItem,
  CommandListGroup,
  CommandListFooter,
  CommandListFooterAction,
} from '@/components/patterns';

export type { PopoverItem, PopoverMode } from '@/types';

interface SlashCommandPopoverProps {
  popoverMode: PopoverMode;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  filteredItems: PopoverItem[];
  aiSuggestions: PopoverItem[];
  aiSearchLoading: boolean;
  selectedIndex: number;
  popoverFilter: string;
  inputValue: string;
  triggerPos: number | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  allDisplayedItems: PopoverItem[];
  onInsertItem: (item: PopoverItem) => void;
  onSetSelectedIndex: (index: number) => void;
  onSetPopoverFilter: (filter: string) => void;
  onSetInputValue: (value: string) => void;
  onClosePopover: () => void;
  onFocusTextarea: () => void;
}

export function SlashCommandPopover({
  popoverMode,
  popoverRef,
  filteredItems,
  aiSuggestions,
  aiSearchLoading,
  selectedIndex,
  popoverFilter,
  inputValue,
  triggerPos,
  searchInputRef,
  allDisplayedItems,
  onInsertItem,
  onSetSelectedIndex,
  onSetPopoverFilter,
  onSetInputValue,
  onClosePopover,
  onFocusTextarea,
}: SlashCommandPopoverProps) {
  const { t } = useTranslation();

  const builtInItems = filteredItems.filter(item => item.builtIn);
  const slashCommandItems = filteredItems.filter(item => !item.builtIn && item.kind !== 'agent_skill');
  const agentSkillItems = filteredItems.filter(item => !item.builtIn && item.kind === 'agent_skill');
  let globalIdx = 0;

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onSetSelectedIndex((selectedIndex + 1) % allDisplayedItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onSetSelectedIndex((selectedIndex - 1 + allDisplayedItems.length) % allDisplayedItems.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (allDisplayedItems[selectedIndex]) {
        onInsertItem(allDisplayedItems[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClosePopover();
      onFocusTextarea();
    }
  }, [selectedIndex, allDisplayedItems, onSetSelectedIndex, onInsertItem, onClosePopover, onFocusTextarea]);

  const handleFilterChange = useCallback((val: string) => {
    onSetPopoverFilter(val);
    onSetSelectedIndex(0);
    // Sync textarea: replace the filter portion after /
    if (triggerPos !== null) {
      const before = inputValue.slice(0, triggerPos + 1);
      onSetInputValue(before + val);
    }
  }, [triggerPos, inputValue, onSetPopoverFilter, onSetSelectedIndex, onSetInputValue]);

  const renderItem = (item: PopoverItem, idx: number) => (
    <CommandListItem
      key={`${idx}-${item.value}`}
      active={idx === selectedIndex}
      itemRef={idx === selectedIndex ? (el) => { el?.scrollIntoView({ block: 'nearest' }); } : undefined}
      onClick={() => onInsertItem(item)}
      onMouseEnter={() => onSetSelectedIndex(idx)}
    >
      {popoverMode === 'file' ? (
        <At size={16} className="shrink-0 text-muted-foreground" />
      ) : item.builtIn && item.icon ? (
        (() => { const ItemIcon = item.icon; return <ItemIcon size={16} className="shrink-0 text-muted-foreground" />; })()
      ) : item.kind === 'agent_skill' ? (
        <Brain size={16} className="shrink-0 text-muted-foreground" />
      ) : item.kind === 'slash_command' ? (
        <NotePencil size={16} className="shrink-0 text-muted-foreground" />
      ) : !item.builtIn ? (
        <GlobeSimple size={16} className="shrink-0 text-muted-foreground" />
      ) : (
        <Terminal size={16} className="shrink-0 text-muted-foreground" />
      )}
      <span className="font-mono text-xs truncate">{item.label}</span>
      {(item.descriptionKey || item.description) && (
        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
          {item.descriptionKey ? t(item.descriptionKey) : item.description}
        </span>
      )}
      {!item.builtIn && item.installedSource && (
        <span className="text-xs text-muted-foreground shrink-0 ml-auto">
          {item.installedSource === 'claude' ? 'Personal' : 'Agents'}
        </span>
      )}
    </CommandListItem>
  );

  if (!popoverMode || popoverMode === 'cli') return null;
  if (allDisplayedItems.length === 0 && !aiSearchLoading) return null;

  return (
    <div ref={popoverRef}>
      <CommandList className="w-full max-w-2xl">
        {popoverMode === 'skill' ? (
          <CommandListSearch
            inputRef={searchInputRef}
            value={popoverFilter}
            onChange={handleFilterChange}
            onKeyDown={handleSearchKeyDown}
          />
        ) : (
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
            Files
          </div>
        )}
        <CommandListItems className="max-h-48">
          {popoverMode === 'file' ? (
            filteredItems.map((item, i) => renderItem(item, i))
          ) : (
            <>
              {builtInItems.length > 0 && (
                <CommandListGroup label="Commands">
                  {builtInItems.map((item) => {
                    const idx = globalIdx++;
                    return renderItem(item, idx);
                  })}
                </CommandListGroup>
              )}
              {slashCommandItems.length > 0 && (
                <CommandListGroup label="Slash Commands">
                  {slashCommandItems.map((item) => {
                    const idx = globalIdx++;
                    return renderItem(item, idx);
                  })}
                </CommandListGroup>
              )}
              {agentSkillItems.length > 0 && (
                <CommandListGroup label="Agent Skills">
                  {agentSkillItems.map((item) => {
                    const idx = globalIdx++;
                    return renderItem(item, idx);
                  })}
                </CommandListGroup>
              )}
              {/* AI Suggested section */}
              {(aiSuggestions.length > 0 || aiSearchLoading) && (
                <CommandListGroup>
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Brain size={14} />
                    {t('messageInput.aiSuggested')}
                    {aiSearchLoading && (
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                  </div>
                  {aiSuggestions.map((item) => {
                    const idx = globalIdx++;
                    return renderItem(item, idx);
                  })}
                </CommandListGroup>
              )}
            </>
          )}
        </CommandListItems>
        {/* Footer: manage skills (skill mode only) */}
        {popoverMode === 'skill' && (
          <CommandListFooter>
            <CommandListFooterAction onClick={() => { onClosePopover(); window.location.href = '/skills'; }}>
              <Lightning size={14} />
              {t('composer.manageSkills' as TranslationKey)}
            </CommandListFooterAction>
          </CommandListFooter>
        )}
      </CommandList>
    </div>
  );
}
