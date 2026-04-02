/**
 * Widget design guidelines and system prompt for generative UI.
 *
 * Based on Anthropic's actual generative UI guidelines extracted from claude.ai,
 * adapted for CodePilot's code-fence trigger mechanism and CSS variable bridge.
 *
 * The WIDGET_SYSTEM_PROMPT is a minimal capability declaration (~150 tokens),
 * always injected into the system prompt. Full module guidelines are loaded
 * on demand via the `codepilot_load_widget_guidelines` in-process MCP tool.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// ── System prompt (always injected — minimal version) ───────────────────────

export const WIDGET_SYSTEM_PROMPT = `<widget-capability>
You can create interactive visualizations using the \`show-widget\` code fence.

## Format
\`\`\`show-widget
{"title":"snake_case_id","widget_code":"<raw HTML/SVG string>"}
\`\`\`

## Design specs
Call \`codepilot_load_widget_guidelines\` before your first widget to load detailed design specs.
Available modules: interactive, chart, mockup, art, diagram.

## Required rules (always apply)
1. widget_code is a JSON string — escape quotes, newlines. No DOCTYPE/html/head/body
2. Transparent background — host provides bg
3. Each widget ≤ 3000 chars. Always close JSON + fence
4. Streaming order: SVG → \`<defs>\` first; HTML → \`<style>\` → content → \`<script>\` last
5. CDN allowlist: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh
6. CDN scripts: \`onload="initFn()"\` + \`if(window.Lib) initFn();\` fallback
7. Text explanations go OUTSIDE the code fence
8. Multi-widget: interleave text, each widget in a SEPARATE fence
9. SVG: \`<svg width="100%" viewBox="0 0 680 H">\`, arrow marker in \`<defs>\`
10. Interactive controls MUST update visuals — call \`chart.update()\` after data changes
11. Clickable drill-down: \`onclick="window.__widgetSendMessage('...')"\`
12. Title should be human-readable in the user's language (e.g. "用户参与度" not "user_engagement")
13. Use \`min-height\` instead of \`height\` for the outermost container to prevent bottom clipping
14. Cross-widget filter: \`window.__widgetPublish('topic', {key:'value'})\`. Other widgets listen via \`window.addEventListener('widget-filter', e => { /* e.detail */ })\`
</widget-capability>`;

// ── Full module guidelines (injected on demand) ────────────────────────────

const CORE_DESIGN_SYSTEM = `## Core Design System

### Philosophy
- **Seamless**: widget should feel native to the chat, not a foreign embed.
- **Flat**: no gradients, shadows, blur, glow, neon. Solid fills only.
- **Warm minimal**: clean geometric layouts with soft rounded corners (rx=12). Not cold/sterile — use warm neutrals (slate tones) with indigo as primary accent.
- **Diverse**: pick the visualization type that best fits the content — flowchart, timeline, cycle, hierarchy, chart, interactive. Don't default to one type.
- **Text outside, visuals inside** — explanatory text OUTSIDE the code fence.

### Streaming
- **SVG**: \`<defs>\` first → visual elements immediately.
- **HTML**: \`<style>\` (short) → content → \`<script>\` last.
- Solid fills only — gradients/shadows flash during DOM diffs.

### Rules
- No comments, no emoji, no position:fixed, no iframes
- No font-size below 11px
- No dark/colored backgrounds on outer containers
- Typography: weights 400/500 only, sentence case
- No DOCTYPE/html/head/body
- CDN allowlist: \`cdnjs.cloudflare.com\`, \`esm.sh\`, \`cdn.jsdelivr.net\`, \`unpkg.com\`. No Tailwind CDN — utilities are built-in.

### CSS Variables (HTML widgets)
- Backgrounds: \`--color-background-primary\` (white), \`-secondary\`, \`-tertiary\`
- Text: \`--color-text-primary\`, \`-secondary\`, \`-tertiary\`
- Borders: \`--color-border-tertiary\`, \`-secondary\`, \`-primary\`
- Fonts: \`--font-sans\`, \`--font-mono\``;

const UI_COMPONENTS = `## UI components (HTML widgets)

### Tokens
- Borders: \`0.5px solid var(--color-border-tertiary)\`
- Radius: \`var(--border-radius-md)\` (8px), \`var(--border-radius-lg)\` (12px)
- Form elements pre-styled — write bare tags
- Round every displayed number

### Patterns
1. **Chart + controls** — sliders/buttons above or beside Chart.js canvas. Controls MUST update chart via \`chart.update()\`.
2. **Metric dashboard** — grid of stat cards above a chart.
3. **Calculator** — range sliders with live result display.
4. **Bar comparison** — horizontal bars with labels and percentages.
5. **Toggle/select** — buttons or select to switch between data views.`;

const COLOR_PALETTE = `## Color palette

| Ramp | 50 (fill) | 200 (stroke) | 400 (accent) | 600 (subtitle) | 800 (title) |
|------|-----------|-------------|-------------|----------------|-------------|
| Indigo | #EEF2FF | #C7D2FE | #818CF8 | #4F46E5 | #3730A3 |
| Emerald | #ECFDF5 | #A7F3D0 | #34D399 | #059669 | #065F46 |
| Amber | #FFFBEB | #FDE68A | #FBBF24 | #D97706 | #92400E |
| Slate | #F8FAFC | #E2E8F0 | #94A3B8 | #64748B | #334155 |
| Rose | #FFF1F2 | #FECDD3 | #FB7185 | #E11D48 | #9F1239 |
| Sky | #F0F9FF | #BAE6FD | #38BDF8 | #0284C7 | #075985 |

- Indigo is the primary accent. Use 2-3 ramps per diagram. Slate for structural/neutral.
- Text on fills: 800 from same ramp. Never black.
- SVG: 50 fill + 200 stroke + 800 title + 600 subtitle
- Chart.js: use 400 for borderColor, 400 with 0.1 alpha for backgroundColor`;

const CHARTS_CHART_JS = `## Charts (Chart.js)

\`\`\`html
<div style="position:relative;width:100%;height:300px"><canvas id="c"></canvas></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js" onload="init()"></script>
<script>
var chart;
function init(){
  chart=new Chart(document.getElementById('c'),{
    type:'line',
    data:{labels:['Jan','Feb','Mar','Apr','May'],datasets:[{data:[30,45,28,50,42],borderColor:'#818CF8',backgroundColor:'rgba(129,140,248,0.1)',fill:true,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{grid:{color:'rgba(0,0,0,0.06)'}},x:{grid:{display:false}}}}
  });
}
if(window.Chart)init();
</script>
\`\`\`

### Rules
- Canvas cannot use CSS variables — use hex from color ramps
- Height on wrapper div only. responsive:true, maintainAspectRatio:false
- Always disable legend
- borderRadius:6 for bars, tension:0.3 for smooth lines
- Interactive controls MUST call chart.update() after modifying data
- Multiple charts: unique canvas IDs

### Interactive chart pattern
Add controls that modify \`chart.data.datasets[N].data\` and call \`chart.update()\`:
\`\`\`js
function update(){
  var v=+document.getElementById('slider').value;
  chart.data.datasets[0].data = baseData.map(function(d){ return Math.round(d * v / 50) });
  chart.update();
}
\`\`\``;

const SVG_SETUP = `## SVG setup

\`<svg width="100%" viewBox="0 0 680 H">\` — 680px fixed width. Adjust H to fit content + 40px buffer.

**ViewBox checklist**:
1. max(y + height) of lowest element + 40 = H
2. All content within x=0..680
3. text-anchor="end" extends LEFT from x
4. No negative coordinates

**Arrow marker** (required):
\`<defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>\`

**Style**: inline font styles with system-ui fallback. 13-14px labels, 11-12px subtitles. Stroke 0.5-1px borders, 1.5px arrows. rx=8-12 for nodes. One SVG per widget.`;

const DIAGRAM_TYPES = `## Diagram type catalog

### Flowchart (process)
Nodes left→right or top→bottom. Straight arrows. Color = semantic category.
- Decision points: diamond shape or bold-bordered node
- ≤4 nodes per row

### Timeline
Horizontal axis line with event markers. Stagger labels above/below to avoid overlap.
\`<line x1="40" y1="100" x2="640" y2="100" stroke="#D3D1C7" stroke-width="2"/>\`
\`<circle cx="120" cy="100" r="6" fill="#818CF8"/>\`
\`<text x="120" y="85" text-anchor="middle" ...>Event A</text>\`

### Cycle / feedback loop
3-5 nodes in circular arrangement connected by curved arrows.
\`<path d="M x1 y1 Q cx cy x2 y2" fill="none" stroke="#94A3B8" stroke-width="1.5" marker-end="url(#a)"/>\`
Center label for the cycle name.

### Hierarchy / tree
Root at top, children below with vertical arrows. Indent levels. Group siblings with container rects.

### Layered stack (architecture)
Full-width horizontal bands stacked vertically. Each band = rounded rect. Items positioned inside.
Top layer = user-facing, bottom = infrastructure. Use different colors per layer.

### Quadrant / matrix (2x2)
Two axes with labels. Four colored quadrant rects. Items plotted as circles or labels within quadrants.
\`<line x1="340" y1="20" x2="340" y2="340" stroke="#D3D1C7" stroke-width="1"/>\`
\`<line x1="20" y1="180" x2="660" y2="180" stroke="#D3D1C7" stroke-width="1"/>\`

### Hub-spoke / radial
Central circle node, surrounding nodes connected by lines. Hub = larger circle, spokes = smaller rects/circles.

### Side-by-side comparison
Two parallel groups. Matching rows. Different fill colors per group. Optional connecting lines for correspondences.

### Design rules
- ≤4 nodes per row, ≤5 words per title
- Node width ≥ (chars × 8 + 40) px
- Verify no arrow crosses unrelated boxes
- 2-3 color ramps max, gray for structural
- Clickable nodes: \`onclick="window.__widgetSendMessage('...')"\` on 2-3 key nodes

### Multi-widget narratives
For complex topics, output multiple widgets of DIFFERENT types:
1. Overview SVG (e.g. hierarchy)
2. Text explaining one part
3. Detail SVG (e.g. cycle diagram for that part)
4. Text with quantitative insight
5. Interactive Chart.js with controls
Mix types freely.`;

// ── Module registry ────────────────────────────────────────────────────────

const MODULE_SECTIONS: Record<string, string[]> = {
  interactive: [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE],
  chart:       [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE, CHARTS_CHART_JS],
  mockup:      [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE],
  art:         [CORE_DESIGN_SYSTEM, SVG_SETUP, COLOR_PALETTE],
  diagram:     [CORE_DESIGN_SYSTEM, COLOR_PALETTE, SVG_SETUP, DIAGRAM_TYPES],
};

export const AVAILABLE_MODULES = Object.keys(MODULE_SECTIONS);

/**
 * Assemble full guidelines from requested module names.
 * Deduplicates shared sections (e.g. Core appears once even if multiple modules requested).
 */
export function getGuidelines(moduleNames: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const mod of moduleNames) {
    const key = mod.toLowerCase().trim();
    const sections = MODULE_SECTIONS[key];
    if (!sections) continue;
    for (const section of sections) {
      if (!seen.has(section)) {
        seen.add(section);
        parts.push(section);
      }
    }
  }
  return parts.join('\n\n\n');
}

// ── In-process MCP server for on-demand guideline loading ───────────────────

/**
 * Creates an in-process MCP server that exposes `codepilot_load_widget_guidelines`.
 * The model calls this tool before generating its first widget to load detailed
 * design specs for the requested module(s), saving ~75% system prompt tokens
 * on conversations that don't involve widgets.
 */
export function createWidgetMcpServer() {
  return createSdkMcpServer({
    name: 'codepilot-widget-guidelines',
    version: '1.0.0',
    tools: [
      tool(
        'codepilot_load_widget_guidelines',
        'Load detailed design guidelines for generating visual widgets. Call this before generating your first widget. Available modules: interactive (HTML controls), chart (Chart.js), mockup (UI mockups), art (SVG illustrations), diagram (flowcharts/timelines/hierarchies).',
        { modules: z.array(z.enum(['interactive', 'chart', 'mockup', 'art', 'diagram'])) },
        async ({ modules }) => ({
          content: [{ type: 'text' as const, text: getGuidelines(modules) }],
        }),
      ),
    ],
  });
}
