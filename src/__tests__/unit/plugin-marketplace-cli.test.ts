import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarketplacePluginRef,
  createMarketplacePluginSpawnSpec,
} from '../../lib/plugin-marketplace-cli';

describe('buildMarketplacePluginRef', () => {
  it('should build a plugin reference from safe name and marketplace', () => {
    assert.equal(
      buildMarketplacePluginRef({ name: 'safe-plugin', marketplace: 'official.market' }),
      'safe-plugin@official.market'
    );
  });

  it('should allow plugin names without marketplace', () => {
    assert.equal(
      buildMarketplacePluginRef({ name: 'safe_plugin-1.0' }),
      'safe_plugin-1.0'
    );
  });

  it('should reject unsafe plugin names', () => {
    assert.throws(
      () => buildMarketplacePluginRef({ name: 'safe-plugin; rm -rf /' }),
      /Invalid plugin name/
    );
  });

  it('should reject unsafe marketplace names', () => {
    assert.throws(
      () => buildMarketplacePluginRef({ name: 'safe-plugin', marketplace: 'official && evil' }),
      /Invalid marketplace name/
    );
  });
});

describe('createMarketplacePluginSpawnSpec', () => {
  it('should create install args and shell=true only for trusted cmd wrappers', () => {
    const spec = createMarketplacePluginSpawnSpec(
      {
        action: 'install',
        name: 'safe-plugin',
        marketplace: 'official.market',
        scope: 'project',
      },
      {
        findClaudeBinary: () => 'C:\\Users\\Admin\\AppData\\Roaming\\npm\\claude.cmd',
        getExpandedPath: () => 'TEST_PATH',
        needsShell: (binPath) => /\.cmd$/i.test(binPath),
        env: { HOME: 'test-home' },
      }
    );

    assert.equal(spec.command, 'C:\\Users\\Admin\\AppData\\Roaming\\npm\\claude.cmd');
    assert.deepEqual(spec.args, ['plugin', 'install', 'safe-plugin@official.market', '--scope', 'project']);
    assert.equal(spec.options.shell, true);
    assert.ok(spec.options.env);
    assert.equal(spec.options.env.PATH, 'TEST_PATH');
    assert.equal(spec.options.env.HOME, 'test-home');
  });

  it('should create uninstall args without shell when binary is not a wrapper', () => {
    const spec = createMarketplacePluginSpawnSpec(
      {
        action: 'uninstall',
        name: 'safe-plugin',
        marketplace: 'official.market',
        scope: 'user',
      },
      {
        findClaudeBinary: () => '/usr/local/bin/claude',
        getExpandedPath: () => '/usr/local/bin',
        needsShell: () => false,
        env: {},
      }
    );

    assert.equal(spec.command, '/usr/local/bin/claude');
    assert.deepEqual(spec.args, ['plugin', 'uninstall', 'safe-plugin@official.market', '--scope', 'user']);
    assert.equal(spec.options.shell, false);
  });

  it('should reject unsupported install scopes', () => {
    assert.throws(
      () => createMarketplacePluginSpawnSpec(
        {
          action: 'install',
          name: 'safe-plugin',
          scope: 'admin' as 'user',
        },
        {
          findClaudeBinary: () => '/usr/local/bin/claude',
          getExpandedPath: () => '/usr/local/bin',
          needsShell: () => false,
          env: {},
        }
      ),
      /Invalid plugin scope/
    );
  });

  it('should fail fast when Claude CLI is unavailable', () => {
    assert.throws(
      () => createMarketplacePluginSpawnSpec(
        {
          action: 'install',
          name: 'safe-plugin',
        },
        {
          findClaudeBinary: () => undefined,
          getExpandedPath: () => '',
          needsShell: () => false,
          env: {},
        }
      ),
      /Claude CLI not found/
    );
  });
});
