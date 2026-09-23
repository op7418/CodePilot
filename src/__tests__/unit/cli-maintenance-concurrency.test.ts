import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  __performCliMaintenanceUpdateForTest,
  __resetCliMaintenanceForTest,
  __setCliMaintenanceTestDependencies,
  isCliMaintenanceRunning,
} from '../../../electron/cli-maintenance';
import {
  __resetInstallLifecycleForTest,
  getInstallLifecycleOwner,
} from '../../../electron/install-lifecycle-coordinator';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CLI maintenance concurrent admission', () => {
  beforeEach(() => {
    __resetCliMaintenanceForTest();
    __resetInstallLifecycleForTest();
  });

  for (const competitor of ['claude', 'codex'] as const) {
    it(`rejects a concurrent ${competitor} update until the first admission releases`, async () => {
      const activeWork = deferred<Array<'chat' | 'bridge' | 'task'>>();
      let activityReads = 0;
      __setCliMaintenanceTestDependencies({
        activeWork: () => {
          activityReads += 1;
          return activeWork.promise;
        },
      });

      const first = __performCliMaintenanceUpdateForTest('claude');
      assert.equal(isCliMaintenanceRunning(), true);
      assert.equal(getInstallLifecycleOwner(), 'cli-maintenance');

      const rejected = await __performCliMaintenanceUpdateForTest(competitor);
      assert.equal(rejected.phase, 'error');
      assert.equal(rejected.errorCode, 'maintenance_in_progress');
      assert.equal(activityReads, 1);
      assert.equal(getInstallLifecycleOwner(), 'cli-maintenance');

      activeWork.resolve(['chat']);
      const completed = await first;
      assert.equal(completed.errorCode, 'active_work');
      assert.equal(isCliMaintenanceRunning(), false);
      assert.equal(getInstallLifecycleOwner(), null);
    });
  }
});
