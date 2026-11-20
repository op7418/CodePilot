# Packaged 预览包运行时启动诊断（2026-05-31）

> 关联执行计划：`exec-plans/completed/preview-build-readiness.md` Phase 1 packaged P0（Codex app-server / ClaudeCode "准备运行环境"）。
> 状态：**机制已从源码定位；根因待用户那台机器的「屏幕 reason 字符串 + app 日志」确认。** 本文给「症状 → 已确认机制 → 待确认点 → 需要哪几行日志」，确认后再决定改哪。

在「打包新版、已装 Codex 的另一台 Mac」上复现两个问题：

- **问题 A**：软件打开 / 每轮输出结束一段时间后 / 新建对话 → 输入框「正在准备运行环境」+ 模型下拉「模型加载中」，等一会才好。
- **问题 B**：Settings → 执行引擎 → Codex 显示「应用服务启动失败」（机器明明装了 Codex）。
- **问题 C**（2026-06-01 补充）：Settings 概览 / 执行引擎 等页面「加载中」要**几十秒**才出来。

> **2026-06-01 更新：三个症状很可能是同一个根因。** 见下方「统一根因」。
> **2026-06-01 二次更新（POC 实测）：原先「xhigh 配置让 app-server 挂掉」的判断被 POC 证伪——见下方「POC 实测修正」。真因是 *旧 codex 二进制*（已卸载）+ CodePilot 不快速失败，不是配置本身。**

---

## ✅✅ POC 实测修正（2026-06-01）——真因再定位（本节权威，覆盖下方「日志确认」中关于 xhigh 的结论）

下方「日志确认」基于日志推断「`~/.codex/config.toml` 的 `xhigh` 让 app-server 启动失败、需用户改配置或 spawn 时 `-c` 覆盖」。在用户本机做隔离 + 端到端 POC 后，**这个因果链对当前二进制不成立**，修正如下。

**POC 方法**（脚本见提交记录，跑完即删）：
- 隔离：临时 `CODEX_HOME` 写 `model_reasoning_effort = "<值>"`，spawn `codex app-server`，跑完整 `initialize` + `model/list` 握手，看是否报错 / 退出。
- 端到端：用 `findCodexBinary()` 实际会解析到的二进制 + **用户真实的 `~/.codex`**，只读跑 `initialize` + `model/list`。

**[外部事实 · pin codex-cli 0.133.0 / 2026-06-01]**
- 当前机器 `which -a codex` **找不到**；`/opt/homebrew/bin/codex`（日志里用的那个）**已不在磁盘**。仅存 `/Applications/Codex.app/Contents/Resources/codex`，版本 `codex-cli 0.133.0`。
- `.app` 的 codex `0.133.0` **原生接受 `model_reasoning_effort = "xhigh"`**：initialize + model/list 全 OK，无 deserialize 报错、不退出。
- 同一 `0.133.0` 对 `max` / 垃圾值 **只警告、不致命**（stderr 有 "unknown variant" 但进程不退出，降级到 `medium`）。
- 端到端：`findCodexBinary()` → `/Applications/Codex.app/.../codex`；对**真实 `~/.codex`（确含 xhigh）** → `initialize OK` + `model/list` 返回 **6 个真实模型**（gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.3-codex-spark …）。

**[仓库事实]**
- spawn 参数 = `['app-server']`，无 `-c`（`app-server-manager.ts:189`）；日志里的 spawn 参数也是 `['app-server']`——**与 POC 完全一致**。
- `proc.once('exit')` 仅清 `cached`、置 `lastAvailability=spawn_failed`，**不 reject 正在 await 的 `initialize()`**（`app-server-manager.ts:213-223`）→ 子进程退出后，`getCodexAppServer()` 的 initialize 要等满 **30s RPC 超时**（`app-server-client.ts:121`）才失败。
- 日志里失败的二进制全是 `/opt/homebrew/bin/codex`（`spawning { binary: '/opt/homebrew/bin/codex' }`），其报错只列 `minimal/low/medium/high`（无 xhigh、无 max），且 `error loading config` 后 **`exited code=1`**。

**[推断 → 修正后的真因]**
- 日志里那个会被 xhigh 搞挂的 codex 是**旧 / 更严的 `/opt/homebrew/bin/codex`**（只认 4 档 + 把配置反序列化失败当致命退出）。它**现已卸载**。
- 用户当前机器只剩 `.app 0.133.0`，**它接受 xhigh** → CodePilot 现在解析到它 → **Codex 现在就是通的**（端到端实测 6 个模型为证）。
- 三个症状变慢的真正放大器是 **CodePilot 不快速失败**：任何 codex 在 init 期退出，都会让取模型列表等满 30s——这与"为什么退出"无关，是 CodePilot 自身的韧性缺陷。

### 修正后的结论与对策

| 项 | 修正后 |
|----|--------|
| **用户立即动作** | **重启 / 重试 CodePilot 即可**，Codex 大概率已恢复（实测当前二进制 + 真实配置可出 6 个模型）。**不需要改 `~/.codex/config.toml`**——之前让你改 xhigh→high 是基于"旧 homebrew 二进制"的错误假设，当前 `.app 0.133.0` 不需要。 |
| **P0（真缺陷，值得修）** | app-server 子进程在 init 期退出时**立即 reject 等待中的 `initialize()`**（`proc.once('exit')` 里 reject pending），而不是干等 30s。这是让三个症状都"卡几十秒"的真正原因，**与 codex 为何退出无关**，永远正确。 |
| **P1（防御，针对旧/严二进制）** | 把 CodePilot **发给** Codex 的 effort（`turn/start` 的 `options.effort`，`runtime.ts:862`）clamp 到 Codex 支持集，绝不外发 `xhigh`/`max`。先核实发送路径是否真会把 Opus 档位带给 Codex 模型再决定力度。 |
| **不做：spawn 时 `-c model_reasoning_effort=high`** | 否决。当前 `0.133` 接受 xhigh → 这是 no-op；且它会**强行覆盖用户自己的 Codex 配置默认**；又无法验证它能救回旧二进制（旧二进制已卸载，且日志错误正是 "**overridden** config" 失败）。用 P0 快速失败替代"猜着纠正用户配置"。 |
| **问题 A/C（准备运行环境 / 几十秒）** | P0 修好后自然好（30s→瞬时失败降级）；可再给 `/api/providers/models` 的 Codex 分支加一道短超时做双保险。 |

### ✅ 实现状态（2026-06-01，已提交）

- **P0 已实现（transport/client 层，比只在 manager race initialize 更干净）**：
  - `app-server-client.ts`：`CodexTransport` 增加可选 `onClose`；client 在 `attach()` 订阅，进程死时 `handleClose()` **立即 reject 所有 pending** 并置 `closed`；`requestOnce` 在 `closed` 时直接 reject，不再发往死管道。
  - `app-server-manager.ts`：`makeStdioTransport` 在 `proc` `exit`/`error` 时 `fireClose()`；对**已关闭后才订阅**的 client 同步回放（消除"进程先退、client 后 attach"竞态）。
  - 回归测试 `codex-app-server-client.test.ts`「transport close (P0)」：核心用例用**真实 30s 超时**配置，断言 close 后 reject 耗时 `< 1000ms`（回归即慢且失败）；另覆盖"全部 in-flight 一起 reject""close 后新请求快速失败不写管道""exit-before-attach 竞态"。
- **P1 已实现（仅 codex_runtime）**：
  - 新增 `src/lib/codex/effort.ts` 的 `clampCodexEffort`：`xhigh`/`max`→`high`，`minimal/low/medium/high` 原样，未知→省略；`runtime.ts` 的 `turn/start` 改用 clamp 后的值。**不碰** Claude Code / Native 的 Opus effort（它们不 import 此函数）。
  - 回归测试 `codex-effort-clamp.test.ts`：覆盖 `xhigh→high` / `max→high` / 四档原样 / 空与未知省略。
- **验证**：`npm run test` typecheck 干净 + **3103 单测全过**（含上述新增）。
- **未做**：spawn `-c` 覆盖（已否决，理由见表）；`/api/providers/models` Codex 分支的额外短超时（P0 已把 30s→瞬时，此项作为可选双保险留待按需）。

> 下方「日志确认」与「下一步」中凡是「xhigh 来自配置 → 改配置 / `-c` 覆盖」的表述，**以本节为准**。日志推断的方向（30s 超时是统一放大器、ABI、sonnet）依然成立，只有 xhigh 的因果被本节修正。

---

## ⭐ 统一根因：Codex app-server 卡到 30s 请求超时（2026-06-01）

把三个症状串起来的链路：

1. **取模型列表 = `GET /api/providers/models`**：当 `runtime=auto` 或不带 runtime（null）时，路由 `if (!runtimeFilter || runtimeFilter === 'codex_runtime')` → `buildCodexProviderModelGroup()` → `getCodexAppServer()`（spawn + `initialize`）→ `listCodexModels()`（`client.request`）。
2. **app-server client 的请求超时 = `30_000` ms（30 秒）**（`app-server-client.ts:121`），`initialize` 与 `listModels` 各走一次。
3. **凡是"取模型列表"的 UI 都吃这条链路**：
   - 聊天输入框 `useProviderModels` → **问题 A**（"正在准备运行环境"）。
   - Settings 概览 `useOverviewData`（`fetch /api/providers/models?runtime=auto` + 无 runtime 各一次，`useOverviewData.ts:105-106`）→ **问题 C**。
   - Settings 执行引擎 `RuntimePanel`（`fetch /api/providers/models?runtime=auto`，`RuntimePanel.tsx:550`；`setLoading(false)` 要等**所有**并行 fetch 完成）→ **问题 C**。
   - `getCodexAppServer` 的 `initialize` 卡到 30s 失败 → **问题 B**（"应用服务启动失败"）。

**结论：只要 Codex app-server 的 RPC 不响应，这三处都会卡到 30s 超时。**「几十秒」正好是这个 30s 请求超时。

**关键分诊**：旧问题 `--listen` / 旧版本无 `app-server` 子命令时，子进程会**立刻退出、快速失败**，Settings **不会**卡几十秒。**你 Settings 卡几十秒 = app-server spawn 起来了、但 `initialize` 握手 hang 到 30s 超时** → 据此**改判：更可能是协议 / 版本不匹配（或 app-server 起来后不响应），而非过时构建**。`reason` 字符串可最终确认（见问题 B）。

> 注：`/api/codex/status`（执行引擎页顶部的 Codex 状态条）走 `getCodexAvailability()`，**不 spawn**、读缓存的 `lastAvailability`，所以它本身快——慢的是同页并行的 `/api/providers/models`。

---

## ✅ 日志确认（2026-06-01，`codepilot-main_副本 2.log`）——真因落定

日志跨**4 个版本**（`0.53.0 → 0.55.0-preview.1 → preview.2 → preview.3`，用户一天内迭代了多个本地包），不同版本症状不同，**必须只看最新 preview.3（15:04 起）**：

1. **`--listen` 是旧 `0.53.0` 包的问题，preview.3 已修**：07:12 的 `0.53.0` 段反复 `unexpected argument '--listen' found` + `exited code=2`；但 preview.3（15:04+）spawn 参数已是 **`['app-server']`（无 --listen）** → `6923f13` 的 stdio 修复在 preview.3 里生效。**这条已解决。**

2. **【preview.3 的 Codex 启动失败】`model_reasoning_effort = xhigh`** ⚠️ **因果已被上方「POC 实测修正」更正：失败的是旧 `/opt/homebrew/bin/codex`（已卸载），当前 `.app 0.133.0` 接受 xhigh。下方保留作推断留痕。**
   ```
   [codex.app-server] Failed to deserialize overridden config: unknown variant `xhigh`,
   expected one of `minimal`, `low`, `medium`, `high`  in `model_reasoning_effort`
   [codex.app-server] exited { code: 1 }
   ```
   - **当时推断（已被 POC 证伪）**：以为 Codex 0.133 不认 `xhigh`。**修正**：`.app 0.133.0` 实测**接受** xhigh；报这个错的是 `spawning { binary: '/opt/homebrew/bin/codex' }`——更旧/更严的 codex（报错只列 4 档），把配置反序列化失败当**致命退出**。
   - **来源（仍对）**：spawn 参数只有 `['app-server']`、无 `-c`，CodePilot 不写 codex `config.toml`、不传 `-c`→ `xhigh` 来自**用户自己的 `~/.codex/config.toml`**。但**它只对旧二进制致命**。
   - **每 ~30s 重试（机制仍对，是真正该修的）**：旧二进制读配置失败退出 → CodePilot **不快速失败** → initialize 等满 **30s 超时** → 问题 A/C。该修的是 30s 那段（P0），不是配置。

3. **【preview.1 的 ABI 不匹配】**：08:02 的 preview.1 段 `[ABI check] ABI mismatch detected: better_sqlite3.node ... NODE_MODULE_VERSION 127 ... requires 143` → 那个本地包的 better-sqlite3 没重编到 Electron ABI（用了 Node ABI）。**`preview-build.yml` 的 native ABI 校验步骤正是挡这个的**；preview.3 段未见此报错（重点是 Codex）。

4. **【ClaudeCode sonnet】**：preview.3 仍 `Claude Code compat API error: 503 ... model_not_found ... 分组 auto 下模型 sonnet 无可用渠道（distributor）`（`new_api_error`）——这是**用户的 new-api 网关**报「auto 分组里没有 `sonnet` 这个渠道」，且发出去的还是裸 `sonnet`。属 provider 侧配置（网关要有对应渠道）+ 该 provider 的别名规范化未覆盖；**与 Codex/打包无关，单独处理**。

### 据日志确定的修复方向

| 问题 | 真因 | 修复 |
|------|------|------|
| Codex 启动失败 ⚠️**已被 POC 修正，以「POC 实测修正」节为准** | ~~xhigh 让 0.133 挂~~ → 实际是**旧 `/opt/homebrew/bin/codex`（已卸载）** 致命、当前 `.app 0.133.0` 接受 xhigh | **立即**：重启 CodePilot 即可（实测当前二进制可出 6 模型，**不用改 config**）。**治本 P0**：app-server init 期退出时立即 reject pending init（不等 30s）。**防御 P1**：clamp CodePilot **发给** Codex 的 effort。~~`-c` 覆盖~~ 已否决（no-op + 覆盖用户配置 + 不可验证） |
| 问题 A/C（准备运行环境 / 加载几十秒） | 取模型列表卡在上面失败的 app-server 的 30s 超时 | Codex 修好后自然好；**另建议**：给 `/api/providers/models` 的 Codex 分支设短超时 / 失败快速降级，避免 Codex 一坏就拖 30s |
| preview.1 ABI 127≠143 | 本地包 better-sqlite3 没重编 Electron ABI | 走 `preview-build.yml`（含 ABI 校验）出包，别用本地手打包 |
| sonnet 无可用渠道 | new-api 网关 auto 分组无 sonnet 渠道 + 发裸 sonnet | provider 侧配渠道；查该 provider 类型的别名规范化为何没把 sonnet→`claude-sonnet-4-6` |

---

## 背景：打包态 PATH 与二进制发现（三个问题共用）

- 从访达 / Dock 启动的打包 Electron **不继承 shell 的完整 PATH**（不读 `~/.zshrc`），裸 PATH 只有 `/usr/bin:/bin:...`。
- app 的补救：启动时跑一个 login shell 读 `userShellEnv` + `getExpandedShellPath()`，并注入 Next server 子进程——`electron/main.ts:839` 的 `startServer` env = `{ ...userShellEnv, ...sanitizedProcessEnv(), ...userShellEnv, PATH: constructedPath, HOME, CLAUDE_GUI_DATA_DIR, ... }`。**所以 Next server 进程的 `process.env.PATH` 已经是扩展后的 PATH，且有 `HOME`。**
- `findCodexBinary()`（`app-server-manager.ts:118`）查找顺序：`CODEX_DISABLED` → `CODEX_BIN` → **walk `process.env.PATH`**（=扩展 PATH）→ **macOS bundle fallback** `/Applications/Codex.app/Contents/Resources/codex`。
- Codex app-server 子进程由 `spawn(binary, ['app-server'], { env: { ...process.env, RUST_LOG } })` 启动（`app-server-manager.ts:192`）——继承 Next server 的好 env（扩展 PATH + HOME）。**所以「env 缺失」基本可排除。**

---

## 问题 A：「正在准备运行环境 / 模型加载中」延迟与重现

### 已确认机制（源码追踪）

1. **两个提示是同一件事**：`GET /api/providers/models` 这个请求在途。
   - 输入框占位符 `messageInput.placeholderLoading`（"Preparing runtime..."）的条件是 `isProviderLoading = fetchState === 'idle'`（`MessageInput.tsx:302`）；模型下拉的 `composer.modelLoading`（`ModelSelectorDropdown.tsx:187`）同源。
   - `useProviderModels` 的 `fetchAll()` **第一行就把 `fetchState` 置回 `idle`**，所以**每次该请求被触发，输入框立刻回到"准备运行环境"，直到请求返回 `loaded`**。不是真的在重启引擎。
2. **每次进会话页至少取两次**：`useGlobalAgentRuntime` 默认 `agentRuntime='claude-code-sdk'`，再异步 `fetch('/api/settings/app')` 解析真实 runtime；解析出与默认不同（如 Codex/Native）时 `sessionRuntimeParam` 变 → `useProviderModels(_, _, runtime)` 依赖 `[runtime]` 变 → **`fetchAll` 重跑** → 又闪一次"准备"。新建对话 = 新挂载 = 重来。
3. **慢源（runtime=Codex/auto 时）**：路由 `if (!runtimeFilter || runtimeFilter === 'codex_runtime')` → `buildCodexProviderModelGroup()` → `getCodexAppServer()` **冷启 spawn `codex app-server` + initialize 握手 + listModels RPC**（`models.ts:37`）。首次很慢；之后 `cached` 复用变快；只有 app-quit 主动 dispose，**但 `proc.once('exit')` 会在子进程退出时清 `cached`**（`app-server-manager.ts:215`）→ 下次取模型列表又冷启。

### 待确认（需日志）

- **"输出结束一段时间后又变准备中"** 的触发点：是 (a) Codex/SDK 子进程在一轮后退出 → 清缓存 → 下次冷启，还是 (b) 某状态变化让 `sessionRuntimeParam` 重算 → 重取？源码层两条都可能，要看日志里子进程是否"每轮后 exited 又 spawning"。

### 需要的日志 / 信息

- `[codex.app-server] spawning` 与 `[codex.app-server] exited` 的时间戳——看是否**每轮输出后退出又重 spawn**、`initialize` 等了多久。
- `/api/providers/models` 的请求耗时（开发者工具 Network 或服务端日志）。
- 当前用的 Runtime（Settings → 执行引擎）——决定是否命中 Codex 慢路径。

---

## 问题 B：Codex「应用服务启动失败」（已装 Codex）

### 已确认机制

- 「应用服务启动失败」= `CodexAvailability` 的 **`kind: 'spawn_failed'`**（`RuntimePanel.tsx:1305`），UI 同时显示 **`Codex 应用服务启动失败：{reason}`**（`RuntimePanel.tsx:1052`）。
- 「启动失败」**不等于「未安装」**：能到 spawn_failed 说明 `findCodexBinary` **已经找到了二进制**（否则是 `not_installed` / 未安装）。问题在找到之后的 **spawn / 子进程退出 / initialize**。
- `spawn_failed` 有**三个产生点**（`app-server-manager.ts`），各带不同 `reason`：

| # | 位置 | reason 形态 | 含义 |
|---|------|------------|------|
| 1 | :201 `spawn` 抛 | `spawn ENOENT` / `EACCES` / `EINVAL` | 找到的路径不对 / 不可执行 / env 异常 |
| 2 | :220 子进程启动后 `exit` | `exited with code=X signal=Y` | 二进制跑起来又立刻退出——**旧版本没有 `app-server` 子命令** / **仍带 `--listen` 的过时构建**（参数被拒）/ 启动期 panic |
| 3 | :237 `initialize()` 抛 | `Codex app-server initialize failed: …` | app-server 起来了但 **JSON-RPC initialize 握手失败**（协议 / 版本不匹配 / 超时） |

- spawn env 充分（见背景：Next server 已带扩展 PATH + HOME，spawn 继承）→ **排除 env 缺失**。

### 三种 reason → 三种根因 → 对策

| reason 你会看到 | 根因 | 对策 |
|----------------|------|------|
| `spawn ENOENT` / 路径相关 | 命中的 codex 路径不对（如 bundle fallback 指向了不可用的二进制，或 `CODEX_BIN` 设错） | 在那台机器终端 `command -v codex` + `codex --version`；核对 app 实际用的路径（日志 `[codex.app-server] spawning { binary }`）|
| `exited with code=…`，**日志/stderr 含 `unexpected argument '--listen'`** | **这个"新版"其实没含 `6923f13`**（又是过时构建——和上次坏包同病）| 用 `preview-build.yml` 重新构建（它的 **gate A 会挡 `<6923f13` 的 commit**）；核对打包用的 commit ≥ `6923f13` |
| `exited with code=…`，**无 `--listen`** | 安装的 Codex **太旧 / 没有 `app-server` 子命令**，或启动期 panic | `codex --version`；确认该版本支持 `codex app-server`（stdio）|
| `initialize failed: …` | **协议 / 版本不匹配**：客户端 `CodexAppServerClient.initialize()` 发的 clientInfo / 协议版本与该 Codex 的 app-server 不兼容 | 看 init 报错细节；可能需按该 Codex 版本适配 initialize 协议 |

### 分诊关键：`reason` 字符串就在屏幕和日志里

- **屏幕**：Settings → 执行引擎 → Codex 那条「Codex 应用服务启动失败：**<这里就是 reason>**」。
- **日志** grep：`Codex app-server spawn failed` / `Codex app-server initialize failed` / `[codex.app-server] exited` / `unexpected argument`。

**一句 reason 基本就能定到上面四行之一。**

### 与 preview-build 的关系（重要）

- 如果 reason 指向 **`--listen` / proc exit**，说明你这个"新版"**仍是过时构建**（没含 `6923f13`）——这正是上次坏包的同一类问题。**走 `preview-build.yml`（workflow_dispatch）重新构建**：它的 `verify-source` gate A（`git merge-base --is-ancestor 6923f13 HEAD` + `grep --listen`）会**拒绝构建早于修复的 commit**，从源头杜绝再出过时包。
- 如果 reason 指向 **initialize / 版本**，那是真·兼容问题，与构建无关，需单独适配。

---

## 下一步（需要你给我）

> ⚠️ **本节大部分已由 2026-06-01 的 POC 回答（见「POC 实测修正」），无需再收集 reason 字符串/版本——真因已实测落定。保留作排查清单模板。** 仍待办的只剩：P0 快速失败 + P1 effort clamp 的代码实现，及 sonnet 网关单独排查。


1. **问题 B 的 reason 字符串**：Settings → 执行引擎 → Codex 那行冒号后面的全部文字（或截图）。**这一项最关键，基本一句定根因。**
2. **那台机器的 app 日志**，grep 这些关键字贴给我：
   - `[codex.app-server]`（spawning / exited / 时间）
   - `Codex app-server`（spawn failed / initialize failed）
   - `unexpected argument`
   - `/api/providers/models`（耗时）
   - `not_installed` / `未安装`
3. **当前 Runtime**：Settings → 执行引擎 截图（是 Codex / ClaudeCode / Native）。
4. **`codex --version`**：在那台机器终端跑一下（确认装的 Codex 版本 + 是否支持 `codex app-server`）。
5. **打包用的 commit**：那个"新版"是从哪个 commit 打的（确认是否 ≥ `6923f13`）。

拿到 1 + 2，问题 B 当场可定根因——而 **B 一旦解决，A 和 C 大概率一起好**（三者都卡在同一个 30s Codex RPC，见「统一根因」）。改代码方向取决于 B 的 reason：
- `initialize failed` / 超时 → **协议/版本不匹配**：按该 Codex 版本适配 initialize（或检测不兼容时快速判 `too_old` / 降级，不等 30s）。
- app-server 根本起不来 → **packaged 下让"取模型列表"不阻塞在 Codex**：Codex 不可用时快速降级（给 `/api/providers/models` 的 Codex 分支单独设短超时、或后台预热 app-server、或缓存上次可用状态），不要让聊天 composer / Settings 页面等满 30s。
- `--listen` / 旧版本 → 过时构建（但前述"卡几十秒"使这条可能性变低）→ 走 `preview-build.yml` 重打。

问题 A 的"输出后重现"额外看日志里 app-server 是否每轮后 `exited` 又 `spawning`（决定是否要在 packaged 下保持 app-server 常驻）。
