# Live Captions → Claude Code

**Google Meetの標準字幕**をClaude Codeの**Channels**へ渡し、現在のプロジェクトを踏まえて「要点・相手の問い・口にできる返答案・事業／技術の提案」を短く出す試作です。**Tactiqは不要**です。CLI名 `live-support` と保存先は互換性のため維持しています。受信先は一度に1プロジェクトです。

| 取得対象 | 状態 |
| --- | --- |
| Google Meetブラウザ版 | 字幕DataChannel readerを実装。**試験版・実会議の互換性は未確認** |
| Microsoft Teamsブラウザ版 | 画面に表示されたライブキャプションの**読取りのみ**（Teams側でライブキャプションをONにする）。**試験版・実Teamsでの互換性は未確認** |
| Zoom Webクライアント（app.zoom.us） | **画面に表示された字幕のDOMを読む**（Zoom側で字幕を表示する）。**試験版・実Zoomでの互換性は未確認**。デスクトップ版は対象外 |
| デスクトップ版・音声録音・新規ASR | 対象外 |

Node.js 22以上、Chrome 125以上、Channelsと `--restricted` に対応したClaude Codeが必要です（CLI確認版2.1.302／2.1.303）。検証環境はmacOSです。

> **実会議では未検証です。** 隔離した実ChromeのローカルWebRTC接続で、合成字幕→デコード→実HTTP／MCP通知を検証しています。これは現在のMeetの通信形式、Chrome拡張の実ロード、Claude／Haikuの応答の保証ではありません。まず非機密のテスト会議で試してください。

## インストール（初回）

npmレジストリではなく、この公開GitHubリポジトリからインストールします。

```bash
npm install --global --ignore-scripts github:takemo101/tactiq-live-channel
live-support setup
```

`setup` が表示する拡張フォルダ（通常 `~/.live-support/extension`）を、Chromeの `chrome://extensions` → デベロッパーモード →「パッケージ化されていない拡張機能を読み込む」で**一度だけ**読み込みます。

**サイトアクセスはMeet・Teams・Zoomだけです（Teamsはv0.6、Zoomはv0.7）。** `https://meet.google.com/*`、`https://teams.microsoft.com/*`、`https://teams.live.com/*`、`https://teams.cloud.microsoft/*`、`https://app.zoom.us/*` に限り、MAIN worldの `document_start` でフックを準備します。Chromeではこのサイトのデータの「読み取りと変更」に相当します。準備中は本文を処理・保持・送信しません。Chromeへの権限許可・拡張読込みは本人操作で、ユーザー設定や組織ポリシーを自動変更しません。

## ソースからインストール（just）

このリポジトリを手元にcloneした場合は、Node.js／npmと[just](https://just.systems/)を用意して次を実行できます。

```bash
just install
just uninstall
```

`install` は手元のソースをnpmグローバル領域へ**独立したコピー**として配置し、そのCLIの `setup` でChrome拡張を準備します。Chromeへの手動読み込みは前述と同じです。`uninstall` はグローバルCLIだけを削除し、トークン・拡張の保存先とChromeの登録は残します。`just` 単体ではコマンド一覧を表示します。

## 各プロジェクトで使う

受信したいプロジェクトへ移動して起動します。

```bash
cd /path/to/your-project
live-support claude
```

別ターミナルで、その起動用の新しいペアリングトークンを確認します。

```bash
live-support token
```

**tokenをGitHubやチャットへ貼らないでください。** 次の順で操作します。

1. **会議参加前**に補助拡張とMeetへのサイトアクセスを準備する。更新後はMeetタブを再読み込みしてから参加する。
2. Meet内の**標準字幕をON**にする。Chrome全体の自動字幕ではありません。
3. そのタブのDevTools → `Live Captions` を開きます（準備は自動確認、会議は1件なら自動選択）。tokenを貼り、同意にチェックして「転送開始」。tokenは受信サーバーが受理した後、ブラウザを閉じるまで記憶されます（`chrome.storage.session`、ディスクに保存しません）。
4. パネルを表示したまま使う。上部のバッジで「取得中／自動復旧中／一時停止中／停止（要確認）」が分かります。

- 既存の字幕チャネルを観測し、必要時だけ会議接続に自分の字幕チャネルを追加してACKを返します。字幕ONの強制や元の通信内容の変更はしません。**例外は実験オプション「字幕ボタンがOFFでも開始」（既定OFF）だけ**で、ONにするとMeetの制御チャネル（media-session）へ字幕設定コマンドを1回書き込みます。Meet自身の送信は書き換えず、再試行もしません。Meetが送った字幕言語を一度観測できないと使えません。**実Meetでの動作は未確認**で、Tactiq 3.1.7185の静的解析で見えた形式に基づきます。字幕設定がMeet側に残る可能性があります。
- 約1秒のsnapshot／lease更新。送信はパネルの「転送のまとめ方」で選びます：**発話の区切りごと**（既定。字幕が3秒静かになったら、または最も古い未送信の変化が45秒に達したら）、約30秒ごと、約5秒ごと。失敗時は5秒空けて再送します。通信を待つ間も取得は継続します。
- 開始／再開後、**各話者の最初の発話ID以前を修正後も除外し、次IDから**送ります。最初の質問や長い発話が届かない場合があります。
- 生成時刻は確認できず、受信時刻とID順序を使います。遅配や履歴を完全に見分ける保証はありません。
- **話者の表示名を送ります**（Meet・Teams・Zoomとも、画面に表示されている名前。読み取れない間・曖昧なときは「話者1（名前未確認）」）。参加者一覧の取得や、表示名以外の個人情報の取得はしません。会議の相手の表示名もAnthropicへ送られるため、同意の確認が必要です。
- Meetは字幕通信に名前が無いため、画面に表示された字幕のうち**本文が一致し名前が1つに決まるものだけ**で名前を付けます（Meetの字幕を画面に表示している間だけ）。ZoomはビデオタイルのうちアバターURLが同じものの名前を使います。
- `/meeting` スキルは最初に**本人の表示名を確認**し、本人の発言は要約・返答カード・引用に含めません。
- **専用の一時停止・再開・停止**で制御します。Tactiqのpauseとは独立。未処理分を解放し、新しい本文に触れず、自分が追加したチャネルだけを閉じます。取消不能な処理最大1件が終わるまで新captureを拒否します。
- 字幕OFF・未知形式・接続終了・ページ移動・パネル切替で停止します。heartbeat途絶（約2秒のlease失効）は本文を破棄したうえで、同じ会議へ自動復旧します。ただし失効中の字幕と復旧後の各話者の初回ID以前は欠落し、話者番号は振り直されます。手動の停止・一時停止後は自動再開しません。
- 起動時に会議モードが始まり、必要なプロジェクト資料を読取り専用で確認します。字幕に重要な変化があると短いカードを更新します。5秒ごとのAI応答を保証する機能ではありません。

### 会議中の支援

Skillは [`skills/meeting/SKILL.md`](skills/meeting/SKILL.md) にあります。CLIがその起動だけにpluginとして読み込み、同じファイルを継続支援の指示にも使います。ユーザーの `~/.claude/skills/` や各プロジェクトへコピーしません。

```text
**要点**　山田さんが公開日を相談（暫定）。

**相手の問い**　山田さん：いつ公開できるか。

**返答案**
> 「影響範囲を確認してから、対応できる日程をお伝えします。」

**提案**
- 事業：日程は未確認。公開を優先するなら、先に依存作業の洗い出しを。
- 技術：影響は `SPEC.md` の「更新」節に依存。確認点は移行手順。
```

最初に会議で表示されている**本人の名前**を聞き、本人の発言はカード・要約・引用に含めません（名前が確認できるまで返答カードは出しません）。提案はプロジェクトの文書とコードを確認したうえで、事業・技術の観点から根拠付きで出します。役割・会議の目的を一言添えると、返答の提案を絞れます。仕様から確認できた事実と推測を区別し、納期や予算を本人に代わって約束しません。相づちだけなら同じ要約を繰り返しません。

- 助言を止める：`/live-support:meeting stop`
- 助言を再開する：`/live-support:meeting start`
- **字幕の転送を止める：Chromeパネルの停止ボタン。助言停止だけでは転送は止まりません。**

Haikuを選ぶ場合は `ANTHROPIC_MODEL=haiku live-support claude` と起動できます。実Haikuでの品質・速度・費用は未検証です。

### プロジェクトを切り替える

1. 補助パネルを停止する。
2. 前の `live-support claude` を終了する。
3. 次のプロジェクトで `live-support claude` を起動する。
4. `live-support token` で**新しい値**を取り直してペアリングする。

使用中のポートやランチャーの排他ファイルがあれば二重起動を拒否します。トークンは起動ごとに更新されるため、古いパネルが前のトークンで新しいプロジェクトへ送ることはできません。

## 安全性と制約

- 受信先は `127.0.0.1:43821` のみ。Bearer認証、Host／Origin、schema、サイズ、順序を検査します。
- トークン・拡張はプロジェクト外の `~/.live-support/` に置きます。トークンは0600、ディレクトリは0700。本文はブリッジのログやファイルへ保存しません。
- **転送した字幕と読取ったプロジェクト資料はClaude Codeを通じてAnthropicへ送信され、会話に残り得ます。** 起動直後から資料を読むため、非機密のプロジェクトを選び、会議参加者同意・組織規程・送信先のデータ取扱いを確認してください。
- 利用ツールは `Read,Glob,Grep,Skill` のみ。`--restricted`、`--strict-mcp-config`、手動承認モードを指定し、編集・Shell・外部送信ツールを有効にしません。hooksとSkillのShell前処理も無効にします。
- ファイルツールを作業ディレクトリ内へ制限し、`.env`・鍵・認証設定・ランタイム保存先等の読取りをdeny設定します。ホーム／filesystem rootからの起動は拒否します。これはOSサンドボックスや全秘密情報の自動検出ではなく、組織のmanaged設定が優先します。実Claudeでの権限拒否は受入確認が必要です。
- 自作Channelsには `--dangerously-load-development-channels server:live-support` の明示的な開発用許可が必要です。ランチャーが渡しますが、Claude側の認証・承認・組織制限を迂回しません。
- Channelsはresearch previewです。Bedrock／GoogleのAgent Platform／Microsoft Foundryは非対応との公式記載があります。
- HTTP 202はSDK通知の書出し成功であり、AIによる受領・理解・応答完了の保証ではありません。
- Meetの非公開な `captions`／`captions_v2` の形式に依存します。字幕ボタンの判定は日本語／英語UIが対象。未知の形式や接続は停止し、字幕本文をDOMから読むfallback・チャット・fetch／WebSocket・別拡張の内部状態へfallbackしません（話者名の照合にだけ、画面に表示された字幕リストを読みます）。
- Tactiq内部context経路と旧DOM readerは使用しません。Meet限定のサイトアクセスは追加しますが、全サイト・録音権限やChromeの安全機能無効化はしません。
- 停止時に処理中の読取り・送信、送信済みのデータは取り消せません。未送信分は破棄します。永続キュー・完全な議事録・再起動をまたぐexactly-once保証はありません。

## 更新・削除

転送とランチャーを止めてから再インストールし、`live-support setup` を実行します。Chromeで補助拡張を再読み込みし、Meet限定のサイトアクセスを許可して、**Meetタブも参加前に再読み込み**してください。参加済みの接続を後から発見する保証はありません。拡張の保存先は同じです。

```bash
npm uninstall --global live-support
```

アンインストールは `~/.live-support/` とChromeの読み込み登録を自動削除しません。不要なら全プロセス停止後に本人が確認して削除してください。

## 開発・資料

ソースから開発する場合はリポジトリのルートで実行します。

```bash
npm ci --ignore-scripts
npm test
node bin/live-support.js --help
```

- [使い方・CLI・データ形式・動作仕様：SPEC.md](SPEC.md)
- [字幕readerの根拠・制限・診断](docs/native-captions.md)
- [REAが分析に役立った点と限界](docs/rea-analysis-report.md)
- [会議支援Skill](skills/meeting/SKILL.md)
- [Claude Code Channels](https://code.claude.com/docs/en/channels) / [Channels reference](https://code.claude.com/docs/en/channels-reference)

Tactiq本体、解析JSON、ローカル調査scratch、トークンは配布物に含めません。実会議・実Claudeの受信を確認するまでは、非機密のテスト会議で利用してください。
