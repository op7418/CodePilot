import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCliMcpListLine } from '../../lib/mcp-config';

describe('parseCliMcpListLine', () => {
  it('parses a basic stdio server line', () => {
    const parsed = parseCliMcpListLine('filesystem: npx -y @modelcontextprotocol/server-filesystem D:\\CodeProject - ✓ Connected');

    assert.deepEqual(parsed, {
      name: 'filesystem',
      config: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\CodeProject'],
      },
    });
  });

  it('preserves quoted paths and arguments with spaces', () => {
    const parsed = parseCliMcpListLine(
      'tools: cmd /c "C:\\Program Files\\nodejs\\npx.cmd" -y "@my scope/server" --name "foo bar" - ✓ Connected'
    );

    assert.deepEqual(parsed, {
      name: 'tools',
      config: {
        command: 'cmd',
        args: ['/c', 'C:\\Program Files\\nodejs\\npx.cmd', '-y', '@my scope/server', '--name', 'foo bar'],
      },
    });
  });

  it('uses the last status separator so command args may include " - "', () => {
    const parsed = parseCliMcpListLine(
      'reactbits: npx reactbits-dev-mcp-server --label "alpha - beta" - ✗ Failed'
    );

    assert.deepEqual(parsed, {
      name: 'reactbits',
      config: {
        command: 'npx',
        args: ['reactbits-dev-mcp-server', '--label', 'alpha - beta'],
      },
    });
  });

  it('returns null for malformed lines', () => {
    assert.equal(parseCliMcpListLine('no status separator here'), null);
    assert.equal(parseCliMcpListLine('bad: command - Connected'), null);
    assert.equal(parseCliMcpListLine(' : npx test - ✓ Connected'), null);
  });
});
