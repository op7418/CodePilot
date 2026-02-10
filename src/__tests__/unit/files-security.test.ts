/**
 * Unit tests for file API path traversal security fixes.
 *
 * Run with: npx tsx src/__tests__/unit/files-security.test.ts
 *
 * Tests verify that:
 * 1. isPathSafe correctly prevents path traversal attacks
 * 2. Paths outside the base directory are rejected
 * 3. Symlink-based escapes are caught
 * 4. Edge cases (root, same path, trailing separators) are handled
 * 5. isRootPath correctly identifies filesystem roots
 * 6. getPathDepth returns correct depth values
 * 7. isBaseDirUnsafe blocks shallow/system directories
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Import the functions under test
import { isPathSafe, isRootPath, getPathDepth, isBaseDirUnsafe } from '../../lib/files';

describe('isPathSafe', () => {
  it('should allow paths within the base directory', () => {
    assert.equal(isPathSafe('/home/user/project', '/home/user/project/src/index.ts'), true);
    assert.equal(isPathSafe('/home/user/project', '/home/user/project/package.json'), true);
    assert.equal(isPathSafe('/home/user/project', '/home/user/project/src/lib/utils.ts'), true);
  });

  it('should allow the base directory itself', () => {
    assert.equal(isPathSafe('/home/user/project', '/home/user/project'), true);
  });

  it('should reject paths outside the base directory', () => {
    assert.equal(isPathSafe('/home/user/project', '/home/user/other'), false);
    assert.equal(isPathSafe('/home/user/project', '/home/user'), false);
    assert.equal(isPathSafe('/home/user/project', '/etc/passwd'), false);
    assert.equal(isPathSafe('/home/user/project', '/tmp/malicious'), false);
  });

  it('should reject path traversal via ../', () => {
    // path.resolve will normalize these, but the resolved path should be outside base
    const base = '/home/user/project';
    const traversal = path.resolve(base, '../../etc/passwd');
    assert.equal(isPathSafe(base, traversal), false);
  });

  it('should reject directory names that are prefixes but not parents', () => {
    // /home/user/project-evil should NOT be allowed under /home/user/project
    assert.equal(isPathSafe('/home/user/project', '/home/user/project-evil/file.txt'), false);
    assert.equal(isPathSafe('/home/user/project', '/home/user/projectx'), false);
  });

  it('should handle Windows-style paths if on Windows', () => {
    if (process.platform === 'win32') {
      assert.equal(isPathSafe('C:\\Users\\user\\project', 'C:\\Users\\user\\project\\src\\index.ts'), true);
      assert.equal(isPathSafe('C:\\Users\\user\\project', 'D:\\other\\file.txt'), false);
    }
  });
});

describe('File API path traversal scenarios', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-test-'));
  const projectDir = path.join(tmpDir, 'myproject');
  const secretFile = path.join(tmpDir, 'secret.txt');

  // Setup test fixtures
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'index.ts'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'export default {};\n');
  fs.writeFileSync(secretFile, 'TOP SECRET DATA\n');

  it('should allow reading files inside the project', () => {
    const filePath = path.join(projectDir, 'index.ts');
    assert.equal(isPathSafe(projectDir, filePath), true);
  });

  it('should allow reading files in subdirectories', () => {
    const filePath = path.join(projectDir, 'src', 'app.ts');
    assert.equal(isPathSafe(projectDir, filePath), true);
  });

  it('should block reading files outside the project via relative path', () => {
    const maliciousPath = path.resolve(projectDir, '..', 'secret.txt');
    assert.equal(isPathSafe(projectDir, maliciousPath), false);
    // Verify the secret file actually exists (test is meaningful)
    assert.equal(fs.existsSync(maliciousPath), true);
  });

  it('should block reading system files', () => {
    assert.equal(isPathSafe(projectDir, '/etc/passwd'), false);
    assert.equal(isPathSafe(projectDir, '/etc/shadow'), false);
  });

  it('should block reading via encoded traversal after resolution', () => {
    // Even if someone tries URL-encoded ../, path.resolve normalizes it
    const resolved = path.resolve(projectDir, '..', '..', 'etc', 'passwd');
    assert.equal(isPathSafe(projectDir, resolved), false);
  });

  // Symlink test (only on Unix-like systems)
  if (process.platform !== 'win32') {
    it('should block symlink escape from project directory', () => {
      const symlinkPath = path.join(projectDir, 'escape-link');
      try {
        fs.symlinkSync('/etc', symlinkPath);
        const resolvedSymlink = fs.realpathSync(path.join(symlinkPath, 'passwd'));
        assert.equal(isPathSafe(projectDir, resolvedSymlink), false);
      } finally {
        try { fs.unlinkSync(symlinkPath); } catch { /* cleanup */ }
      }
    });
  }

  // Cleanup test fixtures
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('isRootPath', () => {
  it('should detect Unix root as a root path', () => {
    assert.equal(isRootPath('/'), true);
  });

  it('should detect Windows drive roots as root paths', () => {
    if (process.platform === 'win32') {
      assert.equal(isRootPath('C:\\'), true);
      assert.equal(isRootPath('D:\\'), true);
    }
  });

  it('should not treat regular directories as root paths', () => {
    assert.equal(isRootPath('/home/user/project'), false);
    assert.equal(isRootPath('/tmp'), false);
    assert.equal(isRootPath('/etc'), false);
    if (process.platform === 'win32') {
      assert.equal(isRootPath('C:\\Users\\user\\project'), false);
      assert.equal(isRootPath('D:\\projects'), false);
    }
  });
});

describe('getPathDepth', () => {
  it('should return 0 for filesystem roots', () => {
    assert.equal(getPathDepth('/'), 0);
    if (process.platform === 'win32') {
      assert.equal(getPathDepth('C:\\'), 0);
      assert.equal(getPathDepth('D:\\'), 0);
    }
  });

  it('should return 1 for top-level directories', () => {
    if (process.platform === 'win32') {
      assert.equal(getPathDepth('C:\\Users'), 1);
      assert.equal(getPathDepth('D:\\projects'), 1);
    } else {
      assert.equal(getPathDepth('/etc'), 1);
      assert.equal(getPathDepth('/tmp'), 1);
      assert.equal(getPathDepth('/var'), 1);
    }
  });

  it('should return 2 for two-level paths', () => {
    if (process.platform === 'win32') {
      assert.equal(getPathDepth('C:\\Users\\user'), 2);
      assert.equal(getPathDepth('D:\\projects\\myapp'), 2);
    } else {
      assert.equal(getPathDepth('/opt/projects'), 2);
      assert.equal(getPathDepth('/home/user'), 2);
    }
  });

  it('should return correct depth for deep paths', () => {
    if (process.platform === 'win32') {
      assert.equal(getPathDepth('C:\\Users\\user\\projects\\myapp'), 4);
    } else {
      assert.equal(getPathDepth('/home/user/projects/myapp'), 4);
    }
  });
});

describe('isBaseDirUnsafe', () => {
  it('should reject filesystem roots', () => {
    assert.equal(isBaseDirUnsafe('/'), true);
    if (process.platform === 'win32') {
      assert.equal(isBaseDirUnsafe('C:\\'), true);
      assert.equal(isBaseDirUnsafe('D:\\'), true);
    }
  });

  it('should reject shallow system directories (depth 1)', () => {
    if (process.platform === 'win32') {
      assert.equal(isBaseDirUnsafe('D:\\projects'), true);
    } else {
      assert.equal(isBaseDirUnsafe('/etc'), true);
      assert.equal(isBaseDirUnsafe('/tmp'), true);
      assert.equal(isBaseDirUnsafe('/var'), true);
    }
  });

  it('should allow directories with depth >= 2', () => {
    if (process.platform === 'win32') {
      assert.equal(isBaseDirUnsafe('D:\\projects\\myapp'), false);
      assert.equal(isBaseDirUnsafe('C:\\Users\\user'), false);
    } else {
      assert.equal(isBaseDirUnsafe('/opt/projects'), false);
      assert.equal(isBaseDirUnsafe('/home/user'), false);
      assert.equal(isBaseDirUnsafe('/home/user/projects/myapp'), false);
    }
  });
});

describe('baseDir validation', () => {
  it('should reject baseDir set to root (bypass attempt)', () => {
    assert.equal(isBaseDirUnsafe('/'), true);
  });

  it('should reject shallow system dirs as baseDir', () => {
    // /etc, /tmp etc. have depth 1 — too shallow for baseDir
    if (process.platform === 'win32') {
      assert.equal(isBaseDirUnsafe('D:\\projects'), true);
    } else {
      assert.equal(isBaseDirUnsafe('/etc'), true);
      assert.equal(isBaseDirUnsafe('/tmp'), true);
    }
  });

  it('should allow baseDir with sufficient depth outside home', () => {
    if (process.platform === 'win32') {
      assert.equal(isBaseDirUnsafe('D:\\projects\\myapp'), false);
    } else {
      assert.equal(isBaseDirUnsafe('/opt/projects'), false);
    }
  });

  it('should allow baseDir inside home directory', () => {
    const homeDir = os.homedir();
    const projectDir = path.join(homeDir, 'projects', 'myapp');
    assert.equal(isPathSafe(homeDir, projectDir), true);
  });

  it('should allow baseDir equal to home directory', () => {
    const homeDir = os.homedir();
    assert.equal(isPathSafe(homeDir, homeDir), true);
  });

  it('should block files outside home when no baseDir provided (fallback)', () => {
    const homeDir = os.homedir();
    assert.equal(isPathSafe(homeDir, '/etc/passwd'), false);
    assert.equal(isPathSafe(homeDir, '/tmp/malicious'), false);
  });

  it('should allow files inside home when no baseDir provided (fallback)', () => {
    const homeDir = os.homedir();
    const filePath = path.join(homeDir, 'documents', 'file.txt');
    assert.equal(isPathSafe(homeDir, filePath), true);
  });

  it('should allow dir within a non-home baseDir', () => {
    // This is the key fix: D:\\projects\\myapp should work as baseDir
    const baseDir = path.resolve('/opt/projects/myapp');
    const targetDir = path.join(baseDir, 'src', 'components');
    assert.equal(isPathSafe(baseDir, targetDir), true);
  });

  it('should block dir outside a non-home baseDir', () => {
    const baseDir = path.resolve('/opt/projects/myapp');
    const targetDir = path.resolve('/etc/passwd');
    assert.equal(isPathSafe(baseDir, targetDir), false);
  });
});
