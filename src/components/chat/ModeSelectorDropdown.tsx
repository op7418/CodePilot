'use client';

import { useRef, useState, useEffect } from 'react';
import { CaretDown } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import {
  CommandList,
  CommandListItem,
  CommandListGroup,
} from '@/components/patterns';

const MODES = ['code', 'plan'] as const;

interface ModeSelectorDropdownProps {
  currentMode: string;
  onModeChange: (mode: string) => void;
}

export function ModeSelectorDropdown({
  currentMode,
  onModeChange,
}: ModeSelectorDropdownProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const labelKey = `messageInput.mode${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}` as TranslationKey;

  return (
    <div className="relative" ref={menuRef}>
      <PromptInputButton onClick={() => setMenuOpen((prev) => !prev)}>
        <span className="text-xs">{t(labelKey)}</span>
        <CaretDown size={10} className={cn("transition-transform duration-200", menuOpen && "rotate-180")} />
      </PromptInputButton>

      {menuOpen && (
        <CommandList className="w-32 mb-1.5 rounded-lg">
          <CommandListGroup label={t('messageInput.modeLabel' as TranslationKey)}>
            <div className="py-0.5">
              {MODES.map((mode) => (
                <CommandListItem
                  key={mode}
                  active={currentMode === mode}
                  onClick={() => {
                    onModeChange(mode);
                    setMenuOpen(false);
                  }}
                  className="justify-between"
                >
                  <span className="text-xs">{t(`messageInput.mode${mode.charAt(0).toUpperCase() + mode.slice(1)}` as TranslationKey)}</span>
                  {currentMode === mode && <span className="text-xs">&#10003;</span>}
                </CommandListItem>
              ))}
            </div>
          </CommandListGroup>
        </CommandList>
      )}
    </div>
  );
}
