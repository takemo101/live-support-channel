# Live Support Channel：使い方と仕様

バージョン：0.7.0。最終更新：2026-10-20。

> **試験版。実会議の互換性は未確認です。** 実ChromeのローカルWebRTC接続と合成wire・合成した内部状態（Teamsの通話オブジェクト、Zoomのstore）、実HTTP／MCP通知を検証。実Meet・Teams・Zoom／document_start拡張ロード／実Claudeの応答・権限強制は別の受入確認です。Meetは字幕通信の観測、Teamsは通話の字幕イベントの傍受、Zoomは字幕の内部状態（store）の購読です。

## 1. 目的と範囲

Chrome上のMeet・Teams・Zoom（Webクライアント）の字幕を、明示選択した一つのClaude Codeセッションへ逐次渡します。プロジェクト資料を読取り専用で参照し、「要点・相手の問い・短い返答案・根拠付きの事業／技術の提案」を表示します。Tactiqは不要。CLI名・channel名は `live-support`、保存先は `~/.live-support`、npmパッケージとGitHubリポジトリは `live-support-channel`。

実装範囲：

- GitHubからグローバル導入。一度に1プロジェクトへ配信。
- Meet：参加前フックで、captions／captions_v2の既知wireだけを処理する独立reader。必要時の独自購読とown-v2 ACK。話者名はMeetの名簿メッセージ（collections）から。Teams：通話の字幕イベントのハンドラを開始後だけ包む傍受。Zoom：アプリのReduxストアを開始後だけ購読（読み取りのみ）。いずれも話者は表示名。
- 同意後の開始・一時停止・再開・停止。使えるフレームが1つもない（50件超）・字幕OFF・lease失効等で停止。
- 約1秒のsnapshot／heartbeat。差分送信はパネルの「転送のまとめ方」：発話の区切りごと（既定。字幕が3秒静か、または最古の未送信の変化が45秒）／約30秒／約5秒。失敗後は5秒空けて再送。発話IDと改訂でupsert。
- 認証付きloopback HTTP、一方向Channels通知、未確認バッチの再送とプロセス内重複抑止。
- `skills/meeting/SKILL.md` による継続支援。Read／Glob／Grep／Skillのみ公開。

対象外：Zoomのソケット・参加者一覧の読取り、Teamsの字幕開始（`startClosedCaption()` など、アプリの状態を変える呼び出し）・参加者名簿の取得（websocket）、Zoom・Teams・Meetの内部状態の書換え、Zoom／Teamsのデスクトップクライアント、音声録音、新しいASR、過去会議・チャット・翻訳別フィードの取得、会議タブ以外（他のウィンドウ・他のタブ）の画像、会議相手への自動送信・代返、編集・Shell、任意の既存Claudeセッションへの注入、永続キュー、完全な議事録・exactly-once配送保証。

字幕は取得できた一部分です。初回ID除外、通信遅延・欠落等があり、全文や確定発話と扱ってはいけません。本人の未確認の納期・予算を確約せず、事実・提案・未確認を分けます。Skillの指示は完全なプロンプトインジェクション防御の保証ではありません。

## 2. 条件と取得対象

| 項目 | 条件 |
| --- | --- |
| Node.js | 22以上（検証24.15.0） |
| Chrome | 125以上、DevTools使用（ローカルRTC検証155） |
| Meet | httpsのmeet.google.com会議top frame（`/abc-defg-hij` または `/meet/abc-defg-hij`）。参加前にフック準備、標準字幕ON |
| Teams | https の teams.microsoft.com／teams.live.com／teams.cloud.microsoft のtop frame。ライブキャプションをON（通話情報が見つかること） |
| Zoom | https の app.zoom.us Webクライアントの会議ページ（`/wc/<番号>/…`）。字幕（ライブトランスクリプション）をON（字幕のstoreが見つかること） |
| UI言語 | 字幕ボタンの判定は日本語／英語。その他は未対応として停止 |
| Tactiq | 不要。他字幕拡張との同居は未確認 |
| Claude Code | Channels・restricted・セッションplugin・Skill Shell前処理無効化に対応。CLI確認2.1.302／2.1.303 |
| 認証／port | Channelsを許可されたAnthropic認証・組織設定、`127.0.0.1:43821` が使用可能 |
| OS | 0700／0600とsymlink拒否を使用。検証はmacOS |

`app.zoom.us` 以外の `zoom.us` とサブドメインは識別しますが、本文を読まず `PLATFORM_NOT_IMPLEMENTED` を返します。iframeの自動探索、ログイン・有料機能・組織ポリシーの回避はしません。

Channelsはresearch previewです。公式資料ではBedrock／GoogleのAgent Platform／Microsoft Foundryは非対応で、組織管理者の有効化が必要な場合があります。提供条件は変更され得ます。

## 3. 導入・起動

```bash
npm install --global --ignore-scripts github:takemo101/live-support-channel
live-support setup
```

表示された拡張フォルダ（通常 `~/.live-support/extension`）を `chrome://extensions` のデベロッパーモードから手動で読み込みます。ChromeやClaudeのユーザー設定は自動変更しません。ビルド、Tactiq、REAは起動時依存ではありません。

cloneした環境では `just install` で独立コピーのグローバル導入とsetup、`just uninstall` でCLIのみ削除できます。justfileはdotenvを読まず、install失敗時はsetupしません。

```bash
cd /path/to/project
live-support claude
# 別ターミナル
live-support token
```

tokenを公開しないでください。ランチャーはcwdを維持し、インストール先の絶対パスからその起動だけのMCP設定を作ります。プロジェクトへのファイル配置やグローバルSkill追加は不要です。起動直後から資料を読むため、先に非機密の参照範囲を選んでください。

ランチャーの安全設定：

- `--strict-mcp-config`、`--tools Read,Glob,Grep,Skill`。
- `--restricted`、`--permission-mode manual`。bypassは使わず、managed設定が優先。
- `--settings` でhooks、SkillのShell前処理を無効化。`permissions.blockReadsOutsideWorkingDirectories` とRead deny（.env、鍵、.git／.ssh／.aws／.claude、認証設定、実ランタイム保存先）を指定。
- `--plugin-dir` と `--append-system-prompt-file` で同じ `skills/meeting/SKILL.md` をそのセッションだけに使用。初期ユーザー依頼で会議モードを開始。
- `--dangerously-load-development-channels server:live-support -- <開始依頼>`。可変長引数とpromptの間の `--` が必要。認証・権限・組織制限は迂回しない。

ホーム／filesystem rootからの起動は拒否します。これはOSサンドボックスや全機密情報の検出ではありません。実Claudeでの拒否動作は受入確認が必要です。モデル環境変数は継承し、例は `ANTHROPIC_MODEL=haiku live-support claude`。実Haikuの品質・速度・費用は未確認です。

受信port使用中・別ランチャーのlockがある場合は二重起動を拒否。終了signalでは子の終了を待ってlockを解除します。直接 `server/main.js` を起動する開発用 `mcp.local.json` にはCLIの排他・起動ごとのtoken更新は適用されません。

## 4. 会議での操作

1. 参加者同意、組織規程、Anthropic側のデータ取扱いを確認する。
2. **会議参加前**に拡張を読み込み、サイトアクセスを本人が許可する。更新時は会議タブを閉じて開き直してから参加する（Meetは参加前の準備が必要）。
3. 会議側で字幕をONにする（Meetは標準字幕、Teamsはライブキャプション、Zoomは字幕）。画面の字幕表示は読まないので、表示の有無は取得に関係しない。Chrome全体の自動字幕ではない。
4. そのタブのDevTools → **Live Support**。パネルを開くと準備を自動確認し、会議は1件なら自動選択する。token入力 → 同意 → 転送開始（tokenは受信サーバーが受理した後、ブラウザ終了まで `chrome.storage.session` に記憶。「再確認」で再検査）。
5. パネルを表示したまま使う。起動直後から参照するプロジェクトも非機密の範囲を選ぶ。

準備中・確認操作はURL、字幕ボタン、接続／チャネルの状態・件数だけを扱い、字幕本文や会議タイトルは読まない。認証済み /health と同意の確認後に取得を開始する。接続が複数で特定できない場合は開始しない。

### 開始・再開とプライバシー

各話者の最初に観測した発話IDを基準に、**そのID以前と全修正を除外**する。次の大きなIDから取得する。最初の質問・新しい話者の初回発話・長い継続発話が届かない可能性がある。

これは生成時刻による厳密な境界ではない。検証済みの生成時刻fieldがなく、受信時刻とID順序に依存するため、遅配・履歴を完全に見分ける保証はない。生成時刻での完全な区間分離が必要な会議には使わない。

参加者一覧は収集しない。話者名は会議サービス自身が持つ表示名を送る（読み取れないときだけ「話者N（名前未確認）」）。表示名は制御・双方向制御文字を除いて64文字に制限し、非信頼・未検証のラベルとして扱う。内部device IDと画像URLは送らない。Meetの名簿（device ID → 表示名）だけは、参加直後に送られるため、同意前からメモリ上に最大256件保持する（送信・保存しない）。本人の特定は `/meeting` スキルが本人に確認した名前だけを根拠にし、本人の発言は助言・要約・引用に含めない。本人の役割は推測で決めない。

### 一時停止・停止

- 一時停止でtimer・未送信分・未確認バッチを破棄し、自分が追加したチャネルを閉じる。本文の処理・保持・送信を止める。準備済みフック自体は残るが、休止中はMessageEvent.dataへアクセスしない。
- 未処理payloadは可変キューから即時解放する。実行中のgzip readerはcancelし、取消不能な読取り最大1件は結果を無効化する。その終了まではCAPTION_DECODE_BUSYで新captureを拒否する。
- 再開時は新しいcapture所有者・送信sessionを作り、各話者の初回IDを再基準化する。休止期間は取り戻さない。
- **Tactiqのpauseとは連動しない。** Tactiqを止めても本readerは止まらない。
- 停止、pagehide、ページ移動、字幕OFF、使えるフレームがない状態の継続、チャネル終了、上限、HTTP4xxで停止。自動再購読しない。
- パネルは約1秒でheartbeatを送り、約2秒のleaseが切れたら本文を破棄して自分のチャネルを閉じる。元のアプリのチャネル・PeerConnectionは閉じない。
- **lease失効（CAPTURE_EXPIRED）だけは同じ会議へ自動復旧する。** パネルが新しいcapture所有者でrecoverを呼び、フックは「現在のcaptureが無く、直前の終了がCAPTURE_EXPIREDで、旧所有者・会議が一致」する場合だけ新規購読を許可する。手動の停止・一時停止・字幕OFF・会議変更・他のcapture・他の終了理由は復旧せず停止する。CAPTION_DECODE_BUSYだけは次の約1秒周期で最大10回再試行し、超えたら停止。送信系列・未確認バッチ・蓄積は維持するが、**失効中の字幕、復旧後の各話者の初回ID以前は欠落し、話者番号は振り直される**（状態表示に回数を出す）。MAINは今も約2秒で安全停止するため、無欠落の取得ではない。
- Main worldとDevToolsは非同期なので、停止指示の到達前や発行済み処理は即時取消できない。各frameと非同期decode後にも所有者・leaseを確認し、失効した結果を送らない。
- 受信サーバーはstdin EOF／SIGINT／SIGTERMで閉じる。送信済み情報を消す機能はない。

### 会議支援と切替

重要な変化に通常4／最大6行のカード。同じ相づちでは繰り返さず、途中は暫定、欠落は不明とする。資料は必要最小限読み、実在する根拠だけ示す。

- /live-support:meeting stop：助言停止。
- /live-support:meeting start：助言再開。
- **助言停止は転送停止ではない。字幕はChromeパネルで停止する。**

プロジェクト切替はパネル停止 → 前のランチャー終了 → 次のprojectで起動 → 新tokenで再ペアリング。古いtokenは新しい受信先で認証されない。

## 5. readerとデータ経路

```text
Meet限定 MAIN/document_start：RTCPeerConnectionを準備
 → 同意・health・標準字幕ON・接続確認
 → 既存の字幕チャネル、または自分のcaptions/captions_v2購読
 → bounded protobuf/gzip decode、初回ID除外、話者名（画面の字幕と本文が一致し名前が1つに決まる場合のみ。それ以外は匿名）、改訂upsert
 → 通常page evalで自作hookからsnapshot／1秒heartbeat
 → CaptionStream → まとめ方に応じたBearer POST /captions（既定は発話の区切りごと）
 → Host／Origin／schema／size／sequence検査 → Claude Channels
```

extension/meet-hook.js はclassic script。MAIN worldでページと同じJS環境に置き、constructor/createDataChannelとincoming datachannelを観測する。元の引数・結果・send・binaryTypeを変更せず、字幕本文をDOMから読むfallback・fetch・WebSocket・チャット・他拡張へfallbackしない。話者名は、`collections` チャネルの名簿メッセージ（protobuf。生または gzip）から device ID → 表示名を最大256件メモリに保つだけで、形式が違えば無視する（名前が付かないだけで停止しない）。サイトのCSPと管理ポリシーに従う。

同意後、識別可能な既存のordered字幕チャネルを優先する。無ければ識別済みの会議接続に自分のordered captions_v2／captionsを追加する。最初の有効packetで一つに固定し、不要になった自分のチャネルだけ閉じる。ACKは自分のv2チャネルへだけ返す。字幕ON・言語・認証・権限や元の通信は書き換えない。

**実験オプション（パネルのチェックボックス、既定OFF）：字幕がOFFでも開始。** Teams：開始時に、通話の `startClosedCaption()` を、`closedCaptionsHaveBeenStarted()` が偽のときだけ1回呼ぶ（Teamsの状態を変える唯一の呼び出し）。字幕イベントのハンドラは字幕が動き出してから現れうるため、250msごと最大80回（約20秒）探して包み、見つからなければ `TEAMS_CALL_NOT_FOUND` で停止する。recoverは元の開始の設定を引き継ぐ。Zoomは字幕を開始する手段を実装しない（対象外）。Meetは次のとおり。

**実験オプション（パネルのチェックボックス、既定OFF）：字幕ボタンOFFでの開始。** 例外としてこの時だけ、(1) `RTCDataChannel.prototype.send` を観測専用で包み、ラベルが `media-session` のMeet自身の制御フレーム（4096 bytes以下）から、コマンド番号`op`・ACK連番・字幕言語コード（`[A-Za-z]{2,3}(-…)`、32文字以下）の3値だけを保持する（他のラベルは中身に触れず、送信内容は変更しない）。(2) 字幕ボタンがOFFのstart時に限り、観測した言語と番号から `op+1` の字幕設定コマンド（BigPacket.envelope(1).command(2){op=1, captionUpdate=3{clientConfig=1{captionConfig=9{lang_1,lang_2}}, updateMask=2{paths=["client_config.caption_config"]}}}）と、ACK連番+1／+2の小フレーム（envelope(1).ack(1){seq=2, ok=3}）2つを、media-sessionチャネルへ**1チャネルにつき1回だけ**書き込む。再試行・Meet送信の書換えはしない。recoverでは書き込まず、元がassistedだった場合だけ字幕OFFを許容する。形式はTactiq 3.1.7185の静的解析（実行なし）による。media-sessionが特定できない／言語未観測／送信失敗は `MEDIA_SESSION_NOT_FOUND`／`CAPTION_LANGUAGE_UNKNOWN`／`CAPTION_ENABLE_FAILED`。**実Meetで未検証。連番の衝突などでMeetの制御通信を乱す恐れがあり、字幕設定がMeet側に残り得る。**非機密のテスト会議でのみ確認する。

snapshot.js の readCaptions は自作の凍結APIだけを呼ぶ。discoverはmetadata、startは所有者付き取得、readはsnapshotとlease更新、resetは一致する所有者だけを解放する。検査対象host／top frame／会議一致をAPIアクセス前に確認する。旧DOMのCAPTION_ROWS_NOT_FOUND経路は削除した。

**Teams（通話の字幕イベントの傍受・試験版）。** `teams-hook.js` は teams.microsoft.com／teams.live.com／teams.cloud.microsoft のtop frame（https）でだけMAIN/document_startに入る。v0.6〜v0.7.0のRTC `main-channel` 観測と、その後の画面字幕DOMの読取りは廃止した。Teamsのアプリが公開する通話の文脈（`window.msteamscalling` のWeakRef → `callingService.getActiveCall()`）から、データチャネルの購読 `remoteUserEventsReceived` のハンドラを探す（見つからなければ `TEAMS_CALL_NOT_FOUND`）。**開始後だけ**そのハンドラを包み、種別 `"3"` のJSON（`recognitionResults[]`、`timestampAudioSent`・`userId`・`text`）を読む。元のハンドラは常に呼び（例外はページへ伝えない）、終了・期限切れ・通話終了で元に戻す。包む前・停止後は何も処理しない。字幕の開始（`startClosedCaption()`）はせず、利用者がTeamsでONにする。話者は `userId`（内部ID）を出現順に匿名番号化し、名前は通話の参加者情報（`participants[].mri` → `displayName`）から、取れなければ匿名のまま。`timestampAudioSent` は数値（大きな整数を含む）または数字の文字列、各話者の最初の発話と、それ以前・同時刻の発話とその修正は履歴として送らない。使えない項目（必須項目の欠落・不正な型）は個別に捨てて数え、使える項目が1つもないまま50件を超えたときだけ `CAPTION_FORMAT_UNKNOWN` で停止する。通話が終われば `TEAMS_CALL_ENDED`。会議IDはURLで特定できないため `<host>/call` 固定で、lease・所有者・recoverはMeetと同じ。**呼び出しの構造と形式はTactiq（解析）の仮定で、実Teamsでは未検証。**Teamsの更新で構造が変わると見つからず停止する。

**Zoom（字幕の内部状態の購読・試験版）。** `zoom-hook.js` は app.zoom.us のtop frame（https）で、会議ページ `/wc/<5〜15桁>/…` にだけ入る（他の *.zoom.us は `PLATFORM_NOT_IMPLEMENTED`）。会議IDは `app.zoom.us/wc/<番号>`。v0.7.0の画面字幕のDOM読取りは廃止した。アプリのReact木（`#webclient` iframe、`.pwa-webclient__iframe-wrapper iframe`、なければトップ文書）の `__reactContainer*` からたどり、`props.store`（`getState`／`subscribe`／`dispatch`を持ち、状態に `newLiveTranscription` があるもの）を探す（見つからなければ `ZOOM_STORE_NOT_FOUND`）。**開始後だけ**そのストアを `subscribe` し（読み取りのみ、dispatchもreducerの差し替えもしない）、`newLiveTranscription.newLTMessage`（msgId → `{ user: { zoomID, displayName }, text }`）の変化を読む。開始時にあるメッセージとその後の変化は履歴として送らない。`msgId/zoomID` を発話ID、本文の変化を改訂として扱う。本文は先頭の改ページ・NUL・置換文字を除く。使えない項目は個別に捨てて数え、使える項目がないまま50件を超えたときだけ停止する。話者名はメッセージの表示名。lease・所有者・recoverはMeetと同じ。**ストアの構造はTactiq（解析）の仮定で、実Zoomでは未検証。**Zoomの更新で構造が変わると見つからず停止する。

**Claude Code以外のエージェント（omp・pi・agy）。** 受信口（`127.0.0.1:43821`）と拡張からのPOSTは共通で、セッションへ渡す部分だけが違う。omp・pi：`integrations/pi/live-support.js`（同じ拡張API）が、セッション開始時にエージェントの中で `server/bridge.js` の受信口を開き、トークンを更新し、各バッチを `sendMessage({ customType: "live-support" }, { deliverAs: "followUp", triggerTurn: true })` で渡す（最初のメッセージに `server/instructions.js` の説明を付ける）。送信に失敗すれば503でパネルが再送する。子セッションは受信口を二重に開かず、終了時に閉じる。agy：`LIVE_SUPPORT_TOOLS=1` のMCPサーバーが、Channelsの通知の代わりに最新200件のバッチを保持し、`get_captions`（`after` のカーソル、1回約200KBまで）で返す。いずれもClaude Code用の読取り専用の制限は再現しない。詳しくは [other-agents.md](docs/other-agents.md)。

正のsigned-int64（1〜2^63-1）の発話IDはBigIntで正確に比較し、氏名や一致した本文からIDを推測しない。既知IDの修正はupsert。遅れて届いた古いIDは新しい発話として扱い、同じ版で本文が新しければ置き換え、古い版は採用しない（停止しない）。詳しいwire根拠・条件は [native-captions.md](docs/native-captions.md) を参照。

`hook-core.js` は全プラットフォーム共通の所有者・lease・終了状態・recoverの前提確認・コマンドの封筒だけを持ち、本文には触れない。manifestの各エントリは `js: [hook-core.js, <platform>-hook.js]` の順で、各hookがコアを一度だけ受け取って即座に消す（ページのスクリプトからは到達できず、コアが無いhookは何も入れない）。実Chromeでの拡張ロード時の実行順は未確認。

panel.jsは同意・UI・世代管理・heartbeat・蓄積・HTTP、stream.jsは差分／再送、devtools.jsは非表示停止。bin、server、Skillの既存責務とreadonly設定は維持する。

## 6. HTTP／Channels契約

bind先はloopbackのみ。`Authorization: Bearer <pairing-token>` が必要です。Hostは実際の `127.0.0.1:<port>` と一致、Originがあれば `chrome-extension://<32文字ID>` 形式だけ許可します。Origin形式だけを認証として信頼しません。一般webサイトへCORSを開放しません。

- `GET /health`：MCP初期化済みなら200、未初期化なら503。bodyは空。
- `POST /screenshots?sessionId=<UUID>&sequence=<n>`：会議画面のJPEG（`image/jpeg`、先頭がJPEGのマジックバイト、2MiBまで、Content-Encodingは不可）。同じ `sessionId`・`sequence` のバッチの**直前**に送る。受信側は専用ディレクトリ（`~/.live-support-screens`、0700。ファイルは0600。ランタイムのディレクトリの外）へ保存し、そのバッチのイベントに `screenshot`（絶対パス）を足す。新しい30枚だけ保持し、受信側の停止時と `live-support claude` の起動時に全削除する。ディレクトリを設定しない受信側（`screenshots: null`）では404。
- `POST /captions`：`application/json` のみ、Content-Encodingは不可。次は架空の例。

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "sequence": 1,
  "meetingId": "demo-meeting",
  "platform": "Google Meet",
  "updates": [{
    "messageId": "demo-row-1", "messageVersion": 1,
    "speakerName": "Demo", "transcript": "ダミー字幕",
    "timestamp": 1000, "version": 1
  }]
}
```

| 項目 | 条件 |
| --- | --- |
| sessionId／sequence | UUID、1から始まる正のsafe integer |
| meetingId | 1〜512文字、同sessionで固定 |
| platform | schemaはGoogle Meet／Zoom／Teams。reader実装はMeet・Teams・Zoom（Webクライアント） |
| updates | 1〜64件 |
| messageId／deviceId | 1〜512文字。発話は区間内ローカルID、deviceIdは匿名話者ID（schemaでは任意）。speakerNameは表示名（最大64文字に整形）または匿名ラベル |
| messageVersion | 0以上のsafe integer。解釈できるprovider revision |
| speakerName／transcript | 1〜256文字／0〜32768文字 |
| timestamp／version | 非負有限数。timestampは採用時の受信Date.now()、versionはprovider revision。音声の生成／開始時刻ではない |

列挙外のtop-level／blockフィールドは拒否。成功202はSDK通知の書出し成功であり、AIの受領・理解・応答完了ではありません。

エラー：400 JSON／schema、401 token、403 Host／Origin、404 path／method、409 sequence・同番号異内容・会議変更、413 body上限、415 Content-Type／Encoding、429 session上限、503 MCP未初期化／通知失敗。

MCP capabilityは `{ "experimental": { "claude/channel": {} } }`。通知methodは `notifications/claude/channel`、`params.content` はJSON文字列（meetingIdとupdates、`<>&`はUnicode escape）、`params.meta` は文字列の `platform`／`session_id`／`sequence`。返信ツールやpermission承認capabilityは持ちません。session_idとmessageIdでupsertし、字幕は命令・承認として扱いません。

## 7. 差分・再送・上限

同意後のMessageEventだけを処理し、信頼されない合成event・対象外チャネルは本文に触れず無視する。各話者の初回ID以前を除外し、採用した新IDと修正をメモリにupsertする。HTTP待ち中も取得を続け、約5秒で一バッチ送る。

成功後だけbaseline／sequenceを進める。失敗・5xxでは**同じ未確認バッチ**を先に再送する。サーバーは直列化し、session sequenceとbody digestで直前の同一配送を再通知しない。pause／stopは未送信分を破棄し、永続キュー・再起動をまたぐ重複抑止は保証しない。

| 項目 | 値 |
| --- | --- |
| heartbeat／send／lease | 約1000／5000／2000 ms |
| RTC候補／既知チャネル | 最大16接続、接続ごと最大32 |
| wire／展開後 | 各262144 bytes。gzipはlegacy profileのみ |
| wire構造 | 各message最大64 fields、既知構造だけ最大3層 |
| 処理待ち／話者 | 最大8 frames／256話者 |
| captureをまたぐ実行中読取り | 最大1件。終了するまで新capture不可 |
| own-v2 ACK送信待ち | bufferedAmount＋次のACKで最大16384 bytes |
| source・panelバッファ | 各最大4000 IDs／本文計200万文字 |
| block／batch | 本文32768文字、最大64更新／block JSON計240000 bytes |
| fetch timeout | 8000 ms |
| HTTP body／request・header timeout | 262144 bytes／各10000 ms |
| keep-alive／同時接続／session保持 | 1000 ms／16／1プロセス最大32 |

Meetのデコードはprotobufの意味に従い（未知のfieldは読み飛ばし、重複fieldは最後の値、0の値はwireに現れない＝版の欠落は0）、字幕として使えないフレーム（発話なし・話者IDなし・IDが範囲外・形式不正・非バイナリ）は捨てて理由別に数え、**チャネルごとに、使えるフレームが1つもないまま50件を超えたらそのチャネルだけ放棄し**（まだ自前の購読を作っていなければ1回だけ作り）、**使えるチャネルが1つも残らないときだけ** `CAPTION_FORMAT_UNKNOWN` で停止する（理由の件数と、最初の使えないフレームの構造＝field番号とwire型だけがパネルに出る。本文は含まない）。256KB超のフレームと上限超過は `CAPTION_LIMIT` で停止する。大量の差分は後続のsend tickになる。長時間運用では保持上限に達し得る。

保存先は ~/.live-support/（0700）、tokenは0600。symlink・公開権限は拒否する。setup／tokenは有効な既存tokenを再利用し、claude起動時だけ原子的に更新。tokenコマンドだけが値を明示表示し、通常ログ・ブラウザの永続storageには残さない。パネルだけが、受信サーバーに受理されたtokenを `chrome.storage.session`（メモリのみ・ブラウザ終了で消える・拡張の信頼コンテキスト限定）に記憶し、401／403で消す。tokenはMAIN worldへ渡さない。

LIVE_SUPPORT_RUNTIME_DIRは保存先、LIVE_SUPPORT_PORTはserver portの開発用override。**パネルとCSPは43821固定**。MCP設定へtokenを埋め込まない。

## 8. 診断・更新

| コード／症状 | 対処 |
| --- | --- |
| RTC_HOOK_NOT_READY | Meetサイトアクセスを本人が許可し、拡張更新後にMeetタブを参加前から再読み込み |
| RTC_CONNECTION_NOT_FOUND | Meet：会議参加・標準字幕ON・参加前注入を確認。後から既存接続を見つける保証はない |
| TEAMS_CALL_NOT_FOUND／TEAMS_CALL_ENDED | 会議に参加しライブキャプションをONにして「再確認」。見つからない場合はTeamsの内部構造の変更を疑う。通話終了で停止 |
| ZOOM_STORE_NOT_FOUND | 会議に参加し字幕（ライブトランスクリプション）をONにして「再確認」。見つからない場合はZoomの内部構造の変更を疑う |
| RTC_CONNECTION_AMBIGUOUS | 接続を特定できないため取得しない |
| RTC_PREPARE_FAILED／RTC_RESOURCE_LIMIT | 他の字幕拡張との競合・管理ポリシー・上限を確認。安全機能を無効化しない |
| CAPTIONS_OFF／CAPTION_CONTROL_NOT_FOUND | Meet標準字幕をON、日本語／英語UIの状態を確認。OFFのまま使うなら実験オプション |
| MEDIA_SESSION_NOT_FOUND／CAPTION_LANGUAGE_UNKNOWN／CAPTION_ENABLE_FAILED | 実験オプション専用。制御チャネル未特定／言語未観測／送信失敗。再試行せず、字幕をONにするかページ再読み込み |
| CAPTION_SUBSCRIPTION_FAILED | チャネル作成失敗。字幕・組織設定・拡張競合を確認 |
| CAPTION_FORMAT_UNKNOWN | 未対応wire。本文／生パケットを共有せずコードと件数を報告 |
| CAPTION_DECODE_BUSY | 前の取消不能読取りの終了待ち。待って再確認、止まる場合は非機密テストでページ再読み込み |
| CAPTION_ACK_BACKLOG_LIMIT | 自分のACK出力上限。自分の購読だけ閉じて停止、通信状態を確認 |
| CAPTURE_EXPIRED | heartbeat途絶で破棄。同じ会議へ自動復旧（欠落あり）。復旧が拒否されれば停止 |
| CAPTION_CHANNEL_CLOSED／RTC_CONNECTION_CLOSED | 接続終了。自動では再購読しない |
| CAPTION_LIMIT／CAPTION_BACKLOG_LIMIT／CAPTURE_BUFFER_LIMIT | 無言で削らず停止。非機密fixtureで確認 |
| HTTP401／409／429／503 | 新token、系列不一致、session上限、MCP初期化を確認 |
| 受信はあるが採用0 | 各話者の初回ID以前は除外。次のIDから確認 |
| HTTP成功でもAIに来ない | channelとしての有効化、Claude認証／組織設定を確認 |
| launcher.lock | 前のプロセス終了を確認。クラッシュ時だけ本人が削除。稼働中に消さない |

表示するのは既知コードと接続／字幕ch／受信／初回ID除外／採用の整数件数だけ。任意の例外details・生bytes・文字起こしは表示しない。会議URL、タイトル、本文、話者名、token、全DOM、HARを不具合報告へ貼らないこと。

旧CAPTION_ROWS_NOT_FOUNDはv0.4のDOM方式。現在は字幕の子要素数に依存しない。更新は転送／ランチャー停止 → 再インストール → setup → 拡張再読込み・Meetサイトアクセス確認 → **Meetタブを参加前に再読み込み** → DevTools開き直し。削除はnpm uninstall --global live-support。ランタイムとChrome登録は自動削除しない。

## 9. 安全性と受入確認

追加アクセスはcontent_scripts.matchesの **https://meet.google.com/**（v0.5）、Teams 3ホスト（**https://teams.microsoft.com／teams.live.com／teams.cloud.microsoft**、v0.6）、**https://app.zoom.us/**（v0.7）だけ。いずれも静的で、実行時の追加許可ダイアログは使わない（本人の指示）。Meetは実装前に本人がサイトアクセスと、必要時の字幕DataChannel購読・own-v2 ACKを個別承認した。Teams／Zoomは本人の「Zoom／Teams対応に進む」依頼による追加で、TeamsとZoomは表示字幕の読取りのみ（購読・送信・書込みなし）。実Chromeでの許可は本人操作であり、この承認で組織ポリシーやChrome警告を迂回しない。拡張APIの権限は `storage`（パネルがtokenを`chrome.storage.session`へ記憶するためだけ。UI改善依頼で追加、実Chrome未検証）のみ。tabs／scripting／debugger／全サイト／音声権限は追加しない。 **v0.8の画面スクリーンショット：** 同じ5サイトを `host_permissions` にも静的に置き（`captureVisibleTab` に必要。`tabs`・`activeTab`・`debugger`・`<all_urls>` は使わない）、`background.js`（service worker）だけが、パネルの依頼で、**そのタブがウィンドウの前面にあるとき**に撮る（前面でなければ、他のタブの写真を撮らず、撮らない）。画面共有の資料・参加者の顔・名前・チャットが写り得て、Anthropicへ送られる。パネルのチェック（既定ON、開始時に固定）で止められる。パネルが長辺1280px・JPEG品質0.6へ縮小し、前回から変わっていない画面は送らない。取得・送信の失敗は字幕の送信を止めない。

MAIN worldはページと同じJS環境で、OS／ページ隔離のsandboxではない。transport tokenは拡張パネルにのみ保持する。字幕・話者情報は非信頼データとして扱い、命令・ツール権限承認には使わない。自作channelの停止は元の会議接続を停止しない。

ブリッジは本文をログ・ファイルへ保存しないが、ページ・パネルのメモリやClaude／Anthropic側には残り得る。転送字幕と参照資料の外部送信同意を別に確認する。受信時刻／初回IDの除外は、生成時刻での完全な区間分離ではない。

非機密の本人管理会議での受入項目：早期注入、標準字幕ON/OFF、購読と実際のwire互換、初回ID／修正の非転送、新ID／修正の受信、pause／stop／非表示／移動／lease、元の字幕・音声・会議が維持されること、氏名の非推測、AIの根拠と未確定事項、実Claudeでの秘密・dir外Read拒否と編集／Shell非公開、助言停止と転送停止の区別。TeamsとZoomは字幕の表示が必要で、Teamsはセレクタ・話者ラベルの構造、Zoomはセレクタ・iframe構造・話者のアバター同一視が実機で成立するかも確認する。

## 10. 開発・検証資料

```bash
npm ci --ignore-scripts
npm test
npm audit --omit=dev
```

Node標準test runner。合成protobuf／gzip／不正・上限・signed-int64境界・consent／lease／owner／遅延結果、panelとreadonly CLI、実HTTP／SDK MCP、再送／EOF、packing／隔離導入を検証する。

実Chromeテストは独立した一時profileとfile fixture、テスト用Meet／Teams／Zoom URL stub（Teams・Zoomは合成の通話オブジェクト・store）を使い、**実際の2つのRTCPeerConnection**で合成バイナリを送受信し、own ACK・停止・leaseとHTTP/MCP通知を確認する。実Meetやアカウントは使わない。Chromeがなければskipするため、その場合はブラウザ確認済みと報告しない。

**実Meetの現行wire、document_start拡張の実ロード／サイトCSP、実DevToolsから実会議、実Claude／Haikuのモデル受信・権限強制、長時間の精度・欠落率・費用は未確認**。ローカルRTC成功はこれらの代替証拠ではない。

- [README](README.md)／[wire根拠・制限](docs/native-captions.md)／[REAレポート](docs/rea-analysis-report.md)
- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)／[manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- [Chrome inspectedWindow](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)
- [Claude Channels](https://code.claude.com/docs/en/channels)／[reference](https://code.claude.com/docs/en/channels-reference)
- [Claude Skills](https://code.claude.com/docs/en/skills)／[CLI](https://code.claude.com/docs/en/cli-reference)／[permissions](https://code.claude.com/docs/en/permissions)
