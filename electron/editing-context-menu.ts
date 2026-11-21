export interface RendererContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  formControlType: string;
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canDelete: boolean;
    canSelectAll: boolean;
  };
}

export interface RendererContextMenuItem {
  role?: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll';
  type?: 'separator';
  enabled?: boolean;
}

/**
 * Build the native editing context-menu template for renderer surfaces.
 *
 * Uses `params.formControlType === 'input-password'` (the replacement for the
 * removed `inputFieldType` field in Electron 35+) so password inputs never
 * enable cut or copy even when Chromium's editFlags report them as possible.
 */
export function buildRendererEditingContextMenuTemplate(
  params: RendererContextMenuParams,
): RendererContextMenuItem[] | null {
  const hasSelection = params.selectionText.length > 0;
  const isPassword = params.formControlType === 'input-password';

  if (!params.isEditable && !hasSelection) return null;

  if (params.isEditable) {
    return [
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      {
        role: 'cut',
        enabled: !isPassword && params.editFlags.canCut,
      },
      {
        role: 'copy',
        enabled: !isPassword && params.editFlags.canCopy,
      },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'delete', enabled: params.editFlags.canDelete },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ];
  }

  return [
    { role: 'copy', enabled: !isPassword && hasSelection },
    { type: 'separator' },
    { role: 'selectAll' },
  ];
}
