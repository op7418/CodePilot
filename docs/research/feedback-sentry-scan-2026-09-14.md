# 2026-09-14 用户反馈与 Sentry 只读扫描

查询截止：北京时间 2026-09-14 12:29:30。未修改产品代码、外部 Issue/Sentry 状态或发布版本。

## 范围与计数

- GitHub：op7418/CodePilot，updated >= 2026-09-06；REST 与 issue search 交叉核对，共 3 条反馈，均 open。没有检查微信群或邮件。
- Sentry：codepilot-rg / codepilot-desktop，production；起点为上次关键组实时复核 2026-09-07 13:35（北京时间），UTC 窗口 [2026-09-07T05:35:00Z, 2026-09-14T04:29:30Z)。
- 使用技能提供的 Sentry API helper，只读 GET。项目 Issue 列表返回了窗口前的分组，因此不使用列表 count 作为新增数；筛选 lastSeen 后逐组分页读取 14d events，再以事件 dateCreated 本地过滤。33 组均未触及 2000 条分页上限。
- 全版本共 786 事件：753 error、29 fatal、4 info。错误/fatal 合计 782；info 是旧版 health_summary，不算报错。
- 最新公开正式版仍是 [v0.67.15](https://github.com/op7418/CodePilot/releases/tag/v0.67.15)（2026-09-05 发布），窗口内该版 643 条错误事件。新分组 3 个、共 4 事件，全部该版；新分组不等同新回归。
- 事件数不是用户数，fatal 也不能直接等同整机客户端崩溃；没有分母与独立用户身份，不能推断故障率或受影响人数。

## GitHub 反馈

1. [#687](https://github.com/op7418/CodePilot/issues/687)（9/11 新建）：0.67.15 / macOS / Claude Code SDK / qwen3.8max。用户报告后台子代理权限静默取消，批量取消后父 turn 的 allow 命令也被拒；另报告 CodePilot 子代理写入绕过审批、interrupt 扇出、审批超时后假批准等。优先核实权限 fail-open 与主会话失效，均是报告内容，尚未独立复现，不能把多个现象归为同一根因。当前无评论。
2. [#685](https://github.com/op7418/CodePilot/issues/685)（9/7 新建，9/9 更新）：0.67.15 / Windows / Claude Code SDK / mimo-v2.5-pro Token Plan，第一轮成功、第二轮 MESSAGE_ROUTE_MISMATCH，每次重新选择模型后可继续。优先核对续聊路由，未复现。当前无评论。
3. [#686](https://github.com/op7418/CodePilot/issues/686)（9/10 北京时间新建）：MemCode 跨会话记忆集成合作提议，非故障反馈。唯一回复为 needs-repro 模板机器人回复，不是人工答复。

## Sentry 新分组

- [4X](https://codepilot-rg.sentry.io/issues/7716611150/)：9/7 15:38，Windows，1 次 mkdir ENOENT。样本位置 tools/write.ts:27 创建目录失败，auto.vercelai.channel 标记 handled=false；初始路径原因未知。
- [4Y](https://codepilot-rg.sentry.io/issues/7723543730/)：9/10 15:42–15:43，macOS，2 次 Provider DNS 失败，managed/openai-compatible，retryExhausted=true；属于上游网络分类，不能直接认定产品回归。
- [4Z](https://codepilot-rg.sentry.io/issues/7729411726/)：9/13 16:10，macOS，1 次编辑文件 EPERM，样本位置 tools/edit.ts:89 → writeFileSync，auto.vercelai.channel 标记 handled=false；无法据遥测判断操作系统拒绝的具体原因。

## 旧问题新增与优先级

- Windows EOF：全版本新增 15、0.67.15 新增 8；EPIPE：0.67.15 新增 1，均 fatal/uncaught、next_server。写入端和退出关联仍未知。
- Windows utility process：全版本新增 13、0.67.15 新增 6（48 非零退出 3、4G 意外正常退出 3）。与 EOF/EPIPE 可能是同一故障链的不同事件，不能直接相加为崩溃次数。
- Provider unknown 三组 20/21/23：全版本 556，0.67.15 为 500，仍占多数。上次样本为辅助记忆/建议调用，本次 21 最新样本为 skills/search；不能把这些错误全部归为主聊天失败。
- 0.67.15 其他主要组：9 原生流未知错误 44、2G Provider DNS 49；详见表格。各组标签取最新样本，不宣称整组所有事件上下文完全一致。
- [4T 消息保存失败](https://codepilot-rg.sentry.io/issues/7715120873/)：列表 lastSeen 仍为 2026-09-06T12:20:37Z，累计 6，本窗口无新增。不能因此关闭最初 DB 空读根因，亦不能将未发布修复当作线上停增原因。

下一步建议：先复现 #687 权限绕过与父 turn 失效，再复现 #685 续聊路由；并行任务需另获用户指示，本次未启动子代理。Windows 服务退出与 I/O 来源保留开放诊断。新文件工具错误应核对失败反馈与恢复路径，不应只压低 Sentry 数量。

## 精确分组计数

以下均为窗口内 event 数，非 Issue lifetime count。所有列出组当前 unresolved。

| 分组 | 标题 | 全版本新增 | 0.67.15 新增 | 首次出现的新组 |
|---|---|---:|---:|---|
| [CODEPILOT-DESKTOP-20](https://codepilot-rg.sentry.io/issues/7677508289/) | Error: provider.unknown_failure | 387 | 363 | 否 |
| [CODEPILOT-DESKTOP-9](https://codepilot-rg.sentry.io/issues/7648286666/) | Error: telemetry.unknown_failure | 69 | 44 | 否 |
| [CODEPILOT-DESKTOP-B](https://codepilot-rg.sentry.io/issues/7648413360/) | provider.request_failed | 2 | 0 | 否 |
| [CODEPILOT-DESKTOP-4Z](https://codepilot-rg.sentry.io/issues/7729411726/) | Error: EPERM: operation not permitted, open | 1 | 1 | 是 |
| [CODEPILOT-DESKTOP-F](https://codepilot-rg.sentry.io/issues/7648739372/) | Error: write EOF | 15 | 8 | 否 |
| [CODEPILOT-DESKTOP-21](https://codepilot-rg.sentry.io/issues/7677511240/) | Error: provider.unknown_failure | 153 | 121 | 否 |
| [CODEPILOT-DESKTOP-H](https://codepilot-rg.sentry.io/issues/7648797194/) | telemetry.normalized_failure | 7 | 5 | 否 |
| [CODEPILOT-DESKTOP-2D](https://codepilot-rg.sentry.io/issues/7679782198/) | Error: node_grep_line_too_long | 4 | 4 | 否 |
| [CODEPILOT-DESKTOP-48](https://codepilot-rg.sentry.io/issues/7701709597/) | server.utility_process_failed | 5 | 3 | 否 |
| [CODEPILOT-DESKTOP-23](https://codepilot-rg.sentry.io/issues/7677639113/) | Error: provider.unknown_failure | 16 | 16 | 否 |
| [CODEPILOT-DESKTOP-25](https://codepilot-rg.sentry.io/issues/7677696598/) | server.utility_process_failed | 5 | 0 | 否 |
| [CODEPILOT-DESKTOP-1R](https://codepilot-rg.sentry.io/issues/7653139492/) | telemetry.health_summary | 2 | 0 | 否 |
| [CODEPILOT-DESKTOP-2G](https://codepilot-rg.sentry.io/issues/7680064367/) | telemetry.normalized_failure | 62 | 49 | 否 |
| [CODEPILOT-DESKTOP-2B](https://codepilot-rg.sentry.io/issues/7678353920/) | telemetry.normalized_failure | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-3F](https://codepilot-rg.sentry.io/issues/7687390473/) | Error: spawn EPERM | 3 | 3 | 否 |
| [CODEPILOT-DESKTOP-43](https://codepilot-rg.sentry.io/issues/7699363030/) | SyntaxError: Invalid regular expression: /(?i)money / coin / currency / cash / gold / \bdollar/: Invalid group | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-C](https://codepilot-rg.sentry.io/issues/7648448022/) | telemetry.health_summary | 1 | 0 | 否 |
| [CODEPILOT-DESKTOP-2S](https://codepilot-rg.sentry.io/issues/7682263064/) | provider.request_failed | 3 | 1 | 否 |
| [CODEPILOT-DESKTOP-26](https://codepilot-rg.sentry.io/issues/7677763928/) | Error: telemetry.unknown_failure | 2 | 0 | 否 |
| [CODEPILOT-DESKTOP-3D](https://codepilot-rg.sentry.io/issues/7686296836/) | Error: telemetry.unknown_failure | 21 | 6 | 否 |
| [CODEPILOT-DESKTOP-4G](https://codepilot-rg.sentry.io/issues/7706022431/) | server.utility_process_failed | 3 | 3 | 否 |
| [CODEPILOT-DESKTOP-1Q](https://codepilot-rg.sentry.io/issues/7653092086/) | Error: Minified React error #185; visit [url] for the full message or use the non-minified dev environment for full errors and additional helpful warnings. | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-3C](https://codepilot-rg.sentry.io/issues/7686218886/) | Error: telemetry.unknown_failure | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-4Y](https://codepilot-rg.sentry.io/issues/7723543730/) | telemetry.normalized_failure | 2 | 2 | 是 |
| [CODEPILOT-DESKTOP-2A](https://codepilot-rg.sentry.io/issues/7678115674/) | Error: telemetry.unknown_failure | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-1A](https://codepilot-rg.sentry.io/issues/7651305089/) | telemetry.normalized_failure | 8 | 5 | 否 |
| [CODEPILOT-DESKTOP-4N](https://codepilot-rg.sentry.io/issues/7711311372/) | Error: write EPIPE | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-1B](https://codepilot-rg.sentry.io/issues/7651338824/) | telemetry.health_summary | 1 | 0 | 否 |
| [CODEPILOT-DESKTOP-1W](https://codepilot-rg.sentry.io/issues/7653656225/) | provider.request_failed | 4 | 0 | 否 |
| [CODEPILOT-DESKTOP-38](https://codepilot-rg.sentry.io/issues/7684560611/) | Error: telemetry.unknown_failure | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-3Q](https://codepilot-rg.sentry.io/issues/7690512366/) | DatabaseStartupError: An error occurred while loading instrumentation hook: CODEPILOT_DB_STARTUP_BLOCKED code=database_io_failure preservation=failed | 1 | 0 | 否 |
| [CODEPILOT-DESKTOP-2P](https://codepilot-rg.sentry.io/issues/7681944232/) | Error: telemetry.unknown_failure | 1 | 1 | 否 |
| [CODEPILOT-DESKTOP-4X](https://codepilot-rg.sentry.io/issues/7716611150/) | Error: ENOENT: no such file or directory, mkdir | 1 | 1 | 是 |
