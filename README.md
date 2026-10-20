# Tactiq Live → Claude Code

Tactiqの**会議中の字幕更新**をClaude Codeの**Channels**へ渡し、現在のプロジェクトを踏まえて「今の話・相手の問い・口にできる返答案」を短く出す試作です。グローバルCLIとしてインストールし、各プロジェクトへコードやMCP設定をコピーせずに使えます。**受信先は一度に1プロジェクト**です。

対象：Google Meet／Zoomブラウザ版／Teamsブラウザ版。解析対象のTactiqは **3.1.7185**。Node.js 22以上、Chrome 125以上、Channelsと `--restricted` に対応したClaude Codeが必要です（CLI確認版2.1.302）。検証環境はmacOSです。

> **実会議では未検証です。** ダミー字幕、CLIの隔離インストール、模擬Claudeランチャー、実ローカルHTTP／MCP stdio通信を検証していますが、実Chrome・実Tactiq・Claude Code本体をつないだ動作は別途確認が必要です。

## インストール（初回）

npmレジストリではなく、この公開GitHubリポジトリからインストールします。

```bash
npm install --global --ignore-scripts github:takemo101/tactiq-live-channel
tactiq-live setup
```

`setup` が表示する拡張フォルダ（通常 `~/.tactiq-live-channel/extension`）を、Chromeの `chrome://extensions` → デベロッパーモード →「パッケージ化されていない拡張機能を読み込む」で**一度だけ**読み込みます。

Chrome設定やClaudeのユーザー設定を勝手に変更することはありません。Chrome Web Storeへ公開した拡張ではないため、この初回読み込みは手動です。

## 各プロジェクトで使う

受信したいプロジェクトへ移動して起動します。

```bash
cd /path/to/your-project
tactiq-live claude
```

別ターミナルで、その起動用の新しいペアリングトークンを確認します。

```bash
tactiq-live token
```

**この値をGitHubやチャットへ貼らないでください。** 会議タブのDevTools → `Tactiq Live` パネルへ貼り、会議を確認・選択して、同意確認後に「転送開始」を押します。パネルを開いたまま使ってください。

- 約5秒ごとに確認し、新規・修正差分があるときだけ送ります。
- 開始／再開時点にある発話は修正後も除外し、**次の新しい発話から**転送します。
- Tactiqの一時停止・状態不明では送らず、ページ移動・パネル切替・明示停止で止まります。
- 起動時に会議モードが始まり、必要なプロジェクト資料を読取り専用で確認します。字幕に重要な変化があると短いカードを更新します。5秒ごとのAI応答を保証する機能ではありません。

### 会議中の支援

Skillは [`skills/meeting/SKILL.md`](skills/meeting/SKILL.md) にあります。CLIがその起動だけにpluginとして読み込み、同じファイルを継続支援の指示にも使います。ユーザーの `~/.claude/skills/` や各プロジェクトへコピーしません。

```text
今の話：公開日の相談です。
相手の問い：いつ公開できるか。
返答案：「影響範囲を確認してから、対応できる日程をお伝えします。」
根拠・提案：日程は未確認。先に依存作業を確認しましょう。
```

役割・会議の目的を一言添えると、返答の提案を絞れます。仕様から確認できた事実と推測を区別し、納期や予算を本人に代わって約束しません。相づちだけなら同じ要約を繰り返しません。

- 助言を止める：`/tactiq-live:meeting stop`
- 助言を再開する：`/tactiq-live:meeting start`
- **字幕の転送を止める：Chromeパネルの停止ボタン。助言停止だけでは転送は止まりません。**

Haikuを選ぶ場合は `ANTHROPIC_MODEL=haiku tactiq-live claude` と起動できます。実Haikuでの品質・速度・費用は未検証です。

### プロジェクトを切り替える

1. 補助パネルを停止する。
2. 前の `tactiq-live claude` を終了する。
3. 次のプロジェクトで `tactiq-live claude` を起動する。
4. `tactiq-live token` で**新しい値**を取り直してペアリングする。

使用中のポートやランチャーの排他ファイルがあれば二重起動を拒否します。トークンは起動ごとに更新されるため、古いパネルが前のトークンで新しいプロジェクトへ送ることはできません。

## 安全性と制約

- 受信先は `127.0.0.1:43821` のみ。Bearer認証、Host／Origin、schema、サイズ、順序を検査します。
- トークン・拡張はプロジェクト外の `~/.tactiq-live-channel/` に置きます。トークンは0600、ディレクトリは0700。本文はブリッジのログやファイルへ保存しません。
- **転送した字幕と読取ったプロジェクト資料はClaude Codeを通じてAnthropicへ送信され、会話に残り得ます。** 起動直後から資料を読むため、非機密のプロジェクトを選び、会議参加者同意・組織規程・送信先のデータ取扱いを確認してください。
- 利用ツールは `Read,Glob,Grep,Skill` のみ。`--restricted`、`--strict-mcp-config`、手動承認モードを指定し、編集・Shell・外部送信ツールを有効にしません。hooksとSkillのShell前処理も無効にします。
- ファイルツールを作業ディレクトリ内へ制限し、`.env`・鍵・認証設定・ランタイム保存先等の読取りをdeny設定します。ホーム／filesystem rootからの起動は拒否します。これはOSサンドボックスや全秘密情報の自動検出ではなく、組織のmanaged設定が優先します。実Claudeでの権限拒否は受入確認が必要です。
- 自作Channelsには `--dangerously-load-development-channels server:tactiq-live` の明示的な開発用許可が必要です。ランチャーが渡しますが、Claude側の認証・承認・組織制限を迂回しません。
- Channelsはresearch previewです。Bedrock／GoogleのAgent Platform／Microsoft Foundryは非対応との公式記載があります。
- HTTP 202はSDK通知の書出し成功であり、AIによる受領・理解・応答完了の保証ではありません。
- 非公開のTactiq内部構造に依存します。版更新やframe配置の違いで読めない場合は停止し、認証回避やDOMスクレイピングへ自動fallbackしません。
- 送信済み・送信中のデータは取り消せません。永続キューや再起動をまたぐexactly-once保証はありません。

## 更新・削除

会議の転送とランチャーを止めてから、インストールコマンドを再実行し `tactiq-live setup` を実行します。Chromeの拡張一覧で補助拡張を再読み込みしてください。拡張の保存先は同じなので、プロジェクトごとの再配置は不要です。

```bash
npm uninstall --global tactiq-live-channel
```

アンインストールは `~/.tactiq-live-channel/` とChromeの読み込み登録を自動削除しません。不要なら全プロセス停止後に本人が確認して削除してください。

## 開発・資料

ソースから開発する場合はリポジトリのルートで実行します。

```bash
npm ci --ignore-scripts
npm test
node bin/tactiq-live.js --help
```

- [使い方・CLI・データ形式・動作仕様：SPEC.md](SPEC.md)
- [REAが分析に役立った点と限界](docs/rea-analysis-report.md)
- [会議支援Skill](skills/meeting/SKILL.md)
- [Claude Code Channels](https://code.claude.com/docs/en/channels) / [Channels reference](https://code.claude.com/docs/en/channels-reference)

Tactiq本体、解析JSON、ローカル調査scratch、トークンは配布物に含めません。実会議・実Claudeの受信を確認するまでは、非機密のテスト会議で利用してください。
