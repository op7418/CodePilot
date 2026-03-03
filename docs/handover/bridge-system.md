# 多 IM 远程会话桥接系统

## 核心思路

让用户通过 Telegram（后续可扩展 Discord/飞书等）远程操控 CodePilot 中的 Claude 会话。复用现有 `streamClaude()` 管线，在服务端消费 SSE 流，而非通过浏览器。

## 目录结构

```
src/lib/bridge/
├── types.ts                 # 共享类型（ChannelBinding, BridgeStatus, InboundMessage 等）
├── channel-adapter.ts       # 抽象基类 + adapter 注册表（registerAdapterFactory/createAdapter）
├── channel-router.ts        # (channel, user, thread) → session 映射，自动创建/绑定会话
├── conversation-engine.ts   # 服务端消费 streamClaude() SSE 流，保存消息到 DB
├── permission-broker.ts     # 权限请求转发到 IM 内联按钮，处理回调审批
├── delivery-layer.ts        # 出站消息分片、限流、重试退避、HTML 降级
├── bridge-manager.ts        # 生命周期编排，adapter 事件循环，/stop abort，命令路由
├── markdown/
│   ├── ir.ts                # Markdown → IR 中间表示解析器（基于 markdown-it）
│   ├── render.ts            # IR → 格式化输出的通用标记渲染器
│   └── telegram.ts          # Telegram HTML 渲染 + 文件引用保护 + render-first 分片
├── adapters/
│   ├── index.ts             # Adapter 目录文件（side-effect import 自注册所有 adapter）
│   ├── telegram-adapter.ts  # Telegram 长轮询 + offset 安全水位 + 图片/相册处理 + 自注册
│   ├── telegram-media.ts    # Telegram 图片下载、尺寸选择、base64 转换
│   └── telegram-utils.ts    # callTelegramApi / escapeHtml / splitMessage
└── security/
    ├── rate-limiter.ts      # 按 chat 滑动窗口限流（20 条/分钟）
    └── validators.ts        # 路径/SessionID/危险输入校验
```

## 数据流

```
Telegram 消息 → TelegramAdapter.pollLoop()
  → 纯文本/caption → enqueue()
  → 单图 → telegram-media.downloadPhoto() → base64 FileAttachment → enqueue(msg + attachments)
  → 相册(media_group_id) → bufferMediaGroup() → 500ms 防抖 → flushMediaGroup() 批量下载 → enqueue()
  → BridgeManager.runAdapterLoop() → handleMessage()
    → 命令? → handleCommand() 处理 /new /bind /cwd /mode /stop 等
    → 普通消息/图片? → ChannelRouter.resolve() 获取 ChannelBinding
      → ConversationEngine.processMessage(binding, text, ..., files?)
        → 有图片时：写入 .codepilot-uploads/ + <!--files:JSON-->text 格式存 DB（桌面 UI 可渲染）
        → streamClaude({ prompt, files }) → Claude vision API
        → consumeStream() 服务端消费
          → permission_request → 立即回调 → PermissionBroker 转发到 IM
          → text/tool_use/tool_result → 累积内容块
          → result → 捕获 tokenUsage + sdkSessionId
        → addMessage() 保存到 DB
      → markdownToTelegramChunks() → Markdown→IR→HTML render-first 分片
      → DeliveryLayer.deliverRendered() → 限流 + HTML/plain 双通道发送到 Telegram
    → finally: adapter.acknowledgeUpdate(updateId) → 推进 committedOffset 并持久化
```

## DB 表（在 db.ts migrateDb 中）

| 表 | 用途 |
|---|------|
| channel_bindings | IM 地址 → CodePilot session 映射 |
| channel_offsets | 轮询 offset 持久化（key 为 bot user ID，通过 getMe API 获取） |
| channel_dedupe | 出站消息幂等去重 |
| channel_outbound_refs | 平台消息 ID 映射 |
| channel_audit_logs | 审计日志 |
| channel_permission_links | 权限请求 → IM 消息映射（含 resolved 标记） |

## 关键设计决策

**1. 权限请求死锁解决**
SSE 流在 `permission_request` 事件处会阻塞等待审批。`consumeStream()` 通过 `onPermissionRequest` 回调在流消费过程中立即转发到 IM，而非等流结束后再转发。

**2. Offset 安全水位**
分离 `fetchOffset`（用于 getUpdates API）和 `committedOffset`（持久化到 DB）。消息入队时仅推进 fetchOffset，只有在 bridge-manager 完整处理完消息后（handleMessage 的 finally 块），才调用 `adapter.acknowledgeUpdate(updateId)` 推进 committedOffset 并持久化到 DB。`markUpdateProcessed()` 使用连续水位推进（contiguous walk）：仅当 `recentUpdateIds` 中存在当前 committedOffset 时才前进，避免跳过仍在 media group buffer 中的相册更新 ID。相册 flush 时预注册所有 buffered ID 到 recentUpdateIds，保证 ack 时水位能连续推过。内存 dedup set 防止重启后重复处理。

**2a. Bot 身份标识**
Offset 的 DB key 使用 Telegram `getMe` API 返回的 bot user ID（如 `telegram:bot123456`），而非 token hash。好处是 token 轮换后 offset 不丢失。首次迁移时自动将旧 token-hash key 的值复制到新 bot-ID key。

**3. 并发模型**
`processWithSessionLock()` 实现同会话串行、跨会话并行。不同用户的消息不互相阻塞。

**4. Adapter 注册式架构**
新 IM 只需实现 `BaseChannelAdapter` 并调用 `registerAdapterFactory()` 自注册，然后在 `adapters/index.ts` 中添加一行 side-effect import。bridge-manager 通过 `import './adapters'` 加载目录，registry 自动发现所有已注册的 adapter，无硬编码依赖。

**5. 权限回调安全**
PermissionBroker 在处理 IM 内联按钮回调时，验证 callbackData 中的 chatId 和 messageId 与存储的 permission_link 记录匹配，防止跨聊天伪造审批。`markPermissionLinkResolved()` 使用 `AND resolved = 0` 原子条件更新，确保同一权限请求不被重复审批。

**6. 输入校验**
`security/validators.ts` 对所有 IM 入站命令参数做校验：工作目录路径（拒绝 `..`、null 字节、shell 元字符）、session ID（hex/UUID 格式）、危险输入检测（命令注入、管道符）。`sanitizeInput()` 剥离控制字符并限制 32K 长度。

**7. runAdapterLoop 必须在 state.running = true 之后启动**
`runAdapterLoop` 内部是 fire-and-forget 的 async IIFE，循环条件 `while (state.running && ...)` 在第一个 `await` 之前同步求值。如果调用时 `state.running` 还是 `false`，循环直接跳过，消费者永远不会启动，消息入队后无人消费。`start()` 中必须先设 `state.running = true`，再调用 `runAdapterLoop`。

**8. 出站限流**
`security/rate-limiter.ts` 按 chatId 滑动窗口限流（默认 20 条/分钟）。`DeliveryLayer` 在每次发送前调用 `rateLimiter.acquire(chatId)` 阻塞等待配额，分片间额外加 300ms 节流。错误分类：429 尊重 `retry_after`、5xx 指数退避、4xx 不重试、解析错误降级纯文本。

**9. Telegram 图片接收**
复用已有 `streamClaude({ files })` vision 管道，不引入 sharp 等 native 依赖。`telegram-media.ts` 负责图片下载：`selectOptimalPhoto()` 从 Telegram 的 photo[] 多尺寸数组中选最小且长边 ≥ 1568px（Claude vision 最优值）的版本；`downloadFileById()` 含 3 次重试 + 指数退避 + 双重大小校验。统一返回 `MediaDownloadResult { attachment, rejected, rejectedMessage }`，拒绝时直接发 Telegram 通知，禁止静默丢弃。相册消息通过 500ms 防抖合并（`media_group_id` → `mediaGroupBuffers` Map）。`InboundMessage.attachments` 透传到 `conversation-engine` 和 `streamClaude`。

**10. 图片消息 DB 格式统一**
Bridge 和桌面端使用相同的消息存储格式：图片写入 `.codepilot-uploads/`，消息 content 以 `<!--files:[{id,name,type,size,filePath}]-->text` 格式保存。桌面 UI 的 `MessageItem.parseMessageFiles()` 解析后通过 `FileAttachmentDisplay` + `/api/uploads?path=` 渲染缩略图。`conversation-engine.ts` 中 `getSession()` 提前到文件持久化之前调用，确保 workingDirectory 可用。

**11. Telegram 出站 Markdown 渲染**
Claude 的回复是 Markdown 格式，Telegram 仅支持有限 HTML 标签（b/i/s/code/pre+code/blockquote/a）。采用三层架构将 Markdown 转换为 Telegram HTML：

- **IR 层**（`markdown/ir.ts`）：使用 markdown-it 将 Markdown 解析为中间表示 `MarkdownIR = { text, styles[], links[] }`。text 是纯文本，styles 是 `{ start, end, style }` 区间标记。支持 bold/italic/strikethrough/code/code_block/blockquote/links/lists/headings/tables/hr。表格使用 code-block 模式渲染为 ASCII 表格（包裹在 `<pre><code>` 中保留对齐）。HTML 内联标签中的 `<br>` 被转换为换行符。
- **渲染层**（`markdown/render.ts`）：通用标记渲染器 `renderMarkdownWithMarkers(ir, options)`，接受样式→标签映射表 + escapeText + buildLink 回调，输出格式化文本。使用 boundary tracking + LIFO stack 处理嵌套。
- **Telegram 层**（`markdown/telegram.ts`）：组合 IR+渲染器，映射样式到 Telegram HTML 标签。`wrapFileReferencesInHtml()` 防止 `README.md`、`main.go` 等文件名被 Telegram linkify 误识别为 URL（用 `<code>` 包裹）。`markdownToTelegramChunks(text, limit)` 实现 render-first 分片：先按 IR text 长度分块，再渲染每块为 HTML，若 HTML 超出 4096 限制则按比例重新分割。

`bridge-manager.ts` 对 Claude 回复调用 `markdownToTelegramChunks()`，通过 `deliverRendered()` 发送预渲染 chunks（每个 chunk 包含 html + text 双通道，HTML 解析失败自动降级纯文本）。命令响应和错误消息仍使用 `escapeHtml()` + `deliver()`。

## 设置项（settings 表）

| Key | 说明 |
|-----|------|
| remote_bridge_enabled | 总开关 |
| bridge_telegram_enabled | Telegram 通道开关 |
| bridge_auto_start | 服务启动时自动拉起桥接 |
| bridge_default_work_dir | 新建会话默认工作目录 |
| bridge_default_model | 新建会话默认模型 |
| bridge_default_provider_id | 新建会话默认服务商 |
| telegram_bridge_allowed_users | 白名单用户 ID（逗号分隔） |
| bridge_telegram_image_enabled | Telegram 图片接收开关（默认 true，设为 false 关闭） |
| bridge_telegram_max_image_size | 图片大小上限（字节，默认 20MB） |

## API 路由

| 路由 | 方法 | 功能 |
|------|------|------|
| /api/bridge | GET | 返回 BridgeStatus（纯查询，无副作用） |
| /api/bridge | POST | `{ action: 'start' \| 'stop' \| 'auto-start' }` |
| /api/bridge/channels | GET | 列出活跃通道（支持 `?active=true/false` 过滤） |
| /api/bridge/settings | GET/PUT | 读写 bridge 设置 |

## Telegram 命令

| 命令 | 功能 |
|------|------|
| /new [path] | 新建会话 |
| /bind \<session_id\> | 绑定已有会话 |
| /cwd /path | 切换工作目录 |
| /mode plan\|code\|ask | 切换模式 |
| /status | 当前状态 |
| /sessions | 列出会话 |
| /stop | 中止运行中任务 |
| /help | 帮助 |

## 相关文件（bridge 之外）

- `src/lib/telegram-bot.ts` — 通知模式（UI 发起会话的通知），与 bridge 模式互斥
- `src/lib/permission-registry.ts` — 权限 Promise 注册表，bridge 和 UI 共用
- `src/lib/claude-client.ts` — streamClaude()，bridge 和 UI 共用
- `src/components/bridge/BridgeSection.tsx` — Bridge 设置 UI（一级导航 /bridge）
- `src/components/bridge/TelegramBridgeSection.tsx` — Telegram 凭据 + 白名单设置 UI（/bridge#telegram）
- `electron/main.ts` — 窗口关闭时 bridge 活跃则保持后台运行；启动时通过 POST `auto-start` 触发桥接恢复
- `src/app/api/settings/telegram/verify/route.ts` — 支持 `register_commands` action 注册 Telegram 命令菜单
