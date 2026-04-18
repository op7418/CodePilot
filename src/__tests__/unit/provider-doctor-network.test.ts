import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalHttpsProxy = process.env.HTTPS_PROXY;
const originalHttpProxy = process.env.HTTP_PROXY;
const originalNoProxy = process.env.NO_PROXY;
const originalNodeExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
const originalFetch = global.fetch;

let tempDataDir = '';
let tempHome = '';

async function resetDoctorState(): Promise<void> {
  const { getDb } = await import('../../lib/db');
  const db = getDb();
  db.prepare('DELETE FROM api_providers').run();
  db.prepare("DELETE FROM settings WHERE key IN ('default_provider_id', 'global_default_model_provider', 'global_default_model')").run();
}

function getCodeFinding(
  findings: Array<{ code: string; severity: string; message: string; detail?: string }>,
  code: string,
) {
  return findings.find(f => f.code === code);
}

before(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-doctor-network-db-'));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-doctor-network-home-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  await resetDoctorState();
});

beforeEach(async () => {
  await resetDoctorState();
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.NODE_EXTRA_CA_CERTS;
  global.fetch = (async () => new Response('', { status: 204 })) as typeof fetch;
});

after(() => {
  if (originalDataDir !== undefined) process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  else delete process.env.CLAUDE_GUI_DATA_DIR;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
  if (originalHttpsProxy !== undefined) process.env.HTTPS_PROXY = originalHttpsProxy;
  else delete process.env.HTTPS_PROXY;
  if (originalHttpProxy !== undefined) process.env.HTTP_PROXY = originalHttpProxy;
  else delete process.env.HTTP_PROXY;
  if (originalNoProxy !== undefined) process.env.NO_PROXY = originalNoProxy;
  else delete process.env.NO_PROXY;
  if (originalNodeExtraCaCerts !== undefined) process.env.NODE_EXTRA_CA_CERTS = originalNodeExtraCaCerts;
  else delete process.env.NODE_EXTRA_CA_CERTS;
  global.fetch = originalFetch;
  try { fs.rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('provider doctor network diagnostics', () => {
  it('adds proxy loopback bypass and gateway reachability findings', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.internal:8080';
    process.env.NO_PROXY = 'corp.internal,.example.com';

    const { createProvider, setDefaultProviderId } = await import('../../lib/db');
    const provider = createProvider({
      name: 'Corp Gateway',
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://gw.corp.example.com/v1',
      api_key: 'sk-test-gw',
    });
    setDefaultProviderId(provider.id);

    const { runDiagnosis } = await import('../../lib/provider-doctor');
    const diagnosis = await runDiagnosis();
    const network = diagnosis.probes.find(p => p.probe === 'network');
    assert.ok(network, 'expected network probe');

    const proxyConfigured = getCodeFinding(network.findings, 'network.proxy.configured');
    assert.ok(proxyConfigured, 'expected network.proxy.configured finding');

    const loopbackBypass = getCodeFinding(network.findings, 'network.proxy.loopback-not-bypassed');
    assert.ok(loopbackBypass, 'expected network.proxy.loopback-not-bypassed finding');
    assert.equal(loopbackBypass.severity, 'warn');

    const gatewayValid = getCodeFinding(network.findings, 'gateway.base-url-valid');
    assert.ok(gatewayValid, 'expected gateway.base-url-valid finding');

    const gatewayReachability =
      getCodeFinding(network.findings, 'gateway.reachable') ||
      getCodeFinding(network.findings, 'gateway.unreachable') ||
      getCodeFinding(network.findings, 'gateway.timeout');
    assert.ok(
      gatewayReachability,
      `expected gateway reachability finding; got codes: ${network.findings.map(f => f.code).join(', ')}`,
    );
  });

  it('reports NODE_EXTRA_CA_CERTS readable/missing states', async () => {
    const certFile = path.join(tempHome, 'corp-ca.pem');
    fs.writeFileSync(certFile, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    process.env.NODE_EXTRA_CA_CERTS = certFile;

    const { runDiagnosis } = await import('../../lib/provider-doctor');
    const readableDiagnosis = await runDiagnosis();
    const readableNetwork = readableDiagnosis.probes.find(p => p.probe === 'network');
    assert.ok(readableNetwork, 'expected network probe');
    assert.ok(getCodeFinding(readableNetwork.findings, 'network.ca.readable'), 'expected network.ca.readable finding');

    process.env.NODE_EXTRA_CA_CERTS = path.join(tempHome, 'missing-ca.pem');
    const missingDiagnosis = await runDiagnosis();
    const missingNetwork = missingDiagnosis.probes.find(p => p.probe === 'network');
    assert.ok(missingNetwork, 'expected network probe');
    const missingCa = getCodeFinding(missingNetwork.findings, 'network.ca.missing');
    assert.ok(missingCa, 'expected network.ca.missing finding');
    assert.equal(missingCa.severity, 'warn');
  });

  it('adds gateway invalid-base-url finding for malformed provider URL', async () => {
    const { createProvider, setDefaultProviderId } = await import('../../lib/db');
    const provider = createProvider({
      name: 'Broken Gateway',
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'ht!tp:// bad-url',
      api_key: 'sk-bad',
    });
    setDefaultProviderId(provider.id);

    const { runDiagnosis } = await import('../../lib/provider-doctor');
    const diagnosis = await runDiagnosis();
    const network = diagnosis.probes.find(p => p.probe === 'network');
    assert.ok(network, 'expected network probe');

    const invalidGateway = getCodeFinding(network.findings, 'gateway.invalid-base-url');
    assert.ok(invalidGateway, 'expected gateway.invalid-base-url finding');

    const invalidNetworkUrl = getCodeFinding(network.findings, 'network.invalid-url');
    assert.ok(invalidNetworkUrl, 'expected network.invalid-url finding');
  });
});
