import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRendererEditingContextMenuTemplate } from '../../../electron/editing-context-menu';

const root = path.resolve(__dirname, '../../..');
const readSource = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), 'utf8');

describe('workspace context-menu contracts', () => {
  it('gives Electron editable fields a native editing context menu', () => {
    const source = readSource('electron/main.ts');
    const helper = readSource('electron/editing-context-menu.ts');
    const start = source.indexOf('function attachRendererEditingContextMenu');
    const end = source.indexOf('function createWindow', start);
    const block = source.slice(start, end);

    assert.ok(start >= 0, 'native renderer editing menu helper must exist');
    assert.match(block, /webContents\.on\(['"]context-menu['"]/);
    assert.match(block, /buildRendererEditingContextMenuTemplate\(params\)/);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll']) {
      assert.match(helper, new RegExp(`role:\\s*['"]${role}['"]`), `missing ${role} role`);
    }
    assert.match(helper, /formControlType\s*===\s*['"]input-password['"]/);
    assert.doesNotMatch(source, /inputFieldType/);
    assert.match(source, /attachRendererEditingContextMenu\(mainWindow\)/);
  });

  it('disables cut and copy for password fields using Electron formControlType', () => {
    const allEnabled = {
      canUndo: true,
      canRedo: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
    };

    const passwordMenu = buildRendererEditingContextMenuTemplate({
      isEditable: true,
      selectionText: 'secret-token',
      formControlType: 'input-password',
      editFlags: allEnabled,
    });
    assert.ok(passwordMenu);
    assert.equal(passwordMenu.find((item) => item.role === 'cut')?.enabled, false);
    assert.equal(passwordMenu.find((item) => item.role === 'copy')?.enabled, false);
    assert.equal(passwordMenu.find((item) => item.role === 'paste')?.enabled, true);
    assert.equal(passwordMenu.find((item) => item.role === 'selectAll')?.enabled, true);

    const textMenu = buildRendererEditingContextMenuTemplate({
      isEditable: true,
      selectionText: 'hello',
      formControlType: 'input-text',
      editFlags: allEnabled,
    });
    assert.ok(textMenu);
    assert.equal(textMenu.find((item) => item.role === 'cut')?.enabled, true);
    assert.equal(textMenu.find((item) => item.role === 'copy')?.enabled, true);

    assert.equal(
      buildRendererEditingContextMenuTemplate({
        isEditable: false,
        selectionText: '',
        formControlType: 'none',
        editFlags: allEnabled,
      }),
      null,
    );
  });

  it('exposes project and conversation actions from row context menus', () => {
    const project = readSource('src/components/layout/ProjectGroupHeader.tsx');
    const session = readSource('src/components/layout/SessionListItem.tsx');

    assert.match(project, /<ContextMenuTrigger asChild>/);
    assert.match(project, /chatList\.newConversation/);
    assert.match(project, /chatList\.openFolder/);
    assert.match(project, /chatList\.copyFolderPath/);
    assert.match(project, /chatList\.removeProject/);

    assert.match(session, /<ContextMenuTrigger asChild>/);
    assert.match(session, /chatList\.splitScreen/);
    assert.match(session, /chatList\.renameConversation/);
    assert.match(session, /chatList\.copySessionId/);
    assert.match(session, /chatList\.deleteConversation/);
    assert.doesNotMatch(
      session,
      /onDelete\(event as unknown as React\.MouseEvent/,
      'Radix select events must not be cast to React mouse events',
    );
    assert.match(session, /onCloseAutoFocus/);
  });

  it('uses a modal new-item flow and keeps add-to-chat in file-tree context menus only', () => {
    const panel = readSource('src/components/layout/panels/FileTreePanel.tsx');
    const tree = readSource('src/components/ai-elements/file-tree.tsx');

    assert.match(panel, /<PromptDialog/);
    assert.doesNotMatch(panel, /newItemInputRef/);
    assert.doesNotMatch(tree, /name=["']plus["']/);
    assert.match(tree, /onAdd\(path,\s*["']directory["']\)/);
    assert.match(tree, /onAdd\(path,\s*["']file["']\)/);
    assert.match(tree, /onContextMenu=\{\(event\) => event\.stopPropagation\(\)\}/);
    assert.match(tree, /onCloseAutoFocus/);
    assert.match(panel, /selectStem=\{dialogItemMode === ["']file["']\}/);
  });
});
