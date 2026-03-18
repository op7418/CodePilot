<img src="docs/icon-readme.png" width="32" height="32" alt="CodePilot" style="vertical-align: middle; margin-right: 8px;" /> CodePilot
===

**A unified desktop client for Claude Code** -- multi-provider support, MCP extensions, custom skills, cross-platform bridge, and an assistant workspace that understands your projects.

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-BSL--1.1-orange)](LICENSE)

[中文文档](./README_CN.md) | [日本語](./README_JA.md)

![CodePilot](docs/screenshot.png)

---

[Download](#platform--installation) | [Quick Start](#quick-start) | [Documentation](#documentation) | [Contributing](#contributing) | [Community](#community)

---

## Why CodePilot

**Multi-provider, one interface.** Connect to Anthropic, OpenRouter, Bedrock, Vertex, or any custom endpoint. Switch providers and models mid-conversation without losing context.

**MCP + Skills extensibility.** Add MCP servers (stdio / sse / http) with runtime status monitoring. Define reusable prompt-based skills -- global or per-project -- and invoke them as slash commands. Browse and install community skills from skills.sh.

**Control from anywhere.** Bridge connects CodePilot to Telegram, Feishu, Discord, and QQ. Send a message from your phone, get the response on your desktop.

**An assistant that knows your project.** Set up a workspace directory with persona files (soul.md, user.md), rules (claude.md), and persistent memory (memory.md). Claude uses these to adapt to your project's conventions over time, with onboarding flows and daily check-ins.

**Built for daily use.** Pause, resume, and rewind sessions to any checkpoint. Work in split-screen with two conversations side by side. Track token usage and costs. Import CLI session history. Switch between dark and light themes.

---

## Quick Start

### Path A: Download a release (most users)

1. Install the Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
2. Authenticate: `claude login`
3. Download the installer for your platform from the [Releases](https://github.com/op7418/CodePilot/releases) page
4. Launch CodePilot

### Path B: Build from source (developers)

| Prerequisite | Minimum version |
|---|---|
| Node.js | 18+ |
| Claude Code CLI | Installed and authenticated |
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

## First Launch

1. **Authenticate Claude** -- Run `claude login` in your terminal if you haven't already.
2. **Configure a Provider** -- If you only use Anthropic via CLI authentication or `ANTHROPIC_API_KEY`, Providers setup is optional. For OpenRouter, Bedrock, Vertex, or custom endpoints, go to **Settings > Providers** and add the credentials first.
3. **Create a conversation** -- Pick a working directory, select a mode (Code / Plan / Ask), and choose a model.
4. **Set up Assistant Workspace** (optional) -- Go to **Settings > Assistant**, choose a workspace directory, and enable Onboarding. CodePilot creates `soul.md`, `user.md`, `claude.md`, and `memory.md` at the workspace root (state is tracked in the `.assistant/` subdirectory).
5. **Add MCP servers** (optional) -- Go to the **MCP** page in the sidebar to add and manage MCP servers. Custom skills are managed on the separate **Skills** page.

---

## Core Capabilities

### Conversation & Coding

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
| Providers | Anthropic / OpenRouter / Bedrock / Vertex / custom endpoints |
| MCP servers | stdio / sse / http, runtime status monitoring |
| Skills | Custom / project / global skills, skills.sh marketplace |
| Bridge | Telegram / Feishu / Discord / QQ remote control |
| CLI import | Import Claude Code CLI .jsonl session history |
| Image generation | Gemini / Anthropic image gen, batch tasks, gallery |

### Data & Workspace

| Capability | Details |
|---|---|
| Assistant Workspace | Workspace root files (soul.md, user.md, claude.md, memory.md), .assistant/ state, onboarding, check-in |
| File browser | Project file tree with syntax-highlighted preview |
| Usage analytics | Token counts, cost estimates, daily usage charts |
| Local storage | SQLite (WAL mode), all data stays on your machine |
| i18n | English + Chinese |
| Themes | Dark / Light, one-click toggle |

---

## Platform & Installation

| Platform | Format | Architecture |
|---|---|---|
| macOS | .dmg | arm64 (Apple Silicon) + x64 (Intel) |
| Windows | .exe (NSIS) | x64 + arm64 |
| Linux | .AppImage / .deb / .rpm | x64 + arm64 |

Download from the [Releases](https://github.com/op7418/CodePilot/releases) page.

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
- [First Launch](#first-launch) -- Authentication, providers, workspace setup
- [Installation Guide](https://www.codepilot.sh/docs/installation) -- Detailed setup instructions

**User guides:**
- [Providers](https://www.codepilot.sh/docs/providers) -- Configuring Anthropic, OpenRouter, Bedrock, Vertex, and custom endpoints
- [MCP Servers](https://www.codepilot.sh/docs/mcp) -- Adding and managing Model Context Protocol servers
- [Skills](https://www.codepilot.sh/docs/skills) -- Custom skills, project skills, and the skills.sh marketplace
- [Bridge](https://www.codepilot.sh/docs/bridge) -- Remote control via Telegram, Feishu, Discord, QQ
- [Assistant Workspace](https://www.codepilot.sh/docs/assistant-workspace) -- Persona files, onboarding, memory, daily check-ins
- [FAQ](https://www.codepilot.sh/docs/faq) -- Common issues and solutions

**Developer docs:**
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- Architecture, tech stack, directory structure, data flow
- [docs/handover/](./docs/handover/) -- Design decisions and handover documents
- [docs/exec-plans/](./docs/exec-plans/) -- Execution plans and tech debt tracker

---

## FAQ

<details>
<summary><code>claude</code> command not found</summary>

Install the Claude Code CLI globally:
```bash
npm install -g @anthropic-ai/claude-code
```
Then authenticate with `claude login`. Make sure `claude --version` works before launching CodePilot.
</details>

<details>
<summary>Configured a Provider but no models appear</summary>

Verify the API key is valid and the endpoint is reachable. Some providers (Bedrock, Vertex) require additional environment variables or IAM configuration beyond the API key. Check the provider's documentation for required setup.
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

Each Bridge channel (Telegram, Feishu, Discord, QQ) requires its own bot token or app credentials. Go to the **Bridge** page in the sidebar to configure channels. You will need to create a bot on the target platform first and provide the token to CodePilot.
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

**CI/CD:** Pushing a `v*` tag triggers a full multi-platform build and creates a GitHub Release automatically.

**Notes:**
- Electron forks a Next.js standalone server on `127.0.0.1` with a random free port
- Chat data is stored in `~/.codepilot/codepilot.db` (dev mode: `./data/`)
- SQLite uses WAL mode for fast concurrent reads
</details>

---

## License

[Business Source License 1.1 (BSL-1.1)](LICENSE)

- **Personal / academic / non-profit use**: free and unrestricted
- **Commercial use**: requires a separate license — contact 7418@openclaw.ai
- **Change date**: 2029-03-16 — after which the code converts to Apache 2.0
