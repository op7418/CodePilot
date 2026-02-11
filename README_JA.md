<img src="docs/icon-readme.png" width="32" height="32" alt="CodePilot" style="vertical-align: middle; margin-right: 8px;" /> CodePilot
===

**Claude Code のネイティブ デスクトップ GUI** -- ターミナルではなく、洗練されたビジュアルインターフェースを通じてチャット、コーディング、プロジェクト管理を行えます。

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](./README.md) | [中文文档](./README_CN.md)

---

## 機能

- **💬 会話型コーディング** -- Claude からのレスポンスをリアルタイムでストリーミング受信します。完全な Markdown レンダリング、シンタックスハイライトされたコードブロック、ツール呼び出しの可視化に対応しています。
- **📂 セッション管理** -- チャットセッションの作成、名前変更、アーカイブ、再開ができます。会話は SQLite にローカル保存されるため、再起動後もデータが失われません。
- **🎯 プロジェクト対応コンテキスト** -- セッションごとに作業ディレクトリを指定できます。右パネルにはライブファイルツリーとファイルプレビューが表示されるため、Claude が何を見ているかが常にわかります。
- **🔒 権限制御** -- ツール使用をアクション単位で承認、拒否、または自動許可できます。お好みに応じて権限モードを選択できます。
- **🎭 複数の相互作用モード** -- *Code*、*Plan*、*Ask* モード間で切り替えて、各セッションで Claude の動作を制御できます。
- **🤖 モデルセレクター** -- 会話中に Claude モデル（Opus、Sonnet、Haiku）を切り替えられます。
- **🔌 MCP サーバー管理** -- Model Context Protocol サーバーをエクステンション ページから直接追加、設定、削除できます。`stdio`、`sse`、`http` トランスポート型に対応しています。
- **⚡ カスタムスキル** -- スラッシュコマンドとして呼び出し可能な、再利用可能なプロンプトベースのスキル（グローバルまたはプロジェクト単位）を定義できます。
- **⚙️ 設定エディター** -- `~/.claude/settings.json` のビジュアルエディターと JSON エディター。権限と環境変数の設定に対応しています。
- **📊 トークン使用量追跡** -- アシスタントのレスポンスごとに入力/出力トークン数と推定コストが表示されます。
- **🌗 ダーク / ライト テーマ** -- ナビゲーションレールのワンクリックでテーマを切り替えられます。
- **⌨️ スラッシュコマンド** -- `/help`、`/clear`、`/cost`、`/compact`、`/doctor`、`/review` などの組み込みコマンドを使用できます。
- **🖥️ Electron パッケージング** -- 隠れたタイトルバー、バンドルされた Next.js サーバー、自動ポート割り当てを備えたネイティブ デスクトップ アプリとして配布されます。

---

## スクリーンショット

![CodePilot](docs/screenshot.png)

---

## 前提条件

> **重要**: CodePilot は Claude Code Agent SDK を内部で呼び出します。アプリを起動する前に、`claude` が `PATH` で利用可能であることを確認し、認証済み (`claude login`) であることを確認してください。

| 要件 | 最小バージョン |
|---|---|
| **Node.js** | 18+ |
| **Claude Code CLI** | インストール済みおよび認証済み (`claude --version` が動作することを確認) |
| **npm** | 9+ (Node 18 に付属) |

---

## ダウンロード

プリビルド版のリリースは [**Releases**](https://github.com/op7418/CodePilot/releases) ページから利用できます。

### サポートプラットフォーム

- **macOS**: ユニバーサルバイナリ（arm64 + x64）を `.dmg` として配布
- **Windows**: x64 を `.zip` として配布
- **Linux**: x64 と arm64 を `.AppImage`、`.deb`、`.rpm` として配布

---

## クイックスタート

```bash
# リポジトリのクローン
git clone https://github.com/op7418/CodePilot.git
cd codepilot

# 依存関係のインストール
npm install

# 開発モードで起動（ブラウザ）
npm run dev

# -- または、開発モードで完全な Electron アプリを起動 --
npm run electron:dev
```

その後、[http://localhost:3000](http://localhost:3000)（ブラウザモード）を開くか、Electron ウィンドウが表示されるまで待ちます。

---

## インストールのトラブルシューティング

CodePilot はまだコード署名されていないため、初回起動時にオペレーティングシステムがセキュリティ警告を表示します。

### macOS

**「Apple はこのソフトウェアを確認できません」** というダイアログが表示されます。

**オプション 1 -- 右クリックで開く**

1. Finder で `CodePilot.app` を右クリック（または Control キーを押しながらクリック）します。
2. コンテキストメニューから **開く** を選択します。
3. 確認ダイアログで **開く** をクリックします。

**オプション 2 -- システム設定**

1. **システム設定** > **プライバシーとセキュリティ** を開きます。
2. **セキュリティ** セクションまでスクロールします。
3. CodePilot がブロックされているというメッセージが表示されます。**このまま開く** をクリックします。
4. 必要に応じて認証を行い、アプリを起動します。

**オプション 3 -- ターミナルコマンド**

```bash
xattr -cr /Applications/CodePilot.app
```

これは隔離属性を削除するため、macOS はアプリをブロックしなくなります。

### Windows

Windows SmartScreen はインストーラーまたは実行ファイルをブロックします。

**オプション 1 -- 実行を続ける**

1. SmartScreen ダイアログで **詳細情報** をクリックします。
2. **実行を続ける** をクリックします。

**オプション 2 -- アプリインストール制御を無効にする**

1. **設定** > **アプリ** > **詳細アプリ設定** を開きます。
2. **アプリインストール制御**（または「アプリの取得元」）をトグルして、どこからでもアプリをインストール可能にします。

---

## テック スタック

| レイヤー | テクノロジー |
|---|---|
| フレームワーク | [Next.js 16](https://nextjs.org/)（App Router） |
| デスクトップシェル | [Electron 40](https://www.electronjs.org/) |
| UI コンポーネント | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| スタイリング | [Tailwind CSS 4](https://tailwindcss.com/) |
| アニメーション | [Motion](https://motion.dev/)（Framer Motion） |
| AI 統合 | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| データベース | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（組み込み、ユーザーごと） |
| Markdown | react-markdown + remark-gfm + rehype-raw + [Shiki](https://shiki.style/) |
| ストリーミング | [Vercel AI SDK](https://sdk.vercel.ai/) ヘルパー + Server-Sent Events |
| アイコン | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |
| テスト | [Playwright](https://playwright.dev/) |
| ビルド / パック | electron-builder + esbuild |

---

## プロジェクト構成

```
codepilot/
├── electron/                # Electron メインプロセス＆プリロード
│   ├── main.ts              # ウィンドウ作成、組み込みサーバーライフサイクル
│   └── preload.ts           # コンテキスト ブリッジ
├── src/
│   ├── app/                 # Next.js App Router ページ＆ API ルート
│   │   ├── chat/            # 新規チャットページ＆ [id] セッションページ
│   │   ├── extensions/      # スキル＋ MCP サーバー管理
│   │   ├── settings/        # 設定エディター
│   │   └── api/             # REST ＋ SSE エンドポイント
│   │       ├── chat/        # セッション、メッセージ、ストリーミング、権限
│   │       ├── files/       # ファイルツリー＆プレビュー
│   │       ├── plugins/     # プラグイン＆ MCP CRUD
│   │       ├── settings/    # 設定の読み書き
│   │       ├── skills/      # スキル CRUD
│   │       └── tasks/       # タスク追跡
│   ├── components/
│   │   ├── ai-elements/     # メッセージバブル、コードブロック、ツール呼び出しなど
│   │   ├── chat/            # ChatView、MessageList、MessageInput、ストリーミング
│   │   ├── layout/          # AppShell、NavRail、Header、RightPanel
│   │   ├── plugins/         # MCP サーバーリスト＆エディター
│   │   ├── project/         # FileTree、FilePreview、TaskList
│   │   ├── skills/          # SkillsManager、SkillEditor
│   │   └── ui/              # Radix ベースのプリミティブ（button、dialog、tabs など）
│   ├── hooks/               # カスタム React フック（usePanel など）
│   ├── lib/                 # コアロジック
│   │   ├── claude-client.ts # Agent SDK ストリーミングラッパー
│   │   ├── db.ts            # SQLite スキーマ、マイグレーション、CRUD
│   │   ├── files.ts         # ファイルシステムヘルパー
│   │   ├── permission-registry.ts  # 権限リクエスト/レスポンスブリッジ
│   │   └── utils.ts         # 共有ユーティリティ
│   └── types/               # TypeScript インターフェース＆ API コントラクト
├── electron-builder.yml     # パッケージング設定
├── package.json
└── tsconfig.json
```

---

## 開発

```bash
# Next.js 開発サーバーのみを実行（ブラウザで開く）
npm run dev

# 開発モードで完全な Electron アプリを実行
# (Next.js を起動して待機し、その後 Electron を開く)
npm run electron:dev

# 本番環境ビルド（Next.js 静的エクスポート）
npm run build

# Electron 配布可能ファイルと Next.js をビルド
npm run electron:build

# macOS DMG をパッケージ（ユニバーサルバイナリ）
npm run electron:pack
```

### メモ

- Electron メインプロセス（`electron/main.ts`）は Next.js スタンドアロン サーバーをフォークし、`127.0.0.1` 経由でランダムなフリーポートで接続します。
- チャット データは `~/.codepilot/codepilot.db`（または開発モードでは `./data/codepilot.db`）に保存されます。
- アプリは SQLite の WAL モードを使用するため、同時読み込みは高速です。

---

## 貢献

貢献を歓迎します。開始するには：

1. リポジトリをフォークしてフィーチャーブランチを作成します。
2. `npm install` で依存関係をインストールします。
3. `npm run electron:dev` を実行して、変更をローカルでテストします。
4. プルリクエストを開く前に `npm run lint` が成功することを確認します。
5. 変更内容と理由を明確に説明した PR を `main` に対して開きます。

PR はフォーカスを保つようにしてください -- 1 つのフィーチャーまたは修正ごとに 1 つの PR を開いてください。

---

## ライセンス

MIT
