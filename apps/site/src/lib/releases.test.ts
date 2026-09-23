import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeReleases, releaseSummary } from './releases';

const release = {
  tag_name: 'v1.2.3', name: 'CodePilot 1.2.3',
  published_at: '2026-09-04T00:00:00Z',
  html_url: 'https://github.com/op7418/CodePilot/releases/tag/v1.2.3',
  body: '## Improvements\n\nA paragraph-only release.\n\n1. First change\n2. Second change',
  draft: false, prerelease: false,
};

describe('site release feed', () => {
  it('retains complete Markdown, paragraph-only releases and empty release bodies', () => {
    const result = normalizeReleases([release, { ...release, body: null }]);
    assert.equal(result.length, 2);
    assert.equal(result[0].body, release.body);
    assert.equal(result[1].body, '');
  });
  it('excludes drafts and previews before limiting stable cards', () => {
    const input = [{ ...release, prerelease: true }, { ...release, draft: true }, ...Array.from({ length: 5 }, (_, index) => ({ ...release, tag_name: `v1.2.${index}` }))];
    assert.deepEqual(normalizeReleases(input).map(item => item.tag), ['v1.2.0', 'v1.2.1', 'v1.2.2', 'v1.2.3']);
  });
  it('handles unavailable data and malformed metadata without inventing dates', () => {
    assert.deepEqual(normalizeReleases({ message: 'Rate limit exceeded' }), []);
    assert.deepEqual(normalizeReleases([null, {}, { ...release, html_url: 'javascript:alert(1)' }, { ...release, html_url: 'https://example.com/releases/1' }]), []);
    assert.equal(normalizeReleases([{ ...release, published_at: 'invalid' }])[0].date, null);
  });
  it('produces a short readable teaser without mutating the full body', () => {
    const body = '## v1.2.3\n\n> A **new** [workspace](https://example.com) with `tools`.\n\n### Fixes\n- ' + 'long change '.repeat(60);
    const summary = releaseSummary(body);
    assert.ok(summary.startsWith('A new workspace with tools.'));
    assert.equal(summary.length, 240);
    assert.doesNotMatch(summary, /##|\*\*|https:\/\/|`/);
    assert.ok(body.includes('**new**'));
  });
});

// Exercise the actual server-rendered component, including GFM and HTML safety.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReleaseMarkdown } from '../components/marketing/ReleaseMarkdown';

describe('site release Markdown', () => {
  it('keeps heading levels, nesting, tables, code blocks and safe links', () => {
    const body = '## Changes\n\n- Parent\n  - Child\n\n| Feature | Status |\n| --- | --- |\n| UI | Ready |\n\n```sh\nnpm test\n```\n\n[Source](https://github.com/op7418/CodePilot)';
    const html = renderToStaticMarkup(React.createElement(ReleaseMarkdown, { body }));
    assert.match(html, /<h2>Changes<\/h2>/);
    assert.match(html, /<li>Parent\s*<ul>/);
    assert.match(html, /<table>/);
    assert.match(html, /<pre><code class="language-sh">npm test/);
    assert.match(html, /rel="noopener noreferrer"/);
  });
  it('does not execute remote HTML, handlers, or unsafe Markdown URLs', () => {
    const body = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n**Readable**';
    const html = renderToStaticMarkup(React.createElement(ReleaseMarkdown, { body }));
    assert.doesNotMatch(html, /<script|onerror|javascript:/);
    assert.match(html, /<strong>Readable<\/strong>/);
  });
});
