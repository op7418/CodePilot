# Agentic Architecture Map — Why

## 为什么需要这份映射

这次重构同时碰到了 Provider、Models、Runtime、Plugins、Chat、Health、Logs、Memory、Tasks。每个点单独看都是一个局部问题，但用户感受到的是同一件事：**系统到底会怎么执行我的任务，我应该在哪里管理能力，出问题时我该看哪里。**

用户提供的 Agentic AI System 参考图有价值，因为它帮我们重新确认分层：

- Provider / Model 是地基，不是用户任务。
- Skills / MCP / CLI 是工具，不是 Agent。
- Claude Code / Codex / OpenClaw 才是执行引擎或 Agent runtime。
- Health / Logs 是观测和取证，不是万能修复。
- Memory / Tasks / Heartbeat 只有在闭环成熟后才应成为用户可管理功能。

## 对当前产品的启发

### 1. 不要把工具误叫 Agent

Design Agent 被隐藏后，设计能力应该回到 MCP/Skill 调用路径。用户表达设计意图时，系统通过 prompt/capability injection 让模型知道可以调用对应 MCP，而不是常驻一个“Design Agent”按钮。

同理，Skills、MCP、CLI 统一到“扩展能力”是对的，但它们仍然是工具层。未来如果支持 Codex / OpenClaw，它们应进入 Runtime / Agent 层，而不是 CLI 工具列表。

### 2. Provider 事实错误会放大成用户信任问题

火山返回 100+ 模型、OpenRouter 返回 300+ 模型，看起来都是“发现成功”，但对用户来说这可能是错误清单。Coding Plan 用户关心的是“我买的套餐到底能用什么”，不是“这个域名能列出什么”。

所以模型发现不应只问 endpoint 有没有返回；还要问这个 provider 的计费/套餐语义是什么。

### 3. Chat 页不该变成设置页

Chat 的核心是把任务交给 Agent。Runtime、模型、权限、上下文成本都很重要，但它们应该在需要时解释，而不是平铺成一排按钮。

这也是“按钮越少，离 AGI 越近”的实际含义：不是少做功能，而是减少用户每次发送前的显式决策。

### 4. 诊断应降级为证据链

过去诊断功能的问题是：它试图告诉用户“问题是什么”和“我能修复”，但真实根因经常在 provider、CLI、runtime、网络、权限、模型套餐之间。自动诊断很容易误导。

更可靠的产品路径是 Health + sanitized logs + clear status。用户可以看到状态，出问题可以打开日志文件夹或导出诊断包。

### 5. 半成品功能不要抢入口

Memory、Scheduled Tasks、Heartbeat、Assistant 这些方向都重要，但它们属于更高层的 Memory/Reliability 能力。只要还没有稳定触发、失败状态、UI 管理和测试证据，就不应该在 Settings 里打稳定标签。

## 对开发流程的启发

### 文档服务下一次修复

文档不只是记录“这次为什么这么改”，还要让下一次接手的人知道：

- 这块属于哪一层。
- 哪些不变量不能碰。
- 哪些旧决策已经废弃。
- 哪些功能只是 preview / audit。
- 哪些测试能证明它真的可用。

因此这份映射应该作为跨模块重构前的第一层校准文档。

### Review 不只看代码 bug

这次很多关键问题不是 TypeScript 错误，而是产品层错误：

- 火山模型“能探测”但不代表“套餐可用”。
- Skills 商店藏进全局创建菜单，功能还在但用户找不到。
- 诊断入口承诺过强，用户会被误导。
- MCP/CLI/Skill 合并后导航层级变复杂。

后续 review 要同时检查：

1. 代码是否正确。
2. 事实来源是否过期。
3. 页面心智是否一致。
4. 用户是否能找到功能。
5. 文案是否承诺了系统做不到的事。

### 执行计划要标状态，而不是只列任务

适合继续沿用 `docs/exec-plans/active` 的方式，但每个计划要更明确标注：

- `stable`：已有测试和真实路径。
- `preview`：功能可见但边界未完全闭环。
- `audit`：需要核准代码与文档是否一致。
- `deferred`：明确不在本期做。

这比单纯写 TODO 更能服务下一次修复。

## 判断一句话

如果一个功能让用户更清楚“这次任务会由谁、用什么工具、在什么约束下执行”，它就符合这次重构目标。

如果一个功能只是把内部模块多暴露一个入口、或把不稳定能力包装成稳定功能，它就跑偏了。
