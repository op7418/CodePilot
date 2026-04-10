'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  action?: ToastAction;
  duration?: number;
}

const MAX_TOASTS = 3;
const DEFAULT_DURATION = 5000;
const ERROR_DURATION = 8000;

let globalAddToast: ((toast: Omit<Toast, 'id'>) => void) | null = null;

/** Imperatively show a toast from anywhere */
export function showToast(toast: Omit<Toast, 'id'>) {
  if (globalAddToast) {
    globalAddToast(toast);
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

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `toast-${++counterRef.current}`;
    const duration = toast.duration ?? (toast.type === 'error' ? ERROR_DURATION : DEFAULT_DURATION);

    setToasts(prev => {
      const next = [...prev, { ...toast, id }];
      // FIFO eviction
      while (next.length > MAX_TOASTS) {
        const evicted = next.shift()!;
        const timer = timersRef.current.get(evicted.id);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(evicted.id);
        }
      }
      return next;
    });

    const timer = setTimeout(() => removeToast(id), duration);
    timersRef.current.set(id, timer);
  }, [removeToast]);

  // Register as global handler
  useEffect(() => {
    globalAddToast = addToast;
    return () => {
      if (globalAddToast === addToast) globalAddToast = null;
    };
  }, [addToast]);

  // Cleanup on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
    };
  }, []);

  return { toasts, addToast, removeToast };
}
