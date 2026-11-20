/**
 * RuntimeCapabilityList — Phase 5e Phase 3 (2026-05-18).
 *
 * Settings → Runtime page sub-component that surfaces the capability
 * clipboard for each Runtime. Per user decision (B-Settings variant)
 * this is the ONLY place CodePilot tells the user "this engine
 * supports X but not Y — switch to Z to enable Y" — never a
 * chat-page banner.
 *
 * Phase 5e review round 7 (2026-05-18 user feedback) — UI reads
 * **user-facing copy** from `capability-display-text.ts`. The
 * `capability-contract.ts` strings (`displayName`,
 * `deferredReason`, `statusLine`) are engineering identifiers and
 * MUST NOT leak into Settings — words like "MCP" / "bridge not yet
 * implemented" / "permission round-trip design" / "Phase 5d slice 7"
 * are noise for the end user. The display layer keeps the user
 * vocabulary stable (生成 Widget / 看板操作 / ...) while the
 * engineering contract evolves underneath.
 *
 * Phase 5e review round 7 also:
 *   - Removes the underline on the trigger (per user request).
 *   - Removes the explicit footer "Close" button (Radix Dialog
 *     ships its own corner X close button per
 *     `src/components/ui/dialog.tsx:53` — having two close buttons
 *     was a "弹窗叠按钮" smell).
 *   - Adds a Codex Account header note when codex_account is the
 *     active provider: Codex’s own plugins / Skills are managed by
 *     Codex itself; the list below ONLY describes CodePilot Harness
 *     injection, not Codex native capabilities.
 *
 * Design (sync'd with `docs/design.md` "Click-card → detail dialog"
 * spec):
 *   - Trigger: ghost-style text button, no underline. Sits inside
 *     the engine card (round 7 user request) so the affordance is
 *     part of the card, not a sibling row.
 *   - Dialog: `sm:max-w-2xl max-h-[85vh] flex flex-col gap-0
 *     overflow-hidden`. Header + scrollable body, no custom footer.
 *
 * Data source is **derived** from `capability-matrix.ts` which
 * derives from `capability-contract.ts`. The contract test in
 * `harness-capability-matrix.test.ts` guarantees every cell shown
 * comes from the catalog.
 */

'use client';

import { useState, type MouseEvent } from 'react';
import { CheckCircle, Circle, XCircle } from '@/components/ui/icon';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { RuntimeId } from '@/lib/runtime/runtime-id';
import { getRuntimeDisplayName } from '@/lib/runtime/runtime-catalog';
import type { CapabilityMatrixCell } from '@/lib/harness/capability-matrix';
import {
  getCapabilityDisplay,
  buildUserReason,
  getCapabilityNote,
  CALLABLE_STATUS_LINE,
  CODEX_ACCOUNT_HEADER_NOTE,
  getUserExtensionsSummary,
  type UserExtensionsStatus,
} from '@/lib/harness/capability-display-text';

interface Props {
  readonly runtimeId: RuntimeId;
  readonly cells: readonly CapabilityMatrixCell[];
  readonly isZh: boolean;
  /** When the active default provider triggers a downgrade (e.g.
   *  codex_account on the Codex Runtime card), the parent passes a
   *  short sentence rendered inside the dialog header note slot. */
  readonly providerNote?: string;
  /** Round 7 user request — trigger lives inside the picker card.
   *  Clicking it must NOT bubble into the picker's "switch default
   *  runtime" handler. */
  readonly stopPropagationOnTrigger?: boolean;
}

function statusIcon(status: CapabilityMatrixCell['status']) {
  switch (status) {
    case 'executable':
      return <CheckCircle size={14} weight="fill" className="text-status-success-foreground" />;
    case 'perception_only':
      return <Circle size={14} className="text-status-warning-foreground" />;
    case 'unavailable':
      return <XCircle size={14} weight="fill" className="text-muted-foreground" />;
    case 'undetermined':
      return <Circle size={14} className="text-muted-foreground/60" />;
  }
}

function userExtensionsStatusIcon(status: UserExtensionsStatus) {
  switch (status) {
    case 'executable':
      return <CheckCircle size={14} weight="fill" className="text-status-success-foreground" />;
    case 'partial':
      // Same warning tone as perception_only — "some pieces work, some
      // don't" still means the user shouldn't expect every kind to be
      // callable here.
      return <Circle size={14} className="text-status-warning-foreground" />;
    case 'perception_only':
      return <Circle size={14} className="text-status-warning-foreground" />;
  }
}

type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

function userExtensionsBadge(status: UserExtensionsStatus, t: TranslateFn): { label: string; cls: string } {
  switch (status) {
    case 'executable':
      return { label: t('runtime.capabilities.extExecutable'), cls: 'bg-status-success-muted text-status-success-foreground' };
    case 'partial':
      return { label: t('runtime.capabilities.extPartial'), cls: 'bg-status-warning-muted text-status-warning-foreground' };
    case 'perception_only':
      return { label: t('runtime.capabilities.extPerceptionOnly'), cls: 'bg-status-warning-muted text-status-warning-foreground' };
  }
}

function statusLabel(status: CapabilityMatrixCell['status'], t: TranslateFn): string {
  switch (status) {
    case 'executable':
      return t('runtime.capabilities.statusExecutable');
    case 'perception_only':
      return t('runtime.capabilities.statusPerceptionOnly');
    case 'unavailable':
      return t('runtime.capabilities.statusUnavailable');
    case 'undetermined':
      return t('runtime.capabilities.statusUndetermined');
  }
}

function trustBoundaryLabel(
  boundary: NonNullable<CapabilityMatrixCell['trustBoundary']>,
  t: TranslateFn,
): string {
  switch (boundary) {
    case 'auto_safe':
      return t('runtime.capabilities.trustAutoSafe');
    case 'requires_approval':
      return t('runtime.capabilities.trustRequiresApproval');
    case 'side_effect':
      return t('runtime.capabilities.trustSideEffect');
    case 'mixed':
      return t('runtime.capabilities.trustMixed');
  }
}

function trustBoundaryClass(
  boundary: NonNullable<CapabilityMatrixCell['trustBoundary']>,
): string {
  switch (boundary) {
    case 'auto_safe':
      return 'bg-muted text-muted-foreground';
    case 'requires_approval':
      return 'bg-status-warning-muted text-status-warning-foreground';
    case 'side_effect':
      return 'bg-status-info-muted text-status-info-foreground';
    case 'mixed':
      return 'bg-status-warning-muted/60 text-status-warning-foreground';
  }
}

function runtimeLabel(runtimeId: RuntimeId, isZh: boolean): string {
  return getRuntimeDisplayName(runtimeId, isZh ? 'zh' : 'en');
}

export function RuntimeCapabilityList({
  runtimeId,
  cells,
  isZh,
  providerNote,
  stopPropagationOnTrigger,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const executableCount = cells.filter((c) => c.status === 'executable').length;
  const totalCount = cells.length;
  const lang: 'zh' | 'en' = isZh ? 'zh' : 'en';

  const handleTriggerClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (stopPropagationOnTrigger) {
      // Round 7 — trigger is hosted inside the EnginePickerCard
      // click surface; without stopPropagation a click would both
      // open the dialog AND switch the default runtime.
      e.stopPropagation();
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          onClick={handleTriggerClick}
          data-testid={`runtime-capability-trigger-${runtimeId}`}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 rounded text-[11px]',
            'text-muted-foreground hover:text-foreground hover:bg-muted/60',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {t('runtime.capabilities.viewTrigger', {
            executable: executableCount,
            total: totalCount,
          })}
        </button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden"
        data-testid={`runtime-capability-dialog-${runtimeId}`}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t('runtime.capabilities.dialogTitle')} — {runtimeLabel(runtimeId, isZh)}
          </DialogTitle>
          <DialogDescription>
            {t('runtime.capabilities.dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto mt-4 space-y-3">
          {providerNote && (
            <p
              data-testid={`provider-note-${runtimeId}`}
              className="text-[11px] leading-snug text-status-warning-foreground bg-status-warning-muted/60 rounded px-3 py-2"
            >
              {providerNote}
            </p>
          )}

          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mt-1">
            {t('runtime.capabilities.builtInHeading')}
          </h4>
          <ul className="flex flex-col gap-2">
            {cells.map((cell) => {
              const display = getCapabilityDisplay(cell.capabilityId);
              const label = display?.label[lang] ?? cell.capabilityId;
              const desc = display?.description?.[lang];
              const userStatusLine =
                cell.status === 'executable'
                  ? CALLABLE_STATUS_LINE[lang]
                  : buildUserReason({
                      capabilityId: cell.capabilityId,
                      currentRuntime: runtimeId,
                      suggestedRuntimes: cell.suggestedRuntime ? [cell.suggestedRuntime] : [],
                      lang,
                    });
              return (
                <li
                  key={cell.capabilityId}
                  data-testid={`capability-row-${runtimeId}-${cell.capabilityId}`}
                  data-status={cell.status}
                  data-trust-boundary={cell.trustBoundary ?? ''}
                  className="flex items-start gap-2.5 text-xs"
                >
                  <span className="shrink-0 mt-0.5">{statusIcon(cell.status)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={cn(
                          'font-medium leading-tight',
                          cell.status === 'executable' ? 'text-foreground' : 'text-foreground/70',
                        )}
                      >
                        {label}
                      </span>
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded tracking-wide',
                          cell.status === 'executable' && 'bg-status-success-muted text-status-success-foreground',
                          cell.status === 'perception_only' && 'bg-status-warning-muted text-status-warning-foreground',
                          cell.status === 'unavailable' && 'bg-muted text-muted-foreground',
                          cell.status === 'undetermined' && 'bg-muted text-muted-foreground',
                        )}
                      >
                        {statusLabel(cell.status, t)}
                      </span>
                      {cell.status === 'executable' && cell.trustBoundary && (
                        <span
                          data-testid={`trust-badge-${runtimeId}-${cell.capabilityId}`}
                          className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded tracking-wide',
                            trustBoundaryClass(cell.trustBoundary),
                          )}
                        >
                          {trustBoundaryLabel(cell.trustBoundary, t)}
                        </span>
                      )}
                    </div>
                    {desc && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground/85 leading-snug">
                        {desc}
                      </p>
                    )}
                    {cell.status !== 'executable' && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                        {userStatusLine}
                      </p>
                    )}
                    {cell.noteKey && getCapabilityNote(cell.noteKey, lang) && (
                      <p
                        data-testid={`capability-note-${runtimeId}-${cell.capabilityId}`}
                        className="mt-0.5 text-[11px] text-muted-foreground leading-snug"
                      >
                        {getCapabilityNote(cell.noteKey, lang)}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Phase 5e round 8 (2026-05-18) — user-extensions section.
              Built-in capabilities above describe CodePilot's first-
              party tools; this section describes whether user-defined
              MCP servers / Skills / slash commands / workspace rules
              are honored on the current Runtime. Kept as a separate
              section (not part of the matrix above) because user
              extensions are dynamic and outside the engineering
              HARNESS_CAPABILITIES catalog. */}
          {(() => {
            const summary = getUserExtensionsSummary(runtimeId);
            const badge = userExtensionsBadge(summary.status, t);
            return (
              <div className="mt-4 pt-3 border-t border-border/40">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('runtime.capabilities.userExtensionsHeading')}
                </h4>
                <div
                  data-testid={`user-extensions-row-${runtimeId}`}
                  data-status={summary.status}
                  className="mt-2 flex items-start gap-2.5 text-xs"
                >
                  <span className="shrink-0 mt-0.5">{userExtensionsStatusIcon(summary.status)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={cn(
                          'font-medium leading-tight',
                          summary.status === 'executable' ? 'text-foreground' : 'text-foreground/70',
                        )}
                      >
                        {summary.label[lang]}
                      </span>
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded tracking-wide',
                          badge.cls,
                        )}
                      >
                        {badge.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground/85 leading-snug">
                      {summary.description[lang]}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Standalone export for the Codex Account note so RuntimePanel can
 *  pick the right copy without importing the bilingual constant
 *  directly. */
export function codexAccountHeaderNote(isZh: boolean): string {
  return isZh ? CODEX_ACCOUNT_HEADER_NOTE.zh : CODEX_ACCOUNT_HEADER_NOTE.en;
}
