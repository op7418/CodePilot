'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { ToolActionsGroup } from '@/components/ai-elements/tool-actions-group';
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
} from '@/components/ai-elements/confirmation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import type { ToolUIPart } from 'ai';
import type { PermissionRequestEvent } from '@/types';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface StreamingMessageProps {
  content: string;
  isStreaming: boolean;
  toolUses?: ToolUseInfo[];
  toolResults?: ToolResultInfo[];
  streamingToolOutput?: string;
  statusText?: string;
  pendingPermission?: PermissionRequestEvent | null;
  onPermissionResponse?: (decision: 'allow' | 'allow_session' | 'deny') => void;
  permissionResolved?: 'allow' | 'deny' | null;
  onForceStop?: () => void;
}

function ElapsedTimer() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

  useEffect(() => {
    startRef.current = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <span className="tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
  );
}

function StreamingStatusBar({ statusText, onForceStop }: { statusText?: string; onForceStop?: () => void }) {
  const displayText = statusText || 'Thinking';

  // Parse elapsed seconds from statusText like "Running bash... (45s)"
  const elapsedMatch = statusText?.match(/\((\d+)s\)/);
  const toolElapsed = elapsedMatch ? parseInt(elapsedMatch[1], 10) : 0;
  const isWarning = toolElapsed >= 60;
  const isCritical = toolElapsed >= 90;

  return (
    <div className="flex items-center gap-3 py-2 px-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className={isCritical ? 'text-red-500' : isWarning ? 'text-yellow-500' : undefined}>
          <Shimmer duration={1.5}>{displayText}</Shimmer>
        </span>
        {isWarning && !isCritical && (
          <span className="text-yellow-500 text-[10px]">Running longer than usual</span>
        )}
        {isCritical && (
          <span className="text-red-500 text-[10px]">Tool may be stuck</span>
        )}
      </div>
      <span className="text-muted-foreground/50">|</span>
      <ElapsedTimer />
      {isCritical && onForceStop && (
        <button
          type="button"
          onClick={onForceStop}
          className="ml-auto rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500 transition-colors hover:bg-red-500/20"
        >
          Force stop
        </button>
      )}
    </div>
  );
}

export function StreamingMessage({
  content,
  isStreaming,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  statusText,
  pendingPermission,
  onPermissionResponse,
  permissionResolved,
  onForceStop,
}: StreamingMessageProps) {
  const runningTools = toolUses.filter(
    (tool) => !toolResults.some((r) => r.tool_use_id === tool.id)
  );

  // Determine confirmation state for the AI Elements component
  const getConfirmationState = (): ToolUIPart['state'] => {
    if (permissionResolved) return 'approval-responded';
    if (pendingPermission) return 'approval-requested';
    return 'input-available';
  };

  const getApproval = () => {
    if (!pendingPermission && !permissionResolved) return undefined;
    if (permissionResolved === 'allow') {
      return { id: pendingPermission?.permissionRequestId || '', approved: true as const };
    }
    if (permissionResolved === 'deny') {
      return { id: pendingPermission?.permissionRequestId || '', approved: false as const };
    }
    // Pending - no decision yet
    return { id: pendingPermission?.permissionRequestId || '' };
  };

  const formatToolInput = (input: Record<string, unknown>): string => {
    if (input.command) return String(input.command);
    if (input.file_path) return String(input.file_path);
    if (input.path) return String(input.path);
    return JSON.stringify(input, null, 2);
  };

  // Extract a human-readable summary of the running command
  const getRunningCommandSummary = (): string | undefined => {
    if (runningTools.length === 0) {
      // All tools completed but still streaming — AI is generating text
      if (toolUses.length > 0) return 'Generating response...';
      return undefined;
    }
    const tool = runningTools[runningTools.length - 1];
    const input = tool.input as Record<string, unknown>;
    if (tool.name === 'Bash' && input.command) {
      const cmd = String(input.command);
      return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
    }
    if (input.file_path) return `${tool.name}: ${String(input.file_path)}`;
    if (input.path) return `${tool.name}: ${String(input.path)}`;
    return `Running ${tool.name}...`;
  };

  return (
    <AIMessage from="assistant">
      <MessageContent>
        {/* Tool calls — compact collapsible group */}
        {toolUses.length > 0 && (
          <ToolActionsGroup
            tools={toolUses.map((tool) => {
              const result = toolResults.find((r) => r.tool_use_id === tool.id);
              return {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                result: result?.content,
                isError: result?.is_error,
              };
            })}
            isStreaming={isStreaming}
            streamingToolOutput={streamingToolOutput}
          />
        )}

        {/* Permission approval confirmation */}
        {(pendingPermission || permissionResolved) && (
          <Confirmation
            approval={getApproval()}
            state={getConfirmationState()}
          >
            <ConfirmationTitle>
              <span className="font-medium">{pendingPermission?.toolName}</span>
              {pendingPermission?.decisionReason && (
                <span className="text-muted-foreground ml-2">
                  — {pendingPermission.decisionReason}
                </span>
              )}
            </ConfirmationTitle>

            {pendingPermission && (
              <div className="mt-1 rounded bg-muted/50 px-3 py-2 font-mono text-xs">
                {formatToolInput(pendingPermission.toolInput)}
              </div>
            )}

            <ConfirmationRequest>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => onPermissionResponse?.('deny')}
                >
                  Deny
                </ConfirmationAction>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => onPermissionResponse?.('allow')}
                >
                  Allow Once
                </ConfirmationAction>
                {pendingPermission?.suggestions && pendingPermission.suggestions.length > 0 && (
                  <ConfirmationAction
                    variant="default"
                    onClick={() => onPermissionResponse?.('allow_session')}
                  >
                    Allow for Session
                  </ConfirmationAction>
                )}
              </ConfirmationActions>
            </ConfirmationRequest>

            <ConfirmationAccepted>
              <p className="text-xs text-green-600 dark:text-green-400">Allowed</p>
            </ConfirmationAccepted>

            <ConfirmationRejected>
              <p className="text-xs text-red-600 dark:text-red-400">Denied</p>
            </ConfirmationRejected>
          </Confirmation>
        )}

        {/* Streaming text content rendered via Streamdown */}
        {content && (
          <MessageResponse>{content}</MessageResponse>
        )}

        {/* Loading indicator when no content yet */}
        {isStreaming && !content && toolUses.length === 0 && !pendingPermission && (
          <div className="py-2">
            <Shimmer>Thinking...</Shimmer>
          </div>
        )}

        {/* Status bar during streaming */}
        {isStreaming && !pendingPermission && <StreamingStatusBar statusText={
          statusText || getRunningCommandSummary()
        } onForceStop={onForceStop} />}
      </MessageContent>
    </AIMessage>
  );
}
