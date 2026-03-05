# 任务清单 (Task Breakdown)

> **功能名称：** 文件树拖拽生成 ContextMention（文件 + 目录）
> **关联规范：** `docs/specs/product.md` · `docs/specs/architecture.md`
> **最后更新：** 2026-03-05
> **进度：** 8 / 8 已完成

---

## 执行规则

1. **严格顺序执行：** 从上到下，一次只处理一个 `- [ ]` 复选框
2. **单任务约束：** 每个复选框完成后必须经过验证，才可标记为 `- [x]`
3. **禁止跳跃：** 不得跳过任何任务，除非人类明确指示 "跳过"（标记为 `- [~]`）
4. **退回机制：** 如发现需要修改架构设计，必须暂停并退回到 `architecture.md` 修改

---

## 阶段 1：基础设施 (Foundation)

- [x] **T-001:** 在 FileTree 节点加入拖拽 payload（文件 + 目录）
  - 📁 涉及文件：`src/components/ai-elements/file-tree.tsx`
  - ✅ 验证标准：拖拽文件/目录时 DataTransfer 带有自定义 MIME payload
  - ⏱️ 预估工程量：0.5-1 小时
  - 🔗 依赖：无

- [x] **T-002:** 在 MessageInput 添加 ContextMention 状态与 chip 渲染
  - 📁 涉及文件：`src/components/chat/MessageInput.tsx`
  - ✅ 验证标准：可添加/移除文件与目录 chip，样式可见
  - ⏱️ 预估工程量：1 小时
  - 🔗 依赖：T-001

---

## 阶段 2：核心逻辑 (Core Logic)

- [x] **T-003:** 实现 FileTreeAttachmentBridge（监听 `attach-file-to-chat` 并添加附件）
  - 📁 涉及文件：`src/components/chat/MessageInput.tsx`
  - ✅ 验证标准：触发事件后附件 capsule 出现；失败时插入 `@path`
  - ⏱️ 预估工程量：1 小时
  - 🔗 依赖：T-002

- [x] **T-004:** 在 MessageInput 实现拖拽 drop 处理（文件 -> 附件 + chip；目录 -> chip）
  - 📁 涉及文件：`src/components/chat/MessageInput.tsx`
  - ✅ 验证标准：拖拽文件/目录符合 US-001/US-002
  - ⏱️ 预估工程量：1 小时
  - 🔗 依赖：T-003

- [x] **T-005:** 发送前去重 ContextMention 前缀与输入中的 `@path`
  - 📁 涉及文件：`src/components/chat/MessageInput.tsx`
  - ✅ 验证标准：当输入包含 `@path` 时发送内容只出现一次该路径
  - ⏱️ 预估工程量：0.5 小时
  - 🔗 依赖：T-004

---

## 阶段 3：接口层 (Interface Layer)

- [x] **T-006:** 使用 CDP 验证拖拽交互与 console 无报错
  - 📁 涉及文件：`src/components/chat/MessageInput.tsx`
  - ✅ 验证标准：拖拽文件/目录行为符合 US-001~US-003
  - ⏱️ 预估工程量：0.5-1 小时
  - 🔗 依赖：T-005

---

## 阶段 4：测试与集成 (Testing & Integration)

- [x] **T-007:** 运行 `npm run test`
  - 📁 涉及文件：`package.json`
  - ✅ 验证标准：命令零退出码
  - ⏱️ 预估工程量：0.2 小时
  - 🔗 依赖：T-006

- [x] **T-008:** 创建分支、提交修改并使用 `gh pr create` 提交 PR
  - 📁 涉及文件：`.git/`
  - ✅ 验证标准：PR 指向原作者仓库 `main` 且包含本次变更
  - ⏱️ 预估工程量：0.2 小时
  - 🔗 依赖：T-007

---

## 风险标记

> 以下任务涉及高风险系统变更，必须请求人类深度审查。

| 任务 ID | 风险类别 | 风险描述 |
|:---|:---|:---|
| — | — | 无高风险变更 |

---

## 完成日志

| 任务 ID | 完成时间 | Commit Hash | 备注 |
|:---|:---|:---|:---|
| — | — | — | 暂无完成任务 |
