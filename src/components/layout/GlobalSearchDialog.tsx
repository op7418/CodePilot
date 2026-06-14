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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CaretDown, CaretRight } from '@/components/ui/icon';
import {
  CodePilotIcon,
  type CodePilotIconName,
} from '@/components/ui/semantic-icon';
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

const GROUP_ICON_NAMES: Record<SearchScope, CodePilotIconName> = {
  all: 'search',
  sessions: 'chat',
  messages: 'note',
  files: 'file_tree',
};

const CONTENT_TYPE_ICONS: Record<SearchResultMessage['contentType'], CodePilotIconName> = {
  user: 'chat',
  assistant: 'assistant',
  tool: 'wrench',
};

const CONTENT_TYPE_LABEL_KEYS: Record<SearchResultMessage['contentType'], TranslationKey> = {
  user: 'messageList.userLabel',
  assistant: 'messageList.assistantLabel',
  tool: 'globalSearch.toolLabel',
};

const SCOPE_OPTIONS: Array<{
  scope: SearchScope;
  labelKey: TranslationKey;
  descriptionKey?: TranslationKey;
  prefix: string | null;
  icon: CodePilotIconName;
}> = [
  { scope: 'all', labelKey: 'globalSearch.all', prefix: null, icon: 'search' },
  {
    scope: 'sessions',
    labelKey: 'globalSearch.sessions',
    descriptionKey: 'globalSearch.scopeSessionsHint',
    prefix: 'session:',
    icon: 'chat',
  },
  {
    scope: 'messages',
    labelKey: 'globalSearch.messages',
    descriptionKey: 'globalSearch.scopeMessagesHint',
    prefix: 'message:',
    icon: 'note',
  },
  {
    scope: 'files',
    labelKey: 'globalSearch.files',
    descriptionKey: 'globalSearch.scopeFilesHint',
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
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

  const groupedMessages = useMemo(() => {
    const groups: Record<
      string,
      { sessionTitle: string; messages: SearchResultMessage[] }
    > = {};

    for (const message of results.messages) {
      if (!groups[message.sessionId]) {
        groups[message.sessionId] = {
          sessionTitle: message.sessionTitle,
          messages: [],
        };
      }
      groups[message.sessionId].messages.push(message);
    }

    return Object.entries(groups).map(([sessionId, value]) => ({
      sessionId,
      sessionTitle: value.sessionTitle,
      messages: value.messages,
    }));
  }, [results.messages]);

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
      setCollapsedGroups(new Set());
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const toggleGroup = useCallback((sessionId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
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

  const renderSectionHeader = (
    scope: Exclude<SearchScope, 'all'>,
    count: number,
  ) => (
    <div className="flex items-center justify-between gap-3 px-1">
      <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        <CodePilotIcon
          name={GROUP_ICON_NAMES[scope]}
          size="sm"
          className="text-inherit"
          aria-hidden
        />
        <span>{t(TYPE_LABEL_KEYS[scope])}</span>
      </div>
      <Badge variant="outline" className="border-border/70 bg-background/80 text-[10px] text-muted-foreground">
        {count}
      </Badge>
    </div>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('globalSearch.title')}
      description={t('globalSearch.description')}
      className="h-[min(88vh,720px)] overflow-hidden rounded-[28px] border border-border/70 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-4xl"
      showCloseButton={false}
      shouldFilter={false}
    >
      <div className="border-b border-border/60 bg-gradient-to-b from-muted/60 to-background/95 px-5 pb-4 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              <CodePilotIcon
                name="search"
                size="sm"
                className="text-inherit"
                aria-hidden
              />
              <span>{t('globalSearch.title')}</span>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              {t('globalSearch.description')}
            </p>
          </div>
          <Badge
            variant="outline"
            className="border-border/70 bg-background/80 px-2.5 py-1 font-mono text-[10px] text-muted-foreground"
          >
            ⌘K
          </Badge>
        </div>
      </div>

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

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-background/80 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {SCOPE_OPTIONS.map((option) => {
            const isActive = option.scope === activeScope;
            return (
              <Button
                key={option.scope}
                type="button"
                variant={isActive ? 'secondary' : 'ghost'}
                size="xs"
                aria-pressed={isActive}
                data-testid={`global-search-scope-${option.scope}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleScopeSelect(option.scope)}
                className={cn(
                  'h-7 rounded-full px-2.5 text-[11px]',
                  isActive
                    ? 'bg-foreground text-background hover:bg-foreground/90 [&_svg]:!text-current'
                    : 'border border-transparent text-muted-foreground hover:border-border/60 hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <CodePilotIcon
                  name={option.icon}
                  size="sm"
                  className="text-inherit"
                  aria-hidden
                />
                {t(option.labelKey)}
              </Button>
            );
          })}
        </div>

        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid="global-search-status"
        >
          {activePrefix && (
            <Badge
              variant="outline"
              className="border-primary/25 bg-primary/10 font-mono text-[10px] text-primary"
            >
              {activePrefix}
            </Badge>
          )}
          <span className="inline-flex items-center gap-2">
            {loading ? (
              <>
                <CodePilotIcon
                  name="loading"
                  size="sm"
                  className="animate-spin text-muted-foreground"
                  aria-hidden
                />
                {t('globalSearch.searching')}
              </>
            ) : hasSearchTerm ? (
              t('globalSearch.resultsSummary', { count: totalResults })
            ) : (
              t('globalSearch.hintPrefix')
            )}
          </span>
        </div>
      </div>

      <CommandList className="max-h-none flex-1 min-h-0 overflow-y-auto px-3 pb-4 pt-3">
        <div className="space-y-4" data-testid="global-search-surface">
          {!hasSearchTerm && !loading && (
            <div
              className="rounded-[24px] border border-dashed border-border/70 bg-muted/25 px-5 py-6"
              data-testid="global-search-empty-state"
            >
              <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
                <div className="flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-background/90 shadow-sm">
                  <CodePilotIcon
                    name="search"
                    size="md"
                    className="text-foreground"
                    aria-hidden
                  />
                </div>
                <h3 className="mt-4 text-base font-medium text-foreground">
                  {t('globalSearch.hint')}
                </h3>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  {t('globalSearch.emptyDescription')}
                </p>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                {SCOPE_OPTIONS.filter((option) => option.scope !== 'all').map((option) => (
                  <button
                    key={option.scope}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleScopeSelect(option.scope)}
                    className="group rounded-2xl border border-border/70 bg-background/80 p-4 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex size-9 items-center justify-center rounded-xl bg-muted/60">
                        <CodePilotIcon
                          name={option.icon}
                          size="sm"
                          className="text-foreground"
                          aria-hidden
                        />
                      </div>
                      <code className="rounded-full border border-border/60 bg-muted/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {option.prefix}
                      </code>
                    </div>
                    <p className="mt-4 text-sm font-medium text-foreground">
                      {t(option.labelKey)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {option.descriptionKey ? t(option.descriptionKey) : ''}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasSearchTerm && !loading && !hasResults && (
            <div
              className="rounded-[24px] border border-border/70 bg-muted/20 px-5 py-10 text-center"
              data-testid="global-search-no-results"
            >
              <div className="mx-auto flex max-w-lg flex-col items-center">
                <div className="flex size-11 items-center justify-center rounded-2xl border border-border/70 bg-background/90">
                  <CodePilotIcon name="search" size="sm" aria-hidden />
                </div>
                <p className="mt-4 text-base font-medium text-foreground">
                  {t('globalSearch.noResults')}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('globalSearch.noResultsHint')}
                </p>
                <code className="mt-4 rounded-full border border-border/70 bg-background/90 px-3 py-1 font-mono text-[11px] text-muted-foreground">
                  {searchTerm}
                </code>
              </div>
            </div>
          )}

          {loading && hasSearchTerm && (
            <div className="space-y-3 py-1">
              {Array.from({ length: 3 }).map((_, index) => (
                <div
                  key={`search-loading-${index}`}
                  className="animate-pulse rounded-2xl border border-border/60 bg-muted/20 p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="size-9 rounded-xl bg-muted" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-4 w-2/3 rounded bg-muted" />
                      <div className="h-3 w-1/3 rounded bg-muted" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {hasSearchTerm && !loading && hasResults && (
            <>
              {results.sessions.length > 0 && (
                <section
                  className="space-y-2"
                  data-testid="global-search-section-sessions"
                >
                  {renderSectionHeader('sessions', results.sessions.length)}
                  <div className="space-y-2">
                    {results.sessions.map((item) => (
                      <CommandItem
                        key={`session-${item.id}`}
                        value={`session-${item.id}`}
                        onSelect={() => handleSelect(item)}
                        className="rounded-2xl border border-border/60 bg-background/80 px-3 py-3 data-[selected=true]:border-border data-[selected=true]:bg-muted/50"
                        data-testid="global-search-item"
                      >
                        <div className="flex w-full items-start gap-3">
                          <div className="mt-0.5 flex size-9 items-center justify-center rounded-xl bg-muted/60">
                            <CodePilotIcon
                              name="chat"
                              size="sm"
                              className="text-foreground"
                              aria-hidden
                            />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                {renderHighlightedText(
                                  normalizeInlineText(item.title),
                                  searchTerm,
                                )}
                              </p>
                              <Badge
                                variant="outline"
                                className="border-border/70 bg-background/90 text-[10px] text-muted-foreground"
                              >
                                {formatRelativeTime(item.updatedAt, t)}
                              </Badge>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {renderHighlightedText(item.projectName, searchTerm)}
                            </p>
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                  </div>
                </section>
              )}

              {groupedMessages.length > 0 && (
                <section
                  className="space-y-2"
                  data-testid="global-search-section-messages"
                >
                  {renderSectionHeader('messages', results.messages.length)}
                  <div className="space-y-3">
                    {groupedMessages.map((group) => {
                      const isCollapsed = collapsedGroups.has(group.sessionId);
                      return (
                        <div
                          key={`message-group-${group.sessionId}`}
                          className="rounded-[22px] border border-border/60 bg-muted/20"
                        >
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.sessionId)}
                            className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <div className="flex size-8 items-center justify-center rounded-xl bg-background/90">
                                {isCollapsed ? (
                                  <CaretRight
                                    size={14}
                                    className="text-muted-foreground"
                                  />
                                ) : (
                                  <CaretDown
                                    size={14}
                                    className="text-muted-foreground"
                                  />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p
                                  className="truncate text-sm font-medium text-foreground"
                                  title={normalizeInlineText(group.sessionTitle)}
                                >
                                  {renderHighlightedText(
                                    normalizeInlineText(group.sessionTitle),
                                    searchTerm,
                                  )}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {t('globalSearch.messages')}
                                </p>
                              </div>
                            </div>
                            <Badge
                              variant="outline"
                              className="border-border/70 bg-background/90 text-[10px] text-muted-foreground"
                            >
                              {group.messages.length}
                            </Badge>
                          </button>

                          {!isCollapsed && (
                            <div className="space-y-2 px-3 pb-3">
                              {group.messages.map((item) => (
                                <CommandItem
                                  key={`message-${item.messageId}`}
                                  value={`message-${item.messageId}`}
                                  onSelect={() => handleSelect(item)}
                                  className="rounded-2xl border border-border/60 bg-background/85 px-3 py-3 data-[selected=true]:border-border data-[selected=true]:bg-muted/45"
                                  data-testid="global-search-item"
                                >
                                  <div className="flex w-full items-start gap-3">
                                    <div className="mt-0.5 flex size-9 items-center justify-center rounded-xl bg-muted/60">
                                      <CodePilotIcon
                                        name={CONTENT_TYPE_ICONS[item.contentType]}
                                        size="sm"
                                        className="text-foreground"
                                        aria-hidden
                                      />
                                    </div>
                                    <div className="min-w-0 flex-1 space-y-1.5">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Badge
                                          variant="outline"
                                          className="border-border/70 bg-background/90 text-[10px] text-muted-foreground"
                                        >
                                          {t(CONTENT_TYPE_LABEL_KEYS[item.contentType])}
                                        </Badge>
                                        <span className="text-[11px] text-muted-foreground">
                                          {formatRelativeTime(item.createdAt, t)}
                                        </span>
                                      </div>
                                      <p className="line-clamp-2 text-sm leading-5 text-foreground">
                                        {renderHighlightedText(
                                          normalizeInlineText(item.snippet),
                                          searchTerm,
                                        )}
                                      </p>
                                    </div>
                                  </div>
                                </CommandItem>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {results.files.length > 0 && (
                <section
                  className="space-y-2"
                  data-testid="global-search-section-files"
                >
                  {renderSectionHeader('files', results.files.length)}
                  <div className="space-y-2">
                    {results.files.map((item) => (
                      <CommandItem
                        key={`file-${item.path}`}
                        value={`file-${item.path}`}
                        onSelect={() => handleSelect(item)}
                        className="rounded-2xl border border-border/60 bg-background/80 px-3 py-3 data-[selected=true]:border-border data-[selected=true]:bg-muted/50"
                        data-testid="global-search-item"
                      >
                        <div className="flex w-full items-start gap-3">
                          <div className="mt-0.5 flex size-9 items-center justify-center rounded-xl bg-muted/60">
                            <CodePilotIcon
                              name={item.nodeType === 'directory' ? 'folder_open' : 'file'}
                              size="sm"
                              className="text-foreground"
                              aria-hidden
                            />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                {renderHighlightedText(item.name, searchTerm)}
                              </p>
                              <Badge
                                variant="outline"
                                className="border-border/70 bg-background/90 text-[10px] text-muted-foreground"
                              >
                                {item.nodeType === 'directory'
                                  ? t('globalSearch.directoryLabel')
                                  : t('globalSearch.fileLabel')}
                              </Badge>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {normalizeInlineText(item.sessionTitle)}
                            </p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                              {renderHighlightedText(formatPathTail(item.path), searchTerm)}
                            </p>
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </CommandList>
    </CommandDialog>
  );
}
