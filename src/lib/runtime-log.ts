/**
 * Runtime Log — ring buffer that intercepts console.error and console.warn.
 *
 * Uses globalThis pattern to survive HMR reloads in development.
 */

export interface LogEntry {
  level: 'error' | 'warn';
  message: string;
  timestamp: string;
}

const BUFFER_SIZE = 200;
const GLOBAL_KEY = '__codepilot_runtime_log__' as const;

interface RuntimeLogState {
  buffer: LogEntry[];
  installed: boolean;
  originalError: typeof console.error;
  originalWarn: typeof console.warn;
}

function getState(): RuntimeLogState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      buffer: [] as LogEntry[],
      installed: false,
      originalError: console.error,
      originalWarn: console.warn,
    };
  }
  return g[GLOBAL_KEY] as RuntimeLogState;
}

/**
 * Scrub embedded sensitive data from log message text.
 * Catches tokens/keys/URLs/paths that appear inline in free-form text.
 */
function scrubMessage(msg: string): string {
  return msg
    // API keys / tokens (sk-xxx, anthropic-xxx, key-xxx, Bearer xxx)
    .replace(/\b(sk-[a-zA-Z0-9_-]{8})[a-zA-Z0-9_-]+/g, '$1***')
    .replace(/\b(anthropic-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/g, '$1***')
    .replace(/\b(key-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/g, '$1***')
    .replace(/(Bearer\s+)[a-zA-Z0-9_.-]{12,}/gi, '$1***')
    // Generic long hex/base64 tokens (32+ chars)
    .replace(/\b[a-f0-9]{32,}\b/gi, (m) => m.slice(0, 8) + '***')
    // Home directory paths
    .replace(new RegExp(homeDirPattern, 'g'), '~');
}

// Pre-compute home dir regex pattern (escaped for use in regex)
const homeDirPattern = (typeof process !== 'undefined' && process.env?.HOME)
  ? process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  : '/Users/[^/\\s]+';

function pushEntry(level: 'error' | 'warn', args: unknown[]): void {
  const state = getState();
  const raw = args
    .map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');

  const message = scrubMessage(raw);

  state.buffer.push({
    level,
    message: message.slice(0, 2000), // cap individual entry length
    timestamp: new Date().toISOString(),
  });

  // Ring buffer: trim from the front when over capacity
  if (state.buffer.length > BUFFER_SIZE) {
    state.buffer.splice(0, state.buffer.length - BUFFER_SIZE);
  }
}

/**
 * Install console.error and console.warn intercepts.
 * Safe to call multiple times — only installs once per globalThis lifetime.
 */
export function initRuntimeLog(): void {
  const state = getState();
  if (state.installed) return;

  console.error = (...args: unknown[]) => {
    pushEntry('error', args);
    state.originalError.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    pushEntry('warn', args);
    state.originalWarn.apply(console, args);
  };

  state.installed = true;
}

/**
 * Return buffered log entries (oldest first).
 */
export function getRecentLogs(): LogEntry[] {
  return [...getState().buffer];
}

/**
 * Clear all buffered entries.
 */
export function clearLogs(): void {
  getState().buffer.length = 0;
}
