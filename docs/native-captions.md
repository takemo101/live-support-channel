# Meet標準字幕reader：根拠・制限・診断

対象：v0.4.0、2026-10-20。**実装済みと実サービス互換性確認済みは別です。** 現在はGoogle Meetだけの試験版で、実会議では未確認です。Zoom／Teamsのreaderは未実装です。

## Tactiq経由をやめた理由

v0.3.1までは `inspectedWindow.eval` の `scriptExecutionContext` に別拡張Tactiqのoriginを指定していました。ユーザー環境で `Permission denied` が発生し、現行Chromiumにも別拡張のexecution contextを拒否する処理・テストがあります。host permissionを増やせば解決する問題とは扱いません。

- [Chromium ExtensionServer.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/common/ExtensionServer.ts)
- [ExtensionServer.test.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/common/ExtensionServer.test.ts) の `blocks evaluation on other extension execution contexts`

ユーザーChromeと同じcommitのバイナリ再現はしていませんが、提示ログと上流の制約が初期設計の問題に一致します。v0.4.0ではこの経路を削除し、通常のページcontextで表示済みの標準字幕DOMだけを読みます。権限追加・Chromeのセキュリティ無効化はしません。

Tactiq公式MCPも調査しました。公開ヘルプではFree／Proは検索・一覧、Team以上は詳細・全文の範囲です。会議中の増分取得は公開仕様として確認できず、課金すればリアルタイム取得できるとは案内しません。

## DOM候補の根拠

公開ソースをrevision固定で確認しました。以下は**現在のMeetで動くという証拠ではありません**。

| ソース | 観測したこと／採用上の注意 |
| --- | --- |
| [TranscripTonic：config](https://github.com/vivek-nexus/transcriptonic/blob/0cb5eb5667759cd9cd0bb98d1ce6bdb763a30151/extension/content-scripts/google-meet/config.js)、[parser](https://github.com/vivek-nexus/transcriptonic/blob/0cb5eb5667759cd9cd0bb98d1ce6bdb763a30151/extension/content-scripts/google-meet/index.js#L189-L240)（MIT、2026-09） | `div[role="region"][tabindex="0"]` とmutation相対の兄弟探索。汎用region自体は字幕の証拠にならない |
| [TranscripTonic旧版](https://github.com/vivek-nexus/transcriptonic/blob/208a088660389b654c0755072a47d344b5d86894/extension/content.js#L313-L371)（2024-11） | `.a4cQT` と子node構造。長文時のDOM削除という回避策は本readerには採用しない |
| [Meet-Script](https://github.com/RutvijDv/Meet-Script/blob/c9fe31cddbc1a0adcaf5b7fbd96cce8d23bef171/content.js#L88-L148)（GPL-3.0、対象fileは2021-03） | 古い `jscontroller`／mutation型の別実装。現行readerのprofileとしては未採用 |

別の[公開参照実装](https://github.com/yunho0130/google-meet-cc-to-srt/blob/c7e649ceffde719fd66b319460b62a5ca56df890/content/meet-cc-simple.js#L1628-L1697)には `.nMcdL.bj4p3b`／`.NWpY1d`／`.ygicle.VbkSUe` の組合せがあります。ただしその[ライセンス](https://github.com/yunho0130/google-meet-cc-to-srt/blob/c7e649ceffde719fd66b319460b62a5ca56df890/LICENSE.md)はApache 2.0単独でなくCommons Clause等の制約付きで、OSI-open-sourceとは数えません。セレクタ・DOM構造の観測と、実装コードの再利用許諾は別です。第三者の実装ソースは同梱せず、その履歴処理・fallbackは移植していません。

`.TBMuR.bj4p3b` と `.CNusmb` の役割は今回の一次ソース調査で確認できず、想像でprofileへ追加していません。

## 本readerの安全側の仮定

- 既知の字幕ボタンがONで、字幕の領域・行・話者・本文が一意に組み合うこと。
- region系では、字幕の明示ラベルか字幕ボタンの `aria-controls` 関連付けがあること。**行の子配置が似ているだけのregionは取得しない**。
- 同じDOM行の修正は同じID。新しい行は別IDとする。話者名や本文一致だけでは同じ発話と判断しない。
- 開始／再開時の行は、その後の修正・続きもすべて除外する。
- 前回の末尾を含む連続suffixが同じ順序で先頭に残る場合だけ、新行の末尾追加と古い先頭の削除を許す。末尾／途中の削除・置換、先頭への履歴挿入、retired行再登場は停止する。元DOMを書き換えない。
- 行・話者・本文とその子要素のCSS可視性を本文アクセス前に確認し、非表示の行や子要素が混在すれば停止する。

これらは公開ソースのparserをそのまま再現した仕様ではなく、独立readerの保守的な条件です。実サービスが条件を満たさなければ、試験版は停止します。条件を満たすが意味が異なる構造、同一node再利用、長文の先頭削除を完全に識別する保証はありません。CSS可視性検査はpixel単位の重なり・clip判定ではありません。

## 欠落と停止の制約

取得は約1秒間隔です。その間に消えた字幕は失われ得ます。取得した行は上限付きメモリに保持し、HTTP待ち中も取得を続けて約5秒ごとに送りますが、完全な議事録にはなりません。不明状態になった場合は未送信分も破棄します。

Tactiqのpauseと独立しています。専用の一時停止はtimerと未送信分を破棄し、再開時は現在行を再基準化します。停止操作時に既に発行された読取り・送信は取り消せません。本文ファイルや永続キューは作りません。

## 診断と報告

パネルは既知コードと領域／行の件数だけを表示します。Chromeが返す任意の例外detailsやページ本文は表示しません。

- `CAPTIONS_OFF`：Meet内の字幕をONにする。
- `CAPTIONS_HIDDEN`：Tactiqが標準字幕を隠している。本人が表示設定を戻す必要がある。
- `CAPTION_CONTROL_NOT_FOUND`：字幕ボタンの状態が不明。日本語／英語UI以外や未対応UI。
- `CAPTION_IDENTITY_UNKNOWN`／`CAPTION_LAYOUT_UNKNOWN`：字幕と安全に特定できない。取得しない。
- `CAPTION_SURFACE_CHANGED`：DOM置換で発話の同一性が不明。再確認後に新しい区間から開始。
- `CAPTURE_BUFFER_LIMIT`：4000行／本文計200万文字の保持上限。新区間開始が必要。
- `PAGE_ACCESS_DENIED`：対象タブや管理ポリシーを確認。権限やセキュリティを迂回しない。
- `PLATFORM_NOT_IMPLEMENTED`：Zoom／Teams取得処理は未実装。

報告にはコード・件数・版だけを使ってください。会議本文、話者名、会議URL／タイトル、token、ユーザーprofileのコピーを要求しません。全DOM dumpや実会議スクリーンショットは共有しないでください。

## 検証を分ける

1. **確認済み**：Node unit、独立Chrome profileの合成DOMとテスト用URL stub、reader→差分処理→実HTTP→SDK MCP通知、privacy／race／pause／再送、隔離CLI導入。
2. **未確認**：現在のMeetの実DOMと字幕更新、実DevTools拡張接続から実会議・Claude／Haiku応答まで、実Claudeの権限制約、長時間の欠落率・費用。

合成DOMは候補profileをテストするもので、実Meetを再現したという保証ではありません。次の受入確認は本人管理の**非機密テスト会議**で、[SPEC.md](../SPEC.md#9-安全性と受入確認) の項目に沿って行います。
