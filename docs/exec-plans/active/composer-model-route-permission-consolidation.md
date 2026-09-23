# Composer 模型路线、能力参数与权限入口收口

> Runtime ownership（2026-09-01）：本计划继续负责 Picker 左右栏、收藏、搜索、能力菜单与 footer 布局；聊天开始后的 Runtime owner、route mutation 服务端规则、legacy empty pin 恢复和跨 Runtime handoff 由 [runtime-thread-ownership-and-handoff.md](runtime-thread-ownership-and-handoff.md) 负责。两份计划不得各自实现一套切换 resolver。

> 创建时间：2026-08-25
> 最后更新：2026-08-26
> 状态：🚧 Code/UI/迁移与自动化验证已完成；三 Runtime 真实 effective-wire smoke 尚未执行，Tier 2 未关闭
> 风险等级：Tier 2（权限边界 / Runtime wire / Provider+Model route）
> 事实基线：[T3 Code 模型输入区、统一侧边栏与内置浏览器专项调研](../../research/t3code-composer-sidebar-browser-ux-2026-08-25.md)
> 关联计划：[跨 Runtime 权限模式](runtime-permission-modes.md)、[模型目录与推理强度统一适配](model-capability-reasoning-refresh.md)
> 未关闭门禁：[B-032 Composer 权限收口缺三 Runtime 真实 effective-wire smoke](issue-tracker.md#b-032-composer-权限收口缺三-runtime-真实-effective-wire-smoke)

## 用户问题与争议

用户希望减少 Composer 下方第二条控制栏。模型选择器是明确的两层结构：**左侧是 Runtime，右侧是该 Runtime 当前可用的 provider instance + model 路线**；Provider 只是右侧路线的执行身份和辅助信息，不是左侧一级导航。路线可搜索、可收藏；reasoning、context 等参数由模型真实能力生成一个菜单；Runtime 切换也由这个统一选择器承载，权限和运行状态收进输入框。独立 Code / Plan 控件可以去掉。

争议在于：Plan 不是提示词风格，而是三 Runtime 的硬只读权限边界。Claude 使用 SDK plan，Native 只装配 safe-read 工具，Codex 使用 read-only sandbox。方案只能移除 `ModeIndicator`，不能删除 Plan 语义或把旧 plan session 静默改成 code。`ask` 仍存在于 session / Bridge schema，也必须进入迁移盘点。

本计划不重做 `runtime-permission-modes.md` 已建立的 reviewer/bypass 能力；它负责把现有 mode + permission profile 映射为一个用户可预测的权限选择器，并保持实际 wire 不变或更保守。

## 状态

| Phase | 内容 | 状态 | 用户能看到什么 |
|-------|------|------|----------------|
| Phase 0 | Legacy mode POC + 权限双向映射合同 | ⚠️ 部分完成 | 双向映射、ask 盘点与 no-touch 合同已落；真实三 Runtime wire 待跑 |
| Phase 1 | Runtime → 可用模型路线搜索与收藏 | ✅ 修正完成 | 左上收藏完整组合；左侧切 Runtime；右侧按供应商分组列可用模型 |
| Phase 2 | Capability descriptor 参数菜单 | ✅ 实现完成 | 仅展示当前 Runtime/渠道/模型真实可变的参数；固定 1M 不出现假开关 |
| Phase 3 | 单一 Composer footer | ✅ 实现完成 | Runtime、模型能力、权限和运行状态都在输入框内；外部 ActionBar 已删除 |
| Phase 4 | 兼容迁移、真实 smoke 与文档收口 | 🚧 自动化通过 / Tier 2 待跑 | unit/build/smoke/UI 已验；真实权限 wire 未验收 |

## 决策日志

- 2026-08-25：移除独立 Mode 控件，但把 Plan 并入 Permission 的“只读规划”档位；prompt / plan artifact 不能替代硬权限。
- 2026-08-25：首轮将收藏 identity 定为 `providerInstanceId + modelId`；2026-08-26 用户验收纠正为完整组合，见下方 superseding 决策。
- 2026-08-25：搜索、最近、收藏并存。shipped catalog 有 29 个 preset / 121 条 preset-model 记录；实际 composer 数量仍以用户启用数据为准，虚拟列表不是预设结论。
- 2026-08-25：descriptor 必须是 Runtime + protocol + model 粒度，并区分 `selectable / fixed / unsupported / unknown`。
- 2026-08-25：首版复用现有 mode/profile schema，不在 UI 重构中顺带做破坏性 DB 收敛。
- 2026-08-25：实现统一 access adapter：`plan + default ↔ read_only`，另外三档 canonical encode 为 `code + profile`；`ask` decode 为带 legacy marker 的 default，加载不写库。会话 API 在任何写入前同时校验 mode/profile，切档只发一个 validated PATCH。
- 2026-08-25：只读盘点本机现有数据：main chat `ask=6`（最近更新 2026-05-15）、Bridge binding `ask=0`；另有 main chat `plan=4`。未读取或输出消息内容，旧 row 不自动迁移。
- 2026-08-26：按用户复核纠正信息架构：Picker 左栏主体固定为 Runtime（Claude Code / CodePilot / Codex），Provider 不能占据一级导航；右栏随 Runtime 变化，只显示当前可用模型，并按 Provider 小标题分组。独立 Runtime selector 同时移除。
- 2026-08-26：收藏作为左栏 Runtime 列表上方的固定快捷入口；V2 identity 为 `runtimeId + providerInstanceId + modelId`。点击收藏必须一次切换完整组合，不能只换模型后沿用旧 Runtime/Provider。
- 2026-08-26：权限默认档的用户文案从“需要时询问我”统一为“请求批准”，不改变 `default` wire；上下文/运行状态从左侧工具组移到发送按钮正左侧。
- 2026-08-26：复审否决 V1 收藏按“当前 Runtime”猜迁移。V1 尚未发布且缺 Runtime identity，解析时 fail closed；V2 失效项保留在 Favorites lane，使用 snapshot 解释原因并允许取消收藏，但永远不可执行。
- 2026-08-26：`context_1m` 拆成 provider requested 与当前 session effective。模型能力归一化只改 effective UI/request，不得自动 PUT 共享 provider option；只有用户显式切换参数才持久化 provider requested 值。
- 2026-08-26：参数与权限菜单不再为解释文案预留大面积横向空间。能力菜单固定 240px、权限菜单固定 256px 并限制 viewport；固定 1M、特殊 effort 与四档权限说明改为短句，完整权限风险告警和真实不可用原因仍保留，长诊断在菜单内换行。

## Phase 0：Legacy mode POC + 双向映射合同

### 用户结果 / 验收入口 / 明确不做

- 用户结果：本阶段不改变界面；它为后续 UI 收口提供“旧会话绝不静默扩权”的证据。
- 验收入口：构造 `code / plan / ask × default / auto_review / full_access` session，通过三 Runtime resolver/发送路径记录 effective wire。
- 明确不做：不改 Composer，不批量迁移 DB，不删除 `mode` 或 Bridge ask。

### Canonical UI 档位

| UI 档位 | 用户语义 | 显式选择后的 canonical persistence | Effective wire 所有权 |
|---------|----------|------------------------------------|----------------------|
| `read_only` / 只读规划 | 读取、分析、规划，不写工作区 | `mode='plan'`, `permission_profile='default'` | Plan 分支优先于所有 profile |
| `default` / 请求批准 | 按规则执行，高风险时请求用户批准 | `mode='code'`, `permission_profile='default'` | `runtime-permission-modes.md` |
| `auto_review` / 替我审批 | 支持的 Runtime 交给受限 reviewer | `mode='code'`, `permission_profile='auto_review'` | capability gate + fail-closed degradation |
| `full_access` / 完全访问 | 跳过一般确认，不覆盖 human-only 边界 | `mode='code'`, `permission_profile='full_access'` | bypass wire；不得覆盖 Plan |

### Persisted → UI decode

1. `mode='plan'` → `read_only`，profile 只作为 legacy metadata，不改变 effective UI。
2. `mode='code' | undefined` → 按 normalized permission profile 映射另外三档。
3. `mode='ask'`：主聊天显示 `default + legacy marker`，不在加载时写 DB；Bridge binding 继续走现有 ask 语义，不由 Composer 迁移。
4. unknown/invalid value fail closed 到 `default` 并留下可诊断 source breadcrumb，不得推断 full access。

### UI → persistence encode

- 只有用户显式切换档位才写 canonical pair；加载旧 row 不做自动 rewrite。
- 必须满足 `decode(encode(uiLevel)) === uiLevel`。
- 对 legacy row 不要求 `encode(decode(row)) === row`；但未操作时 row 必须 no-touch，发送 wire 不得比当前语义更宽。
- 从 `read_only` 离开只允许由用户显式选择另外档位；页面初始化、模型切换、Runtime 切换、resume 均不得自动改写。

### 执行清单

- [x] 建纯函数 `decodeComposerAccessLevel(mode, profile, capability)` 与 `encodeComposerAccessLevel(level)`，UI 和 API tests 共用。
- [x] 表驱动覆盖全部 mode/profile 组合、invalid、capability degraded、round-trip 和 no-write-on-load。
- [ ] POC 记录 Claude `permissionMode/bypassPermissions`、Native tool surface、Codex thread/turn sandbox/reviewer。
- [x] 盘点 DB 中 main chat `ask` 与 Bridge binding `ask` 数量、来源和最近使用；只记录计数与分类，不输出用户内容。
- [x] 如当前 main chat ask 语义无法证明，按更保守的 `default` 处理并在计划决策日志记录，不靠猜测迁移。

### Phase 0 退出门槛

- 三 Runtime 的 plan 实收均为只读；任一 Runtime 扩权即阻断 Phase 3。
- mapping table 经 Claude/Codex review，无 P1/P2 未处理 finding。
- `runtime-permission-modes.md` 仍是 reviewer/bypass 的权威，不出现第二套 resolver。

## Phase 1：Runtime → 可用模型路线搜索与收藏

### 用户结果 / 验收入口 / 明确不做

- 用户结果：trigger 显示当前 Runtime 图标与模型；弹层左侧为 Runtime，右侧可搜索并一键选择该 Runtime 当前可用的准确路线。
- 验收入口：新会话 Composer 与既有 ChatView Composer；打开后切换三种 Runtime，确认右侧列表同步变化，再覆盖搜索、收藏、模型切换、关闭后焦点恢复。
- 明确不做：不把 Provider 作为左侧层级，不展示当前 Runtime 不可执行的模型，不让 picker 显示 server feed 之外的可执行模型，不做云同步。Favorites 仅是 Runtime 列表上方的精确组合快捷入口。

### 数据合同

```ts
interface ModelRouteFavoriteV2 {
  runtimeId: RuntimeId;
  providerInstanceId: string;
  modelId: string;
  providerNameSnapshot: string;
  modelNameSnapshot: string;
  createdAt: number;
}
```

- identity 是 `runtimeId + providerInstanceId + modelId`；snapshot 只用于 provider 删除/不可达时的诚实恢复文案。未发布的 V1 缺 Runtime identity，解析时直接拒绝，不得按当前 Runtime 猜迁移；未来若出现已发布旧格式，必须先定义可证明的 source breadcrumb 再单独迁移。
- 使用版本化 app-local storage `codepilot:model-route-favorites:v2`，与现有 recents 同 scope；不得新增 DB schema。若未来需要跨设备同步，单独迁移到 server settings。
- provider rename 使用 live name；provider 删除、未登录、目录缺失或 Runtime 不兼容时，收藏快照不得猜测执行路线。它不进入普通 Runtime 的“可用模型”列表，但必须在 Favorites lane 以 disabled 行显示真实原因并保留取消收藏入口，避免 badge 与可管理条目数量不一致。

### 排序与搜索

先按当前 Runtime 做可执行性过滤，再按 `exact > prefix/fuzzy text quality > favorite boost > recency > catalog order` 排序。favorite boost 不得压过明显更准确的文本匹配，也不得把不兼容路线重新带回列表。

- [x] 复用现有 `composer.searchModels` i18n key。
- [x] 搜索 model id/name、provider name/alias；不搜索 secrets、base URL 原文或隐藏 metadata。
- [x] Favorites 固定在 Runtime 上方；普通 Runtime lane 仍可用收藏作排序信号。收藏 lane 的 live 组合点击一次更新 Runtime + Provider + Model；失效组合 disabled、说明原因且可删除。
- [x] 右侧按 provider instance 分节，Provider 图标/名称作为小标题，下面只列该组可用模型。
- [x] 保留 `useProviderModels` resolved pair、idle/noCompatibleProvider/send gates 和 runtime-disabled reason。
- [ ] 统计真实启用模型数与渲染耗时；只有达到实测阈值才引入虚拟列表，并补滚动/键盘 active item 测试。
- [x] 收藏、取消、V1 fail-closed、provider 重命名/删除、同 model 两个 provider instance 的单测；失效收藏可见/可删另有 E2E。

## Phase 2：Capability descriptor 参数菜单

### 用户结果 / 验收入口 / 明确不做

- 用户结果：一个能力 trigger 汇总当前有效值，例如 `High · 1M`；菜单只显示真实可调项。
- 验收入口：切换 Runtime、provider、model 后观察菜单项目和 effective value。
- 明确不做：不把 catalog capacity 伪装成 option，不为 T3 截图补产品尚无 wire 的 Fast Mode。

### 合同

```ts
interface ModelOptionSupport {
  state: 'selectable' | 'fixed' | 'unsupported' | 'unknown';
  runtime: string;
  protocol: string;
  modelIds: string[];
  fixedValue?: string | boolean;
  source: string;
}
```

- [x] descriptor 消费 `model-capability-reasoning-refresh.md` 的能力事实，不复制一套 model table。
- [x] 首批覆盖已验证 effort；context 仅覆盖真实 provider option 且确实可变的模型。
- [x] default-1M 模型标 `fixed`，菜单省略开关或只读展示，不发送 no-op beta header。
- [x] `unknown` 一律不渲染为可操作控件；source breadcrumb 可供诊断但不泄露凭据。
- [x] 模型切换后无效旧值归一化，并显示一次可见调整通知；归一化只改当前 session effective 值，禁止自动写共享 provider option。
- [x] descriptor、sanitizer、实际 request shape 共用 explicit upstream model allowlist，并有 fail-closed contract tests。
- [x] 参数菜单保持 240px 紧凑宽度；固定值与 provider 特殊说明使用短句，翻译不得反向撑宽弹层。

## Phase 3：单一 Composer footer

### 用户结果 / 验收入口 / 明确不做

- 用户结果：输入框 footer 左侧容纳添加/工具、Runtime+模型统一选择器、能力摘要和权限；上下文/运行状态紧邻发送按钮左侧；外部 `ChatComposerActionBar` 与独立 Runtime selector 消失。
- 验收入口：新会话、已有会话、窄窗口、streaming、pending approval、RunCockpit 打开状态。
- 明确不做：不把 RunCockpit 全部诊断信息常驻 footer，不删除旧 mode/profile schema，不改变 in-flight permission 处理规则。

- [x] `ChatPermissionSelector` 使用 Phase 0 adapter，新增“只读规划”档位及真实 degraded 状态。
- [x] Runtime 切换并入模型选择器；Permission、RunCockpit 迁入 `MessageInput` footer；保持权限始终可见。
- [x] RunCockpit/上下文状态位于 `PromptInputTools` 之后、Send 之前；窄宽度换行时仍与提交区同一末端顺序。
- [x] 删除可见 `ModeIndicator` 与外层 `ChatComposerActionBar` 的重复布局，但先保留兼容组件/字段直到回归通过。
- [x] 360px/480px/默认桌面宽度下定义 overflow：低频 Run 状态可折叠，模型路线与权限不可被无提示隐藏。
- [ ] streaming disabled、权限弹窗、模型 refetch、session PATCH race 与 focus restore 回归。
- [x] New Chat Page 与 ChatView 两条自治路径使用同一 picker/adapter，不合并其不同初始化责任。
- [x] 权限菜单固定宽度并对真实 capability/degraded 原因换行；完整 elevation 告警仍留在确认弹窗。

## Phase 4：迁移、验证与文档收口

### 用户结果 / 验收入口 / 明确不做

- 用户结果：升级前后的 plan/code/ask 会话可以继续发送，界面与实际权限一致。
- 验收入口：三 Runtime 旧 session、provider 多实例、不可用收藏、默认/固定 1M、窄 Composer。
- 明确不做：没有真实 wire / UI smoke 就不标 `Smoke passed`；不在本计划删除 Bridge ask。

- [x] Targeted：mapping、permission wire、model picker、descriptor、resolved pair、session PATCH tests。
- [x] 全量 `npm run test`。
- [x] `npm run test:smoke`：新会话/已有会话、搜索/收藏、切 Runtime/权限、发送。
- [ ] Tier 2 真实 smoke：Claude / Native / Codex 各至少一条 plan read-only 和一条 default turn；记录 effective wire/source。
- [ ] 无障碍：已移除不完整的 `listbox/option` 伪语义并保留原生 button 键盘操作，disabled reason 可读；完整的焦点循环、Esc/focus restore 仍待专项验收。
- [x] 更新 `ComposerModelSelection.md`、`Runtime.md`、`PermissionBoundary.md`、`docs/insights/chat-composer-redesign.md`；在 `runtime-permission-modes.md` 记录 UI consolidation ownership。
- [x] 更新/清理 i18n，复用 `composer.searchModels`，不留重复或死 key。

## 关键文件与预计责任

| 模块 | 文件 | 责任 |
|------|------|------|
| Composer shell | `src/components/chat/MessageInput.tsx`, `ChatView.tsx`, `src/app/chat/page.tsx` | footer 布局、两条入口一致性、send gate |
| Model picker | `src/components/chat/ModelSelectorDropdown.tsx`, `RuntimeSelector.tsx`, `src/hooks/useProviderModels.ts` | Runtime 一级导航、可用 route 搜索/收藏、resolved pair、compat reason |
| Permission UI | `ModeIndicator.tsx`, `ChatPermissionSelector.tsx`, `src/lib/permission/profile.ts` | UI adapter、只读规划、profile capability |
| Capability | `EffortSelectorDropdown.tsx`, `src/lib/claude-model-options.ts`, provider catalog/capability helpers | descriptor 与 effective request |
| API/DB | `/api/chat`, `/api/chat/sessions/[id]`, DB accessors | legacy mode/profile no-touch、显式切档写入 |

## 不变量与反例

- Plan 永远比 full_access / global skip 优先；删除 UI 不能改变 resolver precedence。
- provider/model favorite 不能绕过 Runtime filter；普通 Runtime 可用列表不得混入 disabled 的不兼容模型或失效快照。Favorites lane 例外展示 disabled 快照，只用于解释与删除，不能触发 route 切换。
- `providerId === ''` 与 `undefined` 继续严格区分。
- API idle / runtime 真空不能合成假 provider 后继续发送。
- fixed capability 不得作为可切换控件；unknown 不得乐观显示。
- 模型路线变化造成的 capability 归一化不得写共享 provider option；发送使用当前 session effective 值，显式用户操作才更新 requested/persisted 值。
- UI label、persisted pair、effective wire 三者任一不一致都算 blocker。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| _待执行_ | claude_code | TBD | TBD | TBD | legacy plan → 只读规划 → send | ⏳ | session id + effective permission wire |
| _待执行_ | codepilot_runtime | TBD | TBD | API key | default / fixed capability / favorite route | ⏳ | session id + request marker |
| _待执行_ | codex_runtime | Codex Account / managed provider | TBD | OAuth / API key | legacy plan → read-only sandbox | ⏳ | session id + thread/turn echo |
| 2026-08-25 | Browser UI | runtime-filtered local catalog | GPT/Claude routes | local app data | route search/favorite/parameter/access menus；1280/800/480/320px Composer | ✅ PASS | interactive UI smoke；favorite 已恢复到 smoke 前状态 |
| 2026-08-25 | Automated | N/A | N/A | fixture | targeted contracts + full unit + build + smoke | ✅ PASS（全量 E2E 另有 stale failures） | capability/request 25/25；permission targeted 36/36；full unit 5359 pass + 1 skip；build PASS；smoke 22/22 |
| 2026-08-26 | Browser UI + Playwright | Runtime-first local catalog | runtime-compatible routes | local app data | 左栏 Claude Code / CodePilot / Codex；右栏可用模型随 Runtime 切换；无独立 Runtime selector | ✅ PASS | interactive UI 中 Codex 171 routes → Claude Code 60 routes；`project-panel.spec.ts` Composer 用例通过 |
| 2026-08-26 | Playwright + Node | full local catalog | exact favorite combination | local app data | 收藏在 Runtime 上方；右侧 Provider 分组；收藏一键切 Runtime+Provider+Model；“请求批准”；上下文紧邻 Send | ✅ PASS | `project-panel.spec.ts` 7/7；定向 unit 158/158；`tsc --noEmit` PASS |
| 2026-08-26 | Automated regression | N/A | N/A | fixture | repository typecheck / harness boundary / full unit / smoke；统一侧栏旧 FileTree fixture 改为显式打开 Files 后复跑 | ✅ PASS | full unit 5361 pass + 1 skip；smoke 22/22；scoped Composer/Sidebar 7/7；ESLint 0 errors |
| 2026-08-26 | Node + Playwright | N/A | mixed live/deleted routes | fixture | V1 不猜 Runtime；失效收藏 badge/disabled reason/删除闭环；模型归一化不 PUT provider `context_1m`，切回支持模型恢复 requested 1M | ✅ PASS | targeted unit 61/61；`project-panel.spec.ts` 10/10；`tsc --noEmit` PASS |
| 2026-08-26 | Final regression | N/A | Runtime-filtered routes | fixture + local web server | picker i18n、requested/effective context、失效收藏、权限文案、完整回归与构建 | ✅ PASS（真实 permission wire 仍待） | `npm run test` 5363 pass + 1 skip；scoped Playwright 14/14；smoke 23/23；ESLint 0 errors；production build 137 pages（同源 `/tmp` 副本） |
| 2026-08-26 | Electron dev + Node + Playwright | live local catalog | DeepSeek V4 Flash fixed-1M route | 本机开发客户端 + fixture | 参数菜单 320→240px；`1M（固定）`；权限四档短说明；动态原因受限宽度换行 | ✅ PASS（不改变 wire） | 真实 Electron 热更新截图/AX；density + capability/provider targeted 160/160；`project-panel.spec.ts` 13/13；`npm run test` 5383 pass + 1 skip；ESLint/docs-drift PASS |

## 完成定义

- mapping contract、UI、persistence 和三 Runtime wire round-trip 一致。
- 用户可从左侧选择 Runtime，再在右侧按 Provider 分组搜索模型；也可从 Runtime 上方收藏区一键切完整 Runtime+Provider+Model 组合。失效项只在 Favorites lane disabled 展示，可解释、可删除、不假成功。
- capability menu 不显示假参数。
- capability / permission menu 的解释文案不把输入框控件横向撑宽；窄窗口下动态原因可完整换行。
- Composer 外部第二条 ActionBar 删除后，窄宽度、streaming、approval 与 Run 状态仍可用。
- Tests pass + 三 Runtime Smoke Ledger 有真实记录 + Review passed；否则只能标对应的较低状态。
