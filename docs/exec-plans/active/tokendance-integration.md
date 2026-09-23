# TokenDance 接入

状态：Shipped — v0.67.15 / Tests pass。正式 CI、20 资产与包内 TokenDance 接口/图标复核通过。用户已确认真实授权成功；真实生成与 packaged 授权 smoke 待执行。用户授权接入第三方 TokenDance（2026-09-05）。

## 问题与取舍

CodePilot 当前没有 TokenDance 预设。用户要求接入模型服务、API Key 授权、应用归因与失效恢复。官方 ai-integration、app-attribution、api-key-oauth、multi-protocol 文档及公开 `/gateway/v1/models` 已读取。目录含聊天、媒体、搜索等协议，不能把全部模型塞进聊天选择器。

当前采用单一 TokenDance 添加入口：Native/Codex 走 Chat Completions，Claude Code 走模型已声明支持的 Messages。历史 Anthropic preset 保留编辑/重授权。按 `supported_protocols` 筛选实时目录，只默认启用用户指定六款；沿用保守 probe/apply，不改变默认模型、旧聊天或用户隐藏项。授权获得普通 API Key，复用加密 provider 存储；已有连接的 protocol、ID、Key 保持不变。详见下方追加决策。

PKCE 使用 S256，动态 loopback callback 加随机 state；提供复制一次性授权码的备用方式。状态接口仅暴露 flow 状态/provider ID。取消、超时、重启授权使迟到结果失效，单次兑换不自动重试。Key 只在服务端保存，不返回前端。重授权沿用原 provider ID，不创建新聊天。

Native/Codex 使用受限 fetch 包装；Claude Code 经固定目标的本地 Messages 转发保留流，统一识别 `TokenDance-Recovery-Action`。请求固定携带 `X-App-URL: https://www.codepilot.sh/`，未知恢复头保留原错误。充值引导到官方管理页面，不代用户创建支付订单。

范围是现有聊天/Agent 服务接入；不添加视频、语音、支付产品。分润价格需要产品方 Key，当前未提供，不猜测或展示价格。

## 执行

- [x] 预设、协议筛选与归因 transport
- [x] 授权服务、取消/错误恢复与设置 UI
- [x] 回归测试、完整单测、隔离 Dev E2E
- [x] 技术交接、产品思考与 guardrail 回写

## 状态总览

| 阶段 | 状态 |
|---|---|
| 接入与授权 | 已完成；用户确认授权成功 |
| 精选模型与同连接 Claude Code | 已完成；定向、E2E 与全量测试通过 |
| 真实生成与 packaged smoke | 待执行 |
| v0.67.15 正式发布 | Shipped；CI、公开资产与包内功能存在性复核通过 |

## Smoke Ledger（初版历史证据；最新追加结果见末尾）

| 验证 | 结果 | 证据与边界 |
|---|---|---|
| 官方文档与公开目录 | 已读取 | 2026-09-05，协议取 `supported_protocols`；未使用真实 Key |
| 定向 Provider/TokenDance 回归 | 126 pass | 含 12 个 TokenDance 用例、真实 SDK/Codex proxy 请求捕获、Claude SSE、PKCE callback 与密文落盘；上游为 fixture |
| 全量 `CODEX_DISABLED=1 npm test` | 5536 pass / 1 skip / 0 fail | tsc、harness boundary、全量单测；日志 `/private/tmp/tokendance-full-tests.log` |
| 隔离 Dev E2E | 1 pass | 双预设入口、真实本地 start/status/cancel、S256/app_url、手动 Key；授权期间已填 Key 也不能重复保存；日志 `/private/tmp/tokendance-e2e.log` |
| ESLint / hooks / docs drift / diff check | 无错误 | 既有 PresetConnectDialog 仍有 unused err/max-lines 两项 warning；新文件无 ESLint 错误 |
| 真实 TokenDance 授权/计费/工具调用 | 授权由用户确认成功；生成未执行 | mock 不能证明 entitlement 或计费 |
| packaged Windows/macOS | 未执行 | 动态 loopback、系统代理、子进程 relay 需打包客户端复核 |
| 产品方分润价目 | 未查询 | 缺产品方 TokenDance Key，未伪造价格 |

## 发现与修正

- Dev E2E 发现 Next 内部 Request URL 的 localhost 与浏览器 127.0.0.1 不同，原始 Origin 校验会误拒绝；改用原始 Host authority，同时保留跨站拒绝回归。
- 全量预设测试原先假定除少数服务外都有内置默认模型。TokenDance 按实时协议目录接入，显式加入动态目录例外；保留其他预设检查。
- 既有 Key 生命周期测试把按钮完整表达式写死；授权互斥增加 `authorizing` 后，测试改为仍要求原 `!canTest` 条件并允许这项额外 gate。E2E 直接验证已填 Key 时授权期间无法重复保存。
- Claude 通用错误分类会把余额/额度折叠成鉴权错误；TokenDance 的精确恢复标记在普通模式匹配前保留为 userMessage，并提供充值/编辑连接动作。

技术交接：[tokendance-integration](../../handover/tokendance-integration.md)。未提交、未推送。


## 用户实测追加：授权后所有模型不可见（历史修复，后被精选方案收敛）

用户确认真实 TokenDance 授权成功，但三个 Runtime 都找不到模型。只读检查真实连接确认 64 行全部为 `enabled=0 / enable_source=discovered`。根因是 TokenDance 无内置白名单，而旧推荐规则只启用白名单或特定 Claude 命名；实时目录虽然正确按协议筛选，写入时却被全部默认隐藏，空 Provider group 随后被模型接口过滤掉。此前 E2E 用空发现结果，仅验证授权/保存，漏掉“能否选模型”的语义验收。

修复：TokenDance 的协议筛选结果直接作为默认启用集合；`applyDiscoveryDiff` 仍保护 manual_hidden/manual_enabled/user_edited。刷新可恢复系统隐藏的历史行，用户隐藏和修改项不动，不修改凭据/默认模型/会话。

验证：新增完整 probe → apply → model feed 单测，复现全隐藏状态并验证恢复、手动隐藏、未声明聊天协议的媒体项排除、vendor 前缀/preview 名称以及 Runtime 注解；原 E2E 改成非空目录，并断言真实 apply 和 feed；新增 Anthropic 连接三个 Runtime 的实际 picker E2E。定向 13 pass，隔离 Dev E2E 2 pass。全量 `npm test`：5537 pass / 1 skip / 0 fail（含 typecheck 与 harness boundary），日志 `/private/tmp/tokendance-visibility-full.log`；ESLint 与文档漂移检查通过。

真实本机恢复：通过当前项目 3000 端口正式 discover/apply 接口刷新用户已授权的 TokenDance，64 行系统管理模型被恢复，随后真实 model feed 返回 64 项，supportedRuntimes 为 Native/Codex。原连接是 OpenAI 协议，不伪造 Claude Code 兼容性；Claude Code 使用 TokenDance (Anthropic) 入口。未新建用户聊天、未更换或重新授权 Key。


## 默认精选模型与同连接 Claude Code（当前方案）

用户要求默认仅显示 GLM 5.3、Kimi K3、最新 MiniMax、DeepSeek V4 Flash/Pro、GLM 5.3 Flash，并确认同一个 TokenDance 应支持 Codex/Claude Code。重新读取 2026-09-05 官方目录与 Claude Code 文档：MiniMax 最新聊天型号是 minimax-m3；Kimi K3 仅声明 OpenAI Chat Completions，其他五款均声明 Anthropic Messages。

执行方案：默认启用精确六项，其他发现项保留隐藏，手动编辑仍保护。已有 tokendance 连接保留 protocol/base URL/Key/ID，不做协议迁移；Native/Codex 沿用原 Chat Completions，Claude Code 通过既有窄 Messages relay 使用同 Key。Runtime 能力按精确 TokenDance host + 上游公开模型协议快照投影，未知模型不宣称支持 Claude Code。同步 picker、route validation、resolver 与子 Agent；Claude env 使用官方文档规定的 AUTH_TOKEN。添加入口收敛成一条，保留旧 Anthropic preset 用于历史连接。验证精选名单、Kimi 反例、旧连接 Key/ID 不变、三个 Runtime 与实际 SDK/relay 请求。


实际本机：通过当前项目 Dev 3000 的正式 discover/apply 接口刷新原连接，随后真实 model feed 返回六个精选 ID；Claude Code 支持五个，Kimi K3 仅 Native/Codex。64 行仍保留，未重新授权、未创建用户聊天。此结果只证明本地目录与路由能力投影，不是上游生成成功。

## 最新验证与决策日志（2026-09-05，未提交）

| 验证 | 结果 | 证据与边界 |
|---|---|---|
| TokenDance 定向回归 | 15 pass | `/private/tmp/tokendance-curated-tests-final.log`；六项精选、同连接 SDK Messages、Kimi/未知模型/非官方 host/media 反例、显式角色保留与未映射角色回退、PKCE/归因/恢复 |
| 全量 `CODEX_DISABLED=1 npm test` | 5539 pass / 1 skip / 0 fail | `/private/tmp/tokendance-curated-full-authorized.log`；包含 typecheck 与 harness boundary。首次沙箱内 8 项因本地 listen EPERM 失败，允许监听后通过。最终角色回退补充后另跑定向与 typecheck |
| 隔离 Dev E2E | 2 pass | `/private/tmp/tokendance-curated-e2e.log`；单入口授权/保存/非空发现，同一连接三个 Runtime picker、Kimi Claude 不可见 |
| 本机真实连接目录 | 六项精选；Claude 五项 | 原 provider 正式 discover/apply 与 models feed，无 Key/协议/聊天迁移 |
| ESLint / hooks / docs drift / diff check | 无错误 | 改动文件 44 个既有 lint warnings，主要为大型组件的 unused/max-lines/native button；新文件无错误 |
| 真实上游生成 / packaged | 待执行 | 真实 SDK wire 上游为 fixture；不宣称 Claude CLI 多步 Agent 或真实计费已验证 |

决策：用户不需要为不同 Runtime 重复授权。用同一 Key 和连接按 Runtime 选协议，模型级兼容性有官方协议来源；默认六项、手动选择优先。Claude Code 文档要求角色映射到网关模型，未映射角色在本轮 env 使用已选模型，避免请求内置 Claude ID；显式映射保留，不写回用户配置。未提交、未推送。

## Claude 审查追加收尾（2026-09-05）

状态：Code complete / Tests pass；本次收尾定向、全量与隔离 UI 验证完成。已有 Review passed 仅覆盖本次收尾之前的改动。

- [x] P3-1：Provider 标签明确多协议；Models 筛选消费模型级 tier；Codex parity 按 TokenDance 的实际协议区分 adapter family。
- [x] P3-3/P3-4：文档只承诺排除未声明聊天协议的模型；不可用 reason 使用字典并按界面 locale 返回。局部内联双语符合 guardrail，不做无必要迁移。
- [x] P3-2：登记实时协议事实与静态快照并存的技术债，规定来源、刷新触发和验收反例，不在本轮改变 DB 能力存储合同。
- [x] 定向测试、全量测试与隔离 UI 验证；真实 Claude CLI/计费/packaged smoke 继续单列。


收尾验证：新增三项定向回归后 TokenDance 共 18 pass；隔离 Dev E2E 共 3 pass，新增实际 Providers badge/tooltip 与 Models 的 Kimi/GLM 交替筛选反例。日志 `/private/tmp/td-review-fixes-unit.log`、`/private/tmp/td-review-fixes-e2e.log`。界面没有将混合协议整组误归到 Anthropic 模板；字典测试覆盖英文理由不含中文、中文与 locale 设置一致。TTS 测试明确它可以按协议进入发现列表但默认隐藏。真实生成/CLI 多步/计费/packaged 不因这些测试升级状态。


最终验证：`CODEX_DISABLED=1 npm test` **5542 pass / 1 skip / 0 fail**（包含 typecheck 与 harness boundary，`/private/tmp/td-review-fixes-full.log`）；ESLint 0 errors（本次检查的大型 Settings 组件仍有 31 个既有 warning）；docs drift 与 diff check 通过。E2E 产生的 tsconfig include 经语义核对只移除 `.next-e2e-*` 派生条目并恢复原格式。未修改用户真实数据库或凭据，未提交、未推送。

决策日志：P3-1/P3-3 与仅中文 reason 已通过代码、文案和反例回归处理；P3-2 转技术债 #91，未声称实时协议持久化已完成；局部内联双语符合现有 i18n 合同，保持现状。R-1/R-2 等真实 smoke 风险仍开放。


## 官方 Logo（2026-09-05，用户追加）

已接入官网首页 favicon 指向的原始 SVG（来源与日期记录在 `public/provider-icons/README.md`）。共享品牌组件新增 tokendance，两个 preset 和名称/精确网关 URL 解析统一使用该图标，覆盖添加菜单、Providers/Models 与 Composer；保留品牌原色，本地加载。验证：既有图标规则 16 pass、typecheck 与目标 ESLint 通过；当前 Dev 真实服务商页面已截图确认黑底白色 Logo 显示正常。未提交。

## v0.67.15 发布准备（2026-09-05）

用户指出 v0.67.14 不应排除 TokenDance，并明确要求再发新版。本次 v0.67.15 纳入当前完整 TokenDance 改动：单入口 PKCE/手动 Key 授权、六项精选、同连接跨 Runtime 协议、错误恢复、多协议筛选、官方 Logo，以及测试、交接、产品思考和技术债 #91。未提交状态只表示需要先完成提交，不再据此自行排除用户要求的发布范围。

发布前全量 `CODEX_DISABLED=1 npm test`：5542 pass / 1 skip / 0 fail；正式 Next build 通过；ESLint 0 errors / 44 既有 warnings。隔离 Dev 3145 复跑 TokenDance E2E 3/3 pass。构建在 `/private/tmp/codepilot-release-0.67.15` 精确快照执行，核对 47 个发布范围文件与主目录一致，未打断主目录开发服务。证据 `/private/tmp/codepilot-0.67.15-{full-tests,build,eslint,e2e}.log`。

本会话已接受的真实账号/运行期 recovery/Codex soak 验证边界继续保留；TokenDance 真实授权与本机目录已验证，真实生成、CLI 多步、计费和 packaged 授权流程仍不记作通过。Release Notes 明示这些边界。签名、公证、三平台构建与公开更新资产审计仍为 CI 硬门禁。当前为发布准备，Shipped 待 CI 及公开资产复核。

## Shipped — v0.67.15（2026-09-05）

- [x] 完整 TokenDance 接入与版本文件提交：`ffe6b367ef2ab5397bac28ced7633ea2cc90f697`，47 文件；main 与不可变 `v0.67.15` tag 已推送。
- [x] 提交门禁 5542 pass / 1 skip / 0 fail；发布前 E2E 3/3、正式 Next build、lint/docs drift 通过。
- [x] [正式 CI 33957516830](https://github.com/op7418/CodePilot/actions/runs/33957516830) 全部 success：source、macOS 签名/公证/包健康、Windows、Linux 双架构、Intel universal ABI 与 release。
- [x] [公开 Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.15) 非 draft、非 prerelease、Latest=true、immutable=true，20 项精确版本资产齐全，正文与含 TokenDance 的 RELEASE_NOTES 一致。
- [x] 所有公开资产 API SHA-256 digest 与 checksum 对齐；实际下载 universal ZIP 与 Windows NSIS，两份 metadata 的版本、单一同版本 URL、大小、SHA-512、安装包 SHA-256、blockmap/checksum coverage 全部通过；无 Linux updater metadata。
- [x] 检查公开 universal ZIP 内的版本 0.67.15、TokenDance auth/gateway 编译路由及 manifest、包含 TokenDance 的 renderer chunks、与源码字节一致的官方 SVG；证明最终安装包确实包含该功能，不只依据源码提交。

决策日志：根据用户纠正完整发布 TokenDance，不以未提交为排除理由。状态为 Shipped；真实生成、Claude CLI 多步、计费、packaged 授权及前述运行期 smoke 缺口继续开放，包内存在性与启动期 health 不冒充这些验证。证据 `/private/tmp/codepilot-v0.67.15-public/{ci.json,release.json,latest.json,audit.log,tokendance-package-audit.log}`；首次包内功能存在性核验通过。
