import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findMissingDirectories } from '../../lib/directory-existence';

describe('findMissingDirectories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-dir-exists-'));
  const existingDir = path.join(tmpDir, 'existing');
  const anotherDir = path.join(tmpDir, 'another');
  const missingDir = path.join(tmpDir, 'missing');

  fs.mkdirSync(existingDir, { recursive: true });
  fs.mkdirSync(anotherDir, { recursive: true });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return only missing directories in stable order', async () => {
    const result = await findMissingDirectories([
      existingDir,
      missingDir,
      anotherDir,
    ]);

    assert.deepEqual(result, [missingDir]);
  });

  it('should deduplicate repeated directories before checking', async () => {
    const result = await findMissingDirectories([
      missingDir,
      missingDir,
      existingDir,
      existingDir,
    ]);

    assert.deepEqual(result, [missingDir]);
  });
});
