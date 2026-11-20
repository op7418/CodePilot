# Hermes Agent 分析 — 与 CodePilot Native Runtime 的结合机会

> **本文采用三段式结构**：外部事实（Hermes）/ 本仓库事实（CodePilot, file:line）/ 推断与建议。
> 每条陈述必须可追溯到具体来源；推断层不得与事实层混写。
>
> **⚠️ 对比基线说明**：本文的 CodePilot 现状以 `docs/handover/decouple-native-runtime.md` 为权威来源。
> `ARCHITECTURE.md:3` 的总览描述仍把主链路写成 Claude Agent SDK，尚未同步到 native runtime 切换——
> 读者遇到两者冲突时请以交接文档为准。

## 来源钉定

**Hermes 本地快照**
- 路径：`/Users/op7418/Documents/code/资料/hermes-agent-main`
- 快照时点：2026-04-09（对应仓内 `RELEASE_v0.8.0.md` 发布窗口）
- 非 git 仓库（ZIP 解压），无 commit SHA；只能按路径 + 行号引用
- Hermes 上游真正的 tag 是日期制（`v2026.4.8` 等），**不存在 `v0.8.0` tag**，只有 `RELEASE_v0.8.0.md` 这个文件名
- 本文 "Hermes 事实层" 的所有引用均基于此本地副本

**CodePilot 基线**
- 权威文档：`docs/handover/decouple-native-runtime.md`
- 代码引用：`src/...:行号` 形式，便于复核

---

## 一、Hermes 事实层（外部项目当前实现）

### 1.1 Agent Loop 结构与仓库布局

核心 `AIAgent` 类和 `run_conversation()` 主循环仍在 **`run_agent.py`（9,660 行，487KB，仓库根目录）**。
与此**并列**，`agent/` 目录下有 26 个独立模块，其中正好装着本文推荐借鉴的多数能力：

| 模块 | 行数 | 职责 |
|---|---|---|
| `agent/auxiliary_client.py` | 2253 | 辅助模型统一路由，多档 fallback |
| `agent/context_compressor.py` | 745 | LLM 驱动上下文压缩 |
| `agent/memory_manager.py` | 367 | 可插拔记忆后端管理 |
| `agent/subdirectory_hints.py` | 224 | 渐进式子目录 hint 发现 |
| `agent/models_dev.py` | — | models.dev 目录集成 |
| `agent/smart_model_routing.py` | — | 模型能力路由 |

**关键观察**：run_agent.py 是单文件巨构（属于已知技术债），但参考实现是**干净隔离**的——
要 port 到 TS/Next.js，看的是 `agent/*.py` 里这些独立模块，不需要去扒 9660 行的主循环。

### 1.2 IterationBudget — 父子独立预算（run_agent.py:169-210）

docstring 原文（粘贴以免转述失真）：

> "Each agent (parent or subagent) gets its own `IterationBudget`.
>  The parent's budget is capped at `max_iterations` (default 90).
>  Each subagent gets an independent budget capped at `delegation.max_iterations`
>  (default 50) — this means total iterations across parent + subagents
>  **can exceed the parent's cap**."

关键事实：
- 父子 agent **各自独立预算，不共享**
- 父默认 90 步，子默认 50 步，由 `config.yaml` 的 `delegation.max_iterations` 控制
- **总消耗可以超过父 cap**——因为子是独立计量的
- `refund()` 方法（:197-201）只对 `execute_code`（编程式工具调用）退款，避免脚本化调用吃预算
- 线程安全：`threading.Lock` 保护 `_used` 计数器

### 1.3 并行工具执行判定（run_agent.py:213-336）

这段是整份 Hermes 代码最值得细看的一段，**默认串行、只有证明安全才并行**（whitelist-first）。
共四层判定：

**层 1 — 交互工具黑名单（`run_agent.py:215`，仅 1 条）**
```python
_NEVER_PARALLEL_TOOLS = frozenset({"clarify"})
```
出现 `clarify`（需要用户输入）即整批串行。黑名单刻意保持极小。

**层 2 — 只读白名单（`run_agent.py:217-229`）**
```python
_PARALLEL_SAFE_TOOLS = frozenset({
    "ha_get_state", "ha_list_entities", "ha_list_services",
    "read_file", "search_files", "session_search",
    "skill_view", "skills_list", "vision_analyze",
    "web_extract", "web_search",
})
```
明确枚举"只读、无共享可变状态"的工具才进白名单。非白名单非路径工具一律保守串行。

**层 3 — 路径作用域工具 + 冲突检测（`run_agent.py:232-335`）**
```python
_PATH_SCOPED_TOOLS = frozenset({"read_file", "write_file", "patch"})
```
对这三个工具，`_extract_parallel_scope_path()` 规范化 `path` 参数（展开 `~`、转绝对路径、避开 `.resolve()` 以兼容未存在文件），
然后 `_paths_overlap()` 用**前缀比较**判定冲突（`a/b/c` 与 `a/b` 视为重叠）。
任一 batch 内有路径重叠 → 整批串行。

**层 4 — 终端命令危险模式正则（`run_agent.py:238-263`）**
```python
_DESTRUCTIVE_PATTERNS = re.compile(
    r"""(?:^|\s|&&|\|\||;|`)(?:
        rm\s|rmdir\s|mv\s|sed\s+-i|truncate\s|dd\s|shred\s|
        git\s+(?:reset|clean|checkout)\s
    )""",
    re.VERBOSE,
)
_REDIRECT_OVERWRITE = re.compile(r'[^>]>[^>]|^>[^>]')
```
`_is_destructive_command()` 对 terminal 命令跑正则：命中破坏性模式或 `>` 重定向覆盖 → 视为写操作。

**其他约束**：
- worker 池上限 `_MAX_TOOL_WORKERS = 8`（`run_agent.py:236`）
- 单个 tool call 的 batch 不并行：`if len(tool_calls) <= 1: return False`
- args 解析失败或非 dict → 保守串行
- 决策入口：`_should_parallelize_tool_batch()` at `run_agent.py:266`
- 主循环调用点：`run_agent.py:6133`

### 1.4 辅助模型统一路由（agent/auxiliary_client.py:1-43）

docstring 里明确列出 **7 档 fallback 链**（text 任务，auto 模式）：

1. OpenRouter（`OPENROUTER_API_KEY`）
2. Nous Portal（`~/.hermes/auth.json` active provider）
3. Custom endpoint（`config.yaml` 的 `model.base_url` + `OPENAI_API_KEY`）
4. Codex OAuth（Responses API via chatgpt.com，模型 `gpt-5.3-codex`，包装成 chat.completions 客户端）
5. Native Anthropic
6. Direct API-key providers（z.ai/GLM、Kimi/Moonshot、MiniMax、MiniMax-CN）
7. None（降级）

Vision/多模态任务有另一条不同顺序的 fallback 链。

**两个设计点**：

1. **Per-task 环境变量覆盖**：`CONTEXT_COMPRESSION_PROVIDER`、`AUXILIARY_VISION_PROVIDER`、
   `AUXILIARY_WEB_EXTRACT_PROVIDER` 等，允许每种副任务独立挂到不同 provider；
   配套还有 `*_MODEL` 和 `*_BASE_URL` / `*_API_KEY` 覆盖
2. **HTTP 402 / credit exhaustion 自动 fallback**：某 provider 余额耗尽时 `call_llm()`
   自动切下一档重试。这解决的是"用户 OpenRouter 没钱了但还有 Codex OAuth"的常见场景

docstring 原文定位：`agent/auxiliary_client.py:1-43`。

### 1.5 渐进式子目录 hint 发现（agent/subdirectory_hints.py）

类名 `SubdirectoryHintTracker`，文件头注明 "Inspired by Block/goose"。

**机制**（:67-89、:111-139）：

1. **路径提取**：每次 tool call 后，从 args 提取路径
   - 直接参数：`_PATH_ARG_KEYS = {"path", "file_path", "workdir"}`（:39）
   - terminal 命令：用 `shlex` 解析 command 并抽路径（:42, :103-107）
2. **祖先上溯**：`_add_path_candidate()` 从解析出的路径向上走，每级检查
   `AGENTS.md` / `agents.md` / `CLAUDE.md` / `claude.md` / `.cursorrules`
   - 上限 `_MAX_ANCESTOR_WALK = 5` 级
   - 遇到已加载目录（`_loaded_dirs`）或文件系统根则停
   - **关键巧思**：读 `project/src/main.py` 会发现 `project/AGENTS.md`——即使 `project/src/` 本身没有 hint 文件
3. **注入方式**：发现的 hint **追加到 tool result 字符串末尾**（`return "\n\n" + "\n\n".join(all_hints)`）
   —— 文件头 docstring 明确说这是为了 "preserve prompt caching"，不动 system prompt
4. **去重与防爆炸**：`_loaded_dirs: Set[Path]` 去重，`_MAX_HINT_CHARS = 8_000` 单文件上限

### 1.6 LLM 驱动上下文压缩（agent/context_compressor.py）

`ContextCompressor` 类（:53），5 步算法在 docstring 里明确列出：

> 1. Prune old tool results (cheap, no LLM call)
> 2. Protect head messages (system prompt + first exchange)
> 3. Protect tail messages **by token budget** (most recent ~20K tokens)
> 4. Summarize middle turns with structured LLM prompt
> 5. On subsequent compactions, iteratively update the previous summary

**关键参数**（:64-102）：
- 默认阈值 `threshold_percent = 0.50`（**不是** 80%——超过上下文窗口一半就开始压缩）
- `protect_first_n = 3`（保护前 3 条消息）
- `protect_last_n = 20`（保护最后 20 条，叠加 token 预算约束）
- 尾部 token 预算：`tail_token_budget = threshold_tokens × summary_target_ratio`，
  默认 ≈ 200K × 0.5 × 0.2 = 20K——是**推算值**，随模型 context 窗口自动缩放
- 摘要 token 天花板 `_SUMMARY_TOKENS_CEILING = 12_000`
- 失败冷却 `_SUMMARY_FAILURE_COOLDOWN_SECONDS = 600`（10 分钟内不重试）

**结构化摘要模板**（docstring 第 8 行）：Goal / Progress / Decisions / Files / Next Steps。
多次压缩时迭代更新之前的摘要而非从头重生成。

**与辅助模型的关系**（:20）：`from agent.auxiliary_client import call_llm`——
压缩**走的就是 §1.4 的统一路由**，不是独立维护一套 provider fallback。

### 1.7 与本文前一版本（2026-04-09）的差异修正

| 前版表述 | 真实情况 |
|---|---|
| "v0.8.0" | 无此 tag；`RELEASE_v0.8.0.md` 只是文件名；Hermes 用日期制 tag |
| "9,660 行单文件是技术债，Hermes 自己也在拆分" | 行数对（本地快照），但**不应只看 run_agent.py**——推荐借鉴的组件已独立在 `agent/` 目录 |
| "跨 agent 共享总预算" | **反了**。父子各自独立，总量可超父 cap |
| "网关的 355KB 单文件" | 错。真正的单文件巨构是 `cli.py`（392KB）；`gateway/` 本身是多文件目录 |
| "LLM 压缩触发阈值 80%" | 错。默认 50%（`threshold_percent=0.50`） |

---

## 二、CodePilot 事实层（本仓库当前实现）

权威基线：`docs/handover/decouple-native-runtime.md`。
所有引用形式为 `file:line`。

### 2.1 Agent Loop 主循环（`src/lib/agent-loop.ts:225`）

```ts
while (step < maxSteps) {
  step++;
  // ... streamText() 单步调用
}
```

- 每步调用一次 `streamText()`，由 runtime 控制循环
- **不是** "每步只能有一个 tool call"：`src/lib/agent-loop.ts:353-387` 的
  `for await (event of result.fullStream)` 在同一 step 内可消费多个 `tool-call` 和 `tool-result` 事件
- AI SDK 默认对 batch 内的 tool calls 通过 `Promise.all` 并行执行 tool.execute
- 退出条件：`!hasToolCalls`（model 自然收尾）或 `step >= maxSteps`
- 没有 Hermes 那种"父子独立预算"——`maxSteps` 是硬上限，不区分工具类型

### 2.2 上下文裁剪 = 固定截断标记（`src/lib/context-pruner.ts:12-13`）

```ts
const RECENT_TURNS_TO_KEEP = 6; // Keep last N messages fully intact
const TRUNCATED_RESULT_MARKER = '[Tool result truncated — see earlier in conversation]';
```

- 策略：保留最近 6 轮完整；更早的 tool result 全部替换为**固定截断字符串**
- **不是**"摘要占位"——完全没有 LLM 参与
- **文件自身 docstring 的矛盾**：`src/lib/context-pruner.ts:2-5` 的 docstring 写着
  "replacing detailed tool_result content from older turns with **a short summary**"，
  与实现不符。建议顺手修掉这条误导性注释（本文前一版本被它带偏过）

### 2.3 Auto-compact 半成品状态（`src/lib/context-pruner.ts:85`）

```ts
export function shouldAutoCompact(messages, contextWindowTokens): boolean {
  // Trigger at 80% of context window
  return estimateTokens(messages) > contextWindowTokens * 0.8;
}
```

**关键事实**：全仓 grep `shouldAutoCompact` 只命中**定义行本身**，没有任何调用方——**属于未接线的 stub 代码**。

**诊断意义**：如果长上下文退化真的是活跃痛点，这个函数早该被 agent-loop 调用。
它停在半成品状态说明当前主要矛盾是别的东西。这直接影响了 §3 的优先级排序。

### 2.4 Memory 系统现状（`src/lib/context-assembler.ts:85`）

```ts
// Memory/retrieval is handled by codepilot_memory_search MCP tool.
```

**已有**（`src/lib/builtin-tools/memory-search.ts:20-80`）：
- `codepilot_memory_search`：基于 `searchWorkspace` 的工作区记忆检索，支持 `tags` / `file_type` / `limit` 过滤
- `codepilot_memory_get`：按文件路径 + 行范围读取
- `codepilot_memory_recent`：读最近 3 天 daily + 长期记忆摘要

**没有**：
- **Session 历史搜索**。`messages` 表数据完整存在 SQLite（schema 见 `docs/research/session-management-and-context-compaction.md:29-40`），
  但没有工具把它暴露给模型做跨会话全文检索

### 2.5 项目指令发现仅两级（`src/lib/agent-system-prompt.ts:210-236`）

`discoverProjectInstructions()` 当前的发现层级：
1. 用户级：`~/.claude/CLAUDE.md`
2. 项目级（cwd）：`CLAUDE.md` / `AGENTS.md` / `.claude/settings.md` / `.claude/CLAUDE.md`
3. 父目录级：`dirname(cwd)/{CLAUDE.md, AGENTS.md}`

**没有**：
- 随 tool call 访问路径**渐进式**加载子目录的 AGENTS/CLAUDE——monorepo、
  Obsidian vault、非 cwd 子树的 hint 全部丢失
- 保护 prompt caching 的"追加到 tool result"机制——现在是直接拼到 system prompt

### 2.6 Provider 架构约束 — `sdkProxyOnly`（`src/lib/provider-catalog.ts:107-114`）

```ts
/**
 * True for providers that only support the Claude Code SDK wire protocol
 * (e.g. Kimi /coding/, GLM /api/anthropic).
 * These providers cannot be used with the Vercel AI SDK text generation path
 * (streamText / generateText) because they don't implement the standard
 * Anthropic Messages API.
 */
sdkProxyOnly?: boolean;
```

设计辅助模型 fallback 链时必须考虑的硬约束：
- `sdkProxyOnly=true` 的 provider **不能**走 AI SDK 的 `streamText` / `generateText`
- 辅助任务（压缩、摘要、vision）走的就是 AI SDK 文本生成路径
- 所以当用户主 provider 是 `sdkProxyOnly` 时，**必须** fallback 到另一个支持标准 Messages API 的 provider，
  **不能**假设"同 provider 的小模型一定可用"

### 2.7 Provider 预设里已有的小模型槽位（`src/lib/provider-catalog.ts:41, :73-75`）

```ts
export type ModelRole = 'default' | 'reasoning' | 'small' | 'haiku' | 'sonnet' | 'opus';

interface RoleModels {
  default?: string;
  reasoning?: string;
  small?: string;    // ← 专为"小/快"副任务设计的槽位
  haiku?: string;
  sonnet?: string;
  opus?: string;
}
```

**关键事实**：
- 每个 provider 预设都可以配 `roleModels.small` 或 `roleModels.haiku`——这些已经是 CodePilot 既有的架构约定，用户在 provider 编辑界面能直接改
- `src/lib/provider-resolver.ts:268-272` 已经在把 `roleModels.small` 写到 Claude Code SDK 的 `ANTHROPIC_SMALL_FAST_MODEL` 环境变量——**SDK 路径下 SDK 自己就会用它做内部副任务**（摘要、标题生成等）。Native Runtime 下这个槽位目前没被读，但数据本身是有的（`ResolvedProvider.roleModels` 位于 `provider-resolver.ts:51`）
- 非 Anthropic provider 已有映射：GLM 把 `haiku → glm-4.5-air`、`sonnet → glm-5-turbo`、`opus → glm-5.1`（`provider-catalog.ts:262-266`）
- **退化映射也被考虑过**：MiniMax / MiMo 这类无独立小模型的 provider 把 `haiku/sonnet/opus` 全部映射到同一个模型（`provider-catalog.ts:370-405`）——CodePilot 早就接受"不是所有 provider 都有便宜档"这个事实

**意义**：
设计辅助模型路由**不需要**硬编码"Anthropic → Haiku、OpenAI → gpt-mini"类映射。直接复用 `resolved.roleModels.small` / `.haiku` 即可——用户在 provider 预设里改了什么，辅助路由就自动跟着变。对没有独立小模型的 provider，自然退化为"主模型做副任务"，不引入新的故障模式。

---

## 三、推断与建议层（借鉴路线图）

**排序依据**：基于 §2.3 的死代码信号（auto-compact 没接线）推断长上下文退化尚非活跃痛点，
故 session_search 排在 LLM 压缩之前；并行安全与辅助 provider 是 runtime 质量直接瓶颈，排 P0。
每条推断明确标注依据。

### 3.1 P0 — 并行安全调度器

**依据**：Hermes §1.3（四层 whitelist-first 判定） + CodePilot §2.1（AI SDK 已并行但无安全判定）

**建议实现路径**：
在 `src/lib/agent-tools.ts` 的 tool 包装层插入并行前预检，保留 AI SDK 的 `Promise.all` 并行但对不安全组合强制串行化：

1. 建内置只读白名单（Read / Glob / Grep / WebFetch / codepilot_memory_search 等）
2. 对 Write / Edit 这类路径作用域工具，提取 `path` / `file_path` 参数做前缀比较冲突检测
   —— 直接参考 Hermes `_paths_overlap()` 的前缀比较实现（**不要**用 `fs.realpath`，因为目标文件可能尚未存在）
3. 对 Bash 工具移植 `_DESTRUCTIVE_PATTERNS` 正则（rm/mv/sed -i/git reset/clean/checkout + `>` 重定向覆盖）
4. 不安全组合的处理：通过 tool execute 层加 `async-mutex` 串行化，而非拒绝调用
5. 黑名单保持极小（对应我们的 clarify / elicit 类交互工具）

**关键认知**：这不是"开/关并行"的问题，是"在 AI SDK 并行执行之前插入安全检查"的问题。

### 3.2 P0 — 辅助模型解析 + sdkProxyOnly fallback + 主模型兜底

**依据**：
- Hermes §1.4（统一路由 + per-task 覆盖 + 402 fallback）
- CodePilot §2.6（sdkProxyOnly 硬约束）
- CodePilot §2.7（`roleModels.small` / `.haiku` 槽位早已存在）

**建议实现**：
在 `src/lib/provider-resolver.ts` 新增 `resolveAuxiliaryModel(task: 'compact' | 'vision' | 'summarize' | 'web_extract')`，返回 `{ providerId, modelId }`。

**解析链（从上到下）**：

1. **Per-task 覆盖**：类似 Hermes 的 env override，读 `AUXILIARY_COMPACT_PROVIDER` / `AUXILIARY_COMPACT_MODEL` 等配置。命中即返回。
2. **主 provider 的 `small` 槽位**：如果主 provider 不是 `sdkProxyOnly` 且 `resolved.roleModels.small` 有值 → 用主 provider + small 模型。**这是第一优先**——`small` 槽位语义就是"小/快副任务"，比 haiku 更泛化
3. **主 provider 的 `haiku` 槽位**：上一步不命中但 `roleModels.haiku` 有值 → 用主 provider + haiku 模型
4. **主 provider 是 `sdkProxyOnly` 或两个槽位都为空**：按 fallback 链扫其他已配置 provider，找第一个非 sdkProxyOnly 且 `.small` / `.haiku` 有值的
5. **链全部耗尽**：**直接用主 provider + 主模型做副任务**（**不是**返回 null 让调用方跳过）

**为什么兜底是主模型而不是跳过（last-resort ≠ null）**：
- 用户可能完全没配其他 provider，跳过会让压缩/vision/摘要静默失效——这是用户感受上的"功能不见了"
- "成本优化失败"的正确降级是"不优化"，不是"不做"
- 主模型做副任务至少和现状持平（反正现在就是主模型在做所有事），不引入新的故障模式
- 对没有独立小模型的 provider（如 MiniMax，§2.7 的退化映射），这条路径天然会命中——设计闭环

**402 / credit exhaustion 自动 fallback**：
在 `resolveAuxiliaryModel` 的调用包装里捕获 HTTP 402 与典型 credit 耗尽错误，切换到链的下一档重试；如果已经在最后一档（主模型），向用户报错（因为主对话也会卡住，不是副任务独有问题）。

**不要做的事**：
- **不要硬编码** "Anthropic → Haiku、OpenAI → gpt-mini" 类映射 → 复用 `roleModels` 即可（§2.7）
- **不要假设** "同 provider 的小模型一定可用" → sdkProxyOnly 打破了这个假设（§2.6）
- **不要**为每个副任务独立维护 fallback 链 → 统一走 `resolveAuxiliaryModel`，per-task 覆盖用环境变量/配置，不是用代码
- **不要**在链耗尽时跳过副任务 → 回到主模型是更安全的 floor

### 3.3 P1 — 渐进式子目录 hint 发现（可 1:1 port）

**依据**：Hermes §1.5（`SubdirectoryHintTracker` 参考实现）+ CodePilot §2.5（只有 cwd + parent 两级发现）

**建议实现**（几乎可以 1:1 port `agent/subdirectory_hints.py` 到 TS）：

1. 新建 `src/lib/subdirectory-hint-tracker.ts`，暴露 `SubdirectoryHintTracker` 类
2. 在 agent-tools.ts 的 tool 包装层加钩子：tool call 完成后调用 `tracker.checkToolCall(toolName, args)`
3. 从 args 里的 `path` / `file_path` / `workdir` / `cwd` 提取路径
4. 对 Bash 工具用轻量 shell 解析器（可参考 `shell-quote` npm）提取路径
5. **祖先上溯**（关键）：从解析出的目录向上走最多 5 级，每级查 `AGENTS.md` / `CLAUDE.md` / `.cursorrules`
   ——这样读 `project/src/main.py` 能发现 `project/AGENTS.md`
6. **发现的 hint 追加到 tool result 字符串末尾**，不动 system prompt（保护 prompt caching）
7. `_loadedDirs: Set<string>` 去重，单文件 8KB 上限

**收益**：monorepo（多个子包各有 AGENTS.md）、Obsidian vault（子目录 README）场景直接受益。

### 3.4 P1 — session 历史搜索工具

**依据**：
- Hermes §1.3 的 `_PARALLEL_SAFE_TOOLS` 白名单里赫然有 `session_search`
- CodePilot §2.4：memory_search 已成熟但只搜工作区文件；messages 表完全没有搜索工具

**建议实现**：

1. 新建 `src/lib/builtin-tools/session-search.ts`
2. **复用 codepilot_memory_search 的工具壳**：ai SDK `tool()` 定义 + zod schema（`query` / `sessionId` / `dateRange` / `limit`）
3. 查询 `messages` 表，初版用 `content LIKE '%query%'`，按时间倒序 + limit
4. 如果性能不够（messages 超过几万条），升级为 SQLite FTS5 虚拟表——
   但**不要**一开始就做 FTS，先验证需求
5. 注册到 agent-tools.ts，与 memory_search 平级

**排在 LLM 压缩之前的三个理由**：
- CodePilot §2.3 的死代码信号：长上下文退化还不是活跃痛点
- 复用现有工具壳，成本比从零做 LLM 压缩低一个量级
- 对"找回以前对话里讨论过什么"这种诉求，session 搜索是**直接答案**，不是迂回优化

### 3.5 P2 — LLM 驱动上下文压缩（分两步走）

**依据**：Hermes §1.6（ContextCompressor 5 步算法）+ CodePilot §2.2-2.3（固定截断 + 死代码）

**建议分两步**：

**步 1 — 先把现有基础设施接线**：
1. 在 `src/lib/agent-loop.ts:225` 的 while 入口加 `shouldAutoCompact(messages, contextWindow)` 检查
2. 触发后调用**增强版** `pruneOldToolResults`——
   - 不再固定 6 轮，按 token 预算动态裁（对应 Hermes 的 `protect_last_n` + `tail_token_budget` 双约束）
   - 保留 tool-call 的 name + args summary（而非完全替换为 marker）
   - 保护前 3 条消息（system + 首轮交换）
3. 注意：`shouldAutoCompact` 当前阈值写死 0.8，Hermes 的默认 0.5 更保守——可配置化

**步 2 — 再接辅助模型做真正的摘要**：
1. 依赖 §3.2 的 `resolveAuxiliaryProvider('compact')` 就绪
2. 对被裁掉的中段消息调用小模型生成 Goal / Progress / Decisions / Files / Next Steps 结构化摘要
3. 失败时 fallback 到步 1 的纯裁剪版（参考 Hermes `_SUMMARY_FAILURE_COOLDOWN_SECONDS = 600`）
4. 多次压缩时迭代更新上次的摘要，而非从头重生成

**排在 session_search 之后的理由**：
- §2.3 死代码信号：没有实测数据支持"长上下文退化是当前痛点"
- `pruneOldToolResults` 的粗暴截断是**真正**的第一痛点，步 1 就能缓解大半，不需要步 2
- 步 2 强依赖 §3.2 的辅助 provider 路由，工程链路长

### 3.6 P2 — Skill 自动创建

**依据**：Hermes 在复杂任务完成后主动 nudge 用户保存 Skill；CodePilot 有 Skill 系统但只做发现/执行

**建议实现**：
在 agent-loop 结束时统计步数与工具使用复杂度，超过阈值时在 system prompt 中加
"这个流程看起来值得保存为 Skill" 的 nudge。

**排在最后的理由**：这是体验增强，不是 runtime 质量瓶颈。

### 3.7 Runtime 归属总览

CodePilot 是双 runtime 架构（见 `docs/handover/decouple-native-runtime.md`）：
**Native Runtime** 基于 Vercel AI SDK + 手写 agent loop，**SDK Runtime** 调用 Claude Code CLI 子进程。
本节澄清上述 6 项建议各自落地在哪个 runtime、原因何在——这直接决定 PR 要改哪些文件、要不要同时动两套代码。

**对照表**：

| # | 建议 | Native Runtime<br>(AI SDK) | SDK Runtime<br>(Claude Code CLI) | 备注 |
|---|---|---|---|---|
| 3.1 | 并行安全调度器 | ✅ 独占 | ❌ 不适用 | 工具调度在 CLI 子进程内部，改不到 |
| 3.2 | 辅助模型解析 + 兜底 | ✅ 主战场（新 `resolveAuxiliaryModel`） | 🟡 已部分就位 | 见下方"SDK 已有的隐式优化" |
| 3.3 | 渐进式子目录 hint | ✅ 独占 | ❌ 代价过高 | Native 可在 tool 包装层直接改 tool result；SDK 下需拦截 SSE 流，脆弱性高 |
| 3.4 | Session 历史搜索 | ✅ 两边 | ✅ 两边 | 实现与 runtime 无关，一份代码通过 `codepilot_*` 内置 MCP server 暴露 |
| 3.5 | 长对话压缩（auto-compact + LLM 摘要） | ✅ 独占 | ❌ 不适用 | `pruneOldToolResults` / `shouldAutoCompact` 只在 `agent-loop.ts` 的 while 循环里被调用 |
| 3.6 | Skill 自动创建 | ✅ 两边 | ✅ 两边 | Native hook 在 `agent-loop.ts` while 退出处；SDK hook 在 `stream-session-manager.ts` 流结束处；逻辑可抽公共函数复用 |

**为什么多数建议"只能在 Native 做"**：

根因是 Native Runtime 下 **我们持有 agent loop 的完整控制权**——`agent-loop.ts:225` 的 `while (step < maxSteps)` 在我们代码里，每次 `streamText()` 前后都是我们的代码，工具执行走我们的包装层。
这给了我们在对话流程任意位置插入逻辑的能力：压缩前预检、工具调用前安全判定、tool result 追加 hint 等等。

SDK Runtime 下对话流程封装在 Claude Code CLI 子进程里，我们只能：
1. 启动前设环境变量 / 配置文件
2. 启动后从 SSE 流读事件

对"插入并行前预检""每次 tool call 后追加 hint""检测 context 接近上限就压缩"这类**插入式**需求，SDK 路径根本没有代码插入点。

**SDK Runtime 已有的隐式优化（单独拎出来讲）**：

`src/lib/provider-resolver.ts:268-272` 早就在做这件事：

```ts
if (resolved.roleModels.small) {
  env.ANTHROPIC_SMALL_FAST_MODEL = resolved.roleModels.small;
}
```

Claude Code CLI 会读 `ANTHROPIC_SMALL_FAST_MODEL` 环境变量做它**自己**的内部副任务（标题生成、短摘要等）。所以在 SDK Runtime 下：

- **只要 provider 预设里配了 `roleModels.small`，辅助模型降本已经在生效**——用户感知不到但账单能看出来
- GLM / Kimi / MiniMax 这些 `sdkProxyOnly` provider 走 SDK 路径时本来就享受这个优化（前提是它们的预设配齐了 `.small`）
- 而 Anthropic 直连、OpenAI OAuth 等走 Native 路径的场景目前**完全没享受**——因为 Native 路径的 `agent-loop.ts` 根本没读 `resolved.roleModels.small`

**产品含义（一句话）**：

§3.2 的本质**不是**"引入新功能"，是 **"让 Native Runtime 追平 SDK Runtime 早就有的隐式优化"**。
做完之后所有 runtime × 所有 provider 的辅助模型路由规则就统一了，不再出现"换个 provider 或切换 runtime 导致辅助降本突然消失"的情况。

**对 PR 拆分的提示**：

将来把这份路线图拆成 PR 时，可以按这张归属表分：
- **"Native Runtime 能力升级"大 PR**：§3.1（并行安全）+ §3.2 的 Native 部分（新 `resolveAuxiliaryModel`）+ §3.3（渐进子目录）+ §3.5（长对话压缩）
- **"跨 runtime 共用能力" PR**：§3.4（session 搜索）+ §3.6（Skill nudge）
- **"SDK Runtime 预设校验" 小 PR**：确保所有 `provider-catalog.ts` 预设的 `roleModels.small` 都配齐——属于 §3.2 的 SDK 侧补强，成本极低，可以独立落地
- §3.7 的结论可以直接作为这些 PR 的开场白，解释"为什么这个 PR 只动 Native / 为什么两个 runtime 都要改"

---

## 四、不建议借鉴（带理由）

| 内容 | 理由 |
|---|---|
| Python 实现直接移植 | 我们是 TS/Next.js 栈 |
| run_agent.py / cli.py 的单文件巨构风格（分别约 9.7K 行 / 约 400KB） | Hermes 自己的 `agent/` 目录拆分正在反向修正这条路；参考实现本来也不在单文件里 |
| 完整 browser 工具套件 | 我们有 chrome-devtools MCP，功能重叠 |
| 多平台 IM 网关（Telegram/Discord/Slack/WhatsApp/Signal/Matrix/钉钉/飞书 8 家） | CodePilot 有独立的 bridge 系统，架构不同；8 家支持不是 runtime 质量瓶颈 |
| RL 训练数据生成（`environments/hermes_base_env.py`） | 产品定位不同 |

---

## 附录：Codex 独立审查处理记录

2026-04-11 对本文前一版本的代码层审查指出以下问题，已在本次重写中逐条处理：

1. ~~"pruneOldToolResults 替换为摘要占位"~~ → 改为"固定截断标记"，并标注文件自身 docstring 误导（§2.2）
2. ~~"AI SDK 默认并行所以不用改"~~ → 改为"并行已有但缺安全判定"，补充四层 whitelist-first 判定（§2.1, §3.1）
3. ~~"跨 agent 共享总预算"~~ → 改为独立预算并直接引 docstring 原文（§1.2）
4. ~~"只有文件记忆"~~ → 区分已有的 `codepilot_memory_search` 与缺失的 session 搜索（§2.4, §3.4）
5. ~~"v0.8.0"~~ → 改为本地快照 + 日期制 tag 说明（"来源钉定"段）
6. ~~未提 `sdkProxyOnly` 约束~~ → 已作为辅助 provider 设计的核心依据（§2.6, §3.2）
7. ~~"LLM 压缩阈值 80%"~~ → 改为 50%（Hermes 默认），补充 token 预算是推算值（§1.6）
8. ~~"网关 355KB 单文件"~~ → 删除，改为 cli.py 作为真正的单文件巨构示例（§四）

**同时记录一条 Codex 自身需要纠正的判断**：Codex 在审查中主张 "Hermes 当前公开仓库 run_agent.py 更像入口层，核心逻辑已经拆到 agent/ 包"。
经本地副本（2026-04-09 快照）核对，`AIAgent` 类与 `run_conversation()` 主循环**仍在 run_agent.py 内**（§1.1），
`agent/` 目录是与 run_agent.py **并列**存在的独立模块集合。此条作为"外部代码审查意见也需要回到代码本身验证"的案例留档。

### 2026-04-12 用户补充三点细化（§2.7 / §3.2 / §3.7）

1. **辅助模型兜底应回到主模型而非跳过**：原 §3.2 step 4 写"链耗尽 → 返回 null，调用方跳过辅助任务"。修正为"链耗尽 → 用主 provider + 主模型做副任务"。理由：跳过会让用户感觉功能失效；回到主模型至少和现状持平。
2. **复用 CodePilot 既有的 `roleModels.small` / `.haiku` 槽位**：原 §3.2 step 2 写"主 provider 的小模型（Anthropic → Haiku、OpenAI → gpt-mini）"，硬编码成 provider-specific 启发式。修正为直接读 `resolved.roleModels.small` / `.haiku`——这两个槽位早就存在于 `provider-catalog.ts:41, :73-75`，且 `provider-resolver.ts:268-272` 已经在为 SDK 路径把 `.small` 写到 `ANTHROPIC_SMALL_FAST_MODEL` 环境变量。Native Runtime 下只是没读。新增 §2.7 记录这个事实。
3. **补充 §3.7 Runtime 归属总览**：明确 6 项建议各自落在 Native Runtime / SDK Runtime / 两边，解释为什么多数"只能在 Native 做"（根因是 Native 持有 agent loop 控制权），并指出 SDK Runtime 其实**已经**通过 `ANTHROPIC_SMALL_FAST_MODEL` 隐式享受到一部分辅助模型优化——§3.2 的本质是让 Native 追平 SDK 既有的隐式能力，而不是引入全新功能。同时给出按 runtime 归属拆 PR 的建议。

**建议后续动作**（不在本调研稿范围内）：
- `ARCHITECTURE.md:3` / `:57` 的主链路描述仍停留在 Claude Agent SDK 单路径，与 `docs/handover/decouple-native-runtime.md` 的双 runtime 口径冲突，
  应在独立的小修 PR 中同步，避免持续污染对比类研究文档
- `src/lib/context-pruner.ts:2-5` 的 docstring 与实现不符（"short summary" vs 固定 marker），
  应顺手修掉
