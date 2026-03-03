# 上下文共享与存储迁移设计（CodePilot）

更新时间：2026-02-26

## 1. 目标与范围

本设计用于解决当前项目在会话上下文共享与持久化上的核心问题：

- 存储缺少 `project/workspace` 隔离，跨项目上下文容易串扰
- `working_directory`、`sdk_session_id` 缺少一致性约束，恢复行为不稳定
- 运行态强依赖内存 Map，重启后不可恢复
- 长会话 fallback 依赖固定窗口（最近 50 条），无压缩策略

参考实现（本机路径）：

- `/Users/op7418/Documents/code/资料/craft-agents-oss`
- `/Users/op7418/Documents/code/资料/opencode`

## 2. 现状问题摘要

- 会话表 `chat_sessions` 与消息表 `messages` 为单库全局存储，未区分 project。
- `PATCH /api/chat/sessions/[id]` 更新 `working_directory` 时，不会同步清理或重建 SDK 恢复锚点。
- `conversation-registry` / `permission-registry` 为内存态；进程重启会丢失处理中状态。
- fallback 历史上下文取最近 50 条拼接 prompt，长链路任务容易丢关键状态。

## 3. 目标架构

采用“关系型主存储 + 结构化消息 part + 会话压缩摘要 + 可恢复运行态”。

### 3.1 核心原则

- `project` 作为一级隔离边界（至少按 `working_directory` 归属）
- `sdk_cwd` 为会话恢复锚点，默认不可变；仅在“无消息 + 无 sdk_session_id”时允许更新
- 消息内容从“单文本”升级为“message + part（text/tool_use/tool_result/attachment）”
- 运行态状态（处理中、队列、待审批）入库，内存仅做热缓存

### 3.2 目标表结构（建议）

1. `projects`
- `id TEXT PRIMARY KEY`
- `root_path TEXT NOT NULL UNIQUE`
- `name TEXT NOT NULL DEFAULT ''`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

2. `chat_sessions`（新增/调整字段）
- `project_id TEXT NOT NULL`（FK -> `projects.id`）
- `sdk_cwd TEXT NOT NULL DEFAULT ''`
- `is_archived INTEGER NOT NULL DEFAULT 0`
- `parent_session_id TEXT`（支持 fork/sub-session）
- `summary TEXT NOT NULL DEFAULT ''`（最近一次压缩摘要）
- `summary_updated_at TEXT`

3. `messages`（保留主表，内容轻量化）
- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL`
- `role TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `token_usage TEXT`
- `is_summary INTEGER NOT NULL DEFAULT 0`

4. `message_parts`（新增）
- `id TEXT PRIMARY KEY`
- `message_id TEXT NOT NULL`
- `session_id TEXT NOT NULL`
- `part_type TEXT NOT NULL`（`text|tool_use|tool_result|attachment|status`）
- `payload TEXT NOT NULL`（JSON）
- `seq INTEGER NOT NULL`
- `created_at TEXT NOT NULL`

5. `session_runtime_state`（新增）
- `session_id TEXT PRIMARY KEY`
- `is_processing INTEGER NOT NULL DEFAULT 0`
- `processing_generation INTEGER NOT NULL DEFAULT 0`
- `queued_messages TEXT NOT NULL DEFAULT '[]'`
- `pending_permissions TEXT NOT NULL DEFAULT '[]'`
- `updated_at TEXT NOT NULL`

## 4. 关键状态机设计

### 4.1 `working_directory` 与 `sdk_cwd` / `sdk_session_id`

规则：

- 会话创建：`sdk_cwd = working_directory`（若无则使用默认路径）
- 若 `messages.count = 0` 且 `sdk_session_id` 为空：允许同时更新 `working_directory` 与 `sdk_cwd`
- 否则仅更新 `working_directory`，`sdk_cwd` 不变
- 若用户明确“重置上下文”：清空消息 + 清空 `sdk_session_id` + 清零 token usage

### 4.2 恢复与 fallback

- 优先 `sdk_session_id` 恢复
- 恢复失败：清空失效 `sdk_session_id`，转“摘要 + 最近窗口消息”模式
- 最近窗口不再固定 50，改为按 token 预算动态截断（例如保留最近 N token）

## 5. 分阶段迁移计划

### Phase 0（低风险，1~2 天）

- 新增 `projects`，为历史 session 回填 `project_id`
- 新增 `sdk_cwd`，历史数据用 `working_directory` 回填
- 在更新 `working_directory` 路径时引入 `canUpdateSdkCwd` 逻辑

交付标准：
- 旧会话可正常读取
- 新会话具备稳定 `sdk_cwd`

### Phase 1（中风险，2~4 天）

- 新增 `message_parts`，写入新消息时同步落 part
- 读取接口优先读 part 组装，兼容旧 `content`
- 附件、tool_use、tool_result 改为结构化 payload

交付标准：
- UI 展示不回归
- tool 结果不再依赖文本解析

### Phase 2（中风险，2~3 天）

- 新增 `session_runtime_state`，持久化队列与待审批请求
- 启动时恢复可恢复状态（queued/pending）
- streaming 保存改为“可 flush 队列 + 原子提交”

交付标准：
- 进程重启后能恢复排队消息与审批提示

### Phase 3（中高风险，3~5 天）

- 上线 compaction：自动摘要 + 老旧 tool output 裁剪
- 支持 `archive/fork/parent-child`
- 列表查询支持 active/archived 与 parent 维度

交付标准：
- 长会话上下文质量稳定
- 会话组织能力可用

## 6. SQL 迁移草案（示例）

```sql
-- 1) project
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2) chat_sessions 增量字段
ALTER TABLE chat_sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_sessions ADD COLUMN sdk_cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_sessions ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_sessions ADD COLUMN summary_updated_at TEXT;

-- 3) message_parts
CREATE TABLE IF NOT EXISTS message_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  part_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_parts_message_seq ON message_parts(message_id, seq);
CREATE INDEX IF NOT EXISTS idx_message_parts_session_created ON message_parts(session_id, created_at);

-- 4) runtime_state
CREATE TABLE IF NOT EXISTS session_runtime_state (
  session_id TEXT PRIMARY KEY,
  is_processing INTEGER NOT NULL DEFAULT 0,
  processing_generation INTEGER NOT NULL DEFAULT 0,
  queued_messages TEXT NOT NULL DEFAULT '[]',
  pending_permissions TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
```

## 7. 代码落点建议

- `src/lib/db.ts`
  - 增加 schema version 与分步 migration 函数（幂等）
  - 增加 `project` 相关 CRUD
- `src/app/api/chat/sessions/[id]/route.ts`
  - 更新工作目录时执行 `canUpdateSdkCwd` 判定
- `src/lib/claude-client.ts`
  - fallback 改为“summary + token 预算窗口”
  - SDK 恢复失败后的状态落库更完整（含 runtime_state）
- `src/lib/conversation-registry.ts` / `src/lib/permission-registry.ts`
  - 仅保留热缓存；状态源改为 DB

## 8. 验收与回归清单

- 新建会话、切换目录、发送消息、终止、恢复会话全链路
- 进程重启后：处理中状态、排队消息、权限请求恢复验证
- 历史会话兼容读取（旧 content 字段）
- 大会话（>500 消息）下首 token 延迟与恢复成功率

## 9. 风险与回滚

- 风险：旧消息格式兼容处理不完善导致渲染异常
- 风险：迁移中断导致部分字段未回填
- 回滚策略：
  - 所有迁移前备份 `codepilot.db`
  - 每个 phase 单独开关（feature flag）
  - 先双写（old content + message_parts），稳定后再切读路径
