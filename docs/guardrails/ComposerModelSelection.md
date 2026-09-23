# Composer Model Selection — 护栏

聊天输入框（MessageInput）背后的模型选择是 runtime 过滤、隐藏管理、session 历史三股力量的汇合点。本文档锁住 ChatView / MessageInput / useProviderModels 三角的契约。Codex 在 2026-04-26 的几轮 review 里指出过这块的多个 cross-wire（旧 provider 被替换但仍发送、idle 期发送绕过 gate、env 历史被 localStorage 抢），已修但容易回归。

## 1. 词汇表

| 名称 | 定义 | 来源 |
|---|---|---|
| Composer | chat 页底部输入区，含 textarea + 模型/权限 selector + 发送按钮 | `src/components/chat/MessageInput.tsx` |
| Picker | Composer footer 内的 Runtime → 可用模型两层选择器 | `MessageInput.tsx` 内部 |
| ChatView | 已有会话页（chat/[id]）渲染器，包含 Composer + 消息列表 + send 路径 | `src/components/chat/ChatView.tsx` |
| New Chat Page | 新会话入口 (chat/) — 没有 ChatView，自己管 currentModel/currentProviderId | `src/app/chat/page.tsx` |
| Resolved pair | hook 返回的 `(resolvedProviderId, resolvedModel)`，runtime-filtered 后实际生效的发送对 | `useProviderModels.ts` |
| Auto-correct | MessageInput 在 modelName 不在当前 group modelOptions 里时，自动 fire `onProviderModelChange(currentProviderIdValue, modelOptions[0].value)` | `MessageInput.tsx:181-187` |

### 1.1 统一 Runtime → Provider × Model route 与能力菜单（2026-08-26 修订）

- Picker 左侧主体导航**只能是 Runtime**，顺序来自 `RUNTIME_IDS`。唯一例外是 Runtime 列表上方固定的 Favorites 快捷入口；Provider、最近使用不得成为左侧一级导航。
- 点击左侧 Runtime 是 binding-aware action：未绑定新聊天更新待创建完整 route；第一次真实执行被接受后，左侧 Runtime lane 必须 visibly disabled，普通 Picker 不得创建 handoff 或突然跳到另一个聊天。未来若开放跨 Runtime 交接，只能由独立、明确写明“在新聊天中继续”且带确认的入口调用；不得直接 PATCH `runtime_pin`，也不得只改前端过滤状态。
- 右侧只显示所选 Runtime 当前可执行的 live route，并按 provider instance 小标题分组；Provider 图标/名称是分组身份，用于区分同名模型，不是选择器的第一层。
- 已有聊天可在固定 Runtime 内切换不同 Provider 的兼容模型；普通模型选择必须保留当前 session ID、消息和页面，不能创建或导入另一个聊天。不要把“禁止换 Runtime”扩大为“禁止换服务商”。底层续接由 Runtime adapter 处理，详情见 `Runtime.md` §0。
- Picker 的可执行 identity 是 `(providerInstanceId, modelId)`，不能只按 model id。两个渠道实例即使暴露同名模型也必须是两个独立 route。
- 收藏以版本化 localStorage `codepilot:model-route-favorites:v2` 保存 `(runtimeId, providerInstanceId, modelId)` 精确组合；点击必须走一次完整 route action：同 owner Runtime 使用 CAS route mutation，bound 聊天中其它 Runtime 的收藏必须 disabled，不能借收藏绕过 Runtime lock。provider/model snapshot 绝不能据以猜一条可执行 route。
- 未发布 V1 收藏缺 Runtime identity，当前 parser 必须 fail closed；不得用打开 picker 时的 Runtime 猜迁移。
- 搜索可覆盖右侧 live route 的 model id/name 与 provider name，但不得搜索/展示 secret、base URL 原文或隐藏 metadata。
- 搜索排序固定为 `exact > prefix/substring > favorite > recency > catalog order`。收藏 boost 不得压过更准确文本匹配。
- Trigger 显示当前 Runtime 图标 + 当前模型；Composer 中不得再渲染第二个独立 `RuntimeSelector`。
- Provider 品牌图标统一由 `ProviderBrandIcon` + `getProviderIconKey()` 渲染；业务组件不得复制一套 name/URL 品牌猜测。
- capability 菜单消费当前 group/model 已返回的能力字段，并用 `selectable / fixed / unsupported / unknown` 四态表达。`fixed`（例如默认 1M）只能只读展示；`unknown` 不得变成可点击开关。
- provider option 是共享 requested preference，当前 composer 另有 session-effective capability 值。模型切换归一化只能更新 effective display/request；不得自动 PUT `context_1m` 等共享 option。只有用户显式操作能力菜单才允许持久化 requested 值。
- Composer footer 的参数与权限菜单必须使用显式宽度和 viewport `max-width`；解释文案保持一行短句，动态不可用原因允许换行。不得让 i18n 文案决定弹层的 intrinsic width，也不得通过删掉真实权限/降级原因来换取紧凑布局。

## 2. Hook 契约（`useProviderModels`）

### 2.1 runtime 必填，目录全量拉取、发送能力按 Runtime 投影

```ts
useProviderModels(providerId, modelName, runtime: ChatRuntimeParam | null)
```

- Hook 始终 fetch `/api/providers/models` 全量带 `supportedRuntimes` 注解的 catalog，供统一 Picker 在左侧切 Runtime 后立即投影右侧列表。
- Composer / ChatView 必须传 `effectiveChatRuntime(...)` 得到的具体 `RuntimeId`；既有 session pin 优先于 global runtime。
- `'auto'` 仅允许没有 session intent 的受控初始化流程；不得作为 hook 默认值。
- `null` 是 Settings 等明确需要完整 catalog、且不做发送解析的 opt-out。

不变量：`providerGroups` 保留全量 catalog；`compatibleProviderGroups` 才负责 resolved pair / send gate。Picker 对当前左栏 Runtime 做同一兼容投影。详见 `Runtime.md` §2.1。

### 2.2 返回值契约 — 五个关键字段

```ts
{
  providerGroups,           // 原始完整 group 列表，Picker 切 Runtime 的数据源
  currentProviderIdValue,   // alias for resolvedProviderId（兼容历史 caller）
  modelOptions,             // 当前 group 的 models
  currentModelOption,       // modelOptions 内匹配 modelName 的那个，否则 [0]
  globalDefaultModel,       // 仅 Settings selector 用
  globalDefaultProvider,    // 同上
  noCompatibleProvider,     // = loaded && compatibleProviderGroups.length===0
  fetchState,               // 'idle' | 'loaded' | 'failed'
  resolvedProviderId,       // 经 runtime gate 后实际的 provider ID
  resolvedModel,            // 经 runtime gate 后实际的 model value
  providerWasFilteredOut,   // 显式 caller providerId 被 gate 替换 → 触发 PATCH
}
```

### 2.3 fetchState 三态行为

| state | providerGroups | noCompatibleProvider | resolvedProviderId | resolvedModel | 用途 |
|---|---|---|---|---|---|
| `idle` | `[]` 或上次结果（refetch 中） | `false` | 可能空 | 可能空 | 加载窗口，**所有 send 路径必须 gate** |
| `loaded` | server 返回的完整 groups | compatibleProviderGroups.length===0 | 算出的 runtime-compatible fallback | 算出的 runtime-compatible fallback | 正常 |
| `failed` | catch 合成的 `[{ env synthetic }]` | `false`（length=1） | `'env'` | `DEFAULT_MODEL_OPTIONS[0]` | API 不可用 best-effort |

**不变量**：fetchAll 头部**必须** `setFetchState('idle')`；refetch 期间不能仍按 'loaded' 让 send 走旧 feed。

### 2.4 providerId / preferredProviderId / requestedProviderId 三层语义

| 层 | 计算 | 用途 |
|---|---|---|
| Caller `providerId` prop | undefined / '' / 显式字符串 | 三种语义不能混 |
| `requestedProviderId` | `undefined` → `undefined`；`''` → `'env'`；显式 → 原值 | 跟 `resolvedProviderId` 对比算 `providerWasFilteredOut` |
| `preferredProviderId` | `undefined` → fallback chain；`''` → 'env' / fallback；显式 → 原值 | 用于 `providerGroups.find` 找当前 group |
| `resolvedProviderId` | currentGroup?.provider_id | 实际生效的 ID，发送和 PATCH 用这个 |

**不变量**：
- `providerId === undefined` ≠ `providerId === ''`。前者是 caller 没指定（用 fallback），后者是历史 env-mode session 的 explicit value
- `requestedProviderId vs resolvedProviderId` 比较算 filteredOut，不能用 raw providerId vs resolvedProviderId（empty string 永远不等于任何 group ID，会 false-positive）

### 2.5 AbortController 治竞态

`fetchAll` 头部：
```ts
fetchControllerRef.current?.abort();
const controller = new AbortController();
fetchControllerRef.current = controller;
fetch(url, { signal: controller.signal });
```

`.then` 头部 `if (signal.aborted) return`；`.catch` 头部 `if (err?.name === 'AbortError' || signal.aborted) return`。

**不变量**：`provider-changed` 事件触发 refetch 时，旧请求晚到不能覆盖新请求结果。

## 3. ChatView 三道 send gate

`doStartStream` 入口顺序：

```ts
// Gate 1: idle = picker 未加载，发送会绕过 runtime 过滤
if (providerFetchState === 'idle') return;

// Gate 2: noCompatibleProvider = 真空集合，没有 provider 兼容当前 runtime
if (noCompatibleProvider) return;

// Gate 3: loaded 态下 resolved pair 不能为空
if (providerFetchState === 'loaded' && (!resolvedProviderId || !resolvedModel)) return;
```

不变量：三道 gate**全部**必须存在。删掉任何一道都会让 cross-wire 重新出现。

`sendMessage` 头部**也**必须有 gate 1 + gate 2（在 append user message 之前），否则 user 看到自己消息悬停无回复。`dequeue useEffect` 同样。

## 4. ChatView runtime 不兼容时禁止静默改写

`providerWasFilteredOut` 只用于形成 `sessionProviderRuntimeIncompatible`。一旦已保存的 route 不兼容当前 Runtime，ChatView 必须显示恢复提示并在 append optimistic user message 前硬阻断发送。

不变量：
- 页面加载、全局 Runtime 变化或目录 refetch 都不得静默 `setCurrentProviderId` / PATCH session route。
- 只有用户在统一 Picker 中显式选择 owner Runtime 内的完整路线，才能通过带 `expected_route_revision` 的原子 route mutation 持久化；bound 聊天的普通 Picker 不提供跨 Runtime 动作。独立 handoff 入口若将来开放，只创建目标、不改来源 route。
- 服务端并发删除 provider 时用 `INVALID_SESSION_PROVIDER` 409 回到同一恢复面，不得由客户端猜 fallback 后继续发送。

## 5. ChatView 初始化保留 '' 语义

```ts
const [currentProviderId, setCurrentProviderId] = useState(() =>
  providerId !== undefined
    ? providerId
    : (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') : null) || ''
);

useEffect(() => { if (providerId !== undefined) setCurrentProviderId(providerId); }, [providerId]);
```

不变量：判断**必须** `=== undefined`，不能用 truthy `||` 短路。`providerId === ''` 是 env-mode session 的合法 prop 值，被当 falsy → localStorage 抢走 → 历史 env session 切到别的 provider。

`modelName` 可以继续按 truthy 处理 — empty model 不是合法 session 状态，env session 的 model 也是 'sonnet' / 'opus' / 'haiku'。

## 6. MessageInput auto-correct

`MessageInput.tsx:181-187`：
```ts
useEffect(() => {
  if (modelName && modelOptions.length > 0 && !modelOptions.some(m => m.value === modelName)) {
    const fallback = modelOptions[0].value;
    onModelChange?.(fallback);
    onProviderModelChange?.(currentProviderIdValue, fallback);
  }
}, [modelName, modelOptions, currentProviderIdValue, onModelChange, onProviderModelChange]);
```

不变量：
- 只在 `modelName` 不在 `modelOptions` 时触发（别频繁 fire）
- fallback 用 `modelOptions[0]`，不要用 `globalDefaultModel`（globalDefault 只对新会话有意义；存量 session 强行覆盖会把用户原选择丢掉）
- `onProviderModelChange` 传 `currentProviderIdValue`（hook 算的 fallback group ID），不要传 raw `providerId` prop（那是已被替换的旧 ID）
- `isAuto` 回调只同步 Composer 本地显示，不得调用 route mutation。unbound 会话切 Runtime 后的完整 route 只在第一次手动 Send 中与 `first_execution` owner 一起原子保存；不得用一个可能长期残留的“刚选过 Runtime”标志授权后续 catalog refetch 偷写 revision。

## 7. New Chat Page (chat/page.tsx) 自治

`chat/page.tsx` **不**用 `useProviderModels` hook —— 它有自己的 init useEffect，直接 fetch + 自己管 `currentModel/currentProviderId/noCompatibleProvider` state。

为什么不复用 hook：新会话初始化要把 saved provider/model 跟 global default 对比，决定用哪个；逻辑跟 hook 的"展示 picker"职责不同。两套代码各自完整。

不变量：两条路径**都**必须遵守同一契约：
- 初始化 resolver 使用当前 `sessionRuntimeParam` 拉 runtime-filtered feed；Composer 内 Picker 仍从 full annotated catalog 投影三 Runtime 列表
- `groups: []` → `noCompatibleProvider=true` + 清 currentProviderId/Model
- 不要把 saved provider/model 塞回到刚被 runtime 滤掉的位置
- `sendFirstMessage` 加 `noCompatibleProvider` + `!currentModel || !currentProviderId` 防御

侧栏、项目行和目录选择器会先创建一个零消息的 `/chat/[id]` 空会话。此类入口只有两种合法请求：

- 已经掌握一条经过当前 catalog 解析的明确 route：同时提交 `runtime_id + provider_id + model`；
- 只想创建可编辑的 unbound 空会话：三个 route 字段全部省略，由 Composer 展示当前可用 route，第一条真实执行再绑定。

不得从 localStorage 只拼 `model + provider_id`。这既不是完整 route，也会被 `/api/chat/sessions` 的 all-or-none 校验以 `INCOMPLETE_SESSION_ROUTE` 拒绝。相关回归钉在 `sidebar-compose-new-chat.test.ts`。

对第二种空会话，第一条手动 Send 必须先调用 route CAS，并显式携带 `bind_for_execution: true`：服务端在同一次事务中写完整 route、`runtime_binding_state='bound'`、`runtime_binding_source='first_execution'` 和新 revision。只有该请求成功后，客户端才可添加 optimistic 用户气泡并启动 `/api/chat`。不得把裸 `model/provider` 直接交给 `/api/chat` 让它猜 owner，也不得在绑定失败时先把消息显示成已发送。

若 route CAS 返回 `ROUTE_REVISION_CONFLICT`，客户端必须采用响应中的权威 session 快照（完整 route、binding state、owner 与 `route_revision`），保留用户草稿且不添加 optimistic 气泡。用户下一次 Send 使用最新快照重试；不能继续拿旧 revision 无限 409，也不能要求整页刷新才能恢复。

## 8. Auto-trigger 同样吃 resolved pair

`useAssistantTrigger` 通过 props 接收 `resolvedModel / resolvedProviderId / noCompatibleProvider / fetchState`。`checkAssistantTrigger` 头部三道 gate：

```ts
if (fetchState !== 'loaded') return;
if (noCompatibleProvider) return;
if (!resolvedProviderId || !resolvedModel) return;
```

不变量：welcome / heartbeat 这种 auto-trigger 也走 resolved pair，不能用 raw `currentModel/currentProviderId`。Auto-trigger 是 backend route 的入口之一，必须跟 user-typed send 同样的 gate。

## 9. 关键文件 + 责任

| 模块 | 文件 | 不变量 |
|---|---|---|
| Hook 主体 | `src/hooks/useProviderModels.ts` | 五字段契约 + AbortController + 三态 fetchState + undefined/'' 区分 |
| Composer 顶层 | `src/components/chat/MessageInput.tsx` | 传 concrete Runtime；只渲染统一 Runtime+Model Picker；auto-correct fallback 用 modelOptions[0] 不用 globalDefault |
| ChatView 顶层 | `src/components/chat/ChatView.tsx` line 142+ | 调 hook + 同步 useEffect + 三道 gate + sendMessage 头部 gate |
| New Chat Page init | `src/app/chat/page.tsx` line 110+ + line 295+ | `?runtime=auto`；空集合不走 localStorage；sendFirstMessage 防御 |
| Auto-trigger | `src/hooks/useAssistantTrigger.ts` | 接收 resolved pair；三道 gate；startStream 用 resolved pair |
| Route picker / favorites | `src/components/chat/ModelSelectorDropdown.tsx`, `RuntimeSelector.tsx`, `src/lib/model-route-favorites.ts` | 左栏 Runtime、右栏可用 provider+model 复合 identity、失效收藏 fail closed |
| Capability menu | `src/components/chat/ModelCapabilityDropdown.tsx`, `src/lib/model-option-support.ts` | Runtime+protocol+model 粒度四态；fixed/unknown 不产生假 wire |
| Brand icon | `src/components/ui/provider-brand-icon.tsx`, `src/lib/provider-icon-rule.ts` | Settings 与 Composer 共用同一品牌规则 |
| ChatView state init | `ChatView.tsx` line 130-138 | `providerId !== undefined ? providerId : localStorage` 不能用 truthy |

## 10. 改 / 加新功能必须检查

- 新增 chat 入口（除 chat-route / bridge / new chat / chat[id] 外）：
  - 必须吃 resolved pair，不要用 raw saved provider/model
  - 必须有 idle / noCompatibleProvider gate
- 新增 hook consumer：
  - 默认走 `runtime: 'auto'`
  - 看 fetchState 而不是 providerGroups.length
  - empty providerGroups + loaded ≠ 完全没 provider，可能用户没兼容的 → noCompatibleProvider 信号
- 改 MessageInput 模型选择 UI：
  - 左侧 Runtime 主体只能渲染 `RUNTIME_IDS`；Favorites 可固定在其上方，Provider 不得成为左栏层级
  - 收藏 key 必须包含 Runtime + provider instance + model；收藏点击必须切完整组合
  - 普通 Runtime lane 只能显示所选 Runtime 下 `selectable && live` 的 route；Favorites lane 可显示 disabled 快照，但只能解释/删除，不能执行
  - 右侧必须先显示 Provider 分组标题，再列该 Provider 的模型
  - unbound 聊天切 Runtime 只更新待发送的本地 route；第一次手动 Send 必须调用原子 route handler 并绑定 owner。bound / 已接受第一条消息的会话必须 disable Runtime lane，并在 callback 再次 fail closed；不得直写 `runtime_pin`，也不得从普通 Picker 自动 handoff / 跳转
  - Composer 不得同时出现统一 Picker 与独立 `RuntimeSelector`
  - 改 onProviderModelChange callback 时确保把 hook 的 `currentProviderIdValue` 传上去而非 prop
  - 收藏/最近项不能绕过 runtime-filtered live route；snapshot 不得执行
  - V1 等缺 Runtime identity 的记录必须 fail closed，不得按当前 Runtime 猜迁移
  - capability 缺 source 时必须 `unknown`，不得为了截图补开关
  - capability 自动归一化不得调用 provider option PUT；显式菜单操作与自动归一化必须是两条不同 handler
  - 参数菜单保持紧凑的固定宽度；权限菜单必须有固定宽度、viewport 上限和长原因换行，不能只设 `min-width`
- 改 ChatView state 初始化：
  - 任何 `providerId || ...` 短路写法都是 bug，必须 `providerId !== undefined`
  - `modelName || ...` OK（empty model 不合法）
- 加 send 路径前置逻辑（如新的 retry / queue）：
  - 在 append user message 之前 gate
  - 或者让 doStartStream 返回 boolean，caller 据此决定是否 append

## 11. 常见坑

1. **`providerId || localStorage.getItem(...)`** — env session 被 localStorage 抢
2. **`if (providerId)` 同步 effect** — env session 的 prop '' 不被同步
3. **fetchState 初始 'loaded'** — 挂载第一帧就误判 noCompatibleProvider
4. **fetchAll 不重置 fetchState** — provider-changed refetch 期间用旧 feed
5. **没 abort** — 慢的旧请求覆盖新请求
6. **idle 状态不 gate** — 加载窗口 send 绕过 runtime 过滤
7. **append user message 在 gate 之前** — gate 退出后用户消息悬挂无回复
8. **auto-trigger 用 raw currentModel/currentProviderId 或全局 Runtime** — backend 端绕过 route/binding gate；自动会话必须创建即绑定
9. **同步 effect 缺 `providerFetchState` deps** — eslint-disable React Hook 后忘记加
10. **MessageInput auto-correct fallback 用 globalDefaultModel** — 存量 session 被强行改
11. **把 Provider 放进左栏，或让 Favorites 丢失 Runtime** — 执行渠道被误当 Runtime，或快捷选择只换半套 route
12. **Unify 后仍保留独立 Runtime selector** — 两个入口可以显示/写入不同 Runtime，导致 UI 与 wire 漂移
13. **把上下文状态留在左侧工具组** — 视觉上与模型/权限混为一组；它必须紧邻 Send 左侧
14. **badge 统计失效收藏但列表隐藏它们** — 用户看得到数量却无法清理；Favorites lane 必须保留 disabled 管理行
15. **模型切换时把 effective 1M 回写 provider option** — 一次 session 的兼容性归一化污染同 provider 的其他会话
16. **用长解释撑开 footer 菜单** — capability/permission 说明应为短句；完整安全告警留在确认弹窗，动态诊断原因在受限宽度内换行

## 12. 测试覆盖

| 测试文件 | 覆盖 |
|---|---|
| `src/__tests__/unit/chat-runtime.test.ts` | 5 个 chat-runtime helper test，含 registry 注册副作用回归 |
| `src/__tests__/unit/provider-resolver.test.ts` | resolveProvider 在 runtime opt 下的 hidden + runtime stack |
| `src/__tests__/unit/runtime-route-validation.test.ts` | 未落库 catalog 模型、隐藏/不存在/不兼容模型、Codex 冷缓存发现与 recovery safe mode |
| `src/__tests__/e2e/old-chat-model-route.spec.ts` | 三 Runtime 旧聊天同/跨 Provider 切模型，保留聊天 ID、页面、消息与聊天总数；跨 Runtime 仍拒绝 |
| 待补 `useProviderModels.test.ts` | hook 单测：fetchState 转移 / providerWasFilteredOut / requestedProviderId 三层语义 / AbortController 竞态 |
| 待补 `ChatView-send-gate.test.ts` | 三道 gate / append-before-gate 防御 |
| `src/__tests__/unit/sdk-subprocess-env.test.ts` | toClaudeCodeEnv 不 leak hidden role default |
| `src/__tests__/unit/codex-phase-6-wiring.test.ts` | Favorites 位于 Runtime 上方、右栏 Provider 分组、完整组合 handler、上下文紧邻 Send |
| `src/__tests__/unit/model-route-favorites.test.ts` | V2 精确三元 identity、V1 fail-closed、去重与搜索排序 |
| `src/__tests__/unit/model-option-support.test.ts` | Runtime/protocol/model 四态 descriptor 与 context effective 归一化 |
| `src/__tests__/e2e/project-panel.spec.ts` | 三 Runtime、Provider 分组、收藏一键切完整组合、失效收藏可见可删、权限文案、上下文/Send 几何、归一化不 PUT shared 1M |

加 / 改本文涉及任何契约时，至少跑 chat-runtime.test.ts + provider-resolver.test.ts；理想是把 useProviderModels 的 hook test 补上。

## 13. 设计决策日志

- **2026-04-26** Resolved pair 抽成 hook 契约 — Codex review 指出"旧 provider 被过滤但仍发送"；统一让所有 chat 入口吃同一对
- **2026-04-26** undefined vs '' 严格区分 — Codex review 指出 env 旧会话被 localStorage 抢
- **2026-04-26** AbortController 治 fetchAll 竞态 — Codex review 指出 provider-changed 期间旧响应覆盖新
- **2026-04-26** fetchState idle 阻塞 send — Codex review 指出加载窗口 raw 发送绕过 runtime gate
- **2026-04-26** 拆 requestedProviderId vs preferredProviderId — env session + env 不在 feed 时 providerWasFilteredOut 误判 false
- **2026-04-26** ChatView 顶层调 hook 而非通过 props — 让 MessageInput 内部 hook 跟 ChatView 共享同一 fetch 结果不可行（state 各自），但两个 instance 的 fetch 是廉价的
- **2026-04-26** auto-trigger 也吃 resolved pair — welcome/heartbeat 之前用 raw currentModel/currentProviderId 绕过 runtime gate
- **2026-08-26** Picker 改为 Runtime-first — 用户复核指出左栏 Provider 是语义错误；Runtime 决定执行引擎，Provider 只属于右侧可用模型路线
- **2026-08-26** Unify 后移除独立 Runtime selector — 单一入口同时更新 Runtime 与模型可用面，避免两个控件 cross-wire
- **2026-08-26** Favorites 固定在 Runtime 上方，identity 升为 Runtime + Provider + Model — 用户要求收藏即完整执行组合，点击一次完成三项切换
- **2026-08-26** 右栏按 Provider 分组；RunCockpit/上下文移到 Send 左侧 — 对齐模型归属与输入框末端动作层级
- **2026-08-26** 失效收藏留在 Favorites lane 管理、V1 fail closed — badge 必须对应可见可删条目，缺 Runtime 的旧格式不得靠当前 UI 状态猜执行 identity
- **2026-08-26** capability requested/effective 分层 — 模型归一化是 session-local，不允许自动污染 provider 共享设置
- **2026-08-26** footer 菜单收窄 — capability 固定 240px，permission 固定 256px 且动态原因换行；短说明只辅助扫读，完整权限告警继续由确认弹窗承担


## 2026-09-14 #685：已选路由与运行时回报分离

- `chat_sessions.model` 是用户提交的 route model identity；SDK/Native `status.model` 是运行时观察值，collector 不得用它覆盖 route，也不得借 status 绕过 `route_revision` CAS。续接引用 `sdk_session_id` 仍由现有 lock owner gate 写入；模型观察值继续留在 SSE/usage 元数据中。
- `resolveChatMessageRoute` 是普通消息的 identity gate。Provider 未随请求回显时仍固定使用 session Provider，不能回退默认/env；明确不同 Provider 立即拒绝。
- 兼容旧版已写成 upstream 的会话只作读取：必须在同一 Provider 的 live enabled catalog 唯一匹配到本次请求的 modelId，并且当前 Runtime 兼容、实际 resolver upstream 一致。stored ID 若本身是另一条 catalog modelId，或多个 alias 共享它、映射隐藏/删除/修改，不能自动解释为同一路线。虚拟账号路线继续精确 identity。
- 兼容不改 owner、历史、Provider 或 route_revision；真正改 route 仍走用户显式 CAS。无法无歧义恢复的旧会话继续要求明确重选，不能按显示名或跨 Provider 猜测。
- 回归：`chat-message-route.test.ts`（多 Provider 连续/重开、旧 upstream、反例和 Native/Codex owner 兼容）、`chat-message-route-http.test.ts`（真实 POST 双回合与错路由在持久化/Runtime 前拒绝）、`collect-owner-gate.test.ts`（owner 也不覆盖 model、stale owner 不写续接状态）。
