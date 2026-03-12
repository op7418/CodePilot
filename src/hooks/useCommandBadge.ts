import { useState, useCallback } from 'react';
import type { CommandBadge, CliBadge } from '@/types';

export type { CommandBadge, CliBadge } from '@/types';

export interface UseCommandBadgeReturn {
  badge: CommandBadge | null;
  setBadge: (badge: CommandBadge | null) => void;
  cliBadge: CliBadge | null;
  setCliBadge: (badge: CliBadge | null) => void;
  removeBadge: () => void;
  removeCliBadge: () => void;
  hasBadge: boolean;
}

export function useCommandBadge(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): UseCommandBadgeReturn {
  const [badge, setBadge] = useState<CommandBadge | null>(null);
  const [cliBadge, setCliBadge] = useState<CliBadge | null>(null);

  const removeBadge = useCallback(() => {
    setBadge(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [textareaRef]);

  const removeCliBadge = useCallback(() => {
    setCliBadge(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [textareaRef]);

  return {
    badge,
    setBadge,
    cliBadge,
    setCliBadge,
    removeBadge,
    removeCliBadge,
    hasBadge: !!badge || !!cliBadge,
  };
}
