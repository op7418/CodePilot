import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClaudeRuntimeProbe,
  buildCodexRuntimeProbe,
  buildNativeRuntimeProbe,
  inferRuntimeCandidateSource,
} from '../../lib/runtime-probe';

test('runtime probes keep binary, app-server and sandbox states separate', () => {
  const binary = process.execPath;
  const codex = buildCodexRuntimeProbe({ kind: 'installed_idle', binary });
  assert.equal(codex.binary.probe, 'passed');
  assert.equal(codex.appServer?.probe, 'not_run');
  assert.equal(codex.sandbox?.state, process.platform === 'win32' ? 'unknown' : 'unknown');
  assert.equal(codex.sandbox?.probe, 'not_run');
});

test('desktop-only Codex is an explicit failed binary probe, not an installed green state', () => {
  const binary = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\resources\\codex.exe';
  const codex = buildCodexRuntimeProbe({
    kind: 'desktop_only',
    binary,
    reason: 'desktop_bundle_not_executable',
  });
  assert.equal(codex.candidateSource, 'desktop_bundle');
  assert.equal(codex.binary.exists, false, 'fixture existence is never inferred from its spelling');
  assert.equal(codex.binary.probe, 'failed');
  assert.equal(codex.appServer?.probe, 'not_run');
  assert.equal(codex.sandbox?.state, 'not_applicable');
  assert.equal(codex.lastError?.stage, 'binary_probe');
});

test('ready app-server does not imply a ready Windows sandbox', () => {
  const codex = buildCodexRuntimeProbe({
    kind: 'ready',
    binary: process.execPath,
    version: 'Codex test',
    codexHome: process.cwd(),
  });
  assert.equal(codex.appServer?.probe, 'passed');
  assert.equal(codex.sandbox?.state, 'unknown');
});

test('Claude and Native probes expose source breadcrumbs', () => {
  const native = buildNativeRuntimeProbe();
  assert.equal(native.candidateSource, 'builtin');
  assert.equal(native.binary.probe, 'not_run');
  assert.equal(native.appServer?.probe, 'passed');
  assert.equal(native.logLocation, undefined);

  const claude = buildClaudeRuntimeProbe({
    connected: true,
    version: '2.1.74',
    binaryPath: process.execPath,
    installType: 'native',
    missingGit: false,
  });
  assert.equal(claude.binary.probe, 'passed');
  assert.equal(claude.installChannel, 'native');
  assert.equal(claude.cwd.identity.kind, 'directory');
});

test('candidate source distinguishes standalone, aliases and desktop bundles', () => {
  assert.equal(
    inferRuntimeCandidateSource('C:\\Users\\me\\.local\\bin\\codex.exe', 'codex', 'win32'),
    'standalone',
  );
  assert.equal(
    inferRuntimeCandidateSource('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe', 'codex', 'win32'),
    'alias',
  );
  assert.equal(
    inferRuntimeCandidateSource('C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex.exe', 'codex', 'win32'),
    'desktop_bundle',
  );
  assert.equal(
    inferRuntimeCandidateSource('C:\\Users\\me\\AppData\\Local\\Programs\\ChatGPT\\resources\\bin\\codex.exe', 'codex', 'win32'),
    'desktop_bundle',
  );
  assert.equal(
    inferRuntimeCandidateSource('/Applications/ChatGPT.app/Contents/Resources/bin/codex', 'codex', 'darwin'),
    'desktop_bundle',
  );
});
