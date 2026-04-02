/**
 * Unit tests for generative UI widget system.
 *
 * Covers:
 * 1. HTML sanitization (streaming vs finalize modes)
 * 2. Show-widget fence parsing (single, multi-widget, truncated, empty)
 * 3. Receiver iframe srcdoc structure and CSP
 * 4. CSS variable bridge completeness
 * 5. Streaming script truncation logic
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeForStreaming,
  sanitizeForIframe,
  buildReceiverSrcdoc,
  CDN_WHITELIST,
} from '../../lib/widget-sanitizer';

import {
  parseAllShowWidgets,
  parseShowWidget,
  computePartialWidgetKey,
} from '../../components/chat/MessageItem';

import { WIDGET_CSS_BRIDGE } from '../../lib/widget-css-bridge';
import { WIDGET_SYSTEM_PROMPT, getGuidelines, createWidgetMcpServer } from '../../lib/widget-guidelines';

// ── Sanitization ────────────────────────────────────────────────────────

describe('sanitizeForStreaming', () => {
  it('strips script tags', () => {
    const html = '<div>Hello</div><script>alert(1)</script><p>World</p>';
    const result = sanitizeForStreaming(html);
    assert.ok(!result.includes('<script'), 'should strip <script>');
    assert.ok(result.includes('<div>Hello</div>'));
    assert.ok(result.includes('<p>World</p>'));
  });

  it('strips self-closing script tags', () => {
    const result = sanitizeForStreaming('<div>ok</div><script src="evil.js"/>');
    assert.ok(!result.includes('<script'), 'should strip self-closing script');
  });

  it('strips on* event handlers', () => {
    const html = '<div onclick="alert(1)" onmouseover="hack()">Click</div>';
    const result = sanitizeForStreaming(html);
    assert.ok(!result.includes('onclick'), 'should strip onclick');
    assert.ok(!result.includes('onmouseover'), 'should strip onmouseover');
    assert.ok(result.includes('>Click</div>'));
  });

  it('strips dangerous embedding tags (iframe, object, embed, form)', () => {
    const html = '<iframe src="evil"></iframe><object data="x"></object><embed src="y"/><form action="z"></form>';
    const result = sanitizeForStreaming(html);
    assert.ok(!result.includes('<iframe'), 'should strip iframe');
    assert.ok(!result.includes('<object'), 'should strip object');
    assert.ok(!result.includes('<embed'), 'should strip embed');
    assert.ok(!result.includes('<form'), 'should strip form');
  });

  it('strips javascript: and data: URLs in href/src/action', () => {
    const html = '<a href="javascript:alert(1)">link</a><img src="data:text/html,<script>alert(1)</script>">';
    const result = sanitizeForStreaming(html);
    assert.ok(!result.includes('javascript:'), 'should strip javascript: URL');
    assert.ok(!result.includes('data:text'), 'should strip data: URL');
  });

  it('preserves safe HTML and styles', () => {
    const html = '<style>.box { color: red; }</style><div class="box"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg></div>';
    const result = sanitizeForStreaming(html);
    assert.ok(result.includes('<style>'));
    assert.ok(result.includes('<svg'));
    assert.ok(result.includes('<circle'));
  });
});

describe('sanitizeForIframe', () => {
  it('strips dangerous embedding tags but keeps scripts and handlers', () => {
    const html = '<div onclick="go()">Hi</div><script>run()</script><iframe src="x"></iframe>';
    const result = sanitizeForIframe(html);
    assert.ok(!result.includes('<iframe'), 'should strip iframe');
    assert.ok(result.includes('<script>run()</script>'), 'should keep scripts');
    assert.ok(result.includes('onclick'), 'should keep handlers');
  });

  it('is less restrictive than sanitizeForStreaming', () => {
    const html = '<div onclick="test()">X</div><script>alert(1)</script>';
    const streaming = sanitizeForStreaming(html);
    const iframe = sanitizeForIframe(html);
    // iframe version keeps more content
    assert.ok(iframe.includes('<script>'), 'iframe should keep scripts');
    assert.ok(!streaming.includes('<script>'), 'streaming should strip scripts');
  });
});

// ── Fence Parsing ────────────────────────────────────────────────────────

describe('parseAllShowWidgets', () => {
  it('returns empty array for plain text (no fences)', () => {
    const result = parseAllShowWidgets('Just some regular text without widgets');
    assert.deepStrictEqual(result, []);
  });

  it('parses a single widget fence', () => {
    const input = 'Here is a chart:\n```show-widget\n{"title":"my_chart","widget_code":"<div>Chart</div>"}\n```\nDone.';
    const segments = parseAllShowWidgets(input);

    assert.strictEqual(segments.length, 3);
    assert.strictEqual(segments[0].type, 'text');
    assert.strictEqual((segments[0] as { type: 'text'; content: string }).content, 'Here is a chart:');
    assert.strictEqual(segments[1].type, 'widget');
    assert.strictEqual((segments[1] as { type: 'widget'; data: { title?: string; widget_code: string } }).data.title, 'my_chart');
    assert.strictEqual((segments[1] as { type: 'widget'; data: { title?: string; widget_code: string } }).data.widget_code, '<div>Chart</div>');
    assert.strictEqual(segments[2].type, 'text');
    assert.strictEqual((segments[2] as { type: 'text'; content: string }).content, 'Done.');
  });

  it('parses multiple widget fences interleaved with text', () => {
    const input = [
      'First explanation.',
      '```show-widget',
      '{"title":"chart_1","widget_code":"<div>1</div>"}',
      '```',
      'Middle text.',
      '```show-widget',
      '{"title":"chart_2","widget_code":"<div>2</div>"}',
      '```',
      'End.',
    ].join('\n');
    const segments = parseAllShowWidgets(input);

    // text, widget, text, widget, text = 5 segments
    assert.strictEqual(segments.length, 5);
    assert.strictEqual(segments[0].type, 'text');
    assert.strictEqual(segments[1].type, 'widget');
    assert.strictEqual(segments[2].type, 'text');
    assert.strictEqual(segments[3].type, 'widget');
    assert.strictEqual(segments[4].type, 'text');

    const w1 = segments[1] as { type: 'widget'; data: { title?: string; widget_code: string } };
    const w2 = segments[3] as { type: 'widget'; data: { title?: string; widget_code: string } };
    assert.strictEqual(w1.data.title, 'chart_1');
    assert.strictEqual(w2.data.title, 'chart_2');
  });

  it('handles truncated fence (streaming — no closing ```)', () => {
    const input = 'Some intro\n```show-widget\n{"title":"partial","widget_code":"<div>loading...</div>"}';
    const segments = parseAllShowWidgets(input);

    assert.ok(segments.length >= 1, 'should produce segments from truncated fence');
    const widgets = segments.filter(s => s.type === 'widget');
    assert.strictEqual(widgets.length, 1);
    assert.strictEqual(
      (widgets[0] as { type: 'widget'; data: { title?: string; widget_code: string } }).data.widget_code,
      '<div>loading...</div>',
    );
  });

  it('handles truncated fence with partial JSON (widget_code started but not closed)', () => {
    const input = '```show-widget\n{"title":"test","widget_code":"<div>partial';
    const segments = parseAllShowWidgets(input);

    // Should attempt extraction — may or may not succeed depending on minimum length
    // At least should not throw
    assert.ok(Array.isArray(segments));
  });

  it('skips malformed JSON inside fence', () => {
    const input = '```show-widget\nNOT_JSON\n```\nAfter.';
    const segments = parseAllShowWidgets(input);
    // Malformed widget skipped, but trailing text preserved
    const textSegs = segments.filter(s => s.type === 'text');
    assert.ok(textSegs.length > 0, 'should have text segment after malformed fence');
  });

  it('handles widget with no title', () => {
    const input = '```show-widget\n{"widget_code":"<svg></svg>"}\n```';
    const segments = parseAllShowWidgets(input);
    const widgets = segments.filter(s => s.type === 'widget');
    assert.strictEqual(widgets.length, 1);
    const w = widgets[0] as { type: 'widget'; data: { title?: string; widget_code: string } };
    assert.strictEqual(w.data.title, undefined);
    assert.strictEqual(w.data.widget_code, '<svg></svg>');
  });
});

describe('parseShowWidget (legacy single-widget compat)', () => {
  it('returns null for plain text', () => {
    assert.strictEqual(parseShowWidget('no widgets here'), null);
  });

  it('returns first widget with beforeText and afterText', () => {
    const input = 'Before\n```show-widget\n{"title":"w1","widget_code":"<div>1</div>"}\n```\nAfter';
    const result = parseShowWidget(input);
    assert.ok(result !== null);
    assert.strictEqual(result!.beforeText, 'Before');
    assert.strictEqual(result!.widget.title, 'w1');
    assert.ok(result!.afterText.includes('After'));
  });
});

// ── Receiver iframe srcdoc ──────────────────────────────────────────────

describe('buildReceiverSrcdoc', () => {
  const srcdoc = buildReceiverSrcdoc(':root { --bg: #fff; }', false);
  const darkSrcdoc = buildReceiverSrcdoc(':root { --bg: #000; }', true);

  it('includes CSP meta tag with CDN whitelist', () => {
    assert.ok(srcdoc.includes('Content-Security-Policy'), 'should have CSP meta');
    for (const cdn of CDN_WHITELIST) {
      assert.ok(srcdoc.includes(cdn), `should include CDN: ${cdn}`);
    }
  });

  it('blocks network access via connect-src none', () => {
    assert.ok(srcdoc.includes("connect-src 'none'"), 'should block network');
  });

  it('includes __root container', () => {
    assert.ok(srcdoc.includes('id="__root"'), 'should have root div');
  });

  it('includes receiver script with message handlers', () => {
    assert.ok(srcdoc.includes('widget:update'), 'should handle update messages');
    assert.ok(srcdoc.includes('widget:finalize'), 'should handle finalize messages');
    assert.ok(srcdoc.includes('widget:theme'), 'should handle theme messages');
    assert.ok(srcdoc.includes('widget:ready'), 'should emit ready signal');
    assert.ok(srcdoc.includes('widget:resize'), 'should emit resize signals');
    assert.ok(srcdoc.includes('widget:link'), 'should intercept link clicks');
    assert.ok(srcdoc.includes('widget:sendMessage'), 'should support sendMessage');
  });

  it('includes ResizeObserver for height sync', () => {
    assert.ok(srcdoc.includes('ResizeObserver'), 'should use ResizeObserver');
  });

  it('applies dark class when isDark=true', () => {
    assert.ok(darkSrcdoc.includes('class="dark"'), 'should have dark class');
    assert.ok(!srcdoc.includes('class="dark"'), 'light mode should not have dark class');
  });

  it('injects provided style block', () => {
    assert.ok(srcdoc.includes('--bg: #fff'), 'should include custom style');
  });

  it('uses finalizeHtml to separate scripts from visual content', () => {
    // finalizeHtml should avoid repaint flash by comparing innerHTML
    assert.ok(srcdoc.includes('finalizeHtml'), 'should define finalizeHtml');
    assert.ok(srcdoc.includes('root.innerHTML!==visualHtml'), 'should diff before replace');
  });
});

// ── CDN finalize script execution ────────────────────────────────────────

describe('finalizeHtml CDN script handling', () => {
  const srcdoc = buildReceiverSrcdoc(':root{}', false);

  it('separates CDN and inline scripts in finalize', () => {
    // The receiver script must filter scripts into cdn (has src) vs inline (has text)
    assert.ok(srcdoc.includes('cdnScripts=scripts.filter'), 'should separate CDN scripts');
    assert.ok(srcdoc.includes('inlineScripts=scripts.filter'), 'should separate inline scripts');
  });

  it('waits for all CDN scripts before executing inline', () => {
    // When CDN scripts exist, inline must only run after all CDN onload/onerror fire
    assert.ok(srcdoc.includes('_pending=cdnScripts.length'), 'should track pending CDN count');
    assert.ok(srcdoc.includes('_pending--'), 'should decrement on each CDN completion');
    assert.ok(srcdoc.includes('_pending<=0'), 'should run inline only when all CDN done');
  });

  it('runs inline immediately when no CDN scripts', () => {
    assert.ok(srcdoc.includes('cdnScripts.length===0'), 'should check for zero CDN scripts');
    // _appendInline is called directly in the no-CDN branch
    assert.ok(srcdoc.includes('_appendInline()'), 'should call _appendInline');
  });

  it('does NOT re-inject inline scripts on CDN load (no duplicate execution)', () => {
    // _appendInline should only be called once — no _runInline on every onload
    // The function is named _appendInline (not _runInline) and called via _onCdnDone counter
    assert.ok(srcdoc.includes('function _onCdnDone'), 'should use counter-based callback');
    assert.ok(srcdoc.includes('n.onload=_onCdnDone'), 'onload should use counter, not direct _appendInline');
    assert.ok(srcdoc.includes('n.onerror=_onCdnDone'), 'onerror should use counter, not direct _appendInline');
  });

  it('does NOT have a timeout fallback that could race with CDN load', () => {
    // Previous bugs: setTimeout(3000) set _inlineRan=true before CDN arrived
    // The finalizeHtml script section should not use setTimeout for inline execution
    assert.ok(!srcdoc.includes('setTimeout(function(){_appendInline'), 'should not have timeout calling _appendInline');
    assert.ok(!srcdoc.includes('setTimeout(function(){_runInline'), 'should not have timeout calling _runInline');
  });

  it('does NOT have a once-flag that could lock out late CDN arrivals', () => {
    // Previous bug: _inlineRan flag prevented init after slow CDN load
    assert.ok(!srcdoc.includes('_inlineRan'), 'should not have _inlineRan flag');
  });

  it('strips model-provided onload to avoid double init', () => {
    // CDN scripts with model-provided onload="init()" should have it stripped
    // since our _onCdnDone callback handles execution timing
    assert.ok(srcdoc.includes("!=='onload'"), 'should skip onload attribute when setting attrs');
  });

  it('emits widget:scriptsReady after inline scripts execute', () => {
    // Export relies on this signal to know when Chart.js etc. have finished drawing
    assert.ok(srcdoc.includes("widget:scriptsReady"), 'should emit scriptsReady after _appendInline');
  });

  it('handles widget:capture message for PNG export', () => {
    assert.ok(srcdoc.includes("widget:capture"), 'should handle capture message');
    assert.ok(srcdoc.includes("widget:captured"), 'should respond with captured dataUrl');
    // Must convert live canvas to img before serialization
    assert.ok(srcdoc.includes("toDataURL"), 'should convert canvas elements to images');
  });
});

// ── CDN whitelist ───────────────────────────────────────────────────────

describe('CDN_WHITELIST', () => {
  it('contains exactly 4 trusted CDNs', () => {
    assert.strictEqual(CDN_WHITELIST.length, 4);
    assert.ok(CDN_WHITELIST.includes('cdnjs.cloudflare.com'));
    assert.ok(CDN_WHITELIST.includes('cdn.jsdelivr.net'));
    assert.ok(CDN_WHITELIST.includes('unpkg.com'));
    assert.ok(CDN_WHITELIST.includes('esm.sh'));
  });
});

// ── CSS variable bridge ─────────────────────────────────────────────────

describe('WIDGET_CSS_BRIDGE', () => {
  it('maps background variables', () => {
    assert.ok(WIDGET_CSS_BRIDGE.includes('--color-background-primary'));
    assert.ok(WIDGET_CSS_BRIDGE.includes('var(--background)'));
  });

  it('maps text variables', () => {
    assert.ok(WIDGET_CSS_BRIDGE.includes('--color-text-primary'));
    assert.ok(WIDGET_CSS_BRIDGE.includes('var(--foreground)'));
  });

  it('maps border variables', () => {
    assert.ok(WIDGET_CSS_BRIDGE.includes('--color-border-primary'));
    assert.ok(WIDGET_CSS_BRIDGE.includes('var(--border)'));
  });

  it('maps chart palette (chart-1 through chart-5)', () => {
    for (let i = 1; i <= 5; i++) {
      assert.ok(WIDGET_CSS_BRIDGE.includes(`--color-chart-${i}`), `should map chart-${i}`);
      assert.ok(WIDGET_CSS_BRIDGE.includes(`var(--chart-${i})`), `should reference var(--chart-${i})`);
    }
  });

  it('maps typography variables', () => {
    assert.ok(WIDGET_CSS_BRIDGE.includes('--font-sans'));
    assert.ok(WIDGET_CSS_BRIDGE.includes('--font-mono'));
  });
});

// ── System prompt ───────────────────────────────────────────────────────

describe('WIDGET_SYSTEM_PROMPT', () => {
  it('includes show-widget fence format', () => {
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('show-widget'));
  });

  it('includes widget_code field in format example', () => {
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('widget_code'));
  });

  it('references the codepilot_load_widget_guidelines tool', () => {
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('codepilot_load_widget_guidelines'));
  });

  it('is smaller than the original full prompt but includes core rules', () => {
    assert.ok(WIDGET_SYSTEM_PROMPT.length > 500, 'should include core hard constraints');
    assert.ok(WIDGET_SYSTEM_PROMPT.length < 2000, 'should be smaller than original ~2500 char full prompt');
  });

  it('includes critical hard constraints for valid widget output', () => {
    // JSON escaping rule
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('JSON string'), 'must mention JSON string escaping');
    // Streaming order
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('<defs>'), 'must mention SVG defs-first order');
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('<script>'), 'must mention script-last order');
    // Size limit
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('3000'), 'must mention size limit');
    // CDN script loading pattern
    assert.ok(WIDGET_SYSTEM_PROMPT.includes('onload'), 'must mention CDN script load pattern');
  });
});

// ── Widget MCP server ───────────────────────────────────────────────────

describe('createWidgetMcpServer', () => {
  it('returns a valid SDK MCP server config', () => {
    const server = createWidgetMcpServer();
    assert.strictEqual(server.type, 'sdk');
    assert.strictEqual(server.name, 'codepilot-widget-guidelines');
    assert.ok(server.instance, 'should have an McpServer instance');
  });
});

// ── getGuidelines ───────────────────────────────────────────────────────

describe('getGuidelines', () => {
  it('returns diagram guidelines with SVG setup and diagram types', () => {
    const result = getGuidelines(['diagram']);
    assert.ok(result.includes('SVG setup'), 'should include SVG setup section');
    assert.ok(result.includes('Diagram type catalog'), 'should include diagram types');
    assert.ok(result.includes('Flowchart'), 'should include flowchart type');
    assert.ok(result.includes('Timeline'), 'should include timeline type');
  });

  it('returns chart guidelines with Chart.js section', () => {
    const result = getGuidelines(['chart']);
    assert.ok(result.includes('Chart.js'), 'should include Chart.js section');
    assert.ok(result.includes('chart.update()'), 'should include update pattern');
  });

  it('deduplicates shared sections across multiple modules', () => {
    const combined = getGuidelines(['interactive', 'chart']);
    const coreCount = (combined.match(/Core Design System/g) || []).length;
    assert.strictEqual(coreCount, 1, 'Core Design System should appear exactly once');
  });

  it('ignores unknown module names gracefully', () => {
    const result = getGuidelines(['unknown', 'diagram']);
    assert.ok(result.includes('SVG setup'), 'should still include valid module content');
  });
});

// ── Key stability: partial→complete must not remount ────────────────────
//
// Regression guard for P2 (iframe remount on fence close).
// StreamingMessage.tsx computes a React key for the partial widget during
// streaming. When the fence closes, parseAllShowWidgets produces segments
// whose map-index key (`w-${i}`) must match the partial key exactly.
// If they differ, React unmounts + remounts the WidgetRenderer → iframe
// is destroyed → height collapses → scroll jump.
//
// This tests the actual key-computation invariant extracted from
// StreamingMessage.tsx lines 284-337 and 268-279.

describe('widget key stability (partial → complete transition)', () => {
  // Uses the PRODUCTION computePartialWidgetKey from MessageItem.tsx —
  // the same function that StreamingMessage.tsx calls. Any drift in the
  // production code will be caught here.

  function computeClosedWidgetKey(content: string, widgetIndex: number): string {
    const allSegments = parseAllShowWidgets(content);
    // Find the Nth widget (0-indexed) and return its map-index key
    let widgetCount = 0;
    for (let i = 0; i < allSegments.length; i++) {
      if (allSegments[i].type === 'widget') {
        if (widgetCount === widgetIndex) return `w-${i}`;
        widgetCount++;
      }
    }
    throw new Error(`Widget index ${widgetIndex} not found in ${allSegments.length} segments`);
  }

  it('single widget: key matches after fence closes', () => {
    const widgetJson = '{"title":"chart","widget_code":"<div>Chart</div>"}';

    // Streaming: fence is open (no closing ```)
    const openContent = `Here is a chart:\n\`\`\`show-widget\n${widgetJson}`;
    const partialKey = computePartialWidgetKey(openContent);

    // Complete: fence is closed
    const closedContent = `Here is a chart:\n\`\`\`show-widget\n${widgetJson}\n\`\`\``;
    const closedKey = computeClosedWidgetKey(closedContent, 0);

    assert.strictEqual(partialKey, closedKey,
      `partial key "${partialKey}" must equal closed key "${closedKey}" to prevent remount`);
  });

  it('single widget with no preceding text: key matches', () => {
    const widgetJson = '{"title":"solo","widget_code":"<svg></svg>"}';

    const openContent = `\`\`\`show-widget\n${widgetJson}`;
    const partialKey = computePartialWidgetKey(openContent);

    const closedContent = `\`\`\`show-widget\n${widgetJson}\n\`\`\``;
    const closedKey = computeClosedWidgetKey(closedContent, 0);

    assert.strictEqual(partialKey, closedKey,
      `partial key "${partialKey}" must equal closed key "${closedKey}" to prevent remount`);
  });

  it('second widget after a completed first widget: key matches', () => {
    const w1Json = '{"title":"w1","widget_code":"<div>1</div>"}';
    const w2Json = '{"title":"w2","widget_code":"<div>2</div>"}';

    // Streaming: first widget complete, second widget open
    const openContent = [
      'Intro text.',
      '```show-widget',
      w1Json,
      '```',
      'Middle text.',
      '```show-widget',
      w2Json,
    ].join('\n');
    const partialKey = computePartialWidgetKey(openContent);

    // Complete: both fences closed
    const closedContent = openContent + '\n```';
    const closedKey = computeClosedWidgetKey(closedContent, 1); // second widget

    assert.strictEqual(partialKey, closedKey,
      `partial key "${partialKey}" must equal closed key "${closedKey}" to prevent remount`);
  });

  it('third widget after two completed widgets: key matches', () => {
    const wJson = (n: number) => `{"title":"w${n}","widget_code":"<div>${n}</div>"}`;

    const openContent = [
      'A', '```show-widget', wJson(1), '```',
      'B', '```show-widget', wJson(2), '```',
      'C', '```show-widget', wJson(3),
    ].join('\n');
    const partialKey = computePartialWidgetKey(openContent);

    const closedContent = openContent + '\n```';
    const closedKey = computeClosedWidgetKey(closedContent, 2); // third widget

    assert.strictEqual(partialKey, closedKey,
      `partial key "${partialKey}" must equal closed key "${closedKey}" to prevent remount`);
  });

  it('widget key is an actual map-index key (w-N format)', () => {
    const openContent = 'Text\n```show-widget\n{"title":"x","widget_code":"<div>x</div>"}';
    const key = computePartialWidgetKey(openContent);
    assert.match(key, /^w-\d+$/, 'key must be w-N format');
  });
});

// ── Streaming script truncation logic ───────────────────────────────────

describe('streaming script truncation', () => {
  // Reproduces the logic from StreamingMessage.tsx that truncates unclosed
  // <script> tags during streaming to prevent JS code from showing as text.

  function truncateUnclosedScripts(code: string): { result: string | null; truncated: boolean } {
    let partialCode: string | null = code;
    let scriptsTruncated = false;
    if (partialCode) {
      const lastScript = partialCode.lastIndexOf('<script');
      if (lastScript !== -1) {
        const afterScript = partialCode.slice(lastScript);
        if (!/<script[\s\S]*?<\/script>/i.test(afterScript)) {
          partialCode = partialCode.slice(0, lastScript).trim() || null;
          scriptsTruncated = true;
        }
      }
    }
    return { result: partialCode, truncated: scriptsTruncated };
  }

  it('does nothing when no script tags present', () => {
    const { result, truncated } = truncateUnclosedScripts('<div>Hello</div>');
    assert.strictEqual(result, '<div>Hello</div>');
    assert.strictEqual(truncated, false);
  });

  it('does nothing when all script tags are closed', () => {
    const { result, truncated } = truncateUnclosedScripts('<div>Hi</div><script>alert(1)</script>');
    assert.strictEqual(truncated, false);
    assert.ok(result!.includes('<script>'));
  });

  it('truncates unclosed script tag', () => {
    const { result, truncated } = truncateUnclosedScripts(
      '<style>.box{color:red}</style><div>Chart</div><script>const data = [1,2,3',
    );
    assert.strictEqual(truncated, true);
    assert.ok(!result!.includes('<script'), 'should remove unclosed script');
    assert.ok(result!.includes('<div>Chart</div>'), 'should keep visual HTML');
    assert.ok(result!.includes('<style>'), 'should keep style');
  });

  it('truncates when only script tag with no content yet', () => {
    const { result, truncated } = truncateUnclosedScripts('<div>X</div><script');
    assert.strictEqual(truncated, true);
    assert.strictEqual(result, '<div>X</div>');
  });

  it('returns null when entire content is an unclosed script', () => {
    const { result, truncated } = truncateUnclosedScripts('<script src="https://cdn.jsdelivr.net/npm/chart.js"');
    assert.strictEqual(truncated, true);
    assert.strictEqual(result, null);
  });

  it('keeps closed scripts but truncates the last unclosed one', () => {
    const code = '<script>var a=1;</script><div>Hi</div><script>var b=';
    const { result, truncated } = truncateUnclosedScripts(code);
    assert.strictEqual(truncated, true);
    assert.ok(result!.includes('<script>var a=1;</script>'), 'should keep closed script');
    assert.ok(result!.includes('<div>Hi</div>'), 'should keep div');
  });
});
