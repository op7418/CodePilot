'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/hooks/useTranslation';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Lock, LockOpen, CaretDown } from '@/components/ui/icon';

interface ChatPermissionSelectorProps {
  sessionId?: string;
  permissionProfile: 'default' | 'full_access';
  onPermissionChange: (profile: 'default' | 'full_access') => void;
}

export function ChatPermissionSelector({
  sessionId,
  permissionProfile,
  onPermissionChange,
}: ChatPermissionSelectorProps) {
  const { t } = useTranslation();
  const [showWarning, setShowWarning] = useState(false);

  const handleSelect = (profile: 'default' | 'full_access') => {
    if (profile === 'full_access' && permissionProfile !== 'full_access') {
      setShowWarning(true);
      return;
    }
    applyChange(profile);
  };

  const applyChange = async (profile: 'default' | 'full_access') => {
    // No sessionId yet (new chat) — local-only update
    if (!sessionId) {
      onPermissionChange(profile);
      return;
    }
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission_profile: profile }),
      });
      if (!res.ok) {
        console.warn(`[ChatPermissionSelector] PATCH failed: ${res.status}`);
        return;
      }
      onPermissionChange(profile);
    } catch (err) {
      console.warn('[ChatPermissionSelector] PATCH error:', err);
    }
  };

  const isFullAccess = permissionProfile === 'full_access';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'rounded-md px-2.5 h-7 text-xs font-medium border transition-all gap-1',
              isFullAccess
                ? 'bg-status-error-muted text-status-error-foreground border-status-error-foreground/30'
                : 'text-muted-foreground border-border/60 hover:text-foreground hover:border-foreground/30 hover:bg-accent/50'
            )}
          >
            {isFullAccess ? (
              <LockOpen size={14} className="text-status-error-foreground" />
            ) : (
              <Lock size={14} />
            )}
            <span>
              {isFullAccess ? t('permission.fullAccess') : t('permission.default')}
            </span>
            <CaretDown size={10} className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[140px]">
          <DropdownMenuItem onClick={() => handleSelect('default')}>
            <Lock size={14} />
            <span>{t('permission.default')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSelect('full_access')}>
            <LockOpen size={14} className="text-status-error-foreground" />
            <span>{t('permission.fullAccess')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showWarning} onOpenChange={setShowWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('permission.fullAccess')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('permission.fullAccessWarning')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setShowWarning(false);
                applyChange('full_access');
              }}
            >
              {t('permission.fullAccess')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
