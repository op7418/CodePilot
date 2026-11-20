# Windows Runtime 恢复为什么不能只做“多加几个路径”

> 竞品依据见 [Windows 竞品适配可借鉴矩阵](../research/windows-competitor-adaptation-reuse-2026-08-06.md)。

## 用户真正遇到的是一条执行链，而不是一个路径 bug

“项目已经打开，Agent 却读不到文件”表面像中文路径问题，实际可能失败在候选目录、路径 dialect、canonical object、shell、binary、app-server、sandbox 或首个 child command任一层。过去只给一个“可用/不可用”状态，会让用户不断猜：究竟是 Windows、CodePilot、Claude、Codex，还是项目本身坏了。

因此这轮的核心不是继续堆 candidate，而是把状态拆成可证明的事实。用户看到 `desktop_only`、`binary passed/app-server not run`、`sandbox unknown`，虽然不如一个绿色圆点好看，却能直接采取正确动作。

## 为什么借鉴竞品时要吸收原则，不照搬实现

- 飞书 OpenClaw 证明核心 I/O 不该依赖 PowerShell/`cmd.exe`；CodePilot 继续用 filesystem API 和 `cwd/argv`，但不采用“密钥与密文同目录”的弱化方案。
- Craft Agents 证明 Windows 应有独立安装/日志/诊断入口；CodePilot 将恢复入口放回 Runtime 故障现场，而不是另建安装中心。
- OpenCode 证明安装渠道与可执行来源应显式；CodePilot 采用 candidate source breadcrumb，但不把 Scoop/Chocolatey 当默认或替用户安装。
- OpenAI Codex 证明 Windows project trust 和 sandbox 必须分层；CodePilot 保留 display/canonical/comparison 三种路径身份，并让 sandbox 无信号时保持 unknown。

共同原则是：平台适配不是“让失败消失”，而是让每一层的失败有真实来源、有恢复动作、有安全边界。

## 为什么按钮只复制命令，不自动安装

自动把远程脚本送进 PowerShell 看似“一键”，却会同时扩大 renderer→Main IPC、命令注入、Execution Policy 和用户授权边界。用户提出的体验目标其实只需要三步：点击、粘贴、回车。

所以按钮承担两件确定性的事：复制固定官方命令、打开可见 PowerShell。执行仍由用户在可见终端确认。这样少一次手工找命令，又不会把安装行为藏在桌面按钮背后。复制/打开成功也不等于安装成功；最终判定仍是刷新后的 binary probe。

## 为什么凭据安全必须和 Windows 修复一起做

竞品调研暴露出一个更深的矛盾：我们希望 Doctor 给出更多执行链信息，却不能因此让诊断、renderer 或 shell 更容易接触 API key。若 Provider key 仍是 SQLite 明文，任何“统一诊断”都会扩大被误读的面。

Envelope encryption 将职责拆开：OS credential backend 保护数据密钥，数据库只持有带认证的密文，业务 accessor 临时解密。它不是绝对防御——同一用户上下文中的恶意进程仍是威胁——但明显提高了静态数据库泄漏门槛，也让“backend/security level”成为可诚实展示的产品状态。

## 产品语义上的四条底线

1. Desktop 应用存在不等于第三方客户端可执行它的内部 CLI。
2. app-server ready 不等于 sandbox ready。
3. 复制 installer 不等于安装完成。
4. 数据库里有密文不等于系统级保护；backend 不可用或 Linux basic_text 必须明确降级。

## 后续值得继续做的事

- 把 candidate discovery 从运行时内的硬编码列表继续收敛成带 source/channel/priority/probe 的 registry。
- 建立 Windows 11/10、UNC、WSL、OneDrive、junction 的持续矩阵，而非只在本机增加 fixture。
- 在 upstream 能提供真实 first-child sandbox 成功事件后才引入 `ready`，并保留失败 stage。
- 为 live-smoke 建立受控凭据注入方式；不要为了方便脚本而重新开放数据库解密。
- 将同样的“恢复后重新探测”原则用于 Claude Code、Git Bash 与未来 Runtime。
