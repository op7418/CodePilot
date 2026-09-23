# Sentry 免费额度与旧项目上报调查

> **实施跟进**：用户随后已授权修复，工作区实现与验证见 [Memory Runtime 解耦执行计划](../exec-plans/active/memory-runtime-decoupling.md)。本文中的“尚未修改/待修”和源码行号描述调研时的 v0.67.16 基线；离线旧行为探针须在该基线运行，不代表修复后的预期结果。线上统计仍为文中指定时间的快照。

> 2026-09-21 约 12:30（Asia/Shanghai）快照；只读调查，未修改线上配置或产品代码。组织 codepilot-rg；源码基线 HEAD 67507a0 / v0.67.16。

> 后续深挖已隔离复现：Claude settings-only 凭据被错误视为辅助 AI SDK 可用，三场景发网前 LoadAPIKeyError 被归 unknown；与正式 v0.67.16 代码一致。详见 [原因与解耦报告](memory-runtime-root-cause-2026-09-21.md)。未将这条根因外推到全部历史事件。

## 用户问题与结论

用户反馈免费额度耗尽，怀疑旧项目没有删除，持续上报并污染额度。调查分别读取真实计费状态、按项目的接收/拒收统计、已存事件聚合与安全样本，再与代码比对。

1. **此前确实耗尽，目前已经重置。** 账单 API 的当前周期为 2026-09-18 至 2026-10-17，Developer 免费计划，error quota 5,000，已用 533（10.66%），`usageExceeded=false`，Pay-as-you-go 未启用。最近日统计中的 `error_usage_exceeded` 出现在 9/13–9/18，9/19 后没有观察到该拒收原因。用户所见警告很可能对应上个周期；本次没有看到用户警告的具体时间/页面，不能断言 UI 缓存故障。
2. **旧项目还在收，但新项目才是多数。** 按上周期日期重建的统计中，新桌面项目占约 78%，旧项目约 22%。旧项目只是保留历史且不再收新事件时，不会持续消耗额度；此处已证实它仍在接收。
3. **后台辅助功能占据大量事件。** 新项目最大的三组 `provider.unknown_failure` 合计 2,056 条，占近 30 天桌面已存事件约 57%。三组最新样本分别来自自动记忆提取、快捷建议、记忆重排。不能把这些事件都算成主聊天失败或崩溃，也不能用一个最新样本替代整组逐事件场景统计。
4. **确有混入来源的迹象。** 旧项目近 30 天已存事件中有 285 条 release 不以 `codepilot@` 开头，约占 31%；新项目也有 2 条。版本名称不是发送者身份证明，只能支持共享 DSN / 下游改包等排查方向，不能直接认定恶意滥用。
5. **建议先治理接收入口和高频辅助失败，暂不靠升级套餐解决。** 删除已接受的历史事件不会退还已用额度；禁用旧入口会同时失去仍在使用旧 CodePilot 的错误数据，需明确取舍。本轮没有删除、禁用、调额或评论任何线上项目。

## 真实计数与口径

| 时间窗口 | codepilot-desktop 接受 error | javascript-nextjs 接受 error | 合计 | 因 error 额度拒收 |
|---|---:|---:|---:|---:|
| 按前一周期日期重建：8/18 00:00–9/18 00:00 UTC | 3,891 | 1,112 | 5,003 | 706 |
| 本周期日期起点：9/18 00:00–9/21 查询时 | 447 | 88 | 535 | 16（均在 9/18） |
| 近 30 天小时统计窗口 | 3,596 | 916 | 4,512 | 720 |

- **正式计费状态以账单接口的 533/5,000 为准。** 上表为 `stats_v2` 的 ingestion 统计，不能伪称逐条账单对账；端点时间粒度、账务更新与周期切换会有小差异。本周期 16 条拒收仍处于 9/18 切换当天，不能据此声称现在仍超额。
- 近 30 天 stats 请求 `2026-08-22T04:30:00Z → 2026-09-21T04:30:00Z`，响应向小时边界取整为 `04:00 → 05:00`；后一小时为查询时尚未结束的桶，并非来自未来的完整数据。事件查询保持原始截止，桌面已存事件 3,587、旧项目 914，与 ingestion 统计不是相同分母。
- `error` 类别包括 exception、message/default 等错误监控事件。只查询 `event.type:error` 会漏掉 message 事件；本报告的 release/分组占比基于不限 event.type 的已存事件查询。
- `client_discard` 的 `sample_rate` 性能事件、`network_error`、日志 buffer overflow、附件字节均不能混加到 accepted error。SDK 报告的丢弃计数可能很大，不等于同数量的付费错误或真实崩溃。
- 日统计显示 9/13 开始因额度拒收，9/14–9/17 accepted 为 0，9/18 恢复。本证据支持持续累计耗尽；没有用户数/会话量分母，不能证明产品错误率突然上升。0.67.16 在 9/18 发布，不能把 9/13 的耗尽归因它。

计数定义见 [Sentry stats_v2 API](https://docs.sentry.io/api/organizations/retrieve-event-counts-for-an-organization-v2/) 与 [Usage Stats](https://docs.sentry.io/product/stats/)。删除历史不退还额度见 [Sentry 官方说明](https://sentry.zendesk.com/hc/en-us/articles/23574174623259-Can-Deleting-Events-Free-Up-Error-Quota-in-Sentry)。

## 高频组与安全样本

近 30 天事件聚合：起点 2026-08-22 04:30 UTC、截止 2026-09-21 04:30 UTC。以下 count 是该时间窗口内事件数，**不是 issue lifetime count，也不是独立用户数**。

| Issue | 窗口内事件 | 最新样本事实 |
|---|---:|---|
| [DESKTOP-20](https://codepilot-rg.sentry.io/issues/7677508289/) provider.unknown_failure | 1,067 | 9/21，0.67.16，automatic_memory_extract；extractMemories → generateTextFromProvider → pumpTextStream |
| [DESKTOP-21](https://codepilot-rg.sentry.io/issues/7677511240/) provider.unknown_failure | 887 | 9/21，0.67.16，automatic_quick_actions；generateTextFromProvider → pumpTextStream |
| [DESKTOP-23](https://codepilot-rg.sentry.io/issues/7677639113/) provider.unknown_failure | 102 | 9/21，0.67.16，active_turn_memory_rerank；rerankWithAI → generateTextFromProvider → pumpTextStream |
| [DESKTOP-9](https://codepilot-rg.sentry.io/issues/7648286666/) telemetry.unknown_failure | 307 | 9/21，0.67.16，NATIVE_STREAM_ERROR，configured / anthropic |
| [NEXTJS-2X](https://codepilot-rg.sentry.io/issues/7398009709/) AI_NoOutputGeneratedError | 275 | 9/21 仍有 codepilot@0.54.0 production 上报 |
| [DESKTOP-2X](https://codepilot-rg.sentry.io/issues/7682340658/) telemetry.unknown_failure | 159 | 最近 9/5，0.67.13，NATIVE_STREAM_ERROR；不能列作最新版刚发生的回归 |
| [DESKTOP-3V](https://codepilot-rg.sentry.io/issues/7690874508/) net::ERR_CONNECTION_RESET | 95 | 最近 9/5，0.67.10，electron_main |

前三组最新样本均为 production、next_server、provider.class=environment、protocol=anthropic、status.class=none、retryExhausted=true。这提示需要核查辅助调用的真实 Provider 选择、凭据来源和 SDK cause；**并未证明这 2,056 条都是缺凭据，也未证明重试一定执行了具体次数**。当前安全事件把原文归一为 provider.unknown_failure，单凭标题无法还原上游真实错误。

`callScene` 存在于 extras，不是 tag；直接在 Discover 按 callScene 聚合得到空值，不能将这个空值解释为没有调用场景。未来可以增加受限枚举 tag，以便分账，同时保留脱敏约束，不上传 Provider 原始 body。

## 旧项目与混入来源

两个项目均 active：javascript-nextjs 创建于 2026-04-04，codepilot-desktop 创建于 2026-08-02。历史计划 `docs/exec-plans/active/sentry-telemetry-reliability.md:50,287` 明确保留旧项目为历史基线，但保留历史不等于停掉 ingestion。

已存事件的 release 聚合举例：旧项目 codepilot@0.54.0 113 条、0.59.1 81 条；另有 linkiebuypilot@1.0.4 109 条、xteam@0.59.1 80 条、CapyWork@0.3.7 33 条、xclaude@1.50.7 21 条。新项目绝大多数为 CodePilot，但有“京小智@0.67.13”2 条。这些只是 release 标签，不引用用户身份或凭据。

新包切 DSN 不会让安装中的旧包自动停报；发布新的过滤逻辑也不能立即约束未升级用户。旧项目要立即止血需服务端入口控制。禁用整个旧 key 会丢失旧正版监控；若要只挡非官方包，单靠可伪造 release 前缀不足以证明身份，也不能把普通桌面内置 DSN 当秘密凭据。先核对仍在用的 keys 与支持版本范围，再做可回滚的入口调整，不建议直接删除历史项目。

## 代码审计：已证实与尚未证实

- Dev/preview 默认不报：`src/lib/telemetry/contract.ts:82` 的 production + stable + DSN + 未 opt-out 门禁被 main/server/renderer 共同使用。因此当前开发操作不是已证实的额度来源。旧包或下游构建是否继承该规则需单独判断。
- 三层 `tracesSampleRate:0` 关闭的是 tracing，并不采样 error；没有跨请求 error 全局预算。fingerprint 合并 issue 和原异常 marker 去重也不会减少同类错误发生 100 次后产生的 100 个独立事件。
- 自动记忆通常每 3 轮触发（特定 Buddy 稀有度为 2）；quick-actions 有 60 秒失败冷却、10 分钟成功缓存及并发合并，不能声称完全无限调用；但多个用户、持续聊天、过期后再触发仍会累计失败。
- **分类缺口已离线复现**：生产 `normalizeTelemetryFailure('PROVIDER_FAILURE', new Error(message), {retryExhausted:true})` 对 `ai-provider.ts:86/99` 的缺凭据文案、`:322` OAuth 过期文案、`:362` 中文 timeout 均返回 unknown/shouldReport=true。`root-cause.ts:269-272` 的文本规则漏匹配应用自有文案；优先用结构化 code/type 修正，不能靠无限加正则。
- **不能将此分类缺口直接认作最大三组的最终根因。** 最新样本栈落在 pumpTextStream，即 SDK 流 error part 包装位置；缺凭据是在 createModel 前后另一条路径。本轮未获得能证明原始错误种类的安全字段。需要针对实际环境和 SDK 原因做可重复的本地/受控复现。
- 用户侧配置问题、取消、可预期失败应正确分类；真正 unknown、产品缺陷与服务 5xx 应保留诊断。当前结构化 4xx 已排除也会让 Gemini schema 400 类 bug 不出现在 error 中，不能继续为了省额度扩大盲区。

## 建议下一步与验收（均未实施）

1. **旧入口治理**：核对旧项目 keys、官方仍支持的版本与可能共享 DSN 的构建；选择停收旧 key 或可用的项目限制，保留历史。执行前写明丢失旧版监控的影响与恢复方法；以未来 accepted 分摊验证，不以删除后列表变空验证。
2. **复现辅助调用失败**：以 0.67.16 的 memory_extract / quick_actions / memory_rerank 为三个独立场景，核查实际 Provider、credential source、model、SDK error cause。不将普通聊天成功当作辅助能力成功；不为诊断上传用户 prompt、token 或上游原始 body。
3. **修正分类与调用预算**：结构化标识缺凭据/过期，保证零 error transport；临时网络错误明确 transient；辅助任务失败熔断/冷却并显示状态。按有限类别保留首个和周期样本，记录被抑制数量，不笼统吞掉 unknown 或崩溃事件。新代码只能影响升级用户。
4. **验收收益**：对照正常输入、缺凭据、401/429、超时、真正 5xx、产品异常；确认应报与不报都正确，再观察完整 24h/7d 接收量及未知错误占比，尽可能补成功调用分母。不能以“没有上报”代替“产品已修复”。

待修事项记入 [技术债务 #98](../exec-plans/tech-debt-tracker.md)。相关记忆产品建议见 [记忆调研](memory-products-codepilot-2026-09-21.md)。

## 可复核数据来源与边界

只调用 GET：`/api/0/customers/codepilot-rg/`（计费）、`/organizations/codepilot-rg/projects/`、`/organizations/codepilot-rg/stats_v2/`、`/organizations/codepilot-rg/events/`、`/issues/{id}/`、`/issues/{id}/events/latest/`（其余均带 `/api/0`）。stats_v2 按 project/category/outcome/reason 聚合 sum(quantity)；events 按 project/issue/event.type 或 release 聚合 count()，100 行页限下 release 结果 52 行。

本轮执行 helper 来自 Sentry skill；凭据只从本机环境注入进程，没有写进本文或回显。仅将计数、固定标签、安全 frame、调用场景摘录进仓库；没有复制原始事件、请求、用户消息、完整 stack 或 DSN。临时脱敏快照位于 `/tmp/codepilot-sentry-audit-2026-09-21/`，不作为长久证据的唯一载体，本文已保留主要数字、口径、查询边界和 issue 链接。

限制：免费计划事件保留 30 天，不能从当前完整重建所有历史原始事件；前周期按日期统计不等于历史账单；未审阅告警原页面、未做真实客户端三场景重现、未核对客户端 key 配置。统计不会自动给出所有 unknown 的真实原因。没有启动持续监控或自动任务。

## 实施期旧入口核查（2026-09-21 约 18:31，Asia/Shanghai）

通过 Sentry skill helper 只读 GET `/api/0/projects/codepilot-rg/{project}/keys/`，旧项目 `javascript-nextjs` 与新项目 `codepilot-desktop` 各有一个 Default key，均 `isActive=true`、`rateLimit=null`。没有复制 DSN 或 public/secret key。此结果支持“旧包还可继续投递”；不能证明某个客户端随后一定投递成功。

可执行处理为停用旧项目唯一 Default key，保留项目/事件历史，新项目不变。预期影响：旧官方版本与共用旧入口的非官方构建都停止后续监控；恢复方式为重新启用同一 key，停收期间丢失事件不补回。已向用户提交这一具体外部变更的确认请求，尚未执行。代码端分类/预算只能在使用修复版本的客户端生效，不把工作树修复写成线上额度已下降。
