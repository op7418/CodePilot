/**
 * Core onboarding processing logic, extracted from the API route
 * so it can be called directly from server-side completion detection
 * without an HTTP round-trip.
 */
import fs from 'fs';
import path from 'path';
import { getSetting, getSession } from '@/lib/db';
import { resolveProvider } from '@/lib/provider-resolver';
import { loadState, saveState, ensureDailyDir, generateRootDocs } from '@/lib/assistant-workspace';
import { getLocalDateString } from '@/lib/utils';
import { generateTextFromProvider } from '@/lib/text-generator';


/**
 * Process onboarding completion. Generates workspace files from answers.
 * Idempotent: if state.onboardingComplete is already true, returns early.
 *
 * @throws Error if workspace path is not configured or processing fails
 */
export async function processOnboarding(
  answers: Record<string, string>,
  sessionId?: string,
): Promise<void> {
  const workspacePath = getSetting('assistant_workspace_path');
  if (!workspacePath) {
    throw new Error('No workspace path configured');
  }

  // Idempotent check
  const currentState = loadState(workspacePath);
  if (currentState.onboardingComplete) {
    return;
  }

  // Look up the calling session for provider/model context
  let session: ReturnType<typeof getSession> | undefined;
  if (sessionId) {
    session = getSession(sessionId) ?? undefined;
    if (session && session.working_directory !== workspacePath) {
      throw new Error('Session does not belong to current workspace');
    }
  }

  // Build Q&A text from free-form conversation answers
  const qaText = Object.entries(answers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  let soulContent: string;
  let userContent: string;
  let claudeContent: string;
  let memoryContent: string;

  try {
    const resolved = resolveProvider({
      sessionProviderId: session?.provider_id || undefined,
      sessionModel: session?.model || undefined,
    });
    const providerId = resolved.provider?.id || 'env';
    const model = resolved.upstreamModel || resolved.model || getSetting('default_model') || 'claude-sonnet-4-20250514';

    const soulPrompt = `Based on the following conversation summary, generate a soul.md file for an AI assistant.

${qaText}

Structure:
## Core Personality
(1-2 sentences defining the assistant's fundamental character)

## Communication Style
(Specific: concise/detailed, formal/casual, proactive/passive)

## Behavioral Boundaries
(User's explicit no-go zones and preferences)

## Relationship with User
(How to address the user, conversation tone)

Rules:
- Keep under 1500 characters
- Use second person ("You are...")
- Every rule must be specific and actionable, not vague
- Only include what was explicitly discussed, don't invent`;

    const userPrompt = `Based on the following conversation summary, generate a user.md profile.

${qaText}

Structure:
## Basic Info
(Name/title, role, main work areas)

## Current Goals
(Near-term goals or focus areas mentioned)

## Preferences
(Known work habits and preferences, as specific bullet points)

## Workspace Organization
(How they organize files, their philosophy on folders vs tags)

Rules:
- Keep under 1500 characters
- Use third person
- Only include explicitly mentioned information, don't guess`;

    const claudePrompt = `Based on the following conversation summary, generate a claude.md rules file.

${qaText}

The file MUST contain these system preset sections (copy them exactly), followed by personalized rules based on the conversation:

## Time Awareness
任何涉及时间的场景，先用 date 命令确认当前时间，不要凭记忆猜测。

## Memory Rules
- 用户说"记一下"或"记住"：保留原文存笔记，不添加 TODO，不"发挥"，不改写
- 重要决策和稳定偏好 → 写入 memory.md（追加，不覆写）
- 日常工作记录 → 写入 memory/daily/{日期}.md
- 修改 soul.md / user.md / claude.md → 必须告知用户

## Document Organization
- 双向链接：使用 [[文件名]] 创建文档之间的链接
- 反向链接：追踪哪些文档引用了当前文档
- 标签系统：使用 #标签 进行分类和检索
- 属性标记：在文档顶部使用 YAML frontmatter 添加元数据
- 少用文件夹层级，多用标签和链接做组织

## Writing Constraints
- 不使用空泛修饰词（核心能力、关键、彰显、赋能、驱动…）
- 不使用"不是...而是..."对比句式，除非用户要求
- 输出内容以实用为主，不添加不必要的修饰

## Safety
- 修改身份文件（soul/user/claude.md）后必须通知用户具体改了什么
- memory.md 只追加，不覆写已有内容
- 不在记忆文件中存储密码、API key 等敏感信息

## Personalized Rules
(Add rules based on the conversation: folder philosophy, default inbox location, archive strategy, any other user-specific preferences)

Rules for generation:
- Keep the system preset sections exactly as written above
- Add personalized rules in the last section based on conversation content
- Keep total under 3000 characters`;

    const memoryPrompt = `Based on the following conversation summary, generate an initial memory.md with long-term facts.

${qaText}

Include: user goals, confirmed preferences, stable facts worth remembering.
Keep under 1000 characters. Use bullet points.
Only include explicitly stated information.`;

    [soulContent, userContent, claudeContent, memoryContent] = await Promise.all([
      generateTextFromProvider({ providerId, model, system: 'You generate configuration files for AI assistants. Output only the file content, no explanations.', prompt: soulPrompt }),
      generateTextFromProvider({ providerId, model, system: 'You generate user profile documents. Output only the file content, no explanations.', prompt: userPrompt }),
      generateTextFromProvider({ providerId, model, system: 'You generate configuration files for AI assistants. Output only the file content, no explanations.', prompt: claudePrompt }),
      generateTextFromProvider({ providerId, model, system: 'You generate knowledge files for AI assistants. Output only the file content, no explanations.', prompt: memoryPrompt }),
    ]);

    if (!soulContent.trim() || !userContent.trim()) {
      throw new Error('AI returned empty content');
    }
  } catch (e) {
    console.warn('[onboarding-processor] AI generation failed, using raw answers:', e);
    const fallbackEntries = Object.entries(answers)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
    soulContent = `# Soul\n\n## From Onboarding\n${fallbackEntries}\n`;
    userContent = `# User Profile\n\n## From Onboarding\n${fallbackEntries}\n`;
    claudeContent = `# Rules\n\n## From Onboarding\n${fallbackEntries}\n`;
    memoryContent = `# Memory\n\n## From Onboarding\n${fallbackEntries}\n`;
  }

  // Validate generated content quality before writing
  function validateGeneratedContent(content: string, expectedSections: string[]): boolean {
    if (!content || content.trim().length < 50) return false;
    // Check that at least one expected section header exists
    return expectedSections.some(s => content.includes(s));
  }

  // Write all core files (with quality validation)
  if (validateGeneratedContent(soulContent, ['##', 'Personality', 'Style', 'Boundaries', '性格', '风格'])) {
    fs.writeFileSync(path.join(workspacePath, 'soul.md'), soulContent, 'utf-8');
  } else {
    console.warn('[onboarding] soul.md generation quality too low, using template');
    const fallbackSoul = `# Soul\n\n## Core Personality\nI am your personal assistant.\n\n## Communication Style\nConcise and direct.\n\n## Behavioral Boundaries\nRespect user preferences.\n`;
    fs.writeFileSync(path.join(workspacePath, 'soul.md'), fallbackSoul, 'utf-8');
  }

  if (validateGeneratedContent(userContent, ['##', 'Info', 'Goals', 'Preferences', '信息', '目标'])) {
    fs.writeFileSync(path.join(workspacePath, 'user.md'), userContent, 'utf-8');
  } else {
    console.warn('[onboarding] user.md generation quality too low, using template');
    const fallbackUser = `# User Profile\n\n## Basic Info\n(To be filled)\n\n## Current Goals\n(To be filled during conversations)\n\n## Preferences\n(Will be learned over time)\n`;
    fs.writeFileSync(path.join(workspacePath, 'user.md'), fallbackUser, 'utf-8');
  }

  if (claudeContent.trim() && validateGeneratedContent(claudeContent, ['##', 'Rules', 'Memory', 'Safety', '规则', '记忆'])) {
    fs.writeFileSync(path.join(workspacePath, 'claude.md'), claudeContent, 'utf-8');
  } else if (claudeContent.trim()) {
    console.warn('[onboarding] claude.md generation quality too low, skipping write');
  }

  if (memoryContent.trim()) {
    fs.writeFileSync(path.join(workspacePath, 'memory.md'), memoryContent, 'utf-8');
  }

  // Ensure V2 directories
  ensureDailyDir(workspacePath);
  const inboxDir = path.join(workspacePath, 'Inbox');
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  // Generate config.json from answers
  try {
    const { loadConfig, saveConfig } = await import('@/lib/workspace-config');
    const config = loadConfig(workspacePath);

    const orgStyle = (answers.organization || '').toLowerCase();
    if (orgStyle.includes('project')) config.organizationStyle = 'project';
    else if (orgStyle.includes('time')) config.organizationStyle = 'time';
    else if (orgStyle.includes('topic')) config.organizationStyle = 'topic';
    else config.organizationStyle = 'mixed';

    if (answers.capture_default || answers.default_location) {
      let capture = (answers.capture_default || answers.default_location || '').trim();
      if (path.isAbsolute(capture) || capture.startsWith('~') || capture.includes('..')) {
        capture = 'Inbox';
      }
      config.captureDefault = capture;
    }

    saveConfig(workspacePath, config);
  } catch {
    // config module not available, skip
  }

  // Generate taxonomy from existing directories
  try {
    const { loadTaxonomy, saveTaxonomy, inferTaxonomyFromDirs } = await import('@/lib/workspace-taxonomy');
    const taxonomy = loadTaxonomy(workspacePath);
    if (taxonomy.categories.length === 0) {
      const inferred = inferTaxonomyFromDirs(workspacePath);
      if (inferred.length > 0) {
        taxonomy.categories = inferred;
        saveTaxonomy(workspacePath, taxonomy);
      }
    }
  } catch {
    // taxonomy module not available, skip
  }

  // Generate root docs
  generateRootDocs(workspacePath);

  // Update state
  const today = getLocalDateString();
  const state = loadState(workspacePath);
  state.onboardingComplete = true;
  state.lastHeartbeatDate = today;
  // Keep legacy field in sync for backward compat
  state.lastCheckInDate = today;
  state.schemaVersion = 5;
  saveState(workspacePath, state);
}
