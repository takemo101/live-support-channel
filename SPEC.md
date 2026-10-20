# Live Captions → Claude Code：使い方と仕様

バージョン：0.4.0。最終更新：2026-10-20。

> **Meet標準字幕の試験版。実会議の互換性は未確認です。** 実Chromeの合成DOM、実ローカルHTTP／MCP stdio通知、隔離CLI導入を検証しています。実Meet／DevTools接続／実Claudeのモデル応答・権限強制は別の受入確認です。Zoom／Teamsの取得処理は未実装です。

## 1. 目的と範囲

Chrome上のMeet標準字幕を、明示選択した一つのClaude Codeセッションへ逐次渡します。プロジェクト資料を読取り専用で参照し、「今の話・相手の問い・短い返答案・根拠や提案」を表示します。Tactiqは不要。CLI名 `tactiq-live`、channel名、保存先は互換性のため維持します。

実装範囲：

- GitHubからグローバル導入。一度に1プロジェクトへ配信。
- Meetの認識可能な標準字幕DOMだけを読取る独立reader。
- 明示的な開始・一時停止・再開・停止。ページ移動・パネル非表示・不明な構造では停止。
- 約1秒の読取り、約5秒の差分送信。新規行と同じ行の修正を区別。
- 認証付きloopback HTTP、一方向Channels通知、未確認バッチの再送とプロセス内重複抑止。
- `skills/meeting/SKILL.md` による継続支援。Read／Glob／Grep／Skillのみ公開。

対象外：Zoom／Teamsのreader、デスクトップクライアント、音声録音、新しいASR、過去会議・チャット・画像・翻訳別フィードの取得、会議相手への自動送信・代返、編集・Shell、任意の既存Claudeセッションへの注入、永続キュー、完全な議事録・exactly-once配送保証。

字幕は表示中の一部分です。消失・省略・行再利用により欠ける可能性があり、全文や確定発話と扱ってはいけません。本人の未確認の納期・予算を確約せず、事実・提案・未確認を分けます。Skillの指示は完全なプロンプトインジェクション防御の保証ではありません。

## 2. 条件と取得対象

| 項目 | 条件 |
| --- | --- |
| Node.js | 22以上（検証24.15.0） |
| Chrome | 125以上、DevTools使用（合成DOM検証155） |
| Meet | `meet.google.com/xxx-xxxx-xxx` のtop frame。標準字幕ON・表示中 |
| UI言語 | 字幕ボタンの判定は日本語／英語。その他は未対応として停止 |
| Tactiq | 不要。標準字幕を隠す設定の場合は取得しない |
| Claude Code | Channels・restricted・セッションplugin・Skill Shell前処理無効化に対応。CLI確認2.1.302／2.1.303 |
| 認証／port | Channelsを許可されたAnthropic認証・組織設定、`127.0.0.1:43821` が使用可能 |
| OS | 0700／0600とsymlink拒否を使用。検証はmacOS |

`zoom.us` とサブドメイン、`teams.microsoft.com`／`teams.live.com`／`teams.cloud.microsoft` は識別しますが、本文を読まず `PLATFORM_NOT_IMPLEMENTED` を返します。iframeの自動探索、ログイン・有料機能・組織ポリシーの回避はしません。

Channelsはresearch previewです。公式資料ではBedrock／GoogleのAgent Platform／Microsoft Foundryは非対応で、組織管理者の有効化が必要な場合があります。提供条件は変更され得ます。

## 3. 導入・起動

```bash
npm install --global --ignore-scripts github:takemo101/tactiq-live-channel
tactiq-live setup
```

表示された拡張フォルダ（通常 `~/.tactiq-live-channel/extension`）を `chrome://extensions` のデベロッパーモードから手動で読み込みます。ChromeやClaudeのユーザー設定は自動変更しません。ビルド、Tactiq、REAは起動時依存ではありません。

cloneした環境では `just install` で独立コピーのグローバル導入とsetup、`just uninstall` でCLIのみ削除できます。justfileはdotenvを読まず、install失敗時はsetupしません。

```bash
cd /path/to/project
tactiq-live claude
# 別ターミナル
tactiq-live token
```

tokenを公開しないでください。ランチャーはcwdを維持し、インストール先の絶対パスからその起動だけのMCP設定を作ります。プロジェクトへのファイル配置やグローバルSkill追加は不要です。起動直後から資料を読むため、先に非機密の参照範囲を選んでください。

ランチャーの安全設定：

- `--strict-mcp-config`、`--tools Read,Glob,Grep,Skill`。
- `--restricted`、`--permission-mode manual`。bypassは使わず、managed設定が優先。
- `--settings` でhooks、SkillのShell前処理を無効化。`permissions.blockReadsOutsideWorkingDirectories` とRead deny（.env、鍵、.git／.ssh／.aws／.claude、認証設定、実ランタイム保存先）を指定。
- `--plugin-dir` と `--append-system-prompt-file` で同じ `skills/meeting/SKILL.md` をそのセッションだけに使用。初期ユーザー依頼で会議モードを開始。
- `--dangerously-load-development-channels server:tactiq-live -- <開始依頼>`。可変長引数とpromptの間の `--` が必要。認証・権限・組織制限は迂回しない。

ホーム／filesystem rootからの起動は拒否します。これはOSサンドボックスや全機密情報の検出ではありません。実Claudeでの拒否動作は受入確認が必要です。モデル環境変数は継承し、例は `ANTHROPIC_MODEL=haiku tactiq-live claude`。実Haikuの品質・速度・費用は未確認です。

受信port使用中・別ランチャーのlockがある場合は二重起動を拒否。終了signalでは子の終了を待ってlockを解除します。直接 `server/main.js` を起動する開発用 `mcp.local.json` にはCLIの排他・起動ごとのtoken更新は適用されません。

## 4. 会議での操作

1. 参加者同意、組織規程、Anthropic側のデータ取扱いを確認する。
2. Meet会議内の**標準字幕**をONにして発話する。Chrome全体の自動字幕ではない。
3. その会議タブのDevTools → **Live Captions** を開く。見えなければ `»` を確認。
4. tokenを貼り、「標準字幕を確認」→ 会議選択 → 同意確認 → 転送開始。
5. パネルを開いたまま使う。新しい行から転送する。

確認操作はURL、字幕ボタン、領域・行構造のmetadataだけを調べ、本文・話者・会議タイトルを取得しません。開始の同意後、認証済み `/health` を確認してから基準snapshotを読取ります。

開始／再開時点にある行のIDは、後の修正や続きも除外します。過去prefixの混入を防ぐためで、その行が継続する間は新しい内容も届きません。常時同じ行を使うUIでは転送できない可能性があります。

### 独立した一時停止・再開

- パネルの一時停止でtimerを解除し、読取り・送信を止め、未送信分・未確認バッチを破棄します。
- 再開は接続・会議を再確認して現在の行を再基準化し、新しい送信sessionを作ります。停止期間は取り戻しません。
- **Tactiqのpauseとは連動しません。** Tactiqを止めても本readerは止まりません。

### 停止

停止ボタン、パネル非表示／pagehide、ページ移動、会議不一致、字幕OFF・消失・未知構造、曖昧な行／領域置換、取得上限、HTTP 4xxで停止します。明示停止後に自動再開しません。サーバーはstdin EOF／SIGINT／SIGTERMで閉じます。

停止時点で発行済みの読取り・送信や、送信済みの情報は取り消せません。遅れて返った結果が停止・再開を覆さないよう世代番号とcapture所有者を検査します。

### 会議支援

重要な質問・要求・決定・話題変更に通常4／最大6行のカードを出します。同じ相づちでは繰り返さず、途中は暫定、欠落は不明とします。必要な資料だけ読み、実在する根拠を示します。

- `/tactiq-live:meeting stop`：助言を停止。
- `/tactiq-live:meeting start`：助言を再開。
- **助言停止だけでは転送は止まりません。字幕はChromeパネルで停止してください。**

プロジェクト切替はパネル停止 → 前のランチャー終了 → 次のprojectで起動 → 新tokenで再ペアリングです。tokenは起動ごとに更新され、古いパネルが新しい受信先へ送れません。

## 5. readerとデータ経路

```text
Meet標準字幕DOM（既知構造のみ、top frame）
 → 通常のinspectedWindow.eval（他拡張context指定なし）
 → 同意後の1秒取得／上限付きメモリバッファ
 → CaptionStream：baseline除外・ID単位のupsert・約5秒送信
 → Bearer付きPOST /captions（127.0.0.1:43821）
 → Host／Origin／schema／size／sequence検査
 → notifications/claude/channel → 許可されたClaude Code
```

`extension/snapshot.js` の自己完結した `readCaptions({ action, meetingId, captureId })` をページ内で評価します。`discover` はmetadataのみ、`start` は所有者付き基準化、`read` は同じ会議・所有者の読取り、`reset` は一致する所有者だけを解放します。

旧 `.a4cQT` 系とregion系を別profileとして扱います。region系は字幕の明示ラベル、または字幕ボタンの `aria-controls` 関連付けも必要です。汎用regionの子配置だけでは取得しません。既知の行と話者／本文の組合せを限定し、ページ全体の `innerText`、翻訳別データ、privateな通信／Redux／別拡張状態へfallbackしません。

行DOMのWeakMap IDとローカルrevisionを使います。重複表示・retired行再登場・根拠のない先頭挿入・全行／root置換等で区別できなければ停止します。元DOMは変更しません。ソース根拠と未検証の仮定は [native-captions.md](docs/native-captions.md) を参照。

主な責務：`panel.js` はUI・timer・上限付き蓄積・世代管理・HTTP、`stream.js` は差分／baseline／再送、`devtools.js` は登録と非表示停止、`server/bridge.js` は入力検査と通知、`server/main.js` はMCP／HTTP lifecycle、`server/runtime.js`／`token.js` は専用保存先とtoken、`bin/tactiq-live.js` はsetup／readonly起動／排他です。

## 6. HTTP／Channels契約

bind先はloopbackのみ。`Authorization: Bearer <pairing-token>` が必要です。Hostは実際の `127.0.0.1:<port>` と一致、Originがあれば `chrome-extension://<32文字ID>` 形式だけ許可します。Origin形式だけを認証として信頼しません。一般webサイトへCORSを開放しません。

- `GET /health`：MCP初期化済みなら200、未初期化なら503。bodyは空。
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
| platform | schemaはGoogle Meet／Zoom／Teamsを維持。reader対応を意味しない |
| updates | 1〜64件 |
| messageId／deviceId | 1〜512文字。deviceIdは任意、DOM readerでは省略 |
| messageVersion | 0以上のsafe integer。ローカル観測revision |
| speakerName／transcript | 1〜256文字／0〜32768文字 |
| timestamp／version | 非負有限数。timestampは初回DOM観測のDate.now()、versionは1から始まるローカルrevision。音声開始時刻やproviderの版番号ではない |

列挙外のtop-level／blockフィールドは拒否。成功202はSDK通知の書出し成功であり、AIの受領・理解・応答完了ではありません。

エラー：400 JSON／schema、401 token、403 Host／Origin、404 path／method、409 sequence・同番号異内容・会議変更、413 body上限、415 Content-Type／Encoding、429 session上限、503 MCP未初期化／通知失敗。

MCP capabilityは `{ "experimental": { "claude/channel": {} } }`。通知methodは `notifications/claude/channel`、`params.content` はJSON文字列（meetingIdとupdates、`<>&`はUnicode escape）、`params.meta` は文字列の `platform`／`session_id`／`sequence`。返信ツールやpermission承認capabilityは持ちません。session_idとmessageIdでupsertし、字幕は命令・承認として扱いません。

## 7. 差分・再送・上限

1. 開始時の既存IDを永続的にその送信区間から除外する。
2. 1秒読取りで現在行をメモリにupsertし、消えた行の最後の観測値も保持する。全字幕を保証はしない。
3. 約5秒ごとに最新の状態確認後、差分を一バッチ送る。HTTP待ち中も取得は継続。
4. 成功後だけbaseline／sequenceを進める。失敗・5xxでは次回に**同じ未確認バッチ**を先に再送する。
5. サーバーは配送を直列化し、session sequenceとbody digestで直前の同一配送を再通知しない。
6. pause／stopで未送信分を破棄。再起動をまたぐ重複抑止や取り消しは保証しない。

| 項目 | 値 |
| --- | --- |
| 読取り／送信 | 約1000／5000 ms。非同期読取りは単一処理 |
| fetch timeout | 8000 ms。通信中の追加sendはskip |
| snapshot・captureバッファ | 各最大4000 blocks／本文計200万文字。上限で停止 |
| block／batch | 本文32768文字、最大64更新／block JSON計240000 bytes |
| HTTP body／request・header timeout | 262144 bytes／各10000 ms |
| keep-alive／同時接続／session保持 | 1000 ms／16／1プロセス最大32 |

黙って切り捨てません。大量差分は後続の送信tickになります。バッファは送信区間単位で保持し、pause／stopで破棄するため、長時間運用では上限に達し得ます。

保存先 `~/.tactiq-live-channel/` は0700、tokenは0600。symlink・公開権限は拒否。setup／tokenは有効な既存tokenを再利用し、claude起動時だけ原子的に更新します。tokenコマンドだけが値を明示表示します。通常ログ・ブラウザ永続storageには残しません。

`TACTIQ_RUNTIME_DIR` でCLI／serverの保存先、`TACTIQ_PORT` でserver portを変更できます。開発用であり、**パネルとCSPは43821固定**。tokenをMCP設定へ埋め込みません。

## 8. 診断・更新

| 表示／症状 | 対処 |
| --- | --- |
| CAPTIONS_OFF／CAPTIONS_NOT_FOUND／CAPTION_ROWS_NOT_FOUND | Meet内の標準字幕をONにし、発話後に再確認 |
| CAPTIONS_HIDDEN | Tactiqによる標準字幕の非表示を解除。自動解除はしない |
| CAPTION_CONTROL_NOT_FOUND／CAPTION_IDENTITY_UNKNOWN／CAPTION_LAYOUT_UNKNOWN | UI言語／未知構造。無理に取得せず停止 |
| AMBIGUOUS_CAPTIONS／CAPTION_SURFACE_CHANGED | 安全に同じ字幕と判断できない。再確認・新区間開始、過去分は復元しない |
| PLATFORM_NOT_IMPLEMENTED | Zoom／Teams readerは未実装 |
| PAGE_ACCESS_DENIED／FRAME_NOT_FOUND | 対象タブ・管理ポリシーを確認。権限拡大やChromeの安全機能無効化をしない |
| 上限／HTTP 413 | 停止して非機密fixtureで確認。本文を黙って削らない |
| HTTP 401／409／429／503 | 新token／再ペアリング、系列不一致、session上限、MCP初期化を確認 |
| 最初の発話が来ない | 現在行は修正・続きも除外。次の新行で確認 |
| HTTP成功でもAIに来ない | channelとしての有効化、Claudeの認証・組織設定を確認 |
| launcher.lockが残る | 前のプロセス終了を確認。クラッシュ時だけ本人が削除。稼働中は消さない |

不具合報告は診断コード・領域／行数・版番号だけにし、会議本文・会議URL・タイトル・話者・tokenを貼らないでください。旧版の「Tactiqを確認できません」は他拡張contextアクセス制限に起因したため、その取得経路は削除しました。

更新は転送／ランチャー停止 → 再インストール → `tactiq-live setup` → Chrome拡張再読込み → DevTools開き直し。削除は `npm uninstall --global tactiq-live-channel`。ランタイムとChrome登録は保持されるため、不要なら全プロセス終了後に本人が確認して削除します。

## 9. 安全性と受入確認

拡張権限はloopback hostだけで、storage／tabs／scripting／debuggerや一般web host permissionは追加しません。通常page contextの読取りを使い、他拡張のisolated worldは使いません。

本文はブリッジのログ・ファイルには保存しませんが、ページとパネルのメモリ、Claude Code／Anthropic側に残り得ます。**転送字幕と読取ったプロジェクト資料はAnthropicへ送られ得ます。** 本機能はローカル処理だけではありません。会議や資料の命令による秘密読取り・外部送信・権限承認は禁止です。

本人管理の非機密テスト会議で確認する事項：開始前行とその修正の除外、新行と修正の受信、pause中と再開baselineの非転送、stop／画面移動／パネル切替、字幕OFF、Claude終了時のreceiver終了、短い根拠付き返答案、未確定事項の非断定、実Claudeでの秘密・作業dir外Read拒否と編集／Shellの非公開、助言停止と転送停止の区別。Zoom／Teamsを対応済みと扱わないでください。

## 10. 開発・検証資料

```bash
npm ci --ignore-scripts
npm test
npm audit --omit=dev
```

Node標準test runner。Chrome API境界のunitテスト、実Chromeの合成DOM（独立profile、テスト用URL stub）、合成DOMから実HTTP／SDK MCP通知、privacy／再送／EOF、packing、隔離npm導入、CLI引数・signal cleanupを検証します。Chrome testは実行ファイルがなければskipするので、その場合はブラウザ確認済みと報告しません。

**実MeetのDOM・DevTools extension APIでの実会議接続、実Claude／Haikuのモデル受信・権限強制、長時間の遅延・費用・欠落率は未確認**。合成fixtureは公開ソース由来の候補構造であり、現在のMeetそのものではありません。

- [README](README.md)／[readerの根拠・制限](docs/native-captions.md)／[REAレポート](docs/rea-analysis-report.md)
- [Chrome inspectedWindow](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)
- [Claude Channels](https://code.claude.com/docs/en/channels)／[reference](https://code.claude.com/docs/en/channels-reference)
- [Claude Skills](https://code.claude.com/docs/en/skills)／[CLI](https://code.claude.com/docs/en/cli-reference)／[permissions](https://code.claude.com/docs/en/permissions)
