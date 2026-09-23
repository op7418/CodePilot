import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyCliInstallPath,
  isCodexDesktopManagedPath,
  pathIsInside,
} from '../../lib/cli-install-channel';

describe('CLI install channel path evidence', () => {
  it('keeps macOS Codex desktop bundles out of the standalone updater', () => {
    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      realPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      platform: 'darwin',
      homeDir: '/Users/tester',
    }), { channel: 'desktop_bundle', confidence: 'proven' });

    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: '/Users/tester/Applications/Codex.app/Contents/Resources/codex',
      realPath: '/Users/tester/Applications/Codex.app/Contents/Resources/codex',
      platform: 'darwin',
      homeDir: '/Users/tester',
    }), { channel: 'desktop_bundle', confidence: 'proven' });

    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: '/usr/local/bin/codex',
      realPath: '/Applications/ChatGPT.app/Contents/Resources/bin/codex',
      platform: 'darwin',
      homeDir: '/Users/tester',
    }), { channel: 'desktop_bundle', confidence: 'proven' });

    assert.equal(isCodexDesktopManagedPath(
      '/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/codex',
      'darwin',
    ), true);
  });

  it('keeps Windows Store Codex bundles out of the standalone updater', () => {
    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64__abc\\codex.exe',
      realPath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64__abc\\codex.exe',
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
    }), { channel: 'desktop_bundle', confidence: 'proven' });

    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: 'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\resources\\bin\\codex.exe',
      realPath: 'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\resources\\bin\\codex.exe',
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
    }), { channel: 'desktop_bundle', confidence: 'proven' });

    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe',
      realPath: 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe',
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
    }), { channel: 'desktop_bundle', confidence: 'proven' });
  });

  it('still recognizes an independently installed Codex executable as standalone', () => {
    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: '/Users/tester/.local/bin/codex',
      realPath: '/Users/tester/.local/bin/codex',
      platform: 'darwin',
      homeDir: '/Users/tester',
    }), { channel: 'standalone', confidence: 'proven' });

    assert.deepEqual(classifyCliInstallPath({
      provider: 'codex',
      binaryPath: 'C:\\Users\\tester\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
      realPath: 'C:\\Users\\tester\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
    }), { channel: 'standalone', confidence: 'proven' });
  });

  it('recognizes Windows npm cmd shims without pretending realpath traversed them', () => {
    assert.deepEqual(classifyCliInstallPath({
      provider: 'claude',
      binaryPath: 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\claude.cmd',
      realPath: 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\claude.cmd',
      platform: 'win32',
      homeDir: 'C:\\Users\\Test User',
    }), { channel: 'npm', confidence: 'ambiguous' });
  });

  it('keeps the overlapping Windows Claude native and WinGet layout ambiguous', () => {
    assert.deepEqual(classifyCliInstallPath({
      provider: 'claude',
      binaryPath: 'C:\\Users\\alice\\.local\\bin\\claude.exe',
      realPath: 'C:\\Users\\alice\\.local\\bin\\claude.exe',
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
    }), { channel: 'unknown', confidence: 'ambiguous' });
  });

  it('only treats paths inside the exact platform root as owned', () => {
    assert.equal(pathIsInside('C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'C:\\npm\\node_modules\\@openai\\codex', 'win32'), true);
    assert.equal(pathIsInside('C:\\other\\node_modules\\@openai\\codex\\bin\\codex.js', 'C:\\npm\\node_modules\\@openai\\codex', 'win32'), false);
    assert.equal(pathIsInside('/opt/homebrew/Caskroom/codex/1/bin/codex', '/opt/homebrew/Caskroom/codex', 'darwin'), true);
    assert.equal(pathIsInside('/usr/local/bin/codex', '/opt/homebrew/Caskroom/codex', 'darwin'), false);
  });
});
