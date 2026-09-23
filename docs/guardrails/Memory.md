# Memory Guardrail

> Active contract，2026-09-22。实现与验证进度见 [执行计划](../exec-plans/active/memory-runtime-decoupling.md)。修改查询、记忆工具、记录存储、自动抽取或管理 UI 前必读。

## 1. 词汇表

- Memory Core：`memory-service.ts` 的中立 schema/handler，不依赖 Claude Agent SDK、Codex app-server 或 AI SDK。
- Managed record：`memory/records.md` 的带来源记忆；Markdown 是事实源，索引与虚拟 `memory/records/<id>.md` 是投影。
- Revision：包含实际 workspace 身份的 CAS 标识；不是 UI 编造的版本号。
- Assistant binding：用户从助理入口建立的持久绑定；新普通会话 cwd 相等不代表绑定；升级前已有助理身份通过版本化启动事务一次性保留。
- Committed turn：成功终态、消息已持久化且 collector 仍拥有 lock 的用户回合。
- Auxiliary execution：明确 Provider、凭据能力和 policy 后执行的可选模型增强；不决定基础记忆是否可用。

## 2. 不变量

| 契约 | 负责实现 |
|---|---|
| Memory 工具仅挂已绑定的助理工作区；普通项目没有自动 recent 指令、Memory 扫描或写入；Bridge 仅显式请求/配置助理目录绑定；UI 使用 session API 同一判定 | memory-binding + migration + adapters + ChatView |
| 三 Runtime 与 Codex proxy 共享参数、1-based 行号、路径边界、排序、预算与返回语义；协议 wrapper 不能另写检索业务 | memory-service + thin adapters |
| 搜索在限制结果前查正文，不能先按标题/manifest 将正文唯一命中筛掉；扫描最多 512 文件/8 MiB/10000 目录项，超过明确 partial；get 长单行支持 char_start 续读 | workspace-retrieval + memory-service |
| 拒绝路径越界、同前缀兄弟目录、symlink、私有 metadata 和 raw records 历史；只有 active record 可被记忆工具投影 | memory-service + workspace-indexer |
| 记住/更正/忘记默认受保护；Plan/heartbeat 只挂 read 工具；Claude 不能整服 auto-allow，Codex 写工具不得在 proxy 中绕过 MCP 审批 | permission/profile + mutation-level + adapters |
| 工具来源 session 从宿主上下文获取，不能由模型伪造；执行时再次校验 session cwd/Plan，核心 read 模式自身拒绝写入；Settings 只对已配置助理目录做同源操作 | memory-service + memory-binding + workspace/memory route |
| 记录写入采用 CAS、原子文件替换和单写者锁；同 operation 不可换内容；未知/活跃锁不能按时间强抢 | memory-records |
| 更正保留替代关系和新来源；忘记清除该事实全部版本正文，保留来源 tombstone，重试不得复活；不承诺删除原聊天或旧有文件 | memory-records + UI |
| 读取、写入尝试、is_error 或模型文字“已记住”均不能算保存回执 | memory-extractor |
| 抽取由桌面/Bridge 共用提交事件驱动；失败/取消/旧 owner/系统回合不入队；宠物不决定基础 Memory 是否存在 | memory-lifecycle + collectors |
| Ledger 持久化待凑批次的回合和 job 来源，不复制聊天原文；3 回合批次覆盖全部真实来源，模型必须返回 messageId+原文 evidence；模型不可用须显示 unavailable/failed/cooldown，不冒充 completed/nothing | memory-lifecycle + MemoryRecordsPanel |
| Runtime/env 凭据存在与 direct transport 可执行分开；固定当前 Provider，不偷偷切账号/厂商 | auxiliary-provider + ai-provider |
| 基础 CRUD/确定性检索不依赖模型；search 可选 AI 重排走捕获路由的统一 runner，构造期 identity 故障仅停用增强，基本工具与聊天继续；失效/超时/异常/非法输出均确定性降级并说明；真实产品异常不能为省额度吞掉 | memory-service + memory-rerank + telemetry |
| 仅 credentials 根因（401/403、缺 key、OAuth 过期）持久等待配置变化；429 和其他 4xx 有界冷却，不能用 telemetry outcome 决定永久阻断；工作区禁止明文 key 或无盐配置摘要，持久标识用私有 app-data HMAC | auxiliary-provider + auxiliary-provider-identity |
| 抽取 job 的 attempts 在模型执行前持久化，最多 3 次生成尝试；重启/配置变化/手动 Retry 不重置，耗尽显示 retry_exhausted；未发模型的 unavailable/cooldown 不计次，SDK 自身重试不等于新 job | memory-lifecycle + UI |
| identity/block 读写故障返回可见 typed status；不能从可选增强向外抛错，凭据回执写失败仍保留内存阻断；旧 v1 模糊 block 不作为永久锁 | auxiliary-provider + identity |
| Quick actions 缓存按当前配置身份失效；旧请求不能覆盖新配置结果，空列表失败仍可见；Retry 不绕过真实 retryAt，显示截止时间 | quick-action-suggestions + quick-actions route + QuickActions |
| 满额、损坏、访问失败与版本冲突分别显示；抽取先存储预检，确定性存储阻塞等待文件变化才重试，不能按60秒反复消耗模型 | memory-records + lifecycle + UI |

## 3. 文件责任

| 文件 | 责任 |
|---|---|
| `src/lib/memory-service.ts` | 查询/读取/写工具的共同 contract 与 handler |
| `src/lib/memory-records.ts` | Markdown 真源、来源/CAS/幂等/更正/撤销/锁 |
| `src/lib/memory-binding.ts` | 仅助理工具范围与显式服务绑定（getter 不写库） |
| `src/lib/assistant-memory-migration.ts` | 一次性升级回填，不改变会话 Runtime owner |
| `src/lib/memory-rerank.ts` | Runtime 中立检索的可选统一模型增强，快照/超时/降级 |
| `src/lib/stream-turn-outcome.ts` | 桌面/Bridge 共用 sticky 终态成功事实 |
| `src/lib/memory-lifecycle.ts` | 成功回合队列、恢复、状态和自动候选落盘 |
| `src/lib/memory-search-mcp.ts`, `builtin-tools/memory-search.ts`, `codex/proxy/builtin-bridge.ts` | 协议适配；Codex proxy 只处理读 |
| `src/lib/auxiliary-provider.ts`, `auxiliary-provider-identity.ts` | 模型能力、policy、快照、瞬态冷却、私有HMAC与等待配置的持久门禁 |
| `src/app/api/workspace/memory/route.ts`, `MemoryRecordsPanel.tsx` | 用户可见 CRUD、来源与增强状态 |

## 4. 改动检查

- 同一 fixture 经 Native、MCP 与 proxy 的实际 handler 返回一致；不能只看函数同名。
- 路径/权限反例、冷正文命中、来源/版本冲突、撤销后的重建均有行为回归。
- 新工具同时更新 catalog、capability/compiler/matrix 和 permission；`mcp__codepilot-memory` 不可整服白名单。
- 新增强状态映射中英 UI，降级仍可手工使用，不展示假成功或猜测用户身份。
- 生命周期必须在真实 collector / Bridge 中验证，不能仅调用 enqueue 函数声称全链路通过。

## 5. 常见坑

- `hasCredentials` 代表 SDK 子进程能读配置，却被 Native 当作 transport 已拿到 key。
- 缺 key 的固定 SDK 错误被包装后成为 unknown，静默降级仍重复上报。
- records 原始文件被一般文件索引重新纳入，从而把 superseded/revoked 内容当有效事实。
- 只改搜索工具，不改 Native/Codex 的实际注册、Plan prompt 或整服 auto-allow。
- 使用任意 cwd 激活助理自动服务，或用宠物存在性决定记忆是否工作。

## 6. 测试

`memory-scope-entrypoints.test.ts`、`memory-rerank.test.ts`、`memory-records-recovery.test.ts`、`memory-service.test.ts`、`memory-records.test.ts`、`memory-records-route.test.ts`、`memory-lifecycle.test.ts`、`memory-extractor.test.ts`、`codex-memory-mcp-route.test.ts`、`native-memory-tasks-parity.test.ts`、`codex-builtin-bridge-parity.test.ts`、capability/permission suites、`auxiliary-provider.test.ts`、`telemetry-provider-noise.test.ts`、`quick-actions-route.test.ts`、`quick-actions-status.test.ts`、`quick-action-suggestions.test.ts`。完整通过情况与真实 UI/Runtime smoke 分别记入执行计划，不能互相替代。

## 7. 决策日志

- 2026-09-21：保留现有用户文件，增加可审计记录而不引入第三方 Memory 服务或向量库。查询先收敛确定性全文服务；自动抽取为可选、可见、可恢复增强。宠物排除本次兼容矩阵。
- 2026-09-21：Codex read/write MCP 分离沿用现有审批通道；Claude 精确放行三个读工具，Native 根据真实已挂载工具启用能力提示。

- 2026-09-21 复审：追加长单行分页、全扫描总预算与部分结果提示；mutation 在执行时重验权限，Plan 自动提取也不得写入。队列与消息 DB 是两种存储，不声称分布式 exactly-once：持久化任务/记录可恢复，入队文件锁或 IO 失败保守跳过并留错误日志，不能撤销已经成功保存的聊天。

- 2026-09-21 复核：模型执行前/后均校验 Plan、显式绑定与原始消息；metadata 持久化 retryAt + route fingerprint，配置变化立即重新评估（不重置 job 尝试预算），record batch 落盘后通过 operationHash 识别已提交操作。

- 2026-09-21 用户复审决策：仅助理工作区启用全部 Memory 工具，普通项目不引入每轮调用/目录扫描/记忆写入；保留 AI 重排，通过统一 runner，不能删除后仍宣称“可选增强”。Bridge 的明确目录选择是绑定入口；旧助理会话只在启动迁移中一次性保留身份，之后 GET/上下文/工具使用同一只读判定。
- 2026-09-21 复审修复：桌面 enqueue 仍在持久化 finally 中，由共享终态事实、持久化状态和 lock owner 共同约束，位置本身不是成功证据。真实双进程写入、SIGKILL 恢复、存储预检零模型调用纳入回归。

- 2026-09-22 第二轮复审：遥测 user_action_required 不是永久重试策略。仅明确 credentials 保存 v2 block；忽略无法证明根因的 v1 回执。抽取最多 3 次生成尝试，旧 configuration_required ledger 可重新评估，已提交记录仍通过 operationHash 恢复。私有 key/回执 IO 失败降级可选增强，不破坏基础读写与聊天；Quick actions 配置身份、缓存、状态、Retry 使用同一后端事实。
