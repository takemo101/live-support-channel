import { readCaptions } from "./snapshot.js";
import { CaptionStream } from "./stream.js";

export function createPanel({ document, inspectedWindow, onNavigated, fetch, setInterval, clearInterval, storage }) {
  const el = id => document.getElementById(id);
  const endpoint = "http://127.0.0.1:43821";
  let active = false, paused = false, busy = false, captionReady = false, failed = false, assistCaptions = false, platform = "Google Meet";
  let generation = 0, readTimer, sendTimer, controller, meetingId, pairingToken, captureId, capturePromise, lastSnapshot, recovery, recoveries = 0;
  const captured = new Map();
  const status = message => { el("status").textContent = message; };
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
    CAPTION_FORMAT_UNKNOWN: "未対応の字幕通信形式です。本文を送らず停止しました。診断コードと件数だけを報告してください。",
    CAPTION_BACKLOG_LIMIT: "字幕の処理待ち上限に達したため停止しました。",
    CAPTION_DECODE_BUSY: "前の処理の終了を待っています。しばらくして「再確認」してください。解消しない場合は、テスト会議でページを再読み込みしてください。",
    CAPTION_ACK_BACKLOG_LIMIT: "字幕の受信確認の送信待ち上限に達したため停止しました。通信状態を確認して再確認してください。",
    CAPTION_SEQUENCE_UNKNOWN: "発話IDの順序を確認できないため停止しました。",
    CAPTION_REVISION_CONFLICT: "同じ修正番号で本文が異なるため停止しました。",
    CAPTION_LIMIT: "字幕が取得上限を超えたため停止しました。",
    CAPTURE_BUFFER_LIMIT: "読取りバッファの上限に達したため停止しました。再確認して新しい区間から開始してください。",
    PLATFORM_NOT_IMPLEMENTED: "ZoomはWebクライアント（app.zoom.us）だけに対応しています。ブラウザ版で参加してください。",
    ZOOM_FRAME_NOT_FOUND: "Zoomの会議画面がまだ開かれていません。会議に参加し、字幕を表示してから「再確認」してください。",
    UNSUPPORTED_HOST: "対応する会議タブで開いてください。現在の取得対象はGoogle Meet、Teams、Zoom（Webクライアント）です。",
    UNSUPPORTED_FRAME: "会議のメインフレーム以外は取得しません。",
    NOT_MEETING_PAGE: "Meet会議のページを開いてください。",
    MEETING_CHANGED: "会議ページが変わったため停止しました。",
    CAPTURE_CHANGED: "読取りセッションが変わったため停止しました。",
    PAGE_ACCESS_DENIED: "Chromeがページの読取りを拒否しました。管理ポリシーと対象タブを確認してください。",
    FRAME_NOT_FOUND: "対象ページの実行コンテキストがありません。会議タブを再確認してください。",
    EVALUATION_FAILED: "ページでの読取りに失敗しました。会議タブを再確認してください。",
    READ_FAILED: "字幕状態を確認できません。会議タブを再確認してください。",
  };
  function statistics(d) {
    const counts = [["peers", "接続"], ["captionChannels", "字幕ch"], ["frames", "フレーム"], ["received", "受信"], ["baselineExcluded", "初回ID除外"], ["accepted", "採用"]]
      .filter(([key]) => Number.isSafeInteger(d?.[key]) && d[key] >= 0 && d[key] <= 1_000_000_000)
      .map(([key, label]) => `${label}=${d[key]}`);
    const labels = Array.isArray(d?.channelLabels) ? d.channelLabels.filter(l => typeof l === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(l)).slice(0, 8) : [];
    return [...counts, ...(labels.length ? [`ラベル=${labels.join(",")}`] : [])].join("／");
  }
  function describe(result) {
    const code = Object.hasOwn(messages, result?.code) ? result.code : "READ_FAILED";
    const counts = statistics(result?.diagnostics);
    return messages[code] + `（${code}）` + (counts ? "\n" + counts : "");
  }
  function badge() {
    const [kind, label] = !active ? (failed ? ["error", "停止（要確認）"] : captionReady ? ["ready", "準備OK"] : ["idle", "未準備"])
      : busy ? ["working", "接続中"] : paused ? ["paused", "一時停止中"] : recovery ? ["working", "自動復旧中"] : ["live", "取得中"];
    el("state").textContent = label; el("state").className = "state " + kind;
  }
  function controls() {
    for (const id of ["token", "meeting", "refresh", "consent", "assist"]) el(id).disabled = active;
    el("start").disabled = active || !captionReady || !el("meeting").value || !el("consent").checked;
    el("stop").disabled = !active;
    el("pause").disabled = !active || busy || !stream.run;
    el("pause").textContent = paused ? "再開" : "一時停止";
    el("setup").hidden = el("start").hidden = active;
    el("pause").hidden = el("stop").hidden = !active;
    badge();
  }
  function evaluate(action, owner = captureId, previousCaptureId) {
    const params = { action, meetingId, captureId: owner, previousCaptureId, assistCaptions: assistCaptions && (action === "discover" || action === "start") ? true : undefined };
    return new Promise((resolve, reject) => {
      inspectedWindow.eval(`(${readCaptions.toString()})(${JSON.stringify(params)})`, {}, (result, error) => {
        if (error === true || error?.isError || error?.isException) {
          const code = error?.code === "E_FAILED" ? "PAGE_ACCESS_DENIED" : error?.code === "E_NOTFOUND" ? "FRAME_NOT_FOUND" : "EVALUATION_FAILED";
          reject(Object.assign(Error(code), { code }));
        } else if (!result || typeof result.status !== "string") reject(Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" }));
        else resolve(result);
      });
    });
  }
  function resetReader() {
    const owners = [captureId, recovery?.owner].filter(Boolean);
    captureId = recovery = undefined;
    for (const owner of owners) void evaluate("reset", owner).catch(() => {});
  }
  function stop(message = "停止しました。未送信の更新は破棄しました。", error = false) {
    active = false; paused = false; busy = false; failed = error; generation++;
    clearInterval(readTimer); clearInterval(sendTimer); readTimer = sendTimer = undefined;
    capturePromise = lastSnapshot = undefined; captured.clear(); recoveries = 0;
    controller?.abort(); stream.stop(); resetReader(); controls(); status(message);
  }
  async function request(path, body) {
    const response = await fetch(endpoint + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: "Bearer " + pairingToken, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw Object.assign(Error("受信先エラー HTTP " + response.status), { status: response.status, fatal: response.status >= 400 && response.status < 500 });
  }
  const stream = new CaptionStream(payload => request("/captions", payload));
  async function refresh() {
    if (active) return;
    const run = ++generation;
    captionReady = false; failed = false; assistCaptions = el("assist").checked === true; el("meeting").replaceChildren(); controls();
    try {
      const result = await evaluate("discover");
      if (active || run !== generation) return;
      if (result.status !== "ready" || !Array.isArray(result.meetings) || result.meetings.length !== 1) { status(describe(result)); return; }
      const placeholder = document.createElement("option"); placeholder.textContent = "会議を選択"; placeholder.value = ""; el("meeting").append(placeholder);
      for (const meeting of result.meetings) {
        if (typeof meeting.id !== "string" || typeof meeting.title !== "string") throw Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" });
        const option = document.createElement("option"); option.value = meeting.id; option.textContent = meeting.title; el("meeting").append(option);
      }
      captionReady = result.captionReady === true && result.code === "READY";
      if (captionReady) { el("meeting").value = result.meetings[0].id; platform = ["Teams", "Zoom"].includes(result.platform) ? result.platform : "Google Meet"; }
      status(!captionReady ? describe(result) : platform === "Teams"
        ? "準備OK（Teams）。Teamsのライブキャプション（字幕）をONにしてから、トークンを入力し、同意にチェックして「転送開始」を押してください。字幕がOFFの間は何も届きません。"
        : platform === "Zoom"
        ? "準備OK（Zoom）。Zoomの字幕（ライブトランスクリプション）を画面に表示してから、トークンを入力し、同意にチェックして「転送開始」を押してください。画面に出ている字幕だけを読みます。"
        : "準備OKです。トークンを入力し、同意にチェックして「転送開始」を押してください。");
    } catch (error) { if (run === generation) status(describe(error)); }
    finally { if (run === generation) controls(); }
  }
  function remember(snapshot) {
    if (snapshot.meetingId !== meetingId) throw Object.assign(Error("MEETING_CHANGED"), { code: "MEETING_CHANGED" });
    if (!Array.isArray(snapshot.blocks) || snapshot.platform !== platform) throw Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" });
    for (const block of snapshot.blocks) {
      if (!block || typeof block.messageId !== "string" || typeof block.transcript !== "string") throw Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" });
      captured.set(JSON.stringify([block.messageId, block.deviceId ?? ""]), block);
    }
    let characters = 0;
    for (const block of captured.values()) characters += block.transcript.length;
    if (captured.size > 4000 || characters > 2_000_000) throw Object.assign(Error("CAPTURE_BUFFER_LIMIT"), { code: "CAPTURE_BUFFER_LIMIT" });
    lastSnapshot = { status: "live", meetingId: snapshot.meetingId, platform: snapshot.platform, statistics: statistics(snapshot.diagnostics) };
    return { ...lastSnapshot, blocks: [...captured.values()] };
  }
  function capture() {
    if (!active || paused || busy) return Promise.resolve();
    if (capturePromise) return capturePromise;
    const run = generation;
    const task = (async () => {
      try {
        let snapshot = recovery ? await evaluate("recover", recovery.owner, recovery.previous) : await evaluate("read");
        if (!active || paused || run !== generation) return;
        if (!recovery && snapshot.status === "ended" && snapshot.code === "CAPTURE_EXPIRED") {
          // Only lease expiry is recoverable, and only into the same meeting; the hook verifies the previous owner.
          recovery = { previous: captureId, owner: crypto.randomUUID(), tries: 0 };
          controls(); status(describe(snapshot));
          snapshot = await evaluate("recover", recovery.owner, recovery.previous);
          if (!active || paused || run !== generation) return;
        }
        if (snapshot.status !== "live") {
          if (recovery && snapshot.code === "CAPTION_DECODE_BUSY" && ++recovery.tries <= 10) { status("自動復旧を待機中です。前の処理の終了を待っています。（CAPTION_DECODE_BUSY）"); return; }
          captionReady = false; stop(describe(snapshot), true); return;
        }
        if (recovery) {
          captureId = recovery.owner; recovery = undefined; recoveries++; controls();
          status(`自動復旧しました（${recoveries}回目）。途切れた間の字幕と、各話者の復旧後の最初の発言は送られません。話者番号は振り直されます。`);
        }
        remember(snapshot);
      } catch (error) {
        if (active && run === generation) { captionReady = false; stop(describe(error), true); }
      }
    })();
    capturePromise = task;
    void task.finally(() => { if (capturePromise === task) capturePromise = undefined; });
    return task;
  }
  async function flush() {
    if (!active || paused || busy || recovery || !lastSnapshot || stream.busy) return;
    const run = generation;
    await capture();
    if (!active || paused || recovery || run !== generation || !lastSnapshot) return;
    try {
      await stream.update({ ...lastSnapshot, blocks: [...captured.values()] });
      if (!active || paused || run !== generation) return;
      status("字幕を転送中（約5秒ごと）。\n" + lastSnapshot.statistics + "／送信済みバッチ=" + stream.run.sequence + (recoveries ? `／自動復旧=${recoveries}` : ""));
    } catch (error) {
      if (active && run === generation) {
        if (error.fatal) stop(error.message + "。停止しました。", true);
        else status("送信に失敗しました。同じ内容を次回再送します。「停止」で破棄できます。");
      }
    }
  }
  async function startOrResume(resume) {
    if (busy || (resume ? !active || !paused : active)) return;
    if (!resume && (!captionReady || !el("consent").checked || !el("meeting").value)) { status("字幕の準備確認と参加者同意が必要です。"); return; }
    if (!resume && !/^[A-Za-z0-9_-]{43}$/.test(el("token").value.trim())) { status("ペアリングトークン（43文字）を確認してください。"); return; }
    if (!resume) { pairingToken = el("token").value.trim(); meetingId = el("meeting").value; assistCaptions = el("assist").checked === true; }
    active = true; busy = true; failed = false;
    const run = ++generation;
    controller = new AbortController(); captureId = crypto.randomUUID();
    controls(); status(resume ? "再開準備中です。現在の字幕は除外します。" : "接続中です。まだ字幕は送っていません。");
    try {
      await request("/health");
      if (!resume) void Promise.resolve(storage?.set(pairingToken)).catch(() => {});
      if (!active || run !== generation) return;
      const snapshot = await evaluate("start");
      if (!active || run !== generation) return;
      if (snapshot.status !== "live") { captionReady = false; stop(describe(snapshot), true); return; }
      if (snapshot.meetingId !== meetingId) { captionReady = false; stop(describe({ code: "MEETING_CHANGED" }), true); return; }
      captured.clear();
      const baseline = remember(snapshot);
      if (resume) await stream.update(baseline); else stream.start(baseline);
      if (!active || run !== generation) return;
      paused = false; readTimer = setInterval(capture, 1000); sendTimer = setInterval(flush, 5000);
      status("取得中です。開始時点までの発言は送らず、これ以降の発言から転送します。");
    } catch (error) {
      if (run === generation) {
        if (error.status === 401 || error.status === 403) void Promise.resolve(storage?.remove()).catch(() => {});
        stop(error.code ? describe(error) : error.fatal ? (error.status === 401 || error.status === 403 ? "トークンが受け付けられませんでした。ペアリングトークンを確認してください。（HTTP " + error.status + "）" : error.message + "。停止しました。") : "ローカルの受信サーバーに接続できません。Claude Code側が起動しているか確認してください。", true);
      }
    } finally { if (run === generation) { busy = false; controls(); } }
  }
  function togglePause() {
    if (!active || busy || !stream.run) return;
    if (paused) { void startOrResume(true); return; }
    paused = true; generation++;
    clearInterval(readTimer); clearInterval(sendTimer); readTimer = sendTimer = undefined; controller?.abort();
    capturePromise = lastSnapshot = undefined; captured.clear();
    void stream.update({ status: "paused" }); resetReader(); controls();
    status("一時停止中です。この間の字幕は処理・保持・送信しません。再開時は各話者の最初の発言を除外します。");
  }
  const navigate = () => { captionReady = false; stop("ページが移動したため停止しました。字幕を再確認してください。"); el("meeting").replaceChildren(); controls(); };
  el("refresh").addEventListener("click", refresh);
  el("start").addEventListener("click", () => { void startOrResume(false); });
  el("pause").addEventListener("click", togglePause);
  el("stop").addEventListener("click", () => stop());
  el("meeting").addEventListener("change", controls);
  el("consent").addEventListener("change", controls);
  el("assist").addEventListener("change", () => { void refresh(); });
  onNavigated.addListener(navigate); controls();
  void Promise.resolve(storage?.get()).then(token => { if (typeof token === "string" && !el("token").value && !active) el("token").value = token; }).catch(() => {});
  return { stop, refresh, dispose() { stop(); onNavigated.removeListener(navigate); } };
}
if (globalThis.chrome?.devtools && globalThis.document) {
  const panel = createPanel({ document, inspectedWindow: chrome.devtools.inspectedWindow, onNavigated: chrome.devtools.network.onNavigated, fetch: globalThis.fetch.bind(globalThis), setInterval, clearInterval,
    storage: chrome.storage?.session && { get: async () => (await chrome.storage.session.get("token")).token, set: token => chrome.storage.session.set({ token }), remove: () => chrome.storage.session.remove("token") } });
  addEventListener("pagehide", () => panel.dispose(), { once: true });
  addEventListener("tactiq-panel-hidden", () => panel.stop("パネルを離れたため停止しました。"));
  void panel.refresh();
}
