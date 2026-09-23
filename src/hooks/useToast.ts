'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'loading';
export type ToastPlacement = 'bottom-left' | 'bottom-right';
export type ToastBrand = 'claude' | 'codex' | 'multi';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  action?: ToastAction;
  duration?: number;
  placement?: ToastPlacement;
  variant?: 'toast' | 'card';
  brand?: ToastBrand;
  persistent?: boolean;
  dismissible?: boolean;
  onDismiss?: () => void;
}

const MAX_TOASTS = 3;
const DEFAULT_DURATION = 5000;
const ERROR_DURATION = 8000;

let globalAddToast: ((toast: Omit<Toast, 'id'>) => string) | null = null;
let globalUpdateToast: ((id: string, updates: Partial<Omit<Toast, 'id'>>) => void) | null = null;

/** Imperatively show a toast from anywhere */
export function showToast(toast: Omit<Toast, 'id'>): string {
  if (globalAddToast) {
    return globalAddToast(toast);
  }
  return '';
}

/** Show a loading toast that persists until updated. Returns the toast id. */
export function showLoadingToast(message: string): string {
  return showToast({ type: 'loading', message, duration: 0 });
}

/** Update an existing toast (e.g. loading → success) */
export function updateToast(id: string, updates: Partial<Omit<Toast, 'id'>>) {
  if (globalUpdateToast) {
    globalUpdateToast(id, updates);
  }
}

export function useToastState() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = `toast-${++counterRef.current}`;
    const duration = toast.duration ?? (toast.type === 'error' ? ERROR_DURATION : toast.type === 'loading' ? 0 : DEFAULT_DURATION);

    setToasts(prev => {
      const next = [...prev, { ...toast, id }];
      // FIFO eviction for ordinary toasts. Persistent cards are removed only
      // by their explicit close action or their own terminal transition.
      while (next.length > MAX_TOASTS) {
        const evictedIndex = next.findIndex(item => !item.persistent);
        if (evictedIndex < 0) break;
        const [evicted] = next.splice(evictedIndex, 1);
        const timer = timersRef.current.get(evicted.id);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(evicted.id);
        }
      }
      return next;
    });

    if (duration > 0) {
      const timer = setTimeout(() => removeToast(id), duration);
      timersRef.current.set(id, timer);
    }
    return id;
  }, [removeToast]);

  const updateExistingToast = useCallback((id: string, updates: Partial<Omit<Toast, 'id'>>) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
    if (updates.type || updates.duration !== undefined) {
      const oldTimer = timersRef.current.get(id);
      if (oldTimer) {
        clearTimeout(oldTimer);
        timersRef.current.delete(id);
      }
      const duration = updates.duration
        ?? (updates.type === 'error' ? ERROR_DURATION : updates.type === 'loading' ? 0 : DEFAULT_DURATION);
      if (duration > 0) {
        const timer = setTimeout(() => removeToast(id), duration);
        timersRef.current.set(id, timer);
      }
    }
  }, [removeToast]);

  // Register as global handler
  useEffect(() => {
    globalAddToast = addToast;
    globalUpdateToast = updateExistingToast;
    return () => {
      if (globalAddToast === addToast) globalAddToast = null;
      if (globalUpdateToast === updateExistingToast) globalUpdateToast = null;
    };
  }, [addToast, updateExistingToast]);

  // Cleanup on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
    };
  }, []);

  return { toasts, addToast, removeToast };
}
