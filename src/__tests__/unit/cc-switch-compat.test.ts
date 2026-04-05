import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCcSwitchCompatGlobalDefaultPayload,
  shouldPersistCcSwitchCompatGlobalDefault,
} from '../../lib/cc-switch-compat';

describe('cc-switch compat helpers', () => {
  it('only persists global defaults for the built-in Claude Code provider', () => {
    assert.equal(shouldPersistCcSwitchCompatGlobalDefault(true, 'env', 'sonnet'), true);
    assert.equal(shouldPersistCcSwitchCompatGlobalDefault(true, 'some-db-provider', 'sonnet'), false);
    assert.equal(shouldPersistCcSwitchCompatGlobalDefault(false, 'env', 'sonnet'), false);
    assert.equal(shouldPersistCcSwitchCompatGlobalDefault(true, 'env', ''), false);
  });

  it('builds a payload that reuses the env/Claude Code provider as the global default target', () => {
    assert.deepEqual(
      buildCcSwitchCompatGlobalDefaultPayload('env', 'opus'),
      {
        providerId: '__global__',
        options: {
          default_model: 'opus',
          default_model_provider: 'env',
          legacy_default_provider_id: 'env',
        },
      },
    );
  });
});
