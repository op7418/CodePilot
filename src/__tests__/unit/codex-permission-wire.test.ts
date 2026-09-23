/** Codex auto-review permission mapping and runtime wiring guardrail. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  reconcileCodexPermissionEcho,
  resolveCodexPermissionWire,
} from '@/lib/codex/permission';

describe('resolveCodexPermissionWire', () => {
  it('auto_review keeps workspace sandbox and routes approvals to the model reviewer', () => {
    const wire = resolveCodexPermissionWire({ permissionMode: 'auto' });
    assert.deepEqual(wire.thread, {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
    });
    assert.deepEqual(wire.turn, {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: true },
    });
  });

  it('full access is the only branch that combines never + danger full access', () => {
    const wire = resolveCodexPermissionWire({
      permissionMode: 'bypassPermissions',
      bypassPermissions: true,
    });
    assert.equal(wire.thread.approvalPolicy, 'never');
    assert.equal(wire.thread.sandbox, 'danger-full-access');
    assert.deepEqual(wire.turn.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.notEqual(wire.thread.approvalsReviewer, 'auto_review');
  });

  it('plan is read-only and cannot escalate through approval prompts', () => {
    const wire = resolveCodexPermissionWire({ permissionMode: 'plan' });
    assert.deepEqual(wire.thread, {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    });
    assert.deepEqual(wire.turn.sandboxPolicy, { type: 'readOnly', networkAccess: true });
  });

  it('default asks the user inside a workspace sandbox', () => {
    const wire = resolveCodexPermissionWire({ permissionMode: 'acceptEdits' });
    assert.equal(wire.thread.approvalPolicy, 'on-request');
    assert.equal(wire.thread.approvalsReviewer, 'user');
    assert.equal(wire.thread.sandbox, 'workspace-write');
    assert.deepEqual(wire.turn.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: true,
    });
  });
});

describe('Codex thread response is the auto-review authority', () => {
  const requested = resolveCodexPermissionWire({ permissionMode: 'auto' });

  it('keeps auto only when app-server echoes auto_review', () => {
    const decision = reconcileCodexPermissionEcho({
      requested,
      response: { approvalsReviewer: 'auto_review' },
    });
    assert.equal(decision.degraded, false);
    assert.equal(decision.wire.turn.approvalsReviewer, 'auto_review');
  });

  for (const response of [{}, { approvalsReviewer: 'user' }]) {
    it(`fails closed for ${JSON.stringify(response)}`, () => {
      const decision = reconcileCodexPermissionEcho({ requested, response });
      assert.equal(decision.degraded, true);
      assert.equal(decision.wire.thread.approvalsReviewer, 'user');
      assert.equal(decision.wire.turn.approvalsReviewer, 'user');
      assert.equal(decision.wire.turn.approvalPolicy, 'on-request');
    });
  }

  it('does not reinterpret non-auto profiles', () => {
    const defaultWire = resolveCodexPermissionWire({ permissionMode: 'default' });
    const decision = reconcileCodexPermissionEcho({ requested: defaultWire, response: {} });
    assert.equal(decision.degraded, false);
    assert.equal(decision.wire, defaultWire);
  });
});

describe('Codex runtime consumes the permission mapping at every sticky boundary', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../lib/codex/runtime.ts'),
    'utf8',
  );

  it('thread start/resume share permission-bearing base params while start may add start-only fields', () => {
    assert.match(source, /let codexPermission = resolveCodexPermissionWire\(/);
    assert.match(source, /getCodexAutoReviewCapability\(\)/);
    assert.match(
      source,
      /!capability\.supported[\s\S]{0,300}resolveCodexPermissionWire\(\{ permissionMode: 'default' \}\)/,
    );
    assert.match(source, /const threadParams = \{[\s\S]{0,1200}\.\.\.codexPermission\.thread/);
    assert.match(source, /client\.request(?:<[^>]+>)?\('thread\/resume',[\s\S]{0,180}\.\.\.threadParams/);
    assert.match(
      source,
      /const threadStartParams =[\s\S]{0,300}\.\.\.threadParams/,
      'thread/start params must extend the same permission-bearing base used by resume',
    );
    const starts = [...source.matchAll(/['"]thread\/start['"],\s*\n?\s*threadStartParams/g)];
    assert.ok(
      starts.length >= 1,
      'the shared fresh/resume-fallback start callback must receive the permission-bearing params',
    );
  });

  it('validates every thread start/resume response before turn/start', () => {
    assert.match(source, /const applyPermissionEcho =/);
    assert.match(source, /thread\/resume[\s\S]{0,300}applyPermissionEcho\(result\)/);
    const starts = [...source.matchAll(/thread\/start[\s\S]{0,180}applyPermissionEcho\(result\)/g)];
    assert.ok(starts.length >= 1, 'the shared start callback must validate the reviewer echo');
  });

  it('turn/start explicitly refreshes reviewer, approval and sandbox settings', () => {
    assert.match(
      source,
      /client\.request<[^>]+>\('turn\/start',[\s\S]{0,700}\.\.\.codexPermission\.turn/,
    );
  });
});
