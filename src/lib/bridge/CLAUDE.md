# Bridge 模块

多 IM 远程桥接系统，通过 Telegram（后续可扩展）远程操控 CodePilot 中的 Claude 会话。

## 关键约定

- `bridge-manager.ts` 中 `runAdapterLoop()` 必须在 `state.running = true` 之后调用（async IIFE 的 while 条件在首个 await 前同步求值）
- `telegram-bot.ts`（通知模式）与 bridge adapter 互斥，通过 `globalThis` 上的 `bridgeModeActive` 标志协调，防止 HMR 重置
- Offset 安全水位：`fetchOffset`（API 调用）与 `committedOffset`（持久化）分离，仅 handleMessage 完成后才推进 committed
- 新增 adapter 只需实现 `BaseChannelAdapter` + 调用 `registerAdapterFactory()` 自注册 + `adapters/index.ts` 加 import

## 详细架构

见 `docs/handover/bridge-system.md`
