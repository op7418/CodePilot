import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { findSecretLeaks } from './harness-home/validation';
import { currentHarnessMachineId } from './harness-home/repository/writer-lease';

export const MEMORY_RECORDS_PATH = 'memory/records.md';
const HEADER = '# CodePilot memory records\n\n<!-- memory-records:v1 -->\n\n';
const PREFIX = '<!-- memory-record ';
const MAX_BYTES = 2 * 1024 * 1024;

export interface MemoryRecordSource {
  kind: 'manual' | 'conversation' | 'tool';
  sessionId?: string;
  messageId?: string;
  role?: 'user' | 'assistant';
  capturedAt?: string;
}

export interface MemoryRecord {
  id: string;
  rootId: string;
  status: 'active' | 'superseded' | 'revoked';
  content: string;
  source: MemoryRecordSource;
  createdAt: string;
  updatedAt: string;
  operationHash: string;
  supersedes?: string;
}

export interface MemoryRecordsSnapshot {
  revision: string;
  records: MemoryRecord[];
}

export class MemoryRecordError extends Error {
  constructor(public readonly code: 'conflict' | 'invalid' | 'secret' | 'unsafe_path' | 'busy' | 'not_found' | 'capacity' | 'corrupt' | 'storage', message: string) {
    super(message);
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** All writes stay below the explicitly selected root. Existing user symlinks are never followed. */
function locations(workspacePath: string) {
  if (!path.isAbsolute(workspacePath)) throw new MemoryRecordError('unsafe_path', 'An absolute workspace is required.');
  const root = fs.realpathSync(workspacePath);
  if (!fs.statSync(root).isDirectory()) throw new MemoryRecordError('unsafe_path', 'Workspace must be a directory.');
  const dir = path.join(root, 'memory');
  const file = path.join(dir, 'records.md');
  for (const [target, directory] of [[dir, true], [file, false]] as const) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
        throw new MemoryRecordError('unsafe_path', 'Memory path is not a regular workspace file.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { root, dir, file };
}

function validateSource(source: MemoryRecordSource): void {
  if (!source || !['manual', 'conversation', 'tool'].includes(source.kind)) throw new MemoryRecordError('invalid', 'A real source is required.');
  if (source.kind === 'tool' && !source.sessionId) throw new MemoryRecordError('invalid', 'Tool memories need a trusted session ID.');
  if (source.kind === 'conversation' && (!source.sessionId || !source.messageId)) {
    throw new MemoryRecordError('invalid', 'Conversation memories need session and message IDs.');
  }
  for (const value of [source.sessionId, source.messageId, source.capturedAt]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f]/.test(value))) {
      throw new MemoryRecordError('invalid', 'Invalid source reference.');
    }
  }
  if (source.role !== undefined && !['user', 'assistant'].includes(source.role)) throw new MemoryRecordError('invalid', 'Invalid source role.');
}

function validateContent(content: string): void {
  if (typeof content !== 'string' || !content.trim() || content.length > 16000 || content.includes('\0')) {
    throw new MemoryRecordError('invalid', 'Memory must contain 1–16000 characters.');
  }
  if (findSecretLeaks(content).length) throw new MemoryRecordError('secret', 'Remove credential material before saving memory.');
}

function readRaw(file: string): string {
  try {
    if (fs.lstatSync(file).size > MAX_BYTES) throw new MemoryRecordError('capacity', 'Memory storage has reached its 2 MiB limit. Forget unneeded records to free space; do not delete source tombstones.');
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function decode(raw: string): MemoryRecord[] {
  if (!raw) return [];
  if (!raw.startsWith(HEADER)) throw new MemoryRecordError('corrupt', 'Existing records.md is not a managed memory file. Back up the file and restore a valid managed version before retrying.');
  const records: MemoryRecord[] = [];
  const ids = new Set<string>();
  let cursor = HEADER.length;
  try {
    while (cursor < raw.length) {
      if (!raw.startsWith(PREFIX, cursor)) throw new Error('Invalid record header');
      const end = raw.indexOf(' -->\n', cursor);
      if (end < 0) throw new Error('Incomplete record');
      const { contentLength, ...metadata } = JSON.parse(raw.slice(cursor + PREFIX.length, end));
      if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > 16000) throw new Error('Invalid length');
      cursor = end + 5;
      const content = raw.slice(cursor, cursor + contentLength);
      cursor += contentLength;
      if (raw.slice(cursor, cursor + 2) !== '\n\n') throw new Error('Memory was edited; refresh its metadata before writing');
      cursor += 2;
      const record = { ...metadata, content } as MemoryRecord;
      if (!/^[a-f0-9-]{36}$/.test(record.id) || ids.has(record.id) || !/^[a-f0-9-]{36}$/.test(record.rootId)
        || !['active', 'superseded', 'revoked'].includes(record.status)
        || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
        || typeof record.operationHash !== 'string') throw new Error('Invalid record metadata');
      validateSource(record.source);
      if (record.status !== 'revoked') validateContent(content);
      else if (content !== '') throw new Error('Revoked memory must have no content');
      ids.add(record.id);
      records.push(record);
    }
  } catch {
    throw new MemoryRecordError('corrupt', 'Memory file has external or invalid edits. Back up the file and restore a valid managed version; no changes were written.');
  }
  return records;
}

function encode(records: MemoryRecord[]): string {
  return HEADER + records.map(({ content, ...metadata }) =>
    `${PREFIX}${JSON.stringify({ ...metadata, contentLength: content.length })} -->\n${content}\n\n`).join('');
}

export function readMemoryRecords(workspacePath: string): MemoryRecordsSnapshot {
  try {
    const loc = locations(workspacePath);
    const raw = readRaw(loc.file);
    return { revision: hash(`${loc.root}\0${raw}`), records: decode(raw) };
  } catch (error) {
    if (error instanceof MemoryRecordError) throw error;
    throw new MemoryRecordError('storage', 'Memory could not be read. Check workspace and file permissions before retrying.');
  }
}

/** Read-only preflight for model jobs: deterministic storage failures must precede billing. */
export function assertMemoryStorageWritable(workspacePath: string, options: { reserveBytes?: number } = {}) {
  try {
    const loc = locations(workspacePath);
    const raw = readRaw(loc.file);
    decode(raw);
    const usedBytes = Buffer.byteLength(raw);
    const reserve = options.reserveBytes ?? 1024;
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw new MemoryRecordError('invalid', 'Invalid storage reservation.');
    if (usedBytes + reserve > MAX_BYTES) throw new MemoryRecordError('capacity', 'Memory storage has insufficient space. Forget unneeded records before retrying.');
    fs.accessSync(fs.existsSync(loc.dir) ? loc.dir : loc.root, fs.constants.W_OK | fs.constants.X_OK);
    const lock = path.join(loc.dir, '.records-lock');
    if (fs.existsSync(lock) && !deadLocalLease(lock)) throw new MemoryRecordError('busy', 'Memory writer lock is held or cannot be verified.');
    return { revision: hash(`${loc.root}\0${raw}`), usedBytes, maxBytes: MAX_BYTES };
  } catch (error) {
    if (error instanceof MemoryRecordError) throw error;
    throw new MemoryRecordError('storage', 'Memory storage is unavailable. Check workspace access, file permissions and free disk space before retrying.');
  }
}

export function isManagedMemoryRecordPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === MEMORY_RECORDS_PATH || normalized.startsWith('memory/records/') || normalized.startsWith('memory/.records-');
}

export function readActiveMemoryProjection(workspacePath: string) {
  const snapshot = readMemoryRecords(workspacePath);
  return snapshot.records.filter(record => record.status === 'active').map(record => ({
    id: record.id, path: `memory/records/${record.id}.md`, content: record.content, source: record.source, revision: snapshot.revision,
  }));
}

/** Return the exact observed lease only when the OS proves its local owner dead. */
function deadLocalLease(lock: string): string | undefined {
  try {
    const stat = fs.lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size >= 4096) return undefined;
    const observed = fs.readFileSync(lock, 'utf8');
    const holder = JSON.parse(observed);
    if (holder.machineId !== currentHarnessMachineId() || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || typeof holder.nonce !== 'string') return undefined;
    try { process.kill(holder.pid, 0); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return observed; }
  } catch { /* Unknown ownership must not authorize removing the lock. */ }
  return undefined;
}

function acquireLock(lock: string): () => void {
  const owner = JSON.stringify({ machineId: currentHarnessMachineId(), pid: process.pid, nonce: randomUUID() });
  const acquire = () => {
    const fd = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  try { acquire(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Time alone never proves a crashed writer. Recover only a same-machine,
    // unchanged regular-file lease whose process is proved dead by the OS.
    const observed = deadLocalLease(lock);
    if (!observed) throw new MemoryRecordError('busy', 'Memory writer lock is held or cannot be verified.');
    try {
      if (fs.readFileSync(lock, 'utf8') !== observed) throw new Error('Changed lease');
    } catch { throw new MemoryRecordError('busy', 'Another memory writer acquired the lock.'); }
    fs.unlinkSync(lock);
    try { acquire(); } catch { throw new MemoryRecordError('busy', 'Another memory writer acquired the lock.'); }
  }
  return () => {
    try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MemoryRecordError('busy', 'Memory writer lock could not be released; retry after checking directory permissions.'); }
  };
}

function mutateLocked(workspacePath: string, expectedRevision: string | undefined, update: (records: MemoryRecord[]) => 'saved' | 'duplicate' | 'blocked') {
  const loc = locations(workspacePath);
  fs.mkdirSync(loc.dir, { recursive: true });
  locations(workspacePath);
  const lock = path.join(loc.dir, '.records-lock');
  const release = acquireLock(lock);
  let temp: string | undefined;
  try {
    const snapshot = readMemoryRecords(workspacePath);
    if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) throw new MemoryRecordError('conflict', 'Memory changed. Refresh before saving.');
    const draft = snapshot.records.map(record => ({ ...record, source: { ...record.source } }));
    const result = update(draft);
    if (result !== 'saved') return { ...snapshot, result };
    const bytes = encode(draft);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new MemoryRecordError('capacity', 'Memory storage has reached its 2 MiB limit. Forget unneeded records to free space; do not delete source tombstones.');
    temp = path.join(loc.dir, `.records-${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Managed writers serialize with the directory lease; external edits fail CAS.
    if (readMemoryRecords(workspacePath).revision !== snapshot.revision) throw new MemoryRecordError('conflict', 'Memory changed while saving.');
    fs.renameSync(temp, loc.file);
    temp = undefined;
    // Persist the directory entry where supported (Windows does not expose
    // portable directory fsync). The file data itself was already fsynced.
    try {
      const directory = fs.openSync(loc.dir, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) {
      if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    }
    return { revision: hash(`${loc.root}\0${bytes}`), records: draft, result };
  } catch (error) {
    if (error instanceof MemoryRecordError) throw error;
    throw new MemoryRecordError('storage', 'Memory could not be saved. Check workspace permissions and free disk space before retrying.');
  } finally {
    try { if (temp) fs.rmSync(temp, { force: true }); } finally { release(); }
  }
}

function mutate(...args: Parameters<typeof mutateLocked>) {
  try { return mutateLocked(...args); }
  catch (error) {
    if (error instanceof MemoryRecordError) throw error;
    throw new MemoryRecordError('storage', 'Memory storage is unavailable. Check workspace permissions and free disk space before retrying.');
  }
}

function sourceKey(source: MemoryRecordSource): string | undefined {
  return source.sessionId && source.messageId ? `${source.sessionId}\0${source.messageId}` : undefined;
}

export interface MemoryRecordCandidate {
  content: string; source: MemoryRecordSource; idempotencyKey: string;
}

export function saveMemoryRecordCandidates(workspacePath: string, candidates: MemoryRecordCandidate[], expectedRevision?: string) {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 40) throw new MemoryRecordError('invalid', 'Provide 1–40 memory candidates.');
  for (const candidate of candidates) {
    validateContent(candidate.content);
    validateSource(candidate.source);
    if (typeof candidate.idempotencyKey !== 'string' || !candidate.idempotencyKey || candidate.idempotencyKey.length > 1000) throw new MemoryRecordError('invalid', 'An idempotency key is required.');
  }
  return mutate(workspacePath, expectedRevision, records => {
    for (const candidate of candidates) {
      const key = sourceKey(candidate.source);
      if (key && records.some(record => sourceKey(record.source) === key && record.status !== 'active')) return 'blocked';
    }
    let saved = false;
    for (const candidate of candidates) {
      const operationHash = hash(candidate.idempotencyKey);
      const existing = records.find(record => record.operationHash === operationHash);
      if (existing) {
        if (existing.status !== 'active') return 'blocked';
        const sameSource = (['kind', 'sessionId', 'messageId', 'role'] as const)
          .every(key => existing.source[key] === candidate.source[key]);
        if (existing.content !== candidate.content || !sameSource) {
          throw new MemoryRecordError('conflict', 'Idempotency key was already used for different memory content or provenance.');
        }
        continue;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      records.push({ id, rootId: id, content: candidate.content, source: candidate.source, status: 'active', createdAt: now, updatedAt: now, operationHash });
      saved = true;
    }
    return saved ? 'saved' : 'duplicate';
  });
}

export function saveMemoryRecordCandidate(workspacePath: string, candidate: MemoryRecordCandidate, expectedRevision?: string) {
  return saveMemoryRecordCandidates(workspacePath, [candidate], expectedRevision);
}

export function correctMemoryRecord(workspacePath: string, id: string, content: string, expectedRevision: string,
  source: MemoryRecordSource = { kind: 'manual' }) {
  validateContent(content);
  validateSource(source);
  return mutate(workspacePath, expectedRevision, records => {
    const previous = records.find(record => record.id === id && record.status === 'active');
    if (!previous) throw new MemoryRecordError('not_found', 'Active memory was not found.');
    const now = new Date().toISOString();
    previous.status = 'superseded';
    previous.updatedAt = now;
    records.push({ ...previous, id: randomUUID(), content, source, status: 'active', supersedes: previous.id, createdAt: now,
      operationHash: hash(`correction:${id}:${expectedRevision}:${content}`) });
    return 'saved';
  });
}

/** Erase every version of this record; source tombstones stop automatic re-extraction. */
export function revokeMemoryRecord(workspacePath: string, id: string, expectedRevision: string) {
  return mutate(workspacePath, expectedRevision, records => {
    const target = records.find(record => record.id === id);
    if (!target) throw new MemoryRecordError('not_found', 'Memory was not found.');
    if (target.status === 'revoked') return 'duplicate';
    for (const record of records.filter(record => record.rootId === target.rootId)) {
      record.status = 'revoked'; record.content = ''; record.updatedAt = new Date().toISOString();
    }
    return 'saved';
  });
}
