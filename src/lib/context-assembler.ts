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
  /** Whether this is an image agent mode call */
  imageAgentMode?: boolean;
  /** Whether this is an auto-trigger turn (heartbeat, onboarding hook, etc.) */
  autoTrigger?: boolean;
}

export interface AssembledContext {
  /** Final assembled system prompt string, or undefined if no layers produced content */
  systemPrompt: string | undefined;
  /** Whether generative UI is enabled (affects widget MCP server + streamClaude param) */
  generativeUIEnabled: boolean;
  /** Whether widget MCP server should be registered (keyword-gated) */
  needsWidgetMcp: boolean;
  /** Onboarding/checkin instructions (route.ts uses this for server-side completion detection) */
  assistantProjectInstructions: string;
  /** Whether this session is in the assistant workspace */
  isAssistantProject: boolean;
}

// ── Main function ────────────────────────────────────────────────────

export async function assembleContext(config: ContextAssemblyConfig): Promise<AssembledContext> {
  const { session, entryPoint, userPrompt, systemPromptAppend, conversationHistory, imageAgentMode, autoTrigger } = config;
  const t0 = Date.now();

  let workspacePrompt = '';
  let assistantProjectInstructions = '';
  let isAssistantProject = false;

  // ── Layer 1: Workspace prompt (if assistant project session) ──────
  try {
    const workspacePath = getSetting('assistant_workspace_path');
    if (workspacePath) {
      const sessionWd = session.working_directory || '';
      isAssistantProject = sessionWd === workspacePath;

      if (isAssistantProject) {
        const { loadWorkspaceFiles, assembleWorkspacePrompt, loadState, shouldRunHeartbeat } =
          await import('@/lib/assistant-workspace');

        // Incremental reindex BEFORE MCP search so tool calls see latest content.
        // Timeout after 5s to prevent blocking on large workspaces (e.g. Obsidian vaults).
        try {
          const { indexWorkspace } = await import('@/lib/workspace-indexer');
          const indexStart = Date.now();
          indexWorkspace(workspacePath);
          const indexMs = Date.now() - indexStart;
          if (indexMs > 3000) {
            console.warn(`[context-assembler] Workspace indexing took ${indexMs}ms — consider reducing workspace size`);
          }
        } catch {
          // indexer not available or timed out, skip — MCP search will use stale index
        }

        const files = loadWorkspaceFiles(workspacePath);

        // Memory/retrieval is handled by codepilot_memory_search MCP tool.
        // assembleWorkspacePrompt only includes identity files (soul/user/claude).
        // We also inject a lightweight "memory availability hint" so AI knows
        // what's available without loading full content.
        workspacePrompt = assembleWorkspacePrompt(files);

        // Memory availability hint: tell AI what daily memories exist
        try {
          const { loadDailyMemories } = await import('@/lib/assistant-workspace');
          const recentDays = loadDailyMemories(workspacePath, 5);
          if (recentDays.length > 0) {
            const dateList = recentDays.map(d => d.date).join(', ');
            workspacePrompt += `\n\n<memory-hint>Recent daily memories available: ${dateList}. Use codepilot_memory_recent to review them.</memory-hint>`;
          }
        } catch {
          // skip if daily memories unavailable
        }

        const state = loadState(workspacePath);

        // Detect heartbeat auto-trigger by checking the actual prompt content,
        // not just the autoTrigger flag (which is also true for buddy-welcome).
        const isHeartbeatTrigger = autoTrigger && userPrompt.includes('心跳检查');

        if (!state.onboardingComplete) {
          assistantProjectInstructions = buildOnboardingInstructions();
        } else if (isHeartbeatTrigger && shouldRunHeartbeat(state)) {
          // Full heartbeat task mode — only for explicit heartbeat auto-trigger
          assistantProjectInstructions = buildHeartbeatInstructions();
        } else {
          // Progressive file update guidance for completed onboarding
          assistantProjectInstructions = buildProgressiveUpdateInstructions();

          // Soft heartbeat hint for normal conversations when overdue.
          // The AI naturally incorporates a brief check-in; the backend
          // updates lastHeartbeatDate when it detects heartbeat keywords
          // in the assistant response (no HEARTBEAT_OK token needed).
          if (!autoTrigger && shouldRunHeartbeat(state)) {
            assistantProjectInstructions += '\n\n' + buildSoftHeartbeatHint();
          }

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

  // ── Layer 2: Session prompt + per-request append ──────────────────
  let finalSystemPrompt: string | undefined = session.system_prompt || undefined;
  if (systemPromptAppend) {
    finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + systemPromptAppend;
  }

  // Workspace prompt goes first (base personality), session prompt after (task override)
  if (workspacePrompt) {
    finalSystemPrompt = workspacePrompt + '\n\n' + (finalSystemPrompt || '');
  }

  // ── Layer 3: Assistant project instructions ───────────────────────
  if (assistantProjectInstructions) {
    finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + assistantProjectInstructions;
  }

  // Layer 4 removed — CLI tools capability prompt is now injected in
  // claude-client.ts only when the MCP server is also mounted (keyword-gated).

  // ── Layer 5: Widget system prompt (desktop only) ──────────────────
  const generativeUISetting = getSetting('generative_ui_enabled');
  const generativeUIEnabled = entryPoint === 'desktop' && generativeUISetting !== 'false';

  if (generativeUIEnabled) {
    try {
      const { WIDGET_SYSTEM_PROMPT } = await import('@/lib/widget-guidelines');
      finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + WIDGET_SYSTEM_PROMPT;
    } catch {
      // Widget prompt injection failed — don't block
    }
  }

  // ── Widget MCP keyword detection (desktop only) ───────────────────
  let needsWidgetMcp = false;
  if (generativeUIEnabled) {
    const widgetKeywords = /可视化|图表|流程图|时间线|架构图|对比|visualiz|diagram|chart|flowchart|timeline|infographic|interactive|widget|show-widget|hierarchy|dashboard/i;
    if (widgetKeywords.test(userPrompt)) needsWidgetMcp = true;
    else if (conversationHistory?.some(m => m.content.includes('show-widget'))) needsWidgetMcp = true;
    else if (imageAgentMode) needsWidgetMcp = true;
  }

  // ── Layer 6: Dashboard context (desktop only) ─────────────────────
  // Inject compact summary of pinned widgets so the AI knows what's on the dashboard.
  if (entryPoint === 'desktop' && session.working_directory) {
    try {
      const { readDashboard } = await import('@/lib/dashboard-store');
      const config = readDashboard(session.working_directory);
      if (config.widgets.length > 0) {
        const summary = config.widgets.map((w, i) => `${i + 1}. ${w.title} — ${w.dataContract}`).join('\n');
        const trimmed = summary.length > 500 ? summary.slice(0, 500) + '...' : summary;
        finalSystemPrompt = (finalSystemPrompt || '') + `\n\n<active-dashboard>\nThe user has ${config.widgets.length} widget(s) pinned to their project dashboard:\n${trimmed}\n</active-dashboard>`;
      }
    } catch {
      // Dashboard read failed — don't block
    }
  }

  console.log(`[context-assembler] total: ${Date.now() - t0}ms (entry=${entryPoint}, prompt=${finalSystemPrompt?.length ?? 0} chars)`);

  return {
    systemPrompt: finalSystemPrompt,
    generativeUIEnabled,
    needsWidgetMcp,
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
- 不要自己写文件，系统会自动从你收集的信息生成 soul.md、user.md、claude.md 和 memory.md
- 整个过程保持友好、自然，像两个人第一次认识在聊天
</assistant-project-task>`;
}

function buildSoftHeartbeatHint(): string {
  return `<heartbeat-hint>
今天还没有做过日常检查。在回答用户问题的同时，可以自然地：
- 简短提及 HEARTBEAT.md 中你觉得值得关注的事项
- 回顾最近记忆，看有没有需要跟进的
不要让检查主导对话，优先回答用户的问题。
如果你确实做了检查（哪怕只是简短一提），请在回复末尾加上 <!-- heartbeat-done -->
</heartbeat-hint>`;
}

function buildHeartbeatInstructions(): string {
  return `<assistant-project-task type="tick">
这是一次自主检查。你可以做以下任何事情：

1. 检查 HEARTBEAT.md 中的检查清单
2. 回顾最近的记忆，看看有没有需要跟进的事
3. 如果发现值得告诉用户的事，说出来
4. 如果没什么事，回复 HEARTBEAT_OK

你也可以主动：
- 更新过期的记忆文件
- 整理 daily memory 中的重复内容
- 更新 user.md 如果发现用户画像有变化

如果什么都不需要做，回复 HEARTBEAT_OK。
不要问固定的问卷问题，不要重复上次已讨论的内容。
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

### 记忆文件（可以静默更新）
- memory.md：追加稳定的事实和偏好（只追加，不覆写）
- memory/daily/{日期}.md：记录今天的工作和决策

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
