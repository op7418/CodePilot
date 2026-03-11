import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { getClaudeCandidatePaths, getExtraPathDirs } from '../../lib/platform';

describe('platform claude detection', () => {
  it('includes Scoop shim directories in expanded Windows PATH', () => {
    if (process.platform !== 'win32') return;

    const home = os.homedir();
    const dirs = getExtraPathDirs();

    assert.ok(
      dirs.includes(path.join(home, 'scoop', 'shims')),
      'expected user Scoop shim dir to be searched',
    );

    const programData = process.env.ProgramData || 'C:\\ProgramData';
    assert.ok(
      dirs.includes(path.join(programData, 'scoop', 'shims')),
      'expected system Scoop shim dir to be searched',
    );
  });

  it('includes Scoop claude wrapper candidates on Windows', () => {
    if (process.platform !== 'win32') return;

    const home = os.homedir();
    const candidates = getClaudeCandidatePaths();

    assert.ok(
      candidates.includes(path.join(home, 'scoop', 'shims', 'claude.cmd')),
      'expected user Scoop claude.cmd candidate',
    );

    const programData = process.env.ProgramData || 'C:\\ProgramData';
    assert.ok(
      candidates.includes(path.join(programData, 'scoop', 'shims', 'claude.cmd')),
      'expected system Scoop claude.cmd candidate',
    );
  });

  it('includes Node.js global install directory candidates on Windows', () => {
    if (process.platform !== 'win32') return;

    const candidates = getClaudeCandidatePaths();
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    assert.ok(
      candidates.includes(path.join(programFiles, 'nodejs', 'claude.cmd')),
      'expected Program Files nodejs claude.cmd candidate',
    );

    assert.ok(
      candidates.includes(path.join(programFilesX86, 'nodejs', 'claude.cmd')),
      'expected Program Files (x86) nodejs claude.cmd candidate',
    );
  });
});
