import {
  app,
  BrowserWindow,
  nativeImage,
  dialog,
  session,
  utilityProcess,
  ipcMain,
  shell,
  Tray,
  Menu,
} from "electron";
import path from "path";
import { execFileSync, spawn, ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";

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
    if (!key.startsWith("__NEXT_PRIVATE_") && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: Electron.UtilityProcess | null = null;
let serverPort: number | null = null;
let serverErrors: string[] = [];
let serverExited = false;
let serverExitCode: number | null = null;
let userShellEnv: Record<string, string> = {};
let isQuitting = false;
let tray: Tray | null = null;

// --- Install orchestrator ---
interface InstallStep {
  id: string;
  label: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  error?: string;
}

interface InstallState {
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  currentStep: string | null;
  steps: InstallStep[];
  logs: string[];
}

let installState: InstallState = {
  status: "idle",
  currentStep: null,
  steps: [],
  logs: [],
};

let installProcess: ChildProcess | null = null;

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
          if (process.platform === "win32") {
            spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
              stdio: "ignore",
            });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch {
          /* already dead */
        }
      }
      serverProcess = null;
      resolve();
    }, 3000);

    serverProcess.on("exit", () => {
      clearTimeout(timeout);
      serverProcess = null;
      resolve();
    });

    // On Windows, SIGTERM is not supported — use taskkill to kill the tree
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
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
    const http = require("http");
    return await new Promise<boolean>((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${serverPort}/api/bridge`,
        (res: {
          statusCode?: number;
          on: (event: string, cb: (data?: Buffer) => void) => void;
        }) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve(data.running === true);
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on("error", () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
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
    const http = require("http");
    await new Promise<void>((resolve) => {
      const postData = JSON.stringify({ action: "stop" });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: serverPort,
          path: "/api/bridge",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        () => {
          resolve();
        },
      );
      req.on("error", () => resolve());
      req.setTimeout(3000, () => {
        req.destroy();
        resolve();
      });
      req.write(postData);
      req.end();
    });
  } catch {
    // ignore — bridge may already be stopped
  }
}

/**
 * Create a system tray icon for background bridge mode.
 * Called when all windows are closed but the bridge is still active.
 */
function createTray(): void {
  if (tray) return;

  const iconPath = getIconPath();
  const trayIcon = nativeImage
    .createFromPath(iconPath)
    .resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip("CodePilot — Bridge Active");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open CodePilot",
      click: () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow(`http://127.0.0.1:${serverPort || 3000}`);
        } else {
          mainWindow?.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Bridge Status: Active",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Stop Bridge & Quit",
      click: async () => {
        await stopBridge();
        destroyTray();
        await killServer();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click on tray icon opens the window (macOS/Windows)
  tray.on("double-click", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(`http://127.0.0.1:${serverPort || 3000}`);
    } else {
      mainWindow?.focus();
    }
  });
}

function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
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

  const standaloneDir = path.join(process.resourcesPath, "standalone");

  // Find better_sqlite3.node recursively
  function findNodeFile(dir: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findNodeFile(fullPath);
        if (found) return found;
      } else if (entry.name === "better_sqlite3.node") {
        return fullPath;
      }
    }
    return null;
  }

  const nodeFile = findNodeFile(path.join(standaloneDir, "node_modules"));
  if (!nodeFile) {
    console.warn(
      "[ABI check] better_sqlite3.node not found in standalone resources",
    );
    return;
  }

  try {
    // Attempt to load the native module to verify ABI compatibility
    process.dlopen({ exports: {} } as NodeModule, nodeFile);
    console.log(
      `[ABI check] better_sqlite3.node ABI is compatible (${nodeFile})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("NODE_MODULE_VERSION")) {
      console.error(`[ABI check] ABI mismatch detected: ${msg}`);
      dialog.showErrorBox(
        "CodePilot - Native Module ABI Mismatch",
        `The bundled better-sqlite3 native module was compiled for a different Node.js version.\n\n` +
          `${msg}\n\n` +
          `This usually means the build process did not correctly recompile native modules for Electron.\n` +
          `Please rebuild the application or report this issue.`,
      );
      app.quit();
    } else {
      // Other load errors (missing dependencies, etc.) -- log but don't block
      console.warn(`[ABI check] Could not verify better_sqlite3.node: ${msg}`);
    }
  }
}

function parseEnvOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      env[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return env;
}

/**
 * Resolve system proxy for api.anthropic.com using Electron's built-in proxy
 * resolution (same engine as Chromium). Works cross-platform: macOS, Windows,
 * Linux — including PAC files and WinHTTP settings.
 *
 * Must be called after app.whenReady() so session is available.
 */
async function getProxyEnvFromSystem(): Promise<Record<string, string>> {
  try {
    const result = await session.defaultSession.resolveProxy(
      "https://api.anthropic.com",
    );
    // result format: "PROXY host:port" | "DIRECT" | "PROXY h1:p1; PROXY h2:p2"
    const match = result.match(/PROXY\s+([^;\s]+)/i);
    if (match) {
      const proxyUrl = `http://${match[1]}`;
      console.log(`Resolved system proxy for api.anthropic.com: ${proxyUrl}`);
      return {
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
      };
    }
  } catch (err) {
    console.warn("Failed to resolve system proxy:", err);
  }
  return {};
}

/**
 * Read the user's full shell environment by running a login shell.
 * When Electron is launched from Dock/Finder (macOS) or desktop launcher
 * (Linux), process.env is very limited and won't include vars from
 * .zshrc/.bashrc (e.g. API keys, nvm PATH, HTTPS_PROXY).
 *
 * Uses a two-level cascade to handle slow shell startup (e.g. oh-my-zsh):
 * 1. Non-interactive login shell (fast, ~1s)
 * 2. Interactive login shell (slower, handles oh-my-zsh etc.)
 *
 * Proxy fallback is handled separately via getProxyEnvFromSystem() after
 * app.whenReady() — cross-platform and more reliable than shell/scutil.
 */
function loadUserShellEnv(): Record<string, string> {
  // Windows GUI apps inherit the full user environment from the system
  if (process.platform === "win32") {
    return {};
  }
  const shell = process.env.SHELL || "/bin/zsh";

  // Method 1: non-interactive login shell (fast)
  try {
    const result = execFileSync(shell, ["-lc", "env"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const env = parseEnvOutput(result);
    console.log(
      `Loaded ${Object.keys(env).length} env vars from user shell (non-interactive)`,
    );
    return env;
  } catch {
    /* fall through */
  }

  // Method 2: full interactive login shell (slower, handles oh-my-zsh etc.)
  try {
    const result = execFileSync(shell, ["-ilc", "env"], {
      timeout: 10000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const env = parseEnvOutput(result);
    console.log(
      `Loaded ${Object.keys(env).length} env vars from user shell (interactive)`,
    );
    return env;
  } catch (err) {
    console.warn("Failed to load user shell env from login shell:", err);
  }

  return {};
}

/**
 * Build an expanded PATH that includes common locations for node, npm globals,
 * claude, nvm, homebrew, etc. Shared by the server launcher and install orchestrator.
 */
function getExpandedShellPath(): string {
  const home = os.homedir();
  const shellPath = userShellEnv.PATH || process.env.PATH || "";
  const sep = path.delimiter;

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const winExtra = [
      path.join(appData, "npm"),
      path.join(localAppData, "npm"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".claude", "bin"),
    ];
    const allParts = [shellPath, ...winExtra]
      .join(sep)
      .split(sep)
      .filter(Boolean);
    return [...new Set(allParts)].join(sep);
  } else {
    const basePath = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
    const raw = `${basePath}:${home}/.npm-global/bin:${home}/.local/bin:${home}/.claude/bin:${shellPath}`;
    const allParts = raw.split(":").filter(Boolean);
    return [...new Set(allParts)].join(":");
  }
}

function getPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
  });
}

async function waitForServer(port: number, timeout = 30000): Promise<void> {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeout) {
    // If the server process already exited, fail fast
    if (serverExited) {
      throw new Error(
        `Server process exited with code ${serverExitCode}.\n\n${serverErrors.join("\n")}`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require("http");
        // Use options object with family:4 to force IPv4 — avoids Windows
        // IPv6 resolution issues where 127.0.0.1 may fail to connect.
        const req = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/health",
            family: 4,
            timeout: 2000,
          },
          (res: { statusCode?: number }) => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`Status ${res.statusCode}`));
          },
        );
        req.on("error", (err: Error) => reject(err));
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("request timeout"));
        });
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(
    `Server startup timeout after ${timeout / 1000}s.\n\nLast health-check error: ${lastError}\n\n${serverErrors.length > 0 ? "Server output:\n" + serverErrors.slice(-10).join("\n") : "No server output captured."}`,
  );
}

function startServer(port: number): Electron.UtilityProcess {
  const standaloneDir = path.join(process.resourcesPath, "standalone");
  const serverPath = path.join(standaloneDir, "server.js");

  console.log(`Server path: ${serverPath}`);
  console.log(`Standalone dir: ${standaloneDir}`);

  serverErrors = [];
  serverExited = false;
  serverExitCode = null;

  const home = os.homedir();
  const constructedPath = getExpandedShellPath();

  const env: Record<string, string> = {
    ...userShellEnv,
    ...sanitizedProcessEnv(),
    // Ensure user shell env vars override (especially API keys)
    ...userShellEnv,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    CLAUDE_GUI_DATA_DIR: path.join(home, ".codepilot"),
    HOME: home,
    USERPROFILE: home,
    PATH: constructedPath,
  };

  // Use Electron's utilityProcess to run the server in a child process
  // without spawning a separate Dock icon on macOS.
  const child = utilityProcess.fork(serverPath, [], {
    env,
    cwd: standaloneDir,
    stdio: "pipe",
    serviceName: "codepilot-server",
  });

  child.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    console.log(`[server] ${msg}`);
    serverErrors.push(msg);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    console.error(`[server:err] ${msg}`);
    serverErrors.push(msg);
  });

  child.on("exit", (code) => {
    console.log(`Server process exited with code ${code}`);
    serverExited = true;
    serverExitCode = code;
    serverProcess = null;
  });

  return child;
}

function getIconPath(): string {
  if (isDev) {
    return path.join(process.cwd(), "build", "icon.png");
  }
  if (process.platform === "win32") {
    return path.join(process.resourcesPath, "icon.ico");
  }
  if (process.platform === "linux") {
    return path.join(process.resourcesPath, "icon.png");
  }
  return path.join(process.resourcesPath, "icon.icns");
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
    minWidth: 800,
    minHeight: 600,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (process.platform === "darwin") {
    windowOptions.titleBarStyle = "hiddenInset";
  } else if (process.platform === "win32") {
    windowOptions.titleBarStyle = "hidden";
    windowOptions.titleBarOverlay = {
      color: "#00000000",
      symbolColor: "#888888",
      height: 44,
    };
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadURL(url || LOADING_HTML);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Load user's full shell environment (API keys, PATH, etc.)
  userShellEnv = loadUserShellEnv();

  // If shell env has no proxy, fall back to system proxy resolution.
  // Uses Electron's built-in Chromium proxy engine — cross-platform
  // (macOS scutil, Windows WinHTTP/IE settings, Linux gsettings, PAC files).
  if (!userShellEnv.HTTPS_PROXY && !userShellEnv.https_proxy) {
    const systemProxy = await getProxyEnvFromSystem();
    Object.assign(userShellEnv, systemProxy);
  }

  // Last fallback: read proxy from ~/.claude/settings.json env field.
  // This allows users to configure proxy via the CodePilot settings UI,
  // persisted as HTTPS_PROXY in the CLI settings env object.
  if (!userShellEnv.HTTPS_PROXY && !userShellEnv.https_proxy) {
    try {
      const claudeSettingsPath = path.join(
        os.homedir(),
        ".claude",
        "settings.json",
      );
      if (fs.existsSync(claudeSettingsPath)) {
        const raw = fs.readFileSync(claudeSettingsPath, "utf-8");
        const parsed = JSON.parse(raw);
        const envProxy = parsed?.env?.HTTPS_PROXY || parsed?.env?.https_proxy;
        if (envProxy) {
          userShellEnv.HTTPS_PROXY = envProxy;
          userShellEnv.https_proxy = envProxy;
          userShellEnv.HTTP_PROXY = envProxy;
          userShellEnv.http_proxy = envProxy;
          console.log(`Loaded proxy from ~/.claude/settings.json: ${envProxy}`);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Verify native module ABI compatibility before starting the server
  checkNativeModuleABI();

  // Clear cache on version upgrade
  const currentVersion = app.getVersion();
  const versionFilePath = path.join(
    app.getPath("userData"),
    "last-version.txt",
  );
  try {
    const lastVersion = fs.existsSync(versionFilePath)
      ? fs.readFileSync(versionFilePath, "utf-8").trim()
      : "";
    if (lastVersion && lastVersion !== currentVersion) {
      console.log(
        `Version changed from ${lastVersion} to ${currentVersion}, clearing cache...`,
      );
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({
        storages: ["cachestorage", "serviceworkers"],
      });
      console.log("Cache cleared successfully");
    }
    fs.writeFileSync(versionFilePath, currentVersion, "utf-8");
  } catch (err) {
    console.warn("Failed to check/clear version cache:", err);
  }

  // Set macOS Dock icon
  if (process.platform === "darwin" && app.dock) {
    const iconPath = getIconPath();
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // --- Install wizard IPC handlers ---

  ipcMain.handle("install:check-prerequisites", async () => {
    const expandedPath = getExpandedShellPath();
    const execEnv = {
      ...sanitizedProcessEnv(),
      ...userShellEnv,
      PATH: expandedPath,
    };
    const execOpts = {
      timeout: 5000,
      encoding: "utf-8" as const,
      env: execEnv,
    };

    let hasNode = false;
    let nodeVersion: string | undefined;
    try {
      const result = execFileSync("node", ["--version"], execOpts);
      nodeVersion = result.trim();
      hasNode = true;
    } catch {
      // node not found
    }

    let hasClaude = false;
    let claudeVersion: string | undefined;
    try {
      const claudeOpts =
        process.platform === "win32" ? { ...execOpts, shell: true } : execOpts;
      const result = execFileSync("claude", ["--version"], claudeOpts);
      claudeVersion = result.trim();
      hasClaude = true;
    } catch {
      // claude not found
    }

    // Check Homebrew on macOS
    let hasHomebrew = false;
    if (process.platform === "darwin") {
      const brewPaths = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
      hasHomebrew = brewPaths.some((p) => fs.existsSync(p));
    }

    return {
      hasNode,
      nodeVersion,
      hasClaude,
      claudeVersion,
      hasHomebrew,
      platform: process.platform,
    };
  });

  ipcMain.handle(
    "install:start",
    (
      _event: Electron.IpcMainInvokeEvent,
      options?: { includeNode?: boolean },
    ) => {
      if (installState.status === "running") {
        throw new Error("Installation is already running");
      }

      const needsNode = options?.includeNode === true;

      // Reset state
      const steps: InstallStep[] = [];
      if (needsNode) {
        steps.push({
          id: "install-node",
          label: "Installing Node.js",
          status: "pending",
        });
      }
      steps.push(
        { id: "check-node", label: "Checking Node.js", status: "pending" },
        {
          id: "install-claude",
          label: "Installing Claude Code",
          status: "pending",
        },
        { id: "verify", label: "Verifying installation", status: "pending" },
      );

      installState = {
        status: "running",
        currentStep: null,
        steps,
        logs: [],
      };

      const expandedPath = getExpandedShellPath();
      const execEnv: Record<string, string> = {
        ...userShellEnv,
        ...sanitizedProcessEnv(),
        ...userShellEnv,
        PATH: expandedPath,
      };

      function sendProgress() {
        mainWindow?.webContents.send("install:progress", installState);
      }

      function setStep(
        id: string,
        status: InstallStep["status"],
        error?: string,
      ) {
        const step = installState.steps.find((s) => s.id === id);
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
          // Step 0 (optional): Install Node.js via package manager
          if (needsNode) {
            setStep("install-node", "running");

            const nodeInstalled = await new Promise<boolean>((resolve) => {
              const isWin = process.platform === "win32";
              const isMac = process.platform === "darwin";
              let cmd: string;
              let args: string[];

              if (isMac) {
                // macOS: Homebrew only — UI should guide the user to install Homebrew first
                const brewPaths = [
                  "/opt/homebrew/bin/brew",
                  "/usr/local/bin/brew",
                ];
                const brewPath = brewPaths.find((p) => fs.existsSync(p));
                if (brewPath) {
                  cmd = brewPath;
                  args = ["install", "node"];
                  addLog(`Running: ${brewPath} install node`);
                } else {
                  addLog(
                    "Homebrew is required. Please install Homebrew first and retry.",
                  );
                  resolve(false);
                  return;
                }
              } else if (isWin) {
                cmd = "winget";
                args = [
                  "install",
                  "-e",
                  "--id",
                  "OpenJS.NodeJS.LTS",
                  "--accept-source-agreements",
                  "--accept-package-agreements",
                ];
                addLog("Running: winget install -e --id OpenJS.NodeJS.LTS");
              } else {
                // Linux — no universal package manager
                addLog(
                  "Auto-install of Node.js is not supported on this platform.",
                );
                resolve(false);
                return;
              }

              const child = spawn(cmd, args, {
                env: execEnv,
                shell: isWin,
                stdio: ["ignore", "pipe", "pipe"],
              });

              installProcess = child;

              child.stdout?.on("data", (data: Buffer) => {
                for (const line of data
                  .toString()
                  .split("\n")
                  .filter(Boolean)) {
                  addLog(line);
                }
              });
              child.stderr?.on("data", (data: Buffer) => {
                for (const line of data
                  .toString()
                  .split("\n")
                  .filter(Boolean)) {
                  addLog(line);
                }
              });
              child.on("error", (err) => {
                addLog(`Error: ${err.message}`);
                resolve(false);
              });
              child.on("close", (code) => {
                installProcess = null;
                resolve(code === 0);
              });
            });

            if (installState.status === "cancelled") {
              setStep("install-node", "failed", "Cancelled");
              return;
            }

            if (!nodeInstalled) {
              setStep(
                "install-node",
                "failed",
                "Could not auto-install Node.js.",
              );
              installState.status = "failed";
              sendProgress();
              return;
            }

            setStep("install-node", "success");
            addLog("Node.js installation completed.");
          }

          // Step 1: Check node
          setStep("check-node", "running");
          try {
            const nodeResult = execFileSync("node", ["--version"], {
              timeout: 5000,
              encoding: "utf-8",
              env: execEnv,
            });
            addLog(`Node.js found: ${nodeResult.trim()}`);
            setStep("check-node", "success");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog(`Node.js not found: ${msg}`);
            setStep(
              "check-node",
              "failed",
              "Node.js is not installed. Please install Node.js first.",
            );
            installState.status = "failed";
            sendProgress();
            return;
          }

          // Step 2: Install Claude Code via npm
          setStep("install-claude", "running");
          addLog("Running: npm install -g @anthropic-ai/claude-code");

          const npmInstallSuccess = await new Promise<boolean>((resolve) => {
            const isWin = process.platform === "win32";
            const npmCmd = isWin ? "npm.cmd" : "npm";

            const child = spawn(
              npmCmd,
              ["install", "-g", "@anthropic-ai/claude-code"],
              {
                env: execEnv,
                shell: isWin,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );

            installProcess = child;

            child.stdout?.on("data", (data: Buffer) => {
              const lines = data.toString().split("\n").filter(Boolean);
              for (const line of lines) {
                addLog(line);
              }
            });

            child.stderr?.on("data", (data: Buffer) => {
              const lines = data.toString().split("\n").filter(Boolean);
              for (const line of lines) {
                addLog(line);
              }
            });

            child.on("error", (err) => {
              addLog(`npm error: ${err.message}`);
              resolve(false);
            });

            child.on("close", (code) => {
              installProcess = null;
              if (code === 0) {
                addLog("npm install completed successfully");
                resolve(true);
              } else if (installState.status === "cancelled") {
                addLog("Installation was cancelled");
                resolve(false);
              } else {
                addLog(`npm install exited with code ${code}`);
                resolve(false);
              }
            });
          });

          if (installState.status === "cancelled") {
            setStep("install-claude", "failed", "Cancelled");
            return;
          }

          if (!npmInstallSuccess) {
            setStep(
              "install-claude",
              "failed",
              "npm install failed. Check logs for details.",
            );
            installState.status = "failed";
            sendProgress();
            return;
          }

          setStep("install-claude", "success");

          // Step 3: Verify claude is available
          setStep("verify", "running");
          try {
            const verifyOpts =
              process.platform === "win32"
                ? {
                    timeout: 5000,
                    encoding: "utf-8" as const,
                    env: execEnv,
                    shell: true,
                  }
                : { timeout: 5000, encoding: "utf-8" as const, env: execEnv };
            const claudeResult = execFileSync(
              "claude",
              ["--version"],
              verifyOpts,
            );
            addLog(`Claude Code installed: ${claudeResult.trim()}`);
            setStep("verify", "success");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog(`Verification failed: ${msg}`);
            setStep(
              "verify",
              "failed",
              "Claude Code was installed but could not be verified.",
            );
            installState.status = "failed";
            sendProgress();
            return;
          }

          installState.status = "success";
          installState.currentStep = null;
          sendProgress();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLog(`Unexpected error: ${msg}`);
          installState.status = "failed";
          sendProgress();
        }
      })();
    },
  );

  ipcMain.handle("install:cancel", () => {
    if (installState.status !== "running") {
      return;
    }

    installState.status = "cancelled";
    installState.logs.push("Cancelling installation...");

    if (installProcess) {
      const pid = installProcess.pid;
      try {
        if (process.platform === "win32" && pid) {
          // Windows: kill entire process tree (shell: true spawns cmd.exe which
          // spawns npm/winget — child.kill() only kills the shell, not the tree)
          spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
            stdio: "ignore",
          });
        } else {
          installProcess.kill();
        }
      } catch {
        // already dead
      }
      installProcess = null;
      installState.logs.push("Installation process terminated.");
    }

    mainWindow?.webContents.send("install:progress", installState);
  });

  ipcMain.handle("install:get-logs", () => {
    return installState.logs;
  });

  // --- End install wizard IPC handlers ---

  // Open a folder in the system file manager (Finder / Explorer)
  ipcMain.handle(
    "shell:open-path",
    async (_event: Electron.IpcMainInvokeEvent, folderPath: string) => {
      return shell.openPath(folderPath);
    },
  );

  // Bridge status IPC
  ipcMain.handle("bridge:is-active", async () => {
    return isBridgeActive();
  });

  // Native folder picker dialog
  ipcMain.handle(
    "dialog:open-folder",
    async (_event, options?: { defaultPath?: string; title?: string }) => {
      if (!mainWindow) return { canceled: true, filePaths: [] };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: options?.title || "Select a project folder",
        defaultPath: options?.defaultPath || undefined,
        properties: ["openDirectory", "createDirectory"],
      });
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
  );

  try {
    let port: number;

    if (isDev) {
      port = 3000;
      console.log(`Dev mode: connecting to http://127.0.0.1:${port}`);
      serverPort = port;
      createWindow(`http://127.0.0.1:${port}`);
    } else {
      port = await getPort();
      console.log(`Starting server on port ${port}...`);
      serverProcess = startServer(port);
      serverPort = port;

      // Show window immediately with loading screen
      createWindow();

      // Wait for server in background, then navigate to real URL
      await waitForServer(port);
      console.log("Server is ready");
      if (mainWindow) {
        mainWindow.loadURL(`http://127.0.0.1:${port}`);
      }

      // Trigger bridge auto-start via explicit POST (only checks setting once)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const http = require("http");
      const autoStartData = JSON.stringify({ action: "auto-start" });
      const autoStartReq = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/bridge",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(autoStartData),
          },
        },
        () => {},
      );
      autoStartReq.on("error", () => {});
      autoStartReq.write(autoStartData);
      autoStartReq.end();
    }
  } catch (err) {
    console.error("Failed to start:", err);
    dialog.showErrorBox(
      "CodePilot - Failed to Start",
      `The internal server could not start.\n\n${err instanceof Error ? err.message : String(err)}\n\nPlease try restarting the application.`,
    );
    app.quit();
  }
});

app.on("window-all-closed", async () => {
  // If bridge is active, keep the server running and show a tray icon
  const bridgeActive = await isBridgeActive();
  if (bridgeActive) {
    console.log(
      "Bridge is active — keeping server alive in background with tray icon",
    );
    createTray();
    return;
  }

  destroyTray();
  await killServer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  // If tray is active (bridge background mode), destroy it when user re-opens
  destroyTray();

  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      if (!isDev && !serverProcess) {
        const port = await getPort();
        serverProcess = startServer(port);
        // Show loading window immediately
        createWindow();
        await waitForServer(port);
        serverPort = port;
        if (mainWindow) {
          mainWindow.loadURL(`http://127.0.0.1:${port}`);
        }
      } else {
        createWindow(`http://127.0.0.1:${serverPort || 3000}`);
      }
    } catch (err) {
      console.error("Failed to restart server:", err);
    }
  }
});

app.on("before-quit", async (e) => {
  // Kill any running install process (tree-kill on Windows)
  if (installProcess) {
    const pid = installProcess.pid;
    try {
      if (process.platform === "win32" && pid) {
        spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
          stdio: "ignore",
        });
      } else {
        installProcess.kill();
      }
    } catch {
      /* already dead */
    }
    installProcess = null;
  }

  destroyTray();

  if (serverProcess && !isQuitting) {
    isQuitting = true;
    e.preventDefault();
    // Stop bridge gracefully before killing the server
    await stopBridge();
    await killServer();
    app.quit();
  }
});
