'use client';

import { useCallback, useMemo, useState } from 'react';
import { CaretDown, MagnifyingGlass, Star } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import type { ProviderModelGroup } from '@/types';
import { findModelOption } from '@/lib/model-option-match';
import { RUNTIME_IDS, type RuntimeId } from '@/lib/runtime/runtime-id';
import { ProviderBrandIcon } from '@/components/ui/provider-brand-icon';
import { RuntimeIcon, runtimeTranslationKeys } from './RuntimeSelector';
import {
  MODEL_ROUTE_FAVORITES_KEY,
  modelRouteFavoriteIdentity,
  modelRouteIdentity,
  parseModelRouteFavorites,
  rankModelRoutes,
  serializeModelRouteFavorites,
  toggleModelRouteFavorite,
  type ModelRouteFavoriteV2,
} from '@/lib/model-route-favorites';

const RECENT_MODELS_KEY = 'codepilot:recent-models';
const RECENT_MODELS_STORED = 8;

interface RecentModelEntry {
  providerId: string;
  modelValue: string;
  ts: number;
}

function readRecentModels(): RecentModelEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is RecentModelEntry =>
          entry
          && typeof entry.providerId === 'string'
          && typeof entry.modelValue === 'string'
          && typeof entry.ts === 'number')
      : [];
  } catch {
    return [];
  }
}

function pushRecentModel(providerId: string, modelValue: string): void {
  if (typeof window === 'undefined') return;
  try {
    const next = [
      { providerId, modelValue, ts: Date.now() },
      ...readRecentModels().filter((entry) =>
        !(entry.providerId === providerId && entry.modelValue === modelValue)),
    ].slice(0, RECENT_MODELS_STORED);
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
  } catch {
    // Storage is an enhancement. Selection itself must continue to work.
  }
}

interface ModelOption {
  value: string;
  label: string;
  upstreamModelId?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  effortNoteKey?: string;
  contextWindow?: number;
  supportedRuntimes?: string[];
  unsupportedReasonByRuntime?: Record<string, string>;
}

interface ModelSelectorDropdownProps {
  currentModelValue: string;
  currentProviderIdValue: string;
  providerGroups: ProviderModelGroup[];
  modelOptions: ModelOption[];
  onModelChange?: (model: string) => void;
  onProviderModelChange?: (
    providerId: string,
    model: string,
    opts?: { isAuto?: boolean },
  ) => void;
  globalDefaultModel?: string;
  globalDefaultProvider?: string;
  runtimeApplied?: RuntimeId;
  onRuntimeChange?: (runtime: RuntimeId) => void;
  runtimeChangeDisabled?: boolean;
  isLoading?: boolean;
}

interface ModelRoute {
  runtimeId: RuntimeId;
  providerInstanceId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  option?: ModelOption;
  group?: ProviderModelGroup;
  catalogOrder: number;
  favorite: boolean;
  recentAt?: number;
  selectable: boolean;
  unavailableReason?: string;
}

type PickerLane = 'favorites' | RuntimeId;

interface ProviderRouteSection {
  providerInstanceId: string;
  providerName: string;
  routes: ModelRoute[];
}

function ProviderGlyph({ name }: { name: string }) {
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center"
      aria-hidden
    >
      <ProviderBrandIcon name={name} size={16} />
    </span>
  );
}

export function ModelSelectorDropdown({
  currentModelValue,
  currentProviderIdValue,
  providerGroups,
  modelOptions,
  onModelChange,
  onProviderModelChange,
  globalDefaultModel,
  globalDefaultProvider,
  runtimeApplied,
  onRuntimeChange,
  runtimeChangeDisabled,
  isLoading,
}: ModelSelectorDropdownProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [lane, setLane] = useState<PickerLane>(runtimeApplied ?? RUNTIME_IDS[0]);
  const [favorites, setFavorites] = useState<ModelRouteFavoriteV2[]>([]);
  const [recent, setRecent] = useState<RecentModelEntry[]>([]);

  const currentModelOption = findModelOption(modelOptions, currentModelValue) || modelOptions[0];
  const showLoading = isLoading || !currentModelOption;
  const isCurrentDefault = Boolean(
    globalDefaultModel
    && globalDefaultProvider
    && currentModelValue === globalDefaultModel
    && currentProviderIdValue === globalDefaultProvider,
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery('');
      return;
    }
    const activeRuntime = runtimeApplied ?? RUNTIME_IDS[0];
    const currentRaw = typeof window === 'undefined'
      ? null
      : localStorage.getItem(MODEL_ROUTE_FAVORITES_KEY);
    const storedFavorites = parseModelRouteFavorites(currentRaw);
    setFavorites(storedFavorites);
    setRecent(readRecentModels());
    setLane(activeRuntime);
  }, [runtimeApplied]);

  const favoriteIds = useMemo(
    () => new Set(favorites.map((favorite) =>
      modelRouteFavoriteIdentity(
        favorite.runtimeId,
        favorite.providerInstanceId,
        favorite.modelId,
      ))),
    [favorites],
  );
  const recentTimes = useMemo(
    () => new Map(recent.map((entry) => [
      modelRouteIdentity(entry.providerId, entry.modelValue),
      entry.ts,
    ])),
    [recent],
  );

  const routes = useMemo(() => {
    if (lane === 'favorites') {
      return favorites.flatMap((favorite, catalogOrder): ModelRoute[] => {
        const group = providerGroups.find((candidate) =>
          candidate.provider_id === favorite.providerInstanceId);
        const option = (group?.models as ModelOption[] | undefined)?.find((candidate) =>
          candidate.value === favorite.modelId);
        const selectable = Boolean(
          group
          && option
          && (!option.supportedRuntimes || option.supportedRuntimes.includes(favorite.runtimeId)),
        );
        const unavailableReason = !group
          ? t('composer.favoriteProviderUnavailable' as TranslationKey)
          : !option
            ? t('composer.favoriteModelUnavailable' as TranslationKey)
            : !selectable
              ? t('composer.favoriteRuntimeUnavailable' as TranslationKey)
              : undefined;
        return [{
          runtimeId: favorite.runtimeId,
          providerInstanceId: favorite.providerInstanceId,
          providerName: group?.provider_name ?? favorite.providerNameSnapshot,
          modelId: favorite.modelId,
          modelName: option?.label ?? favorite.modelNameSnapshot,
          option,
          group,
          catalogOrder,
          favorite: true,
          recentAt: recentTimes.get(modelRouteIdentity(
            favorite.providerInstanceId,
            favorite.modelId,
          )),
          selectable,
          unavailableReason,
        }];
      });
    }

    let catalogOrder = 0;
    const live: ModelRoute[] = [];
    for (const group of providerGroups) {
      for (const option of group.models as ModelOption[]) {
        const selectable = !option.supportedRuntimes
          || option.supportedRuntimes.includes(lane);
        if (!selectable) continue;
        const routeId = modelRouteIdentity(group.provider_id, option.value);
        const favoriteId = modelRouteFavoriteIdentity(lane, group.provider_id, option.value);
        live.push({
          runtimeId: lane,
          providerInstanceId: group.provider_id,
          providerName: group.provider_name,
          modelId: option.value,
          modelName: option.label,
          option,
          group,
          catalogOrder: catalogOrder++,
          favorite: favoriteIds.has(favoriteId),
          recentAt: recentTimes.get(routeId),
          selectable: true,
        });
      }
    }
    return live;
  }, [favoriteIds, favorites, lane, providerGroups, recentTimes, t]);

  const visibleRoutes = useMemo(() => {
    const ranked = rankModelRoutes(routes, query);
    return lane === 'favorites'
      ? ranked
      : ranked.filter((route) => route.selectable && route.option);
  }, [lane, query, routes]);

  const providerSections = useMemo(() => {
    const sections = new Map<string, ProviderRouteSection>();
    for (const route of visibleRoutes) {
      const existing = sections.get(route.providerInstanceId);
      if (existing) {
        existing.routes.push(route);
      } else {
        sections.set(route.providerInstanceId, {
          providerInstanceId: route.providerInstanceId,
          providerName: route.providerName,
          routes: [route],
        });
      }
    }
    return [...sections.values()];
  }, [visibleRoutes]);

  const handleRuntimeSelect = useCallback((nextRuntime: RuntimeId) => {
    if (runtimeChangeDisabled) return;
    setLane(nextRuntime);
    setQuery('');
    if (nextRuntime !== runtimeApplied) onRuntimeChange?.(nextRuntime);
  }, [onRuntimeChange, runtimeApplied, runtimeChangeDisabled]);

  const handleModelSelect = useCallback((route: ModelRoute) => {
    if (!route.selectable || !route.option) return;
    if (route.runtimeId !== runtimeApplied) {
      if (runtimeChangeDisabled) return;
      onRuntimeChange?.(route.runtimeId);
    }
    onModelChange?.(route.modelId);
    onProviderModelChange?.(route.providerInstanceId, route.modelId);
    try {
      localStorage.setItem('codepilot:last-model', route.modelId);
      localStorage.setItem('codepilot:last-provider-id', route.providerInstanceId);
    } catch {
      // Selection remains authoritative even if local history is unavailable.
    }
    pushRecentModel(route.providerInstanceId, route.modelId);
    setOpen(false);
  }, [onModelChange, onProviderModelChange, onRuntimeChange, runtimeApplied, runtimeChangeDisabled]);

  const handleFavorite = useCallback((route: ModelRoute) => {
    const next = toggleModelRouteFavorite(favorites, {
      runtimeId: route.runtimeId,
      providerInstanceId: route.providerInstanceId,
      modelId: route.modelId,
      providerNameSnapshot: route.providerName,
      modelNameSnapshot: route.modelName,
      createdAt: Date.now(),
    });
    setFavorites(next);
    try {
      localStorage.setItem(MODEL_ROUTE_FAVORITES_KEY, serializeModelRouteFavorites(next));
    } catch {
      // Keep the in-memory interaction functional if storage is unavailable.
    }
  }, [favorites]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <PromptInputButton
          disabled={showLoading}
          aria-label={t('composer.chooseRuntimeModel' as TranslationKey)}
        >
          {showLoading ? (
            <span className="text-xs text-muted-foreground">
              {t('composer.modelLoading' as TranslationKey)}
            </span>
          ) : (
            <>
              <RuntimeIcon runtime={runtimeApplied ?? RUNTIME_IDS[0]} size={16} />
              <span className="max-w-40 truncate text-xs font-normal">{currentModelOption?.label}</span>
              {isCurrentDefault && (
                <span className="text-[10px] font-medium text-muted-foreground">
                  · {t('composer.defaultShort' as TranslationKey)}
                </span>
              )}
            </>
          )}
          <CaretDown size={10} className={cn('transition-transform duration-200', open && 'rotate-180')} />
        </PromptInputButton>
      </PopoverTrigger>

      {open && (
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className="w-[42rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border bg-popover p-0 shadow-[var(--shadow-diffuse)]"
        >
          <div className="grid min-h-80 grid-cols-[9rem_minmax(0,1fr)]">
            <nav className="border-r p-2" aria-label="Runtime">
              <button
                type="button"
                onClick={() => {
                  setLane('favorites');
                  setQuery('');
                }}
                className={cn(
                  'mb-2 flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs',
                  lane === 'favorites' && 'bg-accent text-accent-foreground',
                )}
                aria-pressed={lane === 'favorites'}
                aria-label={t('composer.favoriteCombinations' as TranslationKey)}
              >
                <Star size={16} weight={lane === 'favorites' ? 'fill' : 'regular'} />
                <span className="min-w-0 flex-1 truncate">
                  {t('composer.favorites' as TranslationKey)}
                </span>
                {favorites.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {favorites.length}
                  </span>
                )}
              </button>
              <div className="mb-1 border-t pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Runtime
              </div>
              {RUNTIME_IDS.map((runtimeId) => (
                <button
                  key={runtimeId}
                  type="button"
                  disabled={runtimeChangeDisabled}
                  title={runtimeChangeDisabled
                    ? t('composer.runtimeLocked' as TranslationKey)
                    : undefined}
                  onClick={() => handleRuntimeSelect(runtimeId)}
                  className={cn(
                    'flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50',
                    lane === runtimeId && 'bg-accent text-accent-foreground',
                  )}
                  aria-pressed={lane === runtimeId}
                >
                  <RuntimeIcon runtime={runtimeId} size={16} />
                  <span className="truncate">{t(runtimeTranslationKeys(runtimeId).label)}</span>
                </button>
              ))}
            </nav>

            <section className="min-w-0 p-3">
              <div className="relative mb-3">
                <MagnifyingGlass
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={t('composer.searchModels' as TranslationKey)}
                  className="h-9 pl-9"
                />
              </div>

              <div
                className="max-h-72 overflow-y-auto"
                role="list"
                aria-label={lane === 'favorites'
                  ? t('composer.favoriteCombinations' as TranslationKey)
                  : t('composer.availableModels' as TranslationKey)}
              >
                {providerSections.map((section) => (
                  <div
                    key={section.providerInstanceId}
                    className="mb-2 last:mb-0"
                    data-model-provider-section={section.providerInstanceId}
                  >
                    <div className="sticky top-0 z-10 flex h-7 items-center gap-2 bg-popover px-2 text-[10px] font-medium text-muted-foreground">
                      <ProviderGlyph name={section.providerName} />
                      <span className="truncate">{section.providerName}</span>
                    </div>
                    {section.routes.map((route) => {
                      const group = route.group;
                      const active = route.runtimeId === runtimeApplied
                        && route.providerInstanceId === currentProviderIdValue
                        && group !== undefined
                        && findModelOption(group.models, currentModelValue)?.value === route.modelId;
                      const defaultRoute = route.providerInstanceId === globalDefaultProvider
                        && route.modelId === globalDefaultModel;
                      const selectionDisabled = !route.selectable
                        || (runtimeChangeDisabled && route.runtimeId !== runtimeApplied);
                      return (
                        <div
                          key={modelRouteFavoriteIdentity(
                            route.runtimeId,
                            route.providerInstanceId,
                            route.modelId,
                          )}
                          className={cn(
                            'group flex min-h-12 items-center rounded-lg px-1',
                            active && 'bg-accent',
                            !active && 'hover:bg-accent/60',
                          )}
                          role="listitem"
                        >
                          <button
                            type="button"
                            aria-current={active ? 'true' : undefined}
                            disabled={selectionDisabled}
                            onClick={() => handleModelSelect(route)}
                            title={route.unavailableReason}
                            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {lane === 'favorites' && <RuntimeIcon runtime={route.runtimeId} size={16} />}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">{route.modelName}</span>
                              <span className="block truncate text-[10px] text-muted-foreground">
                                {lane === 'favorites'
                                  ? t(runtimeTranslationKeys(route.runtimeId).label)
                                  : route.modelId}
                                {route.unavailableReason ? ` · ${route.unavailableReason}` : ''}
                              </span>
                            </span>
                            {defaultRoute && (
                              <span className="text-[10px] text-muted-foreground">
                                {t('composer.defaultShort' as TranslationKey)}
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleFavorite(route)}
                            className="mr-1 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                            aria-label={route.favorite
                              ? t('composer.removeFavoriteCombination' as TranslationKey)
                              : t('composer.favoriteCombination' as TranslationKey)}
                          >
                            <Star size={15} weight={route.favorite ? 'fill' : 'regular'} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {providerGroups.length === 0 && favorites.length === 0 ? (
                  <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                    {t('composer.noProvidersConfigured' as TranslationKey)}
                  </div>
                ) : visibleRoutes.length === 0 && (
                  <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                    {query.trim()
                      ? t('composer.noMatchingModels' as TranslationKey)
                      : lane === 'favorites'
                        ? t('composer.noFavoriteCombinations' as TranslationKey)
                        : t('composer.noModelsForRuntime' as TranslationKey)}
                  </div>
                )}
              </div>
            </section>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
