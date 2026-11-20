# OpenClaw 微信插件拆包与 CodePilot 逆向集成可行性调研

> 调研时间：2026-03-22
> 调研方式：静态拆包 + 本地架构比对，未做真实微信账号登录联调
> 样本：npm 包 `@tencent-weixin/openclaw-weixin` 及其 CLI 的解包件（已不保留在本仓库）

## 一句话结论

可以集成，但不建议把 `@tencent-weixin/openclaw-weixin` 这个 npm 包直接塞进 CodePilot 运行。

更合适的做法是：把它当成协议说明和参考实现，按 CodePilot 现有 `Bridge` 架构原生实现一个 `weixin` adapter。

原因很简单：

- **协议层可复用度高**：二维码登录、长轮询、发消息、媒体上传下载都写得很清楚。
- **运行时层耦合很深**：真实业务逻辑大量绑定 `openclaw/plugin-sdk`、OpenClaw 的 routing/session/reply runtime、`~/.openclaw` 状态目录和 pairing 文件格式。

## 一、本次拉取到的包

### 1. CLI 包

- 包名：`@tencent-weixin/openclaw-weixin-cli`
- latest：`1.0.2`
- npm registry 时间：`2026-03-21T14:50:38.585Z`
- 体积很小，解包后只有 `cli.mjs`、`package.json`、`LICENSE`

### 2. 真正的渠道包

- 包名：`@tencent-weixin/openclaw-weixin`
- latest：`1.0.2`
- npm registry 时间：`2026-03-21T15:43:24.503Z`
- License：`MIT`
- 发布内容直接带 TypeScript 源码，便于静态分析

## 二、CLI 实际只做了什么

CLI 没有任何微信协议逻辑，只是一个薄安装器，流程只有四步：

1. 检查本机是否存在 `openclaw` CLI
2. 执行 `openclaw plugins install "@tencent-weixin/openclaw-weixin"`
3. 执行 `openclaw channels login --channel openclaw-weixin`
4. 执行 `openclaw gateway restart`

这意味着：

- `npx -y @tencent-weixin/openclaw-weixin-cli install` 本身没有可“嵌入”的核心价值
- 真正值得研究的是 `@tencent-weixin/openclaw-weixin`

## 三、真实插件的结构

### 1. OpenClaw 插件壳

插件入口是 `index.ts`，通过 `openclaw/plugin-sdk` 注册：

- `api.registerChannel({ plugin: weixinPlugin })`
- `api.registerCli(...)`
- `setWeixinRuntime(api.runtime)`

说明它不是一个独立 Node SDK，而是 **OpenClaw 插件运行时中的一个渠道扩展**。

### 2. 最有价值的可复用层

真正可借鉴的是下面这几层：

- `src/auth/login-qr.ts`
  负责二维码登录：获取二维码、轮询扫码状态、拿到 `bot_token`
- `src/api/api.ts`
  负责所有 HTTP JSON API 调用、头部构造、long-poll timeout、错误处理
- `src/monitor/monitor.ts`
  负责 `getUpdates` 长轮询、同步游标保存、会话过期处理
- `src/media/` + `src/cdn/`
  负责微信媒体下载/解密/上传/加密
- `src/auth/accounts.ts`
  负责多账号状态落盘

### 3. 深耦合、不能直接拿来跑的层

下面这些部分直接绑在 OpenClaw runtime 上：

- `ChannelPlugin` / `OpenClawPluginApi`
- `PluginRuntime["channel"]`
- `resolveSenderCommandAuthorizationWithRuntime`
- `reply.createReplyDispatcherWithTyping`
- `routing.resolveAgentRoute`
- `session.recordInboundSession`
- pairing 的 `allowFrom` 文件协议

结论：

- **直接安装到 CodePilot 里当依赖运行：不现实**
- **按协议和实现样本重写一个 CodePilot 原生 adapter：可行**

## 四、微信后端协议已经暴露得足够清楚

从 README 和源码可以确认，插件与后端的主链路是 HTTP JSON API：

### 1. 登录相关

- `GET ilink/bot/get_bot_qrcode?bot_type=3`
- `GET ilink/bot/get_qrcode_status?qrcode=...`

扫码确认后服务端返回：

- `bot_token`
- `ilink_bot_id`
- `ilink_user_id`
- `baseurl`

### 2. 消息主链路

- `POST ilink/bot/getupdates`
- `POST ilink/bot/sendmessage`
- `POST ilink/bot/getuploadurl`
- `POST ilink/bot/getconfig`
- `POST ilink/bot/sendtyping`

### 3. 关键请求头

- `AuthorizationType: ilink_bot_token`
- `Authorization: Bearer <token>`
- `X-WECHAT-UIN: <随机 uint32 的 base64>`
- 可选 `SKRouteTag`

### 4. 关键状态字段

- `get_updates_buf`
  长轮询同步游标，必须本地持久化
- `context_token`
  回复时必须带回去，否则消息无法正确关联会话
- `typing_ticket`
  由 `getconfig` 返回，供 `sendtyping` 使用
- `errcode = -14`
  表示 session 过期，插件会暂停该账号 1 小时

## 五、媒体链路也已经写明白了

微信媒体不是普通 URL 直传，而是：

1. 本地文件计算明文大小和 MD5
2. 用 AES-128-ECB 计算密文大小
3. 调 `getuploadurl` 获取 `upload_param`
4. 本地 AES-128-ECB 加密
5. PUT 上传到 CDN
6. 把 `encrypt_query_param` + `aes_key` 回填到消息体

入站下载同理：

1. 从消息里拿 `encrypt_query_param` + `aes_key`
2. 从 CDN 拉密文
3. 本地 AES-128-ECB 解密
4. 图片/文件/视频直接保存
5. 语音再尝试 SILK -> WAV 转码

这部分对 CodePilot 的意义很大：

- 我们不用猜协议
- 也不需要 native 依赖
- 直接用 Node `crypto` + `fetch` 就能复刻

## 六、它当前的限制和隐藏坑

### 1. 只支持私聊

插件明确声明：

- `capabilities.chatTypes = ["direct"]`

当前没有群聊、线程或群策略实现。

### 2. `context_token` 只存在内存 Map

源码里 `contextTokenStore` 是一个进程内 `Map<accountId:userId, token>`。

这意味着：

- 当前会话内的正常回复没问题
- 进程重启后，历史 peer 的 `context_token` 会丢
- 任何“冷启动主动推送”都可能失败

这对 CodePilot 很关键，因为我们已经有：

- 持久会话
- bridge 自动启动
- 未来的 scheduled task / automation

如果做原生集成，**必须把最近一次可用的 `context_token` 持久化到 DB**，不能照搬它的内存实现。

### 3. 多账号能力和我们当前设置模型不完全匹配

OpenClaw 微信插件支持：

- 多个微信号同时在线
- 每个账号独立 token
- 每个账号独立 sync buf

而 CodePilot 当前 bridge 设置还是以平面 key-value 为主，例如：

- `bridge_qq_app_id`
- `bridge_feishu_app_secret`

这不阻塞集成，但意味着微信这条线至少要新增：

- 每账号凭证存储
- 每账号同步游标
- 每账号状态展示

### 4. 直接依赖方式会卡在 OpenClaw runtime

即便忽略协议层，直接复用包也会卡在这些点：

- 缺失 `openclaw/plugin-sdk`
- 缺失 OpenClaw 的 runtime object
- 缺失它的 session/routing/reply/pairing 体系
- 状态文件路径默认写在 `~/.openclaw`

所以“npm install 然后 require 进 CodePilot”这条路不值得走。

## 七、与 CodePilot 现状的匹配度

### 1. 能直接复用的现有能力

CodePilot 已有这些基础能力，能接住微信适配器：

- `src/lib/bridge/` 的统一 adapter 生命周期
- `consumeOne()` 队列消费模型
- `conversation-engine.ts` 的图片附件入站处理
- `channel_bindings` / `channel_offsets` / 审计日志
- 现有 Telegram/QQ 的图片下载经验

### 2. 明确缺口

需要新增或改造的点：

- 微信专用设置页和 API
- 二维码登录 API / UI
- 每账号状态与账号列表
- `context_token` 持久化
- `get_updates_buf` 的账号级存储键设计
- 微信媒体加解密层
- 如果想支持“AI 主动发送图片/文件”，需要扩展当前 `OutboundMessage`

## 八、可行的集成路线

### 方案 A：直接嵌 npm 包

不推荐。

原因：

- 运行时耦合太深
- 会把 OpenClaw runtime 假设硬塞进 CodePilot
- 后续调试成本会很高

### 方案 B：原生实现 `weixin` adapter

推荐。

建议拆成下面几块：

1. `src/lib/bridge/adapters/weixin-api.ts`
   封装 `getupdates/sendmessage/getuploadurl/getconfig/sendtyping`
2. `src/lib/bridge/adapters/weixin-auth.ts`
   封装二维码登录、token 保存、多账号
3. `src/lib/bridge/adapters/weixin-media.ts`
   封装 CDN 下载/上传 + AES-128-ECB 加解密
4. `src/lib/bridge/adapters/weixin-adapter.ts`
   实现 `BaseChannelAdapter`
5. `src/app/api/settings/weixin/*`
   设置、校验、登录、状态 API
6. `src/components/bridge/WeixinBridgeSection.tsx`
   登录/账号/状态 UI

### MVP 建议范围

第一阶段先做：

- 私聊
- 文本入站/出站
- 二维码登录
- `get_updates_buf` 持久化
- `context_token` 持久化
- 入站图片

第二阶段再补：

- 文件/视频/语音
- 出站媒体
- 多账号管理 UI
- 诊断 / logs upload

## 九、最终判断

**能做，而且可做性不低。**

但这个“能做”的前提是：

- **把腾讯这套包当协议参考，不当运行时依赖**
- **用 CodePilot 自己的 bridge 架构重写微信 adapter**

如果只问“是否值得往前推进一个 POC”，我的结论是：

- **值得**
- **适合先做一个 text-only + QR login 的 POC**
- **不建议直接在主产品里硬接 OpenClaw 插件包本体**

## 十、这次调研没有覆盖的内容

下面这些仍然需要后续实测确认：

- 真机扫码登录是否稳定
- `context_token` 生命周期和失效条件
- session 过期后恢复策略是否只能等 1 小时
- 图片/视频上传在真实账号下的大小限制
- 多账号并发长轮询时的速率限制
