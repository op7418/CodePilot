import { useEffect, useCallback } from 'react';

export function useGlobalSearchShortcut(onOpen: () => void) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isModifier = e.metaKey || e.ctrlKey;
      if (isModifier && e.key.toLowerCase() === 'k') {
        // Avoid intercepting when an input/textarea is focused
        const active = document.activeElement;
        const isEditing =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active?.getAttribute('contenteditable') === 'true';
        // Still allow shortcut when focus is on body or non-editable elements
        if (!isEditing) {
          e.preventDefault();
          onOpen();
        }
      }
    },
    [onOpen],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
