import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('chat route model persistence contract', () => {
  it('persists the resolved SDK model when a status event includes statusData.model', () => {
    const routePath = path.join(process.cwd(), 'src', 'app', 'api', 'chat', 'route.ts');
    const source = fs.readFileSync(routePath, 'utf8');

    assert.match(
      source,
      /if\s*\(statusData\.model\)\s*\{\s*updateSessionModel\(sessionId,\s*statusData\.model\);?\s*\}/,
    );
  });
});
