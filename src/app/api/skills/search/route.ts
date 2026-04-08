import { NextResponse } from 'next/server';
import { getActiveProvider, getSetting } from '@/lib/db';
import { CLAUDE_MODELS } from '@/lib/provider-resolver';

interface SkillInfo {
  name: string;
  description: string;
}

interface SearchRequest {
  query: string;
  skills: SkillInfo[];
  model?: string;
}

// Model alias -> full model ID (derived from central CLAUDE_MODELS)
const MODEL_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CLAUDE_MODELS).map(([alias, m]) => [alias, m.id])
);

interface ApiConfig {
  supported: boolean;
  url?: string;
  headers?: Record<string, string>;
  model?: string;
}

function resolveApiConfig(model?: string): ApiConfig {
  const provider = getActiveProvider();

  // Bedrock/Vertex don't support direct API calls
  if (provider?.provider_type === 'bedrock' || provider?.provider_type === 'vertex') {
    return { supported: false };
  }

  // Resolve API key: provider -> settings -> env
  let apiKey = provider?.api_key || '';
  if (!apiKey) {
    apiKey = getSetting('anthropic_auth_token') || '';
  }

  // Check extra_env overrides
  let extraEnv: Record<string, string> = {};
  if (provider?.extra_env) {
    try {
      extraEnv = JSON.parse(provider.extra_env);
    } catch {
      // ignore
    }
  }

  if (!apiKey && extraEnv.ANTHROPIC_API_KEY) {
    apiKey = extraEnv.ANTHROPIC_API_KEY;
  }
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY || '';
  }

  if (!apiKey) {
    return { supported: false };
  }

  // Resolve base URL
  let baseUrl = provider?.base_url || '';
  if (extraEnv.ANTHROPIC_BASE_URL) {
    baseUrl = extraEnv.ANTHROPIC_BASE_URL;
  }
  if (!baseUrl) {
    baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  }

  // Build Messages API URL
  const messagesUrl = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;

  // Resolve model
  const modelAlias = model || 'haiku';
  const modelId = MODEL_MAP[modelAlias] || MODEL_MAP.haiku;

  // Build headers: OpenRouter uses Bearer auth, others use x-api-key
  const isOpenRouter = baseUrl.includes('openrouter.ai');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (isOpenRouter) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }

  return { supported: true, url: messagesUrl, headers, model: modelId };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SearchRequest;
    const { query, skills, model } = body;

    if (!query || !skills || skills.length === 0) {
      return NextResponse.json({ suggestions: [] });
    }

    const config = resolveApiConfig(model);
    if (!config.supported || !config.url || !config.headers) {
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
      const res = await fetch(config.url, {
        method: 'POST',
        headers: config.headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          max_tokens: 200,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return NextResponse.json({ suggestions: [] });
      }

      const data = await res.json();
      const text = data.content?.[0]?.text || '';

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
