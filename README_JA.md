<img src="docs/icon-readme.png" width="32" height="32" alt="CodePilot" style="vertical-align: middle; margin-right: 8px;" /> CodePilot
===

**マルチモデル AI エージェント デスクトップクライアント** -- 任意の AI プロバイダーに接続、MCP & スキルで拡張、スマートフォンからリモート制御、アシスタントがあなたのワークフローを学習。

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Downloads](https://img.shields.io/github/downloads/op7418/CodePilot/total)](https://github.com/op7418/CodePilot/releases)
[![GitHub stars](https://img.shields.io/github/stars/op7418/CodePilot)](https://github.com/op7418/CodePilot/stargazers)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-BSL--1.1-orange)](LICENSE)

[English](./README.md) | [中文文档](./README_CN.md)

![CodePilot](apps/site/public/screenshots/en/chat-window.webp)

<details>
<summary>現在のインターフェース</summary>

| スキルと拡張機能 | AI サービスに接続 |
| --- | --- |
| ![スキルと拡張機能](apps/site/public/screenshots/en/plugins-window.webp) | ![AI サービスに接続](apps/site/public/screenshots/en/providers-window.webp) |

</details>

---

[ダウンロード](#ダウンロード) | [クイックスタート](#クイックスタート) | [ドキュメント](#ドキュメント) | [コントリビュート](#コントリビュート) | [コミュニティ](#コミュニティ)

---

## ダウンロード

| プラットフォーム | ダウンロード | アーキテクチャ |
|---|---|---|
| macOS | [Apple Silicon (.dmg)](https://github.com/op7418/CodePilot/releases/latest) · [Intel (.dmg)](https://github.com/op7418/CodePilot/releases/latest) | arm64 / x64 |
| Windows | [インストーラー (.exe)](https://github.com/op7418/CodePilot/releases/latest) | x64 + arm64 |
| Linux | ソースからビルド | x64 + arm64 |

または [Releases](https://github.com/op7418/CodePilot/releases) ページで全バージョンを確認できます。

---

## CodePilot を選ぶ理由

### マルチプロバイダー、ひとつのインターフェース

**17 以上の AI プロバイダー**にすぐ接続可能。会話の途中でプロバイダーやモデルを切り替えても、コンテキストは維持されます。

| カテゴリ | プロバイダー |
|---|---|
| 直接 API | Anthropic、OpenRouter |
| クラウドプラットフォーム | AWS Bedrock、Google Vertex AI |
| 中国 AI プロバイダー | Zhipu GLM（CN/Global）、Kimi、Moonshot、MiniMax（CN/Global）、Volcengine Ark（Doubao）、Xiaomi MiMo、Aliyun Bailian（Qwen） |
| ローカル & セルフホスト | Ollama、LiteLLM |
| カスタム | 任意の Anthropic 互換または OpenAI 互換エンドポイント |
| メディア | Google Gemini（画像生成） |

### コーディングだけじゃない — フル AI エージェント

CodePilot はコーディングツールとして始まりましたが、**汎用 AI エージェント デスクトップ**へと進化しました：

- **Assistant Workspace** — ペルソナファイル、永続メモリ、Onboarding フロー、デイリーチェックイン。アシスタントがあなたの好みを学び、適応し続けます。
- **ジェネレーティブ UI** — AI がインタラクティブなダッシュボード、チャート、ビジュアルウィジェットを作成し、アプリ内でリアルタイムにレンダリング。
- **リモート Bridge** — Telegram、Feishu、Discord、QQ、WeChat に接続。スマートフォンからメッセージを送り、デスクトップで返答を受け取れます。
- **MCP + スキル** — MCP サーバー（stdio / sse / http）を追加し、ランタイム監視。再利用可能なスキルを定義するか、skills.sh マーケットプレイスからインストール。
- **Media Studio** — AI 画像生成、バッチタスク、ギャラリー、タグ管理。
- **タスクスケジューラー** — cron 式やインターバルベースの永続タスクスケジューリング。

### 日常使いのために設計

- セッションの一時停止、再開、**チェックポイントへの巻き戻し**
- **スプリットスクリーン**で 2 セッションを並行表示
- **トークン使用量とコスト**を日次チャート付きで追跡
- Claude Code CLI セッション履歴のインポート
- ダーク / ライトテーマ切り替え
- English + Chinese インターフェース

---

## クイックスタート

### パス A：リリース版をダウンロード（ほとんどのユーザー向け）

1. 上の[ダウンロード](#ダウンロード)セクションからプラットフォームに合ったインストーラーをダウンロード
2. CodePilot を起動
3. **設定 > プロバイダー**でプロバイダーを設定 — 任意のサポートプロバイダーの API キーを追加
4. 会話を開始

> **メモ:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview)（`npm install -g @anthropic-ai/claude-code`）をインストールすると、ファイルの直接編集、ターミナルコマンド、Git 操作などの追加機能が利用可能になります。推奨ですが、基本的なチャットには必須ではありません。

### パス B：ソースからビルド（開発者向け）

| 前提条件 | 最小バージョン |
|---|---|
| Node.js | 18+ |
| npm | 9+（Node 18 に付属） |

```bash
git clone https://github.com/op7418/CodePilot.git
cd CodePilot
npm install
npm run dev              # ブラウザモード http://localhost:3000
# -- または --
npm run electron:dev     # フルデスクトップアプリ
```

---

## コア機能

### 会話とインタラクション

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
| プロバイダー | 17+ プロバイダー：Anthropic、OpenRouter、Bedrock、Vertex、Zhipu GLM、Kimi、Moonshot、MiniMax、Volcengine、MiMo、Bailian、Ollama、LiteLLM、カスタムエンドポイント |
| MCP サーバー | stdio / sse / http、ランタイム状態監視 |
| スキル | カスタム / プロジェクト / グローバルスキル、skills.sh マーケットプレイス |
| Bridge | Telegram / Feishu / Discord / QQ / WeChat リモート制御 |
| CLI インポート | Claude Code CLI .jsonl セッション履歴のインポート |
| 画像生成 | Gemini 画像生成、バッチタスク、ギャラリー |

### データとワークスペース

| 機能 | 詳細 |
|---|---|
| Assistant Workspace | ペルソナファイル（soul.md、user.md、claude.md、memory.md）、Onboarding、デイリーチェックイン、永続メモリ |
| ジェネレーティブ UI | AI が作成するインタラクティブなダッシュボードとビジュアルウィジェット |
| ファイルブラウザ | プロジェクトファイルツリー、シンタックスハイライトプレビュー |
| Git パネル | ステータス、ブランチ、コミット、Worktree 管理 |
| 使用量分析 | トークン数、コスト見積もり、日次使用量チャート |
| タスクスケジューラー | cron ベースおよびインターバルベースの永続スケジューリング |
| ローカルストレージ | SQLite（WAL モード）、全データはローカルに保存 |
| i18n | English + Chinese |
| テーマ | ダーク / ライト、ワンクリック切り替え |

---

## 初回起動

1. **プロバイダーを設定** — **設定 > プロバイダー**で使用するプロバイダーの認証情報を追加。CodePilot には主要プロバイダーのプリセットが内蔵 — 選んで API キーを入力するだけ。
2. **会話を作成** — 作業ディレクトリ、モード（Code / Plan / Ask）、モデルを選択。
3. **Assistant Workspace を設定**（任意）— **設定 > Assistant** でワークスペースディレクトリを選択し、Onboarding を有効化。CodePilot がワークスペースルートに `soul.md`、`user.md`、`claude.md`、`memory.md` を作成。
4. **MCP サーバーを追加**（任意）— サイドバーの **MCP** ページで MCP サーバーを追加・管理。カスタムスキルは **Skills** ページで管理。
5. **Claude Code CLI をインストール**（任意）— ファイル編集やターミナルコマンドなどの高度な機能には、CLI をインストール: `npm install -g @anthropic-ai/claude-code`

---

## プラットフォームとインストール手順

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
- [初回起動](#初回起動) -- プロバイダー設定、ワークスペースセットアップ
- [インストールガイド](https://www.codepilot.sh/docs/installation) -- 詳細なセットアップ手順

**ユーザーガイド:**
- [プロバイダー](https://www.codepilot.sh/docs/providers) -- AI プロバイダーとカスタムエンドポイントの設定
- [MCP サーバー](https://www.codepilot.sh/docs/mcp) -- Model Context Protocol サーバーの追加と管理
- [スキル](https://www.codepilot.sh/docs/skills) -- カスタムスキル、プロジェクトスキル、skills.sh マーケットプレイス
- [Bridge](https://www.codepilot.sh/docs/bridge) -- Telegram、Feishu、Discord、QQ、WeChat によるリモート制御
- [Assistant Workspace](https://www.codepilot.sh/docs/assistant-workspace) -- ペルソナファイル、Onboarding、メモリ、デイリーチェックイン
- [FAQ](https://www.codepilot.sh/docs/faq) -- よくある質問と解決方法

**開発者ドキュメント:**
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- アーキテクチャ、テックスタック、ディレクトリ構成、データフロー
- [docs/handover/](./docs/handover/) -- 設計決定、引き継ぎドキュメント
- [docs/exec-plans/](./docs/exec-plans/) -- 実行計画、技術的負債トラッカー

---

## FAQ

<details>
<summary>Claude Code CLI は必要ですか？</summary>

不要です。CodePilot は任意のサポートプロバイダー（OpenRouter、Zhipu GLM、Volcengine、Ollama など）で Claude Code CLI なしで使用できます。CLI は Claude にファイルの直接編集、ターミナルコマンド実行、Git 操作を行わせる場合にのみ必要です。チャットやアシスタント機能は、プロバイダーを設定するだけで使えます。
</details>

<details>
<summary>プロバイダーを設定したがモデルが表示されない</summary>

API キーが有効でエンドポイントに到達可能であることを確認してください。一部のプロバイダー（Bedrock、Vertex）では、API キー以外に追加の環境変数や IAM 設定が必要です。内蔵の診断機能（**設定 > プロバイダー > 診断を実行**）で接続性を確認できます。
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

各 Bridge チャンネル（Telegram、Feishu、Discord、QQ、WeChat）には独自の Bot トークンまたはアプリ認証情報が必要です。サイドバーの **Bridge** ページでチャンネルを設定してください。ターゲットプラットフォームで先にボットを作成し、トークンを CodePilot に提供する必要があります。
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
npm run electron:pack:linux    # Linux AppImage, deb, rpm（ローカルビルドのみ — GitHub Release の事前ビルド配布物ではありません）
```

**CI/CD:** `v*` タグをプッシュすると、macOS と Windows のパッケージがビルドされ、GitHub Release が自動的に作成されます。Linux は release ビルドに含まれません — `npm run electron:pack:linux` でローカルにビルドしてください。

**メモ:**
- Electron は `127.0.0.1` 上で Next.js スタンドアロンサーバーをフォークし、ランダムなフリーポートで接続
- チャットデータは `~/.codepilot/codepilot.db`（開発モード: `./data/`）に保存
- SQLite は WAL モードを使用し、同時読み込みが高速
</details>

---

## ライセンス

[Business Source License 1.1 (BSL-1.1)](LICENSE)

- **個人 / 学術 / 非営利利用**: 無料かつ無制限
- **商用利用**: 別途ライセンスが必要 — 連絡先: [@op7418 on X](https://x.com/op7418)
- **変更日**: 2029-03-16 — 以降、Apache 2.0 に移行
