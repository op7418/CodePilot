<img src="docs/icon-readme.png" width="32" height="32" alt="CodePilot" style="vertical-align: middle; margin-right: 8px;" /> CodePilot
===

**A multi-model AI agent desktop client** -- connect any AI provider, extend with MCP & skills, control from your phone, and let your assistant learn your workflow.

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Downloads](https://img.shields.io/github/downloads/op7418/CodePilot/total)](https://github.com/op7418/CodePilot/releases)
[![GitHub stars](https://img.shields.io/github/stars/op7418/CodePilot)](https://github.com/op7418/CodePilot/stargazers)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-BSL--1.1-orange)](LICENSE)

[中文文档](./README_CN.md) | [日本語](./README_JA.md)

---

![CodePilot](https://github.com/user-attachments/assets/9750450a-9f6f-49ce-acd4-c623a4e24281)

---

[Download](#download) | [Quick Start](#quick-start) | [Documentation](#documentation) | [Contributing](#contributing) | [Community](#community)

---

## Download

| Platform | Download | Architecture |
|---|---|---|
| macOS | [Apple Silicon (.dmg)](https://github.com/op7418/CodePilot/releases/latest) · [Intel (.dmg)](https://github.com/op7418/CodePilot/releases/latest) | arm64 / x64 |
| Windows | [Installer (.exe)](https://github.com/op7418/CodePilot/releases/latest) | x64 |
| Linux | [AppImage / deb / rpm](https://github.com/op7418/CodePilot/releases/latest) · [AUR](https://aur.archlinux.org/packages/codepilot-appimage) | x64 / arm64 |

Or visit the [Releases](https://github.com/op7418/CodePilot/releases) page for all versions.

---

## Why CodePilot

### Multi-provider, one interface

Connect to **17+ AI providers** out of the box. Switch providers and models mid-conversation without losing context.

| Category | Providers |
|---|---|
| Direct API | Anthropic, OpenRouter |
| Cloud platforms | AWS Bedrock, Google Vertex AI |
| Chinese AI providers | Zhipu GLM (CN/Global), Kimi, Moonshot, MiniMax (CN/Global), Volcengine Ark (Doubao), Xiaomi MiMo, Aliyun Bailian (Qwen) |
| Local & self-hosted | Ollama, LiteLLM |
| Custom | Any Anthropic-compatible or OpenAI-compatible endpoint |
| Media | Google Gemini (image generation) |

### Beyond coding — a full AI agent

CodePilot started as a coding tool but has grown into a **general-purpose AI agent desktop**:

- **Assistant Workspace** — Persona files, persistent memory, onboarding flows, and daily check-ins. Your assistant learns your preferences and adapts over time.
- **Generative UI** — AI can create interactive dashboards, charts, and visual widgets rendered live in-app.
- **Remote Bridge** — Connect to Telegram, Feishu, Discord, QQ, and WeChat. Send messages from your phone, get responses on your desktop.
- **MCP + Skills** — Add MCP servers (stdio / sse / http) with runtime monitoring. Define reusable skills or install from the skills.sh marketplace.
- **Media Studio** — AI image generation with batch tasks, gallery, and tagging.
- **Task Scheduler** — Schedule recurring tasks with cron expressions or intervals.

### Built for daily use

- Pause, resume, and **rewind sessions to any checkpoint**
- **Split-screen** dual sessions side by side
- Track **token usage and costs** with daily charts
- Import Claude Code CLI session history
- Dark / Light theme toggle
- English + Chinese interface

---

## Quick Start

### Path A: Download a release (most users)

1. Download the installer for your platform from the [Download](#download) section above
2. Launch CodePilot
3. **Configure a Provider** in **Settings > Providers** — add your API key for any supported provider
4. Start a conversation

> **Note:** Installing the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) (`npm install -g @anthropic-ai/claude-code`) unlocks additional capabilities like direct file editing, terminal commands, and git operations. It is recommended but not required for basic chat.

### Path B: Build from source (developers)

| Prerequisite | Minimum version |
|---|---|
| Node.js | 18+ |
| npm | 9+ (ships with Node 18) |

```bash
git clone https://github.com/op7418/CodePilot.git
cd CodePilot
npm install
npm run dev              # browser mode at http://localhost:3000
# -- or --
npm run electron:dev     # full desktop app
```

---

## Core Capabilities

### Conversation & Interaction

| Capability | Details |
|---|---|
| Interaction modes | Code / Plan / Ask |
| Reasoning effort | Low / Medium / High / Max + Thinking mode |
| Permission control | Default / Full Access, per-action approval |
| Session control | Pause, resume, rewind to checkpoint, archive |
| Model switching | Change model mid-conversation |
| Split screen | Side-by-side dual sessions |
| Attachments | Files and images with multimodal vision support |
| Slash commands | /help /clear /cost /compact /doctor /review and more |

### Extensions & Integrations

| Capability | Details |
|---|---|
| Providers | 17+ providers: Anthropic, OpenRouter, Bedrock, Vertex, Zhipu GLM, Kimi, Moonshot, MiniMax, Volcengine, MiMo, Bailian, Ollama, LiteLLM, custom endpoints |
| MCP servers | stdio / sse / http, runtime status monitoring |
| Skills | Custom / project / global skills, skills.sh marketplace |
| Bridge | Telegram / Feishu / Discord / QQ / WeChat remote control |
| CLI import | Import Claude Code CLI .jsonl session history |
| Image generation | Gemini image gen, batch tasks, gallery |

### Data & Workspace

| Capability | Details |
|---|---|
| Assistant Workspace | Persona files (soul.md, user.md, claude.md, memory.md), onboarding, daily check-ins, persistent memory |
| Generative UI | AI-created interactive dashboards and visual widgets |
| File browser | Project file tree with syntax-highlighted preview |
| Git panel | Status, branches, commits, worktree management |
| Usage analytics | Token counts, cost estimates, daily usage charts |
| Task scheduler | Cron-based and interval scheduling with persistence |
| Local storage | SQLite (WAL mode), all data stays on your machine |
| i18n | English + Chinese |
| Themes | Dark / Light, one-click toggle |

---

## First Launch

1. **Configure a Provider** — Go to **Settings > Providers** and add credentials for the provider you want to use. CodePilot includes presets for all major providers — just pick one and enter your API key.
2. **Create a conversation** — Pick a working directory, select a mode (Code / Plan / Ask), and choose a model.
3. **Set up Assistant Workspace** (optional) — Go to **Settings > Assistant**, choose a workspace directory, and enable Onboarding. CodePilot creates `soul.md`, `user.md`, `claude.md`, and `memory.md` at the workspace root.
4. **Add MCP servers** (optional) — Go to the **MCP** page in the sidebar to add and manage MCP servers. Custom skills are managed on the separate **Skills** page.
5. **Install Claude Code CLI** (optional) — For advanced features like file editing and terminal commands, install the CLI: `npm install -g @anthropic-ai/claude-code`

---

## Platform & Installation Notes

macOS builds are code-signed with a Developer ID certificate but not notarized, so Gatekeeper may still prompt on first launch. Windows and Linux builds are unsigned.

<details>
<summary>macOS: Gatekeeper warning on first launch</summary>

**Option 1** -- Right-click `CodePilot.app` in Finder > Open > confirm.

**Option 2** -- System Settings > Privacy & Security > scroll to Security > click Open Anyway.

**Option 3** -- Run in Terminal:
```bash
xattr -cr /Applications/CodePilot.app
```
</details>

<details>
<summary>Windows: SmartScreen blocks the installer</summary>

**Option 1** -- Click "More info" on the SmartScreen dialog, then "Run anyway".

**Option 2** -- Settings > Apps > Advanced app settings > set App Install Control to allow apps from anywhere.
</details>

---

## Documentation

📖 **Full documentation:** [English](https://www.codepilot.sh/docs) | [中文](https://www.codepilot.sh/zh/docs)

**Getting started:**
- [Quick Start](#quick-start) -- Download or build from source
- [First Launch](#first-launch) -- Provider setup, workspace configuration
- [Installation Guide](https://www.codepilot.sh/docs/installation) -- Detailed setup instructions

**User guides:**
- [Providers](https://www.codepilot.sh/docs/providers) -- Configuring AI providers and custom endpoints
- [MCP Servers](https://www.codepilot.sh/docs/mcp) -- Adding and managing Model Context Protocol servers
- [Skills](https://www.codepilot.sh/docs/skills) -- Custom skills, project skills, and the skills.sh marketplace
- [Bridge](https://www.codepilot.sh/docs/bridge) -- Remote control via Telegram, Feishu, Discord, QQ, WeChat
- [Assistant Workspace](https://www.codepilot.sh/docs/assistant-workspace) -- Persona files, onboarding, memory, daily check-ins
- [FAQ](https://www.codepilot.sh/docs/faq) -- Common issues and solutions

**Developer docs:**
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- Architecture, tech stack, directory structure, data flow
- [docs/handover/](./docs/handover/) -- Design decisions and handover documents
- [docs/exec-plans/](./docs/exec-plans/) -- Execution plans and tech debt tracker

---

## FAQ

<details>
<summary>Do I need the Claude Code CLI?</summary>

No. You can use CodePilot with any supported provider (OpenRouter, Zhipu GLM, Volcengine, Ollama, etc.) without the Claude Code CLI. The CLI is only needed if you want Claude to directly edit files, run terminal commands, or use git operations on your machine. For chat and assistant features, just configure a provider and start a conversation.
</details>

<details>
<summary>Configured a Provider but no models appear</summary>

Verify the API key is valid and the endpoint is reachable. Some providers (Bedrock, Vertex) require additional environment variables or IAM configuration beyond the API key. Use the built-in diagnostics (**Settings > Providers > Run Diagnostics**) to check connectivity.
</details>

<details>
<summary>What is the difference between <code>npm run dev</code> and <code>npm run electron:dev</code>?</summary>

`npm run dev` starts only the Next.js dev server -- you use CodePilot in your browser at `http://localhost:3000`. `npm run electron:dev` starts both Next.js and the Electron shell, giving you the full desktop app experience with native window controls.
</details>

<details>
<summary>Where are the Assistant Workspace files?</summary>

When you set up a workspace, CodePilot creates four Markdown files at the **workspace root directory**: `soul.md` (personality), `user.md` (user profile), `claude.md` (rules), and `memory.md` (long-term notes). State tracking (onboarding progress, check-in dates) is stored in the `.assistant/` subdirectory. Daily memories go to `memory/daily/`.
</details>

<details>
<summary>Bridge requires additional setup per platform</summary>

Each Bridge channel (Telegram, Feishu, Discord, QQ, WeChat) requires its own bot token or app credentials. Go to the **Bridge** page in the sidebar to configure channels. You will need to create a bot on the target platform first and provide the token to CodePilot.
</details>

---

## Community

<img src="docs/wechat-group-qr.png" width="240" alt="WeChat Group QR Code" />

Scan the QR code to join the WeChat user group for discussions, feedback, and updates.

- [GitHub Issues](https://github.com/op7418/CodePilot/issues) -- Bug reports and feature requests
- [GitHub Discussions](https://github.com/op7418/CodePilot/discussions) -- Questions and general discussion

---

## Contributing

1. Fork the repository and create a feature branch
2. `npm install` and `npm run electron:dev` to develop locally
3. Run `npm run test` before opening a PR
4. Submit a PR against `main` with a clear description

Keep PRs focused -- one feature or fix per pull request.

<details>
<summary>Development commands</summary>

```bash
npm run dev                    # Next.js dev server (browser)
npm run electron:dev           # Full Electron app (dev mode)
npm run build                  # Production build
npm run electron:build         # Build Electron distributable
npm run electron:pack:mac      # macOS DMG (arm64 + x64)
npm run electron:pack:win      # Windows NSIS installer
npm run electron:pack:linux    # Linux AppImage, deb, rpm
```

**CI/CD:** Pushing a `v*` tag builds macOS arm64/x64, Windows x64, and Linux arm64/x64 packages, then creates a GitHub Release automatically. A failure in any target blocks the Release.

**Notes:**
- Electron forks a Next.js standalone server on `127.0.0.1` with a random free port
- Chat data is stored in `~/.codepilot/codepilot.db` (dev mode: `./data/`)
- SQLite uses WAL mode for fast concurrent reads
</details>

---

## License

[Business Source License 1.1 (BSL-1.1)](LICENSE)

- **Personal / academic / non-profit use**: free and unrestricted
- **Commercial use**: requires a separate license — contact [@op7418 on X](https://x.com/op7418)
- **Change date**: 2029-03-16 — after which the code converts to Apache 2.0
