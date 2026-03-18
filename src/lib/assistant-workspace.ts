import fs from 'fs';
import path from 'path';
import type { AssistantWorkspaceState, AssistantWorkspaceFiles, AssistantWorkspaceFilesV2, SearchResult } from '@/types';
import { getLocalDateString } from '@/lib/utils';

const DEFAULT_STATE: AssistantWorkspaceState = {
  onboardingComplete: false,
  lastCheckInDate: null,
  schemaVersion: 3,
};

const STATE_DIR = '.assistant';
const STATE_FILE = 'state.json';
const MEMORY_DAILY_DIR = 'memory/daily';

// Canonical filenames — lowercase preferred, uppercase fallback
const FILE_MAP: Record<keyof AssistantWorkspaceFiles, string[]> = {
  claude: ['claude.md', 'Claude.md', 'CLAUDE.md', 'AGENTS.md'],
  soul: ['soul.md', 'Soul.md', 'SOUL.md'],
  user: ['user.md', 'User.md', 'USER.md', 'PROFILE.md'],
  memory: ['memory.md', 'Memory.md', 'MEMORY.md'],
};

// Templates for initialization
const FILE_TEMPLATES: Record<keyof AssistantWorkspaceFiles, string> = {
  claude: '# Rules\n\n<!-- Assistant execution rules go here -->\n',
  soul: '# Soul\n\n<!-- Assistant personality and style go here -->\n',
  user: '# User Profile\n\n<!-- User preferences and information go here -->\n',
  memory: '# Memory\n\n<!-- Long-term facts and notes go here -->\n',
};

const PER_FILE_LIMIT = 8000;
const HEAD_SIZE = 6000;
const TAIL_SIZE = 1800;
const TOTAL_PROMPT_LIMIT = 40000;
const DAILY_MEMORY_LIMIT = 4000;
const ROOT_DOC_LIMIT = 2000;
const RETRIEVAL_RESULT_LIMIT = 3000;
const MAX_RETRIEVAL_RESULTS = 5;

function resolveFile(dir: string, key: keyof AssistantWorkspaceFiles): { filePath: string; exists: boolean } {
  for (const variant of FILE_MAP[key]) {
    const filePath = path.join(dir, variant);
    if (fs.existsSync(filePath)) {
      return { filePath, exists: true };
    }
  }
  return { filePath: path.join(dir, FILE_MAP[key][0]), exists: false };
}

// ==========================================
// Daily Memory
// ==========================================

export function ensureDailyDir(dir: string): string {
  const dailyDir = path.join(dir, MEMORY_DAILY_DIR);
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }
  return dailyDir;
}

export function writeDailyMemory(dir: string, date: string, content: string): string {
  const dailyDir = ensureDailyDir(dir);
  const filePath = path.join(dailyDir, `${date}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function loadDailyMemories(dir: string, count = 2): Array<{ date: string; content: string }> {
  const dailyDir = path.join(dir, MEMORY_DAILY_DIR);
  if (!fs.existsSync(dailyDir)) return [];

  try {
    const files = fs.readdirSync(dailyDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, count);

    return files.map(f => ({
      date: f.replace('.md', ''),
      content: fs.readFileSync(path.join(dailyDir, f), 'utf-8'),
    }));
  } catch {
    return [];
  }
}

// ==========================================
// State Migration
// ==========================================

export function migrateStateV1ToV2(dir: string): void {
  // Read state directly (not via loadState, which triggers migration recursively)
  let state: AssistantWorkspaceState;
  try {
    const statePath = path.join(dir, STATE_DIR, STATE_FILE);
    const raw = fs.readFileSync(statePath, 'utf-8');
    state = JSON.parse(raw) as AssistantWorkspaceState;
  } catch {
    return; // No state file, nothing to migrate
  }

  if (state.schemaVersion >= 2) return;

  // Create daily memory directory
  ensureDailyDir(dir);

  // Create Inbox if not exists
  const inboxDir = path.join(dir, 'Inbox');
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  // Update schema version
  state.schemaVersion = 2;
  saveState(dir, state);
}

/**
 * Migrate schema v2 → v3: normalize lastCheckInDate from UTC to local.
 *
 * Before v3, lastCheckInDate was written as `new Date().toISOString().slice(0, 10)`
 * which is a UTC date. After v3 it's written via `getLocalDateString()`.
 *
 * For users east/west of UTC, the old UTC date can differ from the local date
 * by ±1 day. We only rewrite the stored date if it matches today's UTC date —
 * meaning the user checked in "today" under the old semantics and the value
 * just needs normalizing to local. Clearly-past dates are left as-is so the
 * user correctly receives their next check-in.
 *
 * Edge cases that the migration cannot resolve (e.g. check-in written during
 * the UTC/local day-boundary mismatch window, but migration runs after UTC
 * midnight) are handled by a runtime compat fallback in needsDailyCheckIn.
 */
export function migrateStateV2ToV3(dir: string): void {
  let state: AssistantWorkspaceState;
  try {
    const statePath = path.join(dir, STATE_DIR, STATE_FILE);
    const raw = fs.readFileSync(statePath, 'utf-8');
    state = JSON.parse(raw) as AssistantWorkspaceState;
  } catch {
    return;
  }

  if (state.schemaVersion >= 3) return;

  if (state.lastCheckInDate) {
    const utcToday = new Date().toISOString().slice(0, 10);
    // Only normalize if the stored UTC date is "today" — the ambiguous case
    // where the user checked in today but the UTC/local date may differ.
    // Past dates are left untouched so needsDailyCheckIn triggers correctly.
    if (state.lastCheckInDate === utcToday) {
      state.lastCheckInDate = getLocalDateString();
    }
  }

  state.schemaVersion = 3;
  saveState(dir, state);
}

// ==========================================
// Root Docs
// ==========================================

export function generateRootDocs(dir: string): string[] {
  const generated: string[] = [];

  // Scan top-level entries
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return generated;
  }

  const subdirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
  const files = entries.filter(e => e.isFile());

  const startMarker = '<!-- AI_GENERATED_START -->';
  const endMarker = '<!-- AI_GENERATED_END -->';

  // README.ai.md — workspace purpose + categories + structure
  const dirList = subdirs.map(d => `- **${d.name}/** — directory`).join('\n');
  const fileList = files
    .filter(f => !f.name.startsWith('.'))
    .map(f => `- ${f.name}`)
    .join('\n');

  const readmeContent = `${startMarker}
# Workspace Overview

## Directories
${dirList || '(none)'}

## Root Files
${fileList || '(none)'}

## Structure
This workspace contains ${subdirs.length} directories and ${files.length} root files.
${endMarker}`;

  const readmePath = path.join(dir, 'README.ai.md');
  writeAiDoc(readmePath, readmeContent, startMarker, endMarker);
  generated.push(readmePath);

  // PATH.ai.md — directory tree + role map
  const treeLines = [
    `${startMarker}`,
    `# Workspace Path Index`,
    '',
    `Base: \`${dir}\``,
    '',
  ];
  for (const d of subdirs) {
    treeLines.push(`- \`${d.name}/\``);
  }
  for (const f of files.filter(f => !f.name.startsWith('.'))) {
    treeLines.push(`- \`${f.name}\``);
  }
  treeLines.push(endMarker);

  const pathFilePath = path.join(dir, 'PATH.ai.md');
  writeAiDoc(pathFilePath, treeLines.join('\n'), startMarker, endMarker);
  generated.push(pathFilePath);

  return generated;
}

function writeAiDoc(filePath: string, content: string, startMarker: string, endMarker: string): void {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    const startIdx = existing.indexOf(startMarker);
    const endIdx = existing.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      const updated = existing.slice(0, startIdx) + content + existing.slice(endIdx + endMarker.length);
      fs.writeFileSync(filePath, updated, 'utf-8');
    } else {
      fs.writeFileSync(filePath, content + '\n', 'utf-8');
    }
  } else {
    fs.writeFileSync(filePath, content + '\n', 'utf-8');
  }
}

// ==========================================
// Validation & Initialization
// ==========================================

export function validateWorkspace(dir: string): {
  exists: boolean;
  files: Record<keyof AssistantWorkspaceFiles, { exists: boolean; path: string | null; size: number }>;
} {
  const dirExists = fs.existsSync(dir);
  const keys = Object.keys(FILE_MAP) as Array<keyof AssistantWorkspaceFiles>;
  const files = {} as Record<keyof AssistantWorkspaceFiles, { exists: boolean; path: string | null; size: number }>;

  for (const key of keys) {
    if (!dirExists) {
      files[key] = { exists: false, path: null, size: 0 };
      continue;
    }
    const resolved = resolveFile(dir, key);
    if (resolved.exists) {
      const stat = fs.statSync(resolved.filePath);
      files[key] = { exists: true, path: resolved.filePath, size: stat.size };
    } else {
      files[key] = { exists: false, path: null, size: 0 };
    }
  }

  return { exists: dirExists, files };
}

export function initializeWorkspace(dir: string): string[] {
  const stateDir = path.join(dir, STATE_DIR);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const created: string[] = [];

  // Detect if this is an existing directory with content
  let existingEntries: fs.Dirent[] = [];
  try {
    existingEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { /* empty */ }
  const hasExistingContent = existingEntries.some(
    e => !e.name.startsWith('.') && e.name !== 'Inbox' && e.name !== 'memory'
  );

  // Create core workspace files (only if missing)
  const keys = Object.keys(FILE_MAP) as Array<keyof AssistantWorkspaceFiles>;
  for (const key of keys) {
    const resolved = resolveFile(dir, key);
    if (!resolved.exists) {
      const canonicalPath = path.join(dir, FILE_MAP[key][0]);
      fs.writeFileSync(canonicalPath, FILE_TEMPLATES[key], 'utf-8');
      created.push(canonicalPath);
    }
  }

  // Create V2 directories
  ensureDailyDir(dir);
  const inboxDir = path.join(dir, 'Inbox');
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  // State file
  const statePath = path.join(stateDir, STATE_FILE);
  if (!fs.existsSync(statePath)) {
    saveState(dir, { ...DEFAULT_STATE });
  } else {
    // Migrate existing state through all schema versions
    migrateStateV1ToV2(dir);
    migrateStateV2ToV3(dir);
  }

  // For existing directories, generate root docs and infer taxonomy
  if (hasExistingContent) {
    generateRootDocs(dir);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { inferTaxonomyFromDirs, loadTaxonomy, saveTaxonomy } = require('@/lib/workspace-taxonomy');
      const taxonomy = loadTaxonomy(dir);
      if (taxonomy.categories.length === 0) {
        const inferred = inferTaxonomyFromDirs(dir);
        if (inferred.length > 0) {
          taxonomy.categories = inferred;
          saveTaxonomy(dir, taxonomy);
        }
      }
    } catch {
      // taxonomy module not available, skip
    }
  }

  return created;
}

// ==========================================
// File Loading
// ==========================================

export function truncateContent(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const headSize = Math.min(HEAD_SIZE, Math.floor(limit * 0.75));
  const tailSize = Math.min(TAIL_SIZE, limit - headSize - 30);
  return content.slice(0, headSize) + '\n\n[...truncated...]\n\n' + content.slice(-tailSize);
}

export function loadWorkspaceFiles(dir: string): AssistantWorkspaceFilesV2 {
  const result: AssistantWorkspaceFilesV2 = {};
  const keys = Object.keys(FILE_MAP) as Array<keyof AssistantWorkspaceFiles>;

  for (const key of keys) {
    const resolved = resolveFile(dir, key);
    if (resolved.exists) {
      const content = fs.readFileSync(resolved.filePath, 'utf-8');
      result[key] = truncateContent(content, PER_FILE_LIMIT);
    }
  }

  // Load daily memories (today + yesterday)
  const dailyMemories = loadDailyMemories(dir, 2);
  if (dailyMemories.length > 0) {
    result.dailyMemories = dailyMemories.map(m =>
      truncateContent(`## ${m.date}\n${m.content}`, DAILY_MEMORY_LIMIT)
    );
  }

  // Load root docs
  const readmePath = path.join(dir, 'README.ai.md');
  if (fs.existsSync(readmePath)) {
    result.rootReadme = truncateContent(
      fs.readFileSync(readmePath, 'utf-8'),
      ROOT_DOC_LIMIT
    );
  }

  const pathFilePath = path.join(dir, 'PATH.ai.md');
  if (fs.existsSync(pathFilePath)) {
    result.rootPath = truncateContent(
      fs.readFileSync(pathFilePath, 'utf-8'),
      ROOT_DOC_LIMIT
    );
  }

  result.rootDir = dir;

  return result;
}

// ==========================================
// Budget-Aware Prompt Assembly (V2)
// ==========================================

interface PromptSection {
  tag: string;
  content: string;
  priority: number; // lower = higher priority
  maxSize: number;
}

export function assembleWorkspacePrompt(files: AssistantWorkspaceFilesV2, retrievalResults?: SearchResult[]): string {
  const sections: PromptSection[] = [];

  // Priority 1: Identity (claude + soul + user) — never drop claude
  if (files.claude) {
    sections.push({ tag: 'claude', content: files.claude, priority: 1, maxSize: PER_FILE_LIMIT });
  }
  if (files.soul) {
    sections.push({ tag: 'soul', content: files.soul, priority: 1, maxSize: PER_FILE_LIMIT });
  }
  if (files.user) {
    sections.push({ tag: 'user', content: files.user, priority: 1, maxSize: PER_FILE_LIMIT });
  }

  // Priority 2: Long-term memory
  if (files.memory) {
    sections.push({ tag: 'memory', content: files.memory, priority: 2, maxSize: PER_FILE_LIMIT });
  }

  // Priority 3: Daily memories
  if (files.dailyMemories && files.dailyMemories.length > 0) {
    for (let i = 0; i < files.dailyMemories.length; i++) {
      sections.push({
        tag: `daily-memory-${i}`,
        content: files.dailyMemories[i],
        priority: 3,
        maxSize: DAILY_MEMORY_LIMIT,
      });
    }
  }

  // Priority 4: Root docs
  if (files.rootReadme) {
    sections.push({ tag: 'workspace-readme', content: files.rootReadme, priority: 4, maxSize: ROOT_DOC_LIMIT });
  }
  if (files.rootPath) {
    sections.push({ tag: 'workspace-path', content: files.rootPath, priority: 4, maxSize: ROOT_DOC_LIMIT });
  }

  // Priority 5: Retrieval results
  if (retrievalResults && retrievalResults.length > 0) {
    const results = retrievalResults.slice(0, MAX_RETRIEVAL_RESULTS);
    for (const result of results) {
      const content = `**${result.path}** (${result.source}, score: ${result.score.toFixed(1)})\n${result.heading ? `### ${result.heading}\n` : ''}${result.snippet}`;
      sections.push({
        tag: 'retrieval-result',
        content: truncateContent(content, RETRIEVAL_RESULT_LIMIT),
        priority: 5,
        maxSize: RETRIEVAL_RESULT_LIMIT,
      });
    }
  }

  if (sections.length === 0) return '';

  // Sort by priority
  sections.sort((a, b) => a.priority - b.priority);

  // Budget-aware assembly
  let totalSize = 0;
  const included: string[] = [];
  const wrapperOverhead = 50; // <assistant-workspace> tags

  for (const section of sections) {
    const sectionContent = truncateContent(section.content, section.maxSize);
    const sectionSize = sectionContent.length + section.tag.length * 2 + 10; // tag overhead

    if (totalSize + sectionSize + wrapperOverhead > TOTAL_PROMPT_LIMIT) {
      // Drop low-priority content on overflow, but never drop claude.md
      if (section.tag === 'claude') {
        // Force include claude.md even on overflow
        included.push(`<${section.tag}>\n${sectionContent}\n</${section.tag}>`);
        totalSize += sectionSize;
      }
      // Skip other sections that don't fit
      continue;
    }

    included.push(`<${section.tag}>\n${sectionContent}\n</${section.tag}>`);
    totalSize += sectionSize;
  }

  if (included.length === 0) return '';

  return `<assistant-workspace>\n${included.join('\n\n')}\n</assistant-workspace>`;
}

// ==========================================
// State Management
// ==========================================

export function loadState(dir: string): AssistantWorkspaceState {
  try {
    const statePath = path.join(dir, STATE_DIR, STATE_FILE);
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw) as AssistantWorkspaceState;

    // Auto-migrate on load
    let migrated = false;
    if (state.schemaVersion < 2) {
      migrateStateV1ToV2(dir);
      migrated = true;
    }
    if (state.schemaVersion < 3) {
      migrateStateV2ToV3(dir);
      migrated = true;
    }
    if (migrated) {
      return loadState(dir); // Reload after migration
    }

    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(dir: string, state: AssistantWorkspaceState): void {
  const stateDir = path.join(dir, STATE_DIR);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  const statePath = path.join(stateDir, STATE_FILE);
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpPath, statePath);
}

export function needsDailyCheckIn(state: AssistantWorkspaceState, now?: Date): boolean {
  if (!state.onboardingComplete) return false;
  if (state.dailyCheckInEnabled === false) return false;
  const d = now ?? new Date();
  const localToday = getLocalDateString(d);
  if (state.lastCheckInDate === localToday) return false;

  // Compat: before schema v3, lastCheckInDate was stored as a UTC date.
  // If the stored value matches today's UTC date, the user checked in "today"
  // under the old semantics. Accept it to avoid a spurious re-trigger.
  // Once the next check-in writes a local date + v3, this path becomes inert.
  const utcToday = d.toISOString().slice(0, 10);
  if (state.lastCheckInDate === utcToday) return false;

  return true;
}

// ==========================================
// Directory Docs (legacy — kept for backward compatibility)
// ==========================================

export function generateDirectoryDocs(dir: string): string[] {
  const generated: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return generated;
  }

  const subdirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

  for (const subdir of subdirs) {
    const subdirPath = path.join(dir, subdir.name);
    let subEntries: fs.Dirent[];
    try {
      subEntries = fs.readdirSync(subdirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const fileList = subEntries
      .map(e => `- ${e.name}${e.isDirectory() ? '/' : ''}`)
      .sort()
      .join('\n');

    const startMarker = '<!-- AI_GENERATED_START -->';
    const endMarker = '<!-- AI_GENERATED_END -->';
    const generatedBlock = `${startMarker}\n# ${subdir.name}\n\n${fileList}\n${endMarker}`;

    const readmePath = path.join(subdirPath, 'README.ai.md');

    if (fs.existsSync(readmePath)) {
      const existing = fs.readFileSync(readmePath, 'utf-8');
      const startIdx = existing.indexOf(startMarker);
      const endIdx = existing.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        const updated = existing.slice(0, startIdx) + generatedBlock + existing.slice(endIdx + endMarker.length);
        fs.writeFileSync(readmePath, updated, 'utf-8');
      } else {
        fs.writeFileSync(readmePath, generatedBlock + '\n', 'utf-8');
      }
    } else {
      fs.writeFileSync(readmePath, generatedBlock + '\n', 'utf-8');
    }

    generated.push(readmePath);

    // Generate PATH.ai.md containing full path index
    const pathContent = `${startMarker}\n# ${subdir.name} — Path Index\n\nBase: \`${subdirPath}\`\n\n${subEntries.map(e => `- \`${path.join(subdirPath, e.name)}${e.isDirectory() ? '/' : ''}\``).sort().join('\n')}\n${endMarker}`;
    const pathFilePath = path.join(subdirPath, 'PATH.ai.md');

    if (fs.existsSync(pathFilePath)) {
      const existing = fs.readFileSync(pathFilePath, 'utf-8');
      const startIdx = existing.indexOf(startMarker);
      const endIdx = existing.indexOf(endMarker);
      if (startIdx !== -1 && endIdx !== -1) {
        const updated = existing.slice(0, startIdx) + pathContent + existing.slice(endIdx + endMarker.length);
        fs.writeFileSync(pathFilePath, updated, 'utf-8');
      } else {
        fs.writeFileSync(pathFilePath, pathContent + '\n', 'utf-8');
      }
    } else {
      fs.writeFileSync(pathFilePath, pathContent + '\n', 'utf-8');
    }
    generated.push(pathFilePath);
  }

  return generated;
}
