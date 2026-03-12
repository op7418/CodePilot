"use client";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SpinnerGap } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { WorkspaceInspectResult } from "@/types";

export type ConfirmDialogType =
  | { kind: 'not_found' }
  | { kind: 'empty' }
  | { kind: 'normal_directory' }
  | { kind: 'existing_workspace'; summary: NonNullable<WorkspaceInspectResult['summary']> }
  | { kind: 'partial_workspace' };

interface WorkspaceConfirmDialogsProps {
  confirmDialog: ConfirmDialogType | null;
  initializing: boolean;
  onClose: () => void;
  onExecuteSave: (initialize: boolean, resetOnboarding?: boolean, navigateMode?: 'new' | 'reuse') => void;
}

export function WorkspaceConfirmDialogs({
  confirmDialog,
  initializing,
  onClose,
  onExecuteSave,
}: WorkspaceConfirmDialogsProps) {
  const { t } = useTranslation();

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  return (
    <>
      {/* Non-existent path — offer to create */}
      <AlertDialog open={confirmDialog?.kind === 'not_found'} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assistant.confirmNotFoundTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('assistant.confirmNotFoundDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onExecuteSave(true)} disabled={initializing}>
              {initializing ? (
                <>
                  <SpinnerGap size={14} className="animate-spin mr-1" />
                  {t('assistant.initializing')}
                </>
              ) : (
                t('assistant.confirmCreate')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Empty directory confirmation */}
      <AlertDialog open={confirmDialog?.kind === 'empty'} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assistant.confirmEmptyTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('assistant.confirmEmptyDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onExecuteSave(true)} disabled={initializing}>
              {initializing ? (
                <>
                  <SpinnerGap size={14} className="animate-spin mr-1" />
                  {t('assistant.initializing')}
                </>
              ) : (
                t('assistant.confirmInitialize')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Normal directory confirmation */}
      <AlertDialog open={confirmDialog?.kind === 'normal_directory'} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assistant.confirmNormalTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{t('assistant.confirmNormalDesc')}</p>
                <p className="text-xs text-muted-foreground">{t('assistant.confirmNormalHint')}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onExecuteSave(true)} disabled={initializing}>
              {initializing ? (
                <>
                  <SpinnerGap size={14} className="animate-spin mr-1" />
                  {t('assistant.initializing')}
                </>
              ) : (
                t('assistant.confirmInitialize')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Existing workspace confirmation */}
      <AlertDialog open={confirmDialog?.kind === 'existing_workspace'} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assistant.confirmExistingTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('assistant.confirmExistingDesc')}</p>
                {confirmDialog?.kind === 'existing_workspace' && (
                  <div className="rounded border border-border/50 p-3 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('assistant.summaryOnboarding')}:</span>
                      <span>{confirmDialog.summary.onboardingComplete
                        ? t('assistant.onboardingComplete')
                        : t('assistant.onboardingNotStarted')
                      }</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('assistant.summaryLastCheckIn')}:</span>
                      <span>{confirmDialog.summary.lastCheckInDate || t('assistant.summaryNever')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('assistant.summaryFileCount')}:</span>
                      <span>{confirmDialog.summary.fileCount}</span>
                    </div>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-col gap-2">
            <Button size="sm" onClick={() => onExecuteSave(false, false, 'reuse')} disabled={initializing}>
              {t('assistant.takeoverContinue')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onExecuteSave(false, true, 'new')} disabled={initializing}>
              {initializing ? (
                <>
                  <SpinnerGap size={14} className="animate-spin mr-1" />
                  {t('assistant.initializing')}
                </>
              ) : (
                t('assistant.takeoverReonboard')
              )}
            </Button>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Partial workspace confirmation */}
      <AlertDialog open={confirmDialog?.kind === 'partial_workspace'} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assistant.confirmPartialTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('assistant.confirmPartialDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onExecuteSave(true)} disabled={initializing}>
              {initializing ? (
                <>
                  <SpinnerGap size={14} className="animate-spin mr-1" />
                  {t('assistant.initializing')}
                </>
              ) : (
                t('assistant.confirmRepair')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
