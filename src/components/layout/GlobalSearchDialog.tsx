'use client';

import { Fragment, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/hooks/useTranslation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { CodePilotIcon, type CodePilotIconName } from '@/components/ui/semantic-icon';
import { cn } from '@/lib/utils';
import type { TranslationKey } from '@/i18n';
import { formatRelativeTime } from './chat-list-utils';

interface SearchResultSession {
  type: 'session';
  id: string;
  title: string;
  projectName: string;
  updatedAt: string;
}

interface SearchResultMessage {
  type: 'message';
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
  createdAt: string;
  contentType: 'user' | 'assistant' | 'tool';
}

interface SearchResultFile {
  type: 'file';
  sessionId: string;
  sessionTitle: string;
  path: string;
  name: string;
  nodeType: 'file' | 'directory';
}

interface SearchResponse {
  sessions: SearchResultSession[];
  messages: SearchResultMessage[];
  files: SearchResultFile[];
}

interface GlobalSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SearchScope = 'all' | 'sessions' | 'messages' | 'files';

const TYPE_LABEL_KEYS: Record<Exclude<SearchScope, 'all'>, TranslationKey> = {
  sessions: 'globalSearch.sessions',
  messages: 'globalSearch.messages',
  files: 'globalSearch.files',
};

const CONTENT_TYPE_LABEL_KEYS: Record<SearchResultMessage['contentType'], TranslationKey> = {
  user: 'messageList.userLabel',
  assistant: 'messageList.assistantLabel',
  tool: 'globalSearch.toolLabel',
};

const SCOPE_OPTIONS: Array<{
  scope: SearchScope;
  labelKey: TranslationKey;
  prefix: string | null;
  icon?: CodePilotIconName;
}> = [
  { scope: 'all', labelKey: 'globalSearch.all', prefix: null },
  {
    scope: 'sessions',
    labelKey: 'globalSearch.sessions',
    prefix: 'session:',
    icon: 'chat',
  },
  {
    scope: 'messages',
    labelKey: 'globalSearch.messages',
    prefix: 'message:',
    icon: 'note',
  },
  {
    scope: 'files',
    labelKey: 'globalSearch.files',
    prefix: 'file:',
    icon: 'file_tree',
  },
];

function buildScopedQuery(scope: SearchScope, term: string) {
  const option = SCOPE_OPTIONS.find((item) => item.scope === scope);
  if (!option || !option.prefix) {
    return term;
  }
  return `${option.prefix}${term}`;
}

function normalizeInlineText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function formatPathTail(filePath: string) {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return filePath;
  return parts.slice(-3).join('/');
}

function renderHighlightedText(text: string, searchTerm: string) {
  if (!searchTerm) return text;

  const normalizedTerm = searchTerm.trim();
  if (!normalizedTerm) return text;

  const lowerText = text.toLowerCase();
  const lowerTerm = normalizedTerm.toLowerCase();
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerTerm, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }

    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), match: false });
    }

    segments.push({
      text: text.slice(matchIndex, matchIndex + normalizedTerm.length),
      match: true,
    });
    cursor = matchIndex + normalizedTerm.length;
  }

  return segments.map((segment, index) => (
    <Fragment key={`${segment.text}-${index}`}>
      {segment.match ? (
        <mark className="rounded bg-primary/15 px-0.5 text-foreground">
          {segment.text}
        </mark>
      ) : (
        segment.text
      )}
    </Fragment>
  ));
}

export function GlobalSearchDialog({ open, onOpenChange }: GlobalSearchDialogProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse>({
    sessions: [],
    messages: [],
    files: [],
  });
  const abortRef = useRef<AbortController | null>(null);
  const composingRef = useRef(false);

  const parsedQuery = useMemo<{
    scope: SearchScope;
    term: string;
    prefix: string | null;
  }>(() => {
    const trimmed = query.trim();
    const lower = trimmed.toLowerCase();

    const parsePrefix = (
      single: string,
      plural: string,
      scope: Exclude<SearchScope, 'all'>,
    ) => {
      if (lower.startsWith(`${single}:`)) {
        return {
          scope,
          term: trimmed.slice(single.length + 1).trim(),
          prefix: `${single}:`,
        };
      }
      if (lower.startsWith(`${plural}:`)) {
        return {
          scope,
          term: trimmed.slice(plural.length + 1).trim(),
          prefix: `${single}:`,
        };
      }
      return null;
    };

    return (
      parsePrefix('session', 'sessions', 'sessions') ??
      parsePrefix('message', 'messages', 'messages') ??
      parsePrefix('file', 'files', 'files') ?? {
        scope: 'all',
        term: trimmed,
        prefix: null,
      }
    );
  }, [query]);

  const searchTerm = parsedQuery.term;
  const activeScope = parsedQuery.scope;
  const activePrefix = parsedQuery.prefix;
  const hasSearchTerm = searchTerm.length > 0;
  const totalResults =
    results.sessions.length + results.messages.length + results.files.length;
  const hasResults = totalResults > 0;

  const focusSearchInput = useCallback(() => {
    if (typeof document === 'undefined') return;
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-slot="command-input"]',
      );
      input?.focus();
    });
  }, []);

  const performSearch = useCallback(async (rawQuery: string, term: string) => {
    if (composingRef.current) return;

    abortRef.current?.abort();

    if (!term.trim()) {
      abortRef.current = null;
      setResults({ sessions: [], messages: [], files: [] });
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(rawQuery)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Search failed');

      const data: SearchResponse = await res.json();
      if (!controller.signal.aborted) {
        setResults(data);
      }
    } catch {
      if (!controller.signal.aborted) {
        setResults({ sessions: [], messages: [], files: [] });
      }
    } finally {
      if (!controller.signal.aborted) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void performSearch(query, searchTerm);
    }, 160);
    return () => clearTimeout(timer);
  }, [performSearch, query, searchTerm]);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setQuery('');
      setResults({ sessions: [], messages: [], files: [] });
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleSelect = useCallback(
    (item: SearchResultSession | SearchResultMessage | SearchResultFile) => {
      onOpenChange(false);
      const qParam = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : '';

      if (item.type === 'session') {
        router.push(`/chat/${item.id}`);
        return;
      }

      if (item.type === 'message') {
        router.push(`/chat/${item.sessionId}?message=${item.messageId}${qParam}`);
        return;
      }

      const seek = Date.now().toString(36);
      router.push(
        `/chat/${item.sessionId}?file=${encodeURIComponent(item.path)}&seek=${seek}${qParam}`,
      );
    },
    [onOpenChange, query, router],
  );

  const handleScopeSelect = useCallback(
    (scope: SearchScope) => {
      setQuery(buildScopedQuery(scope, searchTerm));
      focusSearchInput();
    },
    [focusSearchInput, searchTerm],
  );

  const activeScopeLabel =
    activeScope === 'all' ? t('globalSearch.all') : t(TYPE_LABEL_KEYS[activeScope]);
  const expanded = hasSearchTerm || loading;
  const resultStackClass =
    'overflow-hidden rounded-2xl border border-border/60 bg-background/80';
  const resultItemClass =
    'rounded-none border-0 border-b border-border/45 bg-transparent px-3.5 py-2.5 data-[selected=true]:bg-accent/70 last:border-b-0';

  const renderSectionHeader = (
    scope: Exclude<SearchScope, 'all'>,
    count: number,
  ) => (
    <div className="flex items-center justify-between gap-3 px-2 pb-1 pt-1">
      <div className="text-[11px] font-medium text-muted-foreground">
        {t(TYPE_LABEL_KEYS[scope])}
      </div>
      <span className="rounded-full bg-muted/55 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('globalSearch.title')}
      description={t('globalSearch.description')}
      className={cn(
        'top-[44%] h-[min(70vh,560px)] overflow-hidden rounded-[24px] border border-border/70 bg-background/98 p-0 shadow-[var(--shadow-diffuse)] backdrop-blur-xl sm:max-w-[760px]',
        '[&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:border-0 [&_[data-slot=command-input-wrapper]]:px-3',
      )}
      showCloseButton={false}
      shouldFilter={false}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border/60 px-3 pt-3">
          <div className="overflow-hidden rounded-[18px] border border-border/70 bg-background shadow-sm">
            <CommandInput
              placeholder={t('globalSearch.placeholder')}
              value={query}
              onValueChange={setQuery}
              className="h-12 text-[15px]"
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={(event) => {
                composingRef.current = false;
                setQuery((event.target as HTMLInputElement).value);
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3 py-2.5">
            <div className="inline-flex rounded-full bg-muted/55 p-0.5">
              {SCOPE_OPTIONS.map((option) => {
                const isActive = option.scope === activeScope;
                return (
                  <Button
                    key={option.scope}
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-pressed={isActive}
                    data-testid={`global-search-scope-${option.scope}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleScopeSelect(option.scope)}
                    className={cn(
                      'h-7 gap-1.5 rounded-full px-3 text-[12px] transition-colors',
                      isActive
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option.icon && (
                      <CodePilotIcon
                        name={option.icon}
                        size="sm"
                        className="text-inherit"
                        aria-hidden
                      />
                    )}
                    {t(option.labelKey)}
                  </Button>
                );
              })}
            </div>

            <div
              className="flex min-w-0 items-center justify-end gap-2 text-[11px] text-muted-foreground"
              data-testid="global-search-status"
            >
              {activePrefix && (
                <code className="rounded-full bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {activePrefix}
                </code>
              )}
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <CodePilotIcon
                    name="loading"
                    size="sm"
                    className="animate-spin text-muted-foreground"
                    aria-hidden
                  />
                  {t('globalSearch.searching')}
                </span>
              ) : hasSearchTerm ? (
                <span>{t('globalSearch.resultsSummary', { count: totalResults })}</span>
              ) : null}
            </div>
          </div>
        </div>

        <CommandList
          className="max-h-none min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2"
        >
          <div className={cn(expanded && 'space-y-3')} data-testid="global-search-surface">
            {!hasSearchTerm && !loading && (
              <div
                className="flex min-h-9 items-center justify-end gap-1.5 rounded-2xl bg-muted/[0.16] px-3 py-2 text-[11px] text-muted-foreground"
                data-testid="global-search-empty-state"
              >
                <kbd className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shadow-sm">
                  Enter
                </kbd>
                <kbd className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shadow-sm">
                  Esc
                </kbd>
              </div>
            )}

            {hasSearchTerm && !loading && !hasResults && (
              <div
                className="rounded-2xl border border-dashed border-border/70 bg-muted/[0.14] px-4 py-8 text-center"
                data-testid="global-search-no-results"
              >
                <p className="text-sm font-medium text-foreground">
                  {t('globalSearch.noResults')}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {t('globalSearch.noResultsHint')}
                </p>
                <code className="mt-3 inline-flex rounded-full bg-background px-2.5 py-1 font-mono text-[11px] text-muted-foreground shadow-sm">
                  {activeScopeLabel}: {searchTerm}
                </code>
              </div>
            )}

            {loading && hasSearchTerm && (
              <div className={resultStackClass}>
                {Array.from({ length: 5 }).map((_, index) => (
                  <div
                    key={`search-loading-${index}`}
                    className="animate-pulse border-b border-border/45 px-3.5 py-3 last:border-b-0"
                  >
                    <div className="space-y-2">
                      <div className="h-3 w-2/3 rounded bg-muted/80" />
                      <div className="h-3 w-1/3 rounded bg-muted/55" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {hasSearchTerm && !loading && hasResults && (
              <div className="space-y-3">
                {results.sessions.length > 0 && (
                  <section className="space-y-1" data-testid="global-search-section-sessions">
                    {renderSectionHeader('sessions', results.sessions.length)}
                    <div className={resultStackClass}>
                      {results.sessions.map((item) => (
                        <CommandItem
                          key={`session-${item.id}`}
                          value={`session-${item.id}`}
                          onSelect={() => handleSelect(item)}
                          className={resultItemClass}
                          data-testid="global-search-item"
                        >
                          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
                            <p className="min-w-0 truncate text-sm font-medium leading-6 text-foreground">
                              {renderHighlightedText(
                                normalizeInlineText(item.title),
                                searchTerm,
                              )}
                            </p>
                            <span className="text-[11px] leading-6 text-muted-foreground">
                              {formatRelativeTime(item.updatedAt, t)}
                            </span>
                            <p className="col-span-2 truncate text-[11px] leading-5 text-muted-foreground">
                              {renderHighlightedText(item.projectName, searchTerm)}
                            </p>
                          </div>
                        </CommandItem>
                      ))}
                    </div>
                  </section>
                )}

                {results.messages.length > 0 && (
                  <section className="space-y-1" data-testid="global-search-section-messages">
                    {renderSectionHeader('messages', results.messages.length)}
                    <div className={resultStackClass}>
                      {results.messages.map((item) => (
                        <CommandItem
                          key={`message-${item.messageId}`}
                          value={`message-${item.messageId}`}
                          onSelect={() => handleSelect(item)}
                          className={resultItemClass}
                          data-testid="global-search-item"
                        >
                          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
                            <p
                              className="min-w-0 truncate text-[11px] leading-5 text-muted-foreground"
                              title={normalizeInlineText(item.sessionTitle)}
                            >
                              {renderHighlightedText(
                                normalizeInlineText(item.sessionTitle),
                                searchTerm,
                              )}
                            </p>
                            <span className="text-[11px] leading-5 text-muted-foreground">
                              {t(CONTENT_TYPE_LABEL_KEYS[item.contentType])}
                              <span aria-hidden> · </span>
                              {formatRelativeTime(item.createdAt, t)}
                            </span>
                            <p className="col-span-2 line-clamp-2 text-[13px] leading-6 text-foreground">
                              {renderHighlightedText(
                                normalizeInlineText(item.snippet),
                                searchTerm,
                              )}
                            </p>
                          </div>
                        </CommandItem>
                      ))}
                    </div>
                  </section>
                )}

                {results.files.length > 0 && (
                  <section className="space-y-1" data-testid="global-search-section-files">
                    {renderSectionHeader('files', results.files.length)}
                    <div className={resultStackClass}>
                      {results.files.map((item) => (
                        <CommandItem
                          key={`file-${item.path}`}
                          value={`file-${item.path}`}
                          onSelect={() => handleSelect(item)}
                          className={resultItemClass}
                          data-testid="global-search-item"
                        >
                          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
                            <p className="min-w-0 truncate text-sm font-medium leading-6 text-foreground">
                              {renderHighlightedText(item.name, searchTerm)}
                            </p>
                            <span className="text-[11px] leading-6 text-muted-foreground">
                              {item.nodeType === 'directory'
                                ? t('globalSearch.directoryLabel')
                                : t('globalSearch.fileLabel')}
                            </span>
                            <p className="col-span-2 truncate text-[11px] text-muted-foreground">
                              {normalizeInlineText(item.sessionTitle)}
                              <span aria-hidden> · </span>
                              <span className="font-mono text-muted-foreground/80">
                                {renderHighlightedText(formatPathTail(item.path), searchTerm)}
                              </span>
                            </p>
                          </div>
                        </CommandItem>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </CommandList>
      </div>
    </CommandDialog>
  );
}
