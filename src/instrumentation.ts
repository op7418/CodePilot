/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Used to initialize runtime log capture for the Doctor export feature.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initRuntimeLog } = await import('@/lib/runtime-log');
    initRuntimeLog();

    // Start the task scheduler so persisted tasks resume on cold boot
    // (previously only started as a side effect of /api/chat)
    const { ensureSchedulerRunning } = await import('@/lib/task-scheduler');
    ensureSchedulerRunning();
  }
}
