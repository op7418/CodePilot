import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { collectFrameworkNestedCode } = require('../../../scripts/after-sign.js') as {
  collectFrameworkNestedCode(frameworkPath: string): string[];
};

let tempRoot = '';

function writeFile(relative: string, mode: number): void {
  const file = path.join(tempRoot, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, mode);
}

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

describe('after-sign ad-hoc framework order', () => {
  it('seals nested helpers and libraries before the framework, excluding its main binary', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'after-sign-order-'));
    const framework = 'Electron Framework.framework';
    writeFile(`${framework}/Versions/A/Electron Framework`, 0o755);
    writeFile(`${framework}/Versions/A/Helpers/app_shim_loader`, 0o755);
    writeFile(`${framework}/Versions/A/Helpers/chrome_crashpad_handler`, 0o755);
    writeFile(`${framework}/Versions/A/Libraries/libEGL.dylib`, 0o644);
    writeFile(`${framework}/Versions/A/Resources/Info.plist`, 0o644);
    fs.symlinkSync('A', path.join(tempRoot, `${framework}/Versions/Current`));
    fs.symlinkSync('Versions/Current/Electron Framework', path.join(tempRoot, `${framework}/Electron Framework`));

    const frameworkPath = path.join(tempRoot, framework);
    const nested = collectFrameworkNestedCode(frameworkPath).map((file) => path.relative(frameworkPath, file));

    assert.deepEqual(nested, [
      'Versions/A/Helpers/app_shim_loader',
      'Versions/A/Helpers/chrome_crashpad_handler',
      'Versions/A/Libraries/libEGL.dylib',
    ]);
  });

  it('orders deeper nested code before shallower code', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'after-sign-order-'));
    const framework = 'Squirrel.framework';
    writeFile(`${framework}/Versions/A/Squirrel`, 0o755);
    writeFile(`${framework}/Versions/A/Resources/ShipIt`, 0o755);
    writeFile(`${framework}/Versions/A/Resources/deep/nested/tool`, 0o755);

    const frameworkPath = path.join(tempRoot, framework);
    const nested = collectFrameworkNestedCode(frameworkPath).map((file) => path.relative(frameworkPath, file));

    assert.deepEqual(nested, [
      'Versions/A/Resources/deep/nested/tool',
      'Versions/A/Resources/ShipIt',
    ]);
  });
});
