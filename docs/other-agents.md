# Claude Code 以外のエージェントで使う（omp・pi・agy）

Chrome拡張は、字幕を `127.0.0.1:43821` の受信口へ送るだけで、どのエージェントにも依存しません。エージェントごとに違うのは、受信した字幕を**セッションへ渡す方法**です。`live-support agents` で一覧、`live-support agents <name>`（name は claude・omp・pi・agy）で、手元のパスを入れたコマンドを確認できます（何も書き込みません）。

| エージェント | 方式 | 渡し方 | 確認した範囲（2026-10-21、合成の字幕のみ） |
| --- | --- | --- | --- |
| Claude Code | MCPのChannels | `live-support claude`（読取り専用の制限つき起動） | 実Claude Codeは未確認（既存の試験） |
| omp | 拡張（push） | 字幕が `followUp` のメッセージになり、ターンが始まる | 実 omp 18.12.5：`--mode rpc` で、HTTP POST → 202 → `live-support` のメッセージ → モデルのターン開始。終了で受信口が閉じることも確認 |
| pi | 同じ拡張（push） | 同上 | 実 pi 1.3.0：同じ手順で同じ結果を確認 |
| agy | MCPのツール（pull） | エージェントが `get_captions` を繰り返し呼ぶ | 実 agy 1.4.3：`.agents/mcp_config.json` のサーバーを起動し、モデルがMCPツールを呼ぼうとした。ヘッドレスでは `mcp` の許可が要るため、字幕の取得までは**未確認**（下記の許可ルールが必要） |

## omp と pi（push）

```bash
omp -e <repo>/integrations/pi/live-support.js --append-system-prompt <repo>/skills/meeting/SKILL.md
pi  -e <repo>/integrations/pi/live-support.js --append-system-prompt <repo>/skills/meeting/SKILL.md
```

- 拡張はセッションの開始時に、エージェントの**中で**受信口を開きます（MCPサーバーも別プロセスもありません）。終了時に閉じます。
- ペアリングトークンは起動のたびに更新します（`live-support claude` と同じ）。`live-support token` で確認して、Chromeのパネルへ貼ります。
- 最初のメッセージに、字幕の扱い方（非信頼のデータ、字幕は不完全、など）の説明を付けます。会議支援の書式と本人の除外は `skills/meeting/SKILL.md` に従うので、`--append-system-prompt` で渡してください。
- `/live-support` で、受信口の状態と、このセッションへ渡した件数を表示します。
- 同じプロセスの子セッションは、受信口を二重に開かず、親が閉じるまで親のものを使います。
- ポート 43821 が使用中なら、起動時に通知して、受信口は開きません（セッションは続きます）。`LIVE_SUPPORT_PORT` で変えられますが、パネルは 43821 固定です。

## agy（pull）

agy にはセッションへ外部のメッセージを押し込む仕組みが見つからなかったため、MCPのツールで取りに行く方式にしています。

1. プロジェクトの `.agents/mcp_config.json`：

   ```json
   { "mcpServers": { "live-support": { "command": "node", "args": ["<repo>/server/main.js"], "env": { "LIVE_SUPPORT_TOOLS": "1" } } } }
   ```

2. `~/.gemini/antigravity-cli/settings.json` に許可ルールを足します（ヘッドレスでは確認を出せません）。ご自身の設定なので、自動では書き換えません。

   ```json
   { "permissions": { "allow": ["mcp(live-support/get_captions)"] } }
   ```

3. agy に、`get_captions` を繰り返し呼ぶよう頼みます（返ってきた `cursor` を `after` に渡す）。トークンは `live-support token`。

`LIVE_SUPPORT_TOOLS=1` のとき、サーバーはChannelsの通知を送らず、最新200件までのバッチを保持して `get_captions` で返します（1回に約200KBまで。残りは `more: true`）。このオプションなしの挙動（Claude Code用）は変わりません。

## 画面のスクリーンショット

パネルの「スクリーンショットも送る」がONなら、字幕の更新（omp・pi は届くメッセージ、agy は `get_captions` の結果）に `screenshot`（JPEGの絶対パス）が付くことがあります。エージェントがそのファイルを読めれば使えます。omp・pi は通常そのまま読めます。agy は、`~/.live-support-screens` をワークスペースに足してください（`agy --add-dir ~/.live-support-screens`）。Claude Code は `live-support claude` が `--add-dir` で渡します。実エージェントでの画像の読取りは未確認です。

## 共通の注意

- **Claude Code用の読取り専用の制限（ツールの限定、`--restricted`）は、他のエージェントでは再現していません。** 各エージェントの権限・ツールの設定で絞ってください。字幕は非信頼のデータで、プロンプトインジェクションの保証はありません。
- 受信口は一度に1つです（ポート 43821）。Claude Code と同時には使えません。
- リアルタイムの助言は、エージェントがターンを実行できる間だけです。agy は、エージェントが `get_captions` を呼ぶ間隔次第です。
- 会議の相手の表示名と字幕は、使うエージェントのモデル提供元へ送られます。
