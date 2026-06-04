'use client';

import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { MediaJob, MediaJobItem, PlannerOutput, PlannerItem, JobProgressEvent } from '@/types';

// ==========================================
// Types
// ==========================================

export type BatchPhase = 'idle' | 'entry' | 'planning' | 'reviewing' | 'executing' | 'completed' | 'syncing';

export interface BatchImageGenState {
  enabled: boolean;
  phase: BatchPhase;
  currentJob: MediaJob | null;
  items: MediaJobItem[];
  plannerOutput: PlannerOutput | null;
  planningText: string;
  progress: {
    total: number;
    completed: number;
    failed: number;
    processing: number;
  };
  error: string | null;
}

export interface BatchImageGenContextValue {
  state: BatchImageGenState;
  setEnabled: (v: boolean) => void;
  startPlanning: (params: { stylePrompt: string; docPaths?: string[]; docContent?: string; count?: number; sessionId?: string }) => Promise<void>;
  updatePlanItem: (index: number, updates: Partial<PlannerItem>) => void;
  addPlanItem: () => void;
  removePlanItem: (index: number) => void;
  executeJob: (sessionId?: string) => Promise<void>;
  pauseJob: () => Promise<void>;
  resumeJob: () => Promise<void>;
  cancelJob: () => Promise<void>;
  retryFailed: () => Promise<void>;
  syncToLlm: (syncMode?: 'manual' | 'auto_batch') => Promise<void>;
  resetJob: () => void;
  injectPlanAndExecute: (plan: PlannerOutput, sessionId?: string) => Promise<void>;
}

// ==========================================
// Context
// ==========================================

export const BatchImageGenContext = createContext<BatchImageGenContextValue | null>(null);

export function useBatchImageGen(): BatchImageGenContextValue {
  const ctx = useContext(BatchImageGenContext);
  if (!ctx) {
    throw new Error('useBatchImageGen must be used within a BatchImageGenProvider');
  }
  return ctx;
}

// ==========================================
// State Hook
// ==========================================

const initialState: BatchImageGenState = {
  enabled: false,
  phase: 'idle',
  currentJob: null,
  items: [],
  plannerOutput: null,
  planningText: '',
  progress: { total: 0, completed: 0, failed: 0, processing: 0 },
  error: null,
};

export function useBatchImageGenState(): BatchImageGenContextValue {
  const [state, setState] = useState<BatchImageGenState>(initialState);
  const progressSourceRef = useRef<EventSource | null>(null);

  // Close the SSE progress stream on unmount to release the server-side
  // connection and the registered event listeners (which hold closures
  // over the unmounted component's state setters). Without this, navigating
  // away mid-job leaks the EventSource until the server-side timeout fires.
  useEffect(() => {
    return () => {
      if (progressSourceRef.current) {
        progressSourceRef.current.close();
        progressSourceRef.current = null;
      }
    };
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setState(prev => ({
      ...prev,
      enabled: v,
      phase: v ? 'entry' : 'idle',
      error: null,
    }));
  }, []);

  const startPlanning = useCallback(async (params: {
    stylePrompt: string;
    docPaths?: string[];
    docContent?: string;
    count?: number;
    sessionId?: string;
  }) => {
    setState(prev => ({ ...prev, phase: 'planning', planningText: '', error: null }));

    try {
      const res = await fetch('/api/media/jobs/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stylePrompt: params.stylePrompt,
          docPaths: params.docPaths,
          docContent: params.docContent,
          count: params.count,
          sessionId: params.sessionId,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Planning failed' }));
        throw new Error(err.error || 'Planning failed');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));

            if (eventType === 'text') {
              fullText += data.chunk;
              setState(prev => ({ ...prev, planningText: fullText }));
            } else if (eventType === 'plan_complete') {
              const plan = data.plan as PlannerOutput;
              setState(prev => ({
                ...prev,
                phase: 'reviewing',
                plannerOutput: plan,
                planningText: fullText,
              }));
            } else if (eventType === 'error') {
              setState(prev => ({
                ...prev,
                phase: 'entry',
                error: data.message || 'Planning failed',
              }));
            }
          }
        }
      }
    } catch (err) {
      setState(prev => ({
        ...prev,
        phase: 'entry',
        error: err instanceof Error ? err.message : 'Planning failed',
      }));
    }
  }, []);

  const updatePlanItem = useCallback((index: number, updates: Partial<PlannerItem>) => {
    setState(prev => {
      if (!prev.plannerOutput) return prev;
      const newItems = [...prev.plannerOutput.items];
      newItems[index] = { ...newItems[index], ...updates };
      return { ...prev, plannerOutput: { ...prev.plannerOutput, items: newItems } };
    });
  }, []);

  const addPlanItem = useCallback(() => {
    setState(prev => {
      if (!prev.plannerOutput) return prev;
      const newItem: PlannerItem = {
        prompt: '',
        aspectRatio: '1:1',
        resolution: '1K',
        tags: [],
        sourceRefs: [],
      };
      return {
        ...prev,
        plannerOutput: {
          ...prev.plannerOutput,
          items: [...prev.plannerOutput.items, newItem],
        },
      };
    });
  }, []);

  const removePlanItem = useCallback((index: number) => {
    setState(prev => {
      if (!prev.plannerOutput) return prev;
      const newItems = prev.plannerOutput.items.filter((_, i) => i !== index);
      return { ...prev, plannerOutput: { ...prev.plannerOutput, items: newItems } };
    });
  }, []);

  const executeJob = useCallback(async (sessionId?: string) => {
    const currentPlan = state.plannerOutput;
    if (!currentPlan || currentPlan.items.length === 0) return;

    setState(prev => ({ ...prev, phase: 'executing', error: null }));

    try {
      // Create the job
      const createRes = await fetch('/api/media/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          items: currentPlan.items.map(item => ({
            prompt: item.prompt,
            aspectRatio: item.aspectRatio,
            imageSize: item.resolution,
            tags: item.tags,
            sourceRefs: item.sourceRefs,
          })),
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({ error: 'Failed to create job' }));
        throw new Error(err.error);
      }

      const { job, items } = await createRes.json();
      setState(prev => ({
        ...prev,
        currentJob: job,
        items,
        progress: { total: items.length, completed: 0, failed: 0, processing: 0 },
      }));

      // Start execution
      const startRes = await fetch(`/api/media/jobs/${job.id}/start`, { method: 'POST' });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({ error: 'Failed to start job' }));
        throw new Error(err.error);
      }

      // Connect to progress SSE
      connectProgressSSE(job.id);
    } catch (err) {
      setState(prev => ({
        ...prev,
        phase: 'reviewing',
        error: err instanceof Error ? err.message : 'Execution failed',
      }));
    }
  }, [state.plannerOutput]);

  const connectProgressSSE = useCallback((jobId: string) => {
    // Close existing connection
    if (progressSourceRef.current) {
      progressSourceRef.current.close();
    }

    const es = new EventSource(`/api/media/jobs/${jobId}/progress`);
    progressSourceRef.current = es;

    const handleEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);

        if (data.progress) {
          setState(prev => ({ ...prev, progress: data.progress }));
        }

        if (data.items) {
          setState(prev => ({ ...prev, items: data.items }));
        }
      } catch { /* ignore parse errors */ }
    };

    es.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setState(prev => ({
          ...prev,
          progress: data.progress,
          items: data.items || prev.items,
        }));
      } catch { /* ignore */ }
    });

    es.addEventListener('item_started', handleEvent);
    es.addEventListener('item_completed', (e: MessageEvent) => {
      handleEvent(e);
      // Refresh items from server for latest state
      refreshItems(jobId);
    });
    es.addEventListener('item_failed', handleEvent);
    es.addEventListener('item_retry', handleEvent);

    es.addEventListener('job_completed', (e: MessageEvent) => {
      handleEvent(e);
      setState(prev => ({ ...prev, phase: 'completed' }));
      es.close();
      progressSourceRef.current = null;
      refreshItems(jobId);
    });

    es.addEventListener('job_paused', (e: MessageEvent) => {
      handleEvent(e);
      refreshItems(jobId);
    });

    es.addEventListener('job_cancelled', (e: MessageEvent) => {
      handleEvent(e);
      setState(prev => ({ ...prev, phase: 'completed' }));
      es.close();
      progressSourceRef.current = null;
      refreshItems(jobId);
    });

    es.addEventListener('done', () => {
      es.close();
      progressSourceRef.current = null;
    });

    es.onerror = () => {
      es.close();
      progressSourceRef.current = null;
    };
  }, []);

  const refreshItems = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/media/jobs/${jobId}`);
      if (res.ok) {
        const data = await res.json();
        setState(prev => ({
          ...prev,
          currentJob: data.job,
          items: data.items,
        }));
      }
    } catch { /* ignore */ }
  }, []);

  const pauseJob = useCallback(async () => {
    if (!state.currentJob) return;
    try {
      await fetch(`/api/media/jobs/${state.currentJob.id}/pause`, { method: 'POST' });
      setState(prev => ({
        ...prev,
        currentJob: prev.currentJob ? { ...prev.currentJob, status: 'paused' } : null,
      }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to pause',
      }));
    }
  }, [state.currentJob]);

  const resumeJob = useCallback(async () => {
    if (!state.currentJob) return;
    try {
      await fetch(`/api/media/jobs/${state.currentJob.id}/resume`, { method: 'POST' });
      setState(prev => ({
        ...prev,
        currentJob: prev.currentJob ? { ...prev.currentJob, status: 'running' } : null,
      }));
      connectProgressSSE(state.currentJob.id);
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to resume',
      }));
    }
  }, [state.currentJob, connectProgressSSE]);

  const cancelJob = useCallback(async () => {
    if (!state.currentJob) return;
    try {
      await fetch(`/api/media/jobs/${state.currentJob.id}/cancel`, { method: 'POST' });
      if (progressSourceRef.current) {
        progressSourceRef.current.close();
        progressSourceRef.current = null;
      }
      setState(prev => ({
        ...prev,
        phase: 'completed',
        currentJob: prev.currentJob ? { ...prev.currentJob, status: 'cancelled' } : null,
      }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to cancel',
      }));
    }
  }, [state.currentJob]);

  const retryFailed = useCallback(async () => {
    if (!state.currentJob) return;
    // Resume the job — the executor will pick up failed items that haven't exhausted retries
    try {
      await fetch(`/api/media/jobs/${state.currentJob.id}/resume`, { method: 'POST' });
      setState(prev => ({
        ...prev,
        phase: 'executing',
        currentJob: prev.currentJob ? { ...prev.currentJob, status: 'running' } : null,
      }));
      connectProgressSSE(state.currentJob.id);
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to retry',
      }));
    }
  }, [state.currentJob, connectProgressSSE]);

  const syncToLlm = useCallback(async (syncMode: 'manual' | 'auto_batch' = 'manual') => {
    if (!state.currentJob) return;

    setState(prev => ({ ...prev, phase: 'syncing', error: null }));

    try {
      const res = await fetch(`/api/media/jobs/${state.currentJob.id}/sync-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncMode }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Sync failed' }));
        throw new Error(err.error);
      }

      setState(prev => ({
        ...prev,
        phase: 'idle',
        enabled: false,
      }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        phase: 'completed',
        error: err instanceof Error ? err.message : 'Sync failed',
      }));
    }
  }, [state.currentJob]);

  const resetJob = useCallback(() => {
    if (progressSourceRef.current) {
      progressSourceRef.current.close();
      progressSourceRef.current = null;
    }
    setState(initialState);
  }, []);

  const injectPlanAndExecute = useCallback(async (plan: PlannerOutput, sessionId?: string) => {
    // Inject plan into state so the UI shows the reviewing phase
    setState(prev => ({
      ...prev,
      enabled: true,
      phase: 'reviewing',
      plannerOutput: plan,
      error: null,
    }));
  }, []);

  return {
    state,
    setEnabled,
    startPlanning,
    updatePlanItem,
    addPlanItem,
    removePlanItem,
    executeJob,
    pauseJob,
    resumeJob,
    cancelJob,
    retryFailed,
    syncToLlm,
    resetJob,
    injectPlanAndExecute,
  };
}
