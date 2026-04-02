# 核心系统护栏：Design / Context / Provider

> 状态：规划中，待逐项确认后提升为正式文档（目标位置：项目根目录，与 CLAUDE.md 并列）

## 目的

定义三个最脆弱系统的不可破坏约束。不是描述现状（ARCHITECTURE.md 干这个），而是**告诉 AI 和人"这些不能碰、这样必须保持"**。

只记录：我们的特定选择、模型不知道的信息、已选定需要强调的方案。通用常识不记。

---

## 一、Design.md

### 1.1 设计原则

> **待确认**：以下原则需要你明确

- [ ] 信息密度偏好——紧凑高密度（VSCode 风格）还是留白舒适（Linear 风格）？代码现状偏紧凑（`text-xs` 多、`gap-1~2`），但没有明确原则
- [ ] 色彩主张——primary 紫蓝色（`oklch(0.546 0.245 262.881)`）是品牌色还是临时选的？
- [ ] 对话 vs UI 的关系——"对话是主角，UI 退后"？还是"UI 和对话并重"？
- [ ] 组件新建判断标准——什么时候允许新建组件？（AI 特别喜欢新建）

### 1.2 技术选型（已锁定）

| 维度 | 选择 | 不允许 |
|------|------|--------|
| CSS 框架 | Tailwind CSS 4 | 不引入 styled-components / CSS Modules |
| 组件基础 | Radix UI 原语 + CVA variants | 不引入 Ant Design / MUI / Chakra |
| 图标 | Phosphor Icons (`@phosphor-icons/react`) | 不引入 Lucide / Heroicons / 其他图标库 |
| 字体 | Geist Sans + Geist Mono (next/font/google) | 不换字体 |
| 暗色模式 | next-themes + `.dark` class + SQLite 持久化 | 不用 media query 方案 |
| 主题切换 | CSS 变量 + `data-theme-family` 属性 | |
| 状态标记 | `data-slot="component-name"` 属性 | |

### 1.3 颜色系统（OKLCH 语义变量，已锁定）

所有颜色使用 OKLCH 色彩空间，通过 CSS 变量定义，light/dark 双套值。

**核心语义色：**

| 变量 | Light | Dark | 用途 |
|------|-------|------|------|
| `--background` | `oklch(1 0 0)` | `oklch(0.147 0.004 49.25)` | 页面背景 |
| `--foreground` | `oklch(0.147 0.004 49.25)` | `oklch(0.985 0.001 106.423)` | 主文字 |
| `--primary` | `oklch(0.546 0.245 262.881)` | `oklch(0.623 0.214 259.815)` | 品牌主色 |
| `--muted` | `oklch(0.97 0.001 106.424)` | — | 次要背景 |
| `--muted-foreground` | `oklch(0.553 0.013 58.071)` | — | 次要文字 |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | 危险/错误 |
| `--border` | `oklch(0.923 0.003 48.717)` | `oklch(1 0 0 / 10%)` | 边框 |
| `--user-bubble` | `oklch(0.22 0.005 250)` | `oklch(0.90 0.003 106)` | 用户消息气泡 |

另有：success / warning / info / chart(5色) / sidebar / terminal 系列变量。

**约束：新增颜色必须用 OKLCH，必须同时定义 light + dark 值，必须使用语义变量名。**

### 1.4 排版系统

| 档位 | 尺寸 | 用途 |
|------|------|------|
| `text-xs` | 10-11px | 小标签、token 计数 |
| `text-sm` | 14px | 默认正文、菜单项 |
| `text-base` | 16px | 输入框 |
| `text-lg` | 18px | Dialog 标题 |
| `text-xl` | 20px | 页面标题 |
| `text-2xl` | 24px | 大标题 |

字重：400(正文) / 500(按钮/标签) / 600(标题)。行高：正文 1.5，prose 1.7。

### 1.5 圆角 + 间距 + 尺寸

**圆角基准**：`--radius: 0.75rem`(12px)，所有圆角从此计算。

**按钮尺寸档位（已锁定）**：

| 档位 | 高度 | 用途 |
|------|------|------|
| xs | h-6 (24px) | 紧凑内联操作 |
| sm | h-8 (32px) | 次要按钮 |
| default | h-9 (36px) | 标准按钮 |
| lg | h-10 (40px) | 强调按钮 |
| icon | size-9 (36px) | 图标按钮 |

**输入框**：h-9 default, h-8 sm, h-10 lg。与按钮对齐。

**图标尺寸**：sm=14 / md=16 / lg=20 / xl=24，集中定义在 `icon.tsx`。

**间距常用值**：gap-1 / gap-1.5 / gap-2 / gap-3 / gap-4 / gap-6。

### 1.6 组件规则

**目录结构**：
- `src/components/ui/` — 基础层（Radix 封装），不含业务逻辑
- `src/components/{功能}/` — 业务组件（chat / settings / layout / bridge 等）

**新建 vs 复用判断**：
- 如果 `ui/` 里已有类似组件 → 复用或扩展 variant，不新建
- 如果是纯 UI 模式（无业务逻辑） → 放 `ui/`
- 如果是特定功能的组合组件 → 放对应功能目录
- **禁止**在 `ui/` 里引入业务逻辑
- **禁止**创建只用一次的 wrapper 组件

### 1.7 页面模式（已锁定结构）

**设置页**：
- 左侧栏 w-52，图标+文字按钮，active=`bg-accent text-accent-foreground`
- 右侧内容 flex-1，overflow-auto
- 内容用 SettingsCard（`rounded-lg border border-border/50 p-4 space-y-4`）
- 表单行用 FieldRow（`flex items-center justify-between gap-4`）

**聊天页**：
- 主区域 `max-w-3xl px-4 py-6 gap-6`
- use-stick-to-bottom 自动滚动
- UnifiedTopBar（标题编辑 + 分支指示 + 面板切换）

**App Shell**：
- ChatListPanel（左侧栏 180-300px）
- 主内容区
- PanelZone（右侧面板：文件树/Git/Dashboard）
- 响应式断点：`lg` (1024px)

### 1.8 动画

- 标准过渡：200ms ease-in-out
- Sheet 关闭：300ms / 打开：500ms
- 自定义 shimmer：2s infinite，水平渐变滑动

---

## 二、Context.md

### 2.1 层级架构

```
System Prompt 组成（按注入顺序）：

Layer 1: Workspace Prompt          ← 仅助理模式
  ├─ claude.md（永不丢弃）
  ├─ soul.md / user.md
  ├─ memory.md
  ├─ 每日记忆（今天+昨天）
  ├─ 根文档（README.ai.md / PATH.ai.md）
  └─ 检索结果（最多 5 条）

Layer 2: Session System Prompt      ← 所有模式
  └─ session.system_prompt + systemPromptAppend（技能注入等）

Layer 3: Assistant Instructions     ← 仅助理模式，条件触发
  ├─ 引导问卷（13题，!onboardingComplete 时）
  └─ 每日问询（3题，needsDailyCheckIn 时）

Layer 4: CLI Tools Prompt           ← 关键词门控
  └─ CLI_TOOLS_MCP_SYSTEM_PROMPT（~116 行，仅匹配时注入）

Layer 5: Widget System Prompt       ← 仅 Desktop，关键词门控
  └─ WIDGET_SYSTEM_PROMPT（~150 tokens，轻量常驻）

Layer 6: Dashboard Context          ← 仅 Desktop
  └─ 已固定的 widget 摘要（≤500 chars）
```

### 2.2 预算常量（已锁定）

| 参数 | 值 | 位置 |
|------|-----|------|
| Workspace 总预算 | 40,000 chars | `assistant-workspace.ts` |
| 单文件上限 | 8,000 chars | 同上 |
| 截断 head | 6,000 chars | 同上 |
| 截断 tail | 1,800 chars | 同上 |
| 每日记忆 | 4,000 chars/条 | 同上 |
| 根文档 | 2,000 chars/条 | 同上 |
| 检索结果 | 3,000 chars/条，最多 5 条 | 同上 |
| 对话历史 fallback | 50 条消息 | `route.ts` / `conversation-engine.ts` |
| Dashboard 摘要 | 500 chars | `context-assembler.ts` |
| CLI help 输出 | 2,000 chars | CLI tools MCP |

### 2.3 入口矩阵

| 层 | Desktop | Bridge | 未来: floating | 未来: friend_channel |
|----|---------|--------|----------------|---------------------|
| Workspace | ✅（如果是助理项目） | ✅（如果是助理项目） | ✅ | ❌ |
| Session prompt | ✅ | ✅ | ✅ | ✅（受限） |
| Assistant instructions | ✅ | ✅ | ❌ | ❌ |
| CLI tools | ✅（关键词门控） | ✅（关键词门控） | ❌ | ❌ |
| Widget | ✅（关键词门控） | ❌ | ❌ | ❌ |
| Dashboard | ✅（关键词门控） | ❌ | ❌ | ❌ |

Bridge 额外约束：`thinking=disabled`，`effort=medium`，`generativeUI=false`。

### 2.4 不可破坏的约束

1. **claude.md 永不丢弃**——即使 workspace 预算溢出也强制保留
2. **优先级排序不可改**——claude.md > soul/user > memory > daily > root docs > retrieval
3. **Bridge 不注入 widget/dashboard**——IM 渲染不了 iframe
4. **MCP 关键词门控必须保留**——避免 SDK tool discovery 的 ~1s 开销
5. **检索仅在 query > 10 chars 时触发**——防止空查询浪费
6. **system prompt 用 `preset: 'claude_code' + append` 模式**——保留 SDK 自带的 skills/cwd 感知

### 2.5 待确认的原则

- [ ] 总 system prompt 上限——所有层加起来不超过多少？目前没有总量控制
- [ ] 项目模式的 session.system_prompt 上限——助理可以多用上下文，项目应该精简，但目前无约束
- [ ] 同时注册 MCP 数量上限——4 套关键词门控各自独立，是否需要限制同时注册数？
- [ ] 上下文膨胀告警——什么时候提醒用户"你的 system prompt 太长了"？

---

## 三、Provider.md

### 3.1 抽象层三入口（不可绕过）

所有 Provider 调用必须走以下三个函数之一：

| 函数 | 用途 | 消费者 |
|------|------|--------|
| `resolveProvider(opts?)` | 通用解析 | 设置页、模型选择器、能力缓存、诊断 |
| `resolveForClaudeCode(provider?, opts?)` | SDK 子进程启动 | claude-client、speech、checkin、onboarding |
| `toAiSdkConfig(resolved, model?)` | Vercel AI SDK 调用 | text-generator、image-generator |

**约束：禁止直接调用任何 Provider 的原生 SDK。新增消费者必须走这三个入口。**

### 3.2 协议 + 认证矩阵

| 协议 | 认证方式 | 代表服务商 |
|------|---------|-----------|
| `anthropic` | api_key / auth_token | Anthropic 官方、智谱、Kimi、MiniMax、火山、百川、小米 |
| `openai-compatible` | api_key | LiteLLM |
| `openrouter` | api_key | OpenRouter |
| `bedrock` | env_only (AWS credentials) | AWS Bedrock |
| `vertex` | env_only (GCP credentials) | Google Vertex |
| `google` | api_key | Google Generative AI |
| `gemini-image` | api_key | Gemini 图片生成 |

### 3.3 服务商文档索引（改之前必查）

> 修改模型名称、接入方式、API 地址前，**必须先查对应服务商的文档确认最新信息**。

| 服务商 | 文档 URL | 用途 |
|--------|---------|------|
| Anthropic | https://docs.anthropic.com/en/docs/about-claude/models | 模型名称、能力、API 版本 |
| OpenRouter | https://openrouter.ai/models | 可用模型列表、定价 |
| 智谱 GLM | https://open.bigmodel.cn/dev/api/ | 模型 ID、API 兼容性 |
| Kimi | https://platform.moonshot.cn/docs/ | Coding Plan 接入规范 |
| MiniMax | https://platform.minimaxi.com/document/ | API 格式、模型能力 |
| 火山引擎 | https://www.volcengine.com/docs/82379 | Ark API 接入 |
| 百炼 | https://help.aliyun.com/zh/model-studio/ | 模型列表、Anthropic 兼容层 |
| AWS Bedrock | https://docs.aws.amazon.com/bedrock/ | 可用模型、区域 |
| Google Vertex | https://cloud.google.com/vertex-ai/docs | 模型版本、API |

**规则：这张表需要持续维护。新增服务商时必须同时添加文档 URL。**

### 3.4 跨 Provider 防泄漏机制（已锁定）

`toClaudeCodeEnv()` 在注入新 Provider 环境变量前，先清理所有托管变量：

```
清理列表：API_TIMEOUT_MS, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX,
AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
CLOUD_ML_REGION, ANTHROPIC_PROJECT_ID, GEMINI_API_KEY, ...
```

**约束：切换 Provider 时必须走 `toClaudeCodeEnv()`，禁止手动拼环境变量。**

### 3.5 能力声明规范

`provider_models` 表有 `capabilities_json` 字段，但大部分是空的。

**规则：新增服务商时必须填写能力声明：**

```json
{
  "reasoning": true,     // 是否支持 thinking/extended thinking
  "toolUse": true,       // 是否支持工具调用
  "vision": true,        // 是否支持图片输入
  "pdf": false,          // 是否支持 PDF 输入
  "contextWindow": 200000 // 上下文窗口大小
}
```

不声明能力的模型 → 功能降级（关闭 thinking、不传图片），而不是让 SDK 去试错报错。

### 3.6 诊断体系概览

**19 类错误分类**（`error-classifier.ts`）：
CLI_NOT_FOUND / NO_CREDENTIALS / AUTH_REJECTED / AUTH_FORBIDDEN / AUTH_STYLE_MISMATCH / RATE_LIMITED / NETWORK_UNREACHABLE / ENDPOINT_NOT_FOUND / MODEL_NOT_AVAILABLE / CONTEXT_TOO_LONG / UNSUPPORTED_FEATURE / CLI_VERSION_TOO_OLD / CLI_INSTALL_CONFLICT / MISSING_GIT_BASH / RESUME_FAILED / SESSION_STATE_ERROR / PROVIDER_NOT_APPLIED / PROCESS_CRASH / UNKNOWN

其中 RATE_LIMITED / NETWORK_UNREACHABLE / SESSION_STATE_ERROR 可自动重试。

**5 探针诊断**（`provider-doctor.ts`）：
1. CLI 探针：二进制存在性、版本、多安装检测
2. Auth 探针：凭证存在性、认证风格冲突
3. Provider 探针：默认 Provider、base_url、模型配置
4. Features 探针：thinking/context_1m 兼容性、过期 session ID
5. Network 探针：各 Provider base_url 可达性

**5 种修复动作**：set-default-provider / apply-provider-to-session / clear-stale-resume / switch-auth-style / reimport-env-config

### 3.7 待确认的原则

- [ ] 模型信息自动探测——是否在启动时调服务商 API 拉取最新模型列表？还是保持手动维护 + 文档 URL 核查？
- [ ] capabilities_json 补全——现有服务商的能力声明大部分是空的，是否需要一次性补全？
- [ ] API key 加密存储——目前是 SQLite 明文存储，是否需要改用 Electron safeStorage / OS keychain？

---

## 质量保障落项（关联）

质量专项 Phase 6-9 未完成：

| Phase | 内容 | 状态 |
|-------|------|------|
| 6 | 4 个 ESLint error 修复 | 未做（`MessageItem.tsx` hooks 条件调用、`ChatView` impure render、`GalleryDetail` setState in effect） |
| 7 | Smoke 测试进 CI | 未做（需 dev server） |
| 8 | E2E 覆盖核心业务流程 | 未做（框架就位，零用例） |
| 9 | PR 截图对比 | 未做（依赖 7/8） |

这三份核心文档定义的是"什么是对的"，质量保障验证的是"怎么确保不破坏"。两者互补。
