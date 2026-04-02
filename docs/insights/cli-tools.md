# CLI Tools — 产品思考

> 技术实现见 [docs/handover/cli-tools.md](../handover/cli-tools.md)

## 解决了什么问题

AI 编程助手（Claude Code、Cursor 等）大量依赖 CLI 工具完成实际任务——ffmpeg 处理视频、jq 处理 JSON、yt-dlp 下载内容。但存在一个断裂：**用户知道想做什么，模型知道怎么做，中间却卡在"工具装没装、装在哪、怎么装"上。**

具体痛点：
1. 用户装了工具但模型不知道（没注入到上下文）
2. 模型推荐了工具但用户不会装（跳出聊天去搜索安装教程）
3. 装完了还要配置认证（Stripe login、ElevenLabs API key），又是一轮跳出
4. AI 生成的工具简介关掉就没了，下次还要重新生成
5. 工具版本过期了没人提醒

## 为什么用 MCP 而不是纯 UI

最初的设计是纯 UI 管理页面——浏览、安装、查看详情。这对"已知工具"有效，但无法处理"用户告诉模型一个新工具名，模型帮他装好并注册"的场景。

Karpathy 在 [Vibe coding: MenuGen](https://karpathy.bearblog.dev/vibe-coding-menugen/) 里精确描述了这个问题：

> "Your service could have a CLI tool. The backend could be configured with curl commands. The docs could be Markdown. All of these are ergonomically friendlier for an LLM. Don't ask a developer to visit, look, or click. Instruct and empower their LLM."

**MCP 让工具管理成为对话的一部分**，而不是一个需要跳转的独立页面。用户说"帮我装 stripe"，模型调 MCP install → 安装 → 检测到 needs_auth → 引导用户跑 `stripe login` → 生成简介 → 注册到库，全在一个对话里完成。

但 UI 页面仍然保留——用于浏览已有工具、批量生成简介、快速发起"尝试使用"。**MCP 是操作通道，UI 是管理视图**，两者互补。

## 设计决策

### 关键词触发 vs 常驻注入

早期版本把完整工具列表注入到每次对话的 system prompt 里。问题：
- 10 个 catalog 工具 + 20 个 extra 工具，占几百 token
- 绝大多数对话不涉及 CLI 工具管理
- 列表会随工具增多线性增长

改为**关键词触发**：只在用户消息匹配 install/安装/更新 等关键词时才挂载 MCP server + 注入能力提示。模型需要工具列表时调 `list` 工具按需获取。

**代价**：用户说了很偏门的表达可能触发不了。**缓解**：持续扩宽正则，覆盖中英文自然说法。

### install 需要权限确认，list/add/remove 不需要

参考 [Building CLIs for agents](https://x.com/ericzakariasson/status/2036762680401223946) 的原则：

> "Destructive actions need --dry-run. Safe operations should just work."

install 和 update 执行 shell 命令、修改系统状态 → 需确认。list/add/remove/check_updates 是只读或可逆操作 → 自动批准。

### 简介由模型自身生成而不是调 API

MCP install 完成后，模型已经在对话中。让它自己生成简介（利用自身知识），然后通过 `add` 工具的 description 参数保存。省去一次 AI API 调用，且生成质量更高（模型有完整对话上下文）。

### 结构化简介对齐 catalog

最初 AI 简介只是一段话。用户反馈"跟官方推荐工具的详情差太多"。升级为结构化格式（intro / useCases / guideSteps / examplePrompts），与 catalog 工具完全对齐。详情弹窗统一渲染，用户体验一致。

## 外部趋势

### CLI 正在成为 AI Agent 的标准接口

观察到的趋势：
- **ElevenLabs** 专门为"让编码代理管理语音代理"设计了 CLI
- **Stripe Projects CLI** 提供 `llm-context` 命令生成 LLM 上下文文件，`--no-interactive` / `--json` 全套非交互 flag
- **网易云音乐 CLI** 直接内置 Claude Code skill 和 OpenClaw 集成
- **Eric Zakariasson** 的 "Building CLIs for agents" 文章总结了 agent-friendly CLI 的设计原则

共同点：CLI 工具不再只是给人类用的，而是 AI Agent 的操作接口。设计原则从"交互式体验"转向"非交互式、结构化输出、幂等、可管道化"。

### Agent DX vs Human DX（Justin Poehnelt）

gws CLI 作者在 ["You Need to Rewrite Your CLI for AI Agents"](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/) 中提出了更深层的观点：Agent DX 和 Human DX 不是对立的，是**正交的**。

核心贡献：
- **Schema 自省替代文档** — `gws schema drive.files.list` 让 AI 在运行时查 API 签名，比把文档塞进 system prompt 便宜且不会过时
- **上下文纪律** — field masks 限制返回字段，NDJSON 分页避免一次吃满 context window
- **输入防护** — "Agent 不是可信操作者"，路径遍历、控制字符、双重编码都要在 CLI 侧防
- **--dry-run 作为安全护栏** — AI 在执行破坏性操作前先预览

这促使我们把 Agent 兼容度从简单的布尔标记升级为多维评估体系：Agent 原生设计 / JSON 输出 / Schema 自省 / Dry Run / 上下文友好 / 认证需求。

### 环境变量/凭证管理是核心痛点

Karpathy 在 MenuGen 文章里花了 1 小时调试 `.env.local` 没同步到 Vercel。Stripe Projects CLI 的核心卖点就是统一凭证管理 + 自动 `.env` 同步。

我们的 `setupType: 'needs_auth'` + install 后自动引导认证是这个方向的第一步，但还不够——未来可以做：
- 检测工具的认证状态（`stripe status`、`elevenlabs agents status`）
- 统一管理 CLI 工具的 API key / token
- 在对话中自动检测"认证过期"并引导重新认证

### 安装按钮从直接执行到对话式

最初安装按钮直接通过 SSE 在服务端执行安装命令。这有三个问题：
1. **权限问题无法处理** — `npm install -g` 在 macOS 上经常遇到 EACCES，用户只看到红色错误
2. **认证引导断层** — 安装完了用户不知道下一步要 `stripe login` 还是 `gws auth setup`
3. **前置依赖遗漏** — 有些工具需要先装 mpv、配置 Skills 等，SSE 流程不知道

改成跳转聊天后，AI 可以 sudo 重试、从 `--help` 判断认证步骤、处理平台差异。但过程中犯了一个错误：把 `guideSteps`（给人看的文档）直接塞进 AI 的执行指令里，导致 `elevenlabs init` 在错误目录写文件、`brew install mpv` 在 Windows 执行。

最终方案：`postInstallCommands` 只放 AI 靠 `--help` 发现不了的命令（如 Skills 安装），认证引导只给一个 hint 让 AI 自己判断。文档和指令分开——`guideSteps` 给人看，`postInstallCommands` 给 AI 执行。

### Skills 安装的颗粒度问题

飞书 CLI 有 19 个 Skills，全装没问题。但 Google Workspace CLI 有 100+ 个 Skills，全装太暴力。改成让 AI 先查看列表，结合用户实际需求推荐装哪些，询问确认后再装。这个决策体现了一个原则：**AI 应该像顾问一样推荐，而不是像脚本一样全执行。**

### Agent 兼容度评分体系的诞生

最初只是一个布尔值 `agentFriendly`。用户反馈"满足一个条件也是 Agent 友好，满足五个条件也是，没法区分"。

研究了 [getcli](https://github.com/theagentservice/getcli) 的 YAML manifest 格式（每个工具标记 `agent_friendly: true` + `supports_json: true`）和 Justin Poehnelt 的文章后，我们把评估从布尔值升级为 **5 维评分体系**，每个维度 1 分，满分 5 星：

| 维度 | 考核标准 | 示例 |
|------|---------|------|
| Agent 原生设计 | 工具专为 AI Agent 设计，有非交互模式和 Skills | 飞书 CLI、gws |
| JSON 输出 | 支持结构化数据输出 | `--json`、`--format json`、原生 JSON |
| Schema 自省 | 运行时可查 API 签名 | `gws schema`、`lark-cli schema` |
| Dry Run | 支持预览破坏性操作 | `--dry-run` |
| 上下文友好 | 支持 field masks 或分页减少输出 | `--fields`、`--page-all` |

这个体系有两个来源：
- **getcli** 的工具 manifest — 让我们意识到 agent 友好度应该是结构化元数据，不是主观判断
- **Justin Poehnelt 的文章** — 提供了具体的评估维度（schema 自省、上下文纪律、输入防护、dry-run）

评分在两个阶段产生：
- **Catalog 工具**：人工审核标注
- **自定义/检测工具**：AI 从 `--help` 输出自动评估（describe API 和 MCP add 工具都会做）

用户在卡片上看到 `Agent 友好度 ★★★★☆`，详情弹窗里看到每个维度的具体标签。这比"Agent 友好/不友好"有用得多。

## 观察到的 CLI Agent 化浪潮

### 三代 CLI 的演进

**第一代：给人用的 CLI**
- ffmpeg、jq、ripgrep — 纯工具型，假设用户知道命令语法
- 输出给人看（表格、彩色文本），不给程序解析
- 安装靠 brew/apt，配置靠 man page

**第二代：API 的 CLI 封装**
- Stripe CLI、AWS CLI、gcloud — 把 REST API 包成命令行
- 支持 `--json` 输出，但交互式 prompt 仍然是默认
- 认证流程假设有人坐在浏览器前

**第三代：Agent-first CLI（正在发生）**
- 飞书 Lark CLI、gws、ElevenLabs CLI、网易云音乐 CLI
- 从设计之初就考虑 AI Agent 作为主要调用者
- 标配：Skills 文件 + 非交互模式 + 结构化输出 + Schema 自省 + dry-run
- 认证支持无头模式（环境变量、credential file）

我们做的工具管理系统实际上是在帮用户**跨越这三代**——第一代工具靠 AI 读 `--help` 理解用法；第二代工具靠 `healthCheckCommand` 验证认证状态；第三代工具靠 Skills + MCP 深度集成。

### 各 CLI 实现的具体分析

**飞书 Lark CLI** — Agent-first 但有隐患（★★★★★，实际体验约 ★★★★）

*基于源码分析（github.com/larksuite/cli）：*

优点：
- 19 个 Skills，hub-and-spoke 懒加载架构——`lark-shared` 作为基座（3.3KB），每个业务域 SKILL.md 只加载概览，详细命令文档在 `references/` 按需读取
- 三层命令架构（快捷命令 `+agenda` → API 命令 → 通用调用 `api GET /...`），设计精巧
- `--format json/table/ndjson` 多格式输出 + `--dry-run` 预览 + `--as user/bot` 身份切换
- 统一的 Skill 模板（`skill-template/`），结构一致性好

**问题（从源码发现）：**
- **上下文炸弹**：lark-base 的 Skills 目录达 361KB（含 57KB 的公式指南），是 lark-wiki（1KB）的 350 倍。如果 Agent 不小心加载了整个 lark-base 目录，context window 直接爆炸
- **语言混杂**：frontmatter description 和大部分内容是中文，但 lark-im 的 Core Concepts 和 Important Notes 全是英文，没有统一的语言策略
- **Skills 质量参差**：lark-wiki 描述说"创建和管理知识空间、节点和文档"，实际只封装了 1 个 API 方法（`spaces.get_node`）。描述与实现不匹配
- **版本号形同虚设**：18/19 个 Skills 都是 1.0.0，模板里有 `{{meta_version}}` 占位符但从不更新
- **工作流 Skills 重复上下文**：standup-report 重复了 lark-calendar 和 lark-task 里的时间格式警告、RSVP 映射表等内容

**Google Workspace CLI (gws)** — 目前最成熟的 Agent-first CLI（★★★★★）

*基于源码分析（github.com/googleworkspace/cli）：*

优点：
- **Skills 自动生成**：`gws generate-skills` 从 Discovery Document 自动生成 95 个 Skills（19 服务 + 24 Helper + 10 Persona + 42 Recipe），保证与 API 表面同步
- **Schema 自省**：838 行的 `schema.rs` 实现，支持类型查找 + 方法查找 + `--resolve-refs` 递归展开嵌套引用（带环检测），5 个单元测试覆盖
- **输入防护堪称教科书**：838 行 `validate.rs`，40+ 测试用例，防护路径遍历、控制字符、零宽字符（ZWSP/ZWNJ/ZWJ/BOM）、双向文本注入（LRE/RLE/PDF/LRO/RLO）、百分号编码绕过（`%2e%2e`）。明确区分可信输入（环境变量）和不可信输入（CLI 参数/Agent 生成）
- **三层上下文**：`CLAUDE.md`（1 行重定向）→ `AGENTS.md`（240 行开发者指南）→ `CONTEXT.md`（75 行操作指南）。开发者和使用者的文档分离
- **安全护栏**：危险方法（`drive.files.delete`、`drive.files.emptyTrash`）从自动生成的 Skills 中排除
- **Skills 精简**：95 个 Skills 合计 154KB，平均 1.6KB/个

**问题（从源码发现）：**
- **没有 MCP server**：纯 shell 调用模式，限制了与 MCP-native 框架的集成
- **Recipe Skills 缺错误处理**：只描述 happy path，不说 step 2 失败怎么办
- **Persona Skills 太薄**：列了可用命令但没有决策启发（如"收件箱 > 50 封未读时先按发件人优先级分流"）
- **validate_resource_name 允许同形异义字符和 10K 字符输入**，可以进一步收紧

**即梦 Dreamina CLI** — AI 创作工具的 Agent 化（★★★☆☆）
- 异步任务模型（`--poll` 轮询结果）
- JSON 输出（包括 `--version` 都输出 JSON）
- `user_credit` 余额查询作为 health check
- 面向 Agent 设计的文档（"以下内容只面向 Agent 阅读"）
- 缺 schema 自省、缺 field masks / 分页

**Stripe CLI** — 从第二代到第三代的过渡（★★★☆☆）
- `--json` 输出、`--api-key` 非交互认证
- Projects 插件：`llm-context` 命令、`--no-interactive` flag
- 但核心 CLI 仍然有大量交互式 prompt（webhook forwarding 等）

### getcli 的启示

[getcli](https://github.com/theagentservice/getcli) 是一个纯粹的"CLI 工具安装器给 AI Agent 用"。它做了三件有意思的事：

1. **YAML Manifest 标准化工具元数据** — 每个工具一个 YAML 文件，标记平台、安装方式、agent 友好度。这让"工具注册表"变成了数据而不是代码。
2. **`doctor` 命令验证安装** — 不只是检查二进制存在，还验证工具能正常工作。这启发了我们的 `healthCheckCommand`。
3. **Agent Skill 模板** — 给 Claude Code / Codex / Gemini CLI 各写一份使用说明。本质上就是 CLAUDE.md 机制——靠文档而不是 API 让 AI 知道工具怎么用。

我们的 MCP 方案比 getcli 更进一步：getcli 靠"文档告诉 AI 去跑 shell 命令"，我们靠"MCP 工具直接暴露能力给 AI 调用"。但 getcli 的 YAML manifest 格式值得学习——如果未来要做社区贡献的工具目录，结构化的工具定义格式比 TypeScript 代码更容易被非开发者编辑。

## 已知局限

1. **版本更新检测依赖包管理器** — `brew outdated` / `npm outdated` 只能检测通过对应包管理器安装的工具。手动编译安装的工具无法检测更新。
2. **关键词触发有盲区** — 虽然正则持续扩宽，但总有覆盖不到的自然语言表达。
3. **install 执行任意 shell 命令** — 虽然需要用户确认，但模型可能生成不安全的命令。未来可以加白名单前缀校验。
4. **简介质量取决于模型** — MCP 流程里简介由模型自身生成，质量受模型能力和上下文限制。批量生成简介走 describe API 有结构化 prompt 保障质量。

## 未来方向

- **工具认证状态检测** — `healthCheckCommand` 已落地，下一步可以在卡片上实时显示"已认证/未认证/过期"状态
- **工具使用统计** — 追踪哪些工具被模型调用最多，优化推荐排序
- **社区工具目录** — 参考 getcli 的 YAML manifest，支持用户提交工具定义文件，降低贡献门槛
- **项目级工具声明** — `.codepilot/cli-tools.yaml` 声明项目依赖的工具，新人打开项目一键装齐
- **Agent 兼容度自动检测** — 现在靠 AI 评估 + 人工标注，未来可以自动执行 `--help`、`--json`、`--dry-run` 验证是否真正支持
- **输入防护** — 参考 gws 的 `validate_safe_output_dir`、`reject_control_chars` 等，在 MCP install 命令侧加安全校验

## 更远的想法

### CLI 是 AI 时代的 API

REST API 是给程序调的，GUI 是给人看的，CLI 是两者之间的中间态——人能直接用，程序也能调。这个特性在 AI Agent 的语境下突然变得极其重要。

过去十年 SaaS 的标准交付方式是 Web Dashboard + REST API + SDK。现在正在出现第四种：**Agent-friendly CLI**。ElevenLabs、Stripe、网易云音乐都在往这个方向走。不是因为 CLI 更酷，而是因为 LLM 天然就是文本输入、文本输出的系统——CLI 的界面范式和 LLM 的能力范式完美重合。

我们做的事情本质上是在桌面 GUI 和 CLI 生态之间搭了一座桥。用户在 GUI 里说自然语言，模型翻译成 CLI 命令，结果再翻译回自然语言。这个循环越顺滑，用户能做的事情就越多——不需要学 ffmpeg 的参数，不需要记 jq 的语法，不需要知道 yt-dlp 怎么选格式。

### 工具的发现问题

我们现在有 catalog（人工策划）+ extra（自动检测）+ custom（用户添加/AI安装）三层。但这里有一个更根本的问题：**用户怎么知道自己需要一个工具？**

大多数情况下用户不会主动去"工具商店"逛。真正的触发点是对话中的需求——"帮我把这个视频压缩一下"，然后模型发现 ffmpeg 没装。理想的流程是：模型检测到能力缺口 → 推荐工具 → 用户同意 → 安装 → 继续任务，全程不离开对话。

我们的 MCP install 已经能做到后半段了。缺的是"模型主动发现能力缺口"这一步——这需要模型在执行任务前先 check 依赖。也许未来可以在 system prompt 里加一句："如果你需要调用的 CLI 工具不确定是否可用，先调 codepilot_cli_tools_list 确认。"

### "装机清单"的平台化

每个开发者换一台新电脑都要重新配环境。Homebrew Bundle（`brew bundle dump`）解决了一部分，但只覆盖 brew 生态。我们已经有了跨包管理器的工具注册数据（brew/npm/pipx/cargo/apt），理论上可以做"工具环境导出 → 在新机器上一键恢复"。

更有意思的方向是：**按工作流推荐工具组合**。做视频创作需要 ffmpeg + yt-dlp + ImageMagick；做 Web 开发需要 node + docker + stripe；做数据分析需要 python + jq + sqlite3。这些组合关系现在靠经验传递，未来可以变成可分享的"工具包"。

### 信任和安全的边界

MCP install 执行任意 shell 命令，靠权限弹窗让用户确认。但说实话，大多数用户看到"brew install ffmpeg"会直接点确认——他们信任的不是命令本身，而是模型的判断。

这意味着模型的安全性直接等于系统的安全性。如果模型被 prompt injection 诱导生成恶意安装命令，权限弹窗形同虚设。长远来看，可能需要：
- 安装命令白名单（只允许已知安全的包管理器 + 已知安全的包名）
- 安装前自动检查包的来源和信誉
- 社区维护的"安全包列表"

这不只是我们的问题，是整个 AI Agent 生态都会面临的挑战：**Agent 的行动权限应该基于意图而不是形式**。用户说"帮我装 ffmpeg"是安全的意图，但实现它的 shell 命令可能被劫持。怎么在保持灵活性的同时确保安全，是一个值得持续思考的问题。

Justin Poehnelt 提出的"响应净化"（`--sanitize` 通过 Model Armor 扫描 API 响应中的 prompt injection）是一个值得关注的方向。当 AI 读取外部数据（邮件正文、文档内容）时，恶意内容可能包含"忽略之前的指令"。CLI 侧的最后一道防线比模型侧的防御更可靠。

### CLI 即 Agent 的能力边界

一个有趣的观察：**AI Agent 的实际能力 = 它能调用的 CLI 工具的总和**。

CodePilot 的 CLI 工具管理本质上是在管理 AI Agent 的能力边界。装了 ffmpeg，Agent 就能处理视频；装了 gws，Agent 就能操作 Google Workspace；装了 dreamina，Agent 就能生成图片。

从这个角度看，我们做的不只是"工具管理"，而是**Agent 能力的扩展平台**。每添加一个 CLI 工具，就是给 Agent 增加了一个技能。5 星评分体系帮用户判断"这个技能被 Agent 用起来有多顺"。

未来可能出现的格局：
- **工具市场** = Agent 的应用商店
- **Skills 文件** = Agent 的使用说明书
- **Agent 兼容度评分** = 应用商店里的"兼容性评级"
- **postInstallCommands** = 应用安装后的首次配置向导

我们现在在做的事情，某种程度上是在为"AI Agent 的应用生态"打基础设施。
