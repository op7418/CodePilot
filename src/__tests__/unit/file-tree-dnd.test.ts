import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendPathMention,
  FILE_TREE_DRAG_FALLBACK_MIME,
  FILE_TREE_DRAG_MIME,
  hasFileTreeDragType,
  parseFileTreeDragPayload,
  readFileTreeDragPayload,
  serializeFileTreeDragPayload,
} from '../../lib/file-tree-dnd';

describe('file-tree drag payload helpers', () => {
  const makeTypes = (...types: string[]) => types as unknown as readonly string[];

  it('serializes and parses file payload', () => {
    const raw = serializeFileTreeDragPayload({
      path: 'src/app/page.tsx',
      name: 'page.tsx',
      type: 'file',
    });

    assert.deepEqual(parseFileTreeDragPayload(raw), {
      path: 'src/app/page.tsx',
      name: 'page.tsx',
      type: 'file',
    });
  });

  it('normalizes unknown type to file', () => {
    assert.deepEqual(
      parseFileTreeDragPayload('{"path":"src","name":"src","type":"weird"}'),
      { path: 'src', name: 'src', type: 'file' },
    );
  });

  it('rejects invalid payloads', () => {
    assert.equal(parseFileTreeDragPayload(''), null);
    assert.equal(parseFileTreeDragPayload('not-json'), null);
    assert.equal(parseFileTreeDragPayload('{"name":"src"}'), null);
  });

  it('detects supported drag MIME types', () => {
    assert.equal(hasFileTreeDragType({ types: makeTypes(FILE_TREE_DRAG_MIME) }), true);
    assert.equal(hasFileTreeDragType({ types: makeTypes(FILE_TREE_DRAG_FALLBACK_MIME) }), true);
    assert.equal(hasFileTreeDragType({ types: makeTypes('text/plain') }), false);
  });

  it('reads payload from preferred MIME first', () => {
    const payload = readFileTreeDragPayload({
      types: makeTypes(FILE_TREE_DRAG_MIME, FILE_TREE_DRAG_FALLBACK_MIME),
      getData(type: string) {
        if (type === FILE_TREE_DRAG_MIME) {
          return '{"path":"src/components","name":"components","type":"directory"}';
        }
        return '';
      },
    });

    assert.deepEqual(payload, {
      path: 'src/components',
      name: 'components',
      type: 'directory',
    });
  });
});

describe('appendPathMention', () => {
  it('appends mention with trailing space', () => {
    assert.equal(appendPathMention('', 'src/app/page.tsx'), '@src/app/page.tsx ');
  });

  it('inserts spacing between existing text and mention', () => {
    assert.equal(
      appendPathMention('请看这个', 'src/app/page.tsx'),
      '请看这个 @src/app/page.tsx ',
    );
  });

  it('does not duplicate an existing mention', () => {
    assert.equal(
      appendPathMention('请看 @src/app/page.tsx ', 'src/app/page.tsx'),
      '请看 @src/app/page.tsx ',
    );
  });
});
