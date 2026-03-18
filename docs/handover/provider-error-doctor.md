# Provider/Auth/Error 全链路修复 + Doctor 诊断中心

> 完成时间：2026-03-16 | 涉及 ~20 个文件 | P0 直接修复 + P1 诊断中心

## 概述

修复 API key 配置后发送消息报 `Claude Code process exited with code 1` 的全链路问题。根因不是单一 bug，而是 6 类问题被折叠成同一个泛化错误。同时新增 Provider Doctor 诊断中心，提供一键检测和修复。

## 架构

### 错误分类（P0-A4）

```
CLI 进程 crash/exit
  ↓
claude-client.ts catch 块
  ↓
classifyError(ctx) — 模式匹配 16 种类别
  ↓
结构化 JSON SSE error event
  { category, userMessage, actionHint, retryable }
  ↓
useSSEStream.ts / page.tsx 解析
  ↓
展示分类错误 + 修复建议 + 诊断引导
```

**错误类别枚举（`src/lib/error-classifier.ts`）：**

| 类别 | 触发模式 | 可重试 |
|------|---------|--------|
| CLI_NOT_FOUND | ENOENT, spawn | 否 |
| NO_CREDENTIALS | missing api key | 否 |
| AUTH_REJECTED | 401, invalid_api_key | 否 |
| AUTH_FORBIDDEN | 403, Forbidden | 否 |
| AUTH_STYLE_MISMATCH | x-api-key, bearer token | 否 |
| RATE_LIMITED | 429, rate limit | 是 |
| NETWORK_UNREACHABLE | ECONNREFUSED, fetch failed | 是 |
| ENDPOINT_NOT_FOUND | 404 | 否 |
| MODEL_NOT_AVAILABLE | model_not_found | 否 |
| CONTEXT_TOO_LONG | context_length | 否 |
| UNSUPPORTED_FEATURE | unknown option | 否 |
| CLI_VERSION_TOO_OLD | version, upgrade | 否 |
| MISSING_GIT_BASH | git bash (Windows) | 否 |
| RESUME_FAILED | resume failed | 否 |
| PROCESS_CRASH | exit code N | 否 |
| UNKNOWN | 兜底 | 否 |

### Provider 生效修复（P0-A1）

```
chat/page.tsx 初始化
  ↓
useState(() => localStorage.getItem('codepilot:last-provider-id'))
  ↓ (不再硬编码 'sonnet' / '')
provider-changed 事件 → 同步 localStorage
  ↓
onProviderModelChange → 写入 localStorage
```

**新增 provider 自动设默认流程：**
- 首个 provider → 自动设为默认
- 已有 provider → `confirm()` 询问是否切换
- 写入 DB (`set-default` API) + localStorage

### Auth Style 自动分流（P0-A2）

- 非 thirdparty preset：从 `extra_env` 自动检测 auth style，不显示选择器
- thirdparty preset：根据 base_url 模糊匹配 VENDOR_PRESETS hostname 智能推荐
- 显示只读 badge（`Authorization: Bearer ...` 或 `X-Api-Key: ...`）

### Model Upstream 映射（P0-A3）

`provider-resolver.ts` `buildResolution()` 中：当 `opts.model`（如 `sonnet`）通过 catalog 查到不同的 `upstreamModelId` 时，更新 `roleModels.default` 为 upstream ID，确保 `toClaudeCodeEnv()` 设置正确的 `ANTHROPIC_MODEL`。

### Resume 静默回退（P0-A6）

resume fallback 的 status event 标记为 `_internal: true`。`useSSEStream.ts` 过滤掉 `_internal` 事件。用户无感知。

### Doctor 诊断中心（P1）

```
设置 → 服务商 → 运行诊断
  ↓
GET /api/doctor → runDiagnosis()
  ↓
5 个探针并行执行
  ├── CLI: findClaudeBinary + version + 多安装冲突 + Git Bash
  ├── Auth: env/DB/provider 凭据 + resolved provider + 双 key 冲突
  ├── Provider: 数量 + 默认 + 解析路径
  ├── Features: thinking/context1m 兼容性 + stale sdk_session_id
  └── Network: HEAD 请求所有 provider base_url (5s 超时)
  ↓
附加修复动作到 findings (attachRepairsToFindings)
  ↓
前端渲染诊断结果 + 修复按钮 + GitHub Issue 引导
```

**修复动作（POST /api/doctor/repair）：**

| 动作 | 触发条件 | 效果 |
|------|---------|------|
| set-default-provider | provider.no-default | 设置第一个 provider 为默认 |
| apply-provider-to-session | auth.resolved-no-creds | 将默认 provider 赋给无 provider 的 session |
| clear-stale-resume | features.stale-session-id | 清理所有 stale sdk_session_id |
| switch-auth-style | auth.style-mismatch | 在 provider extra_env 中切换 API_KEY ↔ AUTH_TOKEN |
| reimport-env-config | auth.no-credentials | 从 env 导入 AUTH_TOKEN + BASE_URL 到 DB |

**脱敏规则（导出日志）：**
- API key/token → `{ exists: true, last4: "xxxx" }`
- URL → 仅 hostname（已知 vendor 保留完整）
- 文件路径 → `~` 替换 homedir
- runtime-log 消息在写入时即 scrub（正则替换 key/token/path）

### Runtime Log（P1）

`src/lib/runtime-log.ts` — 200 条环形缓冲区。通过 `src/instrumentation.ts` 的 Next.js instrumentation hook 在服务端启动时自动调用 `initRuntimeLog()`。拦截 `console.error` / `console.warn`，写入前做 `scrubMessage()` 脱敏。

### CI 构建修复

- Linux arm64 使用原生 `ubuntu-24.04-arm` runner，不做交叉编译
- 三平台均生成 SHA-256 checksum，合并为 `SHA256SUMS.txt` 上传到 Release
- Linux 产物校验 AppImage（ELF arch）、deb（dpkg-deb）、rpm（rpm -qp）架构

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/lib/error-classifier.ts` | 16 类错误模式匹配 + 结构化输出 |
| `src/lib/provider-doctor.ts` | 5 探针诊断引擎 + 修复动作 |
| `src/lib/runtime-log.ts` | console 环形缓冲 + 脱敏 |
| `src/instrumentation.ts` | 服务端启动 hook（initRuntimeLog） |
| `src/app/api/doctor/route.ts` | 诊断 API |
| `src/app/api/doctor/repair/route.ts` | 修复 API（5 种动作） |
| `src/app/api/doctor/export/route.ts` | 脱敏日志导出 |
| `src/app/api/providers/set-default/route.ts` | 设置默认 provider |
| `src/components/settings/ProviderDoctorDialog.tsx` | 诊断 UI |
| `src/components/settings/ProviderManager.tsx` | 诊断入口（设置项样式） |

## 设计决策

1. **错误分类放在服务端** — classifier 在 `claude-client.ts` catch 块中调用，SSE 发送结构化 JSON，前端向后兼容纯文本
2. **修复动作挂在 finding 上** — 不是顶层 repairs 数组，而是每个 finding 的 `repairActions[]`，前端可以直接渲染
3. **stale resume 批量清理** — 不从截断的 detail 文本提取 session ID，使用无参模式 `UPDATE ... WHERE sdk_session_id != ''`
4. **switch-auth-style 只处理 provider 级冲突** — env 变量冲突（both-styles-set）不提供修复按钮，只给手动建议
5. **reimport-env-config 不混用 key 类型** — 只导入 AUTH_TOKEN 和 BASE_URL 到对应 DB setting，API_KEY 由 resolver 直接从 process.env 读取
6. **arm64 不做交叉编译** — 使用 GitHub 原生 arm64 runner，避免 Ubuntu 版本变更导致 sources.list 路径不一致
