/**
 * AI Commit Message Generator API
 * POST: Generate commit message from staged changes using AI
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';
import { getActiveProvider, getSetting } from '@/lib/db';

const COMMIT_MESSAGE_SYSTEM = `You are an expert at writing Git commit messages.
Generate a commit message based on the diff with:

## Subject Line (第一行)
- Format: type: description (e.g., feat: add user authentication)
- Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert
- Keep under 72 characters
- Use imperative mood

## Body (描述部分，空一行后)
Write 3-5 sentences covering:
1. 具体做了什么改动（主要变更点）
2. 为什么要做这个改动（背景/原因）
3. 改动的影响范围（影响哪些功能）
4. 需要注意的事项（如破坏性变更、配置需求等）

## 格式示例
feat: 添加用户登录功能

实现基于 JWT 的用户认证系统：
- 新增 /api/auth/login 和 /api/auth/logout 接口
- 密码使用 bcrypt 加密存储
- 登录失败 5 次后锁定账户 30 分钟
- 支持 remember me 功能，- 需要在 .env 中配置 JWT_SECRET

Use the same language as existing commits (prefer Chinese).
Output ONLY the commit message, no explanations.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath } = body;

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    // Get staged diff
    const gitService = createGitService(repoPath);
    const diff = await gitService.getDiff(undefined, true);

    if (!diff.raw || diff.raw.trim() === '') {
      return NextResponse.json(
        { error: '没有暂存的更改，请先暂存要提交的文件' },
        { status: 400 }
      );
    }

    // Truncate diff if too large (keep first 8000 chars for context)
    const truncatedDiff = diff.raw.length > 8000
      ? diff.raw.slice(0, 8000) + '\n... (diff truncated)'
      : diff.raw;

    // Get model from settings or use default
    const model = getSetting('default_model') || 'claude-sonnet-4-6';

    // Use the same provider resolution logic as chat (streamClaude)
    const activeProvider = getActiveProvider();

    let apiKey: string | undefined;
    let baseUrl: string | undefined;

    if (activeProvider?.api_key) {
      apiKey = activeProvider.api_key;
      baseUrl = activeProvider.base_url || undefined;
    } else {
      const appToken = getSetting('anthropic_auth_token');
      const appBaseUrl = getSetting('anthropic_base_url');
      apiKey = appToken || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
      baseUrl = appBaseUrl || process.env.ANTHROPIC_BASE_URL;
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: '请在设置中配置 AI 提供者，或设置 ANTHROPIC_API_KEY 环境变量' },
        { status: 400 }
      );
    }

    const apiUrl = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/v1/messages`
      : 'https://api.anthropic.com/v1/messages';

    console.log('[ai-commit] Calling API:', apiUrl, 'with model:', model);

    // Direct API call
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        system: COMMIT_MESSAGE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Generate a commit message for these staged changes:

\`\`\`diff
${truncatedDiff}
\`\`\``
          }
        ]
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ai-commit] API error:', response.status, errorText);
      return NextResponse.json(
        { error: `API 错误 (${response.status}): ${errorText.slice(0, 200)}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('[ai-commit] API response:', JSON.stringify(data).slice(0, 200));

    // Extract text from response
    let commitMessage = '';
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          commitMessage += block.text;
        }
      }
    }

    // Clean up the response
    commitMessage = commitMessage
      .replace(/^```.*\n?/gm, '')
      .replace(/```$/gm, '')
      .replace(/^\s*[\r\n]/gm, '')
      .trim();

    if (!commitMessage) {
      return NextResponse.json(
        { error: 'AI 未能生成有效的提交信息' },
        { status: 500 }
      );
    }

    return NextResponse.json({ message: commitMessage });
  } catch (error) {
    console.error('[ai-commit] Failed to generate commit message:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('API key') || errorMessage.includes('ANTHROPIC') || errorMessage.includes('401')) {
      return NextResponse.json(
        { error: '请在设置中配置 AI 提供者，或设置 ANTHROPIC_API_KEY 环境变量' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: `生成提交信息失败: ${errorMessage}` },
      { status: 500 }
    );
  }
}
