import { NextResponse } from 'next/server';

import { quickActionSuggestions } from '@/lib/quick-action-suggestions';
import { captureAuxiliaryRoute, resolveAuxiliaryProvider, runAuxiliaryText } from '@/lib/auxiliary-provider';

async function respond(retry: boolean) {
  try {
    const { getSetting } = await import('@/lib/db');
    const workspacePath = getSetting('assistant_workspace_path');

    if (!workspacePath) {
      return NextResponse.json({ actions: [], enhancement: { status: 'unavailable', reason: 'workspace_unavailable' } }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const fs = await import('fs');
    const path = await import('path');
    const { loadDailyMemories } = await import('@/lib/assistant-workspace');

    const actions: string[] = [];

    // Hoist dailyMemories so it can be used by both static extraction and dynamic suggestions
    let dailyMemories: { content: string }[] = [];

    // 1. Extract unchecked TODOs from recent daily memories
    try {
      dailyMemories = loadDailyMemories(workspacePath, 3);
      for (const daily of dailyMemories) {
        const todos = daily.content.match(/- \[ \] (.+)/g);
        if (todos) {
          for (const todo of todos.slice(0, 2)) {
            const item = todo.replace('- [ ] ', '').trim();
            if (item.length > 5 && item.length < 60) {
              actions.push(item);
            }
          }
        }
      }
    } catch { /* skip */ }

    // 2. Extract goals from user.md
    try {
      const userVariants = ['user.md', 'User.md', 'USER.md'];
      for (const variant of userVariants) {
        const userPath = path.join(workspacePath, variant);
        if (fs.existsSync(userPath)) {
          const content = fs.readFileSync(userPath, 'utf-8');
          const goalMatch = content.match(/## (?:Current Goals|当前目标)\n([\s\S]*?)(?=\n##|$)/);
          if (goalMatch) {
            const firstGoal = goalMatch[1].trim().split('\n')[0]?.replace(/^[-*] /, '').trim();
            if (firstGoal && firstGoal.length > 3 && firstGoal.length < 60) {
              actions.push(firstGoal);
            }
          }
          break;
        }
      }
    } catch { /* skip */ }

    // 3. Add a locale-agnostic "review this week" action
    // Frontend resolves the display text via i18n key 'assistant.quickActions.reviewWeek'
    actions.push('__review_week__');

    // Bind both transport and cache to one configuration snapshot. The opaque
    // identity is private server state and never enters this response.
    const resolvedProvider = resolveAuxiliaryProvider({});
    const route = resolvedProvider ? captureAuxiliaryRoute('', resolvedProvider) : undefined;
    const generation = await quickActionSuggestions.get(workspacePath, route?.fingerprint, async () => {
      if (!resolvedProvider) return { suggestions: [], enhancement: { status: 'unavailable', reason: 'provider_missing' } };
      const dailyContext = dailyMemories.map(d => d.content.slice(0, 200)).join('\n');
      const result = await runAuxiliaryText({
        callScene: 'automatic_quick_actions',
        scopeKey: workspacePath,
        resolvedProvider,
        resolvedConfig: route?.resolvedConfig,
        system: 'Generate 1-2 short questions (5-15 words each) that the user might want to ask their AI assistant. Based on their recent activity.',
        prompt: `Recent activity:\n${dailyContext || 'No recent activity'}\n\nSuggest 1-2 short questions. One per line, no numbering.`,
        maxTokens: 60,
      });
      if (result.status !== 'completed') return { suggestions: [], enhancement: result };
      const suggestions = result.text.split('\n').map(s => s.trim()).filter(s => s.length > 5 && s.length < 60).slice(0, 2);
      return suggestions.length ? { suggestions, enhancement: { status: 'completed' } }
        : { suggestions: [], enhancement: { status: 'failed', reason: 'empty_response', retryAt: Date.now() + 60_000 } };
    }, retry);
    // Ignore a stale completion after a provider change during the request.
    const currentProvider = resolveAuxiliaryProvider({});
    const currentRoute = currentProvider ? captureAuxiliaryRoute('', currentProvider) : undefined;
    const stale = !!route?.fingerprint && currentRoute?.fingerprint !== route.fingerprint;
    if (!stale) actions.push(...generation.suggestions);

    // Deduplicate and limit to 5
    const unique = [...new Set(actions)].slice(0, 5);

    return NextResponse.json({ actions: unique, retryRequested: retry,
      enhancement: stale ? { status: 'unavailable', reason: 'configuration_changed' } : generation.enhancement },
    { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ actions: ['__review_week__'], retryRequested: retry,
      enhancement: { status: 'failed', reason: 'request_failed' } },
    { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** Initial load may generate suggestions using the configured background provider. */
export async function GET() { return respond(false); }

/** Explicit retry; respects the provider runner's cooldown and configuration blocks. */
export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const target = new URL(`${url.protocol}//${request.headers.get('host') || url.host}`);
    const site = request.headers.get('sec-fetch-site');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
        || request.headers.get('origin') !== target.origin
        || (site && site !== 'same-origin' && site !== 'none')
        || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const body = await request.json();
    if (!body || body.action !== 'retry' || Object.keys(body).length !== 1) {
      return NextResponse.json({ error: 'invalid' }, { status: 400 });
    }
    return respond(true);
  } catch { return NextResponse.json({ error: 'invalid' }, { status: 400 }); }
}
