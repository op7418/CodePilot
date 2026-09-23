import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import {
  releaseNotesSanitizeSchema,
  releaseNotesUrlTransform,
} from '../../lib/release-notes-rendering';

function renderReleaseNotes(source: string): string {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeRaw, [rehypeSanitize, releaseNotesSanitizeSchema]],
    urlTransform: releaseNotesUrlTransform,
  }, source));
}

describe('release notes rich-text boundary', () => {
  it('renders GitHub Atom HTML and existing Markdown as structure', () => {
    const html = renderReleaseNotes('<h2>Changes</h2><ul><li>Fixed</li></ul>\n\n| A | B |\n| - | - |\n| 1 | 2 |');
    assert.match(html, /<h2>Changes<\/h2>/);
    assert.match(html, /<ul>\s*<li>Fixed<\/li>\s*<\/ul>/);
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /&lt;h2&gt;/);
  });

  it('strips active content, remote images, styling and dangerous URLs', () => {
    const html = renderReleaseNotes([
      '<script>alert(1)</script>',
      '<style>body{display:none}</style>',
      '<svg><a href="https://tracker.invalid">x</a></svg>',
      '<form><input value="secret"><button>go</button></form>',
      '<img src="https://tracker.invalid/pixel">',
      '<p id="clobber" class="evil" style="color:red" onclick="alert(1)">safe</p>',
      '<a href="javascript:alert(1)">bad</a>',
      '<a href="data:text/html,bad">data</a>',
      '<a href="file:///tmp/secret">file</a>',
      '<a href="https://user:pass@example.com/private">credentials</a>',
      '<a href="https://example.com/release">good</a>',
    ].join(''));

    assert.doesNotMatch(html, /script|style=|onclick|<style|<svg|<form|<input|<button|<img/i);
    assert.doesNotMatch(html, /javascript:|data:text|file:|user:pass/i);
    assert.match(html, /<p>safe<\/p>/);
    assert.match(html, /<a>bad<\/a>/);
    assert.match(html, /<a href="https:\/\/example\.com\/release">good<\/a>/);
  });

  it('only accepts absolute credential-free HTTP(S) links', () => {
    assert.equal(releaseNotesUrlTransform('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(releaseNotesUrlTransform('http://example.com'), 'http://example.com/');
    assert.equal(releaseNotesUrlTransform('/relative'), '');
    assert.equal(releaseNotesUrlTransform('mailto:test@example.com'), '');
    assert.equal(releaseNotesUrlTransform('https://u:p@example.com'), '');
  });
});
