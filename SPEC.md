# Tactiq Live → Claude Code：使い方と仕様

バージョン：0.3.1。最終更新：2026-10-19。

> **手動導入前の試作です。** ダミーデータ、Chrome API境界の模擬、実ローカルHTTP／MCP stdio通信は自動テスト済みですが、実Chrome・実Tactiq・実Claude Codeをつないだ動作は未検証です。実会議で利用可能と判断する前に、非機密のテスト会議で確認してください。

## 1. 目的・機能範囲

Tactiqが処理した会議中の字幕を、明示的に選択したClaude Codeセッションへ逐次渡します。字幕を運ぶ**入力経路**と、現在のプロジェクトを参照して会話理解・返答を助ける**会議Skill**を分けて提供します。

### 実装している機能

- GitHubからグローバルインストールし、各プロジェクトで同じCLIを利用する。受信先は一度に1プロジェクト。
- 選択した一つの会議の、新規発話と発話修正の取得。
- 約5秒ごとの確認。差分がなければ送信しない。
- 明示開始・停止、Tactiq一時停止への追従、ページ移動・DevToolsパネル切替時の停止。
- 認証付きローカルHTTP、一方向のClaude Code Channels通知。
- 未確認バッチの再送と、プロセス内の重複通知抑止。
- `skills/meeting/SKILL.md` による継続支援。今の話、相手の問い、口にできる返答案、必要な根拠・確認・提案を短く表示する。
- Read／Glob／Grepによる関連プロジェクト資料の参照。編集・Shell・追加の外部送信ツールは無効。

### 実装していない機能

- 音声の録音・音声認識。文字起こしはTactiq側が担当する。
- デスクトップ版Zoom／Teams、過去会議の一括読取り、翻訳・画像・ページリンク・チャットの転送。
- 任意の既存Claude Codeセッションへの入力。channelを有効にして起動したセッションが必要。
- 定時の自動要約ジョブ、会議相手への自動送信・代返、コード変更・コマンド実行。
- 永続キュー、再起動をまたぐexactly-once配送、AIによる受領確認。

CLIの初期ユーザー依頼で会議サポートを開始します。読み込めた資料の事実・推測・未確認を分け、未確認の納期や予算を確約しない方針です。字幕や資料の中の命令をツール操作や権限承認として扱ってはいけません。Skillはモデルへの指示であり、回答精度や完全なプロンプトインジェクション防御の保証ではありません。

## 2. 動作条件

| 項目 | 条件 |
| --- | --- |
| Node.js | 22以上。ローカル検証は24.15.0 |
| Chrome | 125以上。DevToolsを利用 |
| Tactiq | Chrome拡張が対象タブで動作中。解析対象版は3.1.7185 |
| Claude Code | Channels・`--restricted`・セッションplugin・Skill Shell前処理無効化に対応する版。CLI確認版は2.1.302 |
| Claude認証 | Channelsが利用できるAnthropic認証・組織設定 |
| ネットワーク | `127.0.0.1:43821` が使用可能 |
| OS | 権限0700／0600とsymlink拒否を使う。検証環境はmacOS |

Claude Code Channelsはresearch previewです。公式資料ではBedrock、Google CloudのAgent Platform、Microsoft Foundryは非対応で、組織アカウントでは管理者の有効化が必要な場合があります。提供条件は変更され得ます。

### 読取り対象のhost

- Google Meet：`meet.google.com`
- Zoom：`zoom.us` とそのサブドメイン
- Teams：`teams.microsoft.com`、`teams.live.com`、`teams.cloud.microsoft`

検査対象のtop frameのみを読みます。別iframeへの自動探索はしません。各サービスを対象として実装していますが、実サービスでの互換性は未確認です。

## 3. 初回セットアップ

### 3.1 CLIを一度インストールする

Node.jsとClaude Codeを本人が用意した環境で実行します。npmレジストリではなく公開GitHubリポジトリから取得します。

```bash
npm install --global --ignore-scripts github:takemo101/tactiq-live-channel
tactiq-live setup
```

`setup` はユーザー専用の `~/.tactiq-live-channel/extension` に補助拡張を配置し、そのパスを表示します。Chromeの設定・Claudeのグローバル設定は自動変更しません。Tactiq本体やREAは通常起動の依存関係ではありません。

ビルド・bundling・install scriptは不要です。配布物はbin、server、extension、skills、`.claude-plugin`と公開ドキュメントに限定し、実行データ・第三者配布物・解析scratchは含めません。

ソースをcloneした環境では、Node.js／npmとjustを用意し、`just install` でも導入できます。`npm install --global --ignore-scripts --install-links .` でcheckoutから独立したコピーを配置し、インストール先CLIの `setup` を実行します。`just uninstall` はnpmグローバルCLIのみ削除し、ランタイム保存先とChrome登録は保持します。インストールが失敗した場合はsetupへ進みません。justfileはdotenvを自動読込みしません。

### 3.2 任意のプロジェクトでClaude Codeを起動する

```bash
cd /path/to/your-project
tactiq-live claude
```

CLIは作業ディレクトリを保ったまま、インストールされたNodeとserverの絶対パスからMCP設定を組み立て、その起動だけに渡します。各プロジェクトへMCP設定やコードをコピーする必要はありません。内部では次のflagを付けます。

- `--strict-mcp-config`：指定外のMCP設定を読み込まない。
- `--tools Read,Glob,Grep,Skill`：参照とSkillだけを公開。編集・Bash・WebFetch・外部送信等を公開しない。
- `--restricted`：コード実行ツール等を除き、ファイルツールを作業ディレクトリ内へ制限。user／project／localのsettingsは読み込まない。managed設定とCLIのsettingsは引き続き適用される。
- `--permission-mode manual`：bypassを使わず、必要な承認は本人へ。組織の拒否を迂回しない。
- `--settings`：hooksとSkillのShell前処理を無効化。`permissions.blockReadsOutsideWorkingDirectories`を有効にし、.env、鍵、.git／.ssh／.aws／.claude、認証設定、実ランタイム保存先をRead denyにする。
- `--plugin-dir <インストール先>`：このセッションだけに `.claude-plugin/plugin.json` と `skills/meeting/SKILL.md` を読み込む。グローバルSkillsやプロジェクトへコピーしない。
- `--append-system-prompt-file <Skillの絶対パス>`：同じSkillを常設方針として追加し、初期ユーザー依頼で会議モードを開始。字幕からの自動Skill呼出しには依存しない。
- `--dangerously-load-development-channels`：自作channelを試すための明示的な開発用許可。認証・ツール権限の迂回のためには使わない。可変長のchannel指定と開始プロンプトは `--` で区切り、開始文がchannel名へ吸収されないようにする。

ホーム／filesystem rootをプロジェクトとして起動することは拒否します。これらのflagはOSサンドボックスではありません。ファイルに埋め込まれた秘密を完全に検出する機能もないため、読み取ってよいプロジェクトでのみ使い、managed設定と実際の拒否動作を受入確認してください。

モデルの選択は既存環境変数を引き継ぎます。例：`ANTHROPIC_MODEL=haiku tactiq-live claude`。実Haikuでの精度・速度・費用は未確認です。

起動時の承認や組織ポリシーに従い、`tactiq-live` が**channelとして有効**なことを確認してください。通常のMCP接続成功だけではpush通知を受け取れるとは限りません。

サーバーはこのClaudeプロセスに起動させます。別途サーバーを起動する必要はありません。受信port使用中、または別ランチャーの排他ファイルがある場合は起動を拒否します。通常終了・扱える終了signalでは子プロセス終了を待ち、排他ファイルを解除します。

同時に複数プロジェクトへ配信する機能はありません。プロジェクト切替は、パネル停止 → 前のランチャー終了 → 次のプロジェクトで起動 → 新トークンで再ペアリング、の順に行います。

ソースの `mcp.local.json` は開発用です。通常利用はCLIを使ってください。直接serverを起動すると、CLIの排他・起動ごとのtoken更新は適用されません。

### 3.3 ペアリングトークンを確認する

ランチャー起動後、別ターミナルで実行します。

```bash
tactiq-live token
```

- 保存先は `~/.tactiq-live-channel/token`。プロジェクト外に置く。
- ディレクトリ0700、ファイル0600。symlinkや公開権限のファイルは拒否する。
- `claude` 起動ごとに新しいtokenへ原子的に置換する。前のパネルのtokenは新しい受信先で認証されない。
- `setup`／`token` は既存の正しいtokenを再利用し、勝手にローテーションしない。
- `token` サブコマンドは値をローカル標準出力へ明示表示する。それ以外の通常ログへは出さない。

起動ごとに新しい値をパネルへ貼り付けます。**GitHub、チャット、スクリーンショットへ載せないでください。**

### 3.4 補助Chrome拡張を読み込む

1. Chromeで `chrome://extensions` を開く。
2. デベロッパーモードを有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」から、`tactiq-live setup` が表示したフォルダ（通常 `~/.tactiq-live-channel/extension`）を選ぶ。
4. 既に開いているDevToolsは一度閉じて開き直す。

補助拡張はTactiqとは別の拡張です。Tactiqのインストールや設定を変更しません。初回読込みは手動で、以後プロジェクトごとの読込み直しは不要です。

### 3.5 更新・削除

転送とClaudeランチャーを停止してからインストールコマンドを再実行し、`tactiq-live setup` とChrome拡張の再読み込みを行います。拡張の保存先は変わりません。

```bash
npm uninstall --global tactiq-live-channel
```

アンインストールはユーザーディレクトリやChromeの登録を自動削除しません。不要な場合は、全プロセス停止後に本人が確認して削除します。

## 4. 会議での操作

### 開始

1. 会議参加者の同意、組織規程、Claude／Anthropic側のデータ取扱いを確認する。
2. 会議をChromeで開き、Tactiqの文字起こしが動いていることを確認する。
3. **その会議タブ**でDevToolsを開き、`Tactiq Live` パネルを選ぶ。見えなければ `»` メニューを確認する。
4. `tactiq-live token` で得た今回の起動用tokenを貼り付ける。ブラウザの永続storageには保存しない。
5. 「Tactiqの会議を確認」を押し、対象会議を選ぶ。
6. 同意確認にチェックし、「Claude Codeへ転送開始」を押す。
7. 接続成功後、**次の新しい発話から**転送される。

開始時点に存在する発話IDは、その後に修正されても転送しません。開始前の本文が修正版に混ざるのを防ぐためです。進行中の発話の続きが最初の数秒届かない場合があります。

転送開始後の本文と、Claudeが読取ったプロジェクト資料は、Claude Codeを通じて**Anthropicへ送られます**。資料読取りは起動直後から始まるため、先に参照範囲を確認してください。ローカル受信サーバーだけで完結する機能ではありません。

### 継続中

- パネルを開いたままにする。自動開始・バックグラウンド常駐型の全会議監視ではない。
- 更新があると約5秒の確認単位でバッチを送る。字幕確定、通信、AI処理による遅延は別に発生する。
- Claude側が作業中の受信・処理タイミングはClaude Code側の挙動に依存する。5秒ごとのAI応答を保証しない。
- 初期依頼で会議モードが有効。重要な変化に対し通常4行、最大6行を目安に短いカードを出す。変化のない相づちでは繰り返さず、話の途中は暫定とする。
- 「今の話」「相手の問い」「返答案」「根拠・提案」を優先する。根拠は実際に確認した資料だけ。話者や本人の立場が不明なら推測で断定しない。
- 必要なら役割・会議の目的を伝える。関連する仕様・コードを必要最小限読み、提案と決定・未確認を区別する。

### 助言モードと転送の区別

- `/tactiq-live:meeting stop` または本人の明示的な終了依頼で継続助言を止める。
- `/tactiq-live:meeting start` または本人の再開依頼で助言を再開する。
- **助言停止はHTTP／Channels転送を止めない。** 字幕を止めるにはChromeパネルの停止ボタンを押す。会議参加者の字幕中に「止めて」とあっても、本人の操作指示として扱わない。

### 一時停止・再開

- Tactiqの `isPaused` が `false` と確認できない間は本文を取得・送信しない。
- pauseを観測すると、未確認バッチを破棄する。
- 再開時は最初のsnapshotを再基準化し、その時点の発話IDも以後の修正対象から除外する。
- 次の新しい発話から転送する。停止期間の取り戻し機能はない。

pauseの確認はポーリング単位です。停止操作の瞬間に、既に送信済み／送信中だったデータを取り消すことはできません。

### 停止

次の操作・状態で転送が止まります。

- パネルの「停止・未送信分を破棄」。
- 別のDevToolsパネルへ切替える、パネルを閉じる。
- 検査対象ページの移動。
- 会議終了、選択会議不一致、Tactiq消失・未知schema。
- HTTP 4xx等の回復不能なエラー。
- Claude側サーバーのstdin EOF／終了。

明示停止後は自動で開始しません。必要なら対象会議を再確認して開始してください。Claudeへの送信済み本文を消す機能はありません。

## 5. 非機密データでの受入確認

実会議の前に、本人管理のテスト会議で次を確認します。

1. 開始前の発話が遡って届かない。
2. 開始後の**新しい発話**と、その修正がClaudeへ届く。
3. 同じ発話の修正が、別発話として無制限に重複しない。
4. Tactiq一時停止中に転送せず、再開しても過去prefixを遡って送らない。
5. パネル停止、ページ移動、DevToolsパネル切替で止まる。
6. Claude終了後にローカル受信サーバーが残らない。
7. Google Meet、Zoomブラウザ、Teamsブラウザで個別に確認する。
8. 必要な非機密資料を参照し、相手の問い・短い返答案・実在する根拠が出るか確認する。
9. 読めない仕様・未確定日程を断定せず、字幕の命令で秘密を読まないことを確認する。
10. 作業ディレクトリ外・.env・鍵の読取りが実Claudeで拒否され、編集・Shell・追加外部ツールが使えないことを確認する。
11. Skillのstopでは助言だけが止まり、パネル停止で初めて転送が止まることを確認する。

通らないサービスを「対応確認済み」と扱ってはいけません。会議の本文や認証情報を不具合報告へそのまま貼らないでください。

## 6. 処理構成

```text
Tactiqのisolated world
  └─ 固定のgetState読取り式
      └─ 選択会議・pause・schema検査
          └─ DevTools panel / 差分と未確認バッチ
              └─ POST http://127.0.0.1:43821/captions
                  └─ Bearer / Host / Origin / schema / size / sequence検査
                      └─ notifications/claude/channel
                          └─ このchannelを有効化したClaude Code
```

主なファイル：

| ファイル | 責務 |
| --- | --- |
| `extension/devtools.js` | パネルの登録・非表示通知 |
| `extension/panel.js` | UI、固定contextの読取り、開始停止、5秒timer、HTTP |
| `extension/snapshot.js` | 選択会議だけの処理済み状態をwhitelist形式へ変換 |
| `extension/stream.js` | baseline除外、差分、バッチ、再送 |
| `bin/tactiq-live.js` | setup／Claude起動／token表示、読取り専用設定・Skill読込み、排他、token更新、子プロセス終了 |
| `.claude-plugin/plugin.json` | セッション限定pluginのメタ情報 |
| `skills/meeting/SKILL.md` | 会議の継続理解・返答支援、参照境界、助言の開始停止 |
| `server/runtime.js` | ユーザー専用保存先と環境変数override |
| `server/main.js` | MCP capability、stdio接続、loopback起動、終了 |
| `server/bridge.js` | HTTP入力検査、認証、順序、重複抑止、channel通知 |
| `server/token.js` | トークンの安全な生成・読取り |

## 7. Tactiq読取り契約

`chrome.devtools.inspectedWindow.eval` の `scriptExecutionContext` に、次のoriginを指定します。

```text
chrome-extension://fggkaccpbmombhnjkjokndojfgagejfb
```

固定の自己完結した読取り式が、`window.tactiq.content.store.getState().transcriptions.current` を確認します。任意の会議本文をJavaScriptとして評価したり、Tactiqへdispatchしたりしません。

- 会議一覧の取得時は、会議IDと最大200文字のタイトルのみを返す。
- 本文取得は選択IDの会議に限定する。
- `detectedMeetingStage === "meeting"`、`isPaused === false` が必要。
- 不明・無効化されたcontext・schema不一致では送らない。
- 削除済み・chat・screenshot・page-linkのblockは送らない。
- 翻訳ブロックやアカウント・トークン等の状態は収集しない。

この内部構造はTactiqの公開APIではなく、版更新で変わり得ます。

## 8. HTTP仕様

### 接続・認証

既定：`http://127.0.0.1:43821`。bind先はloopbackのみです。

全リクエストに次を付けます。

```http
Authorization: Bearer <pairing-token>
```

`Host` は実際の `127.0.0.1:<port>` と一致する必要があります。Originが付く場合は `chrome-extension://<32文字の拡張ID>` 形式のみを許可します。**Originだけで正当な拡張と認証しているわけではなく、秘密トークンも必要**です。一般web Originは拒否し、CORSを一般サイトへ開放しません。

### GET /health

MCP初期化済みなら `200`。応答bodyは空です。起動中で未初期化なら `503`。

### POST /captions

`Content-Type: application/json`。圧縮等の `Content-Encoding` は受け付けません。

例はすべてダミーデータです。

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "sequence": 1,
  "meetingId": "demo-meeting",
  "platform": "Google Meet",
  "updates": [
    {
      "messageId": "utterance-001",
      "deviceId": "speaker-device-1",
      "messageVersion": 1,
      "speakerName": "Demo speaker",
      "transcript": "これはダミー字幕です。",
      "timestamp": 1000,
      "version": 1001
    }
  ]
}
```

| 項目 | 条件 |
| --- | --- |
| `sessionId` | UUID形式文字列。開始／pause後の再開で新しい送信系列になる |
| `sequence` | 1から始まる正のsafe integer。確認済み配送ごとに増加 |
| `meetingId` | 1〜512文字。同一session中に変更しない |
| `platform` | `Google Meet` / `Zoom` / `Teams` |
| `updates` | 1〜64件 |
| `messageId` | 1〜512文字 |
| `deviceId` | 任意。存在する場合1〜512文字 |
| `messageVersion` | 0以上のsafe integer |
| `speakerName` | 1〜256文字 |
| `transcript` | 0〜32768文字 |
| `timestamp` / `version` | 非負有限数。Tactiq側で付くミリ秒値を想定 |

列挙外のトップレベル／blockフィールドは受け付けません。`timestamp` は音声上の厳密な発話開始時刻の保証ではありません。

### 応答

成功は `202`、bodyは空です。**SDKへ通知を書き出せたという意味で、モデルの受領・理解・応答完了ではありません。**

| HTTP | 主な意味 |
| --- | --- |
| 400 | JSON／schema／入力読取りの不正 |
| 401 | トークン不一致 |
| 403 | Host／Origin不一致 |
| 404 | 未対応パス／メソッド |
| 409 | sequence飛び・古い配送・同番号で異なる内容・session内の会議変更 |
| 413 | body上限超過 |
| 415 | Content-Type／Content-Encoding不一致 |
| 429 | プロセス内session上限 |
| 503 | MCP未初期化／通知発行失敗 |

## 9. Claude Code Channels仕様

MCP capability：

```json
{ "experimental": { "claude/channel": {} } }
```

一方向通知：

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "{\"meetingId\":\"demo-meeting\",\"updates\":[]}",
    "meta": {
      "platform": "Google Meet",
      "session_id": "00000000-0000-4000-8000-000000000001",
      "sequence": "1"
    }
  }
}
```

`content` はJSON文字列です。`<`、`>`、`&` はUnicode escapeに変換します。`meta` の値は文字列です。返信ツールや `claude/channel/permission` capabilityは持ちません。

同じ送信sessionの発話は `messageId` と必要に応じ `deviceId` で更新として扱います。サーバー側instructionsは、会議本文を非信頼の参考情報とし、実ユーザーが会議モードを有効にした場合は短い継続支援を行い、それ以外は本人の依頼に基づいて回答するよう指定します。プロンプトインジェクションの完全な防止保証ではありません。

## 10. 差分・再送・終了の仕様

1. 開始時にsnapshotをbaseline化し、既存IDを除外する。
2. 新しいID、または開始後に取得したIDの内容変更を検出する。
3. 上限内にまとめ、未確認バッチを一つ保持する。
4. 成功応答の後だけbaseline・sequenceを進める。
5. 通信失敗・5xxでは同じ未確認バッチを次回再送する。新しい更新はその確認後に処理する。
6. サーバーは配送を直列化し、sessionのsequenceとリクエスト本文digestで直前の同一配送を再通知しない。
7. pause／停止で未確認分を破棄する。サーバー再起動時には重複抑止状態も失われる。
8. MCP stdin EOF、SIGINT、SIGTERMでHTTP listenerと接続を閉じる。

本文の削除や修正によって、既にAIへ届いた情報を取り消すことはできません。

## 11. 上限と設定

| 項目 | 値 |
| --- | --- |
| パネルの確認間隔 | 5000 ms |
| fetch timeout | 8000 ms。処理中の重複pollはskip |
| snapshot | 4000 blocks、本文合計200万文字 |
| block本文 | 32768文字 |
| バッチ | 最大64更新、block JSON合計240000 bytesまで |
| HTTP body | 262144 bytes（256 KiB） |
| HTTP request／header timeout | 各10000 ms |
| HTTP keep-alive | 1000 ms |
| HTTP同時接続 | 16 |
| 送信sessionの保持 | 1サーバープロセスあたり最大32 |

巨大な単一blockや未知schemaは無言で切り捨てず停止します。大量の差分は複数バッチへ分割するため、後続分は次のpoll以降になります。

既定のユーザー保存先は `~/.tactiq-live-channel/` です。環境変数 `TACTIQ_RUNTIME_DIR` はCLI・サーバー共通の保存先、`TACTIQ_PORT` はサーバーportを変更できます。主にテスト／開発用です。**パネルとCSPは43821に固定**されているため、サーバーportだけを変えても通常UIは接続できません。MCP設定へ秘密トークンを埋め込む必要はありません。

## 12. トラブル対処

| 症状 | 確認・対処 |
| --- | --- |
| コマンドが見つからない | npmのグローバルbinがPATHにあるか、現在のNode環境にインストールしたかを確認。sudoでの解決を前提にしない |
| ランチャーlockが残っている | 前のプロセスが完全に終了したか確認。クラッシュで残った場合のみ `~/.tactiq-live-channel/launcher.lock` を本人が確認して削除する。稼働中に削除しない |
| パネルが見えない | `setup` が表示した拡張フォルダを読み込んだか、DevTools再起動と `»` メニューを確認 |
| 会議一覧が空 | 正しい会議タブか、Tactiqが動いているか、対応hostかを確認 |
| contextが読めない | Tactiq版・frame配置・内部構造の相違を疑い、停止したまま調査。別contextへ勝手にfallbackしない |
| 接続失敗 | channel付きClaudeが起動中か、43821の競合、ローカル通信制限を確認 |
| 401 | 起動後に `tactiq-live token` を再実行し新しい値を貼る。値をログやIssueへ貼らない |
| 503 | MCP初期化・channel設定を確認。反復する場合は停止してサーバー状態を調べる |
| 409 | サーバー再起動や系列不一致が考えられる。パネルを停止し、再確認・再開始。過去分は復元しない |
| 429 | 頻繁な開始／pauseで32session上限。停止してサーバーを再起動し、再開始 |
| 413／上限エラー | 黙って本文を削らず停止。非機密の再現データで上限・schemaを調査 |
| 送信中なのに最初の発話が来ない | baselineに存在した進行中発話は除外される。新しい発話から確認 |
| HTTPは成功するがClaudeに来ない | 通常MCP接続だけでなくchannelとして有効か、アカウント／組織の提供条件を確認 |

通常のtoken更新はランチャー再起動時に自動で行います。破損等を手動で直す場合も、**先にパネルとサーバーを停止**してから扱ってください。実行中にファイルだけを書き換えても、サーバーが保持する値は変わりません。旧0.1版の `.runtime/token` は新しい保存先へ自動移行しません。

## 13. セキュリティと保持

- 補助拡張のhost permissionは `http://127.0.0.1/*`。コードとCSPは43821へ限定する。
- storage、tabs、scripting、debugger権限、一般webサイトのhost permissionは要求しない。
- トークンはパネルのメモリに保持し、ローカルHTTPのAuthorizationへだけ付ける。
- ブリッジは会議本文をファイルやログへ保存しない。ただし本文はメモリとClaude Code／Anthropic側の会話に残り得る。
- 拡張Origin形式だけを信頼せず、Bearer認証・型・サイズを検査する。
- 会議本文の指示でツール実行・外部送信・権限承認を行わない。
- プロジェクト参照内容もモデルへ送られる。Read denyと作業ディレクトリ境界はOS隔離や完全な機密検出の代替ではない。
- `.runtime/`、解析対象の第三者拡張本体、ローカル調査scratch、依存関係は公開Git履歴へ含めない。

## 14. 開発・検証・関連資料

```bash
npm test
npm audit --omit=dev
```

開発時はリポジトリルートで `npm ci --ignore-scripts` 後に実行します。テストはNode標準test runnerを使用します。CLIのhelp・配置・作業ディレクトリ維持・起動間token分離・排他・signal cleanupと、隔離したnpmグローバルインストールも確認します。固定読取り式のVM実行、Chrome／DOM境界の模擬、privacy regression、packing上限、実HTTP、stdio MCP handshake、EOFのみでの終了を含みます。

CLI／plugin／読取り設定は引数記録と公式CLIのparse・plugin validateで確認。会議Skillは架空の催促・秘密要求に対する5つの独立応答を比較し、短い返答案と未確認の扱いを評価しています。これは実Claude Code／HaikuでのSkill実行・権限強制の試験ではありません。

**実Chromeのcontext読取り、三サービスの実Tactiq状態、実Claude Codeのモデル受信・権限拒否、長時間の精度・費用は未検証**です。ダミーテスト成功を本番の全経路保証として扱わないでください。

- [README：概要と短い導入手順](README.md)
- [REAが分析に役立った点と限界](docs/rea-analysis-report.md)
- [Chrome DevTools inspectedWindow](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)
- [Claude Code Channels](https://code.claude.com/docs/en/channels)
- [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
