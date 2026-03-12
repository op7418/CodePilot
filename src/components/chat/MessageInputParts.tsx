'use client';

import { useEffect } from 'react';
import { ArrowUp, Plus, X, Stop, Terminal } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import {
  PromptInputButton,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import type { ChatStatus } from 'ai';
import { isSubmitEnabled } from '@/lib/message-input-logic';

/**
 * Submit button that's aware of file attachments. Must be rendered inside PromptInput.
 */
export function FileAwareSubmitButton({
  status,
  onStop,
  disabled,
  inputValue,
  hasBadge,
}: {
  status: ChatStatus;
  onStop?: () => void;
  disabled?: boolean;
  inputValue: string;
  hasBadge: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const hasFiles = attachments.files.length > 0;
  const isStreaming = status === 'streaming' || status === 'submitted';
  const enabled = isSubmitEnabled({
    inputValue,
    hasBadge,
    hasFiles,
    isStreaming,
    disabled: !!disabled,
  });

  return (
    <PromptInputSubmit
      status={status}
      onStop={onStop}
      disabled={!enabled}
      className="rounded-full"
    >
      {isStreaming ? (
        <Stop size={16} />
      ) : (
        <ArrowUp size={16} />
      )}
    </PromptInputSubmit>
  );
}

/**
 * Attachment button that opens the file dialog. Must be rendered inside PromptInput.
 */
export function AttachFileButton() {
  const attachments = usePromptInputAttachments();
  const { t } = useTranslation();

  return (
    <PromptInputButton
      onClick={() => attachments.openFileDialog()}
      tooltip={t('messageInput.attachFiles')}
    >
      <Plus size={16} />
    </PromptInputButton>
  );
}

/**
 * Bridge component that listens for 'attach-file-to-chat' custom events
 * from the file tree and inserts `@filepath` into the textarea.
 */
export function FileTreeAttachmentBridge() {
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{ path: string }>;
      const filePath = customEvent.detail?.path;
      if (!filePath) return;
      window.dispatchEvent(new CustomEvent('insert-file-mention', { detail: { path: filePath } }));
    };

    window.addEventListener('attach-file-to-chat', handler);
    return () => window.removeEventListener('attach-file-to-chat', handler);
  }, []);

  return null;
}

/**
 * Capsule display for attached files, rendered inside PromptInput context.
 */
export function FileAttachmentsCapsules() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 px-3 pt-2 pb-0 order-first">
      {attachments.files.map((file) => {
        const isImage = file.mediaType?.startsWith('image/');
        return (
          <span
            key={file.id}
            className="inline-flex items-center gap-1.5 rounded-full bg-status-success-muted text-status-success-foreground pl-2 pr-1 py-0.5 text-xs font-medium border border-status-success-border"
          >
            {isImage && file.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={file.url}
                alt={file.filename || 'image'}
                className="h-5 w-5 rounded object-cover"
              />
            )}
            <span className="max-w-[120px] truncate text-[11px]">
              {file.filename || 'file'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => attachments.remove(file.id)}
              className="ml-0.5 h-auto w-auto rounded-full p-0.5 hover:bg-status-success-border"
            >
              <X size={12} />
            </Button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Slash-command badge displayed above the textarea.
 */
export function CommandBadge({
  command,
  description,
  onRemove,
}: {
  command: string;
  description?: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-1.5 px-3 pt-2.5 pb-0 order-first">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary pl-2.5 pr-1.5 py-1 text-xs font-medium border border-primary/20">
        <span className="font-mono">{command}</span>
        {description && (
          <span className="text-primary/60 text-[10px]">{description}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          className="ml-0.5 h-auto w-auto rounded-full p-0.5 hover:bg-primary/20"
        >
          <X size={12} />
        </Button>
      </span>
    </div>
  );
}

/**
 * CLI tool badge displayed above the textarea.
 */
export function CliBadge({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-1.5 px-3 pt-2.5 pb-0 order-first">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-status-success-muted text-status-success-foreground pl-2.5 pr-1.5 py-1 text-xs font-medium border border-status-success-border">
        <Terminal size={12} />
        <span>CLI: {name}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          className="ml-0.5 h-auto w-auto rounded-full p-0.5 hover:bg-status-success-border"
        >
          <X size={12} />
        </Button>
      </span>
    </div>
  );
}
