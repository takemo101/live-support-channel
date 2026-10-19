# Tactiq Live → Claude Code

Tactiqの**会議中の字幕更新**を、ローカルのHTTP受信 → Claude Codeの**Channels**へ渡す、最小の検証用Chrome DevTools拡張です。

対象：Google Meet／Zoomブラウザ版／Teamsブラウザ版。Tactiq **3.1.7185** の配布コードに基づきます。デスクトップ会議アプリは対象外です。

> **実会議では未検証です。** 自動テストはダミー字幕・Chrome API境界の模擬・実MCP stdio通信まで。Chrome上の別拡張context読取りと、実Claude CodeのChannels受信は導入時の手動確認が必要です。リアルタイム転送を実証済みとは扱わないでください。

## 方式と制約

- 生の字幕イベントは使わず、Tactiqのisolated worldで `window.tactiq.content.store.getState()` を**固定の読取り式**で確認します。Tactiqのコードや状態は変更しません。
- DevToolsの **Tactiq Liveパネルを開いたまま**、選択した会議だけを約5秒ごとに確認。Tactiq停止／一時停止／状態不明なら送らず、ページ移動・パネル切替・明示停止で止まります。
- 開始時／一時停止後の最初のsnapshotにある発話IDは、その後に修正されても送りません。過去の本文が修正版に混ざるのを防ぐため、**次の新しい発話から**転送します。開始直後／再開直後の進行中の発話は欠けます。
- Tactiqの処理済み状態なので、置換・話者・チャット除外等の後段処理を尊重します。翻訳、画像、ページリンク、チャットの転送は実装しません。
- 発話はmessageIdとdeviceIdでupsert。同じ発話の修正をすべて新規行として扱いません。
- SDKが通知を書き出せた時点でHTTP 202を返します。**AIによる読取り・理解の完了保証ではありません。**
- 非公式のTactiq内部構造に依存します。更新・iframe配置・stageやblock形式の違いで読めない場合は停止します。DOMスクレイピングや認証の回避へ自動fallbackしません。

- [使い方・データ形式・動作仕様：SPEC.md](SPEC.md)
- [REAが分析に役立った点と限界](docs/rea-analysis-report.md)

Tactiq本体・解析JSON・ローカル調査scratchは公開対象に含めていません。

## 導入前に確認

1. 会議参加者の同意、組織規程、Claude/Anthropic側の保存・学習ポリシーを確認してください。開始後の字幕はClaude Codeを通じて**Anthropicへ送信**されます。
2. Claude Code Channelsはresearch previewです。Anthropic認証に対応し、Bedrock／GoogleのAgent Platform／Microsoft Foundryは非対応との公式記載があります。組織では管理者の有効化が必要な場合があります。
3. 自作channelは開発用の明示的opt-inが必要です。以下の `--dangerously-load-development-channels` はその許可であり、認証やツール権限の迂回のためには使いません。
4. 既存セッションへ勝手に文字を入力する仕組みではありません。**このchannelを有効にして起動したClaude Codeセッション**が受信します。

公式：[Channels](https://code.claude.com/docs/en/channels) / [自作channel仕様](https://code.claude.com/docs/en/channels-reference) / [Chrome context指定](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow#method-eval)

## 起動手順（本人が操作）

### 1. 依存関係

Node.js 22以上が必要です。このワークスペースでは依存関係の導入と自動テストは済ませています。別の場所では：

```bash
npm ci --ignore-scripts
npm test
```

`mcp.local.json` の `server/main.js` は相対パスです。必ずこのリポジトリのルートを作業ディレクトリとして起動してください。設定を既存のMCP登録へ自動追加することはありません。

### 2. Claude Codeを起動

このフォルダから、本人の判断で実行してください：

```bash
claude \
  --mcp-config ./mcp.local.json \
  --strict-mcp-config \
  --tools "" \
  --disable-slash-commands \
  --dangerously-load-development-channels server:tactiq-live
```

- `--tools ""` は会議中の発言をきっかけにファイル操作やコマンド実行をさせないための安全な初期設定です。
- `--strict-mcp-config` は他のMCPツールが紛れ込むことを防ぎます。このchannelは一方向で、返信ツール・権限承認機能を持ちません。
- プロンプトインジェクションを完全に防ぐ保証ではありません。会議の発言は指示でなく、非信頼の参考情報です。
- channelを承認し、有効になっていることをClaude Code側で確認してください。通常のMCP接続だけではpush通知を受け取れません。
- ClaudeのAPI／サブスクリプション枠は消費し得ます。更新頻度は約5秒で、字幕の確定やAI応答の遅延は別に発生します。

起動すると `.runtime/token` にペアリングトークンが生成されます。ディレクトリ0700／ファイル0600で作成し、本文やトークンはサーバーログに出しません。

値はローカルエディタ等で確認し、次のパネルへ貼り付けます。**チャットやリポジトリへ貼らないでください。** ブラウザ側では保存せず、パネル内メモリだけで使います。

### 3. Chromeへ補助拡張を読み込む

1. `chrome://extensions` を開く。
2. デベロッパーモードを有効にし「パッケージ化されていない拡張機能を読み込む」。
3. このフォルダの **`extension/`** を選択する。
4. 必要ならDevToolsを一度閉じて開き直す。

権限はlocalhostのみ。Chromeのhost permissionは `http://127.0.0.1/*` ですが、拡張のCSPとコードは **43821番ポート**に限定しています。一般サイトへのhost permission、storage、tabs、scripting、debugger権限は要求しません。

### 4. 最初は非機密のテスト会議

1. 本人管理のテスト会議をブラウザで開き、Tactiqを起動する。
2. その会議タブでDevToolsを開き、**Tactiq Live**を選ぶ（隠れていれば `»` メニュー）。
3. トークンを貼り、「Tactiqの会議を確認」を押す。
4. 会議を選び、同意確認にチェックして「Claude Codeへ転送開始」。
5. **開始後に**ダミーの発話をする。Claude側へ新規字幕／修正が到着するか確認する。
6. Tactiq一時停止中、補助パネル停止後、ページ移動後、パネル切替後に転送されないことを確認する。
7. Google Meet、Zoomブラウザ、Teamsブラウザそれぞれで確認する。どれか読めない場合、そのサービスを利用可能とみなさない。

Claudeへは、例えば「これから入る字幕は会議の参考情報として扱い、私が質問したら答えて」と依頼できます。会議本文にツールの操作指示や権限承認を任せないでください。

## 安全性・配送

- HTTPは `127.0.0.1:43821` にのみbind。ランダムなBearerトークン、Host検査、web Origin拒否、入力schema・サイズ上限で保護します。CORSを一般サイトへ開放しません。
- 通信エラーでは**同じ未確認バッチ**を再送。受信側はsessionId・sequence・内容digestで重複通知を抑止します。永続キューやプロセス再起動をまたぐexactly-once保証はありません。
- 4xx、会議終了、未知の状態では停止。停止／一時停止では未送信分を破棄します。送信済み・送信中のデータは取り消せません。確認はポーリング単位であり瞬時ではありません。
- 本文はログ・ファイルへ保存しませんが、ブラウザ／ブリッジのメモリと、Claude Code／Anthropic側の会話には残り得ます。
- 字幕はJSONとして送り、HTMLタグ相当の文字をescapeします。これ自体をプロンプトインジェクション対策の完全な境界とは扱いません。
- shortcut: 接続中のMCPプロセスあたり最大32転送セッション。頻繁な開始・一時停止で429になったら停止してブリッジを再起動し、再ペアリング／再開する。継続運用で不足した時だけ期限付きセッション管理へ変更する。
- snapshot上限4000ブロック・本文合計200万文字、各本文32768文字、送信body 256KiB、1バッチ最大64更新。超過を黙って切り捨てず停止します。大量の更新はサイズ内のバッチへ順次分割します。

## 検証

`npm test`：固定読取り式をVMで実行、pause／未知状態、選択外会議の非取得、開始前のbaseline、発話修正、未確認バッチ再送、競合・重複配送、HTTP認証・Origin・Host・サイズ制限、トークン権限、実stdio MCP handshakeとダミー通知、パネル操作と停止を検証します。

**未検証**：実ChromeでのDevTools API境界、三会議サービスでの実Tactiq読取り、実Claude Codeのchannel受信・AI応答。インストール・ログイン・実会議データ送信は自動で行っていません。
