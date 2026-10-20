import { readCaptions } from "./snapshot.js";
import { CaptionStream } from "./stream.js";

export function createPanel({ document, inspectedWindow, onNavigated, fetch, setInterval, clearInterval }) {
  const el = id => document.getElementById(id);
  const endpoint = "http://127.0.0.1:43821";
  let active = false, paused = false, busy = false, captionReady = false;
  let generation = 0, readTimer, sendTimer, controller, meetingId, pairingToken, captureId, capturePromise, lastSnapshot;
  const captured = new Map();
  const status = message => { el("status").textContent = message; };
  const messages = {
    CAPTIONS_OFF: "Meetの標準字幕をONにして、発話後に再確認してください。",
    CAPTION_CONTROL_NOT_FOUND: "字幕ボタンの状態を確認できません。日本語／英語UI以外、または未対応のUI構造です。",
    CAPTIONS_HIDDEN: "標準字幕がTactiqによって非表示です。標準字幕を表示してから再確認してください。",
    CAPTIONS_NOT_FOUND: "標準字幕の領域が見つかりません。字幕をONにして再確認してください。",
    CAPTION_ROWS_NOT_FOUND: "対応する字幕行がありません。発話後に再確認してください。",
    CAPTION_IDENTITY_UNKNOWN: "字幕領域と確認できない構造のため取得しません。未対応レイアウトです。",
    AMBIGUOUS_CAPTIONS: "字幕領域を一意に特定できないため取得しません。",
    CAPTION_LAYOUT_UNKNOWN: "未対応の字幕構造です。取得を停止します。",
    CAPTION_SURFACE_CHANGED: "字幕DOMの置換を検出したため停止しました。過去字幕の再送を防ぐため再確認が必要です。",
    CAPTION_LIMIT: "字幕が取得上限を超えたため停止しました。",
    CAPTURE_BUFFER_LIMIT: "読取りバッファの上限に達したため停止しました。再確認して新しい区間から開始してください。",
    PLATFORM_NOT_IMPLEMENTED: "現在はMeet標準字幕の試験版です。Zoom／Teamsの取得処理は未実装です。",
    UNSUPPORTED_HOST: "対応する会議タブで開いてください。現在の取得対象はGoogle Meetです。",
    UNSUPPORTED_FRAME: "会議のメインフレーム以外は取得しません。",
    NOT_MEETING_PAGE: "Meet会議のページを開いてください。",
    MEETING_CHANGED: "会議ページが変わったため停止しました。",
    CAPTURE_CHANGED: "読取りセッションが変わったため停止しました。",
    PAGE_ACCESS_DENIED: "Chromeがページの読取りを拒否しました。管理ポリシーと対象タブを確認してください。",
    FRAME_NOT_FOUND: "対象ページの実行コンテキストがありません。会議タブを再確認してください。",
    EVALUATION_FAILED: "ページでの読取りに失敗しました。会議タブを再確認してください。",
    READ_FAILED: "字幕状態を確認できません。会議タブを再確認してください。",
  };
  function describe(result) {
    const code = Object.hasOwn(messages, result?.code) ? result.code : "READ_FAILED";
    const d = result?.diagnostics;
    const counts = d && Number.isInteger(d.roots) && d.roots >= 0 && d.roots <= 4000 && Number.isInteger(d.rows) && d.rows >= 0 && d.rows <= 4000
      ? ` 領域=${d.roots}／字幕行=${d.rows}` : "";
    return messages[code] + `（${code}）` + counts;
  }
  function controls() {
    for (const id of ["token", "meeting", "refresh", "consent"]) el(id).disabled = active;
    el("start").disabled = active || !captionReady || !el("meeting").value || !el("consent").checked;
    el("stop").disabled = !active;
    el("pause").disabled = !active || busy || !stream.run;
    el("pause").textContent = paused ? "再開（現在の字幕を除外）" : "一時停止";
  }
  function evaluate(action, owner = captureId) {
    const params = { action, meetingId, captureId: owner };
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
    const owner = captureId;
    captureId = undefined;
    if (owner) void evaluate("reset", owner).catch(() => {});
  }
  function stop(message = "停止しました。未送信の更新は破棄します。") {
    active = false; paused = false; busy = false; generation++;
    clearInterval(readTimer); clearInterval(sendTimer); readTimer = sendTimer = undefined;
    capturePromise = lastSnapshot = undefined; captured.clear();
    controller?.abort(); stream.stop(); resetReader(); controls(); status(message);
  }
  async function request(path, body) {
    const response = await fetch(endpoint + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: "Bearer " + pairingToken, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw Object.assign(Error("受信先エラー HTTP " + response.status), { fatal: response.status >= 400 && response.status < 500 });
  }
  const stream = new CaptionStream(payload => request("/captions", payload));
  async function refresh() {
    if (active) return;
    const run = ++generation;
    captionReady = false; el("meeting").replaceChildren(); controls();
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
      status(captionReady ? "Meet標準字幕の候補を検出しました。会議を選び、同意を確認して開始してください。実会議での互換性は未確認です。" : describe(result));
    } catch (error) { if (run === generation) status(describe(error)); }
    finally { if (run === generation) controls(); }
  }
  function remember(snapshot) {
    if (snapshot.meetingId !== meetingId) throw Object.assign(Error("MEETING_CHANGED"), { code: "MEETING_CHANGED" });
    if (!Array.isArray(snapshot.blocks) || snapshot.platform !== "Google Meet") throw Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" });
    for (const block of snapshot.blocks) {
      if (!block || typeof block.messageId !== "string" || typeof block.transcript !== "string") throw Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" });
      captured.set(JSON.stringify([block.messageId, block.deviceId ?? ""]), block);
    }
    let characters = 0;
    for (const block of captured.values()) characters += block.transcript.length;
    if (captured.size > 4000 || characters > 2_000_000) throw Object.assign(Error("CAPTURE_BUFFER_LIMIT"), { code: "CAPTURE_BUFFER_LIMIT" });
    lastSnapshot = { status: "live", meetingId: snapshot.meetingId, platform: snapshot.platform };
    return { ...lastSnapshot, blocks: [...captured.values()] };
  }
  function capture() {
    if (!active || paused || busy) return Promise.resolve();
    if (capturePromise) return capturePromise;
    const run = generation;
    const task = (async () => {
      try {
        const snapshot = await evaluate("read");
        if (!active || paused || run !== generation) return;
        if (snapshot.status !== "live") { captionReady = false; stop(describe(snapshot)); return; }
        remember(snapshot);
      } catch (error) {
        if (active && run === generation) { captionReady = false; stop(describe(error)); }
      }
    })();
    capturePromise = task;
    void task.finally(() => { if (capturePromise === task) capturePromise = undefined; });
    return task;
  }
  async function flush() {
    if (!active || paused || busy || !lastSnapshot || stream.busy) return;
    const run = generation;
    await capture();
    if (!active || paused || run !== generation || !lastSnapshot) return;
    try {
      await stream.update({ ...lastSnapshot, blocks: [...captured.values()] });
      if (!active || paused || run !== generation) return;
      status("標準字幕を取得約1秒／送信約5秒で転送中。送信済みバッチ " + stream.run.sequence);
    } catch (error) {
      if (active && run === generation) {
        if (error.fatal) stop(error.message + "。停止しました。");
        else status("通信失敗：同じ未確認バッチを次回再送します。停止で破棄できます。");
      }
    }
  }
  async function startOrResume(resume) {
    if (busy || (resume ? !active || !paused : active)) return;
    if (!resume && (!captionReady || !el("consent").checked || !el("meeting").value)) { status("字幕確認、会議選択、参加者同意が必要です。"); return; }
    if (!resume && !/^[A-Za-z0-9_-]{43}$/.test(el("token").value.trim())) { status("ペアリングトークンを確認してください。"); return; }
    if (!resume) { pairingToken = el("token").value.trim(); meetingId = el("meeting").value; }
    active = true; busy = true;
    const run = ++generation;
    controller = new AbortController(); captureId = crypto.randomUUID();
    controls(); status(resume ? "再開準備中。現在の字幕を除外します。" : "接続中。まだ字幕は転送していません。");
    try {
      await request("/health");
      if (!active || run !== generation) return;
      const snapshot = await evaluate("start");
      if (!active || run !== generation) return;
      if (snapshot.status !== "live") { captionReady = false; stop(describe(snapshot)); return; }
      if (snapshot.meetingId !== meetingId) { captionReady = false; stop(describe({ code: "MEETING_CHANGED" })); return; }
      captured.clear();
      const baseline = remember(snapshot);
      if (resume) await stream.update(baseline); else stream.start(baseline);
      if (!active || run !== generation) return;
      paused = false; readTimer = setInterval(capture, 1000); sendTimer = setInterval(flush, 5000);
      status("転送開始。現在の字幕は除外し、次の新しい字幕行から送ります。Tactiqの一時停止とは連動しません。");
    } catch (error) {
      if (run === generation) stop(error.code ? describe(error) : error.fatal ? error.message + "。停止しました。" : "接続できないため停止しました。Claude側のサーバーを確認してください。");
    } finally { if (run === generation) { busy = false; controls(); } }
  }
  function togglePause() {
    if (!active || busy || !stream.run) return;
    if (paused) { void startOrResume(true); return; }
    paused = true; generation++;
    clearInterval(readTimer); clearInterval(sendTimer); readTimer = sendTimer = undefined; controller?.abort();
    capturePromise = lastSnapshot = undefined; captured.clear();
    void stream.update({ status: "paused" }); resetReader(); controls();
    status("一時停止中。字幕の読取り・送信を行いません。再開時の字幕も除外します。");
  }
  const navigate = () => { captionReady = false; stop("ページが移動したため停止しました。字幕を再確認してください。"); el("meeting").replaceChildren(); controls(); };
  el("refresh").addEventListener("click", refresh);
  el("start").addEventListener("click", () => { void startOrResume(false); });
  el("pause").addEventListener("click", togglePause);
  el("stop").addEventListener("click", () => stop());
  el("meeting").addEventListener("change", controls);
  el("consent").addEventListener("change", controls);
  onNavigated.addListener(navigate); controls();
  return { stop, dispose() { stop(); onNavigated.removeListener(navigate); } };
}
if (globalThis.chrome?.devtools && globalThis.document) {
  const panel = createPanel({ document, inspectedWindow: chrome.devtools.inspectedWindow, onNavigated: chrome.devtools.network.onNavigated, fetch: globalThis.fetch.bind(globalThis), setInterval, clearInterval });
  addEventListener("pagehide", () => panel.dispose(), { once: true });
  addEventListener("tactiq-panel-hidden", () => panel.stop("パネルを離れたため停止しました。"));
}
