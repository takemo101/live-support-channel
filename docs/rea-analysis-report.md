# REAがTactiqの分析にどう役立ったか

調査日：2026-10-19。対象はTactiqのChrome拡張 **3.1.7185**。利用した解析ツールは[REA](https://github.com/morluto/rea)（`rea-agents` **6.7.0**）。

## 結論

**REAは配布物の構造と静的な解析根拠を記録し、追加調査の範囲を絞るのに役立った。一方、リアルタイム連携の核心をREAだけで解明したわけではない。**

`background.js` と `googlemeet.inline.js` は解析できたが、約2 MBの `content.js` はワーカーヒープ上限で解析できなかった。イベント、Redux相当の状態、一時停止、外部メッセージ制限の具体的な意味は、配布コードの直接確認と公式資料の調査で補った。

初期試作（v0.3.1まで）はTactiqの処理済み状態を読む設計だったが、後に**Chromeの別拡張contextアクセス制限で失敗する**ことが判明した。v0.4.0ではその経路を削除し、独立した**Meet標準字幕DOM reader**へ変更した。Tactiqは不要、Zoom／Teamsの取得は未実装。現在の取得仕様は [SPEC.md](../SPEC.md)、公開DOM候補と制限は [native-captions.md](native-captions.md) を参照。実会議・実モデルの全経路は未検証である。

## 1. 調べたかったこと

1. 会議中の文字起こしはどこで生成・受信されるか。
2. 話者・本文・更新IDはどの形式か。
3. 保存やクラウド同期を待たずに更新を取得できるか。
4. 一時停止・会議選択・認証の境界を壊さず、別AIへ渡せるか。
5. 公式機能だけで要件を満たせるか、それともローカル連携が必要か。

最初は「別AIへの読取り連携」が対象だったが、会議後ではなく**会議中の逐次転送**が必要と分かり、リアルタイム経路の調査を優先した。

## 2. 解析対象の同一性

| 項目 | 値 |
| --- | --- |
| 拡張ID | `fggkaccpbmombhnjkjokndojfgagejfb` |
| 配布版 | `3.1.7185`、Manifest V3 |
| 入手元 | [Chrome Web Store](https://chromewebstore.google.com/detail/fggkaccpbmombhnjkjokndojfgagejfb)に対応するGoogleの拡張更新エンドポイント |
| CRXサイズ | 2,211,890 bytes |
| 展開内容 | 79エントリ、7,061,599 bytes |
| CRX SHA-256 | `d2c397a5e701b3f0a1ac1449a89b8c6fe0ef866c5e0b9a2434db0ea289fe0c8b` |
| REAのroot artifact SHA-256 | `466de32136f0a5c43d55ef6f49eb0f0cb50350fd1106172a18084c4e45ff993e` |

manifestの公開鍵から導出した拡張IDが一致することを確認した。ただし、CRX署名そのものの暗号学的検証までは行っていない。CRXファイルと展開ディレクトリではハッシュの対象が異なるため、上の二つのSHA-256は同じ値ではない。

拡張のインストール・実行、会議への参加、ログイン済みトークンや実際の文字起こしの取得は行っていない。Tactiq本体・整形コピー・巨大な解析JSONは再配布せず、公開リポジトリには本レポートと自作の連携コード・テストを収録する。

## 3. REAをどう使ったか

### JavaScript用CLIを使い、MCPの登録変更はしなかった

対象は展開済みJavaScript拡張なので、`analyze-javascript-application` を使用した。Ghidra、Hopperなどのネイティブ解析エンジンは導入していない。REAのMCP登録やユーザー設定も変更していない。

初回は `npx -y rea-agents@latest` を使用し、その時点の解決版は **6.7.0** だった。次は同版に固定した再現用コマンドである。`APP_DIR` には、同じ配布物を手元で展開したディレクトリの絶対パスを指定する。

```bash
APP_DIR="$PWD/artifacts/tactiq-3.1.7185"

npx -y rea-agents@6.7.0 analyze-javascript-application "$APP_DIR" \
  --source-path manifest.json \
  --source-path googlemeet.inline.js \
  --source-path background.js \
  --source-path content.js \
  --max-semantic-nodes 6000 \
  --max-semantic-nodes-per-file 2000 \
  --analysis-timeout-ms 90000 \
  --format json
```

この選択はアプリ全体の完全解析ではない。関連ファイルのinventoryは保持するが、選択外のソースやその関係はunknownとして扱う。

### 実際の結果

| 指標 | 結果 |
| --- | --- |
| Evidence ID | `ev_9a37c960b96bbfc7dc01326aab93e5e703486aa6c5800f2b800df474dda5d1ec` |
| Inventory ID | `agm_806b2649c14f9ec2f41820c646837cae416b784798428249895c4d20e23b34d6` |
| relevant files | 64 |
| 選択したパス | 4（うちmanifestはJSON） |
| 選択外 | 60ファイル |
| 読み取ったテキスト | 3,339,702 bytes |
| JavaScript解析成功 | 2ファイル |
| JavaScriptスキップ | 1ファイル（`content.js`） |
| visited AST nodes | 381,279 |
| findings | 54 |
| 構文エラー | 0 |
| Graph coverage | **partial** |
| CLI終了コード | 0 |

### 2026-10-20：各サービスadapterの追加解析

同じREA 6.7.0でmanifest、`googlemeet.inline.js`、`msteams.inline.js`、`zoom.inline.js`、`rtcinjector.js`を選択し、heap 1024 MiB／semantic nodes 6000（file当たり2000）／timeout 90000 msで実際に再解析した。

- Evidence：`ev_2a89b822e2b09c8197ee1a1e66f4313a67dfd7760d2ba8a287dc811fffe62bd5`。
- JavaScript 4ファイル解析、skip 0、構文解析失敗0。427,594 bytes、134,736 AST nodes、37 findings。
- 選択外59ファイル。semantic budget上限がありcoverageはpartial。
- `content.js` は対象外であり、上のheap制約を解消した結果ではない。

adapterの通信hookやprivate state依存は配布コードの直接確認で補った。REAの4ファイル解析は、4サービスの取得実装や実会議検証を意味しない。独立readerではこれらのprivate通信hookを移植せず、表示字幕DOMを候補として別途調査した。

初回のグラフには `storage` 23ノード、`endpoint` 7ノード、`worker` 2ノード等があった。これは**ノード数であり、Tactiq固有機能数・通信先ホスト数・実行済み処理数ではない**。同梱ライブラリ由来の情報も含む。

例えば、`background.js` のGraphQL mutation `UpdateUserSetting` はAST上の観測として記録された。一方、`mp_optout` は `call:v.cookie.get` に由来するlow-confidenceのendpoint候補だった。後者をそのまま「外部送信先」と判断してはいけない。観測と推論の区別が、出力を読むうえで重要だった。

## 4. REAが役立った点

### 4.1 配布物から解析を始められた

元のTypeScriptソースや開発用リポジトリがなくても、JavaScriptの配布ツリーを入力にできた。対象をネイティブバイナリとして逆アセンブルする必要がなく、最初の手順を小さくできた。

### 4.2 何を解析したかをEvidenceとハッシュで残せた

版番号だけでなく、対象artifact・inventory・Evidenceの識別子と、選択したソース範囲を残せた。直接コードを確認した後も、違う版の結果と混ぜないための基準になった。

ただし、これらは今回のローカル実行の識別子である。別環境で同じEvidence IDが必ず再現される保証や、結果を外部検証機関が認証したという意味ではない。

### 4.3 AST由来の構造・保存・通信候補を足がかりにできた

minify済みファイルの文字列検索だけでは、SDK内部コードとアプリ本体を混同しやすい。REAのグラフは、ソース位置・mechanism・authority・confidenceを持つ足がかりになった。

ただし、候補からTactiqの実際のデータ経路を確定するには追加のコード確認が必要だった。今回、Chrome拡張専用のメッセージ連携仕様やRedux状態の意味をREAが自動で全復元したわけではない。

### 4.4 「分からなかった範囲」を明確にできた

終了コード0でも `content.js` は解析できていなかった。coverageとlimitationsを読むことで、成功したファイルと未解析のファイルを区別できた。

これにより、グラフに処理が見えないことを「その処理は存在しない」と誤認せず、未解析の `content.js` を直接確認する判断につながった。

## 5. REAでは足りず、別の方法で補った点

### content.jsのメモリ制約

初回は約1 GiBのワーカーヒープ上限に到達した。続けて `content.js` 単独を次の条件で再解析したが、同じく静的解析中のヒープ制約だった。

- `rea-agents@6.7.0`
- `--source-path manifest.json --source-path content.js`
- `--max-heap-mb 2048`
- semantic nodes全体／ファイル各2000
- `--analysis-timeout-ms 90000`

再解析のEvidence IDは `ev_dbecd19915eb77a3ade9e2233d4ff09183fb0fac8eca45f117b31a33711e3f59`。結果はpartialであり、ヒープ制約は未解消のままである。

無制限にメモリを増やす代わりに、既存の整形ツールで解析用コピーを作り、関連箇所を静的に読んだ。整形は元の変数名・型・設計を復元する処理ではなく、拡張のコードも実行していない。

### 具体的な発見と根拠の分担

| 発見・確認 | 主な根拠 | 設計への影響 |
| --- | --- | --- |
| Meetの字幕は `tactiq-message` の `speech` として通知される | 配布コードの直接確認。REAでは関連ファイルの静的解析を実施 | リアルタイム観測点の候補になった |
| `messageId` / `messageVersion` で同じ字幕が更新される | 配布コードのデコード・更新処理の直接確認 | 単純追記ではなくupsertにした |
| 話者名付与・置換・翻訳等は後段処理である | 未解析だった `content.js` の直接確認 | 生イベントと最終文字起こしを同一視しない |
| 一時停止は後段の `isPaused` で判定される | `content.js` のreducerと状態取得処理の直接確認 | 生イベント直送を避け、処理済み状態を読む方式を採用 |
| 保存はメタ情報と本文ブロックで別キーに分かれる | `background.js` の直接確認 | ローカル保存キー一つだけを読む案を避けた |
| `getTranscript` は任意の外部AI向け公開APIではない | manifestと送信元URL検査の直接確認 | 外部メッセージ制限を回避する案を採らなかった |
| `MCP Connector` とTeam planの文言がある | 配布コードの文字列・周辺処理の直接確認 | 公式MCPの調査を優先した |
| 公式MCPはHTTP/OAuthで会議を読める | [Tactiq公式ヘルプ](https://help.tactiq.io/en/articles/14883619-connecting-tactiq-mcp-server) | 会議後の読取りなら第一候補になった |
| 公式MCPの会議中ストリーミング仕様は確認できなかった | 公式資料の調査範囲 | 公式MCPをリアルタイム配信保証とは扱わなかった |
| context指定パラメータがある／Claudeへ通知をpushできる | DevTools・Channels公式資料。当初は別拡張contextのアクセス制限を見落とした | 初期設計は失敗。後に通常page contextの独立DOM readerへ変更、一方向channelは再利用 |

当初は公式MCPのプラン表記に不一致があった。後続の公式ヘルプ調査ではFree／Proは検索・一覧、Team以上は詳細・全文と区別される。ただし進行中会議の増分取得は公開仕様で確認できず、プラン変更でリアルタイム取得できるとは判断していない。購入や権限変更は行っていない。

## 6. 解析から実装へどうつながったか

以下は**初期に目指した構成（v0.3.1まで、別拡張contextアクセスで失敗）**であり、現行の動作保証ではない。

```text
選択した会議のTactiq処理済み状態
  → 明示開始したDevToolsパネルで約5秒ごとに確認
  → 発話ID単位の新規・修正差分
  → 認証付きloopback HTTP
  → Claude Codeの一方向Channels通知
```

- 一時停止・不明・会議終了時は送信を止める。
- 開始時／再開時点で既存の発話IDは、後で修正されても送らない。過去のprefix混入を防ぐ代わりに、進行中の発話は欠ける。
- 明示停止・パネルを離れる操作・ページ移動で転送を止める。
- 非公開APIの認証情報抽出や拡張の改造は行わない。
- 会議本文を操作指示・ツール権限の承認と扱わない。

**現在のv0.4.0では**「Meet標準字幕DOM → 通常page eval → 約1秒取得／約5秒差分送信 → 既存HTTP／Channels」を実装した。専用のpause／resume／stopが必要で、Tactiqのpauseとは連動しない。実Chrome合成DOMでは検証したが、実Meetの互換性は未確認である。

現在のコードは [`extension/snapshot.js`](../extension/snapshot.js)、[`extension/stream.js`](../extension/stream.js)、[`extension/panel.js`](../extension/panel.js)、[`server/bridge.js`](../server/bridge.js)、[`server/main.js`](../server/main.js)。詳細な運用とデータ形式は [`SPEC.md`](../SPEC.md) を参照。

## 7. 検証済み／未検証

### 検証済み

- REAの出力・coverage・limitationsと対象ファイルの同一性。
- 固定読取り式をダミー状態で実行するテスト。
- 会議選択、pause、開始前本文の除外、差分、再送、認証、重複抑止。
- 実ローカルHTTPとSDKクライアント間のMCP stdio通知。
- 解析後の初期実装では、stdin EOF時の終了処理を含む自動テスト39件。以後追加されたCLI・会議Skill等の現行検証範囲は [SPEC.md](../SPEC.md) を参照。

### 未検証

- 現在のMeet標準字幕DOM、実DevTools接続から実会議までの互換性。
- Zoom／Teamsの独立readerは未実装。旧Tactiq private context経路はアクセス拒否のため削除済み。
- Claude Code本体が開発channelを許可し、実モデルへ取り込むこと。
- 長時間運用、AIによる要約やプロジェクト判断の精度・遅延・費用。

**静的に観測点があること、ダミーテストが通ること、実会議の全経路が動作することは別である。** REAの解析成功を、リアルタイム連携の実機動作保証へ読み替えていない。

その後、GitHubから導入できるCLIと、`skills/meeting/SKILL.md` による読取り専用の会議支援を追加した。これはREAが回答能力を検証した結果ではなく、別レイヤーの実装である。架空の会議で返答案を評価したが、実Claude／Haikuでの応答・権限拒否・会議全経路は引き続き未検証。

## 8. 次回も同じ分析を行うなら

1. 配布版とハッシュを固定する。
2. JavaScript用の小さな解析範囲から始める。
3. 終了コードより先にcoverageとlimitationsを確認する。
4. 同梱SDK由来の候補を、アプリ機能や実通信と取り違えない。
5. REAで足りない箇所を、直接確認・公式仕様・安全なテストで補う。
6. 根拠の出どころを分け、未検証の境界を残す。

今回の価値は「REAに任せればすべて分かる」ことではなく、**解析対象・根拠・不明点を整理したうえで、必要な追加調査と最小の実装へ進めたこと**にある。

## 参考資料

- [REA公式リポジトリ](https://github.com/morluto/rea)
- [REA JavaScript Application Graph](https://github.com/morluto/rea/blob/main/docs/javascript-application-graph.md)
- [REA JavaScript application workflows](https://github.com/morluto/rea/blob/main/docs/javascript-application-workflows.md)
- [Tactiq公式MCP](https://help.tactiq.io/en/articles/14883619-connecting-tactiq-mcp-server)
- [Chrome DevTools inspectedWindow.eval](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow#method-eval)
- [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)

リンク先のmainブランチや公式ヘルプは更新され得る。今回のREA実行版と調査対象は本書記載の版に固定して読むこと。
