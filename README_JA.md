<img src="docs/icon-readme.png" width="32" height="32" alt="CodePilot" style="vertical-align: middle; margin-right: 8px;" /> CodePilot
===

**Claude Code の統合デスクトップクライアント** -- マルチプロバイダー対応、MCP 拡張、カスタムスキル、クロスプラットフォーム Bridge、プロジェクトを理解するアシスタントワークスペース。

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-BSL--1.1-orange)](LICENSE)

[English](./README.md) | [中文文档](./README_CN.md)

![CodePilot](docs/screenshot.png)

---

[ダウンロード](#プラットフォームとインストール) | [クイックスタート](#クイックスタート) | [ドキュメント](#ドキュメント) | [コントリビュート](#コントリビュート) | [コミュニティ](#コミュニティ)

---

## CodePilot を選ぶ理由

**マルチプロバイダー、ひとつのインターフェース。** Anthropic、OpenRouter、Bedrock、Vertex、または任意のカスタムエンドポイントに接続。会話の途中でプロバイダーやモデルを切り替えても、コンテキストは維持されます。

**MCP + Skills で拡張。** MCP サーバー（stdio / sse / http）を追加し、ランタイム状態を監視。再利用可能なプロンプトベースのスキルを定義し、スラッシュコマンドとして呼び出せます。skills.sh からコミュニティスキルを閲覧・インストール可能。

**どこからでも制御。** Bridge で CodePilot を Telegram、Feishu、Discord、QQ に接続。スマートフォンからメッセージを送り、デスクトップで返答を受け取れます。

**プロジェクトを理解するアシスタント。** ワークスペースディレクトリにペルソナファイル（soul.md、user.md）、ルール（claude.md）、永続メモリ（memory.md）を配置。Claude はこれらを使い、プロジェクトの慣例に適応します。Onboarding フローやデイリーチェックインにも対応。

**日常使いのために設計。** セッションの一時停止、再開、チェックポイントへの巻き戻し。スプリットスクリーンで 2 つの会話を並行実行。トークン使用量の追跡。CLI セッション履歴のインポート。ダーク / ライトテーマ。

---

## クイックスタート

### パス A: リリース版をダウンロード（ほとんどのユーザー向け）

1. Claude Code CLI をインストール: `npm install -g @anthropic-ai/claude-code`
2. 認証: `claude login`
3. [Releases](https://github.com/op7418/CodePilot/releases) ページからプラットフォームに合ったインストーラーをダウンロード
4. CodePilot を起動

### パス B: ソースからビルド（開発者向け）

| 前提条件 | 最小バージョン |
|---|---|
| Node.js | 18+ |
| Claude Code CLI | インストール済みおよび認証済み |
| npm | 9+ (Node 18 に付属) |

```bash
git clone https://github.com/op7418/CodePilot.git
cd CodePilot
npm install
npm run dev              # ブラウザモード http://localhost:3000
# -- または --
npm run electron:dev     # フルデスクトップアプリ
```

---

## 初回起動

1. **Claude を認証** -- ターミナルで `claude login` を実行。
2. **プロバイダーを設定** -- Anthropic のみ使用する場合（CLI 認証または `ANTHROPIC_API_KEY`）、プロバイダー設定は不要。OpenRouter、Bedrock、Vertex、カスタムエンドポイントを使用する場合は、先に **設定 > Providers** で認証情報を追加。
3. **会話を作成** -- 作業ディレクトリ、モード（Code / Plan / Ask）、モデルを選択。
4. **Assistant Workspace を設定**（任意）-- **設定 > Assistant** でワークスペースディレクトリを選択し、Onboarding を有効化。CodePilot がワークスペースルートに `soul.md`、`user.md`、`claude.md`、`memory.md` を作成（状態は `.assistant/` サブディレクトリに保存）。
5. **MCP サーバーを追加**（任意）-- サイドバーの **MCP** ページで MCP サーバーを追加・管理。カスタムスキルは **Skills** ページで管理。

---

## コア機能

### 会話とコーディング

| 機能 | 詳細 |
|---|---|
| インタラクションモード | Code / Plan / Ask |
| 推論レベル | Low / Medium / High / Max + Thinking モード |
| 権限制御 | Default / Full Access、アクション単位の承認 |
| セッション制御 | 一時停止、再開、チェックポイントへの巻き戻し、アーカイブ |
| モデル切り替え | 会話中にモデルを変更 |
| スプリットスクリーン | 2 つのセッションを並べて表示 |
| 添付ファイル | ファイルと画像、マルチモーダルビジョン対応 |
| スラッシュコマンド | /help /clear /cost /compact /doctor /review など |

### 拡張と統合

| 機能 | 詳細 |
|---|---|
| プロバイダー | Anthropic / OpenRouter / Bedrock / Vertex / カスタムエンドポイント |
| MCP サーバー | stdio / sse / http、ランタイム状態監視 |
| スキル | カスタム / プロジェクト / グローバルスキル、skills.sh マーケットプレイス |
| Bridge | Telegram / Feishu / Discord / QQ リモート制御 |
| CLI インポート | Claude Code CLI .jsonl セッション履歴のインポート |
| 画像生成 | Gemini / Anthropic 画像生成、バッチタスク、ギャラリー |

### データとワークスペース

| 機能 | 詳細 |
|---|---|
| Assistant Workspace | ワークスペースルートファイル（soul.md、user.md、claude.md、memory.md）、.assistant/ 状態、Onboarding、チェックイン |
| ファイルブラウザ | プロジェクトファイルツリー、シンタックスハイライトプレビュー |
| 使用量分析 | トークン数、コスト見積もり、日次使用量チャート |
| ローカルストレージ | SQLite（WAL モード）、全データはローカルに保存 |
| i18n | English + Chinese |
| テーマ | ダーク / ライト、ワンクリック切り替え |

---

## プラットフォームとインストール

| プラットフォーム | フォーマット | アーキテクチャ |
|---|---|---|
| macOS | .dmg | arm64 (Apple Silicon) + x64 (Intel) |
| Windows | .exe (NSIS) | x64 + arm64 |
| Linux | .AppImage / .deb / .rpm | x64 + arm64 |

[Releases](https://github.com/op7418/CodePilot/releases) ページからダウンロードしてください。

macOS ビルドは Developer ID 証明書で署名済みですが、公証（notarize）は行われていないため、Gatekeeper が初回起動時に警告を表示する場合があります。Windows と Linux ビルドは未署名です。

<details>
<summary>macOS: Gatekeeper の初回起動時警告</summary>

**オプション 1** -- Finder で `CodePilot.app` を右クリック > 開く > 確認。

**オプション 2** -- システム設定 > プライバシーとセキュリティ > セキュリティまでスクロール >「このまま開く」をクリック。

**オプション 3** -- ターミナルで実行:
```bash
xattr -cr /Applications/CodePilot.app
```
</details>

<details>
<summary>Windows: SmartScreen がインストーラーをブロック</summary>

**オプション 1** -- SmartScreen ダイアログで「詳細情報」をクリック、次に「実行を続ける」。

**オプション 2** -- 設定 > アプリ > 詳細アプリ設定 > アプリインストール制御をどこからでも許可に設定。
</details>

---

## ドキュメント

📖 **完全ドキュメント:** [English](https://www.codepilot.sh/docs) | [中文](https://www.codepilot.sh/zh/docs)

**はじめに:**
- [クイックスタート](#クイックスタート) -- ダウンロードまたはソースからビルド
- [初回起動](#初回起動) -- 認証、プロバイダー設定、ワークスペースセットアップ
- [インストールガイド](https://www.codepilot.sh/docs/installation) -- 詳細なセットアップ手順

**ユーザーガイド:**
- [Providers](https://www.codepilot.sh/docs/providers) -- Anthropic、OpenRouter、Bedrock、Vertex、カスタムエンドポイントの設定
- [MCP サーバー](https://www.codepilot.sh/docs/mcp) -- Model Context Protocol サーバーの追加と管理
- [Skills](https://www.codepilot.sh/docs/skills) -- カスタムスキル、プロジェクトスキル、skills.sh マーケットプレイス
- [Bridge](https://www.codepilot.sh/docs/bridge) -- Telegram、Feishu、Discord、QQ によるリモート制御
- [Assistant Workspace](https://www.codepilot.sh/docs/assistant-workspace) -- ペルソナファイル、Onboarding、メモリ、デイリーチェックイン
- [FAQ](https://www.codepilot.sh/docs/faq) -- よくある質問と解決方法

**開発者ドキュメント:**
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- アーキテクチャ、テックスタック、ディレクトリ構成、データフロー
- [docs/handover/](./docs/handover/) -- 設計決定、引き継ぎドキュメント
- [docs/exec-plans/](./docs/exec-plans/) -- 実行計画、技術的負債トラッカー

---

## FAQ

<details>
<summary><code>claude</code> コマンドが見つからない</summary>

Claude Code CLI をグローバルにインストール:
```bash
npm install -g @anthropic-ai/claude-code
```
`claude login` で認証を完了し、`claude --version` が動作することを確認してから CodePilot を起動してください。
</details>

<details>
<summary>プロバイダーを設定したがモデルが表示されない</summary>

API キーが有効でエンドポイントに到達可能であることを確認してください。一部のプロバイダー（Bedrock、Vertex）では、API キー以外に追加の環境変数や IAM 設定が必要です。
</details>

<details>
<summary><code>npm run dev</code> と <code>npm run electron:dev</code> の違い</summary>

`npm run dev` は Next.js 開発サーバーのみを起動し、ブラウザで `http://localhost:3000` を使用します。`npm run electron:dev` は Next.js と Electron シェルの両方を起動し、ネイティブウィンドウコントロールを含むフルデスクトップアプリを提供します。
</details>

<details>
<summary>ワークスペースファイルの場所</summary>

ワークスペース設定後、CodePilot は**ワークスペースルートディレクトリ**に 4 つの Markdown ファイルを作成: `soul.md`（パーソナリティ）、`user.md`（ユーザープロファイル）、`claude.md`（ルール）、`memory.md`（長期メモ）。状態管理（Onboarding 進捗、チェックイン日付）は `.assistant/` サブディレクトリに保存。デイリーメモリは `memory/daily/` に保存。
</details>

<details>
<summary>Bridge にはプラットフォームごとの追加設定が必要</summary>

各 Bridge チャンネル（Telegram、Feishu、Discord、QQ）には独自の Bot トークンまたはアプリ認証情報が必要です。サイドバーの **Bridge** ページでチャンネルを設定してください。
</details>

---

## コミュニティ

- [GitHub Issues](https://github.com/op7418/CodePilot/issues) -- バグ報告と機能リクエスト
- [GitHub Discussions](https://github.com/op7418/CodePilot/discussions) -- 質問と一般的なディスカッション

---

## コントリビュート

1. リポジトリをフォークしてフィーチャーブランチを作成
2. `npm install` と `npm run electron:dev` でローカル開発
3. PR を開く前に `npm run test` を実行
4. `main` に対して明確な説明付きの PR を提出

PR はフォーカスを保つ -- 1 つのフィーチャーまたは修正ごとに 1 つの PR。

<details>
<summary>開発コマンド</summary>

```bash
npm run dev                    # Next.js 開発サーバー（ブラウザ）
npm run electron:dev           # フル Electron アプリ（開発モード）
npm run build                  # 本番ビルド
npm run electron:build         # Electron 配布ファイルをビルド
npm run electron:pack:mac      # macOS DMG (arm64 + x64)
npm run electron:pack:win      # Windows NSIS インストーラー
npm run electron:pack:linux    # Linux AppImage, deb, rpm
```

**CI/CD:** `v*` タグをプッシュすると、全プラットフォームビルドが自動的にトリガーされ、GitHub Release が作成されます。

**メモ:**
- Electron は `127.0.0.1` 上で Next.js スタンドアロンサーバーをフォークし、ランダムなフリーポートで接続
- チャットデータは `~/.codepilot/codepilot.db`（開発モード: `./data/`）に保存
- SQLite は WAL モードを使用し、同時読み込みが高速
</details>

---

## ライセンス

MIT
