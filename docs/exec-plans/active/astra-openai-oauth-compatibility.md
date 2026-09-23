# Astra / OpenAI OAuth 兼容修复

> 创建时间：2026-09-05
> 最后更新：2026-09-05

## 用户问题与取舍

用户要求核对 Astra 在 Codex 的窗口和 OpenCode 最新授权实现，随后明确授权修复。源码对照及离线复现见 [调研](../../research/astra-fable51-adaptation-2026-09-05.md)。当前 OAuth 固定目录滞后，SDK 会丢 Astra reasoning，刷新并发/临时失败会清掉登录状态。API 的 1.05M 不能作为 Codex 默认窗口。

用户验收：OpenAI OAuth 登录后在原聊天选择新模型、调整 effort；临时网络失败重试不要求重新登录；退出/重登录不会被旧请求覆盖。保持原聊天、Runtime owner 和既有默认模型；不触发新聊天或自动账号迁移。Fable 协议适配、device flow、WebSocket、发版不属于此轮授权的四项修复。

## 状态

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 1 | refresh 单次执行、永久/临时错误分类、原子写入与过期请求防护 | Code complete |
| 2 | 同 OAuth 凭据发现目录、缓存隔离、Astra capability/effort | Code complete |
| 3 | API/Codex 预算区分、Codex 分页及视觉能力 | Code complete |
| 4 | targeted/full tests、旧聊天 E2E、guardrail 回写 | Tests pass；真实授权生成未执行 |

## 契约

- 并发刷新共用 promise；同账号快照才能回写，退出/换账号使旧请求失效。refresh token 轮换和 account metadata 在同一 DB transaction 中保存。
- 仅明确 grant/revocation 错误清凭据；网络、429、5xx 和未知错误保留凭据并返回可重试错误，不将旧过期 bearer 继续发出。
- 模型目录使用独立 OAuth 的凭据请求 Codex backend，不能借用 app-server 账号。失败用同账号缓存/明确兼容目录；目录只代表候选，不证明生成 entitlement；成功空目录必须保留为空。
- reasoning 仅按模型能力启用，用户选择必须精确到 wire，不静默退为 medium。Codex `ultra` 继续保持原产品边界。
- Astra 默认 Codex 有效窗口 258400；API 1050000。无 transport 事实时不填假窗口，实际 runtime usage 继续优先。保守历史预算不冒充用量。
- bearer 与 residency 仅发往精确 Codex endpoint，禁止重定向外传。

## Smoke Ledger

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-05 | 离线 | OpenAI OAuth | Astra | 假 token / 内存 fixture | 修复前并发刷新、断网、SDK max wire | 已复现 | 调研文档中的 5 项结果 |

## 决策日志

- 2026-09-05：新源码目录在 `/private/tmp` 独立 checkout；现有站点和上轮聊天修复保留，不混入本轮改动。授权凭据存储继续兼容旧 key，但用一笔 SQLite transaction 防止半写入，避免引入独立数据迁移。


## 验证结果（2026-09-05）

- `CODEX_DISABLED=1 npm test`：typecheck、Harness boundary、完整单测通过，5508 pass / 1 skip。日志 `/private/tmp/codepilot-astra-full-final.log`。
- Targeted OAuth / Native wire / Codex model / context：65 pass（随后新增的项目 config/read 与窗口覆盖两例也进入上述 full suite）。日志 `/private/tmp/codepilot-astra-target.log`。
- 隔离 Dev（3136）+ 浏览器：旧聊天 GLM 内换模型、同 Runtime 换 DeepSeek、历史消息/产品会话 ID 保留与 GLM identity conflict 两例，共 3 pass。日志 `/private/tmp/codepilot-astra-e2e.log`。自动测试创建的数据库及服务均隔离于用户日常数据。
- 改动文件 ESLint：0 errors，9 个既有 unused 警告；新增模块/测试及模型目录文件单独 lint clean。docs-drift / diff-check 通过。
- 防回归合同回写 `Onboarding.md`、`Runtime.md`；公共模型目录与 token smoke 的历史失败记录保留在调研，不冒充修复后真实上游结果。

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-05 | CodePilot Native | OpenAI OAuth | gpt-6-astra | 假 token，拦截真实 SDK fetch | runAgentLoop 的 max / bearer / account / residency | pass（wire，非生成） | openai-oauth-compatibility.test.ts |
| 2026-09-05 | Claude Code / Codex | GLM → DeepSeek | sonnet/haiku → deepseek-v4-flash | 隔离数据库 fixtures | 旧聊天 Picker 原地换模型/Provider | 3 E2E pass（不发上游推理） | old-chat-model-route + model-identity-conflict |
| 2026-09-05 | Codex | Codex Account | gpt-6-astra | fake app-server + 本地模型 metadata | config/read(cwd)、1M 覆盖 clamp 为 828400 有效窗口、较小覆盖 95000 | pass（协议/预算） | codex-models-dual-schema.test.ts |

## 剩余验证边界

## 2026-09-05 独立审查后续与 Fable 5.1

用户明确要求修复审查中确认的问题，并完成 Fable 5.1 基础适配；此授权扩展上文原始范围。状态：Code complete + Tests pass；真实账号 smoke 待验证。

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 5 | OAuth 非阻塞目录、格式异常与真空区分、effort/空目录恢复提示 | Code complete + Tests pass |
| 6 | Codex 冷缓存能力恢复与代理 wire 回归 | Code complete + Tests pass |
| 7 | Fable 5.1 精确目录、参数/历史合同与验证 | Code complete + Tests pass |

- [x] OAuth 后台刷新保留同账号有效缓存；未知 visibility 不默认可见；真空目录保持为空。
- [x] effort 失效与无默认模型给出可恢复错误，不静默降档。
- [x] Codex 已运行的执行路径在冷缓存时有界发现能力；补真实 SDK 代理请求捕获。
- [x] Fable 5.1 作为独立选项，保留旧模型/角色默认；验证 adaptive、effort、工具选择和历史 prefix。
- [x] targeted/full tests、文档与 Smoke Ledger 回写。

决策：模型发现不应阻塞所有 Provider；拒绝缺少 visibility 即可见的建议。Fable 依据官方 overview 与 migration-guide（2026-09-05 核实），不将新增 beta 能力、自动模型 fallback 或真实 entitlement 冒充基础接入。

本机独立 OpenAI OAuth 未登录，因此真实账号发现、token rotation、Astra 文本/工具生成及长上下文 smoke 未执行；不能以候选目录或模拟 wire 宣称上游 entitlement 已通过。没有升级 CLI/SDK、改默认模型、修改真实 OAuth 凭据或发版。实现状态为 Code complete + Tests pass，未标记真实账号 Smoke passed / Release ready。


### 后续验证与决策日志

- 2026-09-05（工作区改动，尚未提交）：针对独立审查的五项建议修复确定路径。目录刷新不再阻塞全局 GET；Composer 在 pending 时有界轮询，不要求离开旧聊天。缺失/未知 visibility 视作发现失败，保留同账号有效缓存并按冷却重试，真实空列表仍为空。空目录默认解析与失效 effort 返回明确恢复指引，live SSE 与已保存错误均有中英文文案。Codex 代理对本地 effort 校验返回 invalid_request，避免抛出未封装异常。
- Codex replacement 冷缓存仅使用执行路径已有 client 进行 2.5 秒有界发现，不从被动列表启动进程；失败仍明确降级图片，不声称恢复像素成功。
- Fable 5.1 新增精确 catalog/upstream 与 1M 窗口；继承已经验证的 adaptive/effort sanitizer，没有重写原本正确的参数逻辑。默认角色与 Fable 5 不迁移；不新增强制工具或 beta fallback。Native 多步真实 SDK wire 中 system/tools/shared messages prefix 一致，thinking signature 原样回放；跨产品回合的 DB history 本就不重放旧 thinking，模型切换/摘要后的恢复保留可见正文。
- `CODEX_DISABLED=1 npm test`：typecheck + Harness boundary + 5518 pass / 1 skip。`/private/tmp/codepilot-review-fable-full.log`。
- 定向 OAuth/Codex 45 pass；Fable 5.1 3 pass。分别见 `/private/tmp/codepilot-review-followup-target.log`、`/private/tmp/codepilot-fable51-target.log`。最初 tsx 被沙箱拒绝本地 IPC，获准运行后通过，未绕过测试。
- 隔离 Dev 3137：2 E2E pass；Fable 5 → 5.1 → Fable 5 → Opus 的旧聊天选择路径（初始 Fable 5，依次点击 5.1、5、Opus），中文恢复文案、pending 后目录更新、消息/会话数不变；另覆盖三 Runtime 下原有 GLM/DeepSeek 切换。`/private/tmp/codepilot-review-fable-e2e.log`。

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-05 | Codex proxy | OpenAI OAuth | Astra | 假 token + 拦截真实 SDK fetch | max、store、account/residency；目录缩窄后结构化拒绝 | pass（wire） | openai-oauth-compatibility.test.ts |
| 2026-09-05 | Native | Anthropic official | Fable 5.1 | fixture key + SSE responses | adaptive/max、auto 工具、两步签名/prefix 保持、旧历史切模型 | pass（wire，非真实上游签名校验） | fable-5-1-model.test.ts |
| 2026-09-05 | Native / 全 Runtime 路由 | Anthropic / GLM / DeepSeek | Fable 5.1 等 | 隔离 DB fixtures | 旧聊天选择模型、中文提示、目录刷新 | 2 E2E pass | fable51-review-followup + old-chat-model-route |

剩余真实路径：OAuth 登录/轮换、Astra 生成/工具/长上下文、Codex 历史图片视觉识别、Fable 5.1 真实账号（含严格 prefix 校验）及 Claude Agent SDK 实际生成。本轮没有真实凭据调用，不能标记 Release ready。

- 最后补充后台刷新失败反例：已加载的模型目录不能被一次后台 503 替换成 synthetic env。浏览器等待列表可见后注入失败，1/1 复测通过，日志 `/private/tmp/codepilot-review-fable-e2e-counterexample.log`。初版测试按请求序号注入，受到 Dev 首次请求取消影响，已改为按“列表已显示”的真实状态注入；未降低产品断言。最终 tsc、docs-drift、diff-check 通过；ESLint 0 errors / 17 warnings（涉及文件已有 warning）。测试生成的 tsconfig include 已按语义核对后清理。

### 第二轮独立审查与调用方补查（2026-09-05）

用户提供基于 `3db317e7` 的未提交 diff 审查：无 P1/P2 blocker，上轮五项 P3 与代理 wire 缺口已实质修复，Fable 5.1 基础接入通过；追加 P3-6 resolver 抛错调用方审计与 P3-7 空目录完整发送/UI 测试缺口。状态为 Review passed（当前范围）；不是 Release ready。审查者本轮仍有四个环境失败，不能把失败自动计成通过；本方实际全量通过证据仍以 `/private/tmp/codepilot-review-fable-full.log` 的 5518 pass / 1 skip 为准。

P3-6 静态补查：`resolveProvider` 只有 effective provider 明确为 openai-oauth 才进入该新分支，且须 model/sessionModel 均为空、目录也为空。无参数的 Doctor/默认后台解析不会仅因 OAuth 空目录进入该分支。正常 chat/task/route validation 在前置检查中要求非空会话模型；标题的 resolveExactProvider 由 generateSessionTitle 捕获并返回 provider-unavailable；子模型枚举捕获跳过不可用 Provider；上下文压缩、memory、onboarding/checkin、transport detection 有上层错误/降级边界；Settings effective provider 对虚拟 Provider 直接返回 identity 并有 catch。未发现正常后台/被动路径因此出现未处理异常的具体证据，不采用 resolver 全局吞错或恢复空 model 的建议。该结论为调用链静态核验，不冒充对所有异常历史数据的运行测试。

P3-7 仍作为明确测试缺口保留：需要空目录 + 未选模型在可达入口的完整错误呈现回归（正常旧聊天发送已有非空 model 前置门，不应构造不可达状态宣称验证真实用户链路）。现有测试证明 resolver 拒绝及 effort 错误渲染，不能代替该项。此轮补查仅更新记录，产品代码与既有验证结果未改；工作区尚未提交。


## v0.67.14 发布决定（2026-09-05）

用户在收到具体候选范围与未验证风险说明后再次明确要求发版。本次发布候选基于 `ec3b53d7`，包括已提交的聊天续接、Astra/OAuth/Fable 5.1 与官网更新，不包含原工作区未提交的 TokenDance 接入。隔离候选 `CODEX_DISABLED=1 npm test`：5518 pass / 1 skip / 0 fail，正式 Next build 通过；日志 `/private/tmp/codepilot-release-candidate-tests.log`、`/private/tmp/codepilot-release-candidate-build.log`。

用户接受本次真实账号生成、各平台 packaged runtime recovery 与 Codex 至少 15 分钟 warmup soak 尚未完成的风险，允许直接发布；这些项目仍为未验证，不记作 Smoke passed。Release Notes 已列明。签名、公证、三平台构建、公开资产与自动更新 metadata 门禁继续执行，不因这次决定豁免。管理员 API 已确认 Immutable Releases enabled=true，main 与 v* ruleset active、无 bypass/exclude；确认变量已按真实状态刷新。发布准备时等待 tag CI 终态及公开资产复核；最终结果见下方 Shipped 记录。

提交门禁环境诊断：worktree 的 Git hook 继承 `GIT_DIR`，导致 Git 初始化测试把全新临时目录误认为现有仓库；显式注入该变量复现 1 fail，清洁环境 2 pass。仅为本次提交使用临时 hook wrapper，清理 Git 局部环境变量后完整执行原 `.husky/pre-commit`；没有跳过测试、改写产品代码或持久修改 hooks 配置。证据 `/private/tmp/codepilot-release-git-env-{repro,clean}.log`。


### Shipped — v0.67.14（2026-09-05）

发布提交 `024041d3fc6cc3918bdc68cd60aeae1649280965` 已推送 main 与不可变 tag `v0.67.14`。[正式 CI 33950667504](https://github.com/op7418/CodePilot/actions/runs/33950667504) 全部 success：source、macOS、Windows、Linux x64/arm64、Intel universal ABI、release 均通过。macOS 签名、公证、Gatekeeper 与 packaged 启动门禁由正式 CI 验证。

[公开 Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.14) 已复核非 draft、非 prerelease、Latest=true、immutable=true、20 项精确版本资产齐全；Release 正文与候选 RELEASE_NOTES 一致。全部公开资产 API SHA-256 digest 与 checksum 对齐；实际下载 universal ZIP（269131558 bytes）与 Windows NSIS（154550314 bytes），两份 metadata 的 version、单一同版本 basename URL、size、SHA-512 与下载字节匹配，更新包 SHA-256、外置 blockmap/checksum coverage 通过，无 Linux updater metadata。证据 `/private/tmp/codepilot-v0.67.14-public/{ci.json,release.json,latest.json,audit.log}`。

状态为 Shipped。此前用户接受的真实账号生成、运行期 recovery、Codex 15 分钟 soak 和真实 Windows 升级 smoke 缺口仍开放；启动期 package health 与资产审计不代替这些验证。TokenDance 未提交改动未包含在本 tag。
