/**
 * Phase 2 (2026-06-03) — clearer "new chat" entry points in the sidebar.
 *
 * User ask: the bare "+" on project rows read ambiguously, and the assistant
 * (which has no folder, so it sits at the top level) had no way to start a new
 * chat. Fix: use the "写新对话" pencil/compose icon (CodePilotIcon `edit`) on
 * project rows, and add the same compose entry to the top-level 助理 header.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const groupHeader = readFileSync(path.join(root, 'components/layout/ProjectGroupHeader.tsx'), 'utf8');
const chatList = readFileSync(path.join(root, 'components/layout/ChatListPanel.tsx'), 'utf8');

describe('project row new-chat affordance uses the compose (edit) icon, not a bare +', () => {
  it('the onCreateSession button renders the edit/pencil icon', () => {
    assert.match(
      groupHeader,
      /onClick=\{onCreateSession\}[\s\S]{0,160}name="edit"/,
      'the project/assistant new-chat button must use the compose (edit) icon',
    );
  });
  it('no longer uses name="plus" for that button', () => {
    // The only plus in this file would have been the new-chat button.
    assert.doesNotMatch(groupHeader, /name="plus"/);
  });
});

describe('assistant top-level header has a compose new-chat entry', () => {
  it('renders a button that creates a chat in the assistant workspace via the edit icon', () => {
    // The assistant has no folder, so its section header carries the compose
    // entry; it creates a session in the assistant workspace dir.
    assert.match(
      chatList,
      /handleCreateSessionInProject\(e, aGroup\.workingDirectory\)/,
      'assistant header must start a new chat in the assistant workspace',
    );
    // ...and it uses the same compose icon.
    assert.match(
      chatList,
      /aGroup\.workingDirectory\)[\s\S]{0,160}name="edit"/,
      'assistant new-chat entry must use the compose (edit) icon',
    );
  });
});

describe('sidebar empty-chat creation preserves the atomic route contract', () => {
  it('does not send the legacy model/provider pair without a Runtime', () => {
    assert.doesNotMatch(
      chatList,
      /getCurrentModelAndProvider|codepilot:last-model|codepilot:last-provider-id/,
      'an empty-chat entry must not reconstruct a partial route from localStorage',
    );

    const createBodies = [...chatList.matchAll(
      /body:\s*JSON\.stringify\(\{\s*working_directory:\s*([^,}\s]+)\s*\}\)/g,
    )];
    assert.equal(
      createBodies.length,
      3,
      'folder selection, global new chat, and project/assistant compose must all create an unbound session using only working_directory',
    );
  });
});
