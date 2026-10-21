# Meet字幕通信reader：根拠・制限・診断（TeamsとZoomは内部の呼び出し・状態の傍受。SPEC参照）

対象：v0.7.0、2026-10-20。**実装済みと現行Meetでの動作確認済みは別です。** 本書はGoogle Meetの字幕通信readerの根拠で、実会議・実Claudeは未確認。TeamsとZoomは内部の呼び出し・状態の傍受の試験版（SPEC参照）で、どちらも実機未検証です。Meetの話者名は `collections` チャネルの名簿から付けます（形式はTactiqの解析に基づく仮定で、実機未検証）。

## 方式変更の経緯

- v0.3.1まで：別拡張Tactiqのexecution contextを読む設計。ユーザー環境のPermission deniedと、[Chromiumの制限](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/common/ExtensionServer.ts)／[テスト](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/common/ExtensionServer.test.ts)が一致したため削除。
- v0.4：独立した標準字幕DOM reader。公開ソース由来の候補構造を合成DOMで検証したが、実Meetでは標準字幕表示中にもCAPTION_ROWS_NOT_FOUNDが報告された。実際のDOM階層は取得しておらず、原因の階層までは断定していない。[当時の根拠・制限](https://github.com/takemo101/live-support-channel/blob/33c61f0abc23654ae80358f49a6c04ab455190cf/docs/native-captions.md)は履歴に残す。
- v0.5：DOMの子配置に依存せず、自作のMAIN-worldフックで既知の字幕通信を処理する。Tactiq本体・別拡張状態は使わず、DOM本文へのfallbackもしない。

## 静的解析とwire根拠

Tactiq **3.1.7185** の配布JavaScriptを、実行せず静的テキストとして確認した。REA 6.7.0の範囲と限界は [REAレポート](rea-analysis-report.md) を参照。第三者コードを同梱・コピーせず、観測したfield番号と標準protobuf wire形式から独立した小さなcodecを書いた。これはGoogleの公開API契約ではなく、現在のMeetに一致するという保証ではない。

主な観測箇所：googlemeet.inline.js内のBTranscriptMessage／Wrapper、CaptionsV2Packet／Utterance／Caption、CaptionsV2Ack／Body／Refとチャネルhandler。

| チャネル | 既知の構造 |
| --- | --- |
| captions | 外側field1=message、field2=control。message内1=device文字列、2=int64発話ID、3=revision、6=本文、8=言語ID |
| captions_v2 | 外側1=utterance。utterance内1=int64 ID、2=revision、3=caption。caption内3=本文、4=言語code、6=device文字列 |
| own-v2 ACK | 外側1=body、body内1=ref、ref内1=ID、2=revision、3=1 |

**meet_messagesはチャット系**であり、字幕として処理しない。イベント名がspeechでも、payloadの意味が字幕とは限らない。collections／media-sessionは接続を識別するラベルだけを使い、その本文や参加者一覧は読まない。fetch・WebSocket・言語変更・認証情報・音声は対象外。

legacyは通常protobuf、またはgzip開始位置0／3の既知framingだけを扱う。生文字列や曖昧なbyteパターンから本文を拾わない。入力／展開後各256KiB、各message64 fields、既知3層の範囲に限り、不正UTF8・重複field・過大整数・未知wireは停止する。

## 権限と準備

本人が次を個別承認した。

1. https://meet.google.com/* のサイトアクセスとMAIN/document_startでの準備。
2. 同意後、標準字幕ONの間に限った、既存会議接続への字幕チャネル追加と自分のv2チャネルへのACK。

実Chromeのサイトアクセス許可は本人が行う。全サイト、録音、storage、tabs、scripting、debugger権限は追加しない。ページCSP・Chromeの安全機能・組織ポリシーを迂回しない。

準備はRTCPeerConnectionのconstructor/createDataChannelとincoming datachannelを観測するだけ。休止中はMessageEvent.dataに触れず、本文のdecode・保持・送信をしない。フックは**参加前**に必要で、既に作成された接続を後から列挙する保証はない。

- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)：document_startの実行順、MAIN worldのページCSP。
- [Manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)：MAIN／ISOLATED、matchesによる権限警告。

## 取得・購読と非干渉

同意、ローカルreceiverのhealth、同じMeet会議、字幕ON、接続の一意性を確認して開始する。既存のordered字幕チャネルがあれば受動利用し、無ければ自分のcaptions_v2／captionsを作る。最初の有効packetで一つに固定する。

元のcreateDataChannel引数・戻り値・send・binaryTypeは変更しない。ACKは自分のv2へだけ送り、bufferedAmount＋次のACKが16384 bytesを超える前に停止する。不要・停止・失効時に閉じるのも自分のチャネルだけで、元のチャネルやPeerConnectionは閉じない。字幕ONや言語の強制変更、途切れた接続の自動再購読はしない。他字幕拡張との同居は未確認。

MAIN worldはページと同じJS環境で、セキュリティsandboxではない。字幕は非信頼データ。ペアリングtokenやHTTP送信は拡張パネル側に置き、MAIN worldへ渡さない。

## 開始・再開の境界と欠落

各話者の最初に観測したIDを基準に、そのID以前と修正を除外する。次の大きなIDから採用し、既知IDの修正をupsertする。遅れて届いた古いIDは新しい発話として扱い、同じrevisionで新しい本文は置き換える（停止しない）。使えないフレーム（発話・話者IDがない、IDが範囲外、形式不正）は捨てて理由別に数える（その数では停止しない）。版の欠落は0（protobufは0を送らない）。本文一致からIDを推測しない。発話IDは正のsigned-int64（1〜2^63-1）をBigIntで正確に扱う。上半分のuint64や0は受け付けず、そのフレームを捨てる。

**最初の発話・初登場話者の質問・長い継続発話は届かない可能性がある。** Meetの字幕通信に名前は無いため、画面の字幕リストと本文が一致し名前が1つに決まるときだけ表示名を付け、それ以外は「話者1（名前未確認）」等にする。内部device IDはページ内のメモリだけで使い、モデルに渡すIDは匿名化する。

検証済みの生成時刻がないため、受信時刻とID順序を基準にする。遅配や履歴を完全に識別する保証はなく、生成時刻での厳密な区間分離が必要な用途には使わない。完全な録画・全文記録の代替ではない。

## 停止・保持

パネルは約1秒でsnapshotとleaseを更新し、差分は「転送のまとめ方」（既定：字幕が3秒静かになるか最古の未送信の変化が45秒で送信／約30秒／約5秒）で送る。約2秒のleaseはframe受信前と非同期decode後にも確認する。期限切れ、pause／stop、ページ移動／pagehide、字幕OFF、未知形式等で本文とキューを破棄し、自分のチャネルを閉じる。
lease失効だけは、パネルが新しい所有者でrecoverを呼んで同じ会議へ自動復旧する。フックは直前の終了がCAPTURE_EXPIREDで旧所有者・会議が一致し、現在のcaptureが無い場合だけ許可する（他の終了理由・手動reset・他captureは拒否）。復旧しても失効中の字幕は取得できず、初回ID除外と話者番号の振り直しが再度起こる。

未処理payloadはsessionの可変キューから即時解放する。実行中gzip readerはcancelを要求する。取消できないBlob変換等は最大1件までで、その終了まで新captureを拒否する。待機中も古い結果をdecode・転送しない。

停止指示は即時到達を保証できず、指示到達前や処理中1件のデータは取消できない。create／attach／close／ACKのobserverが同期的にreset・capture置換した場合も所有者を再検査し、古い処理が追加チャネルを残したり新しい区間を閉じたりしない。Tactiqのpauseと本readerは独立。AI助言stopも転送stopとは別。

最大16接続、既知チャネルは接続ごと32、処理待ち8 frames、256話者、4000 IDs／本文計200万文字。本文ファイル・永続キューは作らない。転送済み字幕と参照資料はClaude／Anthropic側に残り得る。

## 診断と検証

パネルは既知コードと接続／字幕ch／受信／初回ID除外／採用の整数だけを表示する。CAPTION_DECODE_BUSYは前の読取り終了待ち、CAPTION_ACK_BACKLOG_LIMITは自分のACK出力上限での停止を示す。RTC_HOOK_NOT_READYならサイトアクセスと参加前の再読み込み、RTC_CONNECTION_NOT_FOUNDなら接続・字幕ON、CAPTION_FORMAT_UNKNOWNなら未知wireとして停止する。受信が増えて採用0なら初回ID除外か継続中の発話の可能性がある。

**会議本文、話者、会議URL／タイトル、token、全DOM、HAR、生パケット、ユーザーprofileは不具合報告へ貼らないこと。** 詳細コードは [SPEC.md](../SPEC.md#8-診断更新) を参照。

確認済み：Nodeの合成wire／境界テスト、独立Chrome profileのローカルRTC接続による合成packet→decode／ACK／pause／lease→実HTTP／SDK MCP通知。テスト用Meet URL stubであり、実Meetではない。

未確認：現在のMeetの通信、document_start拡張の実ロードとサイトCSP、実DevToolsから実会議・実Claude／Haiku、実権限強制、長時間の欠落率・費用。まず本人管理の非機密テスト会議で受入確認する。

## Tactiq 3.1.7185 との比較メモ（静的解析・実機未確認）

- **購読**：Tactiqは字幕開始時に、自分で `captions` と `captions_v2` のチャネルを（ordered・maxRetransmits 10で）作り、さらにMeet側が作った（リモートの）同名チャネルも観測する。受信は `captions_v2` が素のprotobuf（Packet.utterance＝id・version・caption{text・languageCode・deviceId}）、`captions` がgzip（先頭または3バイト目）＋ラッパーのprotobufで、protobufとして使えない旧形式の保険にバイト列のパターン探索を持つ。
- **許容**：不正・不要なフレームは `rejected` にして無視し、取得は止めない。protobufの0は送られないので、versionの欠落は0。
- **名簿**：`collections` チャネルのprotobuf（deviceId→deviceName）。`collections`・`meet_messages` の他のメッセージはチャットで、字幕ではない。
- **言語設定の再送**：チャネルを採用・作成したとき、観測済みの字幕言語の設定コマンドを `media-session` へ再送する（当方は実験オプション「字幕がOFFでも開始」のときだけ書き込む）。
- **当方の対応**：デコードはprotobuf並みに緩く、使えないフレームは理由別に数えて捨てる。**その数では停止しない**（以前は50件で停止していたが、字幕の前に字幕以外のフレームが流れる場合に早すぎる停止になるため廃止した）。使えるものがないまま50件を超えたら、パネルが知らせ、最初の使えないフレームの構造（field番号とwire型のみ）を出す。

## 実Meetで観測した形（構造のみ）

`captions_v2` の実フレームは、`Packet.1` の中にもう一段のラッパーがあり、`Packet{1:{1:{1:id,2:version,3:caption},6:{1:n}}}` の形だった（Tactiqの解析時点の定義は `Packet{1:utterance}`）。Tactiqのprotobufjs生成デコーダはfield番号だけで読みwire型を見ないため、この入れ子を偶然平らに読む。当方は、`3`（caption）が見つからないときに `1`（length-delimited）を最大2段まで開いて読む。`Packet{2:…}` だけのフレーム（150バイト前後）は字幕ではなく、「発話なし」として数える。Tactiq 3.1.7302（最新）でも `captions_v2` の定義は変わっていない（確認済み）。

## 名簿の取得元（Tactiq 3.1.7302との比較・実機未確認）

Tactiqは、名簿を **`SyncMeetingSpaceCollections` のfetch応答**（base64のprotobuf。`BMeetingCollection.2.2.2` ＝ 反復する `{1:deviceId, 2:deviceName}`）から読み、`collections` チャネルは参加後の変更の補完に使う。自分のdevice idは、`CreateMeetingDevice` の応答と `SyncMeetingSpaceCollections` の要求本文から `spaces/<id>/devices/<id>` を正規表現で拾う。当方は以前チャネルだけを読んでいたため、参加時点で既にいる人と自分の名前を取りこぼし、「話者 N（名前未確認）」になっていた。現在はfetchの応答を `clone()` から読み取り専用で取り込む（応答そのものは触らず、独自のHTTP要求も出さない）。名簿に自分の名前が無いときは「あなた（自分）」と表示する。

名簿の診断：パネルに `名簿`（名前の数）、`RPC観測`（フックが見たMeet自身のRPC呼び出し数）、`同期応答`（読んだ一覧の数）、`同期名簿`（そこから得た名前の数）、`名簿通信`（collectionsチャネルのフレーム数）、`自分ID`（0/1）を整数で出す。一覧の応答から名前が得られなかったときは、その構造（field番号とwire型のみ）を `名簿形=` に出す。一覧はMeetの参加時に1回だけ取得されるため、拡張を更新した後は、Meetのタブを閉じて参加前に開き直す必要がある（参加済みのタブでは取得できない）。応答は、base64テキストまたは素のprotobufバイトのどちらでも読み、URLはhostがmeet.google.comのMeet自身の `/$rpc/` 呼び出しだけを対象にする。
