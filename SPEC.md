# Tactiq Live → Claude Code：使い方と仕様

バージョン：0.1.0。最終更新：2026-10-19。

> **手動導入前の試作です。** ダミーデータ、Chrome API境界の模擬、実ローカルHTTP／MCP stdio通信は自動テスト済みですが、実Chrome・実Tactiq・実Claude Codeをつないだ動作は未検証です。実会議で利用可能と判断する前に、非機密のテスト会議で確認してください。

## 1. 目的・機能範囲

Tactiqが処理した会議中の字幕を、明示的に選択したClaude Codeセッションへ逐次渡します。AIが会議の要約や質問への回答を行うための**入力経路**です。

### 実装している機能

- 選択した一つの会議の、新規発話と発話修正の取得。
- 約5秒ごとの確認。差分がなければ送信しない。
- 明示開始・停止、Tactiq一時停止への追従、ページ移動・DevToolsパネル切替時の停止。
- 認証付きローカルHTTP、一方向のClaude Code Channels通知。
- 未確認バッチの再送と、プロセス内の重複通知抑止。

### 実装していない機能

- 音声の録音・音声認識。文字起こしはTactiq側が担当する。
- デスクトップ版Zoom／Teams、過去会議の一括読取り、翻訳・画像・ページリンク・チャットの転送。
- 任意の既存Claude Codeセッションへの入力。channelを有効にして起動したセッションが必要。
- 定時の自動要約ジョブ、プロジェクト資料の自動読込み、コード変更・コマンド実行。
- 永続キュー、再起動をまたぐexactly-once配送、AIによる受領確認。

要約やプロジェクトを踏まえた判断には、本人の依頼と必要な資料が別途必要です。推奨起動設定ではファイル読取りを含むbuilt-in toolsを無効にします。資料は先に会話へ与えるか、必要な読取り権限だけを許可する別の設計として検討してください。会議の発言をツール操作や権限承認に利用してはいけません。

## 2. 動作条件

| 項目 | 条件 |
| --- | --- |
| Node.js | 22以上。ローカル検証は24.15.0 |
| Chrome | 125以上。DevToolsを利用 |
| Tactiq | Chrome拡張が対象タブで動作中。解析対象版は3.1.7185 |
| Claude Code | Channels対応版。ローカル確認版は2.1.302 |
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

### 3.1 プロジェクトを取得する

取得したリポジトリのルートを作業ディレクトリにします。以降のコマンドはすべてそのルートで実行してください。

```bash
npm ci --ignore-scripts
npm test
```

ビルド・bundlingは不要です。依存関係はMCPの公式JavaScript SDKで、版はlockfileに固定します。Tactiq本体やREAはこの連携の通常起動に必要な依存関係ではありません。

### 3.2 Claude Codeを起動する

```bash
claude \
  --mcp-config ./mcp.local.json \
  --strict-mcp-config \
  --tools "" \
  --disable-slash-commands \
  --dangerously-load-development-channels server:tactiq-live
```

- `mcp.local.json` は `node server/main.js` をstdio MCPサーバーとして起動する設定。相対パスなのでルートから起動する。
- `--strict-mcp-config`：指定外のMCP設定を読み込まない。
- `--tools ""`：字幕をきっかけとするファイル操作・コマンド実行を避ける安全な初期設定。
- `--disable-slash-commands`：skillsを無効化する。
- `--dangerously-load-development-channels`：自作channelを試すための明示的な開発用許可。認証・ツール権限の迂回のためには使わない。

起動時の承認や組織ポリシーに従い、`tactiq-live` が**channelとして有効**なことを確認してください。通常のMCP接続成功だけではpush通知を受け取れるとは限りません。

サーバーはこのClaudeプロセスに起動させます。別のターミナルで `npm run channel` を重ねて起動する必要はありません。MCPクライアントなしでサーバーだけ起動しても、字幕をClaudeへ届けることはできません。

### 3.3 ペアリングトークンを確認する

起動後、ルートの `.runtime/token` にランダムなトークンが生成されます。

- ディレクトリ：0700、ファイル：0600。
- 既存の正しいトークンは再利用する。
- symlinkや公開権限のファイルは拒否する。
- Gitの公開対象外。サーバーログにも出さない。

ローカルエディタ等で値を確認し、後述のパネルへ貼り付けます。**GitHub、チャット、スクリーンショットへ載せないでください。**

### 3.4 補助Chrome拡張を読み込む

1. Chromeで `chrome://extensions` を開く。
2. デベロッパーモードを有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」から、このリポジトリの `extension/` を選ぶ。
4. 既に開いているDevToolsは一度閉じて開き直す。

補助拡張はTactiqとは別の拡張です。Tactiqのインストールや設定を変更しません。

## 4. 会議での操作

### 開始

1. 会議参加者の同意、組織規程、Claude／Anthropic側のデータ取扱いを確認する。
2. 会議をChromeで開き、Tactiqの文字起こしが動いていることを確認する。
3. **その会議タブ**でDevToolsを開き、`Tactiq Live` パネルを選ぶ。見えなければ `»` メニューを確認する。
4. `.runtime/token` の値を貼り付ける。ブラウザの永続storageには保存しない。
5. 「Tactiqの会議を確認」を押し、対象会議を選ぶ。
6. 同意確認にチェックし、「Claude Codeへ転送開始」を押す。
7. 接続成功後、**次の新しい発話から**転送される。

開始時点に存在する発話IDは、その後に修正されても転送しません。開始前の本文が修正版に混ざるのを防ぐためです。進行中の発話の続きが最初の数秒届かない場合があります。

転送開始後の本文は、Claude Codeを通じて**Anthropicへ送られます**。ローカル受信サーバーだけで完結する機能ではありません。

### 継続中

- パネルを開いたままにする。自動開始・バックグラウンド常駐型の全会議監視ではない。
- 更新があると約5秒の確認単位でバッチを送る。字幕確定、通信、AI処理による遅延は別に発生する。
- Claude側が作業中の受信・処理タイミングはClaude Code側の挙動に依存する。5秒ごとのAI応答を保証しない。
- 本人から、例えば「会議内容を参考情報として受け取り、私が質問したら決定事項と未決事項を整理して」と依頼する。

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

同じ送信sessionの発話は `messageId` と必要に応じ `deviceId` で更新として扱います。サーバー側instructionsは、会議本文を非信頼の参考情報とし、実ユーザーの依頼に基づいて回答するよう指定します。プロンプトインジェクションの完全な防止保証ではありません。

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

環境変数 `TACTIQ_RUNTIME_DIR` はサーバーのtoken保存先、`TACTIQ_PORT` はサーバーportを変更できます。主にテスト／開発用です。**パネルとCSPは43821に固定**されているため、サーバーportだけを変えても通常UIは接続できません。MCP設定へ秘密トークンを埋め込む必要はありません。

## 12. トラブル対処

| 症状 | 確認・対処 |
| --- | --- |
| パネルが見えない | `extension/` を読み込んだか、DevTools再起動と `»` メニューを確認 |
| 会議一覧が空 | 正しい会議タブか、Tactiqが動いているか、対応hostかを確認 |
| contextが読めない | Tactiq版・frame配置・内部構造の相違を疑い、停止したまま調査。別contextへ勝手にfallbackしない |
| 接続失敗 | channel付きClaudeが起動中か、43821の競合、ローカル通信制限を確認 |
| 401 | 起動中サーバーの `.runtime/token` と一致するかを確認。値をログやIssueへ貼らない |
| 503 | MCP初期化・channel設定を確認。反復する場合は停止してサーバー状態を調べる |
| 409 | サーバー再起動や系列不一致が考えられる。パネルを停止し、再確認・再開始。過去分は復元しない |
| 429 | 頻繁な開始／pauseで32session上限。停止してサーバーを再起動し、再開始 |
| 413／上限エラー | 黙って本文を削らず停止。非機密の再現データで上限・schemaを調査 |
| 送信中なのに最初の発話が来ない | baselineに存在した進行中発話は除外される。新しい発話から確認 |
| HTTPは成功するがClaudeに来ない | 通常MCP接続だけでなくchannelとして有効か、アカウント／組織の提供条件を確認 |

トークンを更新する場合は、**先にパネルとサーバーを停止**し、生成済み `.runtime/token` を削除してからサーバーを再起動し、新しい値で再ペアリングします。実行中にファイルだけを書き換えてもサーバーが保持する値は変わりません。

## 13. セキュリティと保持

- 補助拡張のhost permissionは `http://127.0.0.1/*`。コードとCSPは43821へ限定する。
- storage、tabs、scripting、debugger権限、一般webサイトのhost permissionは要求しない。
- トークンはパネルのメモリに保持し、ローカルHTTPのAuthorizationへだけ付ける。
- ブリッジは会議本文をファイルやログへ保存しない。ただし本文はメモリとClaude Code／Anthropic側の会話に残り得る。
- 拡張Origin形式だけを信頼せず、Bearer認証・型・サイズを検査する。
- 会議本文の指示でツール実行・外部送信・権限承認を行わない。
- `.runtime/`、解析対象の第三者拡張本体、ローカル調査scratch、依存関係は公開Git履歴へ含めない。

## 14. 開発・検証・関連資料

```bash
npm test
npm audit --omit=dev
```

テストはNode標準test runnerを使用します。固定読取り式のVM実行、Chrome／DOM境界の模擬、privacy regression、packing上限、実HTTP、stdio MCP handshake、EOFのみでの終了を含みます。

**実Chromeのcontext読取り、三サービスの実Tactiq状態、実Claude Codeのモデル受信、長時間の精度・費用は未検証**です。ダミーテスト成功を本番の全経路保証として扱わないでください。

- [README：概要と短い導入手順](README.md)
- [REAが分析に役立った点と限界](docs/rea-analysis-report.md)
- [Chrome DevTools inspectedWindow](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)
- [Claude Code Channels](https://code.claude.com/docs/en/channels)
- [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
