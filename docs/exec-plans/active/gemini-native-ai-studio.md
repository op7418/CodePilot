# Gemini AI Studio Native 接入与能力补齐

> 创建时间：2026-09-18
> 最后更新：2026-09-22
> 发布状态：Shipped — v0.67.17（含9月19日工具参数修复与SDK执行校验）；正式CI和公开20资产审计通过，真实AI Studio问候已通过，完整工具执行/Windows会话smoke仍待执行。

## 用户目标与取舍

用户在三 Runtime 调研后明确授权先接 Native，同时对照 AI SDK 文档补齐 Native 的相关能力。产品目标是在官方 API 中添加 AI Studio key 后，能选择 Gemini 3.8 Flash 写作、调整思考深度、使用工具并持续修改文章。

采用已有 Google generateContent SDK；不切换服务端存储语义，不升级依赖。Gemini 此轮只开放 Native，Codex 与 Claude 暂不开放。补齐实际发现的历史状态、参数、输出截断缺口；已有 MCP、权限、来源展示和 usage 实现先核验，不重复建系统。

## 状态

| Phase | 用户可见变化 | 状态 | 验证 |
|---|---|---|---|
| 0 | 明确支持范围 | 已完成 | 官方网页 + 安装包内 AI SDK 文档/源码 |
| 1 | 官方 API 添加 AI Studio，Native 可选 3.8 Flash | Code complete | 预设/身份/Runtime 排除/目录 |
| 2 | 思考档位、工具与重开续聊完整工作 | Tests pass（离线） | 真 SDK + 模拟 Google SSE + 真 DB 多回合、Bridge owner gate |
| 3 | 能力审计与验证 | Tests pass；UI Smoke passed（fixture）；用户报告 Claude 已复核 | full 5584 pass / 1 skip，两份 spec 四 worker 并行 4 pass；真实 API 与 Windows packaged 尚未执行 |
| 4 | 修复已授权视频工具导致 Gemini 普通聊天 400 | Tests pass；Smoke passed（真实问候） | 定向 50/50；full 5590 pass / 1 skip / 0 fail；SDK 非法调用阻断及合法调用对照通过；真实问候通过，真实工具执行仍未验证 |

## 设计与回归边界

- 使用独立 google 文本 preset，图像 Provider 与 Vertex 不变；不改既有默认 Provider。
- 精确 3.8 模型规则：low/medium/high，默认 medium，always thinking；剔除不支持的采样参数。
- Native 从 AI SDK response.messages 保存每 step 的重放数据，绑定 Provider/model；只在相同路线回放。用户可见文本仍使用现有 content blocks，后续未完成 step 不丢弃；旧记录/换路由继续普通历史重放。
- 新的隐藏元数据不进入 UI 正文、状态提示或遥测日志；collector 沿用 owner gate。
- 截断保留已有输出并明确提示，不能把 token 上限结束当作完整写作。
- Native 能力审计记录在本计划，不能把 SDK 支持列表直接标成产品已支持。

## AI SDK 能力审计与本轮结果

| 能力 | CodePilot 当前状态与本轮处理 |
|---|---|
| Google 文本/流式/工具 | 复用已安装 AI SDK 7 + Google 4；新增 AI Studio preset、Google 原生连接测试，避免误走 Anthropic |
| 思考与参数 | 3.8 精确映射 low/medium/high，默认 medium；关思考/过高档位有调整通知；所有 generateText/streamText 剔除 temperature/topP/topK 与旧 thinkingBudget |
| 多轮工具与签名 | 本轮补齐逐 step canonical messages 的桌面/bridge 持久化与相同路线恢复；跨路线只带可见历史；已完成 step 后的 partial tail 不丢弃 |
| 长输出 | 仅 3.8 上限从通用 16,384 提升至 65,536；所有 Native Provider 的 length 结束都保留正文、结束循环并显示桌面本地化通知（非持久化消息标记）。如果该 step 已执行工具，不自动继续下一 step |
| 长对话压缩 | 所有 Native Provider 均修复重新读 DB 时忽略摘要覆盖边界的问题；摘要合并首条 user、保留附件，覆盖行剔除。签名元数据不重复计入估算。仍保留原先最多 200 行历史读取，不宣称无限上下文 |
| 模型发现 | 完整分页、ID 去前缀、方法过滤、去重；失败无 partial diff，key 不进 URL/错误体 |
| 文件/终端/MCP/权限/取消 | 已有 Native tool loop 与权限/中止机制，继续复用；全量单测验证既有行为，无需另造 agent 框架 |
| 来源与 Google 托管搜索/URL Context | SDK 支持，不等于产品已接；当前 Google 未装配这些 provider tools，本轮未开放 |
| PDF/音视频 | Google 模型支持不等于 Native 消息输入支持；现有 replay 是文本/图片，本轮未添加 PDF 能力承诺 |
| Usage/缓存 | 沿用 SDK 真实 token 用量；Google cache 明细尚未完整映射，保持未知，不填假 0；本轮不扩展会计 schema |
| Interactions API | 已安装 SDK 有此能力，但改变服务端存储/续接语义；本轮保持 generateContent，无依赖升级 |

## 初轮验证记录（P2 follow-up 结果见文末）

- `npm run test`：typecheck、Harness boundary、5581 pass / 1 skip / 0 fail。
- `gemini-native.test.ts`：7 个行为回归，使用真实 AI SDK、模拟 Google wire、真实隔离 DB；包括完整工具 round-trip、正文签名、换路线、截断、摘要边界、bridge/stale owner、连接失败脱敏、发现分页。
- ESLint：新增文件无错误；触及既有大文件的检查保留已有 warnings，未扩大清理范围。
- Playwright `gemini-native.spec.ts`：1 passed（15.6s）；真实设置页添加/保存 AI Studio、连接测试请求协议、真实 models API 三 Runtime 过滤、聊天框选择 Gemini 与 1M 上下文显示。连接/发现网络使用 fixture，截图 `/tmp/gemini-native-composer.png` 已目视检查。
- `lint:hooks`、`lint:docs-drift`、`git diff --check` 通过。初次 UI 测试使用旧设置 query 路由及默认 Claude lane，修正为当前设置导航和显式 Native 后通过；不改变应用默认 Runtime。
- 不使用真实凭据；fixture 仅证明本地协议/持久化与 UI，不证明 Google 账户权限、配额、真实签名服务端校验或模型写作质量。

## 文档依据

- [AI SDK Google](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)；网页抓取不稳定，使用已安装 `@ai-sdk/google/docs/15-google.mdx` 对照实际 4.0.6 实现。
- [AI SDK 文本生成](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)、[工具调用](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)。
- [Gemini 3.8 迁移](https://ai.google.dev/gemini-api/docs/latest-model)。
- [前期调研](../../research/gemini-ai-studio-three-runtimes-2026-09-18.md)。

## Smoke Ledger

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|---|---|---|---|---|---|---|---|
| 2026-09-18 | Native | AI Studio | gemini-3.8-flash | 尚未使用真实 key | 真实模型写作/工具/续聊 | 未执行 | 不以离线 fixture 代替 |
| 2026-09-18 | Native | AI Studio | gemini-3.8-flash | fixture，无上游请求 | 添加服务/协议/真实过滤 API/聊天模型选择 | UI Smoke passed | `gemini-native.spec.ts` 1 pass；`/tmp/gemini-native-composer.png` |
| 2026-09-18 | Native | AI Studio | gemini-3.8-flash | 无 | Windows/macOS packaged 真实调用 | 未执行 | 本轮只验证 macOS 源码/本地 web UI |
| 2026-09-18 | Native / TokenDance 三 Runtime picker | AI Studio + TokenDance | fixture 模型 | fixture，无云端调用 | 两份 spec 四 worker 并行：添加/授权取消/模型选择/兼容筛选 | UI Smoke passed：4/4 | `/tmp/gemini-review-parallel.log`，15.8s；Gemini 使用 page-scoped 语言 |

## 决策日志

- 2026-09-20：P3-2 临时复核转为正式 SDK SSE 回归，新增 7 拒绝与 6/10 执行对照；定向 50/50、typecheck + Harness boundary + full 5590 pass / 1 skip / 0 fail（28.7s）。未提交，完整审查裁决未收到，不标记 Review passed。

- 2026-09-19：用户报告真实问候 400 并授权修复。工作区未提交；选择仅修 Native 视频工具的数字枚举声明，不升级 SDK、不将时长改为字符串、不移除视频能力。修前新增回归 2 pass / 1 fail，修后定向 47/47；真实原会话问候成功。全量首次因沙箱禁止 loopback listen 导致 8 fail；允许本地监听后，typecheck + Harness boundary + 5587 pass / 1 skip / 0 fail（28.8s）。
- 2026-09-18：用户授权实现，仅 Native；保留现有工作区中 #685 等未提交改动。
- 2026-09-18：Code complete + Tests pass；本地 UI fixture smoke 通过。未 commit/push/发版；真实 API smoke 保持待执行。

## Claude 独立审查跟进（2026-09-18）

用户回传审查：无 P1，P2-1 是压缩后连续 user wire 风险，P2-2 是 Gemini spec 写全局设置导致并行 TokenDance 页面失败。独立原版本 full 5581 pass / 1 skip、Gemini UI 1 pass、TokenDance 单独 3/3 不构成这两项关闭证据。

- **P2-1 Signal/Triage**：真实 Google SDK 的 converter 不合并连续 user。先补协议回归，在旧实现下 current-only / retained-text / retained-image 三项均失败，wire 实际出现连续 user；assistant-first 对照通过。未使用真实 Key，不能声称已复现 Google 服务端 400。
- **Fix**：摘要合并进首条 user 内容；字符串拼接、multipart 前置 text part，其余附件原样保留。历史以 assistant 开头时仍用独立摘要 user，保证不产生新的同角色相邻消息。不把摘要提升为 system，不改签名/工具历史。
- **P2-2 Fix**：移除测试对共享 locale/agent_runtime 的 PUT，仅在当前 Playwright page 的 GET 响应中覆盖显示语言；Runtime 由已有 picker 显式选 Native。拒绝只在 finally 还原全局设置的方案，因为并行窗口依然存在。
- **Verify**：定向 10/10 通过，四种压缩边界均检查真实 SDK wire 角色、摘要恰好一次、旧行排除；图片对照检查 inlineData 原字节未丢。两份 spec 四 worker 并行 4/4（15.8s）；`npm run test` typecheck + Harness boundary + 5584 pass / 1 skip / 0 fail（31.2s）。scoped ESLint 0 error / 4 处原有 warnings。日志：`/tmp/gemini-review-before.log`、`/tmp/gemini-review-targeted.log`、`/tmp/gemini-review-parallel.log`、`/tmp/gemini-review-full.log`。
- **Guardrail**：Runtime 明确摘要合并、多模态保留、压缩与 length 的 Native-wide 范围。非阻塞 P3 记录到 tech-debt #92–94；本轮不扩展传输/存储结构或测试 runner 重构。
- **残余**：真实 AI Studio 写作/工具/压缩后再发/签名校验，Windows packaged 多 Provider 三轮与重开仍待执行。#685 历史 upstream 无唯一 live 映射时，升级后仍需显式重选，不承诺全部自动恢复。

2026-09-18 用户补充“刚才修复那两个 Claude 复核了”。记录为用户已报告 Claude 完成复核；当前消息未附复核裁决原文，不虚构新增测试或扩大真实 smoke 的验证范围。以上修复与测试证据保持有效。

- 2026-09-18：用户明确授权正式发版；准备 v0.67.16，真实 API / Windows packaged 缺口写入 Release Notes，不以发布授权冒充 smoke 证据。

## v0.67.16 发布准备（2026-09-18）

用户明确授权发版，Jev 暂不接入。范围为 #685 路由身份、Gemini Native、TokenDance 卡片位置，以及工作区已有的保存失败/快捷建议修复；不新增依赖或改变分发拓扑。

- 最终全量：typecheck + Harness boundary + 5584 pass / 1 skip / 0 fail（28.4s），日志 `/tmp/codepilot-06716-test.log`。
- Gemini/TokenDance 隔离 UI：四 worker 4/4（16.2s），日志 `/tmp/codepilot-06716-ui.log`。
- `package.json` 与 lock 均为 0.67.16，仅版本字段变化；离线 npm install 因缓存缺失未完成，改用 npm version 同步，未刷新依赖解析。
- 管理员 API 实测 Immutable Releases enabled=true；main / stable-release-tags active、无 bypass/exclude、ID/更新时间与确认状态一致。确认日期已更新为 2026-09-18，18 个发布 Action 均使用精确 SHA。
- Release Notes 明示真实 Gemini 与 Windows packaged 缺口，不宣称该部分 Smoke passed；CI 将执行签名、公证、三平台启动与资产图门禁。尚未标记 Shipped。

- 保存失败提示独立隔离 UI：5/5 通过，日志 `/tmp/codepilot-06716-save-ui.log`；已清理本次 E2E 自动生成的 tsconfig 路径，保留原配置。

## Shipped — v0.67.16（2026-09-18）

- [x] 提交 `17c716c6f3ca613e2e52bf18cebca8afa5eabe63`（61 文件）；main 和全新不可变 `v0.67.16` tag 已推送。正常 pre-commit 的 lint、typecheck、boundary、5584 pass / 1 skip 全通过。
- [x] [正式 CI 35357476827](https://github.com/op7418/CodePilot/actions/runs/35357476827) 全部 success：source、macOS 签名/公证与包健康、Windows、Linux 双架构、Intel universal 启动/SQLite、release。
- [x] [公开 Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.16) 已于 2026-09-18 15:24:23 UTC 发布；非 draft、非 prerelease、Latest=true、immutable=true，精确 20 资产，正文与 RELEASE_NOTES 一致。
- [x] 全部公开资产 API SHA-256 digest 与 checksum 对齐；实际下载 universal ZIP、Windows NSIS、两份 metadata 和全部 blockmap，验证下载字节 SHA-256、metadata 版本/单一同版本 URL/size/SHA-512 与 checksum coverage；无 Linux updater metadata。临时独立审计脚本初次未归一化 checksum 合法 `./` 前缀而失败，修正后通过，非发布资产问题。
- [x] 公开 universal ZIP 内 Electron 与 standalone 版本均为 0.67.16；编译产物包含 AI Studio preset、Gemini 3.8、native_step 和保存失败提示码。仅作功能存在性证据，不替代真实调用。

证据目录：`/private/tmp/codepilot-v0.67.16-public/` 的 `ci.json`、`release.json`、`latest.json`、`audit.log`、`package-audit.log`。Jev 按用户决定未接入。真实 Gemini 写作/工具/压缩后续聊、Windows 多模型三轮与重开、旧有运行期恢复/soak 仍保持未验证，不因 Shipped 自动关闭。

## 真实问候 400 修复（2026-09-19）

- **Signal / Triage**：用户在 Dev 的 `cfc4d79370fe97ed2661999b602cfc9a` 会话只发“你好”，Gemini 返回 `400 INVALID_ARGUMENT`，定位 `function_declarations[15]` 的 `duration.any_of[*].enum` 数字 6/10。Grok OAuth 可用时，Native 自动挂载 `codepilot_generate_video`；模型选择工具之前就会校验所有声明，因此影响普通聊天。原离线回归只用 lookup 工具，未覆盖真实媒体工具集。
- **Fix**：`builtin-tools/media.ts` 的 duration 改为 `z.number().pipe(z.union([z.literal(6), z.literal(10)]))` 并添加取值描述；SDK 使用输入 JSON Schema，执行验证仍保留严格数值范围，输出给视频 backend 的类型保持 `6 | 10`。无需改 Google 请求 transport、MCP/Codex schema 或依赖。
- **Verify**：新增媒体工具 gate false/true 的实际 Google SDK wire 对照，递归检查 enum 值，校验数值类型及取值描述；另测省略/6/10 接受、0/7/小数/负数/字符串/null/布尔拒绝。修前 gate=true 测试失败，其他两项通过；修后 Gemini + Native media + xAI Imagine 47/47。全量 `npm run test` 在允许本地监听的环境下通过：typecheck + Harness boundary + 5587 pass / 1 skip / 0 fail（28.8s）。
- **Guardrail**：`Runtime.md` 固化真实工具装配和 Google 参数枚举兼容边界。依据：[Google FunctionDeclaration / Schema](https://ai.google.dev/api/generate-content) 与本地 `@ai-sdk/google` 的 `google-prepare-tools.ts` / `convert-json-schema-to-openapi-schema.ts`。
- **独立残余**：Dev 日志中的 notify/widget/memory 工具 factory 与 Harness Home loader `is not a function` 仍未修复，不属于本次枚举 400 根因；不能将此次问候成功解读为这些能力可用。

- [x] 离线复现原错误及工具授权 gate 反例。
- [x] 修复参数声明并保留执行验证。
- [x] 定向 47/47、scoped ESLint、真实原会话问候通过。
- [x] 全量回归、scoped ESLint、hooks lint、docs drift 与 diff whitespace 检查。

### 补充 Smoke Ledger

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|---|---|---|---|---|---|---|---|
| 2026-09-19 | codepilot_runtime | 用户当前 AI Studio Provider | gemini-3.8-flash | 已配置 API key；未输出凭据 | Dev 原会话 POST /api/chat，保留包括视频在内的 24 工具，请求仅回复问候 | Smoke passed：正文“你好”、finishReason=stop、toolsUsed=[]、DB assistant completed | session `cfc4d79370fe97ed2661999b602cfc9a`；`/tmp/gemini-schema-live.sse`；未触发视频生成或工具执行 |

本次离线日志：`/tmp/gemini-schema-before.log`、`/tmp/gemini-schema-targeted.log`、`/tmp/gemini-schema-full.log`（sandbox listen 失败）、`/tmp/gemini-schema-full-unrestricted.log`。未提交、未推送、未发版。


## P3-2 SDK 执行验证补充（2026-09-20）

用户转述独立复核的补充：临时脚本已清理，建议将非法工具调用的 SDK 级验证正式纳入仓库。当前仅收到补充，没有收到完整 findings 或审查裁决，不据此标记 Review passed。

- [x] 在 `gemini-native.test.ts` 使用生产 `createMediaTools`，只覆盖 execute 为记录参数的 stub；模拟 Google SSE 返回视频 functionCall，交给真实 `streamText` 消费。
- [x] duration=7：断言对应 tool-call.invalid=true、同 call ID 的 tool-error、无 tool-result、execute 零调用。
- [x] duration=6/10：各断言正常 tool-result、无 tool-error、execute 恰好一次且收到原数值，避免用“所有工具都不执行”的假通过代替校验。
- [x] 定向 Gemini / Native media / xAI Imagine 50/50，scoped ESLint 通过；仅 fixture，无真实视频调用。
- [x] 全量 typecheck + Harness boundary + 5590 pass / 1 skip / 0 fail（28.7s）；hooks lint、docs drift 与 diff whitespace 检查通过。

验证日志：`/tmp/gemini-sdk-validation-targeted.log`、`/tmp/gemini-sdk-validation-full.log`。仅测试与现有文档追加，仍为原来的 5 个工作区改动文件，未提交。

## v0.67.17 发布准备（2026-09-22）

用户明确授权发版。数字 duration wire schema 与 SDK 执行校验单独提交，未与 Memory 修复混合；当前完整工作区门禁5704 pass / 0 fail / 1 skip。真实问候证据沿用09-19，完整工具生成/Windows packaged smoke仍不冒称已验证。提交后由正式tag CI完成签名/公证/三平台资产门禁。


## v0.67.17 发布结果（2026-09-22）

数字duration声明修复与SDK非法调用阻断回归随 [v0.67.17](https://github.com/op7418/CodePilot/releases/tag/v0.67.17) **Shipped**，tag指向4ddcd1a0f7931fc2ba3d3a1cf2802782bdc4712e。[CI 35679941503](https://github.com/op7418/CodePilot/actions/runs/35679941503)全部成功；公开Release为Latest、immutable、非draft/prerelease，20资产及实际Mac/Windows更新包SHA-512/size/blockmap核验通过。公开universal ZIP的app与standalone版本均0.67.17。

证据见 `/private/tmp/codepilot-v0.67.17-public/` 的ci.json、release.json、latest.json、audit.log、package-audit.log。真实完整工具执行与Windows会话smoke仍待执行；发布不替代这些验收。
