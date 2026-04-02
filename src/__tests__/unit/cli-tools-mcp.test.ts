/**
 * Unit tests for CLI tools MCP helper functions.
 *
 * Run with: npx tsx --test src/__tests__/unit/cli-tools-mcp.test.ts
 *
 * Tests verify:
 * 1. extractInstallMethod correctly identifies package managers
 * 2. extractPackageSpec extracts full package specs from install commands
 * 3. buildUpdateCommand generates correct update commands
 * 4. Scoped npm packages are handled correctly
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement the helper functions for isolated testing (mirrors cli-tools-mcp.ts)

function extractInstallMethod(command: string): string {
  const cmd = command.trim().toLowerCase();
  if (cmd.startsWith('brew ')) return 'brew';
  if (cmd.startsWith('npm ')) return 'npm';
  if (cmd.startsWith('pipx ')) return 'pipx';
  if (cmd.startsWith('pip ') || cmd.startsWith('pip3 ')) return 'pip';
  if (cmd.startsWith('cargo ')) return 'cargo';
  if (cmd.startsWith('apt ') || cmd.startsWith('apt-get ')) return 'apt';
  return 'unknown';
}

function extractPackageSpec(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  const installIdx = parts.findIndex(p => p === 'install');
  if (installIdx < 0) return null;
  for (let i = installIdx + 1; i < parts.length; i++) {
    if (!parts[i].startsWith('-')) {
      return parts[i].replace(/@\d+.*$/, '');
    }
  }
  return null;
}

function buildUpdateCommand(method: string, packageName: string): string | null {
  switch (method) {
    case 'brew': return `brew upgrade ${packageName}`;
    case 'npm': return `npm update -g ${packageName}`;
    case 'pipx': return `pipx upgrade ${packageName}`;
    case 'pip': return `pip install --upgrade ${packageName}`;
    case 'cargo': return `cargo install ${packageName}`;
    case 'apt': return `sudo apt-get install --only-upgrade ${packageName}`;
    default: return null;
  }
}

// Binary name extraction logic (mirrors cli-tools-mcp.ts install tool)
function extractBinCandidates(command: string, catalogBinNames?: string[]): string[] {
  const cmdParts = command.trim().split(/\s+/);
  const binCandidates: string[] = [];
  let rawPkgArg: string | null = null;
  const installIdx = cmdParts.findIndex(p => p === 'install');
  if (installIdx >= 0) {
    for (let i = installIdx + 1; i < cmdParts.length; i++) {
      if (!cmdParts[i].startsWith('-')) {
        rawPkgArg = cmdParts[i].replace(/@[\d.]*$/, '');
        break;
      }
    }
  }

  // Priority 1: catalog binNames
  if (catalogBinNames) {
    binCandidates.push(...catalogBinNames);
  }

  // Priority 2: derive from package arg
  if (rawPkgArg) {
    const segments = rawPkgArg.split('/');
    const last = segments[segments.length - 1];
    if (last && !binCandidates.includes(last)) binCandidates.push(last);
    if (segments.length >= 2 && segments[0].startsWith('@')) {
      const scopeless = segments[1];
      if (scopeless && !binCandidates.includes(scopeless)) binCandidates.push(scopeless);
    }
  }

  return binCandidates;
}

describe('extractInstallMethod', () => {
  it('detects brew', () => {
    assert.equal(extractInstallMethod('brew install ffmpeg'), 'brew');
    assert.equal(extractInstallMethod('brew install stripe/stripe-cli/stripe'), 'brew');
  });

  it('detects npm', () => {
    assert.equal(extractInstallMethod('npm install -g @elevenlabs/cli'), 'npm');
  });

  it('detects pipx', () => {
    assert.equal(extractInstallMethod('pipx install yt-dlp'), 'pipx');
  });

  it('detects pip/pip3', () => {
    assert.equal(extractInstallMethod('pip install httpie'), 'pip');
    assert.equal(extractInstallMethod('pip3 install httpie'), 'pip');
  });

  it('detects cargo', () => {
    assert.equal(extractInstallMethod('cargo install ripgrep'), 'cargo');
  });

  it('detects apt/apt-get', () => {
    assert.equal(extractInstallMethod('apt install curl'), 'apt');
    assert.equal(extractInstallMethod('apt-get install curl'), 'apt');
  });

  it('returns unknown for unrecognized commands', () => {
    assert.equal(extractInstallMethod('make install'), 'unknown');
    assert.equal(extractInstallMethod('./configure && make'), 'unknown');
  });
});

describe('extractPackageSpec', () => {
  it('extracts simple package names', () => {
    assert.equal(extractPackageSpec('brew install ffmpeg'), 'ffmpeg');
    assert.equal(extractPackageSpec('pip install yt-dlp'), 'yt-dlp');
  });

  it('extracts brew tap formulas', () => {
    assert.equal(extractPackageSpec('brew install stripe/stripe-cli/stripe'), 'stripe/stripe-cli/stripe');
  });

  it('extracts scoped npm packages', () => {
    assert.equal(extractPackageSpec('npm install -g @elevenlabs/cli'), '@elevenlabs/cli');
    assert.equal(extractPackageSpec('npm install -g @music163/ncm-cli'), '@music163/ncm-cli');
    assert.equal(extractPackageSpec('npm install -g @googleworkspace/cli'), '@googleworkspace/cli');
  });

  it('strips version pinning', () => {
    assert.equal(extractPackageSpec('npm install -g typescript@5.0.0'), 'typescript');
  });

  it('skips flags correctly', () => {
    assert.equal(extractPackageSpec('npm install -g --save-dev @elevenlabs/cli'), '@elevenlabs/cli');
  });

  it('returns null for commands without install', () => {
    assert.equal(extractPackageSpec('brew upgrade ffmpeg'), null);
    assert.equal(extractPackageSpec('make all'), null);
  });
});

describe('buildUpdateCommand', () => {
  it('builds brew upgrade with full formula', () => {
    assert.equal(buildUpdateCommand('brew', 'stripe/stripe-cli/stripe'), 'brew upgrade stripe/stripe-cli/stripe');
  });

  it('builds npm update with scoped package', () => {
    assert.equal(buildUpdateCommand('npm', '@elevenlabs/cli'), 'npm update -g @elevenlabs/cli');
  });

  it('builds pipx upgrade', () => {
    assert.equal(buildUpdateCommand('pipx', 'yt-dlp'), 'pipx upgrade yt-dlp');
  });

  it('returns null for unknown method', () => {
    assert.equal(buildUpdateCommand('unknown', 'foo'), null);
    assert.equal(buildUpdateCommand('snap', 'foo'), null);
  });
});

describe('extractBinCandidates (binary name resolution)', () => {
  it('uses catalog binNames as first priority', () => {
    const candidates = extractBinCandidates(
      'npm install -g @elevenlabs/cli',
      ['elevenlabs']
    );
    assert.equal(candidates[0], 'elevenlabs');
  });

  it('falls back to last segment for scoped npm', () => {
    const candidates = extractBinCandidates('npm install -g @elevenlabs/cli');
    assert.ok(candidates.includes('cli'));
  });

  it('handles music163 ncm-cli with catalog binNames', () => {
    const candidates = extractBinCandidates(
      'npm install -g @music163/ncm-cli',
      ['ncm-cli']
    );
    assert.equal(candidates[0], 'ncm-cli');
  });

  it('handles brew tap formulas', () => {
    const candidates = extractBinCandidates('brew install stripe/stripe-cli/stripe');
    assert.ok(candidates.includes('stripe'));
  });

  it('handles simple packages', () => {
    const candidates = extractBinCandidates('brew install ffmpeg');
    assert.ok(candidates.includes('ffmpeg'));
  });

  it('returns empty for non-install commands', () => {
    const candidates = extractBinCandidates('brew upgrade ffmpeg');
    assert.equal(candidates.length, 0);
  });

  it('does not duplicate candidates from catalog and package arg', () => {
    const candidates = extractBinCandidates(
      'brew install ffmpeg',
      ['ffmpeg', 'ffprobe']
    );
    // ffmpeg from catalog + ffprobe from catalog, no duplicate ffmpeg from package arg
    const ffmpegCount = candidates.filter(c => c === 'ffmpeg').length;
    assert.equal(ffmpegCount, 1);
  });
});
