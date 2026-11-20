# 竞品聊天滚动 / 流式性能做法对照(OpenCode / Codex / CraftAgent,2026-07-04)

> 类型:竞品源码调研。为 CodePilot 虚拟滚动与流式性能改造提供参考。
> 关联:本调研直接支撑 `docs/research/stability-fluency-runtime-audit-2026-07-04.md`（已删除，见 git 历史） 的 §4.2(虚拟滚动)与 §4.3(初始滚动动画)。
> 方法:把三个项目**拉到最新版**(旧本地副本已过时 2.5–3 个月)后只读精读聊天滚动/流式相关源码。所有结论附 `文件:行号`。

## 拉取的版本(均为最新)

| 项目 | 上游 | 版本 / commit | 栈 | 旧副本落后 |
|------|------|--------------|----|-----------|
| OpenCode | `anomalyco/opencode` (dev) | `7a8e7c8`(2026-07-04) | SolidJS | 旧 `opencode-dev` 停在 2026-04-07,且 `virtualizer.ts` 已从 `packages/ui` 迁到 `packages/session-ui`,并新增 timeline 虚拟化系统 + Worker 高亮——旧副本完全没有 |
| Codex | `openai/codex` (main) | `98d28aa`(2026-07-03) | Rust / ratatui TUI | 旧快照 2026-04-25 |
| CraftAgent | `lukilabs/craft-agents-oss` (main) | `v0.10.5`(2026-07-01) | Electron + React | 旧副本 v0.8.3(2026-04-03),`ChatDisplay.tsx` 改了 423 行,但滚动/流式核心机制未变 |

---

## 一图流对照

| 维度 | CraftAgent(React,同栈) | OpenCode(Solid) | Codex(TUI) |
|------|------------------------|-----------------|------------|
| **长列表策略** | **不虚拟化**:反向分页,初始只渲染尾部 20 个 turn,上滚 +20 | **真虚拟化**:`@tanstack/virtual-core@3.17.0`(Solid 封装),扁平行模型 | 历史甩给终端原生 scrollback,应用只画底部视口(DOM 无等价物) |
| **流式节流** | 渲染层 300ms 节流 `displayedText` + 缓冲门控(达阈值才显示正文) | 24ms 打字机 pace + 增量 markdown 解析 + Worker 高亮 | 换行门控增量提交 + 帧率合并(≤120fps)+ 自适应分块 |
| **token→UI 解耦** | 底层每 delta setState,喂给 markdown 的文本 300ms 才更 | 累计全文进 signal,`createPacedValue` 按 24ms 窗吐增量 | token 进队列,commit tick 按帧率逐行揭示 |
| **代码高亮** | 主线程 shiki + 模块级 LRU 200 | **Web Worker 里跑 shiki**,增量 token DOM 打补丁 + LRU 200 | syntect 单例 + 512KB/1万行护栏降级 |
| **stick-to-bottom** | `ResizeObserver` + `isStickToBottomRef` + 20px 阈值 + 200ms 去抖 | `create-auto-scroll` hook(ResizeObserver 同帧锁底 + `overflow-anchor:none`)+ tanstack `anchorTo:"end"` | `follow_bottom` 哨兵:插入前在底才跟随 |
| **初次进入会话** | **瞬时**:`useLayoutEffect` + `scrollIntoView({behavior:'instant'})` | **瞬时**:`initialOffset=MAX` + rAF `scrollToEnd`,深链首进用 `"auto"` | N/A(终端) |
| **翻页锚定** | 记录旧 `scrollHeight`→rAF 补 `scrollTop` | `capturePrependAnchor`/`applyPrependAnchor` rAF 循环 + core `shouldAdjustScrollPositionOnItemSizeChange` | `CachedRenderable` 按宽度缓存行高 |

**三个横向共识**(对 CodePilot 最有指导意义):
1. **没有一个用朴素全量渲染**——要么虚拟化(OpenCode),要么分页封顶 + memo(Craft),要么甩给终端(Codex)。
2. **全部把 token 到达与 UI 渲染解耦**——没有一个逐 token 重解析 markdown。
3. **初次进入会话全部瞬时定位、无平滑动画**——直接印证 audit §4.3 对"进历史会话滚一下"的修法(`initial="smooth"→"instant"`)是对的。

---

## 二、各家关键技术(浓缩,附证据)

### CraftAgent(可迁移性最高——同为 Electron+React)

- **反向分页**:`ChatDisplay.tsx:512` `TURNS_PER_PAGE=20`,`allTurns.slice(startIndex)` 只渲染尾窗;动态高度靠浏览器自然回流,零测量。代价:上方历史仍在 DOM(仅被分页数量限制,无回收)。
- **300ms 渲染节流**:`TurnCard.tsx:389` `CONTENT_THROTTLE_MS=300`;`:2410-2419` streaming 时 `setDisplayedText` 最多 300ms 一次、结束立即全量。把 react-markdown 全量重解析从"每 token"降到"每 300ms"。**最高性价比、最易抄**。
- **缓冲门控** `shouldShowContent`(`TurnCard.tsx:451`):代码块≥15 词 / 标题≥12 / 列表≥20 / 普通 40 词+结构 / 封顶 2.5s 才开始显示正文,避免早期无意义重排。纯函数。
- **ResizeObserver 置底**:`ChatDisplay.tsx:1104` `isStickToBottomRef = distanceFromBottom<20`;ResizeObserver 观察内容容器,非聚焦面板瞬时置底、粘底态 200ms 去抖后 smooth。
- **初次瞬时定位**:`ScrollOnMount`(`:411`)`useLayoutEffect`+`scrollIntoView({behavior:'instant'})`,paint 前完成 + 500ms 抑制窗防随后 smooth 打架。
- **memo 比较器**:`TurnCard` 自定义比较——streaming/incomplete 一律重渲染,completed 靠 id + 引用相等跳过;把流式期重渲染面积收敛到最后一张卡。
- **状态分片**:Jotai `atomFamily` 每会话独立 atom——这是"不虚拟化也不炸"的前提,不能只抄节流漏掉分片。
- ⚠️ 反面提示:`MemoizedMarkdown` 号称"按 block 分块记忆"但实际只按整串 `React.memo` 比较,且聊天路径没用它;别照抄注释期待增量。

### OpenCode(虚拟化 + Worker 高亮的最完整参考)

- **虚拟化 = `@tanstack/virtual-core@3.17.0`**(Solid 封装),与 `@tanstack/react-virtual` **共享同一 core**——下列能力全 React 可用:`anchorTo:"end"` / `followOnAppend` / `scrollToEnd()` / `rangeExtractor` / `shouldAdjustScrollPositionOnItemSizeChange` / `takeSnapshot()` / `initialMeasurementsCache`。
- **本地补丁值得移植**:core 里 `calculateRange` 前把 `scrollOffset` 夹到 `[0, totalSize-outerSize]`(防置底/高度校正瞬间用越界 offset 算错可见区间),框架无关。
- **扁平行模型 + 稳定 key + 身份稳定 reconcile**:`timeline-row.ts` 9 种行各有稳定 `key()`;`row-reconciliation.ts` `reuseTimelineRows`+`stabilizeContextKey` 在分组成员增删时把新 key 回绑到最早的旧 key,防 key 漂移误判新增(有独立单测)。
- **动态高度校正**:`measureElement` 的内建 ResizeObserver;OpenCode 包装 `resizeItem`(`message-timeline.tsx:454`)——巨幅变化(如代码块高亮完成,`|Δ|>clientHeight`)时先"钉住"可见行 index 两帧防回收,再交 core 修偏移,粘底态则重贴底。异步内容用 `scheduleConnectedMeasure`(rAF+`isConnected` 守卫)。
- **打字机节流** `createPacedValue`(`message-part.tsx:238`):`TEXT_RENDER_PACE_MS=24`、积压≤512 立即倒出、步长随剩余量放大、吸附词边界。setTimeout 时间窗(非 rAF)。
- **Web Worker 卸载 shiki(本调研最高价值一条)**:`markdown-shiki.worker.ts` 用 `@shikijs/stream` 的 `ShikiStreamTokenizer`,每次只 `enqueue` 新增 suffix,返回 stable/unstable 两段;`markdown-worker-transport.ts` per-key 保证"在途唯一 + 最新请求胜出"背压;`markdown.tsx updateCodeBlock`(`:596`)把 token **imperative 增量打补丁**到 `<code>`(保留稳定前缀、只 diff tail),**绕开框架 reconciliation**;失败降级主线程,key LRU 200。主线程只做廉价 span 增量,流式高亮不阻塞滚动/输入。
- **增量 markdown 解析**:`markdown-stream.ts project()`——新文本是旧前缀且尾块是未闭合 code fence 时只追加 suffix,不重 lex 全文;`markdown-code-state.ts` 追踪已应用 DOM 的代码 token 状态(stableCount/unstable/generation)决定增量 append 还是整块重画。
- **stick-to-bottom 两层**:`create-auto-scroll.tsx` ResizeObserver 同帧锁底 + `userScrolled` + `overflow-anchor:none` + `markAuto/isAuto` 区分程序/用户滚动;叠加 tanstack `anchorTo:"end"`。虚拟化下滚真底:滚动前先把容器 `style.height=totalSize` 防浏览器用旧高度夹回目标 offset。
- **初次瞬时** + 重进会话用 `timelineCache`(`takeSnapshot`/`initialMeasurementsCache`,上限 16)恢复高度即刻正确;深链首进用 `"auto"`,仅用户导航用 `"smooth"`。

### Codex(TUI,思路借鉴)

- 历史甩给终端 scrollback,主视图天然 stick-to-bottom(DOM 不可迁移)。
- **换行门控增量提交** `markdown_stream.rs`:token 累积,仅 `\n` 时把"新完成的逻辑行"提交为不可变行,`committed_line_count` 游标保证每行只解析发射一次——对应 React 的"已完成块 memo 化 + 稳定 key,末尾只留一个进行中节点"。
- **帧率合并** `FrameRequester`:任意处只发"请重绘"请求 → scheduler 合并 → 钳到 ≤120fps(`app.rs:396` `COMMIT_ANIMATION_TICK`)——对应 rAF 合并 + 批处理;但 8.33ms 节拍别照搬(终端重绘廉价、DOM 回流贵,DOM 端用 ~30–60ms/rAF)。
- **自适应分块** `streaming/chunking.rs decide()`:平滑 1 行/tick,积压(深度≥8 或最老≥120ms)切 catch-up 一次排空,滞回防抖——成熟的打字机节流参数参考。
- **高亮护栏**:`render/highlight.rs:567` 512KB / 1万行超限退化纯文本 + syntect 单例——对应超大代码块尺寸阈值降级 + highlighter 单例。

---

## 三、对 CodePilot 的可迁移结论与优先级

CodePilot 现状:`MessageList.tsx:327` 全量 map、无虚拟化;文本有 100ms 节流但非文本 emit 无节流;shiki 高亮在**主线程**(有 LRU,无 Worker);进历史会话有平滑滚动动画(`src/components/ai-elements/conversation.tsx:17` `initial="smooth"`)。

按"收益/成本 + 可迁移确定性"排序:

1. **初始滚动改瞬时(立刻,一行)** —— 三家全部瞬时定位,直接印证 audit §4.3。`src/components/ai-elements/conversation.tsx:17` `initial="smooth"→"instant"`。
2. **流式渲染节流(立刻,低成本)** —— 抄 Craft 的 300ms `displayedText` 节流最简单(token 摄入与 markdown 重解析解耦);想要更顺可上 OpenCode 的 24ms 打字机 pace。与 audit §4.1"非文本 emit 节流"合并做。
3. **Worker 卸载 shiki 高亮(高价值,中成本,强烈建议)** —— OpenCode 这套 worker 管线**零 Solid 依赖**,`markdown-shiki.worker.ts`/`worker-protocol`/`worker-transport`/`worker-queue`/`code-state` 逻辑高度可移植(算法零 Solid 依赖,但**需新增 `@shikijs/stream` 直接依赖、并验证 Next/Electron 的 Web Worker 打包**,不是复制文件即可用);唯一 Solid 耦合点(`createResource` 触发)换成 React hook + **保留 imperative DOM 增量应用**(绕开 React reconciliation)。CodePilot 现有主线程 shiki+LRU 保留为降级路径。收益 = 流式高亮期主线程不再掉帧。
4. **虚拟化用 `@tanstack/react-virtual`(高价值,中-高成本,选型已明确)** —— 修正 audit §4.2 原来的"virtua 或 react-virtual 二选一":**优先 react-virtual**,因为它与 OpenCode 共享 `virtual-core`,OpenCode 整套打法(`anchorTo:"end"`、包装 `resizeItem` 钉行、`measureElement` 动态测高、`takeSnapshot` 缓存、offset 夹紧补丁、扁平行模型 + 身份稳定 reconcile)可作为最贴近的实现蓝本,是最短且有实证的迁移路径。四个必须处理的交互(流式跟随/翻页锚定/rewind 定位/追加滚动)OpenCode 都给了现成解法。

> **依赖/打包风险(Codex 复核补充)**:`@tanstack/react-virtual` 与 `@shikijs/stream` **当前都不是 CodePilot 的直接依赖**;`virtua` 只在 lockfile 里作为传递依赖出现,不能当直接依赖用。两者都需显式的新增依赖决策,且 Worker 卸载高亮 + 虚拟化必须先验证 Next.js/Electron 的 worker 打包链路(worker 文件 bundling、CSP、Electron 下 module worker 支持)才能落地——本文档的"可迁移"指算法/思路层面,不代表零集成成本。
5. **增量 markdown 解析 + stick-to-bottom hook(按需)** —— OpenCode 的 `project()`(未闭合 fence 只追加 suffix)与 `create-auto-scroll`(算法照抄、用 React `useRef`+原生 ResizeObserver 重写)。

**不能直接照搬**:OpenCode 的 solid-virtual reconcile 补丁(React-virtual 本就按 key diff)、Solid `mapArray`/`createMemo` 细粒度记忆(React 用 `useMemo` 链 + 按 message 拆组件 + `React.memo` 近似)、Craft 的 Jotai atomFamily 分片(CodePilot 若用别的状态库需自实现每会话独立订阅——这是不虚拟化方案的前提,虚拟化后重要性下降)。

**落地建议**:虚拟化 + Worker 高亮属 Tier 2,合并进一份虚拟滚动执行计划;初始滚动 + 流式节流可先单独止血。执行计划里可直接引用本文件的 OpenCode 证据作为实现参考。
