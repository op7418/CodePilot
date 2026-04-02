# 多 IM 远程会话桥接系统

## 核心思路

让用户通过 Telegram、Discord、飞书、微信等 IM 通道远程操控 CodePilot 中的 Claude 会话。Bridge 复用现有 `streamClaude()` 管线，在服务端直接消费 SSE 流，而不是依赖浏览器标签页。

## 目录结构

```
src/lib/bridge/
├── types.ts                 # 共享类型（ChannelBinding, BridgeStatus, InboundMessage 等）
├── channel-adapter.ts       # 抽象基类 + adapter 注册表（registerAdapterFactory/createAdapter）
├── channel-router.ts        # (channel, user, thread) → session 映射，自动创建/绑定会话
├── conversation-engine.ts   # 服务端消费 streamClaude() SSE 流，保存消息到 DB，onPartialText 流式回调
├── permission-broker.ts     # 权限请求转发到 IM 内联按钮，处理回调审批
├── delivery-layer.ts        # 出站消息分片、限流、重试退避、HTML 降级
├── bridge-manager.ts        # 生命周期编排，adapter 事件循环，流式预览状态机，deliverResponse 渲染分发
├── markdown/
│   ├── ir.ts                # Markdown → IR 中间表示解析器（基于 markdown-it）
│   ├── render.ts            # IR → 格式化输出的通用标记渲染器
│   └── telegram.ts          # Telegram HTML 渲染 + 文件引用保护 + render-first 分片
├── adapters/
│   ├── index.ts             # Adapter 目录文件（side-effect import 自注册所有 adapter）
│   ├── telegram-adapter.ts  # Telegram 长轮询 + offset 安全水位 + 图片/相册处理 + 自注册
│   ├── telegram-media.ts    # Telegram 图片下载、尺寸选择、base64 转换
│   ├── telegram-utils.ts    # callTelegramApi / sendMessageDraft / escapeHtml / splitMessage
│   ├── weixin-adapter.ts    # 微信多账号长轮询 + batch ack + 纯文本出站 + 自注册
│   ├── weixin/
│   │   ├── weixin-api.ts    # 微信 ilink 协议客户端（getupdates/sendmessage/sendtyping/getconfig）
│   │   ├── weixin-auth.ts   # 二维码登录 + HMR 安全会话存储
│   │   ├── weixin-media.ts  # AES-128-ECB 媒体解密/上传
│   │   ├── weixin-ids.ts    # synthetic chatId 编解码（weixin::<accountId>::<peerUserId>）
│   │   └── weixin-session-guard.ts # errcode -14 暂停保护
│   ├── feishu-adapter.ts    # 薄代理 → ChannelPluginAdapter(FeishuChannelPlugin)
│   └── discord-adapter.ts   # Discord.js Client + Gateway intents + 按钮交互 + 流式预览 + 自注册
├── markdown/
│   └── discord.ts           # Discord 消息分片（2000 字符限制）+ 代码围栏平衡
└── security/
    ├── rate-limiter.ts      # 按 chat 滑动窗口限流（20 条/分钟）
    └── validators.ts        # 路径/SessionID/危险输入校验

src/lib/channels/
├── types.ts                 # ChannelPlugin / ChannelCapabilities / CardStreamController / ToolCallInfo 接口
├── channel-plugin-adapter.ts # ChannelPlugin → BaseChannelAdapter 桥接
└── feishu/
    ├── index.ts             # FeishuChannelPlugin 组合入口
    ├── types.ts             # FeishuConfig / CardStreamConfig / FeishuBotInfo 等内部类型
    ├── config.ts            # 从 settings DB 加载配置 + 校验
    ├── gateway.ts           # WSClient 生命周期 + card.action.trigger monkey-patch + 超时保护
    ├── inbound.ts           # 入站消息解析 + 内容提取 + 资源下载
    ├── outbound.ts          # 出站消息渲染（post md / interactive card / reaction）+ Markdown 优化
    ├── policy.ts            # 用户授权 + DM/群聊策略
    ├── identity.ts          # Bot 身份解析 + @mention 检测
    └── card-controller.ts   # CardKit v2 流式卡片（create/update/finalize/thinking/toolCalls）
```

## 数据流

### 飞书（V2 — ChannelPlugin 架构 + 流式卡片）

```
飞书消息 → WSClient(WebSocket) → EventDispatcher
  → im.message.receive_v1 → FeishuGateway → messageHandler()
    → parseInboundMessage() → 去重(message_id) → 授权检查(policy.ts) → 群策略过滤 → @提及检查
    → text/image/post → enqueue()
  → card.action.trigger → FeishuGateway.safeCardActionHandler() (2.5s 超时保护)
    → FeishuChannelPlugin.cardActionHandler()
      → callback_data (perm:allow/deny) → enqueue(callbackMsg)
      → callback_data (cwd:/path) → enqueue(callbackMsg)
      → action/operation_id → enqueue(syntheticCallback)
      → 返回 toast 给飞书客户端
  → BridgeManager.runAdapterLoop() → handleMessage()
    → 普通消息 → processMessage():
      → CardStreamController.create() 创建流式卡片
      → consumeStream() 服务端消费 SSE:
        → text → onPartialText → CardStreamController.update() 流式推送
        → tool_use/tool_result → onToolEvent → cardToolCalls 追踪 → updateToolCalls() 渲染 🔄/✅/❌
        → permission_request → PermissionBroker 转发 → 内联按钮卡片(Schema V2 column_set)
      → CardStreamController.finalize() 最终渲染 + 页脚(状态+耗时)
    → 回调消息 → handlePermissionCallback() / handleCwdCallback()
    → 命令 → handleCommand():
      → /cwd 无参 → 项目选择器卡片(内联按钮, turquoise header)
      → /new → 继承当前 binding 的 workingDirectory
```

**飞书 V2 关键变化（相比初版 adapter）：**
- **ChannelPlugin 架构**：`FeishuChannelPlugin` 实现 `ChannelPlugin<FeishuConfig>` 接口，通过 `ChannelPluginAdapter` 桥接为 `BaseChannelAdapter`，bridge-manager 无感知
- **流式卡片**：使用 CardKit v2 API（`cardkit.v2.card.create/streamContent/setStreamingMode/update`），替代旧的 card/post 分流渲染
- **WSClient 卡片回调**：通过 monkey-patch `handleEventData()` 将 `type:"card"` 重写为 `type:"event"`，使 SDK 的 EventDispatcher 能处理卡片交互事件
- **配置简化**：移除 encryptKey/verificationToken（WSClient 不需要）、renderMode/blockStreaming（流式始终开启）、footer 开关（始终显示）
- **卡片创建竞态保护**：`cardCreatePromise` 确保 finalize 路径不会在 create 完成前执行

### Discord

```
Discord 消息 → discord.js Client (Gateway WebSocket)
  → messageCreate → processMessage()
    → bot/self 过滤 → 去重(messageId Set 1000) → 授权检查(user+channel)
    → guild 策略过滤(allowed_guilds + group_policy) → @提及检查
    → !command → /command 规范化
    → 图片附件 → fetch(url) → base64 FileAttachment
    → enqueue()
  → interactionCreate → handleInteraction()
    → deferUpdate() (3s Discord 超时) → 存储 Interaction(60s TTL) → enqueue(callbackData)
  → BridgeManager.runAdapterLoop() → handleMessage()
    → deliverResponse():
      → markdownToDiscordChunks(2000 字符, 代码围栏平衡) → 逐块发送
    → 权限请求 → ActionRowBuilder + ButtonBuilder 组件
    → 流式预览 → channel.send() 首次 / message.edit() 后续 / delete 结束
    → typing → channel.sendTyping() 每 8s
```

**Discord 关键设计决策：**
- **原生 Markdown**：Discord 原生支持 Markdown，无需 IR→HTML 转换（不同于 Telegram）
- **保守流式默认值**：Discord 编辑限速 5/5s/channel，默认 interval 1500ms, minDelta 40 chars
- **按钮交互**：deferUpdate() 立即响应（3s Discord 超时），存储 Interaction 对象供 answerCallback 使用，60s TTL 清理
- **授权默认拒绝**：空白允许列表 = 拒绝所有（安全优先，同飞书模式）
- **`!` 命令别名**：在 adapter 层规范化为 `/` 命令后入队——bridge-manager 命令处理器无需改动

### 微信（Native BaseChannelAdapter + 多账号长轮询）

```
微信消息 → WeixinAdapter.runPollLoop(account)
  → getupdates(long-poll, get_updates_buf)
  → context_token 落库(weixin_context_tokens)
  → 媒体解密(AES-128-ECB，可按设置关闭)
  → synthetic chatId = weixin::<accountId>::<peerUserId>
  → enqueue(InboundMessage, updateId=batchId)
  → BridgeManager.runAdapterLoop() → handleMessage()
    → channel-router.resolve() 自愈坏 cwd / stale sdkSessionId
    → conversation-engine.processMessage() 用有效 cwd 调 streamClaude()
    → permission_request → `/perm allow|allow_session|deny <id>` 文本降级
    → deliverResponse() 纯文本分片(4096 chars, 最多 5 段)
      → sendmessage({ msg, base_info })
  → handleMessage() finally
    → adapter.acknowledgeUpdate(batchId)
    → batch sealed + remaining=0
    → channel_offsets["weixin:<accountId>"] = get_updates_buf
```

**关键文件**
- `src/lib/bridge/adapters/weixin-adapter.ts`：微信主 adapter。每个启用账号一个 poll worker，负责入站标准化、batch ack、typing、纯文本出站。
- `src/lib/bridge/adapters/weixin/weixin-api.ts`：协议客户端。对齐 OpenClaw 微信插件协议，但不把其 npm 包作为运行时依赖。
- `src/lib/bridge/adapters/weixin/weixin-auth.ts`：二维码登录，使用 `globalThis` 保存活跃登录会话以穿过 Next.js HMR。
- `src/lib/bridge/adapters/weixin/weixin-media.ts`：微信 CDN 媒体下载/上传的 AES-128-ECB 加解密。
- `src/lib/bridge/adapters/weixin/weixin-ids.ts`：`weixin::<accountId>::<peerUserId>` synthetic chatId 编解码。
- `src/lib/bridge/adapters/weixin/weixin-session-guard.ts`：`errcode = -14` 会话失效时暂停账号 60 分钟，避免无限重试。

**为什么用 synthetic chatId**
- 微信 bridge 需要多账号并存，但 `channel_bindings` 表没有单独的 account 维度。
- 方案是把账号隔离编码进 chatId：`weixin::<accountId>::<peerUserId>`。
- 这样 `channel-router`、`permission-broker`、`delivery-layer` 和审计日志都可以继续复用原来的单 chat 抽象，不需要额外改 schema。

**数据持久化**
- `weixin_accounts`：账号凭据、bot token、base URL、启用状态、最后登录时间。
- `weixin_context_tokens`：按 `(account_id, peer_user_id)` 持久化 `context_token`。这是微信主动回消息的硬前置条件，不能只放内存。
- `channel_offsets`：使用 key `weixin:<accountId>` 保存每个账号各自的 `get_updates_buf`。

**二维码登录与运行时刷新**
- `/api/settings/weixin/login/start` 生成二维码；服务端读取微信返回的 `qrcode_img_content` URL，再用 `qrcode` 渲染为 data URL，前端无需额外跳转或依赖外链图片。
- `/api/settings/weixin/login/wait` 轮询扫码状态。状态变成 `confirmed` 后，账号会落库到 `weixin_accounts`，并在 bridge 正在运行时自动调用 `bridge-manager.restart()`，让新账号立即加入 worker 池。
- 账号启用/停用/删除也会走同样的 restart 流程；如果 DB 改动成功但 runtime 重启失败，API 会显式返回错误，前端 toast 告知“已保存但运行态未切换”。

**出站协议与成功判定**
- `sendmessage` 请求体必须是 `{ msg, base_info }`，其中 `msg` 包含 `to_user_id`、`client_id`、`message_type`、`message_state`、`item_list`、`context_token`。
- 不能依赖服务端返回 `message_id` 判成功。当前实现本地生成 `client_id`，HTTP 成功即视为投递成功，并把 `client_id` 作为 bridge 层的 `messageId`。
- 微信只支持纯文本出站，所以 `bridge-manager.deliverResponse()` 会先做纯文本分片。Markdown / HTML 不走专门渲染器。

**cursor / ack 语义**
- 微信 worker 读到 `get_updates_buf` 后不会立即写库，而是先给本批消息分配 `batchId`。
- 每条消息处理完成后，`bridge-manager.handleMessage()` 在 `finally` 中调用 `adapter.acknowledgeUpdate(batchId)`。
- 只有当该 batch 被 `sealed` 且 `remaining = 0` 时，才真正把 cursor 提交到 `channel_offsets`。
- 这样即使 Claude 处理、权限审批或微信出站在中途失败，也不会把上游 cursor 提前推进，避免静默丢消息。

**cwd 自愈与 resume 清理**
- 微信实现过程中补齐了 bridge 的 cwd 自愈链：`session.sdk_cwd` → `binding.workingDirectory` → `session.working_directory` → `bridge_default_work_dir` → `HOME/process cwd`。
- `channel-router.resolve()` 会在每次消息到来时校验目录是否存在，并在回退到默认目录/Home 时清空 binding/session 上的 `sdk_session_id`，避免拿坏会话强行 resume。
- `conversation-engine` 与 `claude-client` 也会再做一层防线：如果 cwd 已回退，不再尝试 resume 旧 Claude session。

**typing / 媒体 / 权限**
- typing 是 best-effort：先用 `getconfig(ilink_user_id, context_token)` 取 `typing_ticket`，再调用 `sendtyping`。失败不影响主流程。
- 入站媒体可按 `bridge_weixin_media_enabled` 开关控制。开启时会把图片/文件/视频/语音下载、解密并转换成 `FileAttachment`，复用现有 vision / 文件上下文管线。
- 微信没有按钮和消息编辑能力，权限审批统一降级为文本命令：`/perm allow|allow_session|deny <permission_request_id>`。

**当前限制**
- 仅支持私聊，不支持群聊语义。
- 不支持流式预览；微信端无法像 Telegram/飞书那样持续编辑同一条消息。
- 当前版本只做文本出站，AI 主动发图/发文件尚未接通。
- 真实扫码联调依赖具备 ilink bot 权限的微信账号。

### Telegram

```
Telegram 消息 → TelegramAdapter.pollLoop()
  → 纯文本/caption → enqueue()
  → 单图 → telegram-media.downloadPhoto() → base64 FileAttachment → enqueue(msg + attachments)
  → 相册(media_group_id) → bufferMediaGroup() → 500ms 防抖 → flushMediaGroup() 批量下载 → enqueue()
  → BridgeManager.runAdapterLoop() → handleMessage()
    → 命令? → handleCommand() 处理 /new /bind /cwd /mode /stop 等
    → 普通消息/图片? → ChannelRouter.resolve() 获取 ChannelBinding
      → ConversationEngine.processMessage(binding, text, ..., files?, onPartialText?)
        → 有图片时：写入 .codepilot-uploads/ + <!--files:JSON-->text 格式存 DB（桌面 UI 可渲染）
        → streamClaude({ prompt, files }) → Claude vision API
        → consumeStream() 服务端消费
          → permission_request → 立即回调 → PermissionBroker 转发到 IM
          → text → 累积 currentText + previewText → onPartialText(previewText) 回调
          → tool_use/tool_result → 累积内容块（currentText 清零，previewText 不清零）
          → result → 捕获 tokenUsage + sdkSessionId
        → addMessage() 保存到 DB
      → deliverResponse() 按 channelType 分发渲染:
        → Telegram: markdownToTelegramChunks() → deliverRendered() → 限流 + HTML/plain 双通道
        → 其他 IM: deliver() → 纯文本分块发送
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

`bridge-manager.ts` 通过 `deliverResponse()` 按 `adapter.channelType` 分发渲染：Telegram 走 `markdownToTelegramChunks()` + `deliverRendered()`（HTML/plain 双通道），其他 IM 走 `deliver()` 纯文本。`deliverRendered()` 在分块部分失败时继续投递剩余 chunk 并追发截断提示，最终返回 `ok: false` 标识不完整投递。命令响应和错误消息仍使用 `escapeHtml()` + `deliver()`。

**12. Telegram 流式预览（sendMessageDraft）**
利用 Telegram Bot API 9.5 的 `sendMessageDraft` 方法，在 Claude 生成过程中以草稿形式实时展示文本预览。架构上抽象为通道级可选能力（`BaseChannelAdapter` 的 `getPreviewCapabilities`/`sendPreview`/`endPreview` 三个可选方法），未实现这些方法的 adapter 自动跳过。

- **引擎层**：`consumeStream()` 维护独立的 `previewText` 变量（只累积、不因 `tool_use` 清零），通过 `onPartialText` 回调同步传递完整预览文本。
- **编排层**：`bridge-manager.handleMessage()` 检查 adapter 能力 → 分配 `draftId` → 构建节流闭包（间隔 700ms + 最小增量 20 字符 + trailing-edge timer）→ `flushPreview()` fire-and-forget 发送 → finally 清理 timer + `endPreview()`。
- **降级**：`sendPreview` 返回 `'sent'|'skip'|'degrade'` 三态。400/404（API 不支持）→ 永久降级该 chatId；429/网络错误 → 仅跳过本次。`previewDegraded` Set 在 adapter `stop()` 时清空。
- **线程安全**：`processWithSessionLock` 保证同 session 串行 → 同时刻只有一个 `previewState`。多个 in-flight `sendMessageDraft` 安全：Telegram 对同 `draft_id` last-write-wins。

**13. 飞书 ChannelPlugin 架构**
飞书从原 `BaseChannelAdapter` 子类迁移为 `ChannelPlugin<FeishuConfig>` 实现。`src/lib/channels/feishu/` 拆分为独立模块：`gateway.ts`（WSClient 生命周期）、`inbound.ts`（消息解析）、`outbound.ts`（消息发送 + Markdown 优化）、`policy.ts`（授权策略）、`card-controller.ts`（流式卡片）、`config.ts`（配置加载）。通过 `ChannelPluginAdapter` 桥接为 `BaseChannelAdapter`，bridge-manager 无需修改。WSClient 由 SDK 管理重连，消息去重使用内存 LRU。

**14. 飞书流式卡片渲染**
所有 Claude 回复通过 CardKit v2 流式卡片输出（替代旧的 card/post 分流）。流程：`cardController.create()` 创建卡片 → `update()` 节流推送文本（200ms）→ `finalize()` 停止流式 + 渲染最终内容 + 页脚。卡片支持：
- **Thinking 状态**：文本到达前显示 `💭 Thinking...`
- **Tool 进度**：`🔄 Running` / `✅ Complete` / `❌ Error` 实时显示
- **Markdown 优化**：标题降级（H1→H4, H2-6→H5）、表格间距、代码块填充、无效图片 key 剥离
- **页脚**：状态 emoji（✅/⚠️/❌）+ 耗时，始终显示

非卡片消息（命令响应等）使用 `post` 格式 + `md` tag。注意：post md tag 不支持 HTML `<br>`（会渲染为字面文本），必须用空行 `\n\n` 代替。

**15. 飞书权限交互 — Schema V2 内联按钮**
通过 monkey-patch WSClient 的 `handleEventData()` 方法，将 `type:"card"` 事件重写为 `type:"event"`，使 SDK 的 EventDispatcher 能接收 `card.action.trigger` 回调。这解决了之前的 200340 错误（无 webhook 端点）。Schema V2 卡片不支持 `action` tag（错误码 200861），按钮使用 `column_set` + `column` + `button` 布局。按钮 value 中嵌入 `chatId` 作为兜底（WSClient 回调的 context 字段可能缺失）。Gateway 层提供 2.5s 超时保护，确保 3s 内必定返回 toast 响应。

**16. 飞书 Typing 指示器 — Emoji Reaction**
`FeishuChannelPlugin.onMessageStart()` 在用户消息上添加 "Typing" emoji reaction（`im.messageReaction.create`），`onMessageEnd()` 删除。`lastMessageIdByChat` Map 追踪每个 chat 的最新消息 ID，`activeReactions` Map 追踪活跃 reaction ID。非关键路径，fire-and-forget。

**17. 飞书 @提及检测**
`inbound.ts` 解析 `event.message.mentions` 数组检测 bot 是否被 @。bot 身份通过 `identity.ts` 的 `/bot/v3/info/` REST API 获取（`open_id`/`bot_id`）。文本中的 `@_user_N` 占位符由 `stripMentionMarkers()` 清理。

**18. 飞书 Bridge 单操作者模型**
当前飞书 bridge 按「单操作者桌面应用」模型设计。虽然有 dmPolicy/groupPolicy/allowFrom 等多入口访问控制，但所有飞书聊天绑定共享同一操作者身份。`/cwd` 项目选择器展示同一 Feishu 渠道下所有活跃项目目录，作为「最近项目快捷切换」使用，不做 chat-level 隔离。如果未来需要多用户/多租户隔离，`/cwd` picker 应按 userId 或 chatId 进一步收窄数据源。

**19. Telegram 通知模式互斥**
`telegram-bot.ts` 的通知功能（UI 会话通知）与 bridge 模式互斥。通过 `globalThis.__codepilot_bridge_mode_active` 标志协调（存 globalThis 防 HMR 重置）。Bridge 启动时设 `true`，4 个 notify 函数检查此标志后提前返回。

**20. 微信 `context_token` 必须持久化**
微信不是“只靠 chatId 就能主动回消息”的协议。`sendmessage` 依赖最近一次入站消息带来的 `context_token`，所以必须把 `(account_id, peer_user_id) -> context_token` 持久化到 `weixin_context_tokens`。只放内存会在进程重启后导致“能收消息、不能回消息”。

**21. 坏 cwd 不能继续 resume Claude 会话**
Bridge 绑定和 chat session 中可能残留已经删除的 `working_directory` / `sdk_cwd`。一旦用坏目录继续携带旧 `sdk_session_id` 调 `streamClaude()`，Claude 子进程会在错误项目上下文里瞬间退出。当前修复要求在 cwd 回退时同步清空 binding/session 的 `sdk_session_id`，并把修正后的 cwd 回写 DB。

## 设置项（settings 表）

| Key | 说明 |
|-----|------|
| remote_bridge_enabled | 总开关 |
| bridge_telegram_enabled | Telegram 通道开关 |
| bridge_weixin_enabled | 微信通道开关 |
| bridge_weixin_media_enabled | 微信入站媒体下载开关（默认 true；关闭后只收文本） |
| bridge_auto_start | 服务启动时自动拉起桥接 |
| bridge_default_work_dir | 新建会话默认工作目录 |
| bridge_default_model | 新建会话默认模型 |
| bridge_default_provider_id | 新建会话默认服务商（Bridge 系统独立设置，与全局默认模型的 `global_default_model_provider` 分离；Bridge 会话使用此值而非全局默认） |
| telegram_bridge_allowed_users | 白名单用户 ID（逗号分隔） |
| bridge_telegram_image_enabled | Telegram 图片接收开关（默认 true，设为 false 关闭） |
| bridge_telegram_max_image_size | 图片大小上限（字节，默认 20MB） |
| bridge_telegram_stream_enabled | 流式预览总开关（默认启用，设为 `false` 关闭） |
| bridge_telegram_stream_interval_ms | 预览节流间隔（默认 700ms） |
| bridge_telegram_stream_min_delta_chars | 最小增量字符数（默认 20） |
| bridge_telegram_stream_max_chars | 草稿截断阈值（默认 3900） |
| bridge_telegram_stream_private_only | 仅私聊启用预览（默认 true，群聊自动跳过） |
| bridge_feishu_enabled | 飞书通道开关 |
| bridge_feishu_app_id | 飞书应用 App ID |
| bridge_feishu_app_secret | 飞书应用 App Secret（API 返回脱敏） |
| bridge_feishu_domain | 平台域名：`feishu`（默认）或 `lark` |
| bridge_feishu_allow_from | 允许的 open_id（逗号分隔，`*`=不限） |
| bridge_feishu_dm_policy | 私信策略：`open`（默认）/ `pairing` / `allowlist` / `disabled` |
| bridge_feishu_thread_session | 每话题独立上下文（默认 false） |
| bridge_feishu_group_policy | 群消息策略：`open`（默认）/ `allowlist` / `disabled` |
| bridge_feishu_group_allow_from | 群聊白名单 chat_id（逗号分隔） |
| bridge_feishu_require_mention | 群聊需要 @bot 才触发（默认 false） |

## API 路由

| 路由 | 方法 | 功能 |
|------|------|------|
| /api/bridge | GET | 返回 BridgeStatus（纯查询，无副作用） |
| /api/bridge | POST | `{ action: 'start' \| 'stop' \| 'auto-start' }` |
| /api/bridge/channels | GET | 列出活跃通道（支持 `?active=true/false` 过滤） |
| /api/bridge/settings | GET/PUT | 读写 bridge 设置 |
| /api/settings/weixin | GET/PUT | 读写微信全局设置（当前仅开关和媒体选项） |
| /api/settings/weixin/accounts | GET | 列出微信账号（token 脱敏，只返回 `has_token`） |
| /api/settings/weixin/accounts/[accountId] | PATCH/DELETE | 启停或删除微信账号；bridge 运行中会同步 restart |
| /api/settings/weixin/login/start | POST | 创建二维码登录会话并返回二维码图片 |
| /api/settings/weixin/login/wait | POST | 轮询二维码状态；确认后自动尝试重启 bridge |

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
- `src/components/bridge/BridgeSection.tsx` — Bridge 设置 UI（一级导航 /bridge），含 Telegram/微信/飞书通道开关
- `src/components/bridge/BridgeLayout.tsx` — 侧边栏导航（Telegram / 微信 / 飞书 入口）
- `src/components/bridge/TelegramBridgeSection.tsx` — Telegram 凭据 + 白名单设置 UI（/bridge#telegram）
- `src/components/bridge/WeixinBridgeSection.tsx` — 微信设置 UI：账号列表、二维码登录、运行态错误提示（/bridge#weixin）
- `src/components/bridge/FeishuBridgeSection.tsx` — 飞书设置 UI：凭据 + 访问与行为（2 卡片 2 保存按钮 + 脏状态追踪）
- `src/app/api/settings/weixin/route.ts` — 微信全局设置 API（当前仅 `bridge_weixin_enabled` / `bridge_weixin_media_enabled`）
- `src/app/api/settings/weixin/accounts/route.ts` — 微信账号列表 API
- `src/app/api/settings/weixin/accounts/[accountId]/route.ts` — 微信账号启停/删除 API（带 bridge restart 语义）
- `src/app/api/settings/weixin/login/start/route.ts` — 微信二维码登录启动 API
- `src/app/api/settings/weixin/login/wait/route.ts` — 微信二维码状态轮询 API（confirmed 后自动 restart bridge）
- `src/app/api/settings/feishu/route.ts` — 飞书设置读写 API（简化后 10 个 key）
- `src/app/api/settings/feishu/verify/route.ts` — 飞书凭据验证 API（测试 token 获取 + bot info）
- `src/lib/channels/` — V2 ChannelPlugin 架构（见目录结构）
- `electron/main.ts` — 窗口关闭时 bridge 活跃则保持后台运行；启动时通过 POST `auto-start` 触发桥接恢复
- `src/app/api/settings/telegram/verify/route.ts` — 支持 `register_commands` action 注册 Telegram 命令菜单

## V2 演进方向（2026-03）

本文件描述的是当前 Bridge 系统现状。后续方案上，Bridge 不再只被视为“多 IM 会话桥接”，而应逐步演进成更通用的三层结构：

- `Remote Core`
  负责 Host / Controller / Session / Lease、流式事件、审批、结果摘要、多设备控制。
- `Channel Plugin Layer`
  负责 Telegram / Discord / Feishu / QQ 的 pairing、capabilities、status、policy、gateway。
- `Platform Capability Layer`
  负责飞书文档、消息搜索、资源下载、任务、日历等平台深度能力。

这意味着当前 `src/lib/bridge/` 中的很多模块会继续保留，但语义会逐步收敛到“渠道层”：

- `channel-adapter.ts` 将向更完整的 channel contract 演进
- `bridge-manager.ts` 将向 channel runtime / gateway coordinator 演进
- `permission-broker.ts` 将向统一 remote approval broker 演进

在这个目标态下：

- Android App、桌面 Controller 和 IM 渠道都将共享同一套 Remote Core
- 飞书不再只是一个 adapter，而会逐步拆分成独立的渠道模块族
- 当前 Bridge 仍是实现基础，但不再是远程能力的最终抽象边界

### V2 实施状态（codex/feishu-remote-v2）

**已完成：**

1. **Channel Plugin 合约** (`src/lib/channels/types.ts`)
   - `ChannelPlugin<T>` 接口：config/capabilities/lifecycle/inbound/outbound/policy
   - `ChannelCapabilities`：streaming、threadReply、search、history、reactions 能力声明
   - `CardStreamController`：流式卡片接口（create/update/finalize/setThinking/updateToolCalls）
   - `ToolCallInfo`：工具调用进度追踪（id/name/status）

2. **ChannelPluginAdapter** (`src/lib/channels/channel-plugin-adapter.ts`)
   - 将 `ChannelPlugin<T>` 桥接为 `BaseChannelAdapter`
   - 自动代理 `getCardStreamController()`、`onMessageStart/End()` 等
   - bridge-manager 无需修改即可使用新插件

3. **飞书模块拆分** (`src/lib/channels/feishu/`)
   - `types.ts` — FeishuConfig、CardStreamConfig（简化后无 renderMode/blockStreaming/footer 开关）
   - `config.ts` — 从 settings DB 加载配置，cardStreamConfig 始终启用（footer 始终显示）
   - `gateway.ts` — WSClient 生命周期 + card.action.trigger monkey-patch + 2.5s 超时保护
   - `inbound.ts` — 入站消息处理 + 内容解析 + 资源下载
   - `outbound.ts` — 出站渲染（post md + interactive card）+ optimizeMarkdown() + 权限/CWD 卡片
   - `identity.ts` — Bot 身份解析 + @mention 检测
   - `policy.ts` — 用户授权 + DM/群聊策略
   - `card-controller.ts` — CardKit v2 流式卡片（thinking/streaming/tool progress/footer）
   - `index.ts` — FeishuChannelPlugin 组合入口 + Typing reaction 管理

4. **流式卡片 + 工具进度** (`bridge-manager.ts` + `card-controller.ts`)
   - `onPartialText` 回调 → CardStreamController.update() 节流推送
   - `onToolEvent` 回调 → cardToolCalls[] 追踪 → updateToolCalls() 实时渲染
   - Tool-first 回合（无文本直接调工具）：onToolEvent 自动 bootstrap 卡片
   - `cardCreatePromise` 竞态保护：finalize 路径 await 创建完成后再执行

5. **权限内联按钮**
   - Schema V2 `column_set` + `column` + `button` 布局（`action` tag 已废弃 → 200861）
   - 权限卡片：蓝色 header + lock icon + Allow(primary)/Deny(danger) 按钮 + 5 分钟过期提示
   - CWD 选择器卡片：turquoise header + folder icon + 垂直堆叠按钮 + 📍 当前项目高亮
   - 按钮 value 嵌入 chatId 兜底（WSClient 回调 context 可能缺失）

6. **MCP 残留剥离**
   - 移除 `.mcp.json` 中 feishu MCP 入口
   - 移除 `@codepilot/feishu-mcp` workspace 依赖
   - 原 feishu-adapter.ts 改为薄代理（~15 行）

7. **设置 UI 简化** (`FeishuBridgeSection.tsx`)
   - 移除：encryptKey、verificationToken、renderMode、blockStreaming、footer 开关
   - 合并为 2 个卡片：凭据 + 访问与行为
   - 保存按钮脏状态追踪：修改后显示"保存"，保存后显示"已保存"
