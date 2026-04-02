import { NextResponse } from 'next/server';

// Cache dynamic suggestions for 10 minutes
const SUGGESTION_CACHE_KEY = '__quick_action_suggestions__';
const SUGGESTION_TTL = 10 * 60 * 1000;

interface SuggestionCache {
  suggestions: string[];
  timestamp: number;
}

function getCachedSuggestions(): string[] | null {
  const cache = (globalThis as Record<string, unknown>)[SUGGESTION_CACHE_KEY] as SuggestionCache | undefined;
  if (cache && Date.now() - cache.timestamp < SUGGESTION_TTL) {
    return cache.suggestions;
  }
  return null;
}

export async function GET() {
  try {
    const { getSetting } = await import('@/lib/db');
    const workspacePath = getSetting('assistant_workspace_path');

    if (!workspacePath) {
      return NextResponse.json({ actions: [] });
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

    // 4. Dynamic AI-generated suggestions (cached for 10 minutes)
    const cached = getCachedSuggestions();
    if (cached) {
      actions.push(...cached);
    } else {
      try {
        const { generateTextFromProvider } = await import('@/lib/text-generator');
        const { resolveProvider } = await import('@/lib/provider-resolver');
        const resolved = resolveProvider({ useCase: 'small' });

        if (resolved.hasCredentials) {
          const dailyContext = dailyMemories.map(d => d.content.slice(0, 200)).join('\n');

          const result = await generateTextFromProvider({
            providerId: resolved.provider?.id || '',
            model: resolved.upstreamModel || resolved.model || 'haiku',
            system: 'Generate 1-2 short questions (5-15 words each) that the user might want to ask their AI assistant. Based on their recent activity.',
            prompt: `Recent activity:\n${dailyContext || 'No recent activity'}\n\nSuggest 1-2 short questions. One per line, no numbering.`,
            maxTokens: 60,
          });

          const suggestions = result.split('\n').map(s => s.trim()).filter(s => s.length > 5 && s.length < 60).slice(0, 2);
          (globalThis as Record<string, unknown>)[SUGGESTION_CACHE_KEY] = { suggestions, timestamp: Date.now() } as SuggestionCache;
          actions.push(...suggestions);
        }
      } catch { /* fallback to static only */ }
    }

    // Deduplicate and limit to 5
    const unique = [...new Set(actions)].slice(0, 5);

    return NextResponse.json({ actions: unique });
  } catch (e) {
    console.error('[workspace/quick-actions] GET failed:', e);
    return NextResponse.json({ actions: [] });
  }
}
