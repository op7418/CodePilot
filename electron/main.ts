import { app, BrowserWindow, nativeImage, dialog, session } from 'electron';
import path from 'path';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let serverErrors: string[] = [];
let userShellEnv: Record<string, string> = {};

const isDev = !app.isPackaged;

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
 * When Electron is launched from Dock/Finder, process.env is very limited
 * and won't include vars from .zshrc/.bashrc (e.g. API keys).
 */
function loadUserShellEnv(): Record<string, string> {
  // Only macOS needs login-shell env loading; Windows/Linux GUI apps inherit full env
  if (process.platform !== 'darwin') {
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

function getPort(): Promise<number> {
  return new Promise((resolve, reject) => {
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

async function waitForServer(port: number, timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // If the server process already exited, fail fast
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(
        `Server process exited with code ${serverProcess.exitCode}.\n\n${serverErrors.join('\n')}`
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const req = require('http').get(`http://127.0.0.1:${port}/api/health`, (res: { statusCode?: number }) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(
    `Server startup timeout after ${timeout / 1000}s.\n\n${serverErrors.length > 0 ? 'Server output:\n' + serverErrors.slice(-10).join('\n') : 'No server output captured.'}`
  );
}

function startServer(port: number): ChildProcess {
  const standaloneDir = path.join(process.resourcesPath, 'standalone');
  const serverPath = path.join(standaloneDir, 'server.js');

  // Always use Electron's built-in Node.js in packaged mode.
  // electron-builder's @electron/rebuild compiles native modules (better-sqlite3)
  // for Electron's Node ABI, so we must use the matching runtime.
  const nodePath = process.execPath;

  console.log(`Using Node.js: ${nodePath}`);
  console.log(`Server path: ${serverPath}`);
  console.log(`Standalone dir: ${standaloneDir}`);

  serverErrors = [];

  const home = os.homedir();
  const shellPath = userShellEnv.PATH || process.env.PATH || '';
  const sep = path.delimiter; // ';' on Windows, ':' on Unix

  let constructedPath: string;
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
    constructedPath = [...new Set(allParts)].join(sep);
  } else {
    const basePath = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
    const raw = `${basePath}:${home}/.npm-global/bin:${home}/.local/bin:${home}/.claude/bin:${shellPath}`;
    const allParts = raw.split(':').filter(Boolean);
    constructedPath = [...new Set(allParts)].join(':');
  }

  const env: Record<string, string> = {
    ...userShellEnv,
    ...(process.env as Record<string, string>),
    // Ensure user shell env vars override (especially API keys)
    ...userShellEnv,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    CLAUDE_GUI_DATA_DIR: path.join(home, '.codepilot'),
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    USERPROFILE: home,
    PATH: constructedPath,
  };

  // On Windows, spawn Node.js directly with windowsHide to prevent console flash.
  // On macOS, spawn via /bin/sh to prevent the Electron binary from appearing
  // as a separate Dock icon (even with ELECTRON_RUN_AS_NODE=1).
  let child: ChildProcess;
  if (process.platform === 'win32') {
    child = spawn(nodePath, [serverPath], {
      env,
      stdio: 'pipe',
      cwd: standaloneDir,
      windowsHide: true,
    });
  } else {
    child = spawn('/bin/sh', ['-c', `exec "${nodePath}" "${serverPath}"`], {
      env,
      stdio: 'pipe',
      cwd: standaloneDir,
    });
  }

  child.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    console.log(`[server] ${msg}`);
    serverErrors.push(msg);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    console.error(`[server:err] ${msg}`);
    serverErrors.push(msg);
  });

  child.on('exit', (code) => {
    console.log(`Server process exited with code ${code}`);
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
  return path.join(process.resourcesPath, 'icon.icns');
}

/**
 * Fetch proxy settings from the CodePilot API and apply them
 * to Electron's default session so renderer network requests
 * (e.g. remote images in markdown) also route through the proxy.
 */
async function applyProxySettings(port: number): Promise<void> {
  try {
    const http = require('http');
    const data: string = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/settings/app`, (res: { statusCode?: number; on: Function }) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    const parsed = JSON.parse(data);
    const settings = parsed?.settings || {};

    if (settings.proxy_enabled === 'true' && settings.proxy_url) {
      const proxyUrl = settings.proxy_url;
      const bypass = settings.proxy_bypass || 'localhost,127.0.0.1';
      // Electron's setProxy expects proxyRules in the format: scheme://host:port
      await session.defaultSession.setProxy({
        proxyRules: proxyUrl,
        proxyBypassRules: bypass,
      });
      console.log(`[proxy] Electron session proxy set to ${proxyUrl} (bypass: ${bypass})`);
    } else {
      // Ensure proxy is cleared if disabled
      await session.defaultSession.setProxy({ mode: 'direct' as never });
      console.log('[proxy] Electron session proxy: direct (no proxy)');
    }
  } catch (err) {
    console.warn('[proxy] Failed to apply Electron session proxy:', err);
  }
}

function createWindow(port: number) {
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 860,
    minWidth: 800,
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
  } else if (process.platform === 'win32') {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.titleBarOverlay = {
      color: '#00000000',
      symbolColor: '#888888',
      height: 44,
    };
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Load user's full shell environment (API keys, PATH, etc.)
  userShellEnv = loadUserShellEnv();

  // Verify native module ABI compatibility before starting the server
  checkNativeModuleABI();

  // Set macOS Dock icon
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getIconPath();
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  try {
    let port: number;

    if (isDev) {
      port = 3000;
      console.log(`Dev mode: connecting to http://127.0.0.1:${port}`);
    } else {
      port = await getPort();
      console.log(`Starting server on port ${port}...`);
      serverProcess = startServer(port);
      await waitForServer(port);
      console.log('Server is ready');
    }

    serverPort = port;
    await applyProxySettings(port);
    createWindow(port);
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
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      if (!isDev && !serverProcess) {
        const port = await getPort();
        serverProcess = startServer(port);
        await waitForServer(port);
        serverPort = port;
      }
      await applyProxySettings(serverPort || 3000);
      createWindow(serverPort || 3000);
    } catch (err) {
      console.error('Failed to restart server:', err);
    }
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
