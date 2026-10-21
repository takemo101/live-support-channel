// Pure text for the panel: status messages by code and the whitelisted diagnostic counters. Nothing here touches the page or the DOM.
const messages = {
  CAPTIONS_OFF: "Meetの字幕がOFFです。Meetで字幕（CC）をONにして、「再確認」を押してください。",
  CAPTION_CONTROL_NOT_FOUND: "Meetの字幕ボタンが見つかりません。表示言語が日本語／英語以外、または未対応の画面構成です。",
  RTC_HOOK_NOT_READY: "Meet側の準備が未完了です。拡張を更新した場合は、Meetタブを再読み込みして会議に入り直してください（Meetへのサイトアクセス許可も確認）。",
  RTC_CONNECTION_NOT_FOUND: "Meetの会議接続が見つかりません。会議に参加して字幕をONにしてから「再確認」を押してください。拡張は参加前に読み込まれている必要があります。",
  RTC_CONNECTION_AMBIGUOUS: "会議接続を一意に特定できないため取得しません。",
  RTC_PREPARE_FAILED: "通信フックを準備できません。他の字幕拡張との競合や管理ポリシーを確認してください。",
  RTC_UNAVAILABLE: "このページでWebRTC接続を利用できません。",
  RTC_RESOURCE_LIMIT: "接続の監視上限に達したため停止しました。非機密のテスト会議でページを再読み込みしてください。",
  RTC_CONNECTION_CLOSED: "会議の接続が終了したため停止しました。会議に戻ってから「再確認」してください。",
  CAPTURE_EXPIRED: "読取りが一時的に途切れました。同じ会議へ自動で復旧します。",
  CAPTION_CHANNEL_CLOSED: "字幕チャネルが閉じたため停止しました。「再確認」から開始し直してください。",
  MEDIA_SESSION_NOT_FOUND: "Meetの制御チャネルを特定できないため、字幕ボタンOFFでの開始はできません。Meetで字幕をONにするか、ページを再読み込みして参加し直してください。",
  CAPTION_LANGUAGE_UNKNOWN: "Meetの字幕言語をまだ観測できていません。Meetの字幕設定で言語を一度選ぶか、字幕をONにしてください。",
  CAPTION_ENABLE_FAILED: "字幕の開始指示を送れませんでした。再試行はしません。Meetで字幕をONにするか、ページを再読み込みしてください。",
  CAPTION_SUBSCRIPTION_FAILED: "字幕チャネルを追加できません。標準字幕・組織設定・他の字幕拡張との競合を確認してください。",
  CAPTION_FORMAT_UNKNOWN: "字幕として使えるデータが届かないため、本文を送らず停止しました。診断コードと件数（形式不正・発話なし・ID不正など）だけを報告してください。",
  CAPTION_BACKLOG_LIMIT: "字幕の処理待ち上限に達したため停止しました。",
  CAPTION_DECODE_BUSY: "前の処理の終了を待っています。しばらくして「再確認」してください。解消しない場合は、テスト会議でページを再読み込みしてください。",
  CAPTION_ACK_BACKLOG_LIMIT: "字幕の受信確認の送信待ち上限に達したため停止しました。通信状態を確認して再確認してください。",
  CAPTION_LIMIT: "字幕が取得上限を超えたため停止しました。",
  CAPTURE_BUFFER_LIMIT: "読取りバッファの上限に達したため停止しました。再確認して新しい区間から開始してください。",
  PLATFORM_NOT_IMPLEMENTED: "ZoomはWebクライアント（app.zoom.us）だけに対応しています。ブラウザ版で参加してください。",
  TEAMS_CALL_NOT_FOUND: "Teamsの通話情報が見つかりません。会議に参加し、ライブキャプションをONにしてから「再確認」してください。それでも見つからない場合は、Teamsの内部構造が変わった可能性があります。",
  TEAMS_CALL_ENDED: "Teamsの通話が終了したため停止しました。",
  ZOOM_STORE_NOT_FOUND: "Zoomの字幕の内部状態が見つかりません。会議に参加し、字幕（ライブトランスクリプション）をONにしてから「再確認」してください。それでも見つからない場合は、Zoomの内部構造が変わった可能性があります。",
  UNSUPPORTED_HOST: "対応する会議タブで開いてください。現在の取得対象はGoogle Meet、Teams、Zoom（Webクライアント）です。",
  UNSUPPORTED_FRAME: "会議のメインフレーム以外は取得しません。",
  NOT_MEETING_PAGE: "会議ページを開いてください。Meetは meet.google.com/abc-defg-hij または /meet/abc-defg-hij、ZoomはWebクライアント（app.zoom.us/wc/…）の会議画面が対象です。",
  MEETING_CHANGED: "会議ページが変わったため停止しました。",
  CAPTURE_CHANGED: "読取りセッションが変わったため停止しました。",
  PAGE_ACCESS_DENIED: "Chromeがページの読取りを拒否しました。管理ポリシーと対象タブを確認してください。",
  FRAME_NOT_FOUND: "対象ページの実行コンテキストがありません。会議タブを再確認してください。",
  EVALUATION_FAILED: "ページでの読取りに失敗しました。会議タブを再確認してください。",
  READ_FAILED: "字幕状態を確認できません。会議タブを再確認してください。",
};
export function statistics(d) {
  const counts = [["peers", "接続"], ["captionChannels", "字幕ch"], ["names", "名簿"], ["received", "受信"], ["baselineExcluded", "初回ID除外"], ["accepted", "採用"], ["dropped", "不正"], ["frame", "形式不正"], ["utterance", "発話なし"], ["id", "ID不正"], ["device", "話者ID不正"], ["binary", "非バイナリ"]]
    .filter(([key]) => Number.isSafeInteger(d?.[key]) && d[key] >= 0 && d[key] <= 1_000_000_000)
    .map(([key, label]) => `${label}=${d[key]}`);
  // Which Meet caption profile (a fixed vocabulary) the capture settled on.
  const profile = ["captions", "captions_v2"].includes(d?.profile) ? [`方式=${d.profile}`] : [];
  // Structure of the first unusable frames (field numbers and wire types only, e.g. captions_v2:#58:1:2(1:0,3:2(6:2))): never content.
  const shapes = Array.isArray(d?.shapes) ? d.shapes.filter(v => typeof v === "string" && /^[a-z0-9_]{1,16}:#\d{1,6}:[0-9:,()!]{0,200}$/.test(v)).slice(0, 3) : [];
  // Frames keep arriving but none is a usable caption (yet): say so, since nothing else would show it while the capture keeps running.
  const only = Number.isSafeInteger(d?.dropped) && d.dropped >= 50 && !(d.accepted > 0) && !(d.baselineExcluded > 0) ? ["字幕として使えないデータだけが届いています（形=を報告してください）"] : [];
  return [...counts, ...profile, ...(shapes.length ? [`形=${shapes.join(" | ")}`] : []), ...only].join("／");
}
export function describe(result) {
  const code = Object.hasOwn(messages, result?.code) ? result.code : "READ_FAILED";
  const counts = statistics(result?.diagnostics);
  return messages[code] + `（${code}）` + (counts ? "\n" + counts : "");
}
