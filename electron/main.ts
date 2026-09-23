// Sentry must be initialized before all other imports to catch early crashes
import * as Sentry from '@sentry/electron/main';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { configureElectronMainIntegrations, resolveTelemetryConfig, TELEMETRY_IGNORE_ERRORS } from '../src/lib/telemetry/contract';
import { sanitizeTelemetryBreadcrumb, sanitizeTelemetryEvent } from '../src/lib/telemetry/sanitize';
import { createTelemetrySmokeError, telemetrySmokeEnabled } from '../src/lib/telemetry/smoke';
import {
  buildUtilityProcessFailureEvent,
} from '../src/lib/telemetry/utility-process-failure';
import { resolveCodePilotDataDir } from '../src/lib/codepilot-data-dir';
import { translate, type Locale } from '../src/i18n';

const codePilotDataDir = resolveCodePilotDataDir();

// Check opt-out before init — reads a marker file that the renderer writes
const sentryOptOutPath = join(codePilotDataDir, 'sentry-disabled');
const sentryDisabled = existsSync(sentryOptOutPath) &&
  readFileSync(sentryOptOutPath, 'utf-8').trim() === 'true';

const electronTelemetry = resolveTelemetryConfig({
  dsn: process.env.CODEPILOT_SENTRY_DSN,
  channel: process.env.CODEPILOT_APP_CHANNEL,
  version: process.env.CODEPILOT_APP_VERSION,
  nodeEnv: process.env.NODE_ENV,
  optedOut: sentryDisabled,
});
// Native minidumps are raw attachments and bypass beforeSend sanitization.
// They are therefore disabled in every distributable build. The manually
// compiled telemetry-smoke artifact is the only explicit opt-in; CI never
// publishes that artifact and needs the integration on its recovery launch
// so the completed dump can be drained.
const nativeMinidumpTelemetryEnabled = electronTelemetry.enabled
  && telemetrySmokeEnabled(process.env.CODEPILOT_TELEMETRY_SMOKE);

if (electronTelemetry.enabled) {
  Sentry.init({
    dsn: electronTelemetry.dsn,
    environment: electronTelemetry.environment,
    release: electronTelemetry.release,
    sendDefaultPii: false,
    attachScreenshot: false,
    tracesSampleRate: 0,
    ignoreErrors: TELEMETRY_IGNORE_ERRORS,
    integrations: (defaults) => configureElectronMainIntegrations(
      defaults,
      Sentry.mainProcessSessionIntegration({ sendOnCreate: true }),
      Sentry.childProcessIntegration({ events: [] }),
      { allowNativeMinidumps: nativeMinidumpTelemetryEnabled },
    ),
    beforeBreadcrumb(breadcrumb) {
      return sanitizeTelemetryBreadcrumb(breadcrumb);
    },
    beforeSend(event) {
      return sanitizeTelemetryEvent(event, {
        layer: 'electron_main',
        channel: electronTelemetry.channel,
        platform: process.platform,
        arch: process.arch,
      });
    },
  });
  if (telemetrySmokeEnabled(process.env.CODEPILOT_TELEMETRY_SMOKE)) {
    const eventId = Sentry.captureException(createTelemetrySmokeError('electron_main'));
    console.log(`[telemetry-smoke] layer=electron_main event_id=${eventId}`);
    void Sentry.flush(5_000);
  }
}

const nativeCrashSmokeEnabled = electronTelemetry.enabled
  && telemetrySmokeEnabled(process.env.CODEPILOT_TELEMETRY_SMOKE)
  && process.env.CODEPILOT_NATIVE_CRASH_SMOKE === '1';

import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Notification, nativeImage, nativeTheme, dialog, session, utilityProcess, ipcMain, shell, Tray, Menu, clipboard } from 'electron';
import { resolveDefaultAssistantHome } from './default-assistant-home';
import {
  buildNativeNotificationOptions,
  deliverNativeNotification,
  NativeNotificationRetention,
} from './notification-lifecycle';
import {
  NotificationClickQueue,
  resolveNotificationActionRoute,
  type NotificationClickAction,
} from './notification-click-queue';
import { externalOpenFailureCopy, openExternalSafely } from './external-navigation';
import path from 'path';
import { execFileSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import { TerminalManager } from './terminal-manager';
import { validateTerminalCreateOpts } from './terminal-create-validation';
import { ServerRecoverySupervisor } from './server-supervisor';
import {
  parseServerDescendantLifecycleMessage,
  ServerDescendantRegistry,
} from './server-descendant-registry';
import { buildServerRecoveryDataUrl, type ServerRecoveryPageState } from './server-recovery-page';
import {
  buildCodexPowerShellLaunchSpec,
  findWindowsNpmCommand,
  isTrustedCodexRecoverySender,
  selectCodexWindowsInstallCommand,
} from './codex-windows-recovery';
import { initializeProviderSecretEnvironment } from './provider-secret-key';
import {
  PROVIDER_SECRET_ISOLATED_SMOKE_ENV,
  shouldSkipProviderSecretForIsolatedSmoke,
} from './provider-secret-startup-policy';
import { sanitizeLogLine } from './log-sanitize';
import {
  buildMacosKeychainEnvironment,
  getMacosDefaultKeychainProbe,
} from '../src/lib/macos-keychain-guard';
import { getTrayMenuLabels } from '../src/lib/tray-menu-labels';
import { NATIVE_NOTIFICATION_ERROR } from '../src/lib/notification-error-codes';
import { BoundedLineRing } from '../src/lib/logging/bounded-line-ring';
import { createRotatingLogWriter, type RotatingLogWriter } from '../src/lib/logging/main-log-rotation';
import { classifyNavigation } from '../src/lib/navigation-policy';
import { buildProxySafeEnvironment } from '../src/lib/process-proxy-env';
import { isNativeThemeSource } from '../src/lib/native-theme-source';
import {
  deriveHtmlThumbnailRequestScope,
  HTML_THUMBNAIL_CAPTURE_TIMEOUT_MS,
  HtmlThumbnailCaptureTimeoutError,
  isHtmlThumbnailRequestAllowed,
  SerializedDeadlineQueue,
} from './html-thumbnail-security';
import {
  buildScopedPathInspectionUrl,
  type ScopedSystemPathRequest,
  type SystemPathPurpose,
  validateScopedPathInspection,
} from '../src/lib/local-path-security';
import { parseServerRuntimeObservabilityMessage } from '../src/lib/server-runtime-observability';
import {
  cancelFreshDatabaseIntent,
  continueFreshDatabaseIntent,
  DATABASE_RECOVERY_DIRNAME,
  DATABASE_STARTUP_DIAGNOSTIC_MARKER,
  DATABASE_STARTUP_MARKER,
  prepareFreshDatabase,
  SERVER_HEALTH_DIAGNOSTIC_MARKER,
} from '../src/lib/database-recovery';
import { disposeAutoUpdaterTimers, initAutoUpdater, setUpdaterWindow } from './updater';
import {
  cancelCliMaintenanceAndWait,
  getCliMaintenanceBootstrapLease,
  initCliMaintenance,
  isCliMaintenanceRunning,
  reconcileCliMaintenanceAfterServerReady,
  setCliMaintenanceWindow,
} from './cli-maintenance';
import {
  BROWSER_WEB_PREFERENCES,
  deriveBrowserPartition,
  isAllowedBrowserGuestUrl,
  isCanonicalBrowserWorkspaceId,
} from './browser-surface-security';
import { classifyBrowserUrl, isSafeExternalBrowserUrl } from '../src/lib/browser-url-policy';

// B-025: hard caps for the persistent main log + the in-memory server-output
// ring. The 12.5 GB log a user hit came from an unbounded active file plus an
// unbounded `serverErrors` array under a Codex app-server tracing flood.
const MAIN_LOG_MAX_BYTES = 50 * 1024 * 1024; // rotate the active log past 50 MB
const MAIN_LOG_MAX_ARCHIVES = 5;             // keep .1 .. .5 (≈300 MB ceiling)
const SERVER_ERRORS_MAX_LINES = 200;
const SERVER_ERRORS_MAX_BYTES = 256 * 1024;

/**
 * Return a copy of process.env without __NEXT_PRIVATE_* variables.
 *
 * The bundled Next.js standalone server sets these at runtime
 * (e.g. __NEXT_PRIVATE_STANDALONE_CONFIG, __NEXT_PRIVATE_ORIGIN).
 * If they leak into child-process environments they cause every
 * other Next.js project on the machine to skip its own config
 * loading, breaking builds and dev servers.
 */
function sanitizedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      !key.startsWith('__NEXT_PRIVATE_')
      && key !== PROVIDER_SECRET_ISOLATED_SMOKE_ENV
      && value !== undefined
    ) {
      env[key] = value;
    }
  }
  return env;
}

let mainWindow: BrowserWindow | null = null;
const issuedBrowserPartitions = new Set<string>();
const configuredBrowserPartitions = new Set<string>();
const notificationClickQueue = new NotificationClickQueue((action) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notification:click', action);
  }
});
let serverProcess: Electron.UtilityProcess | null = null;
let serverPort: number | null = null;
const serverErrors = new BoundedLineRing(SERVER_ERRORS_MAX_LINES, SERVER_ERRORS_MAX_BYTES);
// B-025: set by setupPersistentMainLog so the crash breadcrumb can report the
// active-log size and the writer can be flushed on quit.
let mainLogWriter: RotatingLogWriter | null = null;
let activeMainLogPath: string | null = null;
let serverExited = false;
let serverExitCode: number | null = null;
const serverSupervisor = new ServerRecoverySupervisor();
let nextServerGeneration = 0;
let activeServerGeneration = 0;
let serverLifecyclePhase: 'startup' | 'running' | 'recovering' | 'quitting' = 'startup';
let serverRecoveryPromise: Promise<void> | null = null;
let queuedServerRecovery: { generation: number; reason: string } | null = null;
let lastRecoverableRoute = '/';
let lastServerFailureReason = 'server_exit';
let lastServerRecoveryAttempt = 0;
let lastServerRecoveryPageState: ServerRecoveryPageState = 'recovering';
let activeServerRecoveryDataUrl: string | null = null;
let lastDatabaseStartupDiagnostic: string | null = null;
let lastServerHealthDiagnostic: string | null = null;
const serverDescendantRegistries = new Map<number, ServerDescendantRegistry>();
let lastServerRuntimeMetrics: ReturnType<typeof parseServerRuntimeObservabilityMessage> = null;
let lastServerProcessMetric: {
  workingSetKb: number;
  peakWorkingSetKb: number;
  privateKb: number | null;
  creationTime: number;
  cpuPercent: number;
} | null = null;
let userShellEnv: Record<string, string> = {};
let resolvedProxyEnv: Record<string, string> = {};
let providerSecretEnvironment: Record<string, string> = {};
let macosKeychainEnvironment: Record<string, string> = {};
let isQuitting = false;
let appQuitTeardownStarted = false;
let updaterInstallLifecycleArmed = false;
let cliMaintenanceQuitCoordinationInFlight = false;
let allowQuitDuringCliMaintenance = false;
let tray: Tray | null = null;
let nativeDeliveryTimer: ReturnType<typeof setInterval> | null = null;
let nativeDeliveryPolling = false;
const nativeDeliveryOwner = `electron-main-${process.pid}-${Math.random().toString(36).slice(2)}`;
const nativeNotificationRetention = new NativeNotificationRetention<Notification>();

function openExternalInSystemBrowser(targetUrl: string): void {
  void openExternalSafely(
    targetUrl,
    (url) => shell.openExternal(url),
    async () => {
      console.warn('[external-navigation] code=external_open_failed');
      const locale = (() => {
        try { return app.getLocale(); } catch { return 'en'; }
      })();
      const copy = externalOpenFailureCopy(locale);
      const options: Electron.MessageBoxOptions = {
        type: 'error',
        title: copy.title,
        message: copy.message,
        detail: copy.detail,
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, options);
      } else {
        await dialog.showMessageBox(options);
      }
    },
  );
}

function isTrustedMainWindowSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== event.sender.mainFrame
    || !serverPort
  ) {
    return false;
  }
  try {
    const senderUrl = new URL(event.sender.getURL());
    return senderUrl.protocol === 'http:'
      && senderUrl.hostname === '127.0.0.1'
      && senderUrl.port === String(serverPort);
  } catch {
    return false;
  }
}

function browserGuestHost(contents: Electron.WebContents): Electron.WebContents | null {
  const host = contents.hostWebContents;
  return host && !host.isDestroyed() ? host : null;
}

function configureBrowserPartition(partition: string): void {
  if (configuredBrowserPartitions.has(partition)) return;
  const browserSession = session.fromPartition(partition);
  const userAgent = browserSession.getUserAgent()
    .replace(/\sElectron\/[\d.]+/g, '')
    .replace(/\sCodePilot\/[\d.]+/gi, '');
  browserSession.setUserAgent(userAgent);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on('will-download', (event, _item, contents) => {
    event.preventDefault();
    browserGuestHost(contents)?.send('browser:download-blocked', {
      webContentsId: contents.id,
    });
  });
  configuredBrowserPartitions.add(partition);
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  const guardNavigation = (event: Electron.Event, targetUrl: string) => {
    const decision = classifyBrowserUrl(targetUrl);
    if (decision.allowed) return;
    event.preventDefault();
    browserGuestHost(contents)?.send('browser:navigation-blocked', {
      webContentsId: contents.id,
      reason: decision.reason,
    });
  };

  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isAllowedBrowserGuestUrl(targetUrl)) {
      browserGuestHost(contents)?.send('browser:open-url-requested', {
        webContentsId: contents.id,
        url: targetUrl,
      });
    } else {
      const decision = classifyBrowserUrl(targetUrl);
      browserGuestHost(contents)?.send('browser:navigation-blocked', {
        webContentsId: contents.id,
        reason: decision.allowed ? 'invalid_url' : decision.reason,
      });
    }
    return { action: 'deny' };
  });
});

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

let installState: InstallState = {
  status: 'idle',
  currentStep: null,
  steps: [],
  logs: [],
};

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

async function getActiveUpdateWork(): Promise<Array<'chat' | 'bridge' | 'task'>> {
  if (!serverPort) throw new Error('activity state unavailable');
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort}/api/app/activity`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('activity endpoint unavailable');
    const body = await response.json() as { chat?: unknown; bridge?: unknown; task?: unknown };
    const blockers: Array<'chat' | 'bridge' | 'task'> = [];
    if (body.chat === true) blockers.push('chat');
    if (body.bridge === true) blockers.push('bridge');
    if (body.task === true) blockers.push('task');
    return blockers;
  } catch {
    // Fail closed: inability to prove idle work must never force an install.
    throw new Error('activity state unavailable');
  }
}

function isTrustedUpdaterSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !serverPort) {
    return false;
  }
  try {
    const senderUrl = new URL(event.sender.getURL());
    return senderUrl.protocol === 'http:'
      && senderUrl.hostname === '127.0.0.1'
      && senderUrl.port === String(serverPort);
  } catch {
    return false;
  }
}

function initializeAutoUpdaterForWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  initCliMaintenance({
    win: mainWindow,
    platform: process.platform,
    isTrustedSender: isTrustedUpdaterSender,
    getServerBaseUrl: () => serverPort ? `http://127.0.0.1:${serverPort}` : null,
    getActiveWork: getActiveUpdateWork,
    isAppQuitting: () => appQuitTeardownStarted || serverLifecyclePhase === 'quitting',
  });
  initAutoUpdater({
    win: mainWindow,
    currentVersion: app.getVersion(),
    channel: process.env.CODEPILOT_APP_CHANNEL || 'local',
    isPackaged: app.isPackaged,
    officialBuild: process.env.CODEPILOT_OFFICIAL_UPDATE_BUILD === '1',
    platform: process.platform,
    appImagePath: process.env.APPIMAGE,
    isTrustedSender: isTrustedUpdaterSender,
    getActiveWork: getActiveUpdateWork,
    onInstallLifecycleChange: (installing) => {
      if (installing) {
        updaterInstallLifecycleArmed = true;
        isQuitting = true;
        serverLifecyclePhase = 'quitting';
        return;
      }
      if (!updaterInstallLifecycleArmed || appQuitTeardownStarted) return;
      updaterInstallLifecycleArmed = false;
      isQuitting = false;
      serverLifecyclePhase = serverProcess && !serverExited ? 'running' : 'recovering';
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow(serverPort ? `http://127.0.0.1:${serverPort}${lastRecoverableRoute}` : undefined);
      } else {
        mainWindow.show();
      }
      ensureTray();
    },
  });
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

async function resolveScopedSystemPath(
  event: Electron.IpcMainInvokeEvent,
  request: ScopedSystemPathRequest,
  purpose: SystemPathPurpose,
): Promise<{ realPath: string } | { error: string }> {
  try {
    const inspectUrl = buildScopedPathInspectionUrl(
      event.sender.getURL(),
      request,
      purpose,
    );
    const response = await fetch(inspectUrl, { cache: 'no-store' });
    if (!response.ok) return { error: `Path validation failed (${response.status})` };
    const inspected = validateScopedPathInspection(await response.json(), purpose);

    // The route returns a canonical real path. Re-check it immediately before
    // the OS call so swapping that path to a symlink after inspection cannot
    // turn an allowed HTML file into an executable or bundle.
    const currentRealPath = fs.realpathSync(inspected.realPath);
    if (currentRealPath !== inspected.realPath) {
      return { error: 'Path changed after validation' };
    }
    const stat = fs.statSync(currentRealPath);
    validateScopedPathInspection(
      {
        realPath: currentRealPath,
        kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      },
      purpose,
    );
    return { realPath: currentRealPath };
  } catch {
    return { error: 'Path validation failed' };
  }
}

/**
 * Show / focus the main window. Re-creates it if the user previously hit
 * Cmd+Q during a hidden state and it was destroyed; otherwise just unhides
 * an existing hidden window. Called from tray menu, tray double-click and
 * notification clicks.
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!isDev && (serverLifecyclePhase === 'recovering' || serverSupervisor.state === 'failed')) {
      activeServerRecoveryDataUrl = buildServerRecoveryDataUrl({
        locale: serverRecoveryLocale(),
        state: lastServerRecoveryPageState,
        attempt: lastServerRecoveryAttempt,
        reasonCode: lastServerFailureReason,
      });
      createWindow(activeServerRecoveryDataUrl);
      return;
    }
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
  if (isCliMaintenanceRunning()) {
    // Let before-quit keep the app alive and present the bounded choice. Do
    // not raise isQuitting yet or close-to-hide and recovery code will assume
    // teardown has already committed.
    app.quit();
    return;
  }
  isQuitting = true;
  app.quit();
}

async function coordinateQuitDuringCliMaintenance(): Promise<void> {
  if (cliMaintenanceQuitCoordinationInFlight) return;
  cliMaintenanceQuitCoordinationInFlight = true;
  const isZh = (() => {
    try { return app.getLocale().toLowerCase().startsWith('zh'); } catch { return false; }
  })();
  const locale: Locale = isZh ? 'zh' : 'en';
  try {
    const result = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: translate(locale, 'cliMaintenance.quit.title'),
      message: translate(locale, 'cliMaintenance.quit.message'),
      detail: translate(locale, 'cliMaintenance.quit.detail'),
      buttons: [
        translate(locale, 'cliMaintenance.quit.keepWaiting'),
        translate(locale, 'cliMaintenance.quit.cancelAndQuit'),
        translate(locale, 'cliMaintenance.quit.forceQuit'),
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response === 0) return;
    const cleaned = await cancelCliMaintenanceAndWait(result.response === 1 ? 10_000 : 2_000);
    if (result.response === 1 && !cleaned) {
      await dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'warning',
        title: translate(locale, 'cliMaintenance.quit.cleanupTitle'),
        message: translate(locale, 'cliMaintenance.quit.cleanupMessage'),
        buttons: [translate(locale, 'cliMaintenance.quit.ok')],
        noLink: true,
      });
      return;
    }
    allowQuitDuringCliMaintenance = true;
    isQuitting = true;
    app.quit();
  } finally {
    cliMaintenanceQuitCoordinationInFlight = false;
  }
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
  stopNativeDeliveryService();
}

interface NativeDeliveryPayload {
  delivery_id: string;
  event_id: string;
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  task_id: string | null;
  session_id: string | null;
  action_type: string | null;
  action_payload: string | null;
}

async function postNotificationApi<T>(
  port: number,
  route: string,
  payload: unknown,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http');
  const body = JSON.stringify(payload);
  return new Promise<T>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-CodePilot-Consumer': 'electron-main',
      },
    }, (res: import('http').IncomingMessage) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`notification API ${route} returned ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(responseBody) as T); }
        catch { reject(new Error(`notification API ${route} returned invalid JSON`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('notification API timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * One native owner for the entire app lifetime. Visibility changes never
 * transfer ownership to the renderer, so an event cannot be shown twice at
 * the visible/hidden boundary.
 */
function startNativeDeliveryService(): void {
  if (nativeDeliveryTimer) return;
  const poll = async () => {
    if (nativeDeliveryPolling) return;
    nativeDeliveryPolling = true;
    const port = serverPort;
    if (!port) {
      nativeDeliveryPolling = false;
      return;
    }
    try {
      const claimed = await postNotificationApi<{ delivery: NativeDeliveryPayload | null }>(
        port,
        '/api/tasks/notify/claim',
        { channel: 'electron-native', owner: nativeDeliveryOwner },
      );
      const delivery = claimed.delivery;
      if (!delivery) return;

      const action: NotificationClickAction = {
        taskId: delivery.task_id || undefined,
        sessionId: delivery.session_id || undefined,
        event_id: delivery.event_id,
        route: resolveNotificationActionRoute(delivery.action_type, delivery.action_payload),
      };
      const supported = Notification.isSupported();
      // Electron's macOS implementation requires a code-signed application.
      // `electron:dev` runs the unsigned Electron.app, whose `show` event can
      // fire without anything reaching Notification Center on Electron 40.
      // Fail closed instead of persisting a fake delivered receipt. Release
      // builds remain subject to the signed-package smoke gate.
      const unavailableReason = process.platform === 'darwin' && !app.isPackaged
        ? NATIVE_NOTIFICATION_ERROR.macosUnsignedDevelopment
        : undefined;
      const notification = supported && !unavailableReason
        ? new Notification(buildNativeNotificationOptions(process.platform, delivery.title, delivery.body || ''))
        : null;
      if (notification) {
        nativeNotificationRetention.retain(notification);
        notification.once('close', () => nativeNotificationRetention.release(notification));
      }
      const outcome = await deliverNativeNotification({
        platform: process.platform,
        supported,
        notification,
        unavailableReason,
        onClick: () => {
          if (notification) nativeNotificationRetention.release(notification);
          showMainWindow();
          notificationClickQueue.push(action);
        },
      });
      if (outcome.status === 'error' && notification) {
        nativeNotificationRetention.release(notification);
      }
      await postNotificationApi(port, '/api/tasks/notify/ack', {
        delivery_id: delivery.delivery_id,
        owner: nativeDeliveryOwner,
        channel: 'electron-native',
        outcome: outcome.status,
        error: outcome.status === 'error' ? outcome.error : undefined,
        retryable: outcome.status === 'error' ? outcome.retryable : false,
      });
      console.log(`[notify] native delivery event_id=${delivery.event_id} outcome=${outcome.status}`);
    } catch (error) {
      console.warn('[notify] native delivery poll failed:', error instanceof Error ? error.message : String(error));
    } finally {
      nativeDeliveryPolling = false;
    }
  };
  void poll();
  nativeDeliveryTimer = setInterval(() => { void poll(); }, 2_000);
}

function stopNativeDeliveryService(): void {
  if (nativeDeliveryTimer) {
    clearInterval(nativeDeliveryTimer);
    nativeDeliveryTimer = null;
  }
  nativeDeliveryPolling = false;
  nativeNotificationRetention.clear();
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

      // Database health is independent of the port. Retrying every stable
      // port would create duplicate backups and keep the user waiting.
      if (msg.includes(DATABASE_STARTUP_MARKER)) throw err;

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
        `Server process exited with code ${serverExitCode}.\n\n${serverErrors.toArray().join('\n')}`
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
        }, (res: {
          statusCode?: number;
          on: (event: string, listener: (chunk?: Buffer) => void) => void;
          resume: () => void;
        }) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve();
            return;
          }
          let body = '';
          res.on('data', (chunk?: Buffer) => {
            if (chunk && body.length < 2_048) {
              body += chunk.toString('utf8').slice(0, 2_048 - body.length);
            }
          });
          res.on('end', () => {
            if (body.includes(DATABASE_STARTUP_MARKER)) {
              const code = body.match(/"code":"([a-z_]+)"/)?.[1] ?? 'database_unavailable';
              const preservation = body.match(/"preservation":"([a-z_]+)"/)?.[1] ?? 'failed';
              reject(new Error(`${DATABASE_STARTUP_MARKER} code=${code} preservation=${preservation}`));
              return;
            }
            reject(new Error(`Status ${res.statusCode}`));
          });
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
      // The health route already returned a complete, path-free startup
      // classification. Retrying the same blocked process for 30 seconds only
      // delays the recovery UI and cannot make a process-stable DB fault heal.
      if (lastError.includes(DATABASE_STARTUP_MARKER)) throw err;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error(
    `Server startup timeout after ${timeout / 1000}s.\n\nLast health-check error: ${lastError}\n\n${serverErrors.length > 0 ? 'Server output:\n' + serverErrors.recent(10).join('\n') : 'No server output captured.'}`
  );
}

function serverRecoveryLocale(): string {
  try { return app.getLocale(); } catch { return 'en'; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureRecoverableRoute(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !serverPort) return;
  try {
    const current = new URL(mainWindow.webContents.getURL());
    if (current.protocol !== 'http:' || current.hostname !== '127.0.0.1') return;
    if (current.port !== String(serverPort)) return;
    lastRecoverableRoute = `${current.pathname}${current.search}${current.hash}` || '/';
  } catch {
    // data: loading/recovery pages are intentionally ignored.
  }
}

function showServerRecoveryPage(
  state: ServerRecoveryPageState,
  attempt: number,
  reasonCode: string,
): void {
  lastServerFailureReason = reasonCode;
  lastServerRecoveryAttempt = attempt;
  lastServerRecoveryPageState = state;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  activeServerRecoveryDataUrl = buildServerRecoveryDataUrl({
    locale: serverRecoveryLocale(),
    state,
    attempt,
    reasonCode,
  });
  void mainWindow?.loadURL(activeServerRecoveryDataUrl);
  mainWindow?.show();
}

function parseDatabaseStartupBlock(message: string): {
  code: string;
  preservation: string;
  pageState: ServerRecoveryPageState;
} | null {
  if (!message.includes(DATABASE_STARTUP_MARKER)) return null;
  const code = message.match(/code=([a-z_]+)/)?.[1] ?? 'database_unavailable';
  const preservation = message.match(/preservation=([a-z_]+)/)?.[1] ?? 'failed';
  const pageState: ServerRecoveryPageState = code === 'database_corrupt'
    ? 'database'
    : code === 'database_fresh_start_conflict'
      ? 'database-fresh-start-conflict'
    : code === 'database_migration_failed' || code === 'database_runtime_recovery_failed'
      ? 'database-migration'
      : 'database-retryable';
  return { code, preservation, pageState };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function serverRecoveryDiagnostics(): string {
  const system = process.getSystemMemoryInfo();
  return JSON.stringify({
    schema: 1,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    state: serverSupervisor.state,
    safeMode: serverSupervisor.safeMode,
    reason: lastServerFailureReason,
    attempt: lastServerRecoveryAttempt,
    exitCode: serverExitCode,
    generation: activeServerGeneration,
    systemMemoryKb: {
      total: system.total,
      free: system.free,
      available: system.available,
      swapTotal: system.swapTotal,
      swapFree: system.swapFree,
    },
    utilityMemoryBytes: lastServerRuntimeMetrics
      ? {
          rss: lastServerRuntimeMetrics.rssBytes,
          heapUsed: lastServerRuntimeMetrics.heapUsedBytes,
          heapTotal: lastServerRuntimeMetrics.heapTotalBytes,
          heapLimit: lastServerRuntimeMetrics.heapLimitBytes,
          external: lastServerRuntimeMetrics.externalBytes,
          arrayBuffers: lastServerRuntimeMetrics.arrayBuffersBytes,
        }
      : null,
    electronUtilityMetric: lastServerProcessMetric,
    databaseStartupDiagnostic: lastDatabaseStartupDiagnostic,
    serverHealthDiagnostic: lastServerHealthDiagnostic,
  }, null, 2);
}

async function runServerRecovery(initialGeneration: number, initialReason: string): Promise<void> {
  let failedGeneration = initialGeneration;
  let failureReason = initialReason;

  for (;;) {
    if (isQuitting || serverLifecyclePhase === 'quitting' || !serverPort) return;

    const decision = serverSupervisor.recordUnexpectedExit();
    const ownership = serverDescendantRegistries
      .get(failedGeneration)
      ?.evaluateRestartOwnership(isPidAlive)
      ?? { allowed: true as const, reason: 'ownership_clear' as const, livePids: [] };

    if (!ownership.allowed) {
      serverSupervisor.markFailed();
      console.warn('[server-supervisor] automatic restart blocked', {
        generation: failedGeneration,
        reason: ownership.reason,
        liveDescendantCount: ownership.livePids.length,
      });
      showServerRecoveryPage('blocked', Math.min(decision.attempt, 3), ownership.reason);
      return;
    }
    if (!decision.allowed || decision.delayMs === null) {
      console.warn('[server-supervisor] automatic restart budget exhausted', {
        generation: failedGeneration,
        attempt: decision.attempt,
      });
      showServerRecoveryPage('failed', 3, decision.reason);
      return;
    }

    showServerRecoveryPage('recovering', decision.attempt, failureReason);
    console.warn('[server-supervisor] recovery scheduled', {
      generation: failedGeneration,
      attempt: decision.attempt,
      delayMs: decision.delayMs,
      safeMode: true,
    });
    await sleep(decision.delayMs);
    if (isQuitting || serverLifecyclePhase === 'quitting' || !serverPort) return;

    try {
      serverSupervisor.markRecovering();
      serverLifecyclePhase = 'recovering';
      const recoveryChild = startServer(serverPort, true);
      serverProcess = recoveryChild;
      failedGeneration = activeServerGeneration;
      await waitForServer(serverPort);
      await reconcileCliMaintenanceAfterServerReady();
      console.log('[server-supervisor] recovery healthy', {
        generation: activeServerGeneration,
        safeMode: true,
      });
      // Keep the offline surface visible briefly so safe-mode recovery is an
      // honest user-visible state, then restore only a validated local route.
      await sleep(750);
      if (mainWindow && !mainWindow.isDestroyed()) {
        activeServerRecoveryDataUrl = null;
        await mainWindow.loadURL(`http://127.0.0.1:${serverPort}${lastRecoverableRoute}`);
      }
      serverSupervisor.markHealthy();
      serverLifecyclePhase = 'running';
      if (serverProcess !== recoveryChild || serverExited) {
        // The exit handler may have queued this same generation after the
        // phase flipped to running. This recovery loop already owns it.
        queuedServerRecovery = null;
        serverLifecyclePhase = 'recovering';
        throw new Error('Recovered utility process exited before handoff');
      }
      startNativeDeliveryService();
      return;
    } catch (error) {
      failureReason = 'safe_mode_restart_failed';
      console.warn('[server-supervisor] recovery attempt failed', {
        generation: failedGeneration,
        reason: error instanceof Error ? error.name : 'unknown_error',
      });
      // Loop back through the same ownership and bounded-budget gates.
    }
  }
}

function finishServerRecoveryRun(): void {
  serverRecoveryPromise = null;
  const queued = queuedServerRecovery;
  queuedServerRecovery = null;
  if (queued && !isQuitting && serverLifecyclePhase === 'running') {
    beginServerRecovery(queued.generation, queued.reason);
  }
}

function beginServerRecovery(generation: number, reason: string): void {
  if (isQuitting || serverLifecyclePhase !== 'running') return;
  if (serverRecoveryPromise) {
    queuedServerRecovery = { generation, reason };
    return;
  }
  captureRecoverableRoute();
  stopNativeDeliveryService();
  serverLifecyclePhase = 'recovering';
  serverRecoveryPromise = runServerRecovery(generation, reason).finally(finishServerRecoveryRun);
}

async function retryInitialServerStartupFromUser(): Promise<void> {
  showServerRecoveryPage('recovering', 1, 'manual_database_retry');
  try {
    const port = await startServerOnStablePort();
    serverPort = port;
    serverSupervisor.markHealthy();
    serverLifecyclePhase = 'running';
    activeServerRecoveryDataUrl = null;
    void mainWindow?.loadURL(`http://127.0.0.1:${port}${lastRecoverableRoute}`);
    startNativeDeliveryService();
    initializeAutoUpdaterForWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const databaseBlock = parseDatabaseStartupBlock(message);
    serverPort = null;
    serverSupervisor.markFailed();
    serverLifecyclePhase = 'recovering';
    if (databaseBlock) {
      console.warn(`[database-recovery] retry code=${databaseBlock.code} preservation=${databaseBlock.preservation}`);
      showServerRecoveryPage(
        databaseBlock.pageState,
        1,
        `${databaseBlock.code}:${databaseBlock.preservation}`,
      );
      return;
    }
    console.warn('[database-recovery] manual retry failed', {
      reason: error instanceof Error ? error.name : 'unknown_error',
    });
    showServerRecoveryPage('failed', 1, 'manual_retry_failed');
  }
}

function retryServerRecoveryFromUser(): boolean {
  if (serverRecoveryPromise || isQuitting) return false;
  serverSupervisor.resetRestartBudgetForManualRetry();
  serverLifecyclePhase = 'recovering';
  serverRecoveryPromise = (serverPort
    ? runServerRecovery(activeServerGeneration, 'manual_retry')
    : retryInitialServerStartupFromUser())
    .finally(finishServerRecoveryRun);
  return true;
}

function startServer(port: number, recoverySafeMode = false): Electron.UtilityProcess {
  const standaloneDir = path.join(process.resourcesPath, 'standalone');
  const serverPath = path.join(standaloneDir, 'server.js');

  console.log(`Server path: ${serverPath}`);
  console.log(`Standalone dir: ${standaloneDir}`);

  serverErrors.clear();
  lastDatabaseStartupDiagnostic = null;
  lastServerHealthDiagnostic = null;
  serverExited = false;
  serverExitCode = null;
  lastServerRuntimeMetrics = null;
  lastServerProcessMetric = null;
  const generation = ++nextServerGeneration;
  activeServerGeneration = generation;
  serverDescendantRegistries.set(generation, new ServerDescendantRegistry(generation));
  if (recoverySafeMode) serverSupervisor.markRecovering();
  else serverSupervisor.markStarting();
  let childFailureReason = 'server_exit';
  let childFailureReported = false;

  const home = os.homedir();
  const constructedPath = getExpandedShellPath();
  const cliMaintenanceBootstrap = getCliMaintenanceBootstrapLease();

  const env = buildProxySafeEnvironment({
    // Ensure user shell env vars override inherited values (especially API
    // keys). On Windows loadUserShellEnv() is empty, so inherited process.env
    // remains the explicit-proxy source of truth.
    baseEnv: {
      ...sanitizedProcessEnv(),
      ...userShellEnv,
    },
    // Chromium's system proxy is only a fallback. The shared helper checks all
    // upper/lower-case proxy keys before applying it, then ensures loopback
    // traffic cannot be sent through Clash/Surge/etc.
    fallbackProxyEnv: resolvedProxyEnv,
    overrides: {
      ...macosKeychainEnvironment,
      ...providerSecretEnvironment,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      CLAUDE_GUI_DATA_DIR: codePilotDataDir,
      HOME: home,
      USERPROFILE: home,
      PATH: constructedPath,
      CODEPILOT_SERVER_GENERATION: String(generation),
      CODEPILOT_RECOVERY_SAFE_MODE: recoverySafeMode ? '1' : '0',
      ...(cliMaintenanceBootstrap ? {
        CODEPILOT_CLI_MAINTENANCE_PROVIDER: cliMaintenanceBootstrap.provider,
        CODEPILOT_CLI_MAINTENANCE_LEASE_ID: cliMaintenanceBootstrap.leaseId,
      } : {}),
    },
    platform: process.platform,
  }) as Record<string, string>;

  // Use Electron's utilityProcess to run the server in a child process
  // without spawning a separate Dock icon on macOS.
  const child = utilityProcess.fork(serverPath, [], {
    env,
    cwd: standaloneDir,
    stdio: 'pipe',
    serviceName: 'codepilot-server',
  });

  const reportUtilityFailureOnce = (reason: string, exitCode?: number | null): void => {
    if (
      childFailureReported
      || !electronTelemetry.enabled
      || isDev
      || isQuitting
      || (serverLifecyclePhase !== 'running' && !recoverySafeMode)
    ) return;
    const system = process.getSystemMemoryInfo();
    const event = buildUtilityProcessFailureEvent({
      reason,
      exitCode,
      platform: process.platform,
      utilityRssBytes: lastServerRuntimeMetrics?.rssBytes,
      utilityHeapUsedBytes: lastServerRuntimeMetrics?.heapUsedBytes,
      utilityHeapTotalBytes: lastServerRuntimeMetrics?.heapTotalBytes,
      utilityHeapLimitBytes: lastServerRuntimeMetrics?.heapLimitBytes,
      utilityExternalBytes: lastServerRuntimeMetrics?.externalBytes,
      utilityArrayBuffersBytes: lastServerRuntimeMetrics?.arrayBuffersBytes,
      hostTotalKb: system.total,
      hostFreeKb: system.free,
      hostAvailableKb: system.available,
      hostSwapTotalKb: system.swapTotal,
      hostSwapFreeKb: system.swapFree,
    });
    if (!event) return;
    childFailureReported = true;
    Sentry.captureEvent(event);
  };

  child.on('message', (rawMessage) => {
    if (activeServerGeneration !== generation || serverProcess !== child) return;
    const lifecycle = parseServerDescendantLifecycleMessage(rawMessage);
    if (lifecycle) {
      if (lifecycle.generation !== generation) return;
      serverDescendantRegistries.get(generation)?.apply(lifecycle);
      console.log('[server-lifecycle] descendant update', {
        generation,
        action: lifecycle.action,
        role: lifecycle.role,
        executableBasename: lifecycle.executableBasename,
        descendantsVerifiable: lifecycle.descendantsVerifiable,
      });
      return;
    }

    const metrics = parseServerRuntimeObservabilityMessage(rawMessage);
    if (!metrics || metrics.generation !== generation) return;
    lastServerRuntimeMetrics = metrics;
    const system = process.getSystemMemoryInfo();
    const processMetric = child.pid
      ? app.getAppMetrics().find((entry) => entry.pid === child.pid)
      : undefined;
    lastServerProcessMetric = processMetric
      ? {
          workingSetKb: processMetric.memory.workingSetSize,
          peakWorkingSetKb: processMetric.memory.peakWorkingSetSize,
          privateKb: processMetric.memory.privateBytes ?? null,
          creationTime: processMetric.creationTime,
          cpuPercent: processMetric.cpu.percentCPUUsage,
        }
      : null;
    console.log('[server-observability] sample', {
      generation,
      utilityRssBytes: metrics.rssBytes,
      utilityHeapUsedBytes: metrics.heapUsedBytes,
      utilityHeapTotalBytes: metrics.heapTotalBytes,
      utilityHeapLimitBytes: metrics.heapLimitBytes,
      utilityExternalBytes: metrics.externalBytes,
      utilityArrayBuffersBytes: metrics.arrayBuffersBytes,
      electronWorkingSetKb: lastServerProcessMetric?.workingSetKb ?? null,
      electronPeakWorkingSetKb: lastServerProcessMetric?.peakWorkingSetKb ?? null,
      electronPrivateKb: lastServerProcessMetric?.privateKb ?? null,
      electronCreationTime: lastServerProcessMetric?.creationTime ?? null,
      electronCpuPercent: lastServerProcessMetric?.cpuPercent ?? null,
      hostTotalKb: system.total,
      hostFreeKb: system.free,
      hostAvailableKb: system.available,
      hostSwapTotalKb: system.swapTotal,
      hostSwapFreeKb: system.swapFree,
    });
  });

  child.on('error', (type, _location, report) => {
    // Electron's native diagnostic report can contain command lines and paths.
    // Persist only the typed event and the most recent allowlisted numeric
    // sample; the raw report deliberately never enters the support log.
    void report;
    childFailureReason = type === 'FatalError' ? 'utility_fatal_error' : 'utility_error';
    lastServerFailureReason = childFailureReason;
    const system = process.getSystemMemoryInfo();
    console.error('[server-supervisor] utility fatal error', {
      generation,
      type,
      utilityRssBytes: lastServerRuntimeMetrics?.rssBytes ?? null,
      utilityHeapUsedBytes: lastServerRuntimeMetrics?.heapUsedBytes ?? null,
      utilityHeapTotalBytes: lastServerRuntimeMetrics?.heapTotalBytes ?? null,
      utilityHeapLimitBytes: lastServerRuntimeMetrics?.heapLimitBytes ?? null,
      hostTotalKb: system.total,
      hostFreeKb: system.free,
      hostAvailableKb: system.available,
      hostSwapTotalKb: system.swapTotal,
      hostSwapFreeKb: system.swapFree,
    });
    reportUtilityFailureOnce(childFailureReason);
  });

  child.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    console.log(`[server] ${msg}`);
    serverErrors.push(msg);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    const diagnosticIndex = msg.lastIndexOf(DATABASE_STARTUP_DIAGNOSTIC_MARKER);
    if (diagnosticIndex >= 0) {
      lastDatabaseStartupDiagnostic = msg
        .slice(diagnosticIndex)
        .split(/\r?\n/, 1)[0]
        .slice(0, 1_024);
    }
    const healthDiagnosticIndex = msg.lastIndexOf(SERVER_HEALTH_DIAGNOSTIC_MARKER);
    if (healthDiagnosticIndex >= 0) {
      lastServerHealthDiagnostic = msg
        .slice(healthDiagnosticIndex)
        .split(/\r?\n/, 1)[0]
        .slice(0, 1_024);
    }
    if (msg.includes(DATABASE_STARTUP_MARKER)) {
      childFailureReason = 'database_startup_blocked';
      lastServerFailureReason = childFailureReason;
    }
    console.error(`[server:err] ${msg}`);
    serverErrors.push(msg);
  });

  child.on('exit', (code) => {
    const reason = childFailureReason === 'server_exit' ? `server_exit_${code}` : childFailureReason;
    console.log(`Server process exited with code ${code}`);
    serverExited = true;
    serverExitCode = code;
    if (serverProcess === child) serverProcess = null;
    const telemetryReason = childFailureReason === 'server_exit'
      ? 'unexpected_exit'
      : childFailureReason;
    reportUtilityFailureOnce(telemetryReason, code);
    if (!isDev && !isQuitting && serverLifecyclePhase === 'running') {
      beginServerRecovery(generation, reason);
    }
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

/**
 * Give every editable renderer surface the platform-native editing menu.
 *
 * Chromium does not add a copy/paste context menu to Electron inputs by
 * default. Keeping this in the main process covers ordinary inputs,
 * textareas and contenteditable editors (including CodeMirror) without each
 * React component having to reimplement clipboard behavior. Electron roles
 * also supply native labels, shortcuts and enablement semantics per platform.
 */
function attachRendererEditingContextMenu(targetWindow: BrowserWindow): void {
  targetWindow.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.length > 0;
    const isPassword = params.inputFieldType === 'password';

    if (!params.isEditable && !hasSelection) return;

    const template: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'undo', enabled: params.editFlags.canUndo },
          { role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          {
            role: 'cut',
            enabled: !isPassword && params.editFlags.canCut,
          },
          {
            role: 'copy',
            enabled: !isPassword && params.editFlags.canCopy,
          },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { role: 'delete', enabled: params.editFlags.canDelete },
          { type: 'separator' },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll },
        ]
      : [
          { role: 'copy', enabled: hasSelection },
          { type: 'separator' },
          { role: 'selectAll' },
        ];

    Menu.buildFromTemplate(template).popup({ window: targetWindow });
  });
}

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
      sandbox: true,
      webviewTag: true,
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
    // Default material:
    //   - `'under-window'` keeps the native translucent backing while
    //     preserving more background definition than the heavier
    //     `'menu'` material. The user selected this after a same-window
    //     visual comparison on 2026-07-30.
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
      : 'under-window';
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
  setUpdaterWindow(mainWindow);
  setCliMaintenanceWindow(mainWindow);
  attachRendererEditingContextMenu(mainWindow);
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const partition = typeof params.partition === 'string' ? params.partition : '';
    if (
      !issuedBrowserPartitions.has(partition)
      || !isAllowedBrowserGuestUrl(params.src)
    ) {
      event.preventDefault();
      return;
    }

    // Renderer controls presentation only. A guest never receives the host
    // preload or any Node/IPC capability, even if host DOM is compromised.
    delete webPreferences.preload;
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.webviewTag = false;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
  mainWindow.webContents.on('did-start-loading', () => {
    // A navigation replaces the renderer and its IPC listeners. Hold native
    // notification clicks until the new AppShell explicitly announces that
    // its route listener is installed.
    notificationClickQueue.setReady(false);
  });

  // External links: open in system default browser instead of Electron
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      openExternalInSystemBrowser(targetUrl);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    // Policy lives in a pure, unit-tested helper (src/lib/navigation-policy).
    // In-app navigation is allowed ONLY for same-origin http/https. The
    // startup splash is a `data:` page whose origin serializes to "null", so
    // an origin-only same-origin check would let data:/file:/javascript:/
    // vscode: targets masquerade as same-origin and skip the http/https
    // external-link whitelist. Non-web targets are blocked outright and never
    // reach shell.openExternal (which would let AI-authored content launch OS
    // protocol handlers). (audit 2026-07 finding 1.7 + Codex Loop-1 review)
    const decision = classifyNavigation(mainWindow!.webContents.getURL(), targetUrl);
    if (decision === 'allow-in-app') return;
    event.preventDefault();
    if (decision === 'open-external') {
      openExternalInSystemBrowser(targetUrl);
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
  // hidden. Native notification delivery is owned by Electron Main for the
  // whole app lifetime and does not change with window visibility.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    notificationClickQueue.setReady(false);
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

    // B-025: rotate the active file past MAIN_LOG_MAX_BYTES (keeping a small
    // ring of archives) instead of appending forever. The writer also rotates a
    // leftover over-cap file (the 12 GB case) before this session's first write.
    const logWriter = createRotatingLogWriter({
      activeLogFile,
      maxBytes: MAIN_LOG_MAX_BYTES,
      maxArchives: MAIN_LOG_MAX_ARCHIVES,
    });
    mainLogWriter = logWriter;
    activeMainLogPath = activeLogFile;
    const sessionMarker = rotationCompleted
      ? `\n=== session start ${new Date().toISOString()} (sanitized) ===\n`
      : `\n=== session start ${new Date().toISOString()} (sanitized — fallback file; rotation pending) ===\n`;
    logWriter.write(sessionMarker);

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

    console.log = (...args: unknown[]) => { logWriter.write(fmt('log', args)); origLog(...args); };
    console.warn = (...args: unknown[]) => { logWriter.write(fmt('warn', args)); origWarn(...args); };
    console.error = (...args: unknown[]) => { logWriter.write(fmt('error', args)); origError(...args); };
  } catch (err) {
    // Logging is best-effort — don't block app startup if disk is full / readonly.

    console.warn('Failed to set up persistent main log:', err);
  }
}

// ── Single-instance lock (Windows multi-tray / multi-process feedback) ──────
// Without this, relaunching CodePilot (double-clicking the shortcut, reopening
// from the tray, etc.) starts a SECOND main process — each with its own tray
// icon and background Next server — which is the duplicate-tray + multiple-
// background-task report on Windows. Acquire the lock before app init; a losing
// second instance quits immediately and hands focus back to the primary via the
// 'second-instance' event. macOS already single-instances .app bundles, so the
// lock is a harmless no-op there.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Not the primary — bail before spinning up a duplicate tray/server. A bare
  // app.quit() is correct here; do NOT set isQuitting (that flag drives the
  // PRIMARY's teardown path).
  app.quit();
} else {
  app.on('second-instance', () => {
    // User tried to launch another copy — surface the existing window instead
    // (respects the menubar-resident hide-on-close model).
    showMainWindow();
  });
}

// B-025 P1 — crash/exit breadcrumb. Writes a typed size/memory summary through
// the rotating writer (a synchronous fd, so it lands on disk before an imminent
// exit AND honors rotation + byte accounting); falls back to a direct sync
// append only if the writer isn't up yet (a crash during early startup). Never
// logs full command / path / API key — a typed summary that still runs through
// sanitizeLogLine.
function logCrashBreadcrumb(kind: string, detail: Record<string, unknown> = {}): void {
  try {
    let activeLogBytes: number | null = null;
    try {
      if (activeMainLogPath && fs.existsSync(activeMainLogPath)) {
        activeLogBytes = fs.statSync(activeMainLogPath).size;
      }
    } catch { /* ignore */ }
    const mem = process.memoryUsage();
    const payload = {
      kind,
      ...detail,
      activeLogBytes,
      writerBytes: mainLogWriter?.currentBytes() ?? null,
      serverErrorsLines: serverErrors.length,
      serverErrorsBytes: serverErrors.byteLength,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
    };
    const line = `${new Date().toISOString()} [crash] ${sanitizeLogLine('[crash-breadcrumb] ' + JSON.stringify(payload))}\n`;
    // Prefer the rotating writer (synchronous fd — rotation + byte-accounting
    // aware); fall back to a direct synchronous append only if it isn't set up.
    if (mainLogWriter) {
      mainLogWriter.write(line);
    } else if (activeMainLogPath) {
      try { fs.appendFileSync(activeMainLogPath, line); } catch { /* best-effort */ }
    }
    try { process.stderr.write(line); } catch { /* best-effort */ }
  } catch { /* a breadcrumb must never throw */ }
}

function registerCrashBreadcrumbs(): void {
  // READ-ONLY breadcrumbs — they must NOT change crash/exit semantics (B-025
  // review). A plain `uncaughtException` listener SUPPRESSES Node's default
  // fatal exit, turning a crash into a zombie main process stuck in a corrupt
  // state — the exact failure mode we want to diagnose, not introduce. So we
  // use `uncaughtExceptionMonitor`, which runs purely for observation and leaves
  // the default fatal handling (and Sentry's handler) untouched.
  process.on('uncaughtExceptionMonitor', (err) => {
    logCrashBreadcrumb('uncaughtException', { name: err?.name, message: String(err?.message ?? '').slice(0, 200) });
  });
  // Deliberately NO plain `unhandledRejection` listener: adding one would
  // suppress the process's default unhandled-rejection policy. In Node's 'throw'
  // mode an unhandled rejection escalates to an uncaughtException — already
  // recorded by the monitor above; in 'warn' mode it isn't a crash. Either way
  // the existing policy stays intact.
  app.on('child-process-gone', (_event, details) => {
    logCrashBreadcrumb('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
  });
  app.on('render-process-gone', (_event, _webContents, details) => {
    logCrashBreadcrumb('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
  });
}

app.whenReady().then(async () => {
  // A losing second instance is on its way out via app.quit() above — don't
  // initialize tray/server/windows in it.
  if (!gotSingleInstanceLock) return;

  // Set up persistent main-process log first so subsequent startup
  // logs (env load, ABI check, server boot) are captured.
  setupPersistentMainLog();

  // B-025: register crash/exit breadcrumbs now that the log writer + active-log
  // path exist, so the next crash near the Codex approval path leaves size /
  // memory evidence instead of vanishing.
  registerCrashBreadcrumbs();

  if (nativeCrashSmokeEnabled) {
    console.log('[telemetry-smoke] native crash fixture armed');
    setTimeout(() => process.crash(), 3_000);
    return;
  }

  // Load user's full shell environment (API keys, PATH, etc.)
  userShellEnv = loadUserShellEnv();

  // Electron owns OS credential-store access. The standalone Next child gets
  // only the in-memory data-encryption key; the database never stores it. A
  // packaged recovery smoke may bypass this only when its userData is under
  // the dedicated disposable temp root, so an ad-hoc test build never touches
  // the developer's real `CodePilot Safe Storage` item.
  const skipProviderSecretForSmoke = shouldSkipProviderSecretForIsolatedSmoke({
    flag: process.env[PROVIDER_SECRET_ISOLATED_SMOKE_ENV],
    isPackaged: app.isPackaged,
    userDataDir: app.getPath('userData'),
  });
  if (skipProviderSecretForSmoke) {
    providerSecretEnvironment = {};
    macosKeychainEnvironment = {};
    console.warn('[provider-secret] safeStorage skipped for isolated packaged recovery smoke');
  } else {
    const macosKeychainProbe = getMacosDefaultKeychainProbe();
    const macosSecurityShimDir = app.isPackaged
      ? path.join(process.resourcesPath, 'macos-keychain-guard')
      : path.join(app.getAppPath(), 'resources', 'macos-keychain-guard');
    macosKeychainEnvironment = buildMacosKeychainEnvironment(
      macosKeychainProbe,
      macosSecurityShimDir,
    );

    if (macosKeychainProbe.status === 'unavailable') {
      providerSecretEnvironment = {};
      console.warn(
        `[macos-keychain] default keychain unavailable; noninteractive guard enabled; reason=${macosKeychainProbe.reason}`,
      );
      console.warn('[provider-secret] safeStorage skipped; legacy provider secrets will not be migrated');
    } else {
      try {
        providerSecretEnvironment = initializeProviderSecretEnvironment(app.getPath('userData'));
        console.log(
          `[provider-secret] backend=${providerSecretEnvironment.CODEPILOT_PROVIDER_SECRET_BACKEND} `
          + `level=${providerSecretEnvironment.CODEPILOT_PROVIDER_SECRET_LEVEL}`,
        );
      } catch (error) {
        providerSecretEnvironment = {};
        console.warn('[provider-secret] OS-protected storage unavailable; legacy provider secrets will not be migrated', error);
      }
    }
  }

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

  // The renderer receives only a partition token and fixed guest preferences.
  // It cannot create arbitrary sessions, grant permissions or reach WebContents.
  ipcMain.handle('browser:get-config', (event: Electron.IpcMainInvokeEvent, workspaceId: unknown) => {
    if (!isTrustedMainWindowSender(event) || !isCanonicalBrowserWorkspaceId(workspaceId)) {
      return null;
    }
    const partition = deriveBrowserPartition(workspaceId);
    issuedBrowserPartitions.add(partition);
    configureBrowserPartition(partition);
    return {
      partition,
      webPreferences: BROWSER_WEB_PREFERENCES,
    };
  });

  ipcMain.handle('browser:open-external', (event: Electron.IpcMainInvokeEvent, targetUrl: unknown) => {
    if (
      !isTrustedMainWindowSender(event)
      || typeof targetUrl !== 'string'
      || !isSafeExternalBrowserUrl(targetUrl)
    ) {
      return false;
    }
    openExternalInSystemBrowser(targetUrl);
    return true;
  });

  // --- Install wizard IPC handlers ---

  ipcMain.handle('install:check-prerequisites', async () => {
    const expandedPath = getExpandedShellPath();
    const execEnv = { ...sanitizedProcessEnv(), ...userShellEnv, PATH: expandedPath };

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
      ...sanitizedProcessEnv(),
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
      installState.logs.push(line);
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
    installState.logs.push('Cancelling installation...');

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
      installState.logs.push('Installation process terminated.');
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
      const execEnv = { ...sanitizedProcessEnv(), ...userShellEnv, PATH: expandedPath };

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

  // Narrow Codex recovery capability: fixed official command, no arguments.
  // The command is copied but never passed to PowerShell, pasted or executed.
  ipcMain.handle('codex:prepare-windows-recovery', async (event: Electron.IpcMainInvokeEvent) => {
    if (
      process.platform !== 'win32'
      || event.sender !== mainWindow?.webContents
      || !isTrustedCodexRecoverySender(event.sender.getURL(), serverPort)
    ) {
      return { ok: false, copied: false, opened: false, error: 'unsupported_or_untrusted' };
    }

    let copied = false;
    try {
      const install = selectCodexWindowsInstallCommand(findWindowsNpmCommand());
      clipboard.writeText(install.command);
      copied = true;
      const spec = buildCodexPowerShellLaunchSpec();
      const launcher = spawn(spec.command, spec.args, {
        windowsHide: spec.windowsHide,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        shell: spec.shell,
        stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        launcher.once('error', reject);
        launcher.once('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`powershell_launcher_exit:${code ?? 'unknown'}`));
        });
      });
      console.log(`[codex-recovery] copied=true opened=true install_method=${install.method}`);
      return { ok: true, copied: true, opened: true, installMethod: install.method };
    } catch (error) {
      console.warn('[codex-recovery] copied command but PowerShell open failed', error);
      return {
        ok: false,
        copied,
        opened: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // AI-authored paths never enter a generic shell.openPath bridge. Reveal is
  // non-launching, and the only launching path is a workspace-scoped HTML
  // file that has passed the server + main-process realpath checks.
  ipcMain.handle('shell:reveal-path', async (
    event: Electron.IpcMainInvokeEvent,
    request: ScopedSystemPathRequest,
  ) => {
    const resolved = await resolveScopedSystemPath(event, request, 'reveal');
    if ('error' in resolved) return resolved.error;
    shell.showItemInFolder(resolved.realPath);
    return '';
  });
  ipcMain.handle('shell:open-html-file', async (
    event: Electron.IpcMainInvokeEvent,
    request: ScopedSystemPathRequest,
  ) => {
    const resolved = await resolveScopedSystemPath(event, request, 'open-html');
    if ('error' in resolved) return resolved.error;
    return shell.openPath(resolved.realPath);
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

  ipcMain.handle('app:get-default-assistant-home', async () => {
    return resolveDefaultAssistantHome(app.getPath('documents'));
  });

  // Keep the NSVisualEffectView appearance aligned with the renderer's
  // next-themes mode. Without this bridge, an app-level dark selection can
  // sit over a light native material (or vice versa), which previously led us
  // to hide the mismatch behind an almost-opaque CSS tint.
  ipcMain.handle('theme:set-source', (_event, source: unknown) => {
    if (!isNativeThemeSource(source)) return false;
    nativeTheme.themeSource = source;
    return true;
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

  // --- Asset Library HTML thumbnail capture ---
  // The Gallery never embeds archived HTML. It asks this isolated window to
  // paint one bounded frame, persists the returned PNG through the scoped
  // Asset API, then renders only that static image on subsequent visits.
  // Calls are serialized so opening a library with legacy HTML Assets cannot
  // create a burst of hidden Chromium renderers.
  const htmlThumbnailCaptureQueue = new SerializedDeadlineQueue();
  ipcMain.handle('asset:capture-html-thumbnail', async (
    event,
    params: { previewUrl?: unknown; width?: unknown; height?: unknown },
  ) => {
    let captureWindow: BrowserWindow | null = null;
    try {
      return await htmlThumbnailCaptureQueue.run(async () => {
        const senderUrl = new URL(event.sender.getURL());
        const width = params.width === undefined ? 1280 : Number(params.width);
        const height = params.height === undefined ? 720 : Number(params.height);
        if (
          senderUrl.protocol !== 'http:'
          || senderUrl.hostname !== '127.0.0.1'
          || typeof params.previewUrl !== 'string'
          || params.previewUrl.length > 16_384
          || !Number.isInteger(width)
          || !Number.isInteger(height)
          || width !== 1280
          || height !== 720
        ) {
          return { error: 'invalid_request' as const };
        }
        const targetUrl = new URL(params.previewUrl, senderUrl.origin);
        if (
          targetUrl.origin !== senderUrl.origin
          || targetUrl.searchParams.has('interactive')
        ) {
          return { error: 'invalid_preview_url' as const };
        }
        let requestScope: ReturnType<typeof deriveHtmlThumbnailRequestScope>;
        try {
          requestScope = deriveHtmlThumbnailRequestScope(targetUrl);
        } catch {
          return { error: 'invalid_preview_url' as const };
        }
        const partition = `asset-thumbnail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const captureSession = session.fromPartition(partition, { cache: false });
        captureSession.setPermissionCheckHandler(() => false);
        captureSession.setPermissionRequestHandler(
          (_webContents, _permission, callback) => callback(false),
        );
        captureSession.webRequest.onBeforeRequest(
          {
            urls: ['<all_urls>'],
          },
          (details, callback) => {
            callback({
              cancel: !isHtmlThumbnailRequestAllowed(details.url, requestScope),
            });
          },
        );

        captureWindow = new BrowserWindow({
          show: false,
          width,
          height,
          backgroundColor: '#ffffff',
          paintWhenInitiallyHidden: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
            partition,
          },
        });
        captureWindow.webContents.on('will-navigate', (navigationEvent) => {
          navigationEvent.preventDefault();
        });
        captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        try {
          await captureWindow.loadURL(targetUrl.toString());
          await captureWindow.webContents.insertCSS(`
            html, body {
              width: 1280px !important;
              height: 720px !important;
              overflow: hidden !important;
              scrollbar-width: none !important;
            }
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
              caret-color: transparent !important;
            }
            ::-webkit-scrollbar { display: none !important; }
          `);
          await Promise.race([
            captureWindow.webContents.executeJavaScript(`
              Promise.all([
                document.fonts ? document.fonts.ready : Promise.resolve(),
                ...Array.from(document.images).map((image) =>
                  image.complete
                    ? Promise.resolve()
                    : new Promise((resolve) => {
                        image.addEventListener('load', resolve, { once: true });
                        image.addEventListener('error', resolve, { once: true });
                      })
                ),
              ]).then(() => true)
            `),
            new Promise((resolve) => setTimeout(resolve, 2500)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 150));
          const image = await captureWindow.webContents.capturePage({
            x: 0,
            y: 0,
            width,
            height,
          });
          const resized = image.resize({ width, height, quality: 'best' });
          return {
            base64: resized.toPNG().toString('base64'),
            width,
            height,
          };
        } finally {
          if (captureWindow && !captureWindow.isDestroyed()) {
            captureWindow.destroy();
          }
          captureWindow = null;
          captureSession.webRequest.onBeforeRequest(null);
          captureSession.setPermissionCheckHandler(null);
          captureSession.setPermissionRequestHandler(null);
        }
      }, {
        timeoutMs: HTML_THUMBNAIL_CAPTURE_TIMEOUT_MS,
        onTimeout: () => {
          if (captureWindow && !captureWindow.isDestroyed()) {
            captureWindow.webContents.stop();
            captureWindow.destroy();
          }
          captureWindow = null;
        },
      });
    } catch (error) {
      console.warn(
        '[asset:capture-html-thumbnail] capture failed:',
        error instanceof Error ? error.message : String(error),
      );
      return {
        error: error instanceof HtmlThumbnailCaptureTimeoutError
          ? 'capture_timeout' as const
          : 'capture_failed' as const,
      };
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
    // NOTE: no `outPath`. The renderer must NOT name an arbitrary filesystem
    // path here — a compromised renderer could overwrite any file with PNG
    // bytes. The handler only returns base64; the renderer saves it via a Blob
    // download (src/lib/artifact-export.ts). (audit 2026-07 finding 1.1)
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

      // Always return base64 to the renderer; never write to a
      // renderer-supplied path (removed — audit 2026-07 finding 1.1). The
      // renderer saves via a Blob download in src/lib/artifact-export.ts.
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
    // Validate before spawning (stability audit ⑦): a non-string/duplicate id
    // would poison the id→terminal map or clobber a live terminal, and a
    // missing cwd would spawn in the wrong place or throw an ambiguous ENOENT.
    const validation = validateTerminalCreateOpts(opts, {
      idExists: (id) => terminalManager.has(id),
      cwdIsDirectory: (cwd) => {
        try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
      },
    });
    if (!validation.ok) {
      console.warn(`[terminal:create] rejected (${validation.error}): ${validation.detail}`);
      return { ok: false as const, error: validation.error, detail: validation.detail };
    }
    terminalManager.create(opts.id, {
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: userShellEnv,
    });
    return { ok: true as const };
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

  // Notification ownership is deliberately one-way: the renderer may listen
  // for clicks but cannot ask Main to show arbitrary native notifications.
  ipcMain.on('notification:renderer-ready', () => {
    notificationClickQueue.setReady(true);
  });

  // Proxy resolution IPC — allows renderer/API routes to query system proxy
  ipcMain.handle('proxy:resolve', async (_event, url: string) => {
    try {
      return await session.defaultSession.resolveProxy(url);
    } catch {
      return 'DIRECT';
    }
  });

  const isTrustedServerRecoverySender = (event: Electron.IpcMainInvokeEvent): boolean => (
    !!mainWindow
    && !mainWindow.isDestroyed()
    && activeServerRecoveryDataUrl !== null
    && event.sender === mainWindow.webContents
    && event.sender.getURL() === activeServerRecoveryDataUrl
  );
  ipcMain.handle('server-recovery:copy-diagnostics', (event) => {
    if (!isTrustedServerRecoverySender(event)) return false;
    clipboard.writeText(serverRecoveryDiagnostics());
    return true;
  });
  ipcMain.handle('server-recovery:retry', (event) => {
    if (
      !isTrustedServerRecoverySender(event)
      || ['database', 'database-fresh-start-conflict'].includes(lastServerRecoveryPageState)
    ) return false;
    return retryServerRecoveryFromUser();
  });
  ipcMain.handle('server-recovery:restart-app', (event) => {
    if (
      !isTrustedServerRecoverySender(event)
      || lastServerRecoveryPageState === 'blocked'
      || ['database', 'database-fresh-start-conflict'].includes(lastServerRecoveryPageState)
    ) return false;
    isQuitting = true;
    serverLifecyclePhase = 'quitting';
    app.relaunch();
    app.quit();
    return true;
  });
  ipcMain.handle('server-recovery:quit-app', (event) => {
    if (
      !isTrustedServerRecoverySender(event)
      || !['blocked', 'database', 'database-retryable', 'database-migration', 'database-fresh-start-conflict'].includes(lastServerRecoveryPageState)
    ) return false;
    // These offline pages intentionally expose plain quit separately from
    // restart. In the blocked descendant case the user must clean up the old
    // process tree manually; DB fault pages also keep quit non-destructive.
    serverLifecyclePhase = 'quitting';
    quitApp();
    return true;
  });
  ipcMain.handle('server-recovery:open-database-backups', async (event) => {
    if (!isTrustedServerRecoverySender(event) || lastServerRecoveryPageState !== 'database') return false;
    const recoveryRoot = path.join(codePilotDataDir, DATABASE_RECOVERY_DIRNAME);
    if (!fs.existsSync(recoveryRoot)) return false;
    return (await shell.openPath(recoveryRoot)) === '';
  });
  ipcMain.handle('server-recovery:start-fresh-database', async (event) => {
    if (!isTrustedServerRecoverySender(event) || lastServerRecoveryPageState !== 'database') return false;
    const zh = serverRecoveryLocale().toLowerCase().startsWith('zh');
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: zh ? '新建空数据库' : 'Start with a new database',
      message: zh
        ? '这会先再次完整备份现有数据库，然后让 CodePilot 创建一个空数据库。'
        : 'CodePilot will make another complete backup, then create an empty database.',
      detail: zh
        ? '原聊天、服务商和设置不会导入空数据库，但会保留在时间戳备份中。只有备份校验成功后才会继续。'
        : 'Existing chats, providers and settings will not be imported into the empty database, but remain in the timestamped backup. This continues only after the backup is verified.',
      buttons: [zh ? '取消' : 'Cancel', zh ? '备份并新建' : 'Back up and start fresh'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return false;
    const databasePath = path.join(codePilotDataDir, 'codepilot.db');
    const result = prepareFreshDatabase(databasePath);
    if (result.status !== 'complete') {
      dialog.showErrorBox(
        zh ? '无法安全新建数据库' : 'Could not safely create a new database',
        zh
          ? '完整备份未能验证。CodePilot 不会继续。请打开备份目录手工恢复。'
          : 'A complete backup could not be verified. CodePilot will not continue. Open the backup folder for manual recovery.',
      );
      return false;
    }
    isQuitting = true;
    serverLifecyclePhase = 'quitting';
    app.relaunch();
    app.quit();
    return true;
  });
  ipcMain.handle('server-recovery:keep-restored-database', (event) => {
    if (
      !isTrustedServerRecoverySender(event)
      || lastServerRecoveryPageState !== 'database-fresh-start-conflict'
    ) return false;
    const databasePath = path.join(codePilotDataDir, 'codepilot.db');
    try {
      cancelFreshDatabaseIntent(databasePath);
      return retryServerRecoveryFromUser();
    } catch {
      return false;
    }
  });
  ipcMain.handle('server-recovery:continue-fresh-database', async (event) => {
    if (
      !isTrustedServerRecoverySender(event)
      || lastServerRecoveryPageState !== 'database-fresh-start-conflict'
    ) return false;
    const zh = serverRecoveryLocale().toLowerCase().startsWith('zh');
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: zh ? '继续新建空数据库' : 'Continue with an empty database',
      message: zh
        ? '当前数据库文件是在上次确认新建空库后出现的。继续会删除这些当前文件。'
        : 'The current database files appeared after the previous empty-database confirmation. Continuing will delete these current files.',
      detail: zh
        ? 'CodePilot 会先重新校验上次生成的完整备份；备份缺失或被修改时不会删除任何文件。'
        : 'CodePilot will first re-verify the complete backup from the prior confirmation. Nothing is deleted if that backup is missing or changed.',
      buttons: [zh ? '取消' : 'Cancel', zh ? '校验备份并继续' : 'Verify backup and continue'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return false;
    const databasePath = path.join(codePilotDataDir, 'codepilot.db');
    try {
      continueFreshDatabaseIntent(databasePath);
      return retryServerRecoveryFromUser();
    } catch {
      dialog.showErrorBox(
        zh ? '无法安全继续' : 'Could not continue safely',
        zh
          ? '上次的完整备份无法重新校验。当前数据库文件没有被删除。'
          : 'The prior complete backup could not be re-verified. The current database files were not deleted.',
      );
      return false;
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
      serverSupervisor.markHealthy();
      serverLifecyclePhase = 'running';
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

    startNativeDeliveryService();
    initializeAutoUpdaterForWindow();

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const databaseBlock = parseDatabaseStartupBlock(message);
    if (databaseBlock) {
      console.warn(`[database-recovery] code=${databaseBlock.code} preservation=${databaseBlock.preservation}`);
      serverPort = null;
      serverSupervisor.markFailed();
      serverLifecyclePhase = 'recovering';
      showServerRecoveryPage(
        databaseBlock.pageState,
        0,
        `${databaseBlock.code}:${databaseBlock.preservation}`,
      );
      return;
    }
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

  // Recreating a destroyed window must never bypass a failed/recovering
  // supervisor and silently launch a normal-mode utility process.
  if (!isDev && (serverLifecyclePhase === 'recovering' || serverSupervisor.state === 'failed')) {
    showMainWindow();
    return;
  }

  try {
    if (!isDev && !serverProcess) {
      // Show loading window immediately so user sees progress
      createWindow();
      const port = await startServerOnStablePort();
      serverPort = port;
      serverSupervisor.markHealthy();
      serverLifecyclePhase = 'running';
      startNativeDeliveryService();
      initializeAutoUpdaterForWindow();
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

// electron-updater closes windows before Electron emits app.before-quit.
// Raise the lifecycle fence on the updater-specific event so the resident
// close handler cannot convert installation into a hidden-window no-op.
nativeAutoUpdater.on('before-quit-for-update', () => {
  updaterInstallLifecycleArmed = true;
  isQuitting = true;
  serverLifecyclePhase = 'quitting';
});

app.on('before-quit', async (e) => {
  if (isCliMaintenanceRunning() && !allowQuitDuringCliMaintenance) {
    e.preventDefault();
    void coordinateQuitDuringCliMaintenance();
    return;
  }
  // First firing: tear down resources, then re-emit quit. Any subsequent
  // firing (after we re-call app.quit() below) just proceeds to exit. The
  // `isQuitting` flag also tells the main window's `close` handler to let
  // the close go through instead of hiding.
  appQuitTeardownStarted = true;
  isQuitting = true;
  serverLifecyclePhase = 'quitting';
  serverSupervisor.markStopped();
  stopNativeDeliveryService();
  disposeAutoUpdaterTimers();

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
