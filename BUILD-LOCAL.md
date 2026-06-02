# 本地构建 / 验证（沙箱环境备忘）

> 这份文档针对的是 **没有完整 Linux 沙箱** 的本地开发者。
> 如果你在 GitHub Actions / 标准 dev 机上，照常 `npm run electron:pack:mac` 即可。

## 已知沙箱 bug

`next build` 在我们的 Linux 沙箱（无 stdout pipe / 无 Next 16.2.1 hotfix）里会报：

```
TypeError: generate is not a function
    at ignore-listed frames
```

这是 **Next 16.2.1 在沙箱环境下的内部 bug**，跟我们的源码、PR 内容、`tsconfig.json` 都无关。验证方式：

```bash
git stash                     # 把所有未提交改动收起来
npm run build                 # baseline 也坏 → 确认 pre-existing
git stash pop
```

> ⚠️ Next 16 dev server 在启动时会自动改 `tsconfig.json`（加 `incremental` / `tsBuildInfoFile`）。如果发现这个文件出现在 diff 里，`git checkout -- tsconfig.json` 即可。

## 本地构建 macOS 安装包

```bash
git clone --branch worktree-product-refactor-research https://github.com/op7418/CodePilot.git
cd CodePilot
npm install                   # 装 1914 个包
npm run electron:pack:mac
```

产物：

```
release/CodePilot-0.55.0-preview.5-mac-{arm64,x64}.dmg
release/mac-{arm64,x64}/CodePilot.app
```

## 本地 dev（最快路径）

```bash
npm install
npm run electron:dev          # next dev + esbuild watch + electron
```

## 验证本 PR 的两个修复

PR 只改了 4 行 Tailwind className + 文档，最有效的验证是 dev 模式下肉眼对照：

1. **侧边栏 hover 分隔**
   - 打开任一有 ≥2 个 session 的项目
   - 鼠标在两个 session row 之间快速扫一遍
   - 期望：每行的 hover 背景**清晰分隔**为两条独立色带（不再融成一条）

2. **角色映射弹窗 footer 分段**
   - Settings → Models → 任意 provider → 「角色映射」
   - 向下滚动到底部
   - 期望：最后一行配置项与「取消 / 保存」按钮之间有 **1px 分隔线 + 32px 缓冲**（不再是 20px 的"紧贴"）

3. **反例 smoke**
   - 添加模型弹窗（短弹窗，无 border）：确认 **没有** 出现多余的分隔线（验证 primitive 没被污染）
   - 项目分组折叠：折叠后无空白 gap
   - 1 个 role vs 10 个 role：footer 都贴在底部，body 单独滚动

## 跑测试

```bash
npm run typecheck             # 0 错
npm run test:unit             # 3153/3154 pass；唯一 fail 是 SQLite 并行锁的 flaky，单跑通过
```

## 不需要做的事

- ❌ 跑 Playwright E2E（Tier 0 验证已足够）
- ❌ 改 `tsconfig.json`（沙箱 Next 16 dev 自动改的，本地正常 dev 不会改）
- ❌ 删 `node_modules` 重装（除非确实坏了；`npm install` 一般 30s 内完成）
