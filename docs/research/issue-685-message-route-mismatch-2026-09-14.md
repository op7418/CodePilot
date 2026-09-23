# #685 连续对话 MESSAGE_ROUTE_MISMATCH 根因诊断

2026-09-14。状态：Signal / Triage 已完成，缺陷链隔离复现；未实施 Fix，未修改产品代码。用户本人也反馈遇到同类现象。

来源：[GitHub #685](https://github.com/op7418/CodePilot/issues/685)。0.67.15 / Windows / Claude Code SDK / MiMo Token Plan：首轮正常，第二轮 MESSAGE_ROUTE_MISMATCH，每次重新选模型才恢复。

## 用户问题与关键判断

这是同一模型在不同层使用不同身份后，SDK 观察值覆盖已提交路由引起的确定性缺陷。不是根据错误提示推测 Provider 认证失败：本地真实 POST 在调用 Provider resolver / Runtime 前就返回了 409。没有读取用户实际聊天或凭据，不能断言用户遇到的每个同码错误都来自该链；#685 所描述组合与恢复方式已可重复模拟。

## 根因链与代码证据

1. `src/lib/provider-catalog.ts:1230`：MiMo Token Plan 的 picker 路由 modelId 是 `sonnet`，实际 upstreamModelId 是 `mimo-v2.5-pro`。角色别名不代表该请求使用 Anthropic Sonnet。
2. `src/lib/claude-client.ts:2474`：SDK init 产生 status，同时包含 `model: sysMsg.model` 与 `requested_model: model`。这里只区分回报模型和请求模型，没有自行更改 route。
3. `src/lib/chat-collect-stream-response.ts:333`：持锁的 collector 把 statusData.model 无条件传给 updateSessionModel；`src/lib/db.ts:2619` 直接 UPDATE chat_sessions.model，不增加 route_revision。于是原先的 `sonnet` 路由被实际 ID 覆盖，route CAS 也无法从 revision 发现该改动。
4. `src/hooks/useProviderModels.ts:436`：findModelOption 支持别名与 upstream 匹配，但 resolvedModel 返回 picker row 的 value，即 `sonnet`。无论前端保持旧状态，还是重新读取数据库里的 upstream ID，都会发送别名。`ChatView.tsx:1267` 发送 resolvedModel。
5. `src/app/api/chat/route.ts:205`：请求 model 与 session.model 直接字符串比较；`sonnet !== mimo-v2.5-pro` 导致 409 MESSAGE_ROUTE_MISMATCH。拒绝发生在第二条用户消息入库和上游请求之前。
6. 手动选模型走 `ChatView.commitRoute` → route PATCH，把 session.model 写回 picker identity。下一轮 init 又覆盖它，因此解释了“每轮都要重选”。

已用 git show 验证 v0.67.15 的 collector 写回与 POST 比较逻辑同样存在；不是当前未提交的保存失败提示补丁新引入的问题。影响机制不依赖 Windows，其他 SDK 回报 ID 与 picker 别名不同的路线也有风险；没有实测所有 Provider。

## 隔离验证

命令：`CODEX_DISABLED=1 node --import tsx --test /tmp/codepilot-685-repro.test.ts`。

结果：2 tests pass / 0 fail，约 3 秒。测试使用项目 db-isolation.setup 创建临时 SQLite，不读取用户库；使用 fixture 凭据，无真实模型调用。

- 真实 collector 接受模拟 SDK status（实际 model + requested_model），首轮助手正文正常落库；数据库 model 从 sonnet 变为 mimo-v2.5-pro，revision 保持不变。
- 真实 findModelOption 得到下一轮发送值 sonnet；真实 POST 返回 409 / MESSAGE_ROUTE_MISMATCH，第二条用户消息没有入库。
- 真实 route PATCH 模拟手动重选，通过 catalog 校验并恢复 sonnet；再次灌入 SDK status 又覆盖为 upstream。
- 反例：SDK 回报与 picker ID 完全相同，collector 不造成身份差异。

边界：这是模拟 SDK init 的真实 collector/DB/HTTP handler 集成复现，不是 Windows packaged 或真实 MiMo 云端 smoke，也未测试 DOM。没有执行全量测试，因为没有产品改动。临时测试是诊断 characterization，后续修复应转换为“不允许回报模型改写 committed route”的回归断言，而不是保留期待错误行为的断言。

## 修复取舍与后续执行要求

建议将用户已提交 route identity 与 Runtime 实测 model 分离：运行状态回报不得覆盖 chat_sessions.model，也不得绕过 route CAS。若要显示实测模型，应使用现有运行/消息元数据或明确独立字段；不应为本问题直接扩大为 schema 改造。

只删除 MESSAGE_ROUTE_MISMATCH 比较会放开真正的错路由发送，不可取。只在前端改发 upstream 会与 picker/route validation 契约继续冲突。仅停止今后的覆盖也不够，历史 session 已被写成 upstream，需要 provider-scoped、无歧义的身份兼容或显式 route 恢复；必须保持 provider instance 与 owner Runtime 边界，不得将不同服务商的同名模型合并。

后续获实现授权时：

- [ ] collector 保留 sdk_session_id 所有权保护，但停止用 SDK model 改写 committed route。
- [ ] 覆盖已有 upstream-ID 会话的安全恢复，保持同一 session、历史与 Runtime，处理并发 revision。
- [ ] 更新 collect-owner-gate.test.ts 的旧断言：它当前把 SDK model 覆盖 route 当成 happy path，正好固化了错误语义。
- [ ] 回归 MiMo 首轮/续聊/重开旧会话、alias=upstream 对照、真正不同模型或 Provider 仍拒绝、过期 owner 不写回；保留 CAS 冲突与 Runtime 锁测试。
- [ ] targeted + full tests + 双聊天入口实际 UI 验证；真实 MiMo/Windows smoke 单列，不用 mock 冒充。
- [ ] 同步 ComposerModelSelection / Runtime / StreamSession 护栏与执行计划的身份定义和验证记录。


## 用户补充：Windows 多模型触发，Mac 尚未遇到

2026-09-14 用户纠正范围：Windows 不只 MiMo，其他模型也出现；Mac 实际使用暂未遇到。初轮复现选择 MiMo 是因为 #685 提供了明确配置，不应把根因限定为 MiMo。

追加隔离矩阵：复用同一真实 collector / SQLite / POST / route PATCH 测试，使用 `minimax-cn` 与 `anthropic-official` 的真实 catalog alias/upstream 值，4/4 通过。加上 MiMo 共 6/6（每个 preset 一条缺陷复现、一条 alias=reported 反例）。所有测试在当前 Darwin/macOS 主机运行，因此已证明该应用逻辑缺陷不依赖 Windows；不代表 Mac GUI / 真实 SDK 端到端已经复现。

源码影响面补充：Native `agent-loop.ts:354–359` 也发顶层 model=modelId 与 requested_model，经过同一个 collector，因此不能把风险限定为 Claude SDK。Codex 当前 runtime.ts 两类 status（unknown_item 和 elicitation）没有相同顶层 model 字段；Runtime 路径可能导致两台机器表现不同，但没有用户两端配置前不能据此定因。

两台机器差异目前未确定。待对照：CodePilot 构建版本、Runtime、同一 Provider 实例的 picker model ID / upstream ID、SDK init 实际回报 model，以及是否为已存量 canonical route。模型别名与实际 ID 相同是已测的不触发条件；两台机器同名模型可能来自不同 catalog/自定义行，名称相同不足以证明 route identity 相同。SDK 版本不同也仅是待查变量，当前无证据认定其导致本例平台差异。

只读查看本机最近会话的 runtime/model 汇总发现混合 Runtime、多个直接模型 ID，并包含历史测试痕迹；该库不能代表用户当前 Mac GUI 的完整有效配置，所以不据此解释“Mac 没问题”。未读取消息正文或凭据，也未更改本机数据库。已向用户询问两端版本/Runtime 与 Windows 上其他受影响模型，等待实际配置比对。


## 2026-09-14 实施回写

用户随后明确授权修复，已落实停止覆盖与只读 legacy identity 兼容，详见 [执行记录](../exec-plans/completed/issue-685-route-identity.md)。上文“未修改产品代码”和临时期待 409 的 characterization 描述诊断时点；当前正式回归已断言新会话保持 route、旧会话同模型续聊成功。无 UI 变化，使用真实 POST 两回合验证服务端行为；没有把 HTTP handler fixture 声称为真实 Windows / SDK smoke。原建议中的数据库迁移未采用，选择不改 route/revision 的只读兼容。
