# CLAUDE.md

CodePilot — Claude Code 的桌面 GUI 客户端，基于 Electron + Next.js。

> 架构细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)，本文件只包含规则和流程。

## 开发规则

**提交前必须详尽测试：**
- 每次提交代码前，必须在开发环境中充分测试所有改动的功能，确认无回归
- 涉及前端 UI 的改动需要实际启动应用验证（`npm run dev` 或 `npm run electron:dev`）
- 涉及构建/打包的改动需要完整执行一次打包流程验证产物可用
- 涉及多平台的改动需要考虑各平台的差异性

**UI 改动必须用 CDP 验证（chrome-devtools MCP）：**
- 修改组件、样式、布局后，必须通过 chrome-devtools MCP 实际验证效果
- 验证流程：`npm run dev` 启动应用 → 用 CDP 打开 `http://localhost:3000` 对应页面 → 截图确认渲染正确 → 检查 console 无报错
- 涉及交互的改动（按钮、表单、导航）需通过 CDP 模拟点击/输入并截图验证
- 修改响应式布局时，用 CDP 的 device emulation 分别验证桌面和移动端视口

**新增功能前必须详尽调研：**
- 新增功能前必须充分调研相关技术方案、API 兼容性、社区最佳实践
- 涉及 Electron API 需确认目标版本支持情况
- 涉及第三方库需确认与现有依赖的兼容性
- 涉及 Claude Code SDK 需确认 SDK 实际支持的功能和调用方式
- 对不确定的技术点先做 POC 验证，不要直接在主代码中试错

**Worktree 隔离规则：**
- 如果任务设置了 Worktree，所有代码改动只能在该 Worktree 内进行
- 严格禁止跨 Worktree 提交（不得在主目录提交 Worktree 的改动，反之亦然）
- 严格禁止 `git push`，除非用户主动提出
- 启动测试服务（`npm run dev` 等）只从当前 Worktree 启动，不得在其他目录启动
- 合并回主分支必须由用户主动发起，不得自动合并
- **端口隔离**：Worktree 启动 dev server 时使用非默认端口（如 `PORT=3001`），避免与主目录冲突
- **禁止跨目录编辑**：属于 Worktree 任务范围的文件，只在该 Worktree 内编辑，不得在主目录修改
- **合并前检查 untracked 文件**：合并回主分支前先 `git status` 确认无调试残留、临时文件等

**Commit 信息规范：**
- 标题行使用 conventional commits 格式（feat/fix/refactor/chore 等）
- body 中按文件或功能分组，说明改了什么、为什么改、影响范围
- 修复 bug 需说明根因；架构决策需简要说明理由

## 自检命令

**自检命令（pre-commit hook 会自动执行前三项）：**
- `npm run test` — typecheck + 单元测试（~4s，无需 dev server）
- `npm run test:smoke` — 冒烟测试（~15s，需要 dev server）
- `npm run test:e2e` — 完整 E2E（~60s+，需要 dev server）

修改代码后，commit 前至少确保 `npm run test` 通过。
涉及 UI 改动时额外运行 `npm run test:smoke`。

## 改动自查

完成代码修改后，在提交前确认：
1. 改动是否涉及 i18n — 是否需要同步 `src/i18n/en.ts` 和 `zh.ts`
2. 改动是否涉及数据库 — 是否需要在 `src/lib/db.ts` 更新 schema 迁移
3. 改动是否涉及类型 — 是否需要更新 `src/types/index.ts`
4. 改动是否涉及已有文档 — 是否需要更新 `docs/handover/` 中的交接文档
5. 改动是否构成新功能或大迭代 — 是否需要写文档（见下方"功能文档"）

## 功能文档

**新功能或大迭代完成后必须同时输出两份文档：**

1. **技术交接文档** — 放 `docs/handover/`
   - 目录结构、数据流、DB schema、API 路由、关键设计决策
   - 涉及 MCP 工具的需列出工具名、参数、自动批准策略
   - 目标读者：接手的开发者，需要能仅靠文档理解模块全貌
2. **产品思考文档** — 放 `docs/insights/`
   - 功能解决了什么用户问题、为什么这样设计而不是其他方案
   - 用户反馈驱动的决策、参考的外部文章/竞品/趋势
   - 未来可能的方向和已知的局限性
   - 目标读者：产品决策者，需要能理解设计背后的"为什么"

**两份文档必须互相反向链接：**
- 交接文档开头：`> 产品思考见 [docs/insights/xxx.md](../insights/xxx.md)`
- 产品文档开头：`> 技术实现见 [docs/handover/xxx.md](../handover/xxx.md)`

**文件命名保持一致**（如 `cli-tools.md`），方便对照查找。

## 发版

**发版流程：** 更新 `RELEASE_NOTES.md` → 更新 package.json version → `npm install` 同步 lock → 提交推送 → `git tag v{版本号} && git push origin v{版本号}` → CI 自动构建发布并使用 `RELEASE_NOTES.md` 作为 Release 正文。不要手动创建 GitHub Release（CI 会自动创建并上传构建产物）。

**发版纪律：** 禁止自动发版。`git push` + `git tag` 必须等用户明确指示后才执行。commit 可以正常进行。

**构建：** macOS 产出 DMG（arm64 + x64），Windows 产出 NSIS 安装包。`scripts/after-pack.js` 重编译 better-sqlite3 为 Electron ABI。构建前清理 `rm -rf release/ .next/`。

**Release Notes 格式（必须严格遵循）：**

标题：`CodePilot v{版本号}`

正文结构：

```markdown
## CodePilot v{版本号}

> 一句话版本摘要，说明这个版本的核心主题或推荐升级理由。

### 新增功能
- 功能描述（面向用户的语言，不要写 commit hash）

### 修复问题
- 修复了 xxx 的问题

### 优化改进
- 优化了 xxx

## 下载地址

### macOS
- [Apple Silicon (M1/M2/M3/M4)](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot-{版本号}-arm64.dmg)
- [Intel](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot-{版本号}-x64.dmg)

### Windows
- [Windows 安装包](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot-Setup-{版本号}.exe)

## 安装说明

**macOS**: 下载 DMG → 拖入 Applications → 首次启动如遇安全提示，在系统设置 > 隐私与安全中点击"仍要打开"
**Windows**: 下载 exe 安装包 → 双击安装

## 系统要求

- macOS 12.0+ / Windows 10+ / Linux (glibc 2.31+)
- 需要配置 API 服务商（Anthropic / OpenRouter 等）
- 推荐安装 Claude Code CLI 以获得完整功能
```

**Release Notes 写作规则：**
- 更新内容必须用用户能理解的语言，不要出现 commit hash、函数名、文件路径
- 每个条目说清楚"用户能感知到什么变化"
- 下载链接必须是完整的 GitHub release download URL，用户点击即可下载
- 如果某个分类没有内容（如没有修复），跳过该分类不要留空标题
- `git log --oneline` 的输出只用于自己梳理，不要原样复制到 Release Notes

## 执行计划

**中大型功能（跨 3+ 模块、涉及 schema 变更、需分阶段交付）必须先写执行计划再开工。**
- 活跃计划放 `docs/exec-plans/active/`，完成后移至 `completed/`
- 纯调研/可行性分析放 `docs/research/`
- 发现技术债务时记录到 `docs/exec-plans/tech-debt-tracker.md`
- 模板和规范见 `docs/exec-plans/README.md`

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 项目架构、目录结构、数据流、新功能触及点
- `docs/exec-plans/` — 执行计划（进度状态 + 决策日志 + 技术债务）
- `docs/handover/` — 技术交接文档（架构、数据流、设计决策）
- `docs/insights/` — 产品思考文档（用户问题、设计理由、趋势洞察）
- `docs/research/` — 调研文档（技术方案、可行性分析）

**检索前先读对应目录的 README.md；增删文件后更新索引。**
