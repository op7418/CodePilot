'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/hooks/useTranslation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { MagnifyingGlass, ChatCircleText, NotePencil, Folder } from '@/components/ui/icon';
import type { IconComponent } from '@/types';

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
}

interface SearchResultFile {
  type: 'file';
  sessionId: string;
  sessionTitle: string;
  path: string;
  name: string;
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

const TYPE_ICONS: Record<string, IconComponent> = {
  sessions: ChatCircleText,
  messages: NotePencil,
  files: Folder,
};

const TYPE_LABELS: Record<string, string> = {
  sessions: 'Sessions',
  messages: 'Messages',
  files: 'Files',
};

export function GlobalSearchDialog({ open, onOpenChange }: GlobalSearchDialogProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse>({ sessions: [], messages: [], files: [] });
  const abortRef = useRef<AbortController | null>(null);

  const performSearch = useCallback(async (q: string) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    if (!q.trim()) {
      setResults({ sessions: [], messages: [], files: [] });
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
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
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      performSearch(query);
    }, 150);
    return () => clearTimeout(timer);
  }, [query, performSearch]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults({ sessions: [], messages: [], files: [] });
    }
  }, [open]);

  const handleSelect = useCallback(
    (item: SearchResultSession | SearchResultMessage | SearchResultFile) => {
      onOpenChange(false);
      if (item.type === 'session') {
        router.push(`/chat/${item.id}`);
      } else if (item.type === 'message') {
        router.push(`/chat/${item.sessionId}`);
      } else if (item.type === 'file') {
        // For files, navigate to the session and let the file tree show it
        router.push(`/chat/${item.sessionId}`);
      }
    },
    [router, onOpenChange],
  );

  const hasResults =
    results.sessions.length > 0 ||
    results.messages.length > 0 ||
    results.files.length > 0;

  const renderGroup = (
    key: keyof SearchResponse,
    items: (SearchResultSession | SearchResultMessage | SearchResultFile)[],
  ) => {
    if (items.length === 0) return null;
    const Icon = TYPE_ICONS[key];
    return (
      <CommandGroup key={key} heading={TYPE_LABELS[key]}>
        {items.map((item, idx) => (
          <CommandItem
            key={`${key}-${idx}`}
            value={`${key}-${idx}-${item.type === 'session' ? item.id : item.type === 'message' ? item.messageId : item.path}`}
            onSelect={() => handleSelect(item)}
            className="flex items-start gap-2 py-2"
          >
            <Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              {item.type === 'session' && (
                <>
                  <p className="truncate text-sm">{item.title}</p>
                  {item.projectName && (
                    <p className="truncate text-xs text-muted-foreground">{item.projectName}</p>
                  )}
                </>
              )}
              {item.type === 'message' && (
                <>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.sessionTitle} · {item.role === 'user' ? 'User' : 'Assistant'}
                  </p>
                  <p className="truncate text-sm">{item.snippet}</p>
                </>
              )}
              {item.type === 'file' && (
                <>
                  <p className="truncate text-sm">{item.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.sessionTitle}</p>
                </>
              )}
            </div>
          </CommandItem>
        ))}
      </CommandGroup>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Global Search"
      description="Search across sessions, messages, and files"
      className="sm:max-w-lg"
      showCloseButton={false}
    >
      <CommandInput
        placeholder="Search... (try sessions:, messages:, files:)"
        value={query}
        onValueChange={setQuery}
        className="h-12"
      />
      <CommandList className="max-h-[60vh]">
        {!query && !loading && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <p>Type to search across sessions and messages</p>
            <p className="mt-1 text-xs">
              Prefix with <code className="rounded bg-muted px-1">sessions:</code>{' '}
              <code className="rounded bg-muted px-1">messages:</code>{' '}
              <code className="rounded bg-muted px-1">files:</code> to narrow scope
            </p>
          </div>
        )}
        {query && !loading && !hasResults && (
          <CommandEmpty>No results found</CommandEmpty>
        )}
        {renderGroup('sessions', results.sessions)}
        {renderGroup('messages', results.messages)}
        {renderGroup('files', results.files)}
        {loading && (
          <div className="py-4 text-center text-sm text-muted-foreground">Searching...</div>
        )}
      </CommandList>
    </CommandDialog>
  );
}
