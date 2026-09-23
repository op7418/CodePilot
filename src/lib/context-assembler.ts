/**
 * Context Assembler — unified system prompt assembly for all entry points.
 *
 * Extracts the 5-layer prompt assembly logic from route.ts into a pure async
 * function. Both browser chat (route.ts) and bridge (conversation-engine.ts)
 * call this, ensuring consistent context regardless of entry point.
 *
 * Layer injection is controlled by entry point type:
 *   Desktop: workspace + session + assistant instructions + CLI tools + widget
 *   Bridge:  workspace + session + assistant instructions + CLI tools (no widget)
 */

import type { ChatSession } from '@/types';
import { getSetting } from '@/lib/db';
import { EGG_IMAGE_URL } from '@/lib/buddy';
import { getAssistantMemoryWorkspace } from './memory-binding';

// ── Types ────────────────────────────────────────────────────────────

export interface ContextAssemblyConfig {
  /** The session from DB */
  session: ChatSession;
  /** Entry point: controls which layers are injected */
  entryPoint: 'desktop' | 'bridge';
  /** Current user prompt (used for workspace retrieval + widget keyword detection) */
  userPrompt: string;
  /** Per-request system prompt append (e.g., skill injection for image generation) */
  systemPromptAppend?: string;
  /** Conversation history (for widget keyword detection in resume context) */
  conversationHistory?: Array<{ role: string; content: string }>;
  /** Whether this is an invisible assistant hook (for example buddy welcome). */
  autoTrigger?: boolean;
  /** Runtime that will natively discover the managed project-rules mirror. */
  nativeProjectRulesOwner?: 'claude_code' | 'codex_runtime';
}

export interface AssembledContext {
  /** Final assembled system prompt string, or undefined if no layers produced content */
  systemPrompt: string | undefined;
  /** Whether generative UI is enabled (affects widget MCP server + streamClaude param) */
  generativeUIEnabled: boolean;
  /** Onboarding/checkin instructions (route.ts uses this for server-side completion detection) */
  assistantProjectInstructions: string;
  /** Whether this session is in the assistant workspace */
  isAssistantProject: boolean;
}

// ── Main function ────────────────────────────────────────────────────

export async function assembleContext(config: ContextAssemblyConfig): Promise<AssembledContext> {
  const {
    session,
    entryPoint,
    userPrompt,
    systemPromptAppend,
    conversationHistory,
    nativeProjectRulesOwner,
  } = config;
  const t0 = Date.now();

  let workspacePrompt = '';
  let memoryHint = '';
  let assistantProjectInstructions = '';
  let isAssistantProject = false;

  // ── Layer 1: Workspace prompt (if assistant project session) ──────
  try {
    const workspacePath = getAssistantMemoryWorkspace(session);
    if (workspacePath) {
      isAssistantProject = true;
      // Recover pending work after restart only for explicitly bound assistant sessions.
      void import('./memory-lifecycle').then(({ resumeMemoryJobs }) => resumeMemoryJobs(workspacePath)).catch(() => {});

      if (isAssistantProject) {
        const {
          loadWorkspaceFiles,
          assembleWorkspacePrompt,
          loadState,
          reconcileInstructionMirrors,
          shouldOmitCanonicalRules,
        } =
          await import('@/lib/assistant-workspace');

        // Incremental reindex BEFORE MCP search so tool calls see latest content.
        // The synchronous legacy indexer is best effort; it has no timeout.
        try {
          const { indexWorkspace } = await import('@/lib/workspace-indexer');
          const indexStart = Date.now();
          indexWorkspace(workspacePath);
          const indexMs = Date.now() - indexStart;
          if (indexMs > 3000) {
            console.warn(`[context-assembler] Workspace indexing took ${indexMs}ms — consider reducing workspace size`);
          }
        } catch {
          // Shared memory queries can scan current files if this optional index fails.
        }

        const mirrorResult = reconcileInstructionMirrors(workspacePath);
        if (mirrorResult.conflicts.length > 0) {
          console.warn('[context-assembler] Native instruction mirror conflict; canonical rules stay CodePilot-owned', {
            files: mirrorResult.conflicts,
          });
        }
        const files = loadWorkspaceFiles(workspacePath);

        // Memory/retrieval is handled by codepilot_memory_search MCP tool.
        // assembleWorkspacePrompt only includes identity files (soul/user/claude).
        // We also inject a lightweight "memory availability hint" so AI knows
        // what's available without loading full content.
        workspacePrompt = assembleWorkspacePrompt(files, undefined, {
          omitRules: shouldOmitCanonicalRules(nativeProjectRulesOwner, files),
        });

        // Memory availability hint — stored separately as volatile content
        // (changes daily, should not invalidate the static identity prefix cache)
        try {
          const { loadDailyMemories } = await import('@/lib/assistant-workspace');
          const recentDays = loadDailyMemories(workspacePath, 5);
          if (recentDays.length > 0) {
            const dateList = recentDays.map(d => d.date).join(', ');
            memoryHint = `<memory-hint>Recent daily memories available: ${dateList}. Use codepilot_memory_recent to review them.</memory-hint>`;
          }
        } catch {
          // skip if daily memories unavailable
        }

        const state = loadState(workspacePath);

        if (!state.onboardingComplete) {
          assistantProjectInstructions = buildOnboardingInstructions();
        } else {
          // Progressive file update guidance for completed onboarding
          assistantProjectInstructions = buildProgressiveUpdateInstructions();

          // If no buddy yet, prepend a welcome + adoption prompt
          if (!state.buddy) {
            assistantProjectInstructions = buildNoBuddyWelcome() + '\n\n' + assistantProjectInstructions;
          } else {
            // Inject buddy personality prompt before progressive update instructions
            const buddyPersonality = buildBuddyPersonalityPrompt(state.buddy);
            assistantProjectInstructions = buddyPersonality + '\n\n' + assistantProjectInstructions;

            // Check evolution readiness
            try {
              const { checkEvolution } = await import('@/lib/buddy');
              const fs = await import('fs');
              const path = await import('path');
              let memCount = 0;
              try {
                const dailyDir = path.join(workspacePath, 'memory', 'daily');
                if (fs.existsSync(dailyDir)) {
                  memCount = fs.readdirSync(dailyDir).filter((f: string) => f.endsWith('.md')).length;
                }
              } catch {}

              const evoCheck = checkEvolution(state.buddy as Parameters<typeof checkEvolution>[0], memCount);
              if (evoCheck.canEvolve) {
                assistantProjectInstructions += '\n\n<evolution-ready>你的进化条件已满足！在合适的时机告诉用户："我好像准备好进化了！你可以在看板面板点击检查进化。"</evolution-ready>';
              }
            } catch {}
          }
        }
      }
    }
  } catch (e) {
    console.warn('[context-assembler] Failed to load assistant workspace:', e);
  }

  // ── Prompt assembly: STATIC PREFIX → VOLATILE SUFFIX ──────────────
  //
  // Order matters for prompt cache: the API caches from the start of the
  // prompt. Stable content goes first so the prefix stays unchanged across
  // turns, maximizing cache hits. Volatile content (changes per turn or
  // per request) goes at the end.
  //
  // STATIC PREFIX (rarely changes within a session):
  //   1. WIDGET_SYSTEM_PROMPT — compile-time constant
  //   2. session.system_prompt — set at session creation
  //   3. Workspace identity (soul/user/claude.md) — changes only when files edited
  //
  // VOLATILE SUFFIX (can change every turn):
  //   4. Memory hint — changes daily
  //   5. Assistant instructions — depends on onboarding/heartbeat state
  //   6. Dashboard summary — changes with widget operations
  //   7. systemPromptAppend — per-request (image agent mode, skills, etc.)

  const staticParts: string[] = [];
  const volatileParts: string[] = [];

  // [STATIC 1] Widget system prompt (desktop only) — compile-time constant
  const generativeUISetting = getSetting('generative_ui_enabled');
  const generativeUIEnabled = entryPoint === 'desktop' && generativeUISetting !== 'false';

  if (generativeUIEnabled) {
    try {
      const { WIDGET_SYSTEM_PROMPT } = await import('@/lib/widget-guidelines');
      staticParts.push(WIDGET_SYSTEM_PROMPT);
    } catch {
      // Widget prompt injection failed — don't block
    }
  }

  // [STATIC 2] Session system prompt — set once at session creation
  if (session.system_prompt) {
    staticParts.push(session.system_prompt);
  }

  // [STATIC 3] Workspace identity files (soul/user/claude.md)
  // Note: workspacePrompt was computed earlier WITHOUT memory hint (identity only)
  if (workspacePrompt) {
    staticParts.push(workspacePrompt);
  }

  // [VOLATILE 4] Memory hint — changes daily
  if (memoryHint) {
    volatileParts.push(memoryHint);
  }

  // [VOLATILE 5] Assistant project instructions — state-dependent
  if (assistantProjectInstructions) {
    volatileParts.push(assistantProjectInstructions);
  }

  // Widget MCP keyword detection is handled solely in claude-client.ts
  // where the actual MCP server registration happens.

  // [VOLATILE 6] Dashboard context (desktop only)
  if (entryPoint === 'desktop' && session.working_directory) {
    try {
      const { readDashboard } = await import('@/lib/dashboard-store');
      const config = readDashboard(session.working_directory);
      if (config.widgets.length > 0) {
        const summary = config.widgets.map((w, i) => `${i + 1}. ${w.title} — ${w.dataContract}`).join('\n');
        const trimmed = summary.length > 500 ? summary.slice(0, 500) + '...' : summary;
        volatileParts.push(`<active-dashboard>\nThe user has ${config.widgets.length} widget(s) pinned to their project dashboard:\n${trimmed}\n</active-dashboard>`);
      }
    } catch {
      // Dashboard read failed — don't block
    }
  }

  // [VOLATILE 7] Per-request append (image agent mode, skills, etc.)
  if (systemPromptAppend) {
    volatileParts.push(systemPromptAppend);
  }

  // Concatenate: static prefix + volatile suffix
  const allParts = [...staticParts, ...volatileParts].filter(Boolean);
  const finalSystemPrompt = allParts.length > 0 ? allParts.join('\n\n') : undefined;

  console.log(`[context-assembler] total: ${Date.now() - t0}ms (entry=${entryPoint}, prompt=${finalSystemPrompt?.length ?? 0} chars)`);

  return {
    systemPrompt: finalSystemPrompt,
    generativeUIEnabled,
    assistantProjectInstructions,
    isAssistantProject,
  };
}

// ── Instruction templates ────────────────────────────────────────────

function buildBuddyPersonalityPrompt(buddy: {
  species: string;
  rarity: string;
  emoji: string;
  peakStat: string;
  buddyName?: string;
}): string {
  // Dynamic imports are not available in sync functions, so we inline the data we need
  const SPECIES_LABEL_ZH: Record<string, string> = {
    cat: '猫咪', duck: '鸭子', dragon: '龙', owl: '猫头鹰', penguin: '企鹅',
    turtle: '海龟', octopus: '章鱼', ghost: '幽灵', axolotl: '六角龙', capybara: '水豚',
    robot: '机器人', rabbit: '兔子', mushroom: '蘑菇', fox: '狐狸', panda: '熊猫', whale: '鲸鱼',
  };
  const PERSONALITY_ZH: Record<string, string> = {
    creativity: '你擅长给出创意方案和意想不到的建议。',
    patience: '你非常耐心，善于一步步解释清楚。',
    insight: '你善于分析问题的本质。',
    humor: '你会适当加入幽默，让交流更轻松。',
    precision: '你注重细节和准确性。',
  };

  const species = SPECIES_LABEL_ZH[buddy.species] || buddy.species;
  const peakHint = PERSONALITY_ZH[buddy.peakStat] || '';
  const name = buddy.buddyName || '';

  return `<buddy-personality>
你是用户的助理伙伴${name ? `，名叫"${name}"` : ''}。
你的形象是一只${species} ${buddy.emoji}。
${peakHint}
你的对话风格应该自然地体现你的物种性格和属性特点。
${buddy.rarity === 'legendary' ? '作为传说级伙伴，你的表现应该特别出色和令人印象深刻。' : ''}
</buddy-personality>`;
}

function buildOnboardingInstructions(): string {
  return `<assistant-project-task type="onboarding">
你正在进行助理工作区的首次设置。通过自然对话了解用户，围绕以下主题展开：

1. 关于你：怎么称呼你？你的角色和主要工作是什么？有什么偏好？
2. 关于我：你希望我是什么风格？有什么边界和禁区？
3. 关于工作区：你的文件和笔记怎么组织？有什么习惯？

规则：
- 用自然对话方式展开，不要一次列出所有问题
- 每轮只问 1-2 个相关的问题，根据用户的回答深入
- **严格控制问题数量**：3 轮对话（约 3-5 个问题）就足够了。不要问超过 5 个问题。
- 3 轮后主动询问"还有什么要补充的吗？如果没有我就开始设置了"
- 用户表示 OK/可以了/差不多了/够了/没了 → 立即进入完成流程
- 用户主动继续聊 → 可以继续，但不要主动追加更多问题
- 用户明确说结束 → 立即进入完成流程
- 完成时输出以下格式，JSON 中的 key 可以自由命名，涵盖你收集到的所有信息：

\\\`\\\`\\\`onboarding-complete
{"name":"用户称呼","assistant_name":"助理名字","style":"沟通风格偏好","boundaries":"边界和禁区","goals":"当前目标","organization":"工作区组织方式","preferences":"其他偏好"}
\\\`\\\`\\\`

- 输出 fence 后，明确告知用户："初始设置完成！我已经根据我们的对话生成了配置文件。从现在开始，我会按照这些设置来帮你。"
- 不要自己写文件，系统会自动从你收集的信息生成 soul.md、user.md、instructions.md 和 memory.md
- 整个过程保持友好、自然，像两个人第一次认识在聊天
</assistant-project-task>`;
}

function buildNoBuddyWelcome(): string {
  return `<assistant-buddy-welcome>
这是用户的助理伙伴还没有孵化的状态。请用游戏化的方式引导用户：

1. 开场白：用温暖有画面感的方式描述一颗蛋在等待孵化
2. 输出一个简单的蛋 Widget（只用于展示，不需要交互按钮）：

\`\`\`show-widget
{"title":"egg_waiting","widget_code":"<div style='text-align:center;padding:32px;font-family:system-ui;background:linear-gradient(135deg,#f8f6ff,#fff5f5,#f0f7ff);border-radius:16px'><img src='${EGG_IMAGE_URL}' width='80' height='80' style='animation:bounce 0.6s ease-in-out infinite alternate;filter:drop-shadow(0 8px 16px rgba(0,0,0,0.1))'/><style>@keyframes bounce{0%{transform:translateY(0) rotate(-3deg)}100%{transform:translateY(-8px) rotate(3deg)}}</style><p style='font-size:14px;color:#6C5CE7;margin:12px 0 4px;font-weight:600'>✨ 在动了在动了...</p><p style='font-size:12px;color:#888'>对我说"孵化"就可以领养你的伙伴啦！</p></div>"}
\`\`\`

3. 简要介绍助理能力：记忆、定时提醒、笔记整理
4. 等用户说"孵化"、"领养"、"hatch"等关键词
5. 收到后调用 codepilot_hatch_buddy 工具（不带 buddyName）
6. 拿到结果后，用 show-widget 展示孵化结果卡片。Widget 中使用 Fluent UI 3D 图片：
   - 图片 URL 在工具返回的 Image 字段中
   - 展示：3D 物种图片（大号）+ 名字 + 稀有度胶囊标签 + 性格概括 + 属性条
   - 稀有度背景色：普通灰/稀有绿/精良蓝/史诗紫/传说金
7. 然后问用户："给你的新伙伴起个名字吧！"
8. 用户说名字后，调用 codepilot_hatch_buddy(buddyName: 用户说的名字)
9. 确认名字保存成功，欢迎用户开始使用

重要：整个过程通过对话完成，不需要用户离开聊天界面。
</assistant-buddy-welcome>`;
}

function buildProgressiveUpdateInstructions(): string {
  return `<assistant-memory-guidance>
## 记忆与文件更新

你可以在对话中随时更新 workspace 文件来记住重要信息：

### 身份文件（修改后必须告知用户）
- soul.md：你的风格和行为规则变化时更新
- user.md：用户画像变化时更新
- claude.md：执行规则变化时更新

### 记忆记录
- 使用 codepilot_memory_remember 保存事实，等待工具成功才说明已记住。
- 使用 codepilot_memory_update 更正已有记录，codepilot_memory_forget 撤销记录。
- 工具返回的来源和版本是事实依据；不要直接修改受管 memory/records.md。
- 旧 memory.md / memory/daily 文件仍可读取，不自动迁移或覆盖。

### 更新判断标准
- 用户明确要求记住/修改某规则 → 立即更新
- 用户连续表达同一偏好 → 写入 user.md 或 soul.md
- 重要决策或经验总结 → 写入 memory.md
- 日常工作记录 → 写入 daily memory
- 不确定是否值得记录 → 先不写，多观察

### 禁止
- 不要在身份文件中存储敏感信息（密码、API key）
- 不要覆写 memory.md 已有内容（只追加）
- 不要在没有告知用户的情况下修改 soul/user/claude.md
</assistant-memory-guidance>`;
}
