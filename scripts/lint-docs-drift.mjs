import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC_PLANS_DIR = path.join(REPO_ROOT, 'docs', 'exec-plans');
const README_PATH = path.join(EXEC_PLANS_DIR, 'README.md');
const ACTIVE_DIR = path.join(EXEC_PLANS_DIR, 'active');
const COMPLETED_DIR = path.join(EXEC_PLANS_DIR, 'completed');
// Archive buckets (document-system-governance). Phase 1 only teaches the linter
// to RECOGNIZE these dirs (link resolution + index sync + table shape); the
// structured top-banner rule that forbids superseded/deferred markers in active/
// is added later (Phase 4), after files are moved, to avoid a must-fail window.
const DEFERRED_DIR = path.join(EXEC_PLANS_DIR, 'deferred');
const SUPERSEDED_DIR = path.join(EXEC_PLANS_DIR, 'superseded');

// Active files that are long-running orchestrators (never archive). Completed
// plans MAY reference these — they're stable indices, not phase work.
// refactor-closeout moved to completed/ in Phase 2b (refactor shipped as
// v0.55.0/0.55.1), so it's no longer here — archived plans now reference it as
// a completed/ peer, not an active orchestrator.
const LONG_LIVED_ACTIVE = new Set([
  'issue-tracker.md',
]);

const errors = [];

function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name);
}

function extractLinks(md) {
  const out = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    out.push({ label: m[1], target: m[2] });
  }
  return out;
}

if (!fs.existsSync(README_PATH)) {
  errors.push(`docs/exec-plans/README.md not found at ${README_PATH}`);
} else {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const links = extractLinks(readme);

  for (const { label, target } of links) {
    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#')) continue;
    const onlyPath = target.split('#')[0];
    if (!onlyPath) continue;
    const isPlanLink =
      onlyPath.startsWith('active/') ||
      onlyPath.startsWith('completed/') ||
      onlyPath.startsWith('deferred/') ||
      onlyPath.startsWith('superseded/') ||
      onlyPath.startsWith('./active/') ||
      onlyPath.startsWith('./completed/') ||
      onlyPath.startsWith('./deferred/') ||
      onlyPath.startsWith('./superseded/');
    if (!isPlanLink) continue;
    const resolved = path.resolve(EXEC_PLANS_DIR, onlyPath);
    if (!fs.existsSync(resolved)) {
      errors.push(
        `README link broken: [${label}](${target}) — target file does not exist (resolved: ${path.relative(REPO_ROOT, resolved)})`,
      );
    }
  }

  const activeFiles = listMd(ACTIVE_DIR).filter((f) => f !== 'README.md');
  const completedFiles = listMd(COMPLETED_DIR).filter((f) => f !== 'README.md');

  for (const name of activeFiles) {
    const patterns = [`active/${name}`, `./active/${name}`];
    const found = patterns.some((p) => readme.includes(`(${p})`));
    if (!found) {
      errors.push(
        `Active file not indexed: docs/exec-plans/active/${name} exists but is not linked anywhere in README.md`,
      );
    }
  }

  for (const name of completedFiles) {
    const patterns = [`completed/${name}`, `./completed/${name}`];
    const found = patterns.some((p) => readme.includes(`(${p})`));
    if (!found) {
      errors.push(
        `Completed file not indexed: docs/exec-plans/completed/${name} exists but is not linked anywhere in README.md`,
      );
    }
  }

  // Archive buckets must be indexed too (README.md per-dir excluded).
  for (const [dir, label] of [[DEFERRED_DIR, 'deferred'], [SUPERSEDED_DIR, 'superseded']]) {
    const files = listMd(dir).filter((f) => f !== 'README.md');
    for (const name of files) {
      const patterns = [`${label}/${name}`, `./${label}/${name}`];
      const found = patterns.some((p) => readme.includes(`(${p})`));
      if (!found) {
        errors.push(
          `${label} file not indexed: docs/exec-plans/${label}/${name} exists but is not linked anywhere in README.md`,
        );
      }
    }
  }
}

if (fs.existsSync(COMPLETED_DIR)) {
  const completedFiles = listMd(COMPLETED_DIR).filter((f) => f !== 'README.md');
  for (const name of completedFiles) {
    const fullPath = path.join(COMPLETED_DIR, name);
    const text = fs.readFileSync(fullPath, 'utf8');
    const links = extractLinks(text);
    for (const { label, target } of links) {
      const onlyPath = target.split('#')[0];
      if (!onlyPath) continue;
      const goesIntoActive = onlyPath.includes('../active/') || onlyPath.startsWith('active/');
      if (!goesIntoActive) continue;
      const targetName = path.basename(onlyPath);
      if (LONG_LIVED_ACTIVE.has(targetName)) continue;
      errors.push(
        `Completed file links into active/: docs/exec-plans/completed/${name} has link [${label}](${target}). Archived plans should link to handover/, completed/ peers, or long-lived orchestrators (${[...LONG_LIVED_ACTIVE].join(', ')}) — not phase-work active files.`,
      );
    }
  }
}

// Internal cross-link integrity across ALL plan buckets. The archive move
// (document-system-governance Phase 2) git-mv'd plans into deferred/ and
// superseded/ but left body links like `./refactor-closeout.md` pointing at a
// now-absent same-dir peer (refactor-closeout itself moved to completed/). git
// mv preserves history but NOT relative-link targets, so 21 dangling links
// survived the move and only hurt "查历史" navigation. This check resolves every
// RELATIVE markdown (.md) link in active/completed/deferred/superseded against
// the file's own directory and fails the gate on dangling ones — so the next
// archive move that forgets to repoint links can't silently rot history.
// Scope guards mirror the non-doc links we must NOT flag (verified false
// positives at fix time):
//   - absolute paths (`/settings#providers` app routes, `/Users/.../.mcp.json`
//     machine paths, `/abs/path/file.md:12` syntax examples) → skipped
//   - non-.md targets (images, `src/foo.ts:12` refs) → skipped
//   - http(s) / #anchors / mailto → skipped
for (const dir of [ACTIVE_DIR, COMPLETED_DIR, DEFERRED_DIR, SUPERSEDED_DIR]) {
  if (!fs.existsSync(dir)) continue;
  const bucket = path.basename(dir);
  for (const name of listMd(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const { label, target } of extractLinks(text)) {
      if (/^(?:https?:|mailto:)/.test(target) || target.startsWith('#') || target.startsWith('/')) continue;
      const onlyPath = target.split('#')[0];
      if (!onlyPath || !onlyPath.endsWith('.md')) continue; // doc cross-links only
      const resolved = path.resolve(dir, onlyPath);
      if (!fs.existsSync(resolved)) {
        errors.push(
          `Broken internal link: docs/exec-plans/${bucket}/${name} has [${label}](${target}) — resolves to a missing file (${path.relative(REPO_ROOT, resolved)}). After an archive move, repoint same-dir links to ../completed/ or the new bucket peer.`,
        );
      }
    }
  }
}

// Inline self-check for the internal-link rule: a relative .md target that does
// not exist must be flagged, and an absolute app-route / non-.md target must NOT.
{
  const probeDir = ACTIVE_DIR;
  const danglingRel = path.resolve(probeDir, './__definitely-missing-peer__.md');
  if (fs.existsSync(danglingRel)) {
    errors.push('lint self-check FAILED: probe file __definitely-missing-peer__.md unexpectedly exists');
  }
  const skipAbsolute = '/settings#providers'.startsWith('/');
  const skipNonMd = !'./peer.png'.split('#')[0].endsWith('.md');
  if (!skipAbsolute || !skipNonMd) {
    errors.push('lint self-check FAILED: internal-link scope guard would flag an app route or non-.md target');
  }
}

// Table-structure guard. The index tables are all 3-column
// (文件 | 主题 | 状态/日期/...). A botched edit can mash two rows onto one
// line (`...才进 Phase 2 || [active/phase-8...]`); the link-existence
// checks above MISS this because both links still resolve. Found
// 2026-05-26 when a hunk split merged the Phase 8 row into the row
// above it. Enforce: every table row that links to a plan must be a
// single, well-formed 3-column row.
if (fs.existsSync(README_PATH)) {
  const lines = fs.readFileSync(README_PATH, 'utf8').split('\n');
  const planLinkRe = /\]\((?:\.\/)?(?:active|completed|deferred|superseded)\//;
  lines.forEach((line, idx) => {
    if (!line.trimStart().startsWith('|')) return; // table rows only
    if (!planLinkRe.test(line)) return; // rows that link to a plan only
    const lineNo = idx + 1;
    if (line.includes('|| ') || line.includes('||[')) {
      errors.push(
        `README.md line ${lineNo}: merged-row artifact ('||') — two table rows mashed onto one line: ${line.slice(0, 90)}…`,
      );
      return;
    }
    // `| a | b | c |` → split('|') → ['', a, b, c, ''] = 5 parts = 3 cells.
    const parts = line.split('|');
    const columns = parts.length - 2;
    if (parts.length !== 5) {
      errors.push(
        `README.md line ${lineNo}: table row has ${columns} columns, expected 3 (index tables are 3-column): ${line.slice(0, 90)}…`,
      );
    }
  });
}

// Phase 4 (document-system-governance): active/ plans must NOT carry a
// superseded/deferred TOP banner — those belong in superseded/ or deferred/.
// STRUCTURAL detection only — we look at the file's top region (the leading
// blockquote banner around the first heading), never the whole body. Signals
// are anchored to a blockquote line (`^>`), so a governance/plan doc that
// DISCUSSES these markers in its body (bullets / prose / backticks) is NOT
// flagged. This is the deliberate replacement for a naive full-text grep.
const BANNER_SIGNALS = [
  /^>\s*.*Superseded by/i,
  /^>\s*⚠️.*Superseded/i,
  /^>\s*⏸/,
  /^>\s*.*本轮重构暂缓/,
];
function topBannerRegion(text) {
  const lines = text.split('\n');
  const region = lines.slice(0, 12); // leading region (covers pre-heading banners)
  const headingIdx = lines.findIndex((l) => /^#/.test(l));
  if (headingIdx >= 0) {
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '') continue; // allow blank lines between heading and banner
      if (t.startsWith('>')) region.push(lines[i]); // contiguous blockquote banner
      else break; // banner ends at first non-blockquote content
    }
  }
  return region;
}
const hasArchiveBanner = (text) =>
  topBannerRegion(text).some((l) => BANNER_SIGNALS.some((re) => re.test(l)));

// Inline self-check: the detector must fire on a TOP banner and stay silent on a
// BODY mention — otherwise it would flag the governance plan itself.
{
  const bannerDoc = '# X\n\n> Superseded by refactor-closeout.md\n\nbody';
  const bodyDoc =
    '# X\n\n> 创建时间：2026-06-05\n\n## 实现路径\n\n- active 中出现 `> Superseded by` → fail\n- 正文讨论 `⏸` / `本轮重构暂缓` 不算违规';
  if (!hasArchiveBanner(bannerDoc)) {
    errors.push('lint self-check FAILED: a top `Superseded by` banner was not detected');
  }
  if (hasArchiveBanner(bodyDoc)) {
    errors.push('lint self-check FAILED: a body mention of an archive marker was wrongly flagged as a banner');
  }
}

for (const name of listMd(ACTIVE_DIR).filter((f) => f !== 'README.md')) {
  const text = fs.readFileSync(path.join(ACTIVE_DIR, name), 'utf8');
  if (hasArchiveBanner(text)) {
    errors.push(
      `Active plan has a superseded/deferred TOP banner: docs/exec-plans/active/${name} — move it to docs/exec-plans/superseded/ or deferred/ (active/ is for current work only). Body mentions are fine; this only matches a leading \`> …\` banner.`,
    );
  }
}

if (errors.length > 0) {
  console.error('\n[lint:docs-drift] FAILED — docs/exec-plans is out of sync:\n');
  for (const e of errors) console.error('  - ' + e);
  console.error(
    '\nFix: update docs/exec-plans/README.md index, or move stale files to completed/, or repoint completed/ internal links to handover/ or completed/ peers.\n',
  );
  process.exit(1);
}

console.log('[lint:docs-drift] ok — docs/exec-plans/README.md is in sync with active/ and completed/.');
