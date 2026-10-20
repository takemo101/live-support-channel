# Meet字幕通信reader：根拠・制限・診断

対象：v0.5.0、2026-10-20。**実装済みと現行Meetでの動作確認済みは別です。** Google Meet限定の試験版で、実会議・実Claudeは未確認。Zoom／Teamsの取得処理は未実装です。

## 方式変更の経緯

- v0.3.1まで：別拡張Tactiqのexecution contextを読む設計。ユーザー環境のPermission deniedと、[Chromiumの制限](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/common/ExtensionServer.ts)／[テスト](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/common/ExtensionServer.test.ts)が一致したため削除。
- v0.4：独立した標準字幕DOM reader。公開ソース由来の候補構造を合成DOMで検証したが、実Meetでは標準字幕表示中にもCAPTION_ROWS_NOT_FOUNDが報告された。実際のDOM階層は取得しておらず、原因の階層までは断定していない。[当時の根拠・制限](https://github.com/takemo101/tactiq-live-channel/blob/33c61f0abc23654ae80358f49a6c04ab455190cf/docs/native-captions.md)は履歴に残す。
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

各話者の最初に観測したIDを基準に、そのID以前と修正を除外する。次の大きなIDから採用し、既知IDの修正をupsertする。未知の逆順ID、同じrevisionで異なる本文は停止する。本文一致からIDを推測しない。発話IDは正のsigned-int64（1〜2^63-1）をBigIntで正確に扱う。上半分のuint64や0は受け付けない。

**最初の発話・初登場話者の質問・長い継続発話は届かない可能性がある。** 氏名は収集せず「話者1（名前未確認）」等にする。内部device IDはページ内のメモリだけで使い、モデルに渡すIDは匿名化する。

検証済みの生成時刻がないため、受信時刻とID順序を基準にする。遅配や履歴を完全に識別する保証はなく、生成時刻での厳密な区間分離が必要な用途には使わない。完全な録画・全文記録の代替ではない。

## 停止・保持

パネルは約1秒でsnapshotとleaseを更新し、約5秒で差分送信する。約2秒のleaseはframe受信前と非同期decode後にも確認する。期限切れ、pause／stop、ページ移動／pagehide、字幕OFF、未知形式等で本文とキューを破棄し、自分のチャネルを閉じる。

未処理payloadはsessionの可変キューから即時解放する。実行中gzip readerはcancelを要求する。取消できないBlob変換等は最大1件までで、その終了まで新captureを拒否する。待機中も古い結果をdecode・転送しない。

停止指示は即時到達を保証できず、指示到達前や処理中1件のデータは取消できない。create／attach／close／ACKのobserverが同期的にreset・capture置換した場合も所有者を再検査し、古い処理が追加チャネルを残したり新しい区間を閉じたりしない。Tactiqのpauseと本readerは独立。AI助言stopも転送stopとは別。

最大16接続、既知チャネルは接続ごと32、処理待ち8 frames、256話者、4000 IDs／本文計200万文字。本文ファイル・永続キューは作らない。転送済み字幕と参照資料はClaude／Anthropic側に残り得る。

## 診断と検証

パネルは既知コードと接続／字幕ch／受信／初回ID除外／採用の整数だけを表示する。CAPTION_DECODE_BUSYは前の読取り終了待ち、CAPTION_ACK_BACKLOG_LIMITは自分のACK出力上限での停止を示す。RTC_HOOK_NOT_READYならサイトアクセスと参加前の再読み込み、RTC_CONNECTION_NOT_FOUNDなら接続・字幕ON、CAPTION_FORMAT_UNKNOWNなら未知wireとして停止する。受信が増えて採用0なら初回ID除外か継続中の発話の可能性がある。

**会議本文、話者、会議URL／タイトル、token、全DOM、HAR、生パケット、ユーザーprofileは不具合報告へ貼らないこと。** 詳細コードは [SPEC.md](../SPEC.md#8-診断更新) を参照。

確認済み：Nodeの合成wire／境界テスト、独立Chrome profileのローカルRTC接続による合成packet→decode／ACK／pause／lease→実HTTP／SDK MCP通知。テスト用Meet URL stubであり、実Meetではない。

未確認：現在のMeetの通信、document_start拡張の実ロードとサイトCSP、実DevToolsから実会議・実Claude／Haiku、実権限強制、長時間の欠落率・費用。まず本人管理の非機密テスト会議で受入確認する。
