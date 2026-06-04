// Sentry must be initialized before all other imports to catch early crashes
import * as Sentry from '@sentry/electron/main';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Check opt-out before init — reads a marker file that the renderer writes
const sentryOptOutPath = join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.codepilot',
  'sentry-disabled',
);
const sentryDisabled = existsSync(sentryOptOutPath) &&
  readFileSync(sentryOptOutPath, 'utf-8').trim() === 'true';

if (!sentryDisabled) {
  Sentry.init({
    dsn: 'https://245dc3525425bcd8eb99dd4b9a2ca5cd@o4511161899548672.ingest.us.sentry.io/4511161904791552',
  });
}

import { app, BrowserWindow, Notification, nativeImage, dialog, session, utilityProcess, ipcMain, shell, Tray, Menu } from 'electron';
import path from 'path';
import { execFileSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import { TerminalManager } from './terminal-manager';
import { sanitizeLogLine } from './log-sanitize';
import { getTrayMenuLabels } from '../src/lib/tray-menu-labels';

/**
 * Return a copy of process.env without __NEXT_PRIVATE_* variables.
 *
 * The bundled Next.js standalone server sets these at runtime
 * (e.g. __NEXT_PRIVATE_STANDALONE_CONFIG, __NEXT_PRIVATE_ORIGIN).
 * If they leak into child-process environments they cause every
 * other Next.js project on the machine to skip its own config
 * loading, breaking builds and dev servers.
 */
function _sanitizedProcessEnv: Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('__NEXT_PRIVATE_') && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

// Cached once at module load — process.env doesn't change during the
// Electron main process lifetime, so iterating it on every call is waste.
const _sanitizedProcessEnv = _sanitizedProcessEnv;

let mainWindow: BrowserWindow | null = null;
let serverProcess: Electron.UtilityProcess | null = null;
let serverPort: number | null = null;
let serverErrors: string[] = [];
const MAX_SERVER_ERRORS = 500;

function pushServerError(msg: string): void {
  if (serverErrors.length >= MAX_SERVER_ERRORS) {
    serverErrors.shift();
  }
  serverErrors.push(msg);
}
let serverExited = false;
let serverExitCode: number | null = null;
let userShellEnv: Record<string, string> = {};
let resolvedProxyEnv: Record<string, string> = {};
let isQuitting = false;
let tray: Tray | null = null;
let bgNotifyTimer: ReturnType<typeof setInterval> | null = null;

// --- Install orchestrator ---
interface InstallStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  error?: string;
}

interface InstallState {
  status: 'idle' | 'running' | 'success' | 'failed' | 'cancelled';
  currentStep: string | null;
  steps: InstallStep[];
  logs: string[];
}

const MAX_INSTALL_LOGS = 1000;
let installState: InstallState = {
  status: 'idle',
  currentStep: null,
  steps: [],
  logs: [],
};

function pushInstallLog(msg: string): void {
  if (installState.logs.length >= MAX_INSTALL_LOGS) {
    installState.logs.shift();
  }
  installState.logs.push(msg);
}

let installProcess: ChildProcess | null = null;

const terminalManager = new TerminalManager();

const isDev = !app.isPackaged;

/**
 * Gracefully shut down the server process.
 * Sends kill() (SIGTERM) first, waits up to 3s for exit,
 * then force-kills via process.kill(pid, SIGKILL) as fallback.
 */
function killServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve();
      return;
    }

    const pid = serverProcess.pid;

    const timeout = setTimeout(() => {
      // Force kill — on Windows use taskkill to kill the entire process tree
      if (pid) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
          } else {
            process.kill(pid, 'SIGKILL');
          }
        } catch { /* already dead */ }
      }
      serverProcess = null;
      resolve();
    }, 3000);

    serverProcess.on('exit', () => {
      clearTimeout(timeout);
      serverProcess = null;
      resolve();
    });

    // On Windows, SIGTERM is not supported — use taskkill to kill the tree
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      serverProcess.kill();
    }
  });
}

/**
 * Check if the remote bridge is currently active by querying the local API.
 */
async function isBridgeActive(): Promise<boolean> {
  if (!serverPort) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require('http');
    return await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${serverPort}/api/bridge`, (res: { statusCode?: number; on: (event: string, cb: (data?: Buffer) => void) => void }) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.running === true);
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

/**
 * Stop the remote bridge by posting to the local API.
 */
async function stopBridge(): Promise<void> {
  if (!serverPort) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require('http');
    await new Promise<void>((resolve) => {
      const postData = JSON.stringify({ action: 'stop' });
      const req = http.request({
        hostname: '127.0.0.1',
        port: serverPort,
        path: '/api/bridge',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, () => { resolve(); });
      req.on('error', () => resolve());
      req.setTimeout(3000, () => { req.destroy(); resolve(); });
      req.write(postData);
      req.end();
    });
  } catch {
    // ignore — bridge may already be stopped
  }
}

/**
 * URL to load when re-creating a destroyed main window. P2 review fix
 * (2026-05-09): this used to be `\`http://127.0.0.1:${serverPort || 3000}\``,
 * but the production server binds to a stable range of 47823–47830, never
 * 3000. If the tray "Open CodePilot" or `activate` (dock click) fires
 * before `serverPort` is set — possible now that the tray is created
 * BEFORE `await startServerOnStablePort()` resolves — the old fallback
 * would open a window pointing at the wrong port and dead-end.
 *
 * Behavior:
 *   - serverPort known → return the real URL.
 *   - serverPort unknown → return undefined so `createWindow()` paints
 *     the inline LOADING_HTML splash. The startup flow's
 *     `mainWindow.loadURL(realUrl)` runs once `startServerOnStablePort()`
 *     resolves and replaces the splash with the actual page on whichever
 *     `mainWindow` is current at that moment.
 *
 * Dev path is exempt — `serverPort` is set immediately at boot from
 * `process.env.PORT` (or 3000 default), well before any tray click could
 * fire, so this helper safely returns the dev URL there too.
 */
function chatWindowUrlForRevival(): string | undefined {
  if (serverPort == null) return undefined;
  return `http://127.0.0.1:${serverPort}`;
}

/**
 * Show / focus the main window. Re-creates it if the user previously hit
 * Cmd+Q during a hidden state and it was destroyed; otherwise just unhides
 * an existing hidden window. Called from tray menu, tray double-click and
 * notification clicks.
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(chatWindowUrlForRevival());
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * Quit the app explicitly — the only path that bypasses the close-to-hide
 * interceptor. Triggered by the tray "Quit CodePilot" menu item.
 */
function quitApp(): void {
  isQuitting = true;
  app.quit();
}

/**
 * Build / rebuild the tray context menu using OS-locale-derived labels.
 * Kept as a separate function so locale changes (rare) or future menu
 * items don't require recreating the Tray instance.
 */
function rebuildTrayMenu(): void {
  if (!tray) return;
  const locale = (() => {
    try { return app.getLocale(); } catch { return 'en'; }
  })();
  const labels = getTrayMenuLabels(locale);
  tray.setToolTip(labels.tooltip);
  const contextMenu = Menu.buildFromTemplate([
    { label: labels.open, click: () => showMainWindow() },
    { type: 'separator' },
    { label: labels.quit, click: () => quitApp() },
  ]);
  tray.setContextMenu(contextMenu);
}

/**
 * Create the menubar / tray icon. Called once at app startup so the icon is
 * present whether the main window is visible, hidden, or destroyed. Bridge
 * state is no longer relevant — local macOS notifications and the scheduler
 * keep running as long as the app is alive, with or without the bridge.
 */
function ensureTray(): void {
  if (tray) return;

  let trayIcon: Electron.NativeImage;
  if (process.platform === 'darwin') {
    // macOS menubar: dedicated monochrome TEMPLATE image (auto-loads @2x),
    // marked as a template so macOS tints it for light/dark menubars. Do NOT
    // resize — the asset is already 16x16 / 32x32. Fall back to the colored
    // app icon only if the template asset is missing (e.g. not packaged), so
    // we never end up with an invisible menubar icon.
    trayIcon = nativeImage.createFromPath(getTrayIconPath());
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
    } else {
      trayIcon.setTemplateImage(true);
    }
  } else {
    // Windows / Linux: keep the full-color app icon resized to tray size.
    trayIcon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
  }
  tray = new Tray(trayIcon);
  rebuildTrayMenu();

  // Platform conventions:
  // - macOS: single click on a menubar icon already pops the context menu
  //   (via setContextMenu); attaching a `click` handler too would
  //   simultaneously yank the main window forward, contradicting the
  //   "menubar-resident, click to see menu" affordance the user expects.
  //   So single-click is intentionally NOT bound on darwin; double-click
  //   is the explicit "open window" gesture.
  // - Windows / Linux: tray icons normally open the primary window on
  //   single click and the context menu on right-click. Bind both so the
  //   menu is reachable either way.
  if (process.platform !== 'darwin') {
    tray.on('click', () => showMainWindow());
  }
  tray.on('double-click', () => showMainWindow());
}

function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  stopBgNotifyPoll();
}

/**
 * Parse notification API response. Canonical version: src/lib/bg-notify-parser.ts
 *
 * Phase 3 Step 3: surfaces `event_id` / `task_id` / `session_id` so the
 * bg-poller can ack delivery and route clicks. We tolerate missing
 * fields (older payloads / external sources) by keeping them optional.
 */
interface BgNotificationPayload {
  title: string;
  body: string;
  priority: string;
  event_id?: string;
  task_id?: string;
  session_id?: string;
}

function parseBgNotifications(json: string): BgNotificationPayload[] {
  try {
    const parsed = JSON.parse(json);
    const notifications: BgNotificationPayload[] = parsed.notifications || [];
    return notifications.filter((n: { title: string }) => n.title);
  } catch {
    return [];
  }
}

/**
 * Phase 3 Step 3 — ack a delivery row from the Electron main process.
 * Used by the bg-poller after `notification.show()` succeeds.
 *
 * Best effort: if the server is unreachable or the ack fails, we just
 * log; the user-visible notification has already fired, the worst case
 * is the delivery row stays `queued` (which the UI represents
 * honestly as "shown, ack pending" — see v3 plan ack-loss path).
 */
function ackDelivery(
  port: number,
  payload: { event_id: string; channel: string; status: 'delivered' | 'error'; error?: string },
): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http');
  const body = JSON.stringify(payload);
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/tasks/notify/ack',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    () => { /* ignore response */ },
  );
  req.on('error', () => { /* best effort */ });
  req.setTimeout(2000, () => { req.destroy(); });
  req.write(body);
  req.end();
}

/**
 * Background notification poller — runs in the main process whenever the
 * main window is hidden or destroyed, so local macOS notifications continue
 * working even after the user closes the window into the menubar. When the
 * window is visible the renderer's `useNotificationPoll` hook handles the
 * same queue, so we self-stop to avoid duplicate delivery.
 *
 * This is intentionally bridge-independent: bridges (Telegram / 飞书 / QQ /
 * Discord) are optional remote channels. Local notifications must work with
 * just CodePilot menubar-resident, no bridge configured.
 */
function startBgNotifyPoll(): void {
  if (bgNotifyTimer) return;

  bgNotifyTimer = setInterval(async () => {
    // Stop polling whenever the renderer is on screen — it will drain the
    // queue itself via useNotificationPoll. We check `isVisible()` instead
    // of "window count" because in the new menubar-resident model the main
    // window stays alive (just hidden) when the user clicks close.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      stopBgNotifyPoll();
      return;
    }

    // Re-read the port each tick. In prod the loading window is created
    // BEFORE startServerOnStablePort() resolves; if the user closes that
    // loading window during boot, `hide` fires and startBgNotifyPoll()
    // runs while serverPort is still null. Caching `serverPort || 3000`
    // at start would then pin the poller to 3000 forever, even after the
    // real port lands. Skipping the tick keeps the timer armed; it'll
    // succeed on the next 5s wakeup once the server is ready.
    const port = serverPort;
    if (!port) return;

    try {
      const http = await import('http');
      const data = await new Promise<string>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/tasks/notify`, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      const notifications = parseBgNotifications(data);
      for (const notif of notifications) {
        try {
          const notification = new Notification({
            title: notif.title,
            body: notif.body || '',
          });
          // #34 observability — bg (window-hidden) show path. supported=false
          // OR no banner despite supported=true ⇒ macOS notification permission
          // for this app (esp. an unsigned dev Electron binary) is the suspect.
          console.log(`[notify] bg-poller OS notification: supported=${Notification.isSupported()} title=${JSON.stringify(notif.title)}`);
          // Phase 3 Step 3: click → re-open window AND forward payload
          // to renderer so it can route to /settings/tasks?focus=<id>
          // (or the relevant chat session). The IPC channel is the
          // same one notification:show uses for in-renderer display.
          notification.on('click', () => {
            showMainWindow();
            if (notif.task_id || notif.session_id) {
              mainWindow?.webContents.send('notification:click', {
                taskId: notif.task_id,
                sessionId: notif.session_id,
                event_id: notif.event_id,
              });
            }
          });
          notification.show();
          // v6 fix (P1): unify on `electron-native`. `sendNotification`
          // pre-writes a `electron-native` row in queued state when
          // priority is normal/urgent; the bg-poller MUST ack THAT
          // row, not introduce a new `electron-bg-native` channel
          // that leaves the original queued forever. Whether the OS
          // notification was rendered by the bg-poller (window hidden)
          // or by the renderer's `useNotificationPoll` (window visible)
          // is the same surface from the user's POV — one row tracking
          // both is the honest representation.
          if (notif.event_id) {
            ackDelivery(port, {
              event_id: notif.event_id,
              channel: 'electron-native',
              status: 'delivered',
            });
            // The drain consumed the queue, so the renderer (when the
            // window returns visible) will NOT see this notification
            // again. Mark its `renderer-toast` candidate as skipped so
            // the UI can show "in-app toast: skipped (window hidden)"
            // instead of perpetual queued. UPSERT semantics make this
            // safe to call even if the row was already acked.
            ackDelivery(port, {
              event_id: notif.event_id,
              channel: 'renderer-toast',
              status: 'skipped',
              error: 'window hidden — bg-poller delivered native notification only',
            });
          }
        } catch (err) {
          if (notif.event_id) {
            ackDelivery(port, {
              event_id: notif.event_id,
              channel: 'electron-native',
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch {
      // Server may not be reachable — ignore
    }
  }, 5000);
}

function stopBgNotifyPoll(): void {
  if (bgNotifyTimer) {
    clearInterval(bgNotifyTimer);
    bgNotifyTimer = null;
  }
}

/**
 * Verify that better_sqlite3.node in standalone resources is compatible
 * with this Electron runtime's ABI. If it was built for a different
 * Node.js ABI (e.g. system Node v22 ABI 127 vs Electron's ABI 143),
 * show a clear error instead of a cryptic MODULE_NOT_FOUND crash.
 */
function checkNativeModuleABI(): void {
  if (isDev) return; // Skip in dev mode

  const standaloneDir = path.join(process.resourcesPath, 'standalone');

  // Find better_sqlite3.node recursively
  function findNodeFile(dir: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findNodeFile(fullPath);
        if (found) return found;
      } else if (entry.name === 'better_sqlite3.node') {
        return fullPath;
      }
    }
    return null;
  }

  const nodeFile = findNodeFile(path.join(standaloneDir, 'node_modules'));
  if (!nodeFile) {
    console.warn('[ABI check] better_sqlite3.node not found in standalone resources');
    return;
  }

  try {
    // Attempt to load the native module to verify ABI compatibility
    process.dlopen({ exports: {} } as NodeModule, nodeFile);
    console.log(`[ABI check] better_sqlite3.node ABI is compatible (${nodeFile})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('NODE_MODULE_VERSION')) {
      console.error(`[ABI check] ABI mismatch detected: ${msg}`);
      dialog.showErrorBox(
        'CodePilot - Native Module ABI Mismatch',
        `The bundled better-sqlite3 native module was compiled for a different Node.js version.\n\n` +
        `${msg}\n\n` +
        `This usually means the build process did not correctly recompile native modules for Electron.\n` +
        `Please rebuild the application or report this issue.`
      );
      app.quit();
    } else {
      // Other load errors (missing dependencies, etc.) -- log but don't block
      console.warn(`[ABI check] Could not verify better_sqlite3.node: ${msg}`);
    }
  }
}

/**
 * Read the user's full shell environment by running a login shell.
 * When Electron is launched from Dock/Finder (macOS) or desktop launcher
 * (Linux), process.env is very limited and won't include vars from
 * .zshrc/.bashrc (e.g. API keys, nvm PATH).
 */
function loadUserShellEnv(): Record<string, string> {
  // Windows GUI apps inherit the full user environment
  if (process.platform === 'win32') {
    return {};
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shell, ['-ilc', 'env'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const env: Record<string, string> = {};
    for (const line of result.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1);
        env[key] = value;
      }
    }
    console.log(`Loaded ${Object.keys(env).length} env vars from user shell`);
    return env;
  } catch (err) {
    console.warn('Failed to load user shell env:', err);
    return {};
  }
}

/**
 * Resolve system proxy via Chromium's proxy resolution.
 * Chinese users often use VPN tools (Clash, Surge, etc.) that set macOS system
 * proxy but don't export HTTP_PROXY to shell env. This detects the system proxy
 * and returns env vars to inject into child processes.
 */
async function resolveSystemProxy(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  try {
    const proxyList = await session.defaultSession.resolveProxy('https://registry.npmjs.org');
    if (!proxyList || proxyList === 'DIRECT') return env;

    // Chromium returns an ordered list: "PROXY host:port; SOCKS5 host:port; DIRECT"
    // Split on ';' and use the first non-DIRECT entry.
    for (const entry of proxyList.split(';')) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed === 'DIRECT') continue;

      const httpMatch = trimmed.match(/^(?:PROXY|HTTPS)\s+([\w.-]+:\d+)$/i);
      if (httpMatch) {
        env.HTTP_PROXY = `http://${httpMatch[1]}`;
        env.HTTPS_PROXY = `http://${httpMatch[1]}`;
        console.log('[proxy] System proxy detected:', env.HTTPS_PROXY);
        return env;
      }

      const socksMatch = trimmed.match(/^SOCKS5?\s+([\w.-]+:\d+)$/i);
      if (socksMatch) {
        env.HTTP_PROXY = `socks5://${socksMatch[1]}`;
        env.HTTPS_PROXY = `socks5://${socksMatch[1]}`;
        console.log('[proxy] System SOCKS proxy detected:', env.HTTPS_PROXY);
        return env;
      }
    }
  } catch (err) {
    console.warn('[proxy] Failed to resolve system proxy:', err);
  }
  return env;
}

/**
 * Check if Git Bash (bash.exe) is available on Windows.
 * Mirrors the detection logic in platform.ts:findGitBash().
 */
function findGitBashSync(): boolean {
  if (process.platform !== 'win32') return true;
  // 1. User-specified env var
  const envBash = process.env.CLAUDE_CODE_GIT_BASH_PATH || userShellEnv.CLAUDE_CODE_GIT_BASH_PATH;
  if (envBash && fs.existsSync(envBash)) return true;
  // 2. Common paths
  if (fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')) return true;
  if (fs.existsSync('C:\\Program Files (x86)\\Git\\bin\\bash.exe')) return true;
  // 3. Derive from `where git`
  try {
    const result = execFileSync('where', ['git'], {
      timeout: 3000, encoding: 'utf-8', shell: true, stdio: 'pipe',
    });
    for (const line of result.trim().split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      const bashPath = path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) return true;
    }
  } catch { /* where git failed */ }
  return false;
}

/**
 * Build an expanded PATH that includes common locations for node, npm globals,
 * claude, nvm, homebrew, etc. Shared by the server launcher and install orchestrator.
 */
function getExpandedShellPath(): string {
  const home = os.homedir();
  const shellPath = userShellEnv.PATH || process.env.PATH || '';
  const sep = path.delimiter;

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const winExtra = [
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'bin'),
    ];
    const allParts = [shellPath, ...winExtra].join(sep).split(sep).filter(Boolean);
    return [...new Set(allParts)].join(sep);
  } else {
    const basePath = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
    const raw = `${basePath}:${home}/.npm-global/bin:${home}/.local/bin:${home}/.claude/bin:${shellPath}`;
    const allParts = raw.split(':').filter(Boolean);
    return [...new Set(allParts)].join(':');
  }
}

/**
 * Try to bind a specific port. Resolves true if free, false if taken.
 * Both EADDRINUSE and other errors count as "not free" (we'll try the next).
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Stable port range for the embedded Next.js server.
 *
 * IMPORTANT: localStorage in the renderer is keyed by origin (scheme+host+port).
 * If we pick a random OS-assigned port (`listen(0)`) every launch, localStorage
 * is effectively wiped on every restart — which silently breaks the theme,
 * default model badge, last-selected provider, working-directory memory, and
 * any other UI state that uses localStorage. (See B-004 in issue tracker.)
 *
 * We try this range in order so the origin stays consistent across restarts.
 * Range chosen: 47823–47830 (8 ports). These are unassigned by IANA and
 * uncommon in practice. 8 candidates handles up to 8 concurrent CodePilot
 * instances before falling back to OS-assigned, which is plenty for normal use.
 */
const STABLE_PORTS = [47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830];

/** Allocate an OS-assigned port (last-resort fallback when all stable ports fail). */
async function getDynamicPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
  });
}

/**
 * Start the embedded server, choosing an available stable port.
 *
 * The previous implementation just probed `isPortFree` then returned the
 * port — a classic TOCTOU race when two packaged instances launch close
 * together (both observe 47823 free, the second one then loses with
 * EADDRINUSE and the app crashes). This function actually attempts to bind
 * each candidate via the real subprocess and advances to the next one if
 * the server fails to come up due to a port conflict.
 *
 * Returns the bound port. Sets the global `serverProcess` as a side effect.
 * Throws only if every candidate AND the OS-assigned fallback fail.
 */
async function startServerOnStablePort(): Promise<number> {
  for (const candidate of STABLE_PORTS) {
    // Quick pre-check skips obviously-occupied ports without spawning.
    // Not a guarantee — but cheap, and avoids a process spawn for the common
    // case where another app already owns 47823.
    if (!(await isPortFree(candidate))) {
      console.log(`[port] ${candidate} is in use, trying next stable port`);
      continue;
    }

    console.log(`[port] Attempting stable port ${candidate}...`);
    serverProcess = startServer(candidate);
    try {
      await waitForServer(candidate);
      console.log(`[port] Bound stable port ${candidate} — localStorage origin will be consistent across restarts`);
      return candidate;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPortConflict = /EADDRINUSE|address.+(?:already )?in use|listen EACCES/i.test(msg);
      console.warn(
        `[port] Port ${candidate} failed${isPortConflict ? ' (collided with another process)' : ''}: ${msg.slice(0, 200)}` +
        (isPortConflict ? ' — trying next stable port' : ''),
      );
      // Make sure the failed subprocess is dead before trying again — otherwise
      // we'd leak processes on each retry.
      try { serverProcess?.kill(); } catch { /* already gone */ }
      serverProcess = null;

      // Non-port errors (Next.js boot crash, missing file, etc.) won't be
      // fixed by switching ports, but we still try the rest because the cost
      // is small and a transient error on the first port shouldn't be fatal.
    }
  }

  // Every stable port failed — last resort: OS-assigned dynamic port.
  // localStorage will be lost on next restart, but at least the app boots.
  console.warn(
    `[port] All stable ports (${STABLE_PORTS[0]}-${STABLE_PORTS[STABLE_PORTS.length - 1]}) failed; ` +
    `falling back to OS-assigned port. UI settings stored in localStorage (theme, last model, etc.) ` +
    `may not persist across this restart.`,
  );
  const dynamicPort = await getDynamicPort();
  serverProcess = startServer(dynamicPort);
  await waitForServer(dynamicPort);
  return dynamicPort;
}

async function waitForServer(port: number, timeout = 30000): Promise<void> {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeout) {
    // If the server process already exited, fail fast
    if (serverExited) {
      throw new Error(
        `Server process exited with code ${serverExitCode}.\n\n${serverErrors.join('\n')}`
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require('http');
        // Use options object with family:4 to force IPv4 — avoids Windows
        // IPv6 resolution issues where 127.0.0.1 may fail to connect.
        const req = http.get({
          hostname: '127.0.0.1',
          port,
          path: '/api/health',
          family: 4,
          timeout: 2000,
        }, (res: { statusCode?: number }) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', (err: Error) => reject(err));
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('request timeout'));
        });
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error(
    `Server startup timeout after ${timeout / 1000}s.\n\nLast health-check error: ${lastError}\n\n${serverErrors.length > 0 ? 'Server output:\n' + serverErrors.slice(-10).join('\n') : 'No server output captured.'}`
  );
}

function startServer(port: number): Electron.UtilityProcess {
  const standaloneDir = path.join(process.resourcesPath, 'standalone');
  const serverPath = path.join(standaloneDir, 'server.js');

  console.log(`Server path: ${serverPath}`);
  console.log(`Standalone dir: ${standaloneDir}`);

  serverErrors = [];
  serverExited = false;
  serverExitCode = null;

  const home = os.homedir();
  const constructedPath = getExpandedShellPath();

  const env: Record<string, string> = {
    // Base: sanitized process env (strips __NEXT_PRIVATE_ vars)
    ..._sanitizedProcessEnv,
    // User shell env overrides process env (API keys, PATH, etc.)
    ...userShellEnv,
    // Inject system proxy (only if not already set in shell env)
    ...(!userShellEnv.HTTP_PROXY && !userShellEnv.HTTPS_PROXY ? resolvedProxyEnv : {}),
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    CLAUDE_GUI_DATA_DIR: path.join(home, '.codepilot'),
    HOME: home,
    USERPROFILE: home,
    PATH: constructedPath,
  };

  // Use Electron's utilityProcess to run the server in a child process
  // without spawning a separate Dock icon on macOS.
  const child = utilityProcess.fork(serverPath, [], {
    env,
    cwd: standaloneDir,
    stdio: 'pipe',
    serviceName: 'codepilot-server',
  });

  child.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    console.log(`[server] ${msg}`);
    pushServerError(msg);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    console.error(`[server:err] ${msg}`);
    pushServerError(msg);
  });

  child.on('exit', (code) => {
    console.log(`Server process exited with code ${code}`);
    serverExited = true;
    serverExitCode = code;
    serverProcess = null;
  });

  return child;
}

function getIconPath(): string {
  if (isDev) {
    return path.join(process.cwd(), 'build', 'icon.png');
  }
  if (process.platform === 'win32') {
    return path.join(process.resourcesPath, 'icon.ico');
  }
  if (process.platform === 'linux') {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(process.resourcesPath, 'icon.icns');
}

/**
 * macOS menubar Tray icon path — a DEDICATED monochrome template PNG
 * (`trayTemplate.png`, with a sibling `trayTemplate@2x.png` that
 * `nativeImage.createFromPath` auto-loads for retina), NOT the full-color
 * app icon. Resizing `icon.icns` for the menubar produced a blurry,
 * non-adapting blob and on some packaged builds no visible icon at all;
 * a template image renders crisply and follows the light/dark menubar.
 * Generated by scripts/gen-tray-icon.mjs. Dock/app icon stays on getIconPath().
 */
function getTrayIconPath(): string {
  return isDev
    ? path.join(process.cwd(), 'build', 'trayTemplate.png')
    : path.join(process.resourcesPath, 'trayTemplate.png');
}

/** Inline loading HTML shown while the server starts up */
const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0a0a; color: #a0a0a0;
    -webkit-app-region: drag;
  }
  .container { text-align: center; }
  .spinner {
    width: 28px; height: 28px; margin: 0 auto 14px;
    border: 2.5px solid rgba(255,255,255,0.1);
    border-top-color: rgba(255,255,255,0.5);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { font-size: 13px; opacity: 0.7; }
</style>
</head>
<body>
<div class="container">
  <div class="spinner"></div>
  <p>Starting CodePilot...</p>
</div>
</body>
</html>`)}`;

function createWindow(url?: string) {
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 600,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    // Phase 7c-E — shell padding-top reduced to 8 (sides + bottom
    // stay 16). Topbar h-10 → items center y = 8 + 20 = 28. Dot
    // cluster center should align with items center, so
    // trafficLightPosition.y = 28 - 7 = 21. The +7 offset is the
    // half-height of the macOS traffic-light cluster (~14px tall);
    // see Phase 7c plan D-3 — actual AppKit offset may be ±2px so
    // verify with Electron screenshot before finalizing.
    windowOptions.trafficLightPosition = { x: 20, y: 21 };
    // macOS material POC matrix — Codex round 3 (2026-05-23).
    // Reviewer asked for a real matrix, not single-flag guessing.
    // Env-driven so anyone can rerun a candidate without editing src:
    //
    //   ELECTRON_VIBRANCY=menu|sidebar|under-window|content|fullscreen-ui|off
    //   ELECTRON_TRANSPARENT=true|false                   (default: true)
    //
    // Defaults reflect what we know so far:
    //   - `'menu'` is what /Applications/Codex.app actually uses
    //     as its primary window material (verified in app.asar).
    //   - `transparent: true` makes Electron honor an alpha-0
    //     backgroundColor on macOS — required for `vibrancy` to
    //     surface unless we go the davidcann route of native
    //     NSVisualEffectView injection.
    //
    // `off` is the explicit no-vibrancy variant so the matrix can
    // include an opaque baseline. Electron's setter accepts `null`
    // to clear vibrancy.
    const VIBRANCY_CANDIDATES = new Set([
      'menu', 'sidebar', 'under-window', 'content', 'fullscreen-ui',
      'titlebar', 'selection', 'popover', 'header', 'sheet', 'window',
      'hud', 'tooltip', 'under-page',
    ]);
    const envVibrancy = process.env.ELECTRON_VIBRANCY;
    const vibrancyChoice = envVibrancy && (VIBRANCY_CANDIDATES.has(envVibrancy) || envVibrancy === 'off')
      ? envVibrancy
      : 'menu';
    const envTransparent = process.env.ELECTRON_TRANSPARENT;
    const transparentChoice = envTransparent === 'false' ? false : true;

    if (vibrancyChoice !== 'off') {
      windowOptions.vibrancy = vibrancyChoice as Electron.BrowserWindowConstructorOptions['vibrancy'];
    }
    // CRITICAL: use `#00ffffff` not `#00000000`. Electron's macOS
    // color parser has a long-standing bug where rgb=0 alpha=0 is
    // treated as opaque white (issue #20357). `#00ffffff` (white
    // rgb, alpha=0) is the documented workaround that actually
    // produces a transparent backing layer.
    windowOptions.backgroundColor = '#00ffffff';
    windowOptions.transparent = transparentChoice;
    windowOptions.visualEffectState = 'followWindow';

    console.log('[macos-vibrancy-poc] window options:', {
      vibrancy: vibrancyChoice,
      transparent: transparentChoice,
      // Mirror the actual value set above. Previously hardcoded as
      // '#00000000' which misleadingly suggested we'd hit Electron's
      // parser bug; the real value is '#00ffffff' (the documented
      // workaround for issue #20357).
      backgroundColor: windowOptions.backgroundColor,
      titleBarStyle: 'hiddenInset',
      hint: 'override via ELECTRON_VIBRANCY / ELECTRON_TRANSPARENT env vars',
    });
  } else if (process.platform === 'win32') {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.titleBarOverlay = {
      color: '#00000000',
      symbolColor: '#888888',
      height: 44,
    };
  }

  mainWindow = new BrowserWindow(windowOptions);

  // External links: open in system default browser instead of Electron
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      shell.openExternal(targetUrl);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    // Allow navigating within the app (localhost dev server)
    const appOrigin = new URL(mainWindow!.webContents.getURL()).origin;
    if (new URL(targetUrl).origin !== appOrigin) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  mainWindow.loadURL(url || LOADING_HTML);

  // Codex round 3 + Electron issue #20357 fix — re-apply
  // setBackgroundColor / setVibrancy AFTER loadURL. loadURL resets
  // the chromium compositor's backing colour to opaque (this is
  // why "constructor option only" repros white window after every
  // navigation). Re-calling here on macOS reattaches the
  // NSVisualEffectView. We mirror Codex.app's belt-and-braces
  // pattern (constructor options + runtime setters).
  if (process.platform === 'darwin') {
    try {
      mainWindow.setBackgroundColor('#00ffffff');
      const v = windowOptions.vibrancy;
      if (v) {
        mainWindow.setVibrancy(v);
      } else {
        mainWindow.setVibrancy(null);
      }
    } catch (err) {
      console.warn('[macos-vibrancy-poc] runtime setBackgroundColor/setVibrancy failed:', err);
    }
  }

  if (isDev) {
    // CRITICAL: docked DevTools force the window to render with an
    // opaque white background regardless of transparent/vibrancy
    // settings (Electron issue #20357 comment). Always open in a
    // detached panel so the main window can still surface vibrancy.
    mainWindow.webContents.openDevTools({ mode: 'undocked' });

    // macOS material POC diagnostic — Phase 7b Phase 2 round 3.
    // Print platform / token / surface state to the MAIN process
    // console (visible in the same terminal that ran electron:dev)
    // 1.5 s after the renderer finishes loading. Keeps the loop
    // tight: change a vibrancy or CSS value, restart Electron,
    // read the diagnostic line, no DevTools needed.
    //
    // Logged keys:
    //   - dataPlatform / dataPlatformStyle: <html> attrs from
    //     anti-FOUC inline script — proves the cascade can see them
    //   - electronApiPlatform: process.platform forwarded through
    //     preload contextBridge — proves the bridge works
    //   - bodyBg / chatListBg / topbarBg: computed background-color
    //     on each candidate chrome surface — should read 'rgba(0,0,0,0)'
    //     on macOS profile when vibrancy is meant to surface
    //   - surfaceSidebarToken / surfaceBarToken: resolved CSS var
    //     values on the root — should be `transparent` under the
    //     darwin profile, `color-mix(...)` elsewhere
    //   - vibrancyOption / transparentOption / backgroundColorOption:
    //     the actual NSWindow-side options we set above
    if (process.platform === 'darwin') {
      mainWindow.webContents.on('did-finish-load', () => {
        // 4 s — give Next dev time to mount lazy ChatListPanel /
        // WorkspaceSidebar / topbar tree. The walker below is
        // expensive on the renderer for a single fire; we don't run
        // it on a timer.
        setTimeout(() => {
          mainWindow?.webContents
            .executeJavaScript(`(() => {
              const html = document.documentElement;
              const cs = getComputedStyle(html);
              // Walk every visible element, list the ones with an
              // opaque background. ANY opaque ancestor inside
              // <body> covers the NSVisualEffectView. The earlier
              // diag only checked five named surfaces — that's not
              // enough; if even one wrapper (#__next, an error
              // boundary, a portal root, ThemeProvider div) is
              // opaque, vibrancy never surfaces.
              const opaqueOffenders = [];
              const all = document.querySelectorAll('*');
              for (const el of all) {
                const s = getComputedStyle(el);
                const bg = s.backgroundColor;
                if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
                // Treat anything with non-zero alpha as opaque enough
                // to block the material underneath.
                const m = bg.match(/rgba?\\(([^)]+)\\)/);
                if (!m) continue;
                const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
                const alpha = parts.length === 4 ? parts[3] : 1;
                if (alpha < 0.05) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 10 || rect.height < 10) continue;
                opaqueOffenders.push({
                  tag: el.tagName.toLowerCase(),
                  // Truncate so the log stays readable
                  cls: (el.className?.toString() || '').slice(0, 120),
                  id: el.id || null,
                  bg,
                  w: Math.round(rect.width),
                  h: Math.round(rect.height),
                });
              }
              // Cap to top 30 by area so we don't flood the log
              opaqueOffenders.sort((a, b) => (b.w * b.h) - (a.w * a.h));
              return {
                dataPlatform: html.getAttribute('data-platform'),
                dataShell: html.getAttribute('data-shell'),
                dataPlatformStyle: html.getAttribute('data-platform-style'),
                electronApiPlatform: window.electronAPI?.versions?.platform ?? null,
                htmlBg: cs.backgroundColor,
                bodyBg: getComputedStyle(document.body).backgroundColor,
                surfaceSidebarToken: cs.getPropertyValue('--platform-surface-sidebar').trim(),
                surfaceBarToken: cs.getPropertyValue('--platform-surface-bar').trim(),
                opaqueElementCount: opaqueOffenders.length,
                top30OpaqueOffenders: opaqueOffenders.slice(0, 30),
              };
            })()`)
            .then((r) => {
              console.log('[macos-vibrancy-diag] renderer state:', JSON.stringify(r, null, 2));
              console.log('[macos-vibrancy-diag] window options:', JSON.stringify({
                vibrancyOption: windowOptions.vibrancy,
                transparentOption: windowOptions.transparent,
                backgroundColorOption: windowOptions.backgroundColor,
                visualEffectStateOption: windowOptions.visualEffectState,
                titleBarStyle: windowOptions.titleBarStyle,
              }, null, 2));
            })
            .catch((err) => {
              console.warn('[macos-vibrancy-diag] failed:', err?.message ?? err);
            });
        }, 4000);
      });
    }
  }

  // Menubar-resident behavior: clicking close hides the window instead of
  // quitting the app. Only `isQuitting` (set by the tray "Quit CodePilot"
  // menu item or by `before-quit`) lets the close go through to a real
  // teardown. The scheduler and local notifications keep running while
  // hidden — see startBgNotifyPoll().
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  // When the window goes hidden, hand off notification polling to the main
  // process (the renderer's useNotificationPoll may be throttled by Chromium
  // background heuristics on hidden BrowserWindows). When it returns visible,
  // the renderer takes over and the main-process poller self-stops.
  mainWindow.on('hide', () => { startBgNotifyPoll(); });
  mainWindow.on('show', () => { stopBgNotifyPoll(); });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Phase 2C.6 + follow-ups: persistent log file for the main process.
 * `app.getPath('logs')` resolves to `~/Library/Logs/{appName}` on macOS,
 * `%APPDATA%\{appName}\logs` on Windows, `~/.config/{appName}/logs` on
 * Linux. Electron creates the dir lazily; we capture console.log /
 * console.warn / console.error output, run each line through
 * `sanitizeLogLine`, and append to a file in that dir so users can
 * grab it when filing an issue. About → "打开日志文件夹" opens the
 * directory (not a specific file) so all of the below are visible.
 *
 * Three filenames live in the directory:
 *   - `codepilot-main.log`
 *       Canonical, fully-sanitized log. About promises this is the
 *       safe-to-share file. Used as the active stream when rotation
 *       has either already completed (marker present) or completes
 *       successfully this run.
 *   - `codepilot-main.unsanitized-legacy.log`
 *       Pre-sanitizer raw history rotated out on first activation.
 *       Kept for forensic / archive purposes; never appended to once
 *       rotation completes. Users can delete it manually.
 *   - `codepilot-main-sanitized.log`
 *       Per-session fallback used when rotation FAILS this run (FS
 *       readonly, permission denied, etc). The canonical filename
 *       still contains pre-sanitizer content in that case, so we
 *       open the stream on this parallel file instead — the user's
 *       "已脱敏" promise stays honest. Once a future launch rotates
 *       successfully, writes go back to canonical and this file is
 *       no longer used (left in place for the user to clean up or
 *       attach as needed).
 *
 * Rotation marker — `.codepilot-sanitized` — pins the migration as
 * a one-shot. Written ONLY when rotation completed (or no rotation
 * was needed). On rotation failure the marker is intentionally NOT
 * written, so the next launch retries from scratch.
 *
 * No size-based rotation: the file is bounded by user session length
 * + how often they restart, not by retention. Add log4js-style
 * rotation later if real-world files grow uncomfortably large.
 */
function setupPersistentMainLog() {
  try {
    const logsDir = app.getPath('logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'codepilot-main.log');
    const sanitizedMarker = path.join(logsDir, '.codepilot-sanitized');
    const legacyFile = path.join(logsDir, 'codepilot-main.unsanitized-legacy.log');

    // One-time rotation. Pre-sanitizer builds appended raw lines to
    // `codepilot-main.log`. Now that About promotes the file as the
    // headline support entry and tells users it's auto-scrubbed, we
    // must not point that promise at a file with mixed history.
    // First time the sanitizer runs in a given logs dir, rename the
    // existing live file to `.unsanitized-legacy.log` and start a
    // fresh, fully-sanitized `codepilot-main.log`. The marker file
    // pins this as a one-shot — subsequent starts skip rotation.
    //
    // **Marker is only written on success.** If rename / append /
    // unlink fails (permission denied, readonly FS), do NOT write
    // the marker — next launch will retry. Writing the marker after
    // a failed rotation would permanently strand the live file in a
    // mixed-content state while About's "已脱敏" copy still points
    // at it.
    const liveFileExisted = fs.existsSync(logFile);
    const markerExisted = fs.existsSync(sanitizedMarker);
    // Rotation is "completed" when there's nothing to rotate (fresh
    // install) or a previous run already wrote the marker. Otherwise
    // it stays false until the rename / append succeeds *this* run.
    let rotationCompleted = !liveFileExisted || markerExisted;

    if (liveFileExisted && !markerExisted) {
      try {
        if (fs.existsSync(legacyFile)) {
          // Defensive: legacy file already exists from some earlier
          // partial rotation. Append the suspect content to it then
          // unlink the live file so we still start clean.
          const buf = fs.readFileSync(logFile);
          fs.appendFileSync(legacyFile, buf);
          fs.unlinkSync(logFile);
        } else {
          fs.renameSync(logFile, legacyFile);
        }
        rotationCompleted = true;
      } catch {
        // Rotation failed. Skip marker write; next launch retries.
      }
    }

    if (rotationCompleted && !markerExisted) {
      try {
        fs.writeFileSync(
          sanitizedMarker,
          `Sanitizer activated at ${new Date().toISOString()}.\n` +
          (liveFileExisted
            ? `Pre-sanitizer log content rotated to ${legacyFile}.\n`
            : `Started with no prior log file.\n`),
        );
      } catch { /* marker write failures are tolerable */ }
    }

    // Decide where THIS session writes. If rotation failed this run
    // the live `codepilot-main.log` may still contain pre-sanitizer
    // raw lines; appending sanitized output to it would produce a
    // mixed file that contradicts About's "已脱敏" promise. Switch
    // to a parallel `codepilot-main-sanitized.log` instead — the
    // user opens the folder via About and sees both files (the old
    // mixed one + the new clean one). Once a future launch
    // successfully rotates, this fallback is no longer needed and
    // writes go back to the canonical filename.
    const sanitizedFallbackFile = path.join(logsDir, 'codepilot-main-sanitized.log');
    const activeLogFile = rotationCompleted ? logFile : sanitizedFallbackFile;

    const stream = fs.createWriteStream(activeLogFile, { flags: 'a' });
    const sessionMarker = rotationCompleted
      ? `\n=== session start ${new Date().toISOString()} (sanitized) ===\n`
      : `\n=== session start ${new Date().toISOString()} (sanitized — fallback file; rotation pending) ===\n`;
    stream.write(sessionMarker);

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    const fmt = (level: string, args: unknown[]): string => {
      const ts = new Date().toISOString();
      const msg = args
        .map((a) => {
          if (typeof a === 'string') return a;
          if (a instanceof Error) return a.stack || a.message;
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(' ');
      // Phase 2C.6 follow-up: scrub before append. About promotes
      // this file as the primary support entry, so leaking a key /
      // bearer token / home path here would be a credential leak
      // channel. Stdout (terminal output the dev sees) stays raw —
      // only the on-disk copy that the user might attach to an
      // issue gets sanitized.
      const sanitized = sanitizeLogLine(msg);
      return `${ts} [${level}] ${sanitized}\n`;
    };

    console.log = (...args: unknown[]) => { stream.write(fmt('log', args)); origLog(...args); };
    console.warn = (...args: unknown[]) => { stream.write(fmt('warn', args)); origWarn(...args); };
    console.error = (...args: unknown[]) => { stream.write(fmt('error', args)); origError(...args); };
  } catch (err) {
    // Logging is best-effort — don't block app startup if disk is full / readonly.

    console.warn('Failed to set up persistent main log:', err);
  }
}

app.whenReady().then(async () => {
  // Set up persistent main-process log first so subsequent startup
  // logs (env load, ABI check, server boot) are captured.
  setupPersistentMainLog();

  // Load user's full shell environment (API keys, PATH, etc.)
  userShellEnv = loadUserShellEnv();

  // Detect system proxy for Chinese users behind VPN (Clash, Surge, etc.)
  resolvedProxyEnv = await resolveSystemProxy();

  // Verify native module ABI compatibility before starting the server
  checkNativeModuleABI();

  // Clear cache on version upgrade
  const currentVersion = app.getVersion();
  const versionFilePath = path.join(app.getPath('userData'), 'last-version.txt');
  try {
    const lastVersion = fs.existsSync(versionFilePath)
      ? fs.readFileSync(versionFilePath, 'utf-8').trim()
      : '';
    if (lastVersion && lastVersion !== currentVersion) {
      console.log(`Version changed from ${lastVersion} to ${currentVersion}, clearing cache...`);
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({
        storages: ['cachestorage', 'serviceworkers'],
      });
      console.log('Cache cleared successfully');
    }
    fs.writeFileSync(versionFilePath, currentVersion, 'utf-8');
  } catch (err) {
    console.warn('Failed to check/clear version cache:', err);
  }

  // Set macOS Dock icon
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getIconPath();
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // --- Install wizard IPC handlers ---

  ipcMain.handle('install:check-prerequisites', async () => {
    const expandedPath = getExpandedShellPath();
    const execEnv = { ..._sanitizedProcessEnv, ...userShellEnv, PATH: expandedPath };

    // Candidate paths — native first, then bun, then homebrew, then npm
    const home = os.homedir();
    const candidatePaths = process.platform === 'win32'
      ? [
          path.join(home, '.local', 'bin', 'claude.exe'),
          path.join(home, '.local', 'bin', 'claude.cmd'),
          path.join(home, '.claude', 'bin', 'claude.exe'),
          path.join(home, '.claude', 'bin', 'claude.cmd'),
          path.join(home, '.bun', 'bin', 'claude.exe'),
          path.join(home, '.bun', 'bin', 'claude.cmd'),
          path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
          path.join(process.env.LOCALAPPDATA || '', 'npm', 'claude.cmd'),
        ].filter(p => p && !p.startsWith(path.sep))
      : [
          path.join(home, '.local', 'bin', 'claude'),
          path.join(home, '.claude', 'bin', 'claude'),
          path.join(home, '.bun', 'bin', 'claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          path.join(home, '.npm-global', 'bin', 'claude'),
        ];

    function classifyPath(p: string): 'native' | 'homebrew' | 'npm' | 'bun' | 'unknown' {
      const n = p.replace(/\\/g, '/');
      if (n.includes('/.local/bin/') || n.includes('/.claude/bin/')) return 'native';
      if (n.includes('/.bun/bin/') || n.includes('/.bun/install/')) return 'bun';
      if (n.includes('/homebrew/') || n.includes('/Cellar/')) return 'homebrew';
      if (n.includes('/npm')) return 'npm';
      if (n === '/usr/local/bin/claude') {
        try {
          const real = fs.realpathSync(p);
          if (real.includes('node_modules')) return 'npm';
          if (real.includes('homebrew') || real.includes('Cellar')) return 'homebrew';
          if (real.includes('.bun')) return 'bun';
        } catch { /* ignore */ }
        return 'unknown';
      }
      return 'unknown';
    }

    interface Detection { path: string; version: string | null; type: string }
    const allInstalls: Detection[] = [];
    const seenReal = new Set<string>();

    for (const p of candidatePaths) {
      try {
        let realPath: string;
        try { realPath = fs.realpathSync(p); } catch { realPath = p; }
        if (seenReal.has(realPath)) continue;

        const isWin = process.platform === 'win32';
        const shell = isWin && /\.(cmd|bat)$/i.test(p);
        const result = execFileSync(p, ['--version'], {
          timeout: 5000, encoding: 'utf-8', env: execEnv, shell, stdio: 'pipe',
        });
        seenReal.add(realPath);
        allInstalls.push({ path: p, version: result.trim() || null, type: classifyPath(p) });
      } catch {
        // not at this path
      }
    }

    // Also scan PATH via which/where to catch bun, custom, or other non-standard installs
    try {
      const isWinPlatform = process.platform === 'win32';
      const cmd = isWinPlatform ? 'where' : '/usr/bin/which';
      const args = isWinPlatform ? ['claude'] : ['-a', 'claude']; // -a = show ALL matches
      const whichResult = execFileSync(cmd, args, {
        timeout: 3000, encoding: 'utf-8', env: execEnv,
        shell: isWinPlatform, stdio: 'pipe',
      });
      for (const line of whichResult.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate) continue;
        try {
          let realPath: string;
          try { realPath = fs.realpathSync(candidate); } catch { realPath = candidate; }
          if (seenReal.has(realPath)) continue;

          const shell = isWinPlatform && /\.(cmd|bat)$/i.test(candidate);
          const result = execFileSync(candidate, ['--version'], {
            timeout: 5000, encoding: 'utf-8', env: execEnv, shell, stdio: 'pipe',
          });
          seenReal.add(realPath);
          allInstalls.push({ path: candidate, version: result.trim() || null, type: classifyPath(candidate) });
        } catch {
          // invalid binary at this path
        }
      }
    } catch {
      // which/where failed
    }

    const primary = allInstalls[0];
    const hasClaude = !!primary;

    // On Windows, check for Git Bash (bash.exe) — this is what the SDK actually uses at runtime.
    // Must match the detection strategy in platform.ts:findGitBash() to avoid false negatives.
    let hasGit = true; // default true for non-Windows
    if (process.platform === 'win32') {
      hasGit = false;
      // 1. User-specified env var
      const envBash = process.env.CLAUDE_CODE_GIT_BASH_PATH || userShellEnv.CLAUDE_CODE_GIT_BASH_PATH;
      if (envBash && fs.existsSync(envBash)) {
        hasGit = true;
      }
      // 2. Common installation paths
      if (!hasGit) {
        const commonPaths = [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        ];
        if (commonPaths.some(p => fs.existsSync(p))) {
          hasGit = true;
        }
      }
      // 3. Derive from `where git`
      if (!hasGit) {
        try {
          const whereResult = execFileSync('where', ['git'], {
            timeout: 3000, encoding: 'utf-8', shell: true, stdio: 'pipe',
          });
          for (const line of whereResult.trim().split(/\r?\n/)) {
            const gitExe = line.trim();
            if (!gitExe) continue;
            const gitDir = path.dirname(path.dirname(gitExe));
            const bashPath = path.join(gitDir, 'bin', 'bash.exe');
            if (fs.existsSync(bashPath)) {
              hasGit = true;
              break;
            }
          }
        } catch {
          // where git failed
        }
      }
    }

    return {
      hasClaude,
      claudeVersion: primary?.version,
      claudePath: primary?.path,
      claudeInstallType: primary?.type,
      otherInstalls: allInstalls.slice(1),
      hasGit,
      platform: process.platform,
    };
  });

  ipcMain.handle('install:start', () => {
    if (installState.status === 'running') {
      throw new Error('Installation is already running');
    }

    // On Windows, check if Git Bash is missing and prepend an install step
    const isWin = process.platform === 'win32';
    const needsGit = isWin && !findGitBashSync();

    const steps: InstallStep[] = [
      ...(needsGit ? [{ id: 'install-git', label: 'Installing Git for Windows', status: 'pending' as const }] : []),
      { id: 'install-claude', label: 'Installing Claude Code (native)', status: 'pending' },
      { id: 'verify', label: 'Verifying installation', status: 'pending' },
    ];

    installState = {
      status: 'running',
      currentStep: null,
      steps,
      logs: [],
    };

    const expandedPath = getExpandedShellPath();
    const home = os.homedir();
    const execEnv: Record<string, string> = {
      ...userShellEnv,
      ..._sanitizedProcessEnv,
      ...userShellEnv,
      PATH: expandedPath,
    };

    function sendProgress() {
      mainWindow?.webContents.send('install:progress', installState);
    }

    function setStep(id: string, status: InstallStep['status'], error?: string) {
      const step = installState.steps.find(s => s.id === id);
      if (step) {
        step.status = status;
        step.error = error;
      }
      installState.currentStep = id;
      sendProgress();
    }

    function addLog(line: string) {
      pushInstallLog(line);
      sendProgress();
    }

    // Run the installation sequence asynchronously
    (async () => {
      try {
        // Step 0 (Windows only): Install Git for Windows if missing
        if (needsGit) {
          setStep('install-git', 'running');
          addLog('Installing Git for Windows via winget...');

          const gitSuccess = await new Promise<boolean>((resolve) => {
            const child = spawn('winget', [
              'install', 'Git.Git',
              '--silent',
              '--accept-package-agreements',
              '--accept-source-agreements',
            ], {
              env: execEnv,
              shell: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            installProcess = child;

            child.stdout?.on('data', (data: Buffer) => {
              for (const line of data.toString().split('\n').filter(Boolean)) addLog(line);
            });
            child.stderr?.on('data', (data: Buffer) => {
              for (const line of data.toString().split('\n').filter(Boolean)) addLog(line);
            });
            child.on('error', (err) => { addLog(`Error: ${err.message}`); resolve(false); });
            child.on('close', (code) => {
              installProcess = null;
              resolve(code === 0);
            });
          });

          if (installState.status === 'cancelled') {
            setStep('install-git', 'failed', 'Cancelled');
            return;
          }
          if (!gitSuccess) {
            // Non-fatal: skip Git install and continue with Claude.
            // The user can install Git manually later.
            addLog('winget not available or install failed. Skipping — please install Git for Windows manually from https://git-scm.com/downloads/win');
            setStep('install-git', 'skipped', 'Auto-install skipped. Please install Git manually.');
          } else {
            addLog('Git for Windows installed successfully.');
            setStep('install-git', 'success');
          }
        }

        // Step 1: Install Claude Code via native installer
        setStep('install-claude', 'running');

        if (isWin) {
          // Windows: download and run install.cmd
          addLog('Downloading native installer for Windows...');

          const installSuccess = await new Promise<boolean>((resolve) => {
            // Download install.cmd to temp, then execute it
            const tmpDir = os.tmpdir();
            const installCmd = path.join(tmpDir, 'claude-install.cmd');

            const downloadChild = spawn('curl', ['-fsSL', 'https://claude.ai/install.cmd', '-o', installCmd], {
              env: execEnv,
              shell: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            installProcess = downloadChild;

            downloadChild.stderr?.on('data', (data: Buffer) => {
              for (const line of data.toString().split('\n').filter(Boolean)) addLog(line);
            });

            downloadChild.on('close', (dlCode) => {
              if (dlCode !== 0) {
                addLog('Failed to download installer.');
                resolve(false);
                return;
              }

              addLog('Running installer...');
              const child = spawn(installCmd, [], {
                env: execEnv,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              installProcess = child;

              child.stdout?.on('data', (data: Buffer) => {
                for (const line of data.toString().split('\n').filter(Boolean)) addLog(line);
              });
              child.stderr?.on('data', (data: Buffer) => {
                for (const line of data.toString().split('\n').filter(Boolean)) addLog(line);
              });
              child.on('error', (err) => { addLog(`Error: ${err.message}`); resolve(false); });
              child.on('close', (code) => {
                installProcess = null;
                // Clean up temp file
                try { fs.unlinkSync(installCmd); } catch { /* ignore */ }
                resolve(code === 0);
              });
            });

            downloadChild.on('error', (err) => {
              addLog(`Download error: ${err.message}`);
              resolve(false);
            });
          });

          if (installState.status === 'cancelled') {
            setStep('install-claude', 'failed', 'Cancelled');
            return;
          }
          if (!installSuccess) {
            setStep('install-claude', 'failed', 'Native installer failed. Check logs for details.');
            installState.status = 'failed';
            sendProgress();
            return;
          }
        } else {
          // macOS / Linux: curl | bash
          addLog('Running: curl -fsSL https://claude.ai/install.sh | bash');

          const installSuccess = await new Promise<boolean>((resolve) => {
            const userShell = process.env.SHELL || '/bin/bash';
            const child = spawn(userShell, ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], {
              env: execEnv,
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            installProcess = child;

            child.stdout?.on('data', (data: Buffer) => {
              for (const line of data.toString().split('\n').filter(Boolean)) addLog(line);
            });
            child.stderr?.on('data', (data: Buffer) => {
              for (const line of data.toString().split('\n').filter(Boolean)) addLog(line);
            });
            child.on('error', (err) => { addLog(`Error: ${err.message}`); resolve(false); });
            child.on('close', (code) => {
              installProcess = null;
              if (code === 0) {
                addLog('Native installer completed successfully.');
                resolve(true);
              } else if (installState.status === 'cancelled') {
                addLog('Installation was cancelled.');
                resolve(false);
              } else {
                addLog(`Installer exited with code ${code}`);
                resolve(false);
              }
            });
          });

          if (installState.status === 'cancelled') {
            setStep('install-claude', 'failed', 'Cancelled');
            return;
          }
          if (!installSuccess) {
            setStep('install-claude', 'failed', 'Native installer failed. Check logs for details.');
            installState.status = 'failed';
            sendProgress();
            return;
          }
        }

        setStep('install-claude', 'success');

        // Step 2: Verify claude is available
        setStep('verify', 'running');

        // Native installer puts binary in ~/.local/bin/claude — add to PATH for verification
        const verifyPath = `${path.join(home, '.local', 'bin')}${path.delimiter}${expandedPath}`;
        const verifyEnv = { ...execEnv, PATH: verifyPath };

        try {
          const verifyOpts = isWin
            ? { timeout: 5000, encoding: 'utf-8' as const, env: verifyEnv, shell: true, stdio: 'pipe' as const }
            : { timeout: 5000, encoding: 'utf-8' as const, env: verifyEnv, stdio: 'pipe' as const };
          const claudeResult = execFileSync('claude', ['--version'], verifyOpts);
          addLog(`Claude Code installed: ${claudeResult.trim()}`);
          setStep('verify', 'success');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLog(`Verification failed: ${msg}`);
          setStep('verify', 'failed', 'Claude Code was installed but could not be verified.');
          installState.status = 'failed';
          sendProgress();
          return;
        }

        installState.status = 'success';
        installState.currentStep = null;
        sendProgress();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`Unexpected error: ${msg}`);
        installState.status = 'failed';
        sendProgress();
      }
    })();
  });

  ipcMain.handle('install:cancel', () => {
    if (installState.status !== 'running') {
      return;
    }

    installState.status = 'cancelled';
    pushInstallLog('Cancelling installation...');

    if (installProcess) {
      const pid = installProcess.pid;
      try {
        if (process.platform === 'win32' && pid) {
          // Windows: kill entire process tree (shell: true spawns cmd.exe which
          // spawns npm/winget — child.kill() only kills the shell, not the tree)
          spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
        } else {
          installProcess.kill();
        }
      } catch {
        // already dead
      }
      installProcess = null;
      pushInstallLog('Installation process terminated.');
    }

    mainWindow?.webContents.send('install:progress', installState);
  });

  ipcMain.handle('install:get-logs', () => {
    return installState.logs;
  });

  // Install Git for Windows via winget (called from ConnectionStatus dialog)
  ipcMain.handle('install:git', async () => {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Git installation is only needed on Windows' };
    }
    try {
      const expandedPath = getExpandedShellPath();
      const execEnv = { ..._sanitizedProcessEnv, ...userShellEnv, PATH: expandedPath };

      const result = await new Promise<{ success: boolean; output: string }>((resolve) => {
        let output = '';
        const child = spawn('winget', [
          'install', 'Git.Git',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ], {
          env: execEnv,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
        child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
        child.on('error', (err) => { resolve({ success: false, output: err.message }); });
        child.on('close', (code) => { resolve({ success: code === 0, output: output.trim() }); });
      });

      return result;
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- End install wizard IPC handlers ---

  // Open a folder in the system file manager (Finder / Explorer)
  ipcMain.handle('shell:open-path', async (_event: Electron.IpcMainInvokeEvent, folderPath: string) => {
    return shell.openPath(folderPath);
  });

  // Phase 2C.6 follow-up: expose the persistent log directory to the
  // renderer so About → "打开日志文件夹" can route the user there. The
  // path is platform-specific; resolved lazily on first call so it
  // matches whatever `setupPersistentMainLog` actually wrote to.
  ipcMain.handle('app:get-log-path', async () => {
    try {
      return app.getPath('logs');
    } catch {
      return null;
    }
  });

  // Bridge status IPC
  ipcMain.handle('bridge:is-active', async () => {
    return isBridgeActive();
  });

  // Native folder picker dialog
  ipcMain.handle('dialog:open-folder', async (_event, options?: { defaultPath?: string; title?: string }) => {
    if (!mainWindow) return { canceled: true, filePaths: [] };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options?.title || 'Select a project folder',
      defaultPath: options?.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  // --- Widget export IPC handler ---
  // Uses an isolated BrowserWindow for secure, high-fidelity widget screenshot.
  // The window is hidden, has its own session partition, no preload, no IPC access.
  ipcMain.handle('widget:export-png', async (_event, { html, width }: { html: string; width: number }) => {
    const exportWindow = new BrowserWindow({
      show: false,
      width,
      height: 2000,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `export-${Date.now()}`, // isolated session, destroyed with window
        // No preload — no IPC access from this window
      },
    });

    // Block all navigation and window.open — prevents data exfiltration via top-level nav
    exportWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    exportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    try {
      // Load the widget HTML directly
      await exportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // Wait for widget scripts to finish (scriptsReady signal or timeout)
      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        // Listen for console message from widget:scriptsReady
        exportWindow.webContents.on('console-message', (_e, _level, message) => {
          if (message === '__scriptsReady__') done();
        });
        // Fallback timeout for widgets without CDN/scripts
        setTimeout(done, 6000);
      });

      // Extra delay for final paint
      await new Promise(r => setTimeout(r, 300));

      // Get actual content height and resize
      const contentHeight = await exportWindow.webContents.executeJavaScript('document.body.scrollHeight');
      exportWindow.setSize(width, Math.min(contentHeight + 20, 4000));
      await new Promise(r => setTimeout(r, 100));

      // Capture using Chromium's native screenshot
      const image = await exportWindow.webContents.capturePage();
      return image.toPNG().toString('base64');
    } finally {
      exportWindow.destroy();
    }
  });

  // --- Artifact long-shot export (Phase 3) ---
  // Captures an arbitrary HTML source as a single full-page PNG, using
  // Chromium's CDP captureBeyondViewport so we can exceed the viewport
  // height without manual stitching. Runs in an isolated hidden
  // BrowserWindow with its own session partition (mirrors
  // widget:export-png's security envelope).
  //
  // Module-level export lock serializes concurrent calls; capturePage +
  // debugger.attach don't play nicely with a second export starting on
  // the same machine before the first finishes.
  let exportLongShotBusy = false;

  ipcMain.handle('artifact:export-long-shot', async (_event, params: {
    html: string;
    width: number;
    pixelRatio?: number;
    outPath?: string;
    maxHeightPx?: number;
    timeoutMs?: number;
  }) => {
    if (exportLongShotBusy) {
      return { error: 'busy' as const };
    }
    exportLongShotBusy = true;

    const {
      html,
      width,
      pixelRatio = 2,
      outPath,
      maxHeightPx = 50000,
      timeoutMs = 30000,
    } = params;

    const exportWindow = new BrowserWindow({
      show: false,
      width,
      height: 2000,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `artifact-export-${Date.now()}`,
      },
    });
    exportWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    exportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    let timeoutHandle: NodeJS.Timeout | null = null;
    const deadline = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      await exportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // Give the document a chance to finish layout + image loading. We
      // race a scriptsReady console signal against a fixed ceiling.
      const readyRace = Promise.race([
        new Promise<'ready'>((resolve) => {
          exportWindow.webContents.on('console-message', (_e, _level, message) => {
            if (message === '__scriptsReady__') resolve('ready');
          });
          // Unconditional floor — even if the page never emits scriptsReady,
          // we still resolve after 3s so simple HTML artifacts render.
          setTimeout(() => resolve('ready'), 3000);
        }),
        deadline,
      ]);
      const readyResult = await readyRace;
      if (readyResult === 'timeout') {
        return { error: 'timeout' as const };
      }
      // Small extra delay so image repaints settle before we measure height.
      await new Promise((r) => setTimeout(r, 200));

      const contentHeight: number = await exportWindow.webContents.executeJavaScript(
        'document.body.scrollHeight',
      );
      if (contentHeight > maxHeightPx) {
        return {
          error: 'canvas_limit' as const,
          meta: { contentHeight, maxHeightPx },
        };
      }

      // Use CDP Page.captureScreenshot with captureBeyondViewport so we
      // don't need to size the window up to the content or stitch segments.
      // debugger.attach is independent of DevTools; the export window
      // itself is hidden so DevTools never attach to it.
      try {
        exportWindow.webContents.debugger.attach('1.3');
      } catch (err) {
        return {
          error: 'debugger_busy' as const,
          meta: { detail: String(err) },
        };
      }

      let pngBase64: string;
      try {
        const result = await exportWindow.webContents.debugger.sendCommand(
          'Page.captureScreenshot',
          {
            format: 'png',
            captureBeyondViewport: true,
            // Force device-pixel ratio so the produced image matches the
            // user's monitor scale — without this, retina users get a
            // half-resolution PNG.
            // Note: CDP doesn't take pixelRatio directly; we size via
            // clip + deviceScaleFactor below if needed.
          },
        );
        pngBase64 = (result as { data: string }).data;
      } finally {
        try {
          exportWindow.webContents.debugger.detach();
        } catch {
          // Detach failures are harmless — the window destroy below
          // tears everything down regardless.
        }
      }

      if (outPath) {
        const fs = await import('fs/promises');
        const buf = Buffer.from(pngBase64, 'base64');
        await fs.writeFile(outPath, buf);
        return { path: outPath, bytes: buf.length };
      }
      return { base64: pngBase64, bytes: Buffer.from(pngBase64, 'base64').length };
    } catch (err) {
      return {
        error: 'oom' as const,
        meta: { detail: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      exportWindow.destroy();
      exportLongShotBusy = false;
      // Unused here but kept to signal we didn't forget the pixelRatio
      // param — Phase 3 follow-up may wire it via deviceScaleFactor emu.
      void pixelRatio;
    }
  });

  // --- Terminal IPC handlers ---
  terminalManager.setOnData((id, data) => {
    mainWindow?.webContents.send('terminal:data', { id, data });
  });

  terminalManager.setOnExit((id, code) => {
    mainWindow?.webContents.send('terminal:exit', { id, code });
  });

  ipcMain.handle('terminal:create', async (_event, opts: { id: string; cwd: string; cols: number; rows: number }) => {
    terminalManager.create(opts.id, {
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: userShellEnv,
    });
  });

  ipcMain.on('terminal:write', (_event, data: { id: string; data: string }) => {
    terminalManager.write(data.id, data.data);
  });

  ipcMain.handle('terminal:resize', async (_event, data: { id: string; cols: number; rows: number }) => {
    terminalManager.resize(data.id, data.cols, data.rows);
  });

  ipcMain.handle('terminal:kill', async (_event, id: string) => {
    terminalManager.kill(id);
  });

  // --- End terminal IPC handlers ---

  // --- Notification IPC handler ---
  // Phase 3 Step 3: payload extended with `taskId` / `sessionId` /
  // `event_id` so a click → re-open + route to /settings/tasks?focus=…
  // works whether the notification was rendered here (window visible)
  // or by the bg-poller (window hidden). The legacy `onClick` field is
  // kept for backward compatibility with non-task notifications.
  ipcMain.handle('notification:show', async (_event, options: {
    title: string;
    body: string;
    onClick?: { type: string; payload: string };
    taskId?: string;
    sessionId?: string;
    event_id?: string;
  }) => {
    try {
      const notification = new Notification({
        title: options.title,
        body: options.body || '',
      });
      // #34 observability — renderer (window-visible) show path. On macOS the
      // OS banner is SUPPRESSED while the app is focused (focused=true) — the
      // in-app toast from useNotificationPoll is the visible fallback there.
      console.log(`[notify] notification:show renderer path: supported=${Notification.isSupported()} focused=${mainWindow?.isFocused() ?? 'n/a'} title=${JSON.stringify(options.title)}`);
      const hasTaskPayload = !!(options.taskId || options.sessionId);
      if (options.onClick || hasTaskPayload) {
        notification.on('click', () => {
          mainWindow?.show();
          mainWindow?.focus();
          if (hasTaskPayload) {
            mainWindow?.webContents.send('notification:click', {
              taskId: options.taskId,
              sessionId: options.sessionId,
              event_id: options.event_id,
            });
          } else if (options.onClick) {
            mainWindow?.webContents.send('notification:click', options.onClick);
          }
        });
      }
      notification.show();
      return true;
    } catch (err) {
      console.error('[notification] Failed to show:', err);
      return false;
    }
  });

  // Proxy resolution IPC — allows renderer/API routes to query system proxy
  ipcMain.handle('proxy:resolve', async (_event, url: string) => {
    try {
      return await session.defaultSession.resolveProxy(url);
    } catch {
      return 'DIRECT';
    }
  });

  try {
    let port: number;

    if (isDev) {
      const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : NaN;
      port = Number.isNaN(envPort) ? 3000 : envPort;
      console.log(`Dev mode: connecting to http://127.0.0.1:${port}`);
      serverPort = port;
      createWindow(`http://127.0.0.1:${port}`);
      ensureTray();
    } else {
      // Show window immediately with loading screen so user sees progress
      // even if port acquisition takes a moment.
      createWindow();

      // P2 review fix (2026-05-09): create the tray BEFORE awaiting
      // server ready. The promise the menubar-resident model makes is
      // "the icon is there from app launch" — if the user closes the
      // loading window mid-boot, hide-on-close keeps mainWindow alive
      // but the user needs a visible re-entry path; without the tray
      // they're staring at an app with no icon and no window. Tray
      // doesn't depend on serverPort to draw — its only server-touching
      // action is showMainWindow(), which now handles "no port yet"
      // by showing a loading screen instead of pinning to 3000.
      ensureTray();

      // startServerOnStablePort actually binds the subprocess on each
      // candidate port and advances on EADDRINUSE — closing the TOCTOU
      // race window from the previous "probe-then-release" approach.
      port = await startServerOnStablePort();
      serverPort = port;
      console.log('Server is ready');
      if (mainWindow) {
        mainWindow.loadURL(`http://127.0.0.1:${port}`);
      }

      // Trigger bridge auto-start via explicit POST (only checks setting once)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const http = require('http');
      const autoStartData = JSON.stringify({ action: 'auto-start' });
      const autoStartReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/bridge',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(autoStartData),
        },
      }, () => {});
      autoStartReq.on('error', () => {});
      autoStartReq.write(autoStartData);
      autoStartReq.end();
    }

  } catch (err) {
    console.error('Failed to start:', err);
    dialog.showErrorBox(
      'CodePilot - Failed to Start',
      `The internal server could not start.\n\n${err instanceof Error ? err.message : String(err)}\n\nPlease try restarting the application.`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // In the menubar-resident model, `close` is intercepted on the main
  // window and turns into `hide()` instead of a real destroy. So this
  // event only fires when the user explicitly chose "Quit CodePilot"
  // from the tray menu (which sets `isQuitting=true` then calls
  // `app.quit()` → `before-quit` does the real teardown).
  //
  // We deliberately do NOT call `app.quit()` here on non-Darwin: that
  // would defeat the menubar-resident promise on Windows / Linux where
  // the tray icon must keep the app alive after the last window goes
  // away. Real shutdown happens from the tray Quit item.
  if (!isQuitting) {
    // Defensive: should not be reachable while the close-to-hide handler
    // is in place, but log if we ever get here so regressions are loud.
    console.warn('[lifecycle] window-all-closed fired without isQuitting — menubar-resident may be broken');
  }
});

app.on('activate', async () => {
  // Dock click on macOS: if we still have a hidden main window, just show it;
  // otherwise re-create. The tray stays alive across this — menubar icon is
  // permanent until the user explicitly chooses "Quit CodePilot".
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }

  try {
    if (!isDev && !serverProcess) {
      // Show loading window immediately so user sees progress
      createWindow();
      const port = await startServerOnStablePort();
      serverPort = port;
      if (mainWindow) {
        mainWindow.loadURL(`http://127.0.0.1:${port}`);
      }
    } else {
      // P2 review fix (2026-05-09): no `serverPort || 3000` here either.
      // If we land in this branch with serverPort unset (dock click during
      // a brief race where serverProcess exists but port hasn't latched
      // yet), `chatWindowUrlForRevival()` returns undefined → loading
      // splash, and the in-flight startup will load the real URL. Pinning
      // to 3000 in production opens a window against the wrong port range.
      createWindow(chatWindowUrlForRevival());
    }
  } catch (err) {
    console.error('Failed to restart server:', err);
  }
});

app.on('before-quit', async (e) => {
  // First firing: tear down resources, then re-emit quit. Any subsequent
  // firing (after we re-call app.quit() below) just proceeds to exit. The
  // `isQuitting` flag also tells the main window's `close` handler to let
  // the close go through instead of hiding.
  isQuitting = true;

  // Kill all terminal processes
  terminalManager.killAll();

  // Kill any running install process (tree-kill on Windows)
  if (installProcess) {
    const pid = installProcess.pid;
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
      } else {
        installProcess.kill();
      }
    } catch { /* already dead */ }
    installProcess = null;
  }

  destroyTray();

  if (serverProcess) {
    e.preventDefault();
    // Stop bridge gracefully before killing the server
    await stopBridge();
    // Phase 5 Phase 6 (2026-05-14) — graceful Codex app-server dispose
    // before the Next server gets hard-killed. The Codex JSON-RPC child
    // is owned by the Next server process; if we kill the Next server
    // without telling Codex first, the Rust binary can orphan (no
    // parent-death signal handler upstream). 1.5s budget — failure /
    // timeout is non-fatal, we still kill the server below.
    if (serverPort) {
      try {
        await Promise.race([
          fetch(`http://127.0.0.1:${serverPort}/api/codex/dispose`, { method: 'POST' }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
        ]);
      } catch {
        /* best-effort — proceed to killServer regardless */
      }
    }
    await killServer();
    app.quit();
  }
});
