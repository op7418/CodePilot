'use client';

import { X, CheckCircle, XCircle, Warning, Info, ArrowClockwise } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useToastState, type Toast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';

const ICON_MAP = {
  success: CheckCircle,
  error: XCircle,
  warning: Warning,
  info: Info,
  loading: ArrowClockwise,
};

const STYLE_MAP = {
  success: 'border-status-success/30 bg-status-success-muted text-status-success-foreground',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-status-warning/30 bg-status-warning-muted text-status-warning-foreground',
  info: 'border-border bg-muted text-foreground',
  loading: 'border-border bg-muted text-foreground',
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = ICON_MAP[toast.type];
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 shadow-lg text-sm animate-in slide-in-from-bottom-2 fade-in duration-200',
        STYLE_MAP[toast.type]
      )}
    >
      <Icon size={16} className={cn("shrink-0", toast.type === 'loading' && "animate-spin")} />
      <span className="flex-1 min-w-0 truncate">{toast.message}</span>
      {toast.action && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs shrink-0"
          onClick={toast.action.onClick}
        >
          {toast.action.label}
        </Button>
      )}
      <button onClick={onDismiss} className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10">
        <X size={12} />
      </button>
    </div>
  );
}

export function Toaster() {
  const { toasts, removeToast } = useToastState();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );
}
