import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DANGEROUSLY_SKIP_PERMISSIONS_UNSUPPORTED_CODE,
  getDangerouslySkipPermissionsSupport,
  isDangerouslySkipPermissionsSupported,
} from '../../lib/claude-permissions';

describe('claude-permissions', () => {
  it('allows auto-approve for non-root users on linux', () => {
    const result = getDangerouslySkipPermissionsSupport({
      platform: 'linux',
      uid: 1000,
      env: {} as NodeJS.ProcessEnv,
    });

    assert.equal(result.supported, true);
    assert.equal(
      isDangerouslySkipPermissionsSupported({
        platform: 'linux',
        uid: 1000,
        env: {} as NodeJS.ProcessEnv,
      }),
      true,
    );
  });

  it('blocks auto-approve for unsandboxed root on linux', () => {
    const result = getDangerouslySkipPermissionsSupport({
      platform: 'linux',
      uid: 0,
      env: {} as NodeJS.ProcessEnv,
    });

    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, DANGEROUSLY_SKIP_PERMISSIONS_UNSUPPORTED_CODE);
    assert.match(result.reason || '', /root\/sudo/i);
  });

  it('allows auto-approve for sandboxed root on linux', () => {
    const result = getDangerouslySkipPermissionsSupport({
      platform: 'linux',
      uid: 0,
      env: { IS_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv,
    });

    assert.equal(result.supported, true);
  });

  it('allows auto-approve on windows', () => {
    const result = getDangerouslySkipPermissionsSupport({
      platform: 'win32',
      uid: 0,
      env: {} as NodeJS.ProcessEnv,
    });

    assert.equal(result.supported, true);
  });
});
