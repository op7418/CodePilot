# 统一上下文层 + 浮窗助理 + 产品架构演进

> 创建时间：2026-03-24
> 最后更新：2026-03-24

## 状态

| Phase | 内容 | 状态 | 备注 |
|-------|------|------|------|
| Phase 1 | 统一上下文层（Context Assembler + MCP Loader） | ✅ 已完成 | 已合入 worktree |
| Phase 2 | Plan Mode 补全 | ✅ 已完成 | UI + 状态恢复 + 安全修复 |
| Phase 3 | Bridge 能力升级 | ✅ 已完成 | CLI 工具上下文注入 |
| Phase 4 | 浮窗助理（Electron 常驻 + 快捷键 + 语音 + 剪贴板） | 📋 待开始 | 需单独规划 |
| Phase 5 | 代码任务通知（系统通知推送） | 📋 待开始 | 依赖 Phase 4 的交互范式确认 |

---

## 一、起因：项目架构散装问题

### 问题描述

CodePilot 发展至今，积累了 6 套独立的"连接器"系统，各有自己的发现机制、注入方式、调用链路和 UI 入口：

| 系统 | 发现方式 | 注入方式 | UI 入口 |
|------|---------|---------|---------|
| Skills | 文件系统扫描 `.claude/skills/` | 展开为纯文本插入 prompt | `/` 弹出框 |
| MCP | 读 3 个配置文件合并 | SDK 原生加载 | 设置页管理 |
| CLI Tools | `which` + `--version` 探测 | system prompt XML 块 | 工具栏弹出框 |
| Plugins | `~/.claude/plugins/` 目录扫描 | SDK 自动加载 | 设置页管理 |
| Generative UI | 模型输出 code fence 检测 | system prompt 指令 | 消息流内 iframe |
| Bridge | 适配器自注册 | 独立消息循环 | CLI skill 启停 |

这些系统之间几乎没有共享抽象，导致三个结构性问题：

1. **上下文组装碎片化**：`route.ts` 有 150 行内联组装逻辑（5 层 prompt），Bridge 只用裸 `session.system_prompt`。同一个用户装了 ffmpeg、配了 MCP、开了 widget，但从 Bridge 发消息时 Claude 不知道这些能力存在。
2. **扩展的"身份"没有统一**：Skills、CLI Tools、MCP tools、Plugins 本质上都是"Claude 可以调用的能力"，但注册方式、生命周期、UI、作用域全部不同。
3. **各入口能力不对称**：Browser chat 有全功能，Bridge 缺 CLI/Widget，Assistant 又是另一套。

### 参考：Moxt 的 AI-Native Workspace

Moxt（[moxt.ai](https://moxt.ai)）的核心洞察：

- **Less Content is More Context** — 重要的不是工具数量，而是 AI 能无摩擦调用。
- 所有能力统一在"工作空间"概念下：文件系统、记忆、技能、AI 同事不是独立功能，而是同一空间的不同维度。
- 用户不需要知道"这是 MCP 工具还是 Skill"，只需说"帮我做这件事"。

映射到 CodePilot：应有一个统一的能力层（Capability Layer），所有扩展注册进去，Claude 按需调用。

---

## 二、架构方向

### 目标架构

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ 主窗口    │  │ 浮窗助理  │  │ Bridge   │  │ 未来入口  │
│ (完整UI)  │  │ (快捷键   │  │ (IM远程)  │  │          │
│          │  │ +剪贴板   │  │           │  │          │
│          │  │ +语音)    │  │           │  │          │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │              │
     └─────────────┴─────────────┴──────────────┘
                        │
              ┌─────────▼──────────┐
              │  Context Assembler  │
              │  按入口类型决定       │
              │  注入哪些能力层       │
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │  SDK Gateway        │
              │  (streamClaude)    │
              │  所有入口共享        │
              └────────────────────┘
```

四个入口形态不同，但底层共享：
- **主窗口**：完整开发体验，生成式 UI、文件树、全功能
- **浮窗助理**：轻量、快进快出、剪贴板 + 语音驱动
- **Bridge**：IM 远程，文字驱动
- **助理空间**：长期记忆、个性化

### 核心设计原则

1. **按 mode 决定注入什么** — 助理模式不注入 CLI/widget（省上下文），代码模式不注入 workspace prompt
2. **不重实现 SDK 已有功能** — plan mode、settingSources、MCP 加载全用 SDK 原生
3. **入口增加不需要重写上下文逻辑** — 新增浮窗助理只需调 `assembleContext({ entryPoint: 'floating' })`

---

## 三、Phase 1-3 已完成：统一上下文层

### 3.1 Context Assembler（`src/lib/context-assembler.ts`）

从 `route.ts` 提取 150 行内联组装逻辑为纯 async 函数。按 `entryPoint` 条件注入 5 层 prompt：

| 层 | Desktop | Bridge | 说明 |
|----|---------|--------|------|
| Workspace prompt | ✅ 如果 isAssistantProject | ✅ 如果 isAssistantProject | soul.md, user.md, memory.md 等 |
| session.system_prompt + append | ✅ | ✅ | 会话自定义 prompt + 技能注入 |
| Assistant project instructions | ✅ 如果 isAssistantProject | ✅ 如果 isAssistantProject | onboarding / daily check-in |
| CLI tools context | ✅ | ✅ **（新增）** | 检测到的系统工具 XML 块 |
| Widget system prompt | ✅ 如果 generative_ui_enabled | ❌ 永不注入 | IM 渲染不了 iframe |

复用现有函数（loadWorkspaceFiles、assembleWorkspacePrompt、buildCliToolsContext 等），不重写。

### 3.2 MCP Loader（`src/lib/mcp-loader.ts`）

**问题**：`loadMcpServers()` 在 route.ts 和 conversation-engine.ts 中完全重复。且 SDK 通过 `settingSources: ['user', 'project', 'local']` 已自动加载所有 MCP 服务器，手动再传一遍是冗余的。

**方案**：Delta 模式。
- `loadCodePilotMcpServers()`：只返回有 `${...}` env placeholder 的服务器（需从 CodePilot DB 解析）。当前实际配置中无此类服务器，返回 undefined。
- `loadAllMcpServers()`：全量合并，供 MCP Manager UI 展示。
- 30 秒 TTL 缓存 + 配置变更时主动失效。

**延迟影响**：大多数用户场景下不再传任何手动 MCP 配置给 SDK，消除冗余配置解析。

### 3.3 Plan Mode 补全

**之前的问题**：
- `permissionMode` 硬编码为 `'acceptEdits'`，切到 Plan 不生效
- mode 状态刷新即丢（hardcoded `useState('code')`）
- 无 UI 切换入口

**修复**：
- 从请求体 `mode` 字段读取（优先）或从 DB `session.mode` 读取（fallback），消除竞态
- Plan mode 优先于 full_access：`bypassPermissions = full_access && mode !== 'plan'`
- `initialMode` prop 从 DB 恢复
- ModeIndicator 组件（Tabs），Code/Plan 切换

### 3.4 Bridge 升级

- `conversation-engine.ts` 调用 `assembleContext({ entryPoint: 'bridge' })`，获得 CLI 工具上下文
- 补齐 5 个缺失 SDK 选项：thinking(disabled)、effort(medium)、generativeUI(false)、fileCheckpointing(false)、context1m(false)

### 3.5 UI 统一

Action bar 三个组件（ModeIndicator、ImageGenToggle、ChatPermissionSelector）统一为：
- 圆角矩形（`rounded-md`）
- 相同高度（`h-7` = 28px）
- 相同字号（`text-xs`）
- 各自带语义图标（Code / NotePencil / PaintBrush / Lock）

---

## 四、Phase 4 待开始：浮窗助理

### 4.1 产品定位

参考 Perplexity 桌面版的"常驻后台 + 快捷键拉起"模式，CodePilot 的浮窗助理定位为：

**始终在身边的助理，不需要打开主窗口就能执行任务。**

```
用户在任何 app 里工作
  → 复制了一段文字/截了一张图（进剪贴板）
  → 按全局快捷键（如 Cmd+Shift+Space）
  → 浮窗从右上角弹出
  → 自动读取剪贴板内容，显示在输入区作为上下文
  → 用户语音说指令（或打字）
  → Claude 执行，结果语音播报
  → 用户关掉浮窗，继续工作
```

全程不需要切换到 CodePilot 主窗口。

### 4.2 核心决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 浮窗用哪个 workspace？ | 固定在助理 workspace | 助理任务不需要项目上下文，避免上下文爆炸 |
| 新建还是继续对话？ | 用户选择 | 可以新建，也可以在助理已有对话上继续 |
| 代码任务怎么办？ | 回主窗口 | 代码需要审查，通过系统通知告知 |
| 语音方案？ | 双轨 | 本地 Whisper（愿意下模型的用户）+ API（配置不够的用户） |
| TTS 回复？ | 仅浮窗助理 | 代码任务不需要语音播报 |

### 4.3 技术方案

**块 1：Electron 常驻 + 全局快捷键 + 浮窗**
- `Tray` 做常驻（菜单栏图标）
- `globalShortcut.register()` 注册全局快捷键
- 独立 `BrowserWindow`，小尺寸，置顶，圆角
- Esc 或失焦自动收起（隐藏不关闭）

**块 2：剪贴板感知**
- 弹出时 `clipboard.readText()` + `clipboard.readImage()`
- 有文字：显示为上下文预览卡片
- 有图片：显示缩略图，作为 vision 输入
- 空：直接显示输入框

**块 3：语音输入/输出**
- 抽象接口：
  ```ts
  interface SpeechProvider {
    transcribe(audio: AudioBuffer): Promise<string>  // STT
    speak(text: string): Promise<void>                // TTS
    readonly type: 'local' | 'api'
    readonly ready: boolean
  }
  ```
- 本地：Whisper + 系统 TTS
- API：OpenAI Whisper API + TTS API
- 用户设置里选，或自动降级（本地模型没下载就 fallback 到 API）

### 4.4 上下文隔离

浮窗助理始终在助理模式：
- Context Assembler 按 `entryPoint: 'floating'` 组装，只注入 workspace prompt + session prompt
- 不注入 CLI tools、widget prompt、项目文件上下文
- 上下文小 → 响应快 → 适合快进快出

---

## 五、Phase 5 待开始：代码任务通知

代码任务留在主窗口，但通过系统通知推送关键事件：

```
助理浮窗:  语音输入 → AI 处理 → 语音/文字回复（快进快出）
代码任务:  主窗口操作 → 需要注意力时推系统通知 → 用户点通知回到主窗口
```

通知场景：
- "任务完成：已创建 3 个文件"
- "需要审批：Claude 想执行 `rm -rf dist/`"
- 点击通知 → 跳转到主窗口对应会话

技术：Electron `Notification` API，简单直接。

---

## 六、技术债务 & 后续优化

| 项目 | 说明 | 优先级 |
|------|------|--------|
| Skills/Commands 双轨发现 | SDK 自动发现 + CodePilot 手动扫描不同步，UI 显示的能力 ≠ Claude 实际知道的 | P1 |
| Widget prompt 始终注入 | ~150 tokens，不大但无关对话也在。已做 keyword-gated MCP，prompt 本身可进一步按需注入 | P2 |
| Bridge 缺 thinking/effort UI | 目前 Bridge 固定 thinking=disabled, effort=medium，未来可加 binding 级别配置 | P3 |
| 统一能力注册表 | 长期目标：`AgentCapabilityRegistry` 让所有扩展统一注册，UI 有统一"能力面板" | P3 |
| ConversationContext 一等实体 | 封装 provider + model + tools + skills + files + cwd，消除重复解析逻辑 | P3 |

---

## 七、相关文件

| 文件 | 用途 |
|------|------|
| `src/lib/context-assembler.ts` | 统一上下文组装 |
| `src/lib/mcp-loader.ts` | 智能 MCP 加载器 |
| `src/components/chat/ModeIndicator.tsx` | Plan/Code 模式切换 UI |
| `src/app/api/chat/route.ts` | 主聊天端点（已重构） |
| `src/lib/bridge/conversation-engine.ts` | Bridge SDK 调用（已升级） |
| `src/__tests__/unit/context-assembler.test.ts` | 上下文组装测试 |
| `src/__tests__/unit/mcp-loader.test.ts` | MCP 加载器测试 |
