# Windows 竞品适配可借鉴矩阵（2026-08-06）

> 对应修复交接：Windows Runtime / 路径兼容性修复交接与复查手册
>
> 本文目标不是罗列竞品功能，而是回答：哪些原则 CodePilot 已经吸收、哪些值得继续立项、哪些实现不能照搬。当前实现基线为 commit `b70c0c10`。

> 2026-08-06 实施回写：本文列出的 P0/P1 已进入 Windows Runtime 诊断、恢复与凭据加固交接：Path Identity、三 Runtime Doctor、Codex sandbox 分层状态、Provider secret envelope encryption，以及复制固定官方命令并打开 PowerShell 的恢复入口。真实 standalone Codex/sandbox child 和跨 OS keyring 仍按交接文档标为待真机复查，不能因代码落地改写为已验证。

## 一、证据范围

本轮只把源码、官方仓库/设计文档和本仓库已有源码调研当作事实证据：

- npm 包 `@larksuiteoapi/feishu-openclaw-plugin@2026.3.7`（解包件已不保留在本仓库）。
- [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss)：Windows PowerShell installer、`.exe` debug 入口、`%APPDATA%` 日志；架构细节同时引用本仓库已固定 commit 的 [竞品 Runtime / 安全调研](./competitor-runtime-security-solutions-2026-07-04.md)。
- [OpenCode](https://github.com/anomalyco/opencode)：Scoop/Chocolatey、Windows Desktop 安装包；Runtime/状态/安全细节引用上述既有源码调研。
- [OpenAI Codex config source](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs)：Windows path comparison、project trust、credential store mode、Windows config；沙盒结构引用 [OpenAI Windows sandbox design](https://openai.com/index/building-codex-windows-sandbox/)。
- CodePilot 当前代码与 Windows DEV/API 实测；没有真实 standalone Codex 的能力继续标为未验证。

旧调研中的本地绝对路径仅是历史定位，不作为跨机唯一证据。未来引用竞品源码必须记录 `repo URL + commit/tag + repo-relative path`。

## 二、结论先行

### 已经吸收，不要重复建设

1. **能力探测优先于文件存在**：Codex candidate 必须通过 `--version`；Store/MSIX 失败时显示 `desktop_only`。
2. **核心文件 I/O 不依赖 shell**：无 `rg` 时 Glob/Grep 走有界 Node fallback；路径通过 `cwd`/argv 传递。
3. **Windows 原生 canonical path**：关键 security boundary 已改 `fs.realpathSync.native`。
4. **平台安装渠道识别**：Claude `.exe/.cmd`、Codex standalone/alias/Desktop bundle 已分开处理。
5. **外链协议白名单和诊断脱敏**：CodePilot 已有 `navigation-policy.ts`、main log sanitizer 和 Doctor export；这部分已经不弱于所对照竞品。

### 最值得继续做

1. **P0：Runtime Doctor 分层诊断**——把当前 Claude/provider-centric Doctor 扩成 Native / Claude / Codex 共用的事实链。
2. **P0：统一 Windows Path Identity Contract**——把散落的 drive/UNC/file URL/case/realpath 处理收敛成一个纯函数契约。
3. **P1：Codex Windows sandbox readiness 可视化**——区分 binary、app-server、sandbox setup、helper/runner、首个 child command，不再用一个 ready 覆盖五层状态。
4. **P1：Provider secret 从明文 SQLite 迁出**——主进程 `safeStorage`/OS keyring 优先，明确降级；不能照搬“密钥与密文同目录”。
5. **P1：安装/修复入口产品化**——复用官方 installer，但必须用户确认、保留日志、刷新 candidate cache，并验证真正可执行。
6. **P2：Windows/WSL/UNC/云盘持续矩阵**——进入 CI + 实机 smoke ledger，而不是每次出问题再补一个路径特判。

## 三、逐项目可借鉴矩阵

| 来源 | 竞品做法 | CodePilot 当前状态 | 建议 | 决策 |
|------|----------|-------------------|------|------|
| 飞书 OpenClaw | Windows token backend 不再通过 PowerShell/DPAPI shell；理由包含冷启动、Execution Policy、`cmd.exe` 长度与容器差异 | Shell/file 工具已减少 shell 依赖；provider key 仍明文存 SQLite | 延续“核心 I/O 用 API，不用 shell”原则；credential 走 Electron main `safeStorage`，不要照搬它的同目录 master key | 原则采纳；实现不照搬 |
| 飞书 OpenClaw | 显式识别 `C:\`、`C:/`、UNC，并在非 Windows host 也能用 `path.win32.basename` 解释 Windows 输入 | 多处已改 native realpath，但 path dialect 判断仍分散 | 建立 `PathIdentity`，输入 dialect 与当前 host 分开；集中测试 drive/UNC/file URL/reparse point | P0 |
| 飞书 OpenClaw | `mediaLocalRoots` 三态语义：未配置、空 allowlist、非空 allowlist；realpath 后做 containment | CodePilot 多条 Asset/HTML/Media 路径已有各自 containment | 借它的显式三态语义，但复用统一 path identity/containment helper，避免各模块继续复制 | P1 |
| Craft Agents | Windows 独立 PowerShell installer、明确 `.exe` debug 命令、固定 `%APPDATA%` log path | CodePilot 有安装引导、日志目录和诊断导出，但 Runtime 设置页没有完整“安装渠道 → binary → log”的 breadcrumb | Runtime 卡片增加安装渠道、resolved binary、probe stage、打开日志/复制诊断入口 | P0/P1 |
| Craft Agents | 会话处理状态由后端单点持有，子进程崩溃转结构化错误并可 lazy respawn | CodePilot Runtime 状态跨 Next route/registry/DB lock/UI snapshot，历史上有 stop/卡死类风险 | 延续既有竞品调研：唯一终态出口、generation/turn ownership、结构化 crash + bounded retry；Windows 上尤其要把 sandbox/helper crash 与模型错误分开 | 独立 Runtime 稳定性计划 |
| Craft Agents | AES-GCM credential file，由 machine identity 派生 key | 比明文 SQLite好，但同机恶意进程仍可重算；CodePilot 当前 provider `api_key` 明文列 | 以 Electron `safeStorage`/DPAPI/Keychain/libsecret 为主；Linux 无 keyring时再设计明确标识的 fallback | P1，需 schema/迁移专项 |
| OpenCode | Windows CLI 支持 Scoop/Chocolatey，Desktop 有独立 x64 installer；安装位置可配置 | Claude/Codex 已有若干 hard-coded candidate 目录和 env override | 把 detector 抽象成 candidate registry：source/channel/path/probe/version/priority；不要把每个 Runtime 的目录继续散落在函数里 | P1 |
| OpenCode | 会话 follow-up 队列按 session ID 分片并持久化；导航先 create/seed，再异步发送 | 与 Windows 路径无直接关系，但能减少重挂载导致的任务丢失 | 继续按既有 Runtime 竞品调研推进；不要塞进 Windows 修复 commit | 跨平台独立计划 |
| OpenAI Codex | project trust 同时考虑原始路径与 canonical path；Windows key 做大小写归一化 | 已用 native realpath，但不同模块的比较 key/显示 path 仍不统一 | 同时保留 display path、native canonical path、comparison key；安全授权只依赖真实 filesystem boundary | P0 |
| OpenAI Codex | Windows sandbox 拆 setup helper、command runner、child process；分别承担 UAC/ACL、受限 token、实际命令 | CodePilot 目前只看到 app-server availability，首个工具执行才暴露 sandbox 失败 | 若 app-server 协议能提供真实状态，则呈现 `not_configured/setup/ready/degraded/error`；无信号时显示 unknown，不能推测绿色 | P1 POC |
| OpenAI Codex | credential store 有 `file/keyring/auto` 模式；日志目录和 debug lockfile 是显式 config | CodePilot secret facade 仍最终读写 SQLite `api_key`；Doctor export 已有脱敏 | Secret backend 也应显式报告 storage kind/security level；诊断导出只显示 kind/last4，不输出密文或 key material | P1 |

## 四、建议的 CodePilot 落地形态

### 4.1 Runtime Doctor：从“Provider 检测”升级为“执行链检测”

当前 `src/lib/provider-doctor.ts` 的 CLI probe 主要围绕 Claude，虽然已有多安装、Git Bash、provider、live probe 和脱敏导出，但不能解释本次 Codex `desktop_only`、WindowsApps、sandbox helper 或 CWD identity。

建议新增统一、只读的 Runtime probe contract：

```ts
interface RuntimeProbeSnapshot {
  runtime: 'native' | 'claude_code' | 'codex';
  platform: NodeJS.Platform;
  candidateSource: 'override' | 'path' | 'standalone' | 'desktop_bundle' | 'alias' | 'builtin';
  installChannel?: string;
  binary: {
    displayPath?: string;
    exists: boolean;
    version?: string;
    probe: 'not_run' | 'passed' | 'failed';
  };
  cwd: {
    requested?: string;
    resolved?: string;
    source: string;
    exists: boolean;
  };
  shell?: { kind: string; executable?: string; probe: 'not_run' | 'passed' | 'failed' };
  sandbox?: {
    state: 'unknown' | 'not_configured' | 'setup' | 'ready' | 'degraded' | 'error';
    stage?: 'setup_helper' | 'command_runner' | 'child_spawn' | 'filesystem' | 'network';
  };
  lastError?: { stage: string; code?: string; message: string };
  logLocation?: string;
}
```

语义约束：`exists=true` 不能推导 `probe=passed`；app-server ready 不能推导 sandbox ready；未执行的 probe 必须显示 unknown/not_run，不能显示假绿色。

### 4.2 Path Identity：显示、比较、安全三份语义不能混用

建议统一返回：

- `displayPath`：保留用户输入和可读性，用于 UI。
- `absolutePath`：基于明确 base resolve 后的绝对路径。
- `nativeRealPath`：存在对象的 OS canonical path，用于 security containment。
- `comparisonKey`：仅用于平台明确允许的等价比较。
- `dialect`：`posix / windows_drive / unc / file_url / wsl`。
- `exists / kind / volume`：真实探测结果。

Codex 对 project trust key 做 Windows lowercase 很值得参考，但**不能机械复制到所有授权判断**：NTFS 支持目录级 case-sensitive mode，且 reparse point/UNC 映射可能让字符串相同/不同与真实对象身份不一致。安全边界以 native realpath + 目录 containment 为准，comparison key 只用于缓存和 lookup。

### 4.3 安装与修复：官方命令只是第一步

参考 Craft/OpenCode 的独立 Windows 分发体验，CodePilot 的完整修复链应是：

1. 展示当前 candidate source 和失败 stage。
2. 用户明确确认后运行官方 installer；保留原始退出码与脱敏日志。
3. 刷新 Electron/Next 所继承的 PATH 与 candidate cache。
4. 重新执行 `--version`，不能以 installer exit 0 直接判成功。
5. Codex 再跑 app-server initialize；Claude 再跑最小 SDK probe。
6. sandbox/首个 child command 单独验收。

自动修改 `WindowsApps` ACL、复制 bundle、静默降级到 unsandboxed 都不属于“修复”。

### 4.4 Secret storage：竞品经验只能当下限

本仓库当前 `api_providers.api_key` 是明文 SQLite，Harness `SecretStore` 只是抽象 facade，没有改变底层存储事实。推荐单独 Tier 2 计划：

- Electron main 独占加解密 IPC；renderer/普通 Next route 不直接拿 encryption key。
- `safeStorage.isEncryptionAvailable()` 成功时使用 OS backend，数据库只存版本化 ciphertext + storage kind。
- 旧明文迁移需 journal/rollback/逐行确认，完成后清空旧列或转换 schema。
- 无 keyring 的 Linux/headless 明确显示 degraded storage，不把同目录随机 key 包装成“系统安全存储”。
- Doctor/export 仅输出 `configured/storageKind/last4`。

## 五、哪些不要照搬

1. 飞书插件未知平台回退 macOS backend 的 fail-open 方式；未知平台应该 unsupported/fail-closed。
2. Windows 密文旁边放可直接读取的随机 master key；只能算防误看，不是 OS-bound secret protection。
3. 仅把所有 Windows spawn 改成 `shell: true`；这会重新引入 quoting、编码和注入边界。
4. 仅凭文件存在、installer exit 0、Desktop 图标或 app-server initialize 显示 Runtime 全绿。
5. 把所有 Windows path 无条件 lowercase 后用于授权。
6. 复制 Store/MSIX 私有资源、修改 `WindowsApps` ACL、读取第一方 token/DB 或连接私有 IPC。
7. 为规避 Windows 10 GPU/沙盒问题全局关闭安全/硬件能力；应做可诊断、按故障触发的 recovery mode。
8. 把会话队列、crash supervisor、secret migration 等跨平台大改塞进同一个 Windows path 修复提交。

## 六、建议优先级与验收

| 顺序 | 工作包 | 用户价值 | 最小验收 |
|------|--------|----------|----------|
| 1 | Runtime Doctor + candidate breadcrumb | 用户和复查模型能直接看出失败在安装、binary、CWD、app-server 还是 sandbox | 三 Runtime 状态均有真实 source；Desktop-only、缺 Git Bash、无 rg、坏 CWD 反例不显示假绿 |
| 2 | Path Identity Contract | 一次解决中文/空格之外的 UNC、盘符、大小写、reparse point 漂移 | 本地盘 + 中文 + 特殊字符 + 另一盘符 + UNC（有条件）+ symlink/junction matrix |
| 3 | Codex sandbox readiness POC | 防止“Codex 已连接但第一条命令失败” | standalone Windows 上 setup/helper/child 最小 smoke；无真实信号时 UI 为 unknown |
| 4 | Secret storage migration | 降低 provider/API key 本地泄漏风险 | Windows DPAPI、macOS Keychain、Linux available/degraded；迁移可回滚且 Doctor 不泄密 |
| 5 | Installer/repair flow | desktop_only 用户可自助恢复 | 用户确认、官方来源、日志、cache refresh、version + app-server 二次验证 |
| 6 | WSL/UNC/cloud/Windows 10 matrix | 防止 Windows 适配只在单台 Windows 11 本地盘成立 | CI 可自动的路径测试 + 至少两类真实环境 smoke ledger |

这些工作应分别立项。当前 commit `b70c0c10` 已解决用户本次可复现的路径/CLI 发现问题，但不应被扩大表述成上述 P1/P2 全部完成。
