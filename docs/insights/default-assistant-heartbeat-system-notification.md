# 为什么“默认助理 → 心跳 → 系统通知”必须是一条纵向闭环

## 用户真正遇到的不是三个孤立 bug

“先选目录才能用助理”是启动门槛；“心跳几乎不触发”是后台能力不可信；“通知只在软件里显示”是提醒没有离开当前页面。这三件事连起来，用户感受到的是：助理既不像自己的，也不能主动工作，更无法在 CodePilot 常驻后台时找到自己。

所以这轮没有分别做一个默认值、一个 timer 和一个 toast。产品结果必须是一条可追踪路径：用户拥有文件，用户明确开启检查，系统真实运行，有事才产生消息，操作系统接受提醒，点击后回到正确上下文。

## 默认不等于替用户做决定

默认助理的目标是去掉设置负担，不是猜人格、迁移私有仓库或替用户生成记忆。于是默认目录只在“从未设置”时建立，内容保持中立，heartbeat 默认关闭。老用户即使目录暂时不可用，也继续拥有原选择。

这看起来比“发现坏路径就自动修复”保守，但它保住了产品定位里最重要的一点：Harness 和 Memory 是用户的，不是应用可以为方便而重写的内部状态。

## 心跳可靠性的关键不是再加一个触发器

以前的问题来自多套入口和多种静默判断：页面 mount 可以触发，scheduler 也能触发，文件里的日期又像运行状态。修复方向是减少答案，而不是增加 fallback：

- `HEARTBEAT.md` 只回答“查什么”；
- state file 只回答“用户想不想启用”；
- scheduler/run log 回答“系统有没有运行”；
- delivery 回答“系统通知有没有被 OS 接受”。

这四层分开后，UI 才能诚实区分没到时间、内容为空、无需提醒、运行失败和通知失败。执行前再读 desired state，是费用安全的最后一道门：即使清理 task 失败，也不能偷偷调用模型。

## 系统通知不是换一个 API 就结束

应用常驻后台时，页面 toast 没有提醒价值；但调用 Electron `Notification.show()` 也不等于成功。真正可靠的通知需要 durable queue、单一消费者、生命周期终态、重启恢复和点击路由。

我们把 Main 设为 native 唯一 owner，是为了消灭窗口显示/隐藏时 Renderer 与 Main 抢队列的竞态。“delivered”只写成 OS accepted，是为了不虚构用户已经看见或已读。声音也服从系统勿扰和权限，不用自播放音频绕过用户选择。

## 与 Harness Home 的关系

这条 P0 落实了“用户自己的 Harness 归用户所有”的体验原则，但没有宣称 Assistant Workspace 已经等于 Harness Home。默认目录仍是当前助理产品的数据面；未来若要合并 canonical root，必须走 Harness Home 的 dry-run、copy-only、conflict-aware migration，而不是在这轮顺手改真源。

## 当前诚实边界

代码与自动化可以证明 CAS、单 task、0-call gate、durable claim 和 lifecycle state machine。它们不能证明每个桌面环境都会响铃。signed macOS、installed Windows 和具体 Linux notification daemon 的实测仍必须分别完成；在那之前只能说实现和测试完成，不能说三平台发布就绪。
