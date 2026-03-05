# 需求规范 (Product Specification)

> **功能名称：** 文件树拖拽生成 ContextMention（文件 + 目录）
> **版本：** v1.1
> **状态：** 审查中
> **作者：** AI Architect + Human Engineer
> **最后更新：** 2026-03-05

---

## 1. 概述

补齐 FileTree → MessageInput 的拖拽体验：拖拽文件时创建附件并生成文件 ContextMention，
拖拽目录时生成目录 ContextMention。附件拉取失败时插入 `@path` 文本作为回退，并在发送时对
ContextMention 前缀进行去重，避免重复路径。

---

## 2. 用户故事与验收标准

### US-001: 文件拖拽同时生成附件与 ContextMention

**作为** 聊天用户，**我希望** 将文件从 FileTree 拖到 MessageInput 时同时获得附件与 ContextMention，
**以便** 发送时既包含文件内容，又显式标注上下文路径。

#### 验收标准

- **AC-001.1:**
  - **GIVEN** 用户从 FileTree 拖拽文件节点
  - **WHEN** 在 MessageInput 区域松开
  - **THEN** PromptInput 附件列表新增该文件
  - **AND** 同时生成文件类型的 ContextMention chip（显示文件名、可移除）

- **AC-001.2:**
  - **GIVEN** 文件拖拽触发附件拉取失败
  - **WHEN** 失败回调触发
  - **THEN** 在输入框插入 `@path` 文本作为回退

### US-002: 目录拖拽生成 ContextMention

**作为** 聊天用户，**我希望** 拖拽目录时生成目录 ContextMention，
**以便** 发送时能显式标注目录上下文。

#### 验收标准

- **AC-002.1:**
  - **GIVEN** 用户从 FileTree 拖拽目录节点
  - **WHEN** 在 MessageInput 区域松开
  - **THEN** 生成目录类型的 ContextMention chip
  - **AND** 不创建附件

### US-003: 发送内容的 ContextMention 去重

**作为** 聊天用户，**我希望** 当输入框已包含相同 `@path` 文本时，
**以便** 发送内容里不会重复拼接 ContextMention 前缀。

#### 验收标准

- **AC-003.1:**
  - **GIVEN** ContextMention 列表包含某个 `path`
  - **WHEN** 输入内容已包含 `@{path}`
  - **THEN** 发送前不再重复追加该 `path` 的前缀

---

## 3. 非功能性需求

| ID | 类别 | 描述 | 目标指标 |
|:---|:---|:---|:---|
| NFR-001 | 质量 | 不引入 TypeScript/ESLint 错误 | `npm run test` 通过 |
| NFR-002 | 可用性 | 拖拽交互无浏览器默认文本插入 | 交互无异常 |
| NFR-003 | 体验 | UI 改动需用 CDP 验证、console 无报错 | 手动验证通过 |
| NFR-004 | 兼容性 | 不新增依赖，保持既有事件与 API | 无新依赖 |

---

## 4. 约束与假设

### 约束
- 仅处理 FileTree 内部拖拽，不支持 OS 文件拖拽到 MessageInput 的额外规则。
- 不修改数据库或 API Schema。

### 假设
- FileTree 拖拽 payload 包含 `path` 与 `name`。
- MessageInput 使用 ContextMention 在发送时前置 `@path`。

---

## 5. 超出范围 (Out of Scope)

以下内容**明确不在**本次迭代的范围内：
- 批量拖拽多个文件或目录。
- 调整 ContextMention 的视觉设计方案。
- 变更文件预览或文件树搜索逻辑。

---

## 6. 审批记录

| 日期 | 审批人 | 决定 | 备注 |
|:---|:---|:---|:---|
| 2026-03-05 | 待定 | 待修改 | 规范需更新以反映缺失的拖拽链路 |
