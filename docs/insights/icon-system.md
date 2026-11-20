# 图标体系与表意校准 — 产品思考

>
> 对应执行计划：docs/exec-plans/completed/phase-7-icon-system.md（Phase 7 第一刀，已归档）

## 解决的用户问题

用户在使用中明确指出：**同一个图标被到处复用，表意不清**。这不是"图标不好看"，而是三件事叠在一起让产品显得没有自己的视觉语言：

1. **一个图标背多个概念**。`Brain` 同时表示模型、Assistant、Memory、Task、空状态；`Lightning` 同时表示 Runtime、Skills、插件、快速动作；`Terminal` 同时表示 CLI、Shell、命令、终端设置、Slash command。用户在不同页面看到同一个图标，却指向不同东西，心智模型被打乱。
2. **同一概念在不同页面用了不同图标**，反过来也成立。
3. **图标来源混杂**：大部分走 Phosphor，`ai-elements` 里有直引 Phosphor，`attachments` / `RateLimitBanner` 还混着 Lucide，品牌图标用 LobeHub。四套来源拼在一起，风格不统一。

## 为什么这样设计，而不是直接换图标库

最直接的做法是"把 Phosphor 全局换成 HugeIcons"。**我们没有这样做**，因为那只换皮、不解决问题——把一个被复用 5 次的 `Brain` 换成一个被复用 5 次的 HugeIcons glyph，表意混乱原样保留。

真正的痛点是**语义**，所以第一刀建的是 **CodePilot 自己的 semantic icon layer**（`<CodePilotIcon name="model" />`），而不是 vendor icon 名：

- **一个概念 = 一个 glyph**，由 `SEMANTIC_MAP` 这一处强制裁决。要表达"模型"只能写 `name="model"`，不能写 `Brain`；具体落到哪个图，是这一层的内部决定，业务代码不关心。
- **冲突在这一层被逼着解决**，而不是散落在各组件里自己挑：
  - `model` 改用 Cube（立方体 = 资产），把 `Brain` 让给 `memory`（记忆才是"脑"）。
  - `runtime` 改用 Chip（芯片 = 执行环境），退役被滥用的 `Lightning`。
  - `cli` 用 CommandLine、`terminal` 用 Terminal——**明确不再是同一个图**：CLI 是命令工具目录，terminal 是 shell 会话。
  - `skill`（模型可调用能力，魔法棒）与 `plugin`（安装包 / 容器，拼图块）分开；`mcp`（协议 / server）与 `cli` 分开。
- **品牌图标继续用 LobeHub**，绝不用通用线性图标伪装品牌——Anthropic / OpenAI / OpenRouter / Kimi 的识别度不能被一个泛化 glyph 替代。这条边界写死在 semantic layer 注释里。

主图标库选 **HugeIcons**（free core package），理由是它是一套风格一致、覆盖面广的语义图标集；缺图时**降级到 Phosphor 别名记录在案，绝不临时混入第三套库**（Lucide / Tabler / Hero 一律拒绝）。

## 反馈驱动的迭代

- **触发点**就是用户反馈"图标重复、表意不清"，所以 Phase 0 先做 inventory + semantic taxonomy，让后续 review 看语义表而不是凭感觉争论。
- **颜色语义**是 Codex review 推动收敛的：默认 light（图标多数是文字标签旁的次要 affordance，不该和标签抢注意力），只有 anchor（左栏 / 侧栏快捷动作 / Settings 左导航，没有相邻标签或本身就是主导航目标）和 active / selected 才走 dark，通过 `text-inherit` 跟随父级颜色。品牌 mark（MonolithIcon）单独默认 `text-foreground`，因为它代表 app 身份不是"标签旁的图标"。
- **表意错位的实战修正**：插件卡按 `source` 分流（真插件用 `plugin`，project/global skill 用 `skill`）；MCP 管理页的 `WifiHigh` 状态图标改成 `mcp`——都是"管道通了但图标含义错了"的具体案例。

## 不靠自觉、靠 guardrail

语义层只有配上守卫才不会回潮。ESLint 规则：业务代码 `import { Brain | Lightning | Terminal }` from `@/components/ui/icon` 被 **error 级禁用**；Phosphor / Lucide 直引被重定向到 `CodePilotIcon`（warn）。新 PR 想绕过语义层重新引入冲突 glyph，过不了 lint。这样"收敛"不是一次性大扫除，而是有边界守着的稳定状态。

## 未来方向与已知局限

- **53 个结构性图标仍留在 Phosphor 兼容层**（CaretDown / CheckCircle / Warning / SpinnerGap / X / Lock 等）。它们要么 HugeIcons 没有等价、要么视觉差异可忽略，作为 wrapper compatibility 保留，不为"数字归零"硬迁。
- **ai-elements 内部图标**按"接近 upstream primitive vs CodePilot 自维护"分类，本轮不强制清零，例外清单留在 handover 文档逐文件标注。**shadcn primitive 6 个**（command / sheet / select / dialog / spinner / dropdown-menu）是生成代码，迁移会与下次 shadcn 升级冲突，明确不动。
- 图标体系是"视觉锚点与图标体系"这条线的**第一刀**。点阵风格的 loading / 空状态 / 背景纹理等视觉记忆点，排在图标语义稳定之后，作为后续子计划，不在本计划内铺开。当前已落地的视觉锚点首批是新应用图标 MonolithIcon、居中欢迎布局、widget 区域点阵卡。
- 局限：semantic layer 是"产品概念 → glyph"的单向映射，不解决"同一概念在不同尺寸 / 状态下的细微视觉差异"——那由尺寸 token（sm/md/lg/xl）和颜色约定承担，不在 alias 层表达。
