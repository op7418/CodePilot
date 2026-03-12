'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Message, SSEEvent, SessionResponse, TokenUsage, PermissionRequestEvent } from '@/types';
import { MessageList } from '@/components/chat/MessageList';
import { MessageInput } from '@/components/chat/MessageInput';
import { ChatComposerActionBar } from '@/components/chat/ChatComposerActionBar';
import { ChatPermissionSelector } from '@/components/chat/ChatPermissionSelector';
import { ImageGenToggle } from '@/components/chat/ImageGenToggle';
import { PermissionPrompt } from '@/components/chat/PermissionPrompt';
import { usePanel } from '@/hooks/usePanel';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
}

export default function NewChatPage() {
  const router = useRouter();
  const { setPendingApprovalSessionId } = usePanel();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolUses, setToolUses] = useState<ToolUseInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultInfo[]>([]);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [workingDir] = useState('');
  const [mode] = useState('code');
  const [currentModel, setCurrentModel] = useState('sonnet');
  const [currentProviderId, setCurrentProviderId] = useState('');
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | null>(null);
  const [streamingToolOutput, setStreamingToolOutput] = useState('');
  const [permissionProfile, setPermissionProfile] = useState<'default' | 'full_access'>('default');
  const abortControllerRef = useRef<AbortController | null>(null);
  // Effort level — lifted here so the first message includes it
  const [selectedEffort, setSelectedEffort] = useState<string | undefined>(undefined);
  // Thinking mode from app settings
  const [thinkingMode, setThinkingMode] = useState<string>('adaptive');

  // Fetch thinking mode from app settings
  useEffect(() => {
    fetch('/api/settings/app')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.settings?.thinking_mode) {
          setThinkingMode(data.settings.thinking_mode);
        }
      })
      .catch(() => {});
  }, []);

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const handlePermissionResponse = useCallback(async (decision: 'allow' | 'allow_session' | 'deny', updatedInput?: Record<string, unknown>, denyMessage?: string) => {
    if (!pendingPermission) return;

    const body: { permissionRequestId: string; decision: { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message?: string } } = {
      permissionRequestId: pendingPermission.permissionRequestId,
      decision: decision === 'deny'
        ? { behavior: 'deny', message: denyMessage || 'User denied permission' }
        : {
            behavior: 'allow',
            ...(updatedInput ? { updatedInput } : {}),
            ...(decision === 'allow_session' && pendingPermission.suggestions
              ? { updatedPermissions: pendingPermission.suggestions }
              : {}),
          },
    };

    setPermissionResolved(decision === 'deny' ? 'deny' : 'allow');
    setPendingApprovalSessionId('');

    try {
      await fetch('/api/chat/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Best effort
    }

    setTimeout(() => {
      setPendingPermission(null);
      setPermissionResolved(null);
    }, 1000);
  }, [pendingPermission, setPendingApprovalSessionId]);

  const sendFirstMessage = useCallback(
    async (content: string, _files?: unknown, systemPromptAppend?: string, displayOverride?: string) => {
      if (isStreaming) return;

      // Require a project directory before sending
      if (!workingDir.trim()) {
        const hint: Message = {
          id: 'hint-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: '**Please select a project directory first.** Use the folder picker in the toolbar below to choose a working directory before sending a message.',
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages((prev) => [...prev, hint]);
        return;
      }

      setIsStreaming(true);
      setStreamingContent('');
      setToolUses([]);
      setToolResults([]);
      setStatusText(undefined);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let sessionId = '';

      try {
        // Create a new session with working directory + model/provider
        const createBody: Record<string, string> = {
          title: content.slice(0, 50),
          mode,
          working_directory: workingDir.trim(),
          permission_profile: permissionProfile,
          model: currentModel,
          provider_id: currentProviderId,
        };

        const createRes = await fetch('/api/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createBody),
        });

        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({}));
          throw new Error(errBody.error || `Failed to create session (${createRes.status})`);
        }

        const { session }: SessionResponse = await createRes.json();
        sessionId = session.id;

        // Notify ChatListPanel to refresh immediately
        window.dispatchEvent(new CustomEvent('session-created'));

        // Add user message to UI — use displayOverride for chat bubble if provided
        const userMessage: Message = {
          id: 'temp-' + Date.now(),
          session_id: session.id,
          role: 'user',
          content: displayOverride || content,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages([userMessage]);

        // Build thinking config from settings
        const thinkingConfig = thinkingMode && thinkingMode !== 'adaptive'
          ? { type: thinkingMode }
          : thinkingMode === 'adaptive' ? { type: 'adaptive' } : undefined;

        // Send the message via streaming API
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: session.id,
            content,
            mode,
            model: currentModel,
            provider_id: currentProviderId,
            ...(systemPromptAppend ? { systemPromptAppend } : {}),
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
            ...(displayOverride ? { displayOverride } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Failed to send message');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let accumulated = '';
        let tokenUsage: TokenUsage | null = null;
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            try {
              const event: SSEEvent = JSON.parse(line.slice(6));

              switch (event.type) {
                case 'text': {
                  accumulated += event.data;
                  setStreamingContent(accumulated);
                  break;
                }
                case 'tool_use': {
                  try {
                    const toolData = JSON.parse(event.data);
                    setStreamingToolOutput('');
                    setToolUses((prev) => {
                      if (prev.some((t) => t.id === toolData.id)) return prev;
                      return [...prev, { id: toolData.id, name: toolData.name, input: toolData.input }];
                    });
                  } catch { /* skip */ }
                  break;
                }
                case 'tool_result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    setStreamingToolOutput('');
                    setToolResults((prev) => [...prev, { tool_use_id: resultData.tool_use_id, content: resultData.content }]);
                  } catch { /* skip */ }
                  break;
                }
                case 'tool_output': {
                  try {
                    const parsed = JSON.parse(event.data);
                    if (parsed._progress) {
                      setStatusText(`Running ${parsed.tool_name}... (${Math.round(parsed.elapsed_time_seconds)}s)`);
                      break;
                    }
                  } catch {
                    // Not JSON — raw stderr output
                  }
                  setStreamingToolOutput((prev) => {
                    const next = prev + (prev ? '\n' : '') + event.data;
                    return next.length > 5000 ? next.slice(-5000) : next;
                  });
                  break;
                }
                case 'status': {
                  try {
                    const statusData = JSON.parse(event.data);
                    if (statusData.session_id) {
                      setStatusText(`Connected (${statusData.model || 'claude'})`);
                      setTimeout(() => setStatusText(undefined), 2000);
                    } else if (statusData.notification) {
                      setStatusText(statusData.message || statusData.title || undefined);
                    } else {
                      setStatusText(event.data || undefined);
                    }
                  } catch {
                    setStatusText(event.data || undefined);
                  }
                  break;
                }
                case 'result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    if (resultData.usage) tokenUsage = resultData.usage;
                  } catch { /* skip */ }
                  setStatusText(undefined);
                  break;
                }
                case 'permission_request': {
                  try {
                    const permData: PermissionRequestEvent = JSON.parse(event.data);
                    setPendingPermission(permData);
                    setPermissionResolved(null);
                    setPendingApprovalSessionId(sessionId);
                  } catch {
                    // skip malformed permission_request data
                  }
                  break;
                }
                case 'error': {
                  accumulated += '\n\n**Error:** ' + event.data;
                  setStreamingContent(accumulated);
                  break;
                }
                case 'done':
                  break;
              }
            } catch {
              // skip
            }
          }
        }

        // Add the completed assistant message
        if (accumulated.trim()) {
          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: session.id,
            role: 'assistant',
            content: accumulated.trim(),
            created_at: new Date().toISOString(),
            token_usage: tokenUsage ? JSON.stringify(tokenUsage) : null,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }

        // Navigate to the session page after response is complete
        router.push(`/chat/${session.id}`);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // User stopped - navigate to session if we have one
          if (sessionId) {
            router.push(`/chat/${sessionId}`);
          }
        } else {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          const errorMessage: Message = {
            id: 'temp-error-' + Date.now(),
            session_id: '',
            role: 'assistant',
            content: `**Error:** ${errMsg}`,
            created_at: new Date().toISOString(),
            token_usage: null,
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
      } finally {
        setIsStreaming(false);
        setStreamingContent('');
        setToolUses([]);
        setToolResults([]);
        setStreamingToolOutput('');
        setStatusText(undefined);
        setPendingPermission(null);
        setPermissionResolved(null);
        setPendingApprovalSessionId('');
        abortControllerRef.current = null;
      }
    },
    [isStreaming, router, workingDir, mode, currentModel, currentProviderId, permissionProfile, selectedEffort, thinkingMode, setPendingApprovalSessionId]
  );

  const handleCommand = useCallback((command: string) => {
    switch (command) {
      case '/help': {
        const helpMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: `## Available Commands\n\n- **/help** - Show this help message\n- **/clear** - Clear conversation history\n- **/compact** - Compress conversation context\n- **/cost** - Show token usage statistics\n- **/doctor** - Check system health\n- **/init** - Initialize CLAUDE.md\n- **/review** - Start code review\n- **/terminal-setup** - Configure terminal\n\n**Tips:**\n- Type \`@\` to mention files\n- Use Shift+Enter for new line\n- Select a project folder to enable file operations`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, helpMessage]);
        break;
      }
      case '/clear':
        setMessages([]);
        break;
      case '/cost': {
        const costMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: `## Token Usage\n\nToken usage tracking is available after sending messages. Check the token count displayed at the bottom of each assistant response.`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, costMessage]);
        break;
      }
      default:
        sendFirstMessage(command);
    }
  }, [sendFirstMessage]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        toolUses={toolUses}
        toolResults={toolResults}
        streamingToolOutput={streamingToolOutput}
        statusText={statusText}
      />
      <PermissionPrompt
        pendingPermission={pendingPermission}
        permissionResolved={permissionResolved}
        onPermissionResponse={handlePermissionResponse}
        toolUses={toolUses}
      />
      <MessageInput
        onSend={sendFirstMessage}
        onCommand={handleCommand}
        onStop={stopStreaming}
        disabled={false}
        isStreaming={isStreaming}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        providerId={currentProviderId}
        onProviderModelChange={(pid, model) => {
          setCurrentProviderId(pid);
          setCurrentModel(model);
        }}
        workingDirectory={workingDir}
        effort={selectedEffort}
        onEffortChange={setSelectedEffort}
      />
      <ChatComposerActionBar
        left={<ImageGenToggle />}
        center={
          <ChatPermissionSelector
            permissionProfile={permissionProfile}
            onPermissionChange={setPermissionProfile}
          />
        }
      />
    </div>
  );
}
