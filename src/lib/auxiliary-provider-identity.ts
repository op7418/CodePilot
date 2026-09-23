import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCodePilotDataDir } from './codepilot-data-dir';

/**
 * A dedicated installation key keeps workspace-ledger fingerprints from being
 * offline guesses of API keys. It lives only in private app data, never in a
 * workspace, exported setting, telemetry payload, or provider subprocess env.
 * Stable across server restarts so a credential failure cannot retry on restart.
 */
function identityKey(): Buffer {
  const directory = resolveCodePilotDataDir();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'auxiliary-identity-key.v1');
  if (!fs.existsSync(file)) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Publish a fully written key without replacing a concurrent winner.
      try { fs.linkSync(temp, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(temp, { force: true }); }
  }
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('AUXILIARY_IDENTITY_KEY_UNAVAILABLE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('AUXILIARY_IDENTITY_KEY_UNAVAILABLE');
    }
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function fingerprintAuxiliaryConfiguration(serialized: string): string {
  try {
    return `hmac-v1:${createHmac('sha256', identityKey())
      .update('codepilot:auxiliary-route:v1\0').update(serialized).digest('hex')}`;
  } catch {
    // Do not expose app-data paths, credentials, or filesystem error contents.
    throw new Error('AUXILIARY_IDENTITY_KEY_UNAVAILABLE');
  }
}

export type AuxiliaryConfigurationBlockReason = 'credentials_missing';
function blockFile(providerIdentity: string) {
  const name = fingerprintAuxiliaryConfiguration(`codepilot:auxiliary-block:v1\0${providerIdentity}`).replace(':', '-');
  return path.join(resolveCodePilotDataDir(), `auxiliary-block-${name}.json`);
}

/** One receipt per provider identity, never one per session/prompt or old configuration. */
export function readAuxiliaryConfigurationBlock(providerIdentity: string, fingerprint: string): AuxiliaryConfigurationBlockReason | undefined {
  try {
    const file = blockFile(providerIdentity);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('AUXILIARY_CONFIGURATION_STATE_UNAVAILABLE');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error();
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      // v1 conflated credentials with all 4xx, including quota/rate limits.
      // No v1 receipt proves a credential root cause: ignore it on upgrade and
      // let the next real request classify once under the narrower v2 contract.
      if (value.version === 1 && typeof value.fingerprint === 'string'
          && ['credentials_missing', 'configuration_required'].includes(value.reason)) return undefined;
      if (value.version !== 2 || typeof value.fingerprint !== 'string'
          || value.reason !== 'credentials_missing' || value.rootCause !== 'credentials') throw new Error();
      return value.fingerprint === fingerprint ? value.reason : undefined;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('AUXILIARY_CONFIGURATION_STATE_UNAVAILABLE');
  }
}

export function blockAuxiliaryConfiguration(providerIdentity: string, fingerprint: string, reason: AuxiliaryConfigurationBlockReason): void {
  const file = blockFile(providerIdentity);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 2, fingerprint, reason, rootCause: 'credentials' })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } catch {
    throw new Error('AUXILIARY_CONFIGURATION_STATE_UNAVAILABLE');
  } finally { fs.rmSync(temp, { force: true }); }
}
