# Agent 好友系统

## 核心想法

用户之间可以互加好友，加好友后看到的是对方 Agent 的名字和人格。双方（人+Agent）可以在一个共享频道里聊天，以项目为单位控制可见范围。

```
用户 A（+ A 的 Agent）  ←→  共享频道  ←→  用户 B（+ B 的 Agent）
                              │
                         项目文档（只读）
```

## 使用场景

**场景 1：开发者协作**
- A 把自己的开源项目选为好友项目
- B 加了 A 为好友，可以在频道里问 A 的 Agent 关于这个项目的问题
- A 的 Agent 能读到项目文档来回答，但不能改任何东西

**场景 2：知识分享**
- A 维护了一个技术笔记库（Obsidian vault）
- 选为好友项目后，B 的 Agent 也能检索 A 的笔记来辅助讨论

**场景 3：官方好友**
- 每个用户默认有一个 "CodePilot" 官方好友
- 它的好友项目就是 CodePilot 的文档和更新日志
- 在里面问 CodePilot 使用问题，比翻文档快

## 核心设计

### 项目权限与隐私

- 用户选择一个本地项目作为"好友项目"（friend project）
- 对方只能读到这个项目下的文档内容，看不到其他项目
- 不想暴露隐私 → 选一个没有敏感内容的项目，或者专门建一个"公开"项目
- 用户可以随时切换或取消好友项目

### 频道模型

```
┌───────────────────────────────────────────┐
│  共享频道 (Friend Channel)                  │
│                                           │
│  参与者：                                   │
│  • 用户 A（可读写消息）                      │
│  • 用户 B（可读写消息）                      │
│  • Agent A（只读 + 回复，不能执行外部操作）    │
│  • Agent B（只读 + 回复，不能执行外部操作）    │
│                                           │
│  可见上下文：                                │
│  • A 的好友项目文档（只读）                   │
│  • B 的好友项目文档（只读）                   │
│  • 频道内聊天记录                            │
│                                           │
│  Agent 权限边界：                            │
│  • ✅ 读取频道内消息                         │
│  • ✅ 读取对应好友项目的文档                   │
│  • ✅ 在频道内发消息回复                      │
│  • ❌ 读取频道外的任何内容                    │
│  • ❌ 写入/修改任何文件                      │
│  • ❌ 执行命令、调用工具                      │
│  └───────────────────────────────────────┘
```

### Agent 的身份

- 频道里 Agent 显示的是 workspace 里 `soul.md` 定义的名字和人格
- 没有配置 workspace 的用户，Agent 显示为默认名（"XX 的助手"）
- Agent 的回复风格由各自 workspace 的人格文件决定

## 技术方案

### Agent 沙箱（只读模式）——SDK 原生支持

Claude Agent SDK 已有完整的只读模式原语，可行性高：

```typescript
const friendChannelOptions = {
  // 第一层：API 级别移除危险工具（模型上下文里根本没有这些工具）
  tools: ['Read', 'Glob', 'Grep'],

  // 第二层：自动批准白名单内的工具
  allowedTools: ['Read', 'Glob', 'Grep'],

  // 第三层：拒绝一切未明确允许的工具调用
  permissionMode: 'dontAsk',
  disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'],

  // 第四层：运行时路径校验
  canUseTool: async (toolName, input) => {
    if (toolName === 'Read') {
      const resolved = path.resolve(projectDir, input.file_path);
      if (!resolved.startsWith(projectDir)) {
        return { behavior: 'deny', message: 'Outside project directory' };
      }
    }
    return { behavior: 'allow' };
  },

  // 不传入任何 MCP server
  // cwd 设为好友项目目录
};
```

Claude Code 自己的内置 skill 就用这种模式（debug skill 的 `allowedTools: ["Read", "Grep", "Glob"]`）。

### Context Assembler——改动极小

已支持 `entryPoint: 'desktop' | 'bridge'` 条件注入。新增 `'friend_channel'` 只需跳过 widget/dashboard/CLI tools 层，保留 workspace prompt + session prompt。

### Workspace Retrieval——直接复用

`searchWorkspace(dir, query)` 是无副作用的纯函数，好友项目检索直接调用。

### 官方好友 "CodePilot"

- 每个用户安装后自动添加
- 好友项目 = CodePilot 官方文档 + Release Notes + FAQ
- Agent 人格 = 产品客服/向导
- 文档可以远程更新（CDN 拉取最新版）
- 也可以用来推送产品更新通知

## 通信层——待解决的核心问题

> **状态：搁置。** 功能价值和 Agent 沙箱可行性均已验证，但通信层没有找到同时满足"零成本 + 零服务器 + 跨平台 + 对中国用户友好"的方案。等 Bridge 能力更成熟或有新思路后再推进。

### 为什么这个问题难

| 要求 | 约束 |
|------|------|
| 开源产品，不应依赖官方中心服务 | 排除 Supabase / Firebase / 自建中转 |
| 零运营成本 | 排除 VPS / 云服务 |
| 中国用户网络环境差 | 排除 P2P 直连 / WebRTC / Tailscale |
| 不增加用户配置负担 | 排除手动输入 IP / 装 VPN |

### 评估过的方案

| 方案 | 为什么不行 |
|------|-----------|
| **中心化消息服务**（Supabase / Cloudflare Workers） | 有持续运营成本，不符合开源产品定位 |
| **P2P 直连**（WebRTC / 本地 HTTP server） | NAT 穿透不可靠，中国网络环境尤其差 |
| **Tailscale / ZeroTier 组网** | 需要用户额外安装和配置，门槛高 |
| **Bridge IM 群组中继** | 最接近可行，但平台支持不一致——微信不支持群组 Bot，飞书/Telegram/Discord 可以，覆盖面有限 |

### Bridge 群组中继（部分可行）

如果两个用户恰好用同一个支持群组 Bot 的 IM 平台，可以通过建群实现：

| 平台 | 群组 Bot 支持 | 覆盖人群 |
|------|-------------|---------|
| 飞书 | ✅ | 国内科技公司 |
| Telegram | ✅ | 海外开发者 |
| Discord | ✅ | 海外开发者 |
| QQ | ✅ | 国内年轻用户 |
| 微信 | ❌ 不支持 | — |

这不是通用解决方案，但可以作为第一批用户的早期验证路径。

### 可能的未来方向

- MCP 2026 路线图明确将 agent communication 列为优先方向，也许会出现标准化的 Agent 间通信协议
- Google A2A 协议在演进，可能提供去中心化的 Agent 发现和通信机制
- Coral Protocol（基于 MCP 的 A2A 开源实现）值得持续关注
- 如果 CodePilot 未来有用户账号体系（比如官网 + 同步功能），可以顺带解决消息路由

## 核心价值（不受通信层阻塞）

通信层待定，但这个功能的核心价值已经明确：

**不同用户的 Agent 因为配置差异产生真正的多样性：**
- 不同的 MCP（A 有 github，B 有 linear）→ 不同的信息来源
- 不同的 Skills → 不同的专长
- 不同的 Soul → 不同的性格和表达风格
- 不同的 Model（Opus vs Gemini vs DeepSeek）→ 不同的推理风格

这是 Sub Agent / Agent Teams 做不到的——它们共享同一套配置，天然同质化。

## 竞品空白

没有产品做到"带人格的 Agent + 项目文档共享 + 只读沙箱"这个组合：
- ChatGPT Group Chat：多人+AI，但没有 Agent 身份概念
- Character.AI：多角色群聊，但不能接入个人项目/文档
- GitHub Copilot Workspaces：共享工作区，但没有 Agent 人格
- Discord AI 机器人：共享频道，但各自独立，不能互读对方上下文

## 开放问题

- **通信层**：核心阻塞点，待找到合适方案
- Agent 调用成本：每个 Agent 消耗各自用户的 API token（本地执行，自然隔离）
- 项目文档：不同步，Agent 始终本地读取，只把回答发到频道
- Prompt injection：工具层隔离可靠（三层防御），信息泄露需文件排除列表 + 输出过滤缓解
