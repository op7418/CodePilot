# 为什么 CLI 更新必须“宁可少支持，也不能更新错目标”

> 技术实现：[handover/cli-maintenance.md](../handover/cli-maintenance.md)；不变量：[guardrails/CliMaintenance.md](../guardrails/CliMaintenance.md)

T3 Code 证明了一个很好的产品方向：桌面客户端知道自己的 Agent CLI 版本是否过旧，并能把“去终端找命令”缩短为一次明确操作。对 CodePilot 来说，它不只是便利功能，也能减少 CLI 版本过低造成的模型、权限和协议兼容问题。

难点不在按钮，而在“这个按钮到底更新哪一份 CLI”。同一台机器可能同时存在 native、npm、Homebrew、bun、pnpm、WinGet 和自建 wrapper。PATH 看到的 `claude`/`codex` 不一定归用户以为的 package manager；Windows `.cmd` 也不是 realpath 能穿透的 symlink。只按目录名猜渠道，最坏结果不是更新失败，而是更新了另一份安装，界面显示成功，Runtime 仍继续执行旧版本。

因此首版采用三条取舍：

1. latest 必须来自当前渠道。npm 发布更快，不代表 Homebrew cask 或 WinGet 已同步；没有同渠道事实就显示 manual/unknown。
2. 一键更新必须先证明 selected binary 的 owner。证明不了就少一个按钮，不用“尽量更新”制造假成功。
3. 成功由 after version 决定，不由 exit code 决定。特别是 Codex self-update 可能只提示改用 package manager 并返回 0；同版本必须诚实归为 unchanged。

Windows 不是简单照搬 macOS。npm `.cmd` 需要保持 argv 边界；Codex standalone 可能进入官方 PowerShell 更新流程；Claude WinGet 与 native 布局重叠时，包存在也不足以唯一证明 ownership。所以 Windows 首版提供 npm/standalone 的可证明路径，并把无法消歧的 WinGet/native 留在 manual-check，而不是自造下载器或静默换成 npm。

“看起来像独立可执行文件”也不等于独立安装。ChatGPT/Codex Desktop 会把 `codex` 放进自己的 app bundle；它即使没有扩展名或以 `.exe` 结尾，生命周期 owner 仍是桌面应用。所有权判断不能锚死今天的 `Resources/codex`：macOS 以 `.app/Contents/**` 为应用边界，Windows 以 Store/alias 和已知桌面应用 Resources 根为边界，同时保留官方 standalone `OpenAI/Codex/bin` 反例。CodePilot 对 app-owned binary 只展示当前版本和“随桌面应用更新”，不拿 public standalone release 制造更新提醒，也不尝试改写另一个应用的安装内容。

更新窗口还有另一层用户信任：安装器运行五分钟时，CodePilot 不能同时启动正在被替换的 CLI，也不能因为应用更新或退出把 package manager 半途杀掉。provider lease 保护 Runtime spawn，Main lifecycle latch 协调 app updater/quit；用户仍能强制退出，但风险必须由产品明确说出来。

提醒卡片也必须忠实反映这段窗口：安装进行中不能被误操作静默隐藏，多 CLI 串行更新失败后的 Retry 只能继续未完成项，不能把已经成功的 Provider 再跑一次并显示成“版本未变化”。成功后才清掉当前通知身份，使同一目标版本在用户回滚或重装后仍能再次提醒。

Release Notes 的 HTML bug 也遵循相同思路。Atom feed 的 HTML 需要被解析才能正常显示，但“支持 HTML”不等于信任远程 HTML。正确边界是 parse 后 strict sanitize：保留标题、列表、表格和安全链接，移除脚本、样式、表单、SVG、图片和危险 scheme。

最终体验应该很简单：有真实更新时一次提醒，Settings 随时能看到版本、渠道和检查时间；能安全一键更新就给 Update，不能证明就给清楚的手工路径。复杂性留在信任边界里，不转嫁成一个看似万能但可能更新错东西的按钮。
