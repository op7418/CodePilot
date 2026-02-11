# CLAUDE.md

## Project Overview

CodePilot — Claude Code 的原生桌面 GUI 客户端，基于 Electron + Next.js。

## Release Checklist

**发版流程（CI 自动打包 + 发布）：**

1. `package.json` 中的 `"version"` 字段更新为新版本号
2. `package-lock.json` 中的对应版本（运行 `npm install` 会自动同步）
3. 提交代码并推送到 `main` 分支
4. 创建并推送 tag：`git tag v{版本号} && git push origin v{版本号}`
5. **推送 tag 后 CI 会自动触发**（`.github/workflows/build.yml`）：
   - 自动在 macOS / Windows / Linux 上构建
   - 自动收集所有平台产物（DMG、exe、AppImage、deb、rpm）
   - 自动创建 GitHub Release 并上传所有产物
6. 等待 CI 完成，在 GitHub Release 页面补充 New Features / Bug Fixes 描述
7. 可通过 `gh run list` 查看 CI 状态，`gh run rerun <id> --failed` 重试失败的任务

**重要：不要手动创建 GitHub Release**，否则会与 CI 自动创建的 Release 冲突。如果需要本地打包测试，使用 `npm run electron:pack:mac` 但不要手动上传到 Release。

## Development Rules

**提交前必须详尽测试：**
- 每次提交代码前，必须在开发环境中充分测试所有改动的功能，确认无回归
- 涉及前端 UI 的改动需要实际启动应用验证（`npm run dev` 或 `npm run electron:dev`）
- 涉及构建/打包的改动需要完整执行一次打包流程验证产物可用
- 涉及多平台的改动需要考虑各平台的差异性

**新增功能前必须详尽调研：**
- 新增功能前必须充分调研相关技术方案、API 兼容性、社区最佳实践
- 涉及 Electron API 需确认目标版本支持情况
- 涉及第三方库需确认与现有依赖的兼容性
- 涉及 Claude Code SDK 需确认 SDK 实际支持的功能和调用方式
- 对不确定的技术点先做 POC 验证，不要直接在主代码中试错

## Release Notes 规范

每次发布 GitHub Release 时，必须包含以下内容：

**标题格式**: `CodePilot v{版本号}`

**正文结构**:

```markdown
## New Features / Bug Fixes（按实际内容选择标题）

- **功能/修复标题** — 简要描述改动内容和原因

## Downloads

- **CodePilot-{版本}-arm64.dmg** — macOS Apple Silicon (M1/M2/M3/M4)
- **CodePilot-{版本}-x64.dmg** — macOS Intel

## Installation

1. 下载对应芯片架构的 DMG 文件
2. 打开 DMG，将 CodePilot 拖入 Applications 文件夹
3. 首次打开时如遇安全提示，前往 **系统设置 → 隐私与安全性** 点击"仍要打开"
4. 在 Settings 页面配置 Anthropic API Key 或环境变量

## Requirements

- macOS 12.0+
- Anthropic API Key 或已配置 `ANTHROPIC_API_KEY` 环境变量
- 如需使用代码相关功能，建议安装 Claude Code CLI

## Changelog (since v{上一版本})

| Commit | Description |
|--------|-------------|
| `{hash}` | {commit message} |
```

**注意事项**:
- 大版本（功能更新）用 `## New Features` + `## Bug Fixes` 分区
- 小版本（纯修复）用 `## Bug Fix` 即可
- Downloads、Installation、Requirements 每次都要写，方便新用户
- Changelog 表格列出自上一版本以来的所有 commit

## Build Notes

- macOS 构建产出 DMG（arm64 + x64），Windows 产出 NSIS 安装包或 zip
- `scripts/after-pack.js` 会在打包时显式重编译 better-sqlite3 为 Electron ABI，确保原生模块兼容
- 构建前清理 `rm -rf release/ .next/` 可避免旧产物污染
- 构建 Windows 包后需要 `npm rebuild better-sqlite3` 恢复本地开发环境
- macOS 交叉编译 Windows 需要 Wine（Apple Silicon 上可能不可用），可用 zip 替代 NSIS
