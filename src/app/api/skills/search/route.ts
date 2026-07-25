import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/provider-resolver';
import { generateTextFromProvider } from '@/lib/text-generator';

interface SkillInfo {
  name: string;
  description: string;
}

interface SearchRequest {
  query: string;
  skills: SkillInfo[];
  model?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SearchRequest;
    const { query, skills, model } = body;

    if (!query || !skills || skills.length === 0) {
      return NextResponse.json({ suggestions: [] });
    }

    // Build skill list for prompt (truncate descriptions to 100 chars)
    const skillList = skills
      .map((s) => {
        const desc = s.description ? s.description.slice(0, 100) : '';
        return `- ${s.name}: ${desc}`;
      })
      .join('\n');

    const systemPrompt =
      'You are a skill search engine. Given a list of available skills and a user query, return the most relevant skill names that match the user\'s intent. Return ONLY a JSON array of skill names (strings), up to 5 results. No explanation, no markdown, just the JSON array.';

    const userMessage = `Available skills:\n${skillList}\n\nUser query: "${query}"\n\nReturn the matching skill names as a JSON array:`;

    // 5 second hard timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const resolved = resolveProvider({
        callScene: 'user_skill_search',
        model,
        useCase: 'small',
      });
      if (!resolved.hasCredentials) return NextResponse.json({ suggestions: [] });

      const text = await generateTextFromProvider({
        callScene: 'user_skill_search',
        providerId: resolved.provider?.id || 'env',
        model: resolved.upstreamModel || resolved.model || model || 'haiku',
        system: systemPrompt,
        prompt: userMessage,
        maxTokens: 200,
        abortSignal: controller.signal,
      });
      clearTimeout(timeout);

      // Extract JSON array from response
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        return NextResponse.json({ suggestions: [] });
      }

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) {
        return NextResponse.json({ suggestions: [] });
      }

      // Filter to only valid skill names
      const validNames = new Set(skills.map((s) => s.name));
      const suggestions = parsed
        .filter((name: unknown) => typeof name === 'string' && validNames.has(name))
        .slice(0, 5);

      return NextResponse.json({ suggestions });
    } catch {
      clearTimeout(timeout);
      return NextResponse.json({ suggestions: [] });
    }
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
