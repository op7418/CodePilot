'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Message, SSEEvent, SessionResponse, TokenUsage, PermissionRequestEvent } from '@/types';
import { MessageList } from '@/components/chat/MessageList';
import { MessageInput } from '@/components/chat/MessageInput';
import { ChatComposerActionBar } from '@/components/chat/ChatComposerActionBar';
import { ModeIndicator } from '@/components/chat/ModeIndicator';
import { ChatPermissionSelector } from '@/components/chat/ChatPermissionSelector';
import { ImageGenToggle } from '@/components/chat/ImageGenToggle';
import { PermissionPrompt } from '@/components/chat/PermissionPrompt';
import { ChatEmptyState } from '@/components/chat/ChatEmptyState';
import { OnboardingWizard } from '@/components/assistant/OnboardingWizard';
import { ErrorBanner } from '@/components/ui/error-banner';
import { FolderPicker } from '@/components/chat/FolderPicker';
import { useNativeFolderPicker } from '@/hooks/useNativeFolderPicker';
import { useTranslation } from '@/hooks/useTranslation';
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
  // Read prefill from URL once on mount — avoids useSearchParams which requires Suspense boundary
  const prefillText = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    return params.get('prefill') || '';
  }, []);
  const { setPendingApprovalSessionId } = usePanel();
  const { t } = useTranslation();
  const { isElectron, openNativePicker } = useNativeFolderPicker();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolUses, setToolUses] = useState<ToolUseInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultInfo[]>([]);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [workingDir, setWorkingDir] = useState('');
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{ message: string; description?: string } | null>(null);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [hasProvider, setHasProvider] = useState(true); // assume true until checked
  const [showWizard, setShowWizard] = useState(false);
  const [assistantConfigured, setAssistantConfigured] = useState(false);
  const [assistantWorkspacePath, setAssistantWorkspacePath] = useState('');
  const [mode, setMode] = useState('code');
  // Model/provider start empty — populated by the async global-default fetch.
  // This prevents the race where a user sends before the fetch completes and
  // gets the stale localStorage model instead of the configured default.
  const [modelReady, setModelReady] = useState(false);
  const [currentModel, setCurrentModel] = useState(() => {
    if (typeof window === 'undefined') return '';
    // One-time migration: clear stale model/provider from pre-0.38 installs
    if (!localStorage.getItem('codepilot:migration-038')) {
      localStorage.removeItem('codepilot:last-model');
      localStorage.removeItem('codepilot:last-provider-id');
      localStorage.setItem('codepilot:migration-038', '1');
    }
    return '';
  });
  const [currentProviderId, setCurrentProviderId] = useState(() => {
    if (typeof window === 'undefined') return '';
    if (!localStorage.getItem('codepilot:migration-038')) {
      return '';
    }
    return '';
  });
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | null>(null);
  const [streamingToolOutput, setStreamingToolOutput] = useState('');
  const [permissionProfile, setPermissionProfile] = useState<'default' | 'full_access'>('default');
  const [createdSessionId, setCreatedSessionId] = useState<string | undefined>();
  const abortControllerRef = useRef<AbortController | null>(null);
  // Effort level — lifted here so the first message includes it
  const [selectedEffort, setSelectedEffort] = useState<string | undefined>(undefined);
  // Provider options (thinking mode + 1M context)
  const [thinkingMode, setThinkingMode] = useState<string>('adaptive');
  const [context1m, setContext1m] = useState(false);

  // Fetch provider-specific options (with abort to prevent stale responses on fast switch)
  useEffect(() => {
    const pid = currentProviderId || 'env';
    const controller = new AbortController();
    fetch(`/api/providers/options?providerId=${encodeURIComponent(pid)}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!controller.signal.aborted) {
          setThinkingMode(data?.options?.thinking_mode || 'adaptive');
          setContext1m(!!data?.options?.context_1m);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [currentProviderId]);

  // Validate restored model/provider against actual available providers/models.
  // For NEW conversations, the global default model takes priority
  // over localStorage's last-model (which is a cross-session global memory).
  useEffect(() => {
    let cancelled = false;

    // Fetch models and global default in parallel
    const modelsP = fetch('/api/providers/models').then(r => r.ok ? r.json() : null);
    const globalP = fetch('/api/providers/options?providerId=__global__').then(r => r.ok ? r.json() : null);

    Promise.all([modelsP, globalP]).then(([modelsData, globalData]) => {
      if (cancelled || !modelsData?.groups || modelsData.groups.length === 0) {
        // No provider data — fall back to localStorage best-effort
        const savedModel = localStorage.getItem('codepilot:last-model') || 'sonnet';
        const savedProvider = localStorage.getItem('codepilot:last-provider-id') || '';
        setCurrentModel(savedModel);
        setCurrentProviderId(savedProvider);
        setModelReady(true);
        return;
      }
      const groups = modelsData.groups as Array<{ provider_id: string; models: Array<{ value: string }> }>;
      const globalDefaultModel = globalData?.options?.default_model || '';
      const globalDefaultProvider = globalData?.options?.default_model_provider || '';

      // Apply global default for new conversations
      // Case 1: both provider and model are set and valid
      if (globalDefaultModel && globalDefaultProvider) {
        const targetGroup = groups.find(g => g.provider_id === globalDefaultProvider);
        const modelValid = targetGroup?.models.some(m => m.value === globalDefaultModel);
        if (modelValid) {
          setCurrentModel(globalDefaultModel);
          setCurrentProviderId(globalDefaultProvider);
          setModelReady(true);
          return;
        }
      }
      // Case 2: provider is set but model was cleared (e.g. after doctor repair / provider delete)
      // → use that provider's first available model
      if (globalDefaultProvider && !globalDefaultModel) {
        const targetGroup = groups.find(g => g.provider_id === globalDefaultProvider);
        if (targetGroup?.models?.length) {
          setCurrentModel(targetGroup.models[0].value);
          setCurrentProviderId(globalDefaultProvider);
          setModelReady(true);
          return;
        }
      }

      // No global default — use localStorage, validate against provider's list
      const savedProvider = localStorage.getItem('codepilot:last-provider-id') || '';
      const savedModel = localStorage.getItem('codepilot:last-model') || '';
      const validProvider = groups.find(g => g.provider_id === savedProvider);
      const resolvedGroup = validProvider || groups[0];
      const resolvedPid = resolvedGroup?.provider_id || '';

      if (validProvider) {
        setCurrentProviderId(savedProvider);
      } else {
        setCurrentProviderId(resolvedPid);
      }

      if (resolvedGroup?.models && resolvedGroup.models.length > 0) {
        const validModel = savedModel && resolvedGroup.models.some(m => m.value === savedModel);
        if (validModel) {
          setCurrentModel(savedModel);
        } else {
          setCurrentModel(resolvedGroup.models[0].value);
        }
      } else {
        setCurrentModel(savedModel || 'sonnet');
      }
      setModelReady(true);
    }).catch(() => {
      // Fetch failed — fall back to localStorage best-effort
      const savedModel = localStorage.getItem('codepilot:last-model') || 'sonnet';
      const savedProvider = localStorage.getItem('codepilot:last-provider-id') || '';
      setCurrentModel(savedModel);
      setCurrentProviderId(savedProvider);
      setModelReady(true);
    });

    return () => { cancelled = true; };
   
  }, []); // Run once on mount to validate initial values

  // Initialize workingDir from localStorage (or setup default), validating the path exists
  useEffect(() => {
    let cancelled = false;

    const validateDir = async (path: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/files/browse?dir=${encodeURIComponent(path)}`);
        return res.ok;
      } catch {
        return false;
      }
    };

    const tryFallbackToDefault = async () => {
      try {
        const res = await fetch('/api/setup');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || !data?.defaultProject) return;
        if (await validateDir(data.defaultProject) && !cancelled) {
          setWorkingDir(data.defaultProject);
          localStorage.setItem('codepilot:last-working-directory', data.defaultProject);
        }
      } catch { /* ignore */ }
    };

    const init = async () => {
      const saved = localStorage.getItem('codepilot:last-working-directory');
      if (saved) {
        if (await validateDir(saved) && !cancelled) {
          setWorkingDir(saved);
        } else if (!cancelled) {
          // Stale — clear and try setup default
          localStorage.removeItem('codepilot:last-working-directory');
          await tryFallbackToDefault();
        }
      } else {
        await tryFallbackToDefault();
      }
    };

    init();

    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      if (path) setWorkingDir(path);
    };
    window.addEventListener('project-directory-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('project-directory-changed', handler);
    };
  }, []);

  // Load recent projects for empty state
  useEffect(() => {
    fetch('/api/setup/recent-projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(data => setRecentProjects(data.projects || []))
      .catch(() => {});
  }, []);

  // Detect assistant workspace status
  useEffect(() => {
    fetch('/api/settings/workspace')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.path && data?.valid !== false) {
          setAssistantWorkspacePath(data.path);
          setAssistantConfigured(!!data.state?.onboardingComplete);
        }
      })
      .catch(() => {});
  }, []);

  // Check provider availability — only 'completed' counts, 'skipped' means user deferred but has no real credentials
  useEffect(() => {
    const checkProvider = () => {
      // Lock sending while we re-resolve the model/provider
      setModelReady(false);
      fetch('/api/setup')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            setHasProvider(data.provider === 'completed');
          }
        })
        .catch(() => {});
      // Sync provider/model, applying global default model for new conversations.
      const savedProviderId = localStorage.getItem('codepilot:last-provider-id');

      // Fetch models + global default in parallel
      const modelsP = fetch('/api/providers/models').then(r => r.ok ? r.json() : null);
      const globalP = fetch('/api/providers/options?providerId=__global__').then(r => r.ok ? r.json() : null);

      Promise.all([modelsP, globalP]).then(([modelsData, globalData]) => {
        if (!modelsData?.groups || modelsData.groups.length === 0) {
          setModelReady(true);
          return;
        }
        const groups = modelsData.groups as Array<{ provider_id: string; models: Array<{ value: string }> }>;
        const globalDefaultModel = globalData?.options?.default_model || '';
        const globalDefaultProvider = globalData?.options?.default_model_provider || '';

        // Validate and apply provider
        if (savedProviderId !== null) {
          const validProvider = groups.find(g => g.provider_id === savedProviderId);
          if (validProvider) {
            setCurrentProviderId(savedProviderId);
          } else {
            setCurrentProviderId('');
            localStorage.removeItem('codepilot:last-provider-id');
          }
        }

        // Apply global default for new conversations
        // Case 1: both provider and model are set and valid
        if (globalDefaultModel && globalDefaultProvider) {
          const targetGroup = groups.find(g => g.provider_id === globalDefaultProvider);
          const modelValid = targetGroup?.models.some(m => m.value === globalDefaultModel);
          if (modelValid) {
            setCurrentModel(globalDefaultModel);
            setCurrentProviderId(globalDefaultProvider);
            setModelReady(true);
            return;
          }
        }
        // Case 2: provider is set but model was cleared (e.g. after doctor repair / provider delete)
        // → use that provider's first available model
        if (globalDefaultProvider && !globalDefaultModel) {
          const targetGroup = groups.find(g => g.provider_id === globalDefaultProvider);
          if (targetGroup?.models?.length) {
            setCurrentModel(targetGroup.models[0].value);
            setCurrentProviderId(globalDefaultProvider);
            setModelReady(true);
            return;
          }
        }

        // No global default — validate current model
        const resolvedPid = savedProviderId && groups.find(g => g.provider_id === savedProviderId)
          ? savedProviderId
          : groups[0]?.provider_id || '';
        const resolvedGroup = groups.find(g => g.provider_id === resolvedPid) || groups[0];
        setCurrentProviderId(resolvedPid);
        if (resolvedGroup?.models?.length > 0) {
          const savedModel = localStorage.getItem('codepilot:last-model');
          const validModel = savedModel && resolvedGroup.models.some(
            (m: { value: string }) => m.value === savedModel
          );
          if (validModel) {
            setCurrentModel(savedModel);
          } else {
            const fallback = resolvedGroup.models[0].value;
            setCurrentModel(fallback);
            localStorage.setItem('codepilot:last-model', fallback);
          }
        }
        setModelReady(true);
      }).catch(() => {
        // On fetch failure, still apply localStorage values as-is (best effort)
        if (savedProviderId !== null) setCurrentProviderId(savedProviderId);
        const savedModel = localStorage.getItem('codepilot:last-model');
        if (savedModel) setCurrentModel(savedModel);
        setModelReady(true);
      });
    };
    checkProvider();

    window.addEventListener('provider-changed', checkProvider);
    return () => window.removeEventListener('provider-changed', checkProvider);
  }, []);

  const handleSelectFolder = useCallback(async () => {
    if (isElectron) {
      const path = await openNativePicker({ title: t('folderPicker.title') });
      if (path) {
        setWorkingDir(path);
        localStorage.setItem('codepilot:last-working-directory', path);
      }
    } else {
      setFolderPickerOpen(true);
    }
  }, [isElectron, openNativePicker, t]);

  const handleFolderPickerSelect = useCallback((path: string) => {
    setWorkingDir(path);
    localStorage.setItem('codepilot:last-working-directory', path);
    setFolderPickerOpen(false);
  }, []);

  const handleSelectProject = useCallback((path: string) => {
    setWorkingDir(path);
    localStorage.setItem('codepilot:last-working-directory', path);
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

      // Wait for model/provider to be resolved from the global default before allowing send
      if (!modelReady) return;

      // Require a project directory before sending
      if (!workingDir.trim()) {
        setErrorBanner({ message: t('chat.empty.noDirectory') });
        return;
      }

      // Require a provider before sending
      if (!hasProvider) {
        setErrorBanner({
          message: t('error.providerUnavailable'),
          description: t('chat.empty.noProvider'),
        });
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
        setCreatedSessionId(sessionId);

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
            ...(context1m ? { context_1m: true } : {}),
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
                  // Try to parse structured error JSON from classifier
                  let errorDisplay: string;
                  try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.category && parsed.userMessage) {
                      errorDisplay = parsed.userMessage;
                      if (parsed.actionHint) errorDisplay += `\n\n**What to do:** ${parsed.actionHint}`;
                      if (parsed.details) errorDisplay += `\n\nDetails: ${parsed.details}`;
                      // Add diagnostic guidance for provider/auth related errors
                      const diagCategories = new Set([
                        'AUTH_REJECTED', 'AUTH_FORBIDDEN', 'AUTH_STYLE_MISMATCH',
                        'NO_CREDENTIALS', 'PROVIDER_NOT_APPLIED', 'MODEL_NOT_AVAILABLE',
                        'NETWORK_UNREACHABLE', 'ENDPOINT_NOT_FOUND', 'PROCESS_CRASH',
                        'CLI_NOT_FOUND', 'UNSUPPORTED_FEATURE',
                      ]);
                      if (diagCategories.has(parsed.category)) {
                        errorDisplay += '\n\n💡 [Run Provider Diagnostics](/settings#providers) to troubleshoot, or check the [Provider Setup Guide](https://www.codepilot.sh/docs/providers).';
                      }
                    } else {
                      errorDisplay = event.data;
                    }
                  } catch {
                    errorDisplay = event.data;
                  }
                  accumulated += '\n\n**Error:** ' + errorDisplay;
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
          setErrorBanner({ message: t('error.sessionCreateFailed'), description: errMsg });
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
    [isStreaming, router, workingDir, mode, currentModel, currentProviderId, permissionProfile, selectedEffort, thinkingMode, context1m, setPendingApprovalSessionId, t, hasProvider, modelReady]
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
      {messages.length === 0 && !isStreaming && (!workingDir.trim() || !hasProvider) ? (
        <ChatEmptyState
          hasDirectory={!!workingDir.trim()}
          hasProvider={hasProvider}
          onSelectFolder={handleSelectFolder}
          recentProjects={recentProjects}
          onSelectProject={handleSelectProject}
          assistantConfigured={assistantConfigured}
          onOpenAssistant={() => {
            if (assistantConfigured) {
              // Navigate to the latest assistant session
              fetch(`/api/workspace/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'checkin' }),
              })
                .then(r => r.json())
                .then(data => router.push(`/chat/${data.session.id}`))
                .catch(() => {});
            } else if (assistantWorkspacePath) {
              setShowWizard(true);
            } else {
              router.push('/settings#assistant');
            }
          }}
        />
      ) : (
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
          sessionId={createdSessionId}
          toolUses={toolUses}
          toolResults={toolResults}
          streamingToolOutput={streamingToolOutput}
          statusText={statusText}
        />
      )}
      {errorBanner && (
        <ErrorBanner
          message={errorBanner.message}
          description={errorBanner.description}
          className="mx-4 mb-2"
          onDismiss={() => setErrorBanner(null)}
          actions={[
            { label: t('error.retry'), onClick: () => setErrorBanner(null) },
          ]}
        />
      )}
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
        disabled={!modelReady}
        isStreaming={isStreaming}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        providerId={currentProviderId}
        onProviderModelChange={(pid, model) => {
          setCurrentProviderId(pid);
          setCurrentModel(model);
          localStorage.setItem('codepilot:last-provider-id', pid);
          localStorage.setItem('codepilot:last-model', model);
        }}
        workingDirectory={workingDir}
        effort={selectedEffort}
        onEffortChange={setSelectedEffort}
        initialValue={prefillText}
      />
      <ChatComposerActionBar
        left={<><ModeIndicator mode={mode} onModeChange={setMode} disabled={isStreaming} /><ImageGenToggle /></>}
        center={
          <ChatPermissionSelector
            permissionProfile={permissionProfile}
            onPermissionChange={setPermissionProfile}
          />
        }
      />
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderPickerSelect}
      />
      {showWizard && assistantWorkspacePath && (
        <OnboardingWizard
          workspacePath={assistantWorkspacePath}
          onComplete={(session) => {
            setShowWizard(false);
            setAssistantConfigured(true);
            router.push(`/chat/${session.id}`);
          }}
        />
      )}
    </div>
  );
}
