# T3 Code 最新版 Runtime 适配复盘，以及 CodePilot 会话中切换 Runtime 的取舍

> 日期：2026-09-01
>
> T3 Code 检查点：`8b033de48247086c1b6c6968ce7cf33b358a1ec5`（`main`，比 `v0.0.38-nightly.20260901.1245` 多 4 个提交）
>
> T3 Code 上次分析基线：`643daa51616d0bfcd4c8235ae6966a68f106dcfe`（2026-08-23）
>
> CodePilot 检查点：`7d610dbeb4e2d102c6ae08c811ed4029713f8586`
>
> 结论性质：源码与文档分析；没有改产品代码，也没有用真实账号跑跨 Runtime 对话

## 一句话结论

**保留多 Runtime，但不再把“已开始的同一个聊天里随意换 Runtime”当成常规能力。**

建议改成：

1. 新聊天开始前自由选择 Runtime；
2. 第一条真实消息发出后，这个聊天由该 Runtime 负责到底；
3. 想换 Runtime 时，使用“在另一个 Runtime 中继续”创建新聊天或分支，并把必要上下文做成一次明确交接；
4. 只有适配器明确保证“底层会话仍是同一个”时，才允许在原聊天里换模型或换账号。

用户的判断基本正确：**当前会话内跨 Runtime 切换带来的收益偏小，可靠性、缓存、维护和解释成本偏大，而且 CodePilot 目前还存在真实的上下文断层。**

这不是要退回单 Runtime，而是把两个概念拆开：

- 多 Runtime 是产品能力；
- 一个聊天同时属于多个 Runtime，不应该是默认产品语义。

## 1. 这次看了什么

我把本地 T3 Code 从上次分析的提交更新到 2026-09-01 的最新 `origin/main`。两点需要先说明：

- 当前主线比最新 nightly 标签多 4 个提交，所以这里分析的是**最新源码**，不等同于所有用户已经安装的稳定版。
- 从上次基线到现在共有 188 个提交、866 个文件变化，约新增 8.5 万行、删除 1.6 万行。完整差异可看 [T3 Code compare](https://github.com/pingdotgg/t3code/compare/643daa51616d0bfcd4c8235ae6966a68f106dcfe...8b033de48247086c1b6c6968ce7cf33b358a1ec5)。

本次重点不是比较界面，而是回答三个问题：

1. T3 Code 的多执行引擎适配为什么能继续扩张，却没有让共同层频繁改形；
2. 它到底允许不允许在一个聊天里随意换执行引擎；
3. CodePilot 当前切换 Runtime 的真实行为、成本和替代方案是什么。

## 2. 先把几个词说人话

为了避免后面被术语绕进去，这里只保留三个概念：

- **Runtime**：真正负责“这一轮怎么运行”的执行引擎，例如 Claude Code、CodePilot Native、Codex app-server。它决定会话、工具、权限、事件和恢复方式。
- **Provider instance**：同一种执行引擎的一份具体配置，例如 Codex 工作账号、Codex 个人账号、Claude 的另一个配置目录。
- **Model**：这次实际使用的模型及其选项。

一个简单比喻：

- Runtime 是厨房；
- Provider instance 是这间厨房使用的账号和库存；
- Model 是这一单请哪位厨师、用什么火候。

换厨师不一定要换厨房；换账号也可能仍在同一间厨房；但直接换厨房，原来的备料、工单和进度通常不能假装无缝接上。

## 3. T3 Code 最新版最值得参考的地方

### 3.1 它把“共同规则”和“各家怪脾气”隔开了

T3 Code 的共同适配器只规定一组稳定动作：开始会话、发送一轮、中断、响应批准、响应用户输入、停止、读取、回滚和输出统一事件。具体 Claude、Codex、Grok、Cursor、OpenCode 怎么做，留在各自适配器里。[ProviderAdapter.ts](../../资料/t3code/apps/server/src/provider/Services/ProviderAdapter.ts)

这次更新最有说服力的地方不是接口长什么样，而是变化分布：

- 188 个提交里，`ProviderAdapter.ts` 和 `ProviderDriver.ts` 没有改；
- 公共 Runtime 合同只增加了 5 行，主要是 MCP 批准和自动压缩信息；
- 同期 OpenCode、Grok、Codex、Claude 的具体实现和测试增加了数千行。

这说明共同边界确实吸收了供应商差异。不是每接一家就把聊天 UI、会话表和所有公共类型再改一遍。

**CodePilot 可参考的不是 Effect 这套技术本身，而是边界：公共层只理解“会话动作和统一事件”，供应商私有状态留在适配器内部。**

### 3.2 它明确区分“驱动类型”和“同类型的多个实例”

T3 Code 的一个 Driver 可以创建多个相互隔离的实例。每个实例拥有自己的进程、状态、配置、显示名和账号，但共同遵守相同适配器接口。[ProviderDriver.ts](../../资料/t3code/apps/server/src/provider/ProviderDriver.ts)

这解决了一个很容易混乱的问题：

- “Codex”是执行方式；
- “Codex Work”和“Codex Personal”是两份账号配置；
- `gpt-*` 是这份账号下选择的模型。

CodePilot 当前虽然已经有 Runtime、Provider、Model 三层，但在 composer、会话 PATCH、模型过滤和账号兼容判断中仍然互相牵连。T3 Code 的做法提醒我们：**账号多开不应该通过再造一个 Runtime 来解决。**

### 3.3 它并不允许一个聊天随意跨执行引擎切换

这是本次最关键的事实。

T3 Code 在聊天开始后会锁定 Provider Driver。模型选择器只展示：

- 同一个 Driver；
- 并且属于同一个 `continuationGroupKey`，即确实能访问同一份底层会话状态的实例。

不兼容的项会直接提示“请新建聊天后切换 Provider”。这个限制同时存在于前端和服务端，不是只把按钮变灰。[ChatView.logic.ts](../../资料/t3code/apps/web/src/components/ChatView.logic.ts) · [ModelPickerContent.tsx](../../资料/t3code/apps/web/src/components/chat/ModelPickerContent.tsx) · [ProviderCommandReactor.ts](../../资料/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)

例如：

- 两个 Codex 账号共享同一个 `CODEX_HOME` 时，T3 Code 认为它们可以继续同一个线程；
- 完全不同的 `CODEX_HOME` 被视为另一个工作环境，不出现在已有聊天里；
- Claude 账号若使用不同配置目录，通常也不能在已有聊天里互换。

这些规则可在 [Codex 多账号文档](../../资料/t3code/docs/user/providers-codex.md) 和 [Claude 多账号文档](../../资料/t3code/docs/user/providers-claude.md) 中核对。

换句话说，T3 Code 的产品规则不是“切换很自由”，而是：

> 只有底层会话身份没有变，才允许看起来像切换。

这比单纯比较 `runtimeId` 更准确。

### 3.4 模型切换由适配器声明，不由 UI 猜

T3 Code 的适配器会声明已有会话是否支持换模型：

- `in-session`：可以在原生会话里换；
- `unsupported`：必须开新会话。

最新一轮中，Grok 专门增加了“已有线程换模型”的支持。公共层不因为 Grok 特例再写一套硬编码，而是读取适配器能力决定行为。[提交 `7880a6e58`](https://github.com/pingdotgg/t3code/commit/7880a6e58)

这个模式很值得借鉴：**能不能切，不应由“看起来都是模型”来决定，而应由拥有底层会话的适配器作出保证。**

### 3.5 最新变化越来越集中在“运行可靠性”，不是继续堆入口

上次分析以后，T3 Code 和 Runtime 相关的重要变化包括：

- 服务端负责判断线程是否真正结束，减少客户端掉线造成的假状态；
- 清理 Provider 事件订阅和空闲 CPU 消耗；
- OpenCode 补齐子任务批准、停止和模型目录；
- Codex 修复输入缓冲随内容增大而越来越慢的问题；
- Claude 可在老聊天耗尽配额前主动提示并执行压缩；
- 用量扫描只读取日志新增部分，不再每次从头扫；
- 区分普通输入、缓存读取、缓存写入，并修复 Claude 缓存 token 被按普通输入高估的问题。

相关提交：[服务端线程收口](https://github.com/pingdotgg/t3code/commit/f32f9a2f4) · [事件泄漏与空闲 CPU](https://github.com/pingdotgg/t3code/commit/0bfb6df34) · [增量用量扫描](https://github.com/pingdotgg/t3code/commit/8f1ef8b9e) · [Claude 缓存计价修复](https://github.com/pingdotgg/t3code/commit/9072aa1fd) · [Claude 老线程压缩](https://github.com/pingdotgg/t3code/commit/c7222ca4d)

这里的共同点是：**适配完成不等于能发出第一条回复；真正难的是长时间运行后，状态、用量、恢复和资源释放仍然可信。**

## 4. CodePilot 当前会话内切换 Runtime，实际发生了什么

CodePilot 当前支持三个 Runtime：

- `claude_code`
- `codepilot_runtime`
- `codex_runtime`

composer 在聊天已有内容时仍允许切换。切换会更新 `chat_sessions.runtime_pin`，并插入一条 Runtime 切换标记。[ChatView.tsx](../../src/components/chat/ChatView.tsx)

表面上三条路径都叫“继续聊天”，实际语义并不相同：

| 切到哪里 | 下一轮如何获得旧上下文 | 实际连续性 |
|---|---|---|
| Claude Code | Runtime 切换会清掉 Claude 原生 session id；下一轮把数据库历史压成 `<conversation_history>` 后新开 Claude 会话 | 大意通常还在，但不再是同一个原生会话，提示词形状和缓存都会变 |
| CodePilot Native | 每轮从数据库读取最多 200 条消息，再组装成标准消息发送 | 历史相对完整，但系统提示、工具定义、模型和协议可能全部不同，缓存通常另起一份 |
| Codex Runtime | 有 Codex thread id 就恢复该 thread，没有就新建；发送时只把当前用户输入交给 Codex | 首次中途切入时看不到之前的聊天；切走再切回时，会恢复旧 Codex 分支，看不到中间发生在其他 Runtime 的轮次 |

证据位置：

- Claude 重新包装数据库历史：[claude-client.ts](../../src/lib/claude-client.ts)
- Native 每轮读取数据库消息：[agent-loop.ts](../../src/lib/agent-loop.ts)
- Codex 只恢复自己的 thread，并把当前 prompt 交给 `turn/start`：[codex/runtime.ts](../../src/lib/codex/runtime.ts)
- 三套 Runtime ref 被分别保留：[runtime/session-store.ts](../../src/lib/runtime/session-store.ts)

### 4.1 这已经不是纯成本问题，而是正确性问题

最明显的例子：

1. 用户先和 Claude 聊了 10 轮；
2. 中途切到 Codex；
3. Codex 第一次收到的只是第 11 轮当前问题，不会自动收到前 10 轮；
4. 再切回 Claude、聊两轮；
5. 再切回 Codex，Codex 恢复的是它自己的旧 thread，也不知道那两轮发生过什么。

用户看到的是一条连续时间线，后端实际已经分叉成几条各自不完整的会话。

这类问题很难通过“再补一个 marker”修好，因为 marker 只能告诉 UI “这里换过”，不能把另一个 Runtime 的原生状态、工具结果和缓存搬过来。

### 4.2 当前还有一个很具体的边角缺口

切换标记的写入端已经接受 `codex_runtime`，但解析和展示端仍只识别 Claude Code 与 CodePilot Native。因此含 Codex 的标记可能被当成普通内容或无法正确展示。[RuntimeSwitchMarker.tsx](../../src/components/chat/RuntimeSwitchMarker.tsx)

这不是本报告要顺手修的单点 bug，但它很能说明问题：每增加一个 Runtime，所有“任意两者之间切换”的边角都会继续增长。

当前至少 28 个 `src` 文件直接出现 `runtime_pin`、Runtime 切换标记或相关状态；单个 `session-runtime-immunity.test.ts` 已有 1336 行。文件数不等于坏设计，但说明这项能力确实把复杂度扩散到了会话、模型、权限、任务、统计、标记和 E2E。

## 5. 为什么切 Runtime 会影响缓存和成本

### 5.1 缓存不是“记住聊天”，而是“重复利用相同的开头”

模型缓存可以理解为：一本很长的书，前 100 页刚读过，下一次如果前 100 页一模一样，就直接从第 101 页继续处理。

这个“开头”不只包括用户看见的聊天，还可能包括：

- 隐藏系统指令；
- 工具名称、说明、参数结构和顺序；
- 开发者指令；
- 历史消息；
- 模型和推理设置。

OpenAI 官方说明，只有渲染后的整个前缀匹配才能复用；改变模型、工具、推理设置或压缩方式，都可能从变化处开始失去命中。[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)

Anthropic 同样要求前缀一致，并把工具、system 和 messages 按顺序纳入缓存。默认缓存通常是 5 分钟，也可选择 1 小时。[Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

所以跨 Runtime 切换通常意味着：

- 换了供应商或模型；
- 换了系统提示；
- 换了工具集合及格式；
- 换了历史消息的组织方式；
- 可能还换了会话恢复协议。

这几乎必然是另一组缓存，而不是继续吃原来的缓存。

### 5.2 更准确的说法不是“缓存被删除”，而是“停止复用”

切换 Runtime 不一定会把上一家的缓存立刻物理删除。短时间内切回完全相同的请求前缀，理论上仍可能命中旧缓存。

但 CodePilot 当前有两个现实障碍：

- 切 Runtime 会清掉 Claude 的原生 session id，回去时又把数据库历史重新包装，前缀形状已经变化；
- Codex 虽然保留自己的 thread，但恢复的是旧分支，不是用户眼中的完整聊天。

因此“切回去还能命中”不能当成产品保证。

### 5.3 一个容易理解的成本例子

以 OpenAI 当前对 GPT-5.6 及后续模型的官方说明为例：

- 第一次写缓存约为普通输入成本的 1.25 倍；
- 后续读取约为 0.1 倍；
- 同一个长前缀连续用 10 次，1 次写入 + 9 次读取约为 2.15 倍；
- 如果 10 次都不能复用，就是 10 倍。

也就是在这个理想例子里，**可复用前缀这一部分**能少约 78.5% 的输入成本。这个数字来自官方示例，不是 CodePilot 整体账单的预测。[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)

必须同时看到三个限制：

1. 新增消息、输出 token 和不能缓存的部分仍照常计费；
2. 不同模型、不同供应商的价格和缓存规则不同；
3. Claude Code、Codex 订阅账号的影响有时表现为额度消耗、限流和首 token 延迟，不一定直接表现成 API 账单。

因此，不能说“禁掉切换就能让全产品成本下降 78.5%”。更合理的估计是：

- 对**频繁来回切、上下文很长、按 API token 计费**的聊天，稳定在一个 Runtime 后，可复用输入部分的成本改善可能达到 30%～80%；
- 对短聊天、只切一次、订阅 CLI 或原本就没命中缓存的情况，直接金额收益可能很小；
- 如果全体用户中会话内切换比例本来就很低，全产品平均成本收益大概率只是低个位数，主要收益会变成可靠性和维护成本下降。

以上区间是基于缓存规则的情景推断，不是实测数据。

### 5.4 CodePilot 已有缓存统计，但还回答不了这次问题

CodePilot 已经持久化 `cache_read_input_tokens` 和 `cache_creation_input_tokens`，Settings 也展示聚合缓存命中率。[UsageStatsSection.tsx](../../src/components/settings/UsageStatsSection.tsx)

但当前聚合看不到：

- 哪一次之前刚发生 Runtime 切换；
- 切换前后的模型、工具和 Provider 是否相同；
- 这次上下文来自原生 resume、数据库重放，还是全新会话；
- 切换后首 token 延迟和错误率发生了什么变化。

因此，用户关于“切换后命中率骤降”的方向是对的，但产品还缺少能把因果关系量出来的分组数据。

## 6. 收益和代价是否不成比例

我的判断是：**对当前 CodePilot，是。**

### 6.1 这项能力真正提供的收益

- 某个 Runtime 卡住或额度用完时，用户不用离开当前页面；
- 高级用户可以用另一个模型继续尝试；
- 开发阶段便于比较不同 Runtime。

这些都是真收益，但不一定要求“同一个聊天 id、同一条时间线、原地切换”。新建分支同样能满足，而且更诚实。

### 6.2 它带来的代价

| 维度 | 当前代价 | 判断 |
|---|---|---|
| 上下文正确性 | 三个 Runtime 用三种方式续聊，Codex 有已核实的丢上下文和旧分支恢复 | 很高 |
| 缓存与延迟 | 跨 Runtime 基本会换缓存组，Claude 回切还会改变历史包装 | 中到高，长对话最明显 |
| 用户理解 | UI 看似一条连续聊天，模型实际看到的内容不同 | 很高 |
| 工程维护 | Runtime × Provider × Model × 权限 × MCP × resume 状态互相组合 | 很高 |
| 测试成本 | 3 个 Runtime 有 6 个有方向的跨切组合；若增至 4 个，会变成 12 个 | 随 Runtime 数量加速增长 |
| 功能使用频率 | 用户反馈自己很少用；当前没有产品数据证明它是高频主路径 | 低或未知 |

只要一项低频功能同时制造“用户以为连续、实际不连续”的风险，它就不应该继续占据主路径。

## 7. 推荐的产品方案

### 7.1 默认规则：一个聊天，一个 Runtime 所有者

建议把规则定义为：

> 第一条真实用户消息发出时，确定该聊天的 Runtime 所有者；此后不允许把这个聊天直接交给另一个 Runtime。

这条规则应由服务端强制，UI 只是展示。这样旧客户端、后台任务或其他入口也不能绕开。

在第一条消息前，Runtime 仍可自由选择；因此不会损失“用户想用 Claude、Native 还是 Codex 开始工作”的核心价值。

### 7.2 把“切换”改成“在另一个 Runtime 中继续”

用户点击后创建一个新聊天或分支，并明确显示：

> 已从原聊天交接到 Codex。这是一个新的底层会话，缓存将重新建立。

交接内容可以包括：

- 原聊天链接；
- 一份短摘要；
- 已确认的目标、决定和未完成项；
- 当前 workspace / branch / cwd；
- 用户选中的文件或附件；
- 必要的工具结果摘要。

不要迁移另一个 Runtime 的私有 session id，也不要声称这是原生无缝续聊。

这样做的好处是：

- 原聊天仍然完整、可复查；
- 新 Runtime 从一个明确、可测试的交接包开始；
- 切换失败不会污染原聊天；
- 用户能同时保留两种方案并比较结果；
- 缓存重建是一次明确事件，不会在一条时间线里反复打断。

### 7.3 同 Runtime 内切换要走能力声明

原聊天里仍可保留部分切换，但必须同时满足：

1. 同一个 Runtime / Driver；
2. 同一个 continuation group，即能访问同一份底层会话；
3. 适配器声明支持已有会话换模型或账号；
4. 服务端再次校验，不只相信前端选择器。

建议的能力不要只放一个 `canSwitch`，而是分清：

- `canSwitchModelInSession`
- `canSwitchInstanceInSession`
- `continuationGroupKey`
- `canImportContextFromAnotherRuntime`

其中最后一项即使为真，也应创建新线程；它表示“能接收交接包”，不是“共享原生会话”。

### 7.4 暂时不要保留“高级模式强制原地切换”

如果默认锁住，但高级菜单还允许强制切换，维护和正确性负担基本仍在，只是入口藏深了。

更稳妥的顺序是：

1. 先全部改成创建分支；
2. 收集真实使用数据；
3. 若确实存在分支无法满足的高价值场景，再为那个具体场景设计窄能力。

不要先保留一个含义模糊的总开关。

## 8. 建议从 T3 Code 吸收什么，以及收益有多大

| 优先级 | 可参考做法 | 对 CodePilot 的直接收益 | 工作量判断 | 建议 |
|---|---|---|---|---|
| P0 | 已开始聊天锁定 Driver / Runtime | 直接消除 Codex 丢历史和旧分支恢复这两条已知错误路径 | 中 | 应做 |
| P0 | 用 continuation group 判断账号是否可续聊 | 多账号不再靠名字、Provider id 或 UI 猜兼容性 | 中 | 应做 |
| P0 | 服务端拥有最终会话绑定和切换校验 | 解决前端乐观状态、分两次 PATCH、后台入口互相漂移 | 中到高 | 应做 |
| P1 | “换 Runtime”改为创建带交接包的新分支 | 保留用户价值，同时让上下文和失败边界可解释 | 中到高 | 应做 |
| P1 | 适配器声明已有会话换模型能力 | 新 Provider 不再到处加特判 | 中 | 应做 |
| P1 | 用量区分缓存读、写、普通输入和真实节省 | 能回答切换到底贵了多少，避免假 0 和错误计价 | 中 | 应做 |
| P1 | 长线程主动压缩并显示阈值 | 降低长聊天突然耗尽额度的风险 | 中 | 借鉴思路，不照搬命令 |
| P2 | 日志用量只扫新增内容 | 大量历史会话下减少统计页 I/O 和 CPU | 中 | 数据量增长后做 |
| P2 | 服务端统一线程 settled 状态、回收 Provider 订阅 | 降低假运行、事件泄漏和空闲消耗 | 高 | 纳入 Runtime 生命周期专项 |

### 8.1 预期收益分级

如果只做“锁定 + 分支交接”，可预期：

- **正确性：非常高。** 已知的 Codex 首次切入丢历史、回切恢复旧分支两类路径从产品主线消失。
- **用户清晰度：高。** 一条聊天不再假装有一个统一大脑，来源和边界更容易解释。
- **测试组合：高。** Runtime 从 3 增加到 4 时，不再需要把所有 12 个有方向的跨切组合都当作原聊天续聊来验证；只需验证每个 Runtime 自身生命周期和一份统一交接合同。
- **维护成本：中到高。** 不能立刻删除全部 28 个相关文件，但可逐步移除跨 Runtime ref 共存、marker、切换后目录重算和全局/会话双重覆盖等状态组合。
- **缓存与直接成本：受人群影响很大。** 对频繁切换的长 API 会话收益可观；全产品平均收益要看真实切换率，预计低于可靠性收益。

## 9. 推荐的目标结构

无需照搬 T3 Code 的全部技术栈，可以在 CodePilot 现有 Runtime contract 上增加一个服务端权威绑定：

```text
ThreadExecutionBinding
  runtimeId
  providerDriver
  providerInstanceId
  continuationGroupKey
  activeModel
  capabilitySnapshot
  nativeSessionRef
  startedAt
```

核心规则：

- UI 从这个绑定读取事实，不分别重新推导；
- Runtime 私有 ref 仍是 opaque，不摊到 UI；
- 一个聊天只有一个 active native session ref；
- 另一个 Runtime 的历史 ref 不作为“回来继续”的暗线保存在同一聊天里；
- 跨 Runtime 操作创建新聊天，并留下 `sourceThreadId` 和交接摘要；
- Provider / Model 变化由 adapter capability 和 continuation group 决定。

CodePilot 已经有统一 Runtime event、permission、capability 和 session ref 合同，所以不是推倒重来。真正要改的是**会话所有权规则**，不是重写三个 Runtime。

## 10. 建议的落地顺序

### 阶段 A：先阻止继续产生模糊状态

- 服务端拒绝已开始聊天的跨 Runtime PATCH；
- composer 在第一条真实消息后锁住 Runtime；
- 原入口改成“在另一个 Runtime 中继续”；
- 修正或迁移已有 Runtime switch marker 的展示；
- 旧聊天保持可读，不尝试自动合并几个 Runtime 的私有分支。

### 阶段 B：补齐明确的会话绑定和能力声明

- 引入 `ThreadExecutionBinding`；
- 为三个 Runtime 填 capability；
- 给 Provider instance 生成 continuation group；
- 同 Runtime 换模型和账号由服务端校验；
- 把全局默认值只用于新聊天，已有聊天不再受全局漂移影响。

### 阶段 C：做可量化的成本和质量闭环

按“切换或分支发生前后”记录以下非敏感指标：

- Runtime、Provider driver、模型；
- 上下文来源：原生 resume / DB 重放 / 新会话交接；
- cache read / write / uncached input token；
- 首 token 延迟、总耗时、错误类别；
- `runtime_switch_attempted`、`runtime_fork_created`、`runtime_switch_blocked`。

不记录提示词、文件内容、账号邮箱或凭据。

至少按用户、workspace、长短会话和计费方式分组，否则总体平均数会掩盖真正受影响的人群。

## 11. 不建议照搬 T3 Code 的部分

- 不为这次调整引入整套 Effect / event-sourcing 重写。CodePilot 现有 contract 足够承接会话所有权收口。
- 不原样复制 T3 Code 的 picker 和文案。我们需要的是兼容性规则，不是它的界面形状。
- 不为了多账号立刻复制 shadow home。先定义 continuation group，再根据每个 CLI 的真实状态存储方式实现。
- 不把“源码里有自动压缩”直接当成成熟能力。阈值、压缩后缓存变化和信息损失仍需 CodePilot 自己验证。
- 不用缓存成本作为唯一理由。即使某个订阅账号没有直接 token 账单，上下文正确性也足以支持锁定策略。

## 12. 最终建议

建议正式拍板下面这句话，作为后续实现和文案的共同原则：

> CodePilot 支持多个 Runtime，但一个已开始的聊天只归属于一个 Runtime。跨 Runtime 继续工作通过新聊天分支和明确上下文交接完成；原聊天内只允许适配器明确保证兼容的模型或账号切换。

这能同时保留 CodePilot 的差异化能力和架构弹性，又把一项低频、难解释、难验证的“伪无缝切换”从主路径移除。

如果只看账单，收益可能因用户切换率低而不大；如果把上下文正确性、后续新增 Runtime 的组合复杂度、测试和用户信任一起算进去，收益很大，而且越早收口越划算。

## 证据边界

本报告做到的证据层级：

- 拉取并逐文件检查 T3 Code 最新 `main`；
- 对比上次分析基线与最新提交；
- 检查 CodePilot 三个 Runtime 的 session ref、历史组装、切换 PATCH、Codex turn 输入和用量展示；
- 用 OpenAI、Anthropic、Google 官方文档核对缓存语义。

本报告没有做到：

- 没有启动 T3 Code 做真实多账号聊天；
- 没有用 CodePilot 真实账号跑 Claude → Native → Codex → 回切 smoke；
- 没有从真实用户数据计算 Runtime 切换率与切换前后缓存命中率；
- 没有验证各订阅 CLI 内部如何把缓存收益折算为额度。

因此，架构和正确性结论置信度高；全产品成本降幅仍需埋点或本地匿名统计验证。

## 主要来源

- [T3 Code 最新源码检查点](https://github.com/pingdotgg/t3code/commit/8b033de48247086c1b6c6968ce7cf33b358a1ec5)
- [T3 Code 本次完整差异](https://github.com/pingdotgg/t3code/compare/643daa51616d0bfcd4c8235ae6966a68f106dcfe...8b033de48247086c1b6c6968ce7cf33b358a1ec5)
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Google Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)
- [上一轮 T3 Code 总体分析](./t3code-reference-analysis-2026-08-24.md)
- [上一轮 T3 Code Composer / Sidebar / Browser 专项](./t3code-composer-sidebar-browser-ux-2026-08-25.md)
