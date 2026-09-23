'use client';

import { X, CheckCircle, XCircle, Warning, Info, SpinnerGap } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useToastState, type Toast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';
import Anthropic from '@lobehub/icons/es/Anthropic';
import OpenAI from '@lobehub/icons/es/OpenAI';

const ICON_MAP = {
  success: CheckCircle,
  error: XCircle,
  warning: Warning,
  info: Info,
  loading: SpinnerGap,
};

const STYLE_MAP = {
  success: 'border-status-success/30 bg-status-success-muted text-status-success-foreground',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-status-warning/30 bg-status-warning-muted text-status-warning-foreground',
  info: 'border-border bg-muted text-foreground',
  loading: 'border-border bg-muted text-foreground',
};

const CARD_STYLE_MAP = {
  success: 'border-status-success/35',
  error: 'border-destructive/35',
  warning: 'border-status-warning/40',
  info: 'border-border/80',
  loading: 'border-border/80',
};

function ToastBrandIcon({ brand }: { brand: Toast['brand'] }) {
  if (brand === 'claude') return <Anthropic size={19} aria-hidden />;
  if (brand === 'codex') return <OpenAI size={19} aria-hidden />;
  if (brand === 'multi') {
    return (
      <div className="flex items-center -space-x-1" aria-hidden>
        <span className="grid place-items-center size-5 rounded-full bg-background"><Anthropic size={13} /></span>
        <span className="grid place-items-center size-5 rounded-full bg-background"><OpenAI size={13} /></span>
      </div>
    );
  }
  return <Info size={18} aria-hidden />;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = ICON_MAP[toast.type];
  const isCard = toast.variant === 'card';
  if (isCard) {
    return (
      <div
        className={cn(
          'relative rounded-xl border bg-popover/95 text-popover-foreground px-3 py-3 shadow-xl backdrop-blur-xl',
          'animate-in slide-in-from-bottom-2 fade-in duration-200',
          CARD_STYLE_MAP[toast.type],
        )}
      >
        <div className="flex items-start gap-2.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/70">
            <ToastBrandIcon brand={toast.brand} />
          </div>
          <div className="min-w-0 flex-1 pr-7">
            <div className="flex min-h-7 items-center gap-1.5">
              <div className="truncate text-[13px] font-semibold leading-5">{toast.title ?? toast.message}</div>
              {toast.type !== 'info' && (
                <Icon
                  size={14}
                  className={cn(
                    'shrink-0',
                    toast.type === 'loading' && 'animate-spin text-muted-foreground',
                    toast.type === 'success' && 'text-status-success-foreground',
                    toast.type === 'warning' && 'text-status-warning-foreground',
                    toast.type === 'error' && 'text-destructive',
                  )}
                />
              )}
            </div>
            <div className="whitespace-pre-line text-[11px] leading-[17px] text-muted-foreground">
              {toast.message}
            </div>
            {toast.action && (
              <div className="mt-2 flex justify-start">
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 min-w-16 px-3 text-xs font-medium shadow-sm"
                  onClick={toast.action.onClick}
                >
                  {toast.action.label}
                </Button>
              </div>
            )}
          </div>
        </div>
        {toast.dismissible !== false && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              toast.onDismiss?.();
              onDismiss();
            }}
            className="absolute right-2 top-2 grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'flex gap-2 rounded-lg border shadow-lg text-sm animate-in slide-in-from-bottom-2 fade-in duration-200',
        'items-center px-3 py-2',
        STYLE_MAP[toast.type]
      )}
    >
      <Icon
        size={16}
        className={cn('shrink-0', toast.type === 'loading' && 'animate-spin')}
      />
      <div className="flex-1 min-w-0">
        {toast.title && <div className="font-medium leading-5">{toast.title}</div>}
        <div className="truncate">
          {toast.message}
        </div>
      </div>
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
      {toast.dismissible !== false && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            toast.onDismiss?.();
            onDismiss();
          }}
          className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function Toaster() {
  const { toasts, removeToast } = useToastState();

  if (toasts.length === 0) return null;

  const renderGroup = (placement: Toast['placement']) => {
    const group = toasts.filter(toast => (toast.placement ?? 'bottom-right') === placement);
    if (group.length === 0) return null;
    return (
      <div className={cn(
        'fixed z-[100] flex flex-col gap-2',
        placement === 'bottom-left'
          ? 'bottom-3 left-3 w-[min(18rem,calc(100vw-1.5rem))]'
          : 'bottom-4 right-4 w-[min(23rem,calc(100vw-2rem))]',
      )}>
        {group.map(toast => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onDismiss={() => removeToast(toast.id)}
          />
        ))}
      </div>
    );
  };

  return (
    <>
      {renderGroup('bottom-left')}
      {renderGroup('bottom-right')}
    </>
  );
}
