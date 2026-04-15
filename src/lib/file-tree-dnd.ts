export const FILE_TREE_DRAG_MIME = 'application/x-codepilot-path';
export const FILE_TREE_DRAG_FALLBACK_MIME = 'text/x-codepilot-path';

export type FileTreeDragPayload = {
  path: string;
  name: string;
  type: 'file' | 'directory';
};

export function serializeFileTreeDragPayload(payload: FileTreeDragPayload): string {
  return JSON.stringify(payload);
}

export function parseFileTreeDragPayload(raw: string | null | undefined): FileTreeDragPayload | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<FileTreeDragPayload>;
    if (!parsed.path || typeof parsed.path !== 'string') return null;

    return {
      path: parsed.path,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      type: parsed.type === 'directory' ? 'directory' : 'file',
    };
  } catch {
    return null;
  }
}

export function hasFileTreeDragType(
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined,
): boolean {
  if (!dataTransfer) return false;

  const types = Array.from(dataTransfer.types as ArrayLike<string>);
  return types.includes(FILE_TREE_DRAG_MIME) || types.includes(FILE_TREE_DRAG_FALLBACK_MIME);
}

export function readFileTreeDragPayload(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'> | null | undefined,
): FileTreeDragPayload | null {
  if (!dataTransfer) return null;
  if (!hasFileTreeDragType(dataTransfer)) return null;

  return parseFileTreeDragPayload(
    dataTransfer.getData(FILE_TREE_DRAG_MIME)
    || dataTransfer.getData(FILE_TREE_DRAG_FALLBACK_MIME),
  );
}

export function appendPathMention(inputValue: string, path: string): string {
  const mention = `@${path}`;
  if (inputValue.includes(mention)) return inputValue;

  const needsSpace = inputValue.length > 0 && !inputValue.endsWith(' ') && !inputValue.endsWith('\n');
  return `${inputValue}${needsSpace ? ' ' : ''}${mention} `;
}
