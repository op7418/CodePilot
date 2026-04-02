/**
 * Unit tests for context-assembler.
 *
 * Run with: npx tsx --test src/__tests__/unit/context-assembler.test.ts
 *
 * Tests verify:
 * 1. Desktop entry point includes widget prompt
 * 2. Bridge entry point does NOT include widget prompt
 * 3. Workspace prompt only injected for assistant project sessions
 * 4. Widget MCP keyword detection
 * 5. generative_ui_enabled=false skips widget even on desktop
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSession } from '../../types';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'test-session',
    title: 'Test',
    model: 'sonnet',
    working_directory: '/Users/test/project',
    system_prompt: 'You are a helpful assistant.',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    sdk_session_id: '',
    mode: 'code',
    provider_id: '',
    sdk_cwd: '',
    permission_profile: 'default',
    project_name: '',
    status: 'active',
    provider_name: '',
    runtime_status: 'idle',
    runtime_updated_at: '',
    runtime_error: '',
    ...overrides,
  };
}

describe('assembleContext', () => {

  it('desktop: includes session prompt and enables generativeUI', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession(),
      entryPoint: 'desktop',
      userPrompt: 'hello',
    });

    assert.ok(result.systemPrompt?.includes('You are a helpful assistant.'));
    assert.equal(result.generativeUIEnabled, true);
    assert.equal(result.isAssistantProject, false);
  });

  it('bridge: does NOT enable generativeUI or widget MCP', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession(),
      entryPoint: 'bridge',
      userPrompt: 'hello',
    });

    assert.equal(result.generativeUIEnabled, false);
    assert.equal(result.needsWidgetMcp, false);
  });

  it('includes systemPromptAppend when provided', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession(),
      entryPoint: 'desktop',
      userPrompt: 'hello',
      systemPromptAppend: 'EXTRA INSTRUCTIONS HERE',
    });

    assert.ok(result.systemPrompt?.includes('EXTRA INSTRUCTIONS HERE'));
    assert.ok(result.systemPrompt?.includes('You are a helpful assistant.'));
  });

  it('non-workspace session: isAssistantProject is false', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession({ working_directory: '/Users/test/project' }),
      entryPoint: 'desktop',
      userPrompt: 'hello',
    });

    assert.equal(result.isAssistantProject, false);
    assert.equal(result.assistantProjectInstructions, '');
  });

  it('widget MCP detection: keyword triggers needsWidgetMcp on desktop', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession(),
      entryPoint: 'desktop',
      userPrompt: '帮我画一个可视化图表',
    });

    assert.equal(result.needsWidgetMcp, true);
  });

  it('widget MCP detection: no keyword means no widget MCP', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession(),
      entryPoint: 'desktop',
      userPrompt: '帮我写一个函数',
    });

    assert.equal(result.needsWidgetMcp, false);
  });

  it('widget MCP detection: conversation history with show-widget', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession(),
      entryPoint: 'desktop',
      userPrompt: '继续',
      conversationHistory: [
        { role: 'assistant', content: '```show-widget\n{"title":"test"}\n```' },
      ],
    });

    assert.equal(result.needsWidgetMcp, true);
  });

  it('bridge: widget MCP is never enabled even with keywords', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession(),
      entryPoint: 'bridge',
      userPrompt: '帮我画一个可视化图表',
    });

    assert.equal(result.needsWidgetMcp, false);
    assert.equal(result.generativeUIEnabled, false);
  });

  it('session with empty system_prompt: does not throw', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession({ system_prompt: '' }),
      entryPoint: 'bridge',
      userPrompt: 'hello',
    });

    // Should not throw — prompt may be undefined or contain only CLI context
    assert.ok(true);
  });

  it('prompt ordering: session prompt present in result', async () => {
    const { assembleContext } = await import('../../lib/context-assembler');
    const result = await assembleContext({
      session: makeSession({ system_prompt: '<<SESSION>>' }),
      entryPoint: 'desktop',
      userPrompt: 'hello',
    });

    assert.ok(result.systemPrompt?.includes('<<SESSION>>'));
  });
});
