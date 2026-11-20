import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCodexPowerShellLaunchSpec,
  CODEX_WINDOWS_INSTALL_COMMAND,
  CODEX_WINDOWS_NPM_INSTALL_COMMAND,
  findWindowsNpmCommand,
  isTrustedCodexRecoverySender,
  selectCodexWindowsInstallCommand,
} from '../../../electron/codex-windows-recovery';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Codex recovery commands are fixed and PowerShell receives no installer argv', () => {
  assert.equal(CODEX_WINDOWS_INSTALL_COMMAND, 'irm https://chatgpt.com/codex/install.ps1 | iex');
  assert.equal(CODEX_WINDOWS_NPM_INSTALL_COMMAND, 'npm.cmd install -g @openai/codex');
  const launch = buildCodexPowerShellLaunchSpec('win32', 'C:\\Windows');
  assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(launch.args[3], /^"start "" "C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoExit"$/);
  assert.equal(launch.windowsHide, true);
  assert.equal(launch.shell, false);
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.equal(launch.args.some(arg => arg.includes('install.ps1') || arg.includes('@openai/codex')), false);
  assert.equal(selectCodexWindowsInstallCommand('C:\\Program Files\\nodejs\\npm.cmd').method, 'npm');
  assert.equal(selectCodexWindowsInstallCommand(null).method, 'standalone_script');
});

test('npm discovery is Windows-only, PATH-aware and injectable', () => {
  const expected = 'C:\\Program Files\\nodejs\\npm.cmd';
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  };
  assert.equal(findWindowsNpmCommand(env, candidate => candidate === expected, 'win32'), expected);
  assert.equal(findWindowsNpmCommand(env, () => true, 'darwin'), null);
});

test('Codex recovery is Windows-only and trusts only the current loopback renderer port', () => {
  assert.throws(() => buildCodexPowerShellLaunchSpec('darwin'), /unsupported_platform/);
  assert.equal(isTrustedCodexRecoverySender('http://127.0.0.1:3000/settings/runtime', 3000), true);
  assert.equal(isTrustedCodexRecoverySender('http://localhost:3000/settings/runtime', 3000), false);
  assert.equal(isTrustedCodexRecoverySender('http://127.0.0.1:3001/settings/runtime', 3000), false);
  assert.equal(isTrustedCodexRecoverySender('https://127.0.0.1:3000/settings/runtime', 3000), false);
});

test('main/preload bridge exposes only a no-argument prepare action and does not auto-execute the installer', () => {
  const main = fs.readFileSync(path.join(repoRoot, 'electron/main.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(repoRoot, 'electron/preload.ts'), 'utf8');
  const panel = fs.readFileSync(path.join(repoRoot, 'src/components/settings/RuntimePanel.tsx'), 'utf8');
  const handlerStart = main.indexOf("ipcMain.handle('codex:prepare-windows-recovery'");
  assert.ok(handlerStart >= 0);
  const handler = main.slice(handlerStart, handlerStart + 2_400);
  assert.match(handler, /clipboard\.writeText\(install\.command\)/);
  assert.match(handler, /selectCodexWindowsInstallCommand\(findWindowsNpmCommand\(\)\)/);
  assert.match(handler, /buildCodexPowerShellLaunchSpec\(\)/);
  assert.match(handler, /spawn\(spec\.command, spec\.args/);
  assert.match(handler, /launcher\.once\('close'/);
  assert.doesNotMatch(handler, /\|-?Command|sendInput|paste|install\.command.*spec/i);
  assert.match(preload, /prepareWindowsRecovery:\s*\(\)\s*=>\s*ipcRenderer\.invoke/);
  assert.match(panel, /runtime\.codexRecoveryReadyNpm/);
});

test('Runtime recovery copy exposes the PowerShell installer only in Windows Electron', () => {
  const panel = fs.readFileSync(path.join(repoRoot, 'src/components/settings/RuntimePanel.tsx'), 'utf8');
  const enSrc = fs.readFileSync(path.join(repoRoot, 'src/i18n/en.ts'), 'utf8');
  const helperStart = panel.indexOf('function codexCliInstallRecovery');
  const helper = panel.slice(helperStart, helperStart + 1_200);
  assert.ok(helperStart >= 0);
  assert.match(helper, /if \(isWindowsElectron\)/);
  assert.match(helper, /runtime\.codexInstallRecoveryWin/);
  assert.match(helper, /runtime\.codexInstallRecoveryOther/);
  assert.match(enSrc, /'runtime\.codexInstallRecoveryWin':[\s\S]{0,200}install\.ps1/);
  assert.match(enSrc, /'runtime\.codexInstallRecoveryOther':[\s\S]{0,200}official instructions for this platform/);

  const statusStart = panel.indexOf('const codexRuntimeStatus');
  const status = panel.slice(statusStart, statusStart + 8_000);
  assert.match(status, /codexCliInstallRecovery\(t, isWindowsElectron\)/);
  assert.match(status, /kind === "desktop_only"[\s\S]*recovery: installRecovery/);
  assert.match(status, /kind === "not_installed"[\s\S]*recovery: installRecovery/);
});
