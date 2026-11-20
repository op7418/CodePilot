# CLI 升级 + 代理透传 — 产品思考

## 解决什么用户问题

### P0：CLI 版本过旧导致 exit code 1

11 个 issue 的共性根因。用户安装 CodePilot 后，里面的 SDK 调用的是系统上的 Claude Code CLI。如果 CLI 版本太旧（如 2.0.x），SDK 接口不兼容直接 exit code 1，用户看到的是"发送消息失败"。

用户不知道：
- 问题出在 CLI 版本上（错误信息只有 exit code 1）
- 自己装的是什么版本、最新版是什么
- 怎么升级（不同安装方式命令不同）

### P1：中国用户的网络问题

中国用户占了相当比例。他们电脑上有 VPN 但代理没传递到子进程，导致：
- 升级命令访问不了 npm/GitHub
- 版本检测 API 也可能超时

### P2：Windows 用户缺 Git Bash

Windows 上 Claude Code 依赖 Git Bash 执行命令。官方只是在文档里提了一句"需要安装 Git for Windows"，没有在产品层面做好引导。用户不理解为什么一个 AI 编程工具需要装 Git。

## 为什么这样设计

### "可更新"状态而非"自动更新 CLI"

考虑过让 CodePilot 自动更新 CLI，但放弃了：
- CLI 是系统级工具，不属于 CodePilot 管理范畴
- 自动更新可能打断正在进行的会话
- 不同安装方式有不同的更新机制，强行统一会出问题
- 用户应该知道自己的 CLI 在更新

所以选择了"检测 + 提示 + 一键操作"的模式：让用户知道有更新，提供一键按钮，但由用户主动触发。

### 分渠道策略而非统一检测

最初想用 npm registry 作为所有渠道的版本源。但发现：
- Homebrew cask 和 WinGet 是独立分发，版本可能滞后数天
- 显示"有新版本"但 `brew upgrade` 说"已是最新"会让用户困惑
- Native 安装自带后台更新，提示更新是噪音

所以拆成三档：
1. **npm/bun** — 可靠对比，显示"可更新"
2. **homebrew/winget** — 无法可靠对比，显示"检查更新"入口
3. **native** — 自动更新，不显示任何提示

### 系统代理透传而非手动配置

考虑过在设置页加代理输入框，但：
- 中国用户电脑上已经有 VPN 了，再让他们手动填一次代理地址是冗余操作
- 大多数用户不知道自己 VPN 的代理端口是多少
- macOS 系统代理设置是现成的，Chromium 的 `resolveProxy` 直接能读

所以选择了"无感透传"：检测系统代理，注入到子进程环境变量，用户完全不需要做任何配置。

### Git 安装的"尽力而为"策略

Git 安装做成非致命步骤，因为：
- 不是所有 Windows 环境都有 winget
- winget 安装 Git 可能需要 UAC 权限
- 即使 Git 装不上，Claude CLI 本身还是能装的（只是功能受限）

## 已知局限

1. **代理检测只在启动时执行一次** — 用户开关 VPN 后需要重启 CodePilot
2. **WinGet 检测有 5 秒超时** — 首次 status 检查可能略慢
3. **Homebrew/WinGet 无法确认是否有新版本** — 只能提供升级入口
4. **native 安装的"自动更新"可能不及时** — CodePilot 通过 SDK spawn 短生命周期子进程，自动更新机制来不及生效。用户仍可以手动运行 `claude update`

## 参考

- 官方安装/升级文档：https://code.claude.com/docs/en/setup
- P0 issue 集群分析：见 `docs/exec-plans/active/cli-upgrade-proxy.md`
- 相关 Issues: #417, #416, #414, #413, #412, #410, #406, #393, #381, #380, #376, #360, #356
