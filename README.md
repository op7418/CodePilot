<img src="docs/icon-readme.png" width="32" height="32" alt="CodePilot" style="vertical-align: middle; margin-right: 8px;" /> CodePilot
===

**A native desktop GUI for Claude Code** -- chat, code, and manage projects through a polished visual interface instead of the terminal.

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文文档](./README_CN.md) | [日本語](./README_JA.md)

---

## Features

- **Conversational coding** -- Stream responses from Claude in real time with full Markdown rendering, syntax-highlighted code blocks, and tool-call visualization.
- **Session management** -- Create, rename, archive, and resume chat sessions. Conversations are persisted locally in SQLite so nothing is lost between restarts.
- **Project-aware context** -- Pick a working directory per session. The right panel shows a live file tree and file previews so you always know what Claude is looking at.
- **Resizable panels** -- Drag the edges of the chat list and right panel to adjust their width. Your preferred sizes are saved across sessions.
- **File & image attachments** -- Attach files and images directly in the chat input. Images are sent as multimodal vision content for Claude to analyze.
- **Permission controls** -- Approve, deny, or auto-allow tool use on a per-action basis. Choose between permission modes to match your comfort level.
- **Multiple interaction modes** -- Switch between *Code*, *Plan*, and *Ask* modes to control how Claude behaves in each session.
- **Model selector** -- Switch between Claude models (Opus, Sonnet, Haiku) mid-conversation.
- **MCP server management** -- Add, configure, and remove Model Context Protocol servers directly from the Extensions page. Supports `stdio`, `sse`, and `http` transport types.
- **Custom skills** -- Define reusable prompt-based skills (global or per-project) that can be invoked as slash commands during chat.
- **Settings editor** -- Visual and JSON editors for your `~/.claude/settings.json`, including permissions and environment variables.
- **Token usage tracking** -- See input/output token counts and estimated cost after every assistant response.
- **Auto update check** -- The app periodically checks for new releases and notifies you when an update is available.
- **Dark / Light theme** -- One-click theme toggle in the navigation rail.
- **Slash commands** -- Built-in commands like `/help`, `/clear`, `/cost`, `/compact`, `/doctor`, `/review`, and more.
- **Electron packaging** -- Ships as a native desktop app with a hidden title bar, bundled Next.js server, graceful shutdown, and automatic port allocation.

---

## Screenshots

![CodePilot](docs/screenshot.png)

---

## Prerequisites

> **Important**: CodePilot calls the Claude Code Agent SDK under the hood. Make sure `claude` is available on your `PATH` and that you have authenticated (`claude login`) before launching the app.

| Requirement | Minimum version |
|---|---|
| **Node.js** | 18+ |
| **Claude Code CLI** | Installed and authenticated (`claude --version` should work) |
| **npm** | 9+ (ships with Node 18) |

---

## Download

Pre-built releases are available on the [**Releases**](https://github.com/op7418/CodePilot/releases) page. Releases are built automatically via GitHub Actions for all platforms.

### Supported Platforms

- **macOS** -- arm64 (Apple Silicon) and x64 (Intel) distributed as `.dmg`
- **Windows** -- NSIS installer (`.exe`) bundling x64 + arm64
- **Linux** -- x64 and arm64 distributed as `.AppImage`, `.deb`, and `.rpm`

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/op7418/CodePilot.git
cd CodePilot

# Install dependencies
npm install

# Start in development mode (browser)
npm run dev

# -- or start the full Electron app in dev mode --
npm run electron:dev
```

Then open [http://localhost:3000](http://localhost:3000) (browser mode) or wait for the Electron window to appear.

---

## Installation Troubleshooting

CodePilot is not code-signed yet, so your operating system will display a security warning the first time you open it.

### macOS

You will see a dialog that says **"Apple cannot check it for malicious software"**.

**Option 1 -- Right-click to open**

1. Right-click (or Control-click) `CodePilot.app` in Finder.
2. Select **Open** from the context menu.
3. Click **Open** in the confirmation dialog.

**Option 2 -- System Settings**

1. Open **System Settings** > **Privacy & Security**.
2. Scroll down to the **Security** section.
3. You will see a message about CodePilot being blocked. Click **Open Anyway**.
4. Authenticate if prompted, then launch the app.

**Option 3 -- Terminal command**

```bash
xattr -cr /Applications/CodePilot.app
```

This strips the quarantine attribute so macOS will no longer block the app.

### Windows

Windows SmartScreen will block the installer or executable.

**Option 1 -- Run anyway**

1. On the SmartScreen dialog, click **More info**.
2. Click **Run anyway**.

**Option 2 -- Disable App Install Control**

1. Open **Settings** > **Apps** > **Advanced app settings**.
2. Toggle **App Install Control** (or "Choose where to get apps") to allow apps from anywhere.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org/) (App Router) |
| Desktop shell | [Electron 40](https://www.electronjs.org/) |
| UI components | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com/) |
| Animation | [Motion](https://motion.dev/) (Framer Motion) |
| AI integration | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (embedded, per-user) |
| Markdown | react-markdown + remark-gfm + rehype-raw + [Shiki](https://shiki.style/) |
| Streaming | [Vercel AI SDK](https://sdk.vercel.ai/) helpers + Server-Sent Events |
| Icons | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |
| Testing | [Playwright](https://playwright.dev/) |
| CI/CD | [GitHub Actions](https://github.com/features/actions) (auto-build + release on tag) |
| Build / Pack | electron-builder + esbuild |

---

## Project Structure

```
codepilot/
├── .github/workflows/      # CI/CD: multi-platform build & auto-release
├── electron/                # Electron main process & preload
│   ├── main.ts              # Window creation, embedded server lifecycle
│   └── preload.ts           # Context bridge
├── src/
│   ├── app/                 # Next.js App Router pages & API routes
│   │   ├── chat/            # New-chat page & [id] session page
│   │   ├── extensions/      # Skills + MCP server management
│   │   ├── settings/        # Settings editor
│   │   └── api/             # REST + SSE endpoints
│   │       ├── chat/        # Sessions, messages, streaming, permissions
│   │       ├── files/       # File tree & preview
│   │       ├── plugins/     # Plugin & MCP CRUD
│   │       ├── settings/    # Settings read/write
│   │       ├── skills/      # Skill CRUD
│   │       └── tasks/       # Task tracking
│   ├── components/
│   │   ├── ai-elements/     # Message bubbles, code blocks, tool calls, etc.
│   │   ├── chat/            # ChatView, MessageList, MessageInput, streaming
│   │   ├── layout/          # AppShell, NavRail, ResizeHandle, RightPanel
│   │   ├── plugins/         # MCP server list & editor
│   │   ├── project/         # FileTree, FilePreview, TaskList
│   │   ├── skills/          # SkillsManager, SkillEditor
│   │   └── ui/              # Radix-based primitives (button, dialog, tabs, ...)
│   ├── hooks/               # Custom React hooks (usePanel, ...)
│   ├── lib/                 # Core logic
│   │   ├── claude-client.ts # Agent SDK streaming wrapper
│   │   ├── db.ts            # SQLite schema, migrations, CRUD
│   │   ├── files.ts         # File system helpers
│   │   ├── permission-registry.ts  # Permission request/response bridge
│   │   └── utils.ts         # Shared utilities
│   └── types/               # TypeScript interfaces & API contracts
├── electron-builder.yml     # Packaging configuration
├── package.json
└── tsconfig.json
```

---

## Development

```bash
# Run Next.js dev server only (opens in browser)
npm run dev

# Run the full Electron app in dev mode
# (starts Next.js + waits for it, then opens Electron)
npm run electron:dev

# Production build (Next.js static export)
npm run build

# Build Electron distributable + Next.js
npm run electron:build

# Package for specific platforms
npm run electron:pack:mac     # macOS DMG (arm64 + x64)
npm run electron:pack:win     # Windows NSIS installer
npm run electron:pack:linux   # Linux AppImage, deb, rpm
```

### CI/CD

The project uses GitHub Actions for automated builds. Pushing a `v*` tag triggers a full multi-platform build and automatically creates a GitHub Release with all artifacts:

```bash
git tag v0.8.1
git push origin v0.8.1
# CI builds Windows + macOS + Linux, then publishes the release
```

You can also manually trigger builds for individual platforms from the Actions tab.

### Notes

- The Electron main process (`electron/main.ts`) forks the Next.js standalone server and connects to it over `127.0.0.1` with a random free port.
- Chat data is stored in `~/.codepilot/codepilot.db` (or `./data/codepilot.db` in dev mode).
- The app uses WAL mode for SQLite, so concurrent reads are fast.

---

## Contributing

Contributions are welcome. To get started:

1. Fork the repository and create a feature branch.
2. Install dependencies with `npm install`.
3. Run `npm run electron:dev` to test your changes locally.
4. Make sure `npm run lint` passes before opening a pull request.
5. Open a PR against `main` with a clear description of what changed and why.

Please keep PRs focused -- one feature or fix per pull request.

---

## License

MIT
