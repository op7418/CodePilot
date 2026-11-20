# 飞书 CLI 一键创建机器人逆向调研

> 调研时间：2026-04-13
> 分析对象：飞书官方 CLI（larksuite-cli；本地快照已不保留）
> 状态：**POC 已完成，全链路验证通过，可进入实现阶段**

## 核心结论

飞书 CLI 使用 `archetype=PersonalAgent` 参数调用 App Registration Device Flow API 创建应用。CLI 源码本身不包含任何后续配置调用（无 PATCH/PUT 来启用 Bot、添加事件、申请权限），但 **POC + 开放平台人工核查 + 运行时测试已确认**：飞书后端根据 PersonalAgent 模板自动配置了 Bot 能力、IM scope、事件订阅、长连接模式，且无需手动发布即可使用。

---

## App Registration API

### 流程

```
用户点击"快速创建飞书应用"
  ↓
CodePilot 调用 POST accounts.feishu.cn/oauth/v1/app/registration (action=begin)
  ↓
拿到 device_code + verification_uri_complete
  ↓
自动在浏览器中打开 verification_uri_complete（无需扫码）
  ↓
用户在浏览器中选择工作区 → 确认创建
  ↓
CodePilot 后端轮询 POST /oauth/v1/app/registration (action=poll)
  ↓
拿到 app_id (client_id) + app_secret (client_secret)
  ↓
自动写入 bridge_feishu_app_id / bridge_feishu_app_secret
```

### API 详情

**开始注册：**
```http
POST https://accounts.feishu.cn/oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id+tenant_brand
```

**响应：**
```json
{
  "device_code": "fe_4c159c1d91d96b129cccb3f59e8fa2c5",
  "user_code": "XXXXX",
  "verification_uri_complete": "https://open.feishu.cn/page/cli?user_code=XXXXX&...",
  "expires_in": 300,
  "interval": 5
}
```

**轮询结果：**
```http
POST https://accounts.feishu.cn/oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=poll&device_code=fe_4c159c1d91d96b129cccb3f59e8fa2c5
```

**成功响应：**
```json
{
  "client_id": "cli_xxx",
  "client_secret": "xxx",
  "user_info": { "open_id": "ou_xxx", "tenant_brand": "feishu" }
}
```

**轮询错误码：**
- `authorization_pending` → 继续等（间隔 5s）
- `slow_down` → 增加间隔后继续
- `access_denied` → 用户拒绝
- `expired_token` → 超时（300s）

**Lark 国际版：** 如果返回 `tenant_brand=lark` 且 `client_secret` 为空，需切到 `accounts.larksuite.com` 重试。

---

## POC 验证结果（2026-04-13 实测）

### Scope 与能力核查（开放平台后台人工确认）

PersonalAgent 模板自动开通的能力：

| 类别 | 项目 | 状态 |
|------|------|------|
| **Bot 能力** | Bot 已启用，bot.info 返回正常 | **已确认** |
| **长连接模式** | 事件和回调均配置为"长连接" | **已确认** |
| **事件订阅** | `im.message.receive_v1`（接收消息） | **已确认** |
| | `im.message.reaction.created_v1`（消息被 reaction） | **已确认** |
| | `im.message.reaction.deleted_v1`（取消 reaction） | **已确认** |
| **回调订阅** | `card.action.trigger`（卡片交互） | **已确认** |
| **IM Scope** | `im:message:send_as_bot`（Bot 发消息） | **已确认** |
| | `im:message:readonly`（读取消息） | **已确认** |
| | `im:message:update`（更新消息 / 流式卡片） | **已确认** |
| | `im:resource`（下载图片/文件） | **已确认** |
| | `im:message:recall`（撤回消息） | **已确认**（额外） |
| | `im:message:send_multi_users`（批量发消息） | **已确认**（额外） |
| **其他** | task / wiki / drive 等大量权限 | **已确认**（超出桥接需求） |

### 运行时验证

用获得的凭据实际执行了完整运行时测试：

1. **tenant_access_token 换取** — 成功（`code: 0`）
2. **bot.info 查询** — 成功（`activate_status: 2`）
3. **WSClient 长连接** — `wsClient.start()` 成功，`ws client ready` 确认
4. **消息事件接收** — 用户在飞书给 Bot 发送"你好"，`im.message.receive_v1` 事件成功触发
5. **事件数据完整** — chat_id、message_type、content、sender.open_id 全部正确返回
6. **无需发布** — 创建后直接可用

```
[EVENT] === Message received! ===
  chat_id: oc_c29857453bc102fc25d00a5e735f2910
  msg_type: text
  content: {"text":"你好"}
  sender: ou_52604379df4ac6a47c30620eaaa05039
```

### 待确认的增强能力（不阻塞核心功能）

| Scope | 用途 | 状态 |
|-------|------|------|
| `im:message.reactions:write_only` | Typing 指示器（添加/移除 emoji） | 待查 |
| `cardkit:card:write` | 流式卡片创建 | 待查 |
| `cardkit:card:read` | 卡片状态读取 | 待查 |

如果未自动开通，桥接应做真实降级处理：CardKit 调用失败时 fallback 为普通 post 消息，reaction 写入失败时静默跳过 typing 指示器。实现时需在 `card-controller.ts` 和 `outbound.ts` 的对应路径加 try-catch 降级逻辑，而不是仅靠文档描述。

---

## 桥接运行时权限依赖

### 当前代码硬依赖（核心功能）

| Scope | 代码位置 | 用途 |
|-------|----------|------|
| `im:message:send_as_bot` | `outbound.ts` 所有出站消息 | 以 Bot 身份发消息 |
| `im:message:readonly` | `gateway.ts:68` 事件处理 | 读取消息内容 |

### 完整渠道覆盖所需（DM + 群聊）

| Scope | 依据 | 用途 |
|-------|------|------|
| `im:message.p2p_msg:readonly` | `policy.ts:10` DM 策略、`feishu.mdx:41` 私聊配置 | 接收用户发给 Bot 的私聊消息 |
| `im:message.group_at_msg:readonly` | `policy.ts:10` 群聊策略、`feishu.mdx:121` 群聊配置 | 接收群聊中 @Bot 的消息 |

当前产品明确支持私聊和群聊两种入口，这两个 scope 是对应事件（`im.message.receive_v1`）在不同场景下的权限前提。POC 中开放平台核查确认事件订阅所需权限显示"读取用户发给机器人的单聊消息 已开通"和"获取群组中用户@机器人消息 已开通"，对应这两个 scope。

以上 4 个 scope + 2 个事件覆盖了完整的消息收发链路。

注：当前入站只处理文本消息（`inbound.ts:48`），非文本直接跳过，`im:resource` 虽已开通但暂无下载链路。

### 事件/回调硬依赖

| 事件/回调 | 代码位置 | 用途 |
|-----------|----------|------|
| `im.message.receive_v1` | `gateway.ts:64` | 接收用户消息 |
| `card.action.trigger` | `gateway.ts:93` | 卡片按钮交互（权限审批、项目切换） |

以上 2 个已全部确认配置且长连接模式已启用。

### 增强能力（降级不影响核心消息收发）

| Scope | 代码位置 | 用途 | 缺失时的降级行为 |
|-------|----------|------|----------------|
| `cardkit:card:write` | `card-controller.ts:125` card.create / `:210` streamContent / `:264` setStreamingMode | 创建和流式更新卡片 | 降级为普通 post 消息 |
| `cardkit:card:write` | `card-controller.ts:329` card.update | 最终化卡片内容 | 同上 |
| `im:message:update` | 未直接使用 | 流式更新走 CardKit 路径而非 im.message.update | 无影响 |
| `im:message.reactions:write_only` | `outbound.ts:311` | Typing emoji 指示器 | 无 typing 指示 |
| `im:resource` | 未直接使用 | 入站只处理文本，暂无资源下载 | 无影响 |
| `im:chat:read` | 未直接使用 | 群授权走本地 policy 配置 | 无影响 |
| `im:message.reactions:read` | 未直接使用 | reaction 事件通过事件订阅覆盖 | 无影响 |

### Token 模型

- **不需要 user_access_token** — 桥接全程使用 tenant/bot 身份
- **tenant_access_token** — 由 `@larksuiteoapi/node-sdk` 自动从 `app_id` + `app_secret` 换取并缓存，无需手动刷新

---

## archetype=PersonalAgent 机制分析

### CLI 源码逆向

CLI 的全部工作是发送 `archetype=PersonalAgent` 参数，然后轮询拿凭据。逆向验证：
- `PollAppRegistration` 返回后只做 `saveAppConfig()`（写入本地凭据）
- 没有对 `/open-apis/application/v6/applications/{app_id}` 发 PATCH/PUT
- 没有 Bot 能力启用、事件订阅、权限申请的任何 API 调用
- `/cmd/config/init.go:272-288` 直接结束

### 结论

CLI 源码本身不能证明 PersonalAgent 会自动配置能力/事件/权限——但 **POC + 开放平台人工核查 + 运行时测试** 三重确认了这一点。飞书后端在用户确认创建时，根据 PersonalAgent 模板完成了所有配置。

---

## CodePilot 集成方案

### 实施方案

```
设置 → 远程桥接 → 飞书 → "快速创建飞书应用"
  ↓
浏览器打开飞书创建页 → 用户选工作区 → 确认
  ↓
自动拿到 app_id + app_secret → 写入 bridge_feishu_* 配置
  ↓
自动测试连接（tenant_access_token + bot.info + WSClient 试连）
  ↓
提示用户启动桥接
```

注意：当前 verify 接口（`/api/settings/feishu/verify`）只验证 tenant_access_token + bot.info。如果要做更完整的验证，可以扩展为试连 WSClient 确认长连接可用。

### 技术实现要点

1. **注册会话模型**：参考微信桥接的 session 模式（`weixin-auth.ts`）——创建服务端 session 保存 device_code / 轮询间隔 / 过期时间 / Lark 回切状态 / 取消标志，前端用 session_id 轮询
2. **API 路由**：`POST /api/bridge/feishu/register/start` — 开始 device flow，返回 session_id + verification_uri_complete
3. **API 路由**：`GET /api/bridge/feishu/register/poll?sessionId=xxx` — 轮询状态
4. **浏览器跳转**：`window.open(verification_uri_complete)` 打开授权页
5. **轮询策略**：5s 间隔，`slow_down` 时递增（最大 60s），最长 300s 超时
6. **凭据存储**：直接写入现有 `bridge_feishu_app_id` / `bridge_feishu_app_secret` 字段
7. **品牌检测**：轮询响应 `tenant_brand=lark` 时自动切域名并重试，写入 `bridge_feishu_domain`

---

## 关键源码文件（CLI 参考）

| 文件 | 作用 |
|------|------|
| `internal/auth/app_registration.go` | App Registration device flow（begin + poll）—— 核心参考 |
| `internal/auth/device_flow.go` | User OAuth device flow（域名用 `accounts.*` 不是 `open.*`） |
| `cmd/config/init_interactive.go` | 交互式流程（品牌选择、模式选择） |
| `internal/core/types.go` | 端点常量（飞书 vs Lark 域名解析） |

---

## 风险评估

| 风险 | 级别 | 说明 |
|------|------|------|
| API 稳定性 | 低 | 飞书官方 CLI 在用的 API，POC 已验证可调通 |
| PersonalAgent 模板覆盖度 | 低 | POC 已确认核心 IM scope + Bot + 事件 + 长连接均自动配置 |
| 应用发布流程 | 低 | 已确认无需发布，创建后直接可用 |
| 企业安全策略 | 中 | 部分企业可能禁止通过 API 创建应用 |
| 增强能力缺失 | 低 | cardkit/reactions write 如果未自动开通，桥接降级为普通消息，不影响核心 |

---

## 下一步

1. ~~验证 PersonalAgent 模板~~ — **已完成**
2. ~~确认"发布"步骤~~ — **已确认**，无需发布
3. ~~WSClient 运行时验证~~ — **已通过**，长连接 + 消息事件接收全通
4. **确认增强 scope** — 检查 cardkit、reactions write 是否也已开通（不阻塞实现）
5. **写执行计划** — 设计注册会话状态机 + API 路由 + 前端交互
6. **实现** — 预估 1-2 天
