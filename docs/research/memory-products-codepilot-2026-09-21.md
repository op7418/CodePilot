# MemCode 与同类记忆方案：CodePilot 改进调研

> **实施跟进**：用户随后已授权修复，工作区实现与验证见 [Memory Runtime 解耦执行计划](../exec-plans/active/memory-runtime-decoupling.md)。本文中的“尚未修改/待修”和源码行号描述调研时的 v0.67.16 基线；离线旧行为探针须在该基线运行，不代表修复后的预期结果。线上统计仍为文中指定时间的快照。

> 2026-09-21；状态：调研完成，#686 具体项目身份待确认；未实施产品变更。

> 后续用户要求已明确：Memory 必须与 Runtime 解耦；宠物排除本轮兼容验收。具体根因、共享服务边界与验收见 [原因与解耦报告](memory-runtime-root-cause-2026-09-21.md)，不是只复用存储文件。

## 结论与用户问题

用户希望研究 #686 提到的 MemCode 及同类方案，优先借鉴以优化自身产品，不要求直接集成。并行复核了外部方案、本地实现与 Sentry 实际用量。

建议保留本地 Markdown 事实源，先完善已有记忆能力，不增加新的后台引擎。我们已有按需搜索、自动抽取和文件维护，但已本地复现正文唯一命中漏检、Native 读取兄弟目录越界；这两项应先修。随后统一三 Runtime 的检索/读取合同，补来源回查、明确作用域、用户更正/遗忘和调用预算，再以自己的评估集决定是否需要向量或图数据库。

Sentry 最新样本同时证明自动提取、记忆重排正在正式 0.67.16 中发生失败；不能仅增加更多自动模型调用。详见 [Sentry 额度调查](sentry-quota-audit-2026-09-21.md)。源码缺口与线上失败尚无完整因果证据，不混为同一个根因。

## 建议实施顺序（尚未授权实施）

| 顺序 | 用户能获得什么 | 验收重点 |
|---|---|---|
| 1 | 已保存的正文搜得到；记忆读取守住当前目录 | 正文唯一命中、兄弟目录和 symlink 拒绝、三个 Runtime 共同 fixture、行号/长度预算一致 |
| 2 | 知道记住了什么、从哪来，并能更正和忘记 | 来源消息/原句、确认与推断分开、替代关系、删除后索引/缓存/派生记忆不复活 |
| 3 | 项目和个人偏好不串用，后台失败不反复调用 | assistant/project/global 显式绑定；采集状态、幂等、失败冷却、token 与时间预算 |
| 4 | 用实测判断是否值得升级检索引擎 | 20–40 个脱敏任务，测正确记忆率、错误注入、跨项目隔离、成本与延迟；不套用厂商 benchmark |

已确认缺陷进入 [技术债务 #96–97](../exec-plans/tech-debt-tracker.md)，保持未修复状态。本轮只写研究与追踪文档；没有安装第三方插件、读取用户真实记忆、调用真实模型或修改 Sentry 配置。

---

# CodePilot 外部记忆方案调研（2026-09-21）

范围：只读官网、官方仓库与文档；未安装依赖、未运行第三方代码、未发送用户数据、未修改产品。除明确标注「源码核对」外，下列能力都是官方文档描述，未做运行验证或第三方基准复现。

## 1. #686 与 MemCode 身份边界

用户给出的 `https://github.com/op7418/CodePilot/issues/686`，本轮 `gh issue view` 返回无法解析 issue，允许网络后 REST `GET /repos/op7418/CodePilot/issues/686` 明确 HTTP 404，网页抓取也失败。**没有读到 issue 正文或评论，不能断言它指的是哪个 MemCode。** 404 只说明当前访问路径不可用，不能推断内容不存在或已删除。

公开检索至少出现三个不同产品：

| 名称/地址 | 实际定位 | 当前可核事实 |
|---|---|---|
| [scalenation/memcode](https://github.com/scalenation/memcode)，[memcode.pro](https://www.memcode.pro/) | 本地 SQLite 项目记忆工具，为多个 coding assistant 注入上下文 | 有公开 TypeScript 源码；MIT；本轮重点源码核对对象，**不是已确认的 #686 对象** |
| [memcode.ai](https://www.memcode.ai/docs/code/memory) | 自带记忆的 coding CLI/gateway | 文档区分全局与项目 memory.md、规则文件 MEMCODE.md、session recap/recall；未核对源码实现 |
| [memcode.in](https://memcode.in/docs) | Memory API、SDK/MCP 与 coding agent | 文档描述领域 specialist 抽取、typed 操作、异步 ingest 状态、来源与 scope；未确认公开完整引擎源码和 license |

`memcode.in` 最值得借鉴的是「已入队 ≠ 已记住」：返回 job ID，并以 completed/failed/cancelled 区分终态。其自主路由、召回关联增强和 benchmark 分数属于厂商说明，本轮未复现。`memcode.ai` 可借鉴规则/事实分开，但将记忆放在 prompt 中并不自动构成抵抗提示注入的安全保证。

## 2. 本地型 MemCode：值得参考的部分与不应照搬的部分

源码版本：`53103b5d955887aae44e95a0b5a9b2316fe31b3e`（GitHub API 返回 commit 时间 2026-06-20）。

- **来源可追踪**：schema 中 workspace、session/source/provider/model、checkpoint/git SHA/branch、decision/rationale/status，以及 task 对 decision/checkpoint 的关联是实在的数据结构。决策状态包括 active/superseded/rejected。[schema 源码](https://github.com/scalenation/memcode/blob/53103b5d955887aae44e95a0b5a9b2316fe31b3e/packages/core/src/schema.ts)
- **低成本的基础记忆**：免费 checkpoint 是规则摘要，SQLite 事务保存，附带 git 信息；可选 summarizer provider 才走模型。不是「每次提交自动读懂代码」。[checkpoint 源码](https://github.com/scalenation/memcode/blob/53103b5d955887aae44e95a0b5a9b2316fe31b3e/packages/core/src/checkpoint.ts)
- **可解释检索**：免费路径是关键词命中 + 30 天半衰期 + 类型权重，输出 reason；SQL 按 workspace_id 筛选。语义检索通过私有 Pro provider 接口，失败退回关键词。因此不能把官网的 semantic recall 宣传写成免费本地功能的已验证结论。该查询还未过滤 decision.status，superseded/rejected 也可能进入候选；不能照搬成「当前事实」检索。[retrieval 源码](https://github.com/scalenation/memcode/blob/53103b5d955887aae44e95a0b5a9b2316fe31b3e/packages/core/src/retrieval.ts)
- **同步并不等于语义冲突解决**：decision/task 依 updated_at 做 last-write-wins，checkpoint 追加。消息正文未上传，但同步请求包含加密 payload 之外的 meta/brain（含摘要、分支等）；不能概括成「服务器完全看不到任何记忆内容」。这是静态源码观察，不是线上服务审计。[sync 源码](https://github.com/scalenation/memcode/blob/53103b5d955887aae44e95a0b5a9b2316fe31b3e/packages/cloud-client/src/sync.ts)

成本与许可：官网称本地免费，云同步 Pro $3.99/月；公开仓库 MIT。当前价格只是调研当日展示。未发现并验证贯穿原始 session、摘要、索引、同步 tombstone 的删除闭环，不能用「数据库可导出」替代遗忘功能已完成。[官网](https://www.memcode.pro/) / [LICENSE](https://github.com/scalenation/memcode/blob/53103b5d955887aae44e95a0b5a9b2316fe31b3e/LICENSE)

## 3. 四个可借鉴的方案

| 方案 | 抽取/检索/生命周期 | 隔离/来源 | 部署、成本、许可 | 对 CodePilot 的参考价值 |
|---|---|---|---|---|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Hook 收集工具观察并生成摘要；search 索引 → timeline → 按 ID 读全文；有隐私排除标记 | project 筛选、观察 ID 引用、UI 可看记忆 | SQLite/本地 worker + 可选云；摘要模型消耗 token；当前官方仓库标 Apache-2.0 | 最贴近客户端产品：先给短索引，按需展开；让用户看到「本轮用了哪些记忆」 |
| [Mem0](https://github.com/mem0ai/mem0) | 当前 README 描述 ADD-only 抽取、语义/关键词/entity 融合与时间排序；显式 update/delete 仍存在 | user/agent/run/metadata scope；需产品传递原始消息 ID | OSS 库/自托管/托管；自托管仍有模型、embedding、存储成本；Apache-2.0 | 记忆 CRUD 和 scope 清楚，适合轻量工程边界；不能沿用旧文章默认「自动 UPDATE/DELETE」的描述 |
| [Graphiti](https://github.com/getzep/graphiti) | episode 提取实体/关系；旧事实失效而保留历史；混合检索 | episode 溯源、事实有效时间；group_id namespace | 自托管图数据库 + 模型/embedding；Apache-2.0；Zep 是另一个托管产品 | 借鉴事实版本与发生时间/写入时间，暂不需要把整套图数据库塞进桌面客户端 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | retain/recall/reflect 分工；事实与归纳 observation 分层；可使过时事实失效；更新/删除来源后刷新派生层 | bank 隔离、document/chunk 来源与原文回查 | 自托管/embedded PostgreSQL 或云；抽取/归纳/反思均可能消耗模型 token；MIT | 最值得借鉴来源到派生记忆的删除传播、异步状态、查询预算；reflect 不应每轮必跑 |

上表不是集成推荐或性能排名。尚未运行隔离/删除/冲突集成测试，不能将文档中的逻辑 scope 直接当作完整权限边界。

补充来源：

- Claude-Mem 官方 README 描述三层读取、观察 ID、SQLite/Chroma 和 `<private>`；其「约 10 倍省 token」为厂商估计，本轮不采用该数字作为收益承诺。[README](https://github.com/thedotmack/claude-mem#-mcp-search-tools)
- Mem0 明确 managed benchmark 包含 OSS 没有的 proprietary optimizations，不能把云分数当本地效果。[README](https://github.com/mem0ai/mem0)；[更新](https://docs.mem0.ai/core-concepts/memory-operations/update)；[删除](https://docs.mem0.ai/core-concepts/memory-operations/delete)。
- Graphiti 隔离需在写入与查询都使用正确 group_id；这是设计机制，不免除应用授权。[Graph namespacing](https://help.getzep.com/graphiti/core-concepts/graph-namespacing)。
- Hindsight document 保存来源、允许原文展开和来源级删除。[Documents](https://hindsight.vectorize.io/developer/api/documents)。派生 observation 会随来源删除失效并重新归纳剩余材料。[Observations](https://hindsight.vectorize.io/developer/observations)。单条事实可 edit/invalidate/restore。[Memories](https://hindsight.vectorize.io/developer/api/memories)。0.9.1 曾修复 document 修改/删除跨 bank 的路径，恰好说明「有 namespace 字段」不等于已验证隔离。[0.9.1 release](https://hindsight.vectorize.io/blog/2026/08/14/version-0-9-1)。

## 4. 外部方案导出的产品原则（结合后附本地基线使用）

**优先完善现有记忆产品闭环，不先引入第三方引擎。** 以上机制可以在本地 store + 轻量检索上实现；第三方重型依赖增加分发、后台服务、模型调用和隐私配置成本。

1. **用户能解释来源**：每条记忆可打开原消息/工具结果/文件和采集时间，保存决定与理由；区分用户明确确认、工具已验证、模型推断。模型说「测试通过」不能自动提升成已验证事实。
2. **当前状态与历史分开**：active/superseded/conflicted/expired，保留 supersedes/source；用户改口能更新当前事实，历史查询仍能回答当时为什么。单凭最近写入时间不能判定事实为真。
3. **项目隔离先于语义智能**：默认当前 project；全局偏好明确提升，跨项目引用可见。读取、编辑、删除、导出、重建索引都检查同一 scope。不要用目录 basename 作为唯一身份，避免同名仓库与 worktree 污染。
4. **可见的采集过程与可撤销性**：展示待提取/处理中/已保存/失败，失败不阻断普通聊天。支持编辑、禁用自动记忆、临时不记忆；删原始来源时告知并清理摘要、向量、缓存和衍生结论，防止下一轮重建复活。
5. **小预算渐进检索**：短索引 → 按需展开原文，展示本轮命中与用途；有检索时间、token 上限，无法检索时正常降级。一次源事件只提取一次，重复回调幂等，不按每轮整段聊天反复抽取。
6. **先建自己的验收集再评估收益**：20–40 个真实但脱敏任务，覆盖换 Provider 续聊、同名不同项目、用户纠错、过时技术决策、删除后不再命中、失败任务不记成功、敏感数据不持久化。比较无记忆/现有记忆/改进版的正确率、错误注入率、跨项目泄漏、额外 token 与 p95 延迟，不能只报命中率和厂商榜单。

建议顺序：来源与状态/删除隔离 → 渐进检索与预算 → 有证据的异步提取 → 用本地评测决定是否需要 embedding/图关系。后附本地源码核查已区分现有能力与缺口，不将上述建议描述成全部缺失。

---

# CodePilot 当前记忆机制事实基线（2026-09-21）

只读代码复核；本子任务未修改仓库文件，主任务已将结果整理为本文。代码路径均相对于 `/Users/op7418/Documents/code/opus-4.6-test/`。本文源码结论不能代替 packaged/真实 Provider smoke。

## 已有能力

- 用户拥有的 Markdown 文件是当前助理记忆主体：soul.md/user.md/instructions.md 身份与规则，memory.md 长期记忆，memory/daily 日期文件。`src/lib/context-assembler.ts:65-131` 以 session cwd === assistant_workspace_path 激活索引、身份注入、近期记忆提示和渐进式写入指令。每轮先同步调用 indexWorkspace；注释声称 5 秒超时，但代码并无计时中断，仅大于 3 秒时日志警告。
- 记忆按需取用而非全量塞 prompt：memory_search/get/recent 三工具。MCP 实现 `src/lib/memory-search-mcp.ts:42-111` 有关键词检索、tags/file_type、30 天时间衰减、可选模型重排；`src/lib/memory-search-mcp.ts:118-171` 有相对路径和 realpath 边界、行读取、长度截断、wikilink。Claude 在助理 cwd 注册（`src/lib/claude-client.ts:1319-1329`），Codex 使用同一 MCP 实现并做助理 realpath 校验（`src/lib/codex/builtin-mcp-servers.ts:56-71`）。
- Native 自己维护一份工具实现，`src/lib/builtin-tools/memory-search.ts:21-191`；注册条件仅是 workspacePath 非空（`src/lib/builtin-tools/index.ts:338-349`），调用端传普通 cwd（`src/lib/agent-tools.ts:142-169`）。因此其挂载边界不同于 Claude/Codex，不宜笼统声称三 Runtime 记忆已完全一致。
- 自动抽取已存在：`src/lib/chat-collect-stream-response.ts:525-560` 在助理 cwd、非 suppressNotifications 轮次中累计轮数，并在未检测到 memory 写入时后台调用 extractor。`src/lib/memory-extractor.ts:26-42` 默认 3 轮，epic/legendary Buddy 2 轮；`80-132` 取最近最多 6 条消息，每条仅前 500 字符，用 small model 输出 durable memory 列表并直接追加当日日记。
- 文件索引已有 Markdown 分块、标题/标签/别名/路径权重、热度加权：`src/lib/workspace-retrieval.ts:100-253`。当前检索核心未见 embedding/vector 召回。
- Settings 已有文件状态/分类/索引/归档入口（`src/components/settings/AssistantWorkspaceSection.tsx:562-589`；`src/components/settings/WorkspaceTabPanels.tsx:23-79,134-176,188-211`），但这些主要是文件健康和维护，并非条目级记忆核对、来源、修改/遗忘、命中解释。
- Harness Home 是另一套可配置 canonical repository/projector：`src/lib/harness-home/runtime/configured.ts:39-72` 只在 harness_home_root 配置后加载；`src/lib/harness-home/runtime/repository-projection.ts:207-234` 投影 memoryRefs/preferenceRefs。不能把这当成 Assistant Workspace 已迁移完毕。`docs/handover/harness-home.md:139-143` 明确 L0/L1 主要为 API/测试面、正式导入导出 UI 尚无、Assistant persisted binding 尚未落地。

## 已确认问题 / 短板

1. **正文唯一命中会漏召回（已本地复现）**。`src/lib/workspace-retrieval.ts:206-210` 先仅按 manifest score > 0 选候选，正文打分到 224-235 才执行。标题、tag、路径不含查询、无热度的文档，即使正文精确匹配也进不了候选。临时 fixture: notes.md 标题 Meeting，正文 “The selected color is cerulean.”，索引后 searchWorkspace('cerulean') 返回 []，searchWorkspace('Meeting') 命中 notes.md。这应先于向量化解决。
2. **Native 与 MCP 行为不一致**。Native `memory-search.ts:45-81` 搜索完直接切片，无 MCP `memory-search-mcp.ts:90-99` 的 decay/rerank。Native 注释称 searchWorkspace 内部做 decay，但检索源码并无该调用。Native `memory_get` 的行号是直接 slice，MCP 是明确 1-based。
3. **Native memory_get 路径边界失效（已本地复现，建议 P2 单独闭环）**。`src/lib/builtin-tools/memory-search.ts:103-114` 使用字符串 startsWith，并不验证路径分隔边界或 symlink。临时 workspace `.../work` 与 sibling `.../work-other/synthetic.txt`，file_path='../work-other/synthetic.txt' 成功读到了合成 fixture。MCP 对应实现具备 path.relative + realpath 检查。这里只验证合成文件，未读真实用户敏感数据。Native 返回全文也缺乏 MCP 的长度预算。
4. **抽取缺少稳定 provenance 与更正生命周期**。`memory-extractor.ts:93-132` 仅保留生成时间+列表文本，无 session/message id、源句、置信/确认状态、supersedes/revoked 字段；抽取 prompt 也没读取既有记忆执行去重/冲突处理，直接 append。故普通偏好变更容易变成多条相互冲突的描述。当前互斥检测 `61-73` 只是 serialized tool blocks 中出现 memory 路径与 tool_use/tool_result 字样，不能证明真有成功 Write/Edit。
5. **作用域契约仍未落地**。`docs/guardrails/HarnessHome.md:46` 要求 persisted assistant binding，而 `context-assembler.ts:70`、collector:530 仍使用 cwd equality。项目主动采用助理目录时会同时激活助理自动服务，这是文档已承认的 Program C P0，不应靠新 memory 插件扩大隐式作用域。
6. **资料陈旧风险**。memory-system-v3.md 仍写调度未实现、记忆 GUI 未实现、未提自动提取；当前 guardrail/代码已含 scheduler 与维护 UI。调研应以代码和新 guardrail 为基准，不能直接抄 V3 交接文档作为产品现状。

## 建议优先改进的 5 点

1. 先修现有全文召回与 Native/MCP 公共实现，统一路径边界、行号、长度预算、时间衰减；补相同 fixture 跑三 Runtime 的契约测试。
2. 做“记忆从哪来、现在是否生效”的最小 UI：来源会话/原句、写入时间、作用域、确认/待确认、替代/撤销。继续以可导出本地文件为事实源。
3. 把显式“记住/忘记/改成”与自动抽取分开。自动抽取先生成候选、去重/冲突检查，减少错记；关联来源，减少每条只截前 500 字符造成的事实丢失。给调用频率、token/费用、失败可见性可解释的策略。
4. 落地 assistant/project/global 的明确绑定和检索作用域；绑定只控制自动服务，不禁止用户通过普通文件工具读自己的目录。
5. 建立可测的记忆评估集：正文唯一命中、中文同义词、跨会话偏好更正、时间过期、忘记后不再召回、跨 Runtime 一致性。先设召回/错误记忆/上下文成本指标，再决定是否需要 hybrid/vector、重排或引入外部服务。

## 运行证据边界

- 此次运行了纯本地临时探针 `/tmp/codepilot-memory-current-probe.ts`，用 `node --import tsx` 执行：正文唯一查询漏检和 Native sibling path read 均确认。fixture 已自动删除，脚本保留供复核。第一次 tsx CLI 因 sandbox 禁止 IPC listen 失败，改 node --import tsx 后成功；这不是产品失败。
- 父任务先前报告 Dev 出现 createMemorySearchTools/loadConfiguredHarnessHome is not a function；本次未在现存 /tmp 日志找到可引用的新原始日志，也未复现 live。源码 `builtin-tools/index.ts:342-349` 的 catch 会记录 load failure 并缺席整个 memory tool group；`232-250` 的 catch 会缺席 canonical projection。故若当时日志准确，该轮能力确实降级，不能因聊天普通回复成功就认定记忆正常。但不能据此认定所有正式安装包受影响或确认其根因。

## 复核基线与权限前提补充

- 复核时 HEAD：`67507a0075af5ae9d27549b655ae32acaec913f1`；package.json version `0.67.16`；Node `v22.22.0`。工作树已有 6 个用户/主任务改动：Gemini 相关 5 文件和 MessageInput.tsx；本探针未更改它们。
- 复核命令（在仓库目录执行）：`node --import tsx /tmp/codepilot-memory-current-probe.ts`。依赖直接导入当前生产 `indexWorkspace`、`searchWorkspace`、`createMemorySearchTools`，不复刻实现，不调用网络/真实 Provider、不打开用户 DB。
- 成功输出：`{"bodyOnlyQuery":[],"titleQuery":["notes.md"]}` 与 `{"nativeSiblingRead":"SYNTHETIC-SIBLING-FIXTURE"}`。
- 越界触发条件：Native 已成功挂载 `codepilot_memory_get`；模型/调用方传入可控 `file_path` 指向名称以 workspace 字符串开头的兄弟目录，且该文件对应用进程用户可读。攻击者若通过非可信上下文诱使模型调用该工具，可能读取预期 workspace 外的文件；本次只证明读取边界缺陷，并未测试提示注入链或任何数据外传。
- 权限代码证据：Native cwd 即挂载范围见 `src/lib/agent-tools.ts:142-169` 与 `src/lib/builtin-tools/index.ts:338-349`；工具按 `safe_read` 声明进入 `PERMISSION_SAFE_TOOLS`（`src/lib/agent-tools.ts:53-56`），`wrapWithPermissions` 的 `232-235` 对该集合直接跳过执行前审批。Plan 模式也保留 safe-read 工具（`agent-tools.ts:142-154`）。因此不能假设会有额外弹窗拦截这个参数；仍不等于任意远端请求可直接调用工具。
- 另一类 symlink 逃逸在代码上也未检查，但本次未为 symlink 另跑 fixture，不标成已复现。

## 可复现证据（不依赖 /tmp 脚本保留）

以下为本轮实际探针的等价相对导入版本。后续复核可临时保存为仓库根目录 `.memory-review-probe.ts`，使用 `node --import tsx .memory-review-probe.ts` 执行，完成后移除该临时脚本。只创建合成临时目录，不访问真实记忆文件；源码未修前应得到上文两个输出。未来修复后的预期是正文查询命中、兄弟目录读取被拒绝。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexWorkspace } from './src/lib/workspace-indexer';
import { searchWorkspace } from './src/lib/workspace-retrieval';
import { createMemorySearchTools } from './src/lib/builtin-tools/memory-search';
async function main() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepilot-memory-probe-'));
 try {
  const workspace=path.join(root,'work'); const sibling=path.join(root,'work-other');
  fs.mkdirSync(workspace); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(workspace,'notes.md'),'# Meeting\n\nThe selected color is cerulean.\n');
  fs.writeFileSync(path.join(sibling,'synthetic.txt'),'SYNTHETIC-SIBLING-FIXTURE');
  indexWorkspace(workspace);
  console.log(JSON.stringify({bodyOnlyQuery: searchWorkspace(workspace,'cerulean'),titleQuery:searchWorkspace(workspace,'Meeting').map(x=>x.path)}));
  const memoryTools=createMemorySearchTools(workspace);
  const read=await memoryTools.codepilot_memory_get.execute!({file_path:'../work-other/synthetic.txt'}, {toolCallId:'probe',messages:[]});
  console.log(JSON.stringify({nativeSiblingRead:read}));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(err=>{console.error(err);process.exitCode=1;});
```
