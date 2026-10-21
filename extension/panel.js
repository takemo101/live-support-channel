import { readCaptions } from "./snapshot.js";
import { CaptionStream } from "./stream.js";
import { shotProblem, describe, statistics } from "./diagnostics.js";
import { captureScreenshot, similar } from "./screenshot.js";

// Batching: "pause" sends once the captions have been quiet for QUIET ms (an utterance run ended) or the oldest unsent change is MAX_HOLD old;
// "5" and "30" send on a fixed cadence in seconds. A failed send is retried after RETRY ms.
const QUIET = 3000, MAX_HOLD = 45000, RETRY = 5000, CADENCE = { 5: 5000, 30: 30000 };
const DESCRIPTION = { pause: "発話の区切りごと（最大45秒）", 5: "約5秒ごと", 30: "約30秒ごと" };
// `screenshot()` resolves to { bytes (JPEG), signature } of the meeting tab, or null when none could be taken (inactive tab, rate limit, no permission).
export function createPanel({ document, inspectedWindow, onNavigated, fetch, setInterval, clearInterval, storage, screenshot, now = () => performance.now() }) {
  const el = id => document.getElementById(id);
  const endpoint = "http://127.0.0.1:43821";
  let active = false, paused = false, busy = false, captionReady = false, failed = false, assistCaptions = false, platform = "Google Meet";
  let batch = "pause", lastChange = 0, pendingSince = null, lastSent = 0, retryAt = 0;
  let generation = 0, readTimer, sendTimer, controller, meetingId, pairingToken, captureId, capturePromise, lastSnapshot, recovery, recoveries = 0;
  const captured = new Map(), signatures = new Map();
  // Screenshots: one is taken per batch (and reused if the batch is resent), uploaded just before it, and skipped while the screen looks unchanged.
  let shotsOn = false, lastShot = null, shotsSent = 0, shotWhy = null;
  const batchShots = new WeakMap();
  const status = message => { el("status").textContent = message; };
  function badge() {
    const [kind, label] = !active ? (failed ? ["error", "停止（要確認）"] : captionReady ? ["ready", "準備OK"] : ["idle", "未準備"])
      : busy ? ["working", "接続中"] : paused ? ["paused", "一時停止中"] : recovery ? ["working", "自動復旧中"] : ["live", "取得中"];
    el("state").textContent = label; el("state").className = "state " + kind;
  }
  function controls() {
    for (const id of ["token", "meeting", "refresh", "consent", "assist", "shots"]) if (el(id)) el(id).disabled = active;
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
    capturePromise = lastSnapshot = undefined; captured.clear(); signatures.clear(); recoveries = 0;
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
  async function takeShot() {
    try {
      const shot = await screenshot();
      if (!shot?.bytes?.length) { shotWhy = "failed"; return null; }
      shotWhy = null;
      if (similar(lastShot, shot.signature)) return null;
      lastShot = shot.signature; return shot;
    } catch (error) { shotWhy = typeof error?.code === "string" ? error.code : "failed"; return null; }
  }
  // A screenshot problem never blocks or stops the captions: the batch goes out either way.
  async function deliver(payload) {
    if (shotsOn) {
      if (!batchShots.has(payload)) batchShots.set(payload, await takeShot());
      const shot = batchShots.get(payload);
      if (shot && active && !paused) {
        try {
          const response = await fetch(endpoint + "/screenshots?sessionId=" + encodeURIComponent(payload.sessionId) + "&sequence=" + payload.sequence, {
            method: "POST", headers: { authorization: "Bearer " + pairingToken, "content-type": "image/jpeg" }, body: shot.bytes, redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          });
          if (response.ok) { shotsSent++; batchShots.set(payload, null); shotWhy = null; } else shotWhy = "upload";
        } catch { shotWhy = "upload"; }
      }
    }
    await request("/captions", payload);
  }
  const stream = new CaptionStream(payload => deliver(payload));
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
        ? "準備OK（Teams）。Teamsのライブキャプションを開始してから、トークンを入力し、同意にチェックして「転送開始」を押してください。通話の字幕イベントだけを受け取ります（画面は読みません）。字幕を開始していない間は何も届きません。"
        : platform === "Zoom"
        ? "準備OK（Zoom）。Zoomの字幕（ライブトランスクリプション）をONにしてから、トークンを入力し、同意にチェックして「転送開始」を押してください。Zoomの字幕の内部状態だけを受け取ります（画面は読みません）。"
        : "準備OKです。トークンを入力し、同意にチェックして「転送開始」を押してください。");
    } catch (error) { if (run === generation) status(describe(error)); }
    finally { if (run === generation) controls(); }
  }
  function remember(snapshot) {
    if (snapshot.meetingId !== meetingId) throw Object.assign(Error("MEETING_CHANGED"), { code: "MEETING_CHANGED" });
    if (!Array.isArray(snapshot.blocks) || snapshot.platform !== platform) throw Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" });
    for (const block of snapshot.blocks) {
      if (!block || typeof block.messageId !== "string" || typeof block.transcript !== "string") throw Object.assign(Error("READ_FAILED"), { code: "READ_FAILED" });
      const key = JSON.stringify([block.messageId, block.deviceId ?? ""]), json = JSON.stringify(block);
      captured.set(key, block);
      if (signatures.get(key) !== json) { signatures.set(key, json); lastChange = now(); pendingSince ??= lastChange; }
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
  const due = () => {
    const at = now();
    if (at < retryAt) return false;
    if (batch === "pause") return pendingSince !== null && (at - lastChange >= QUIET || at - pendingSince >= MAX_HOLD);
    return at - lastSent >= CADENCE[batch];
  };
  async function flush() {
    if (!active || paused || busy || recovery || !lastSnapshot || stream.busy || !due()) return;
    const run = generation;
    await capture();
    if (!active || paused || recovery || run !== generation || !lastSnapshot || !due()) return;
    const sentAt = now(); lastSent = sentAt;
    try {
      await stream.update({ ...lastSnapshot, blocks: [...captured.values()] });
      if (!active || paused || run !== generation) return;
      pendingSince = lastChange > sentAt ? lastChange : null;
      status("字幕を転送中（" + DESCRIPTION[batch] + "）。\n" + lastSnapshot.statistics + "／送信済みバッチ=" + stream.run.sequence + (shotsOn ? "／画像=" + shotsSent + (shotWhy ? "（" + shotProblem(shotWhy) + "）" : "") : "") + (recoveries ? `／自動復旧=${recoveries}` : ""));
    } catch (error) {
      if (active && run === generation) {
        if (error.fatal) stop(error.message + "。停止しました。", true);
        else { retryAt = now() + RETRY; status("送信に失敗しました。同じ内容を次回再送します。「停止」で破棄できます。"); }
      }
    }
  }
  async function startOrResume(resume) {
    if (busy || (resume ? !active || !paused : active)) return;
    if (!resume && (!captionReady || !el("consent").checked || !el("meeting").value)) { status("字幕の準備確認と参加者同意が必要です。"); return; }
    if (!resume && !/^[A-Za-z0-9_-]{43}$/.test(el("token").value.trim())) { status("ペアリングトークン（43文字）を確認してください。"); return; }
    if (!resume) { pairingToken = el("token").value.trim(); meetingId = el("meeting").value; assistCaptions = el("assist").checked === true; batch = Object.hasOwn(DESCRIPTION, el("batch")?.value) ? el("batch").value : "pause"; shotsOn = typeof screenshot === "function" && el("shots")?.checked !== false; lastShot = null; shotsSent = 0; }
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
      captured.clear(); signatures.clear();
      const baseline = remember(snapshot);
      lastChange = lastSent = now(); pendingSince = null; retryAt = 0;
      if (resume) await stream.update(baseline); else stream.start(baseline);
      if (!active || run !== generation) return;
      paused = false; readTimer = setInterval(capture, 1000); sendTimer = setInterval(flush, 500);
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
    capturePromise = lastSnapshot = undefined; captured.clear(); signatures.clear(); pendingSince = null;
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
  const panel = createPanel({ document, inspectedWindow: chrome.devtools.inspectedWindow, screenshot: () => captureScreenshot(chrome.devtools.inspectedWindow.tabId), onNavigated: chrome.devtools.network.onNavigated, fetch: globalThis.fetch.bind(globalThis), setInterval, clearInterval,
    storage: chrome.storage?.session && { get: async () => (await chrome.storage.session.get("token")).token, set: token => chrome.storage.session.set({ token }), remove: () => chrome.storage.session.remove("token") } });
  addEventListener("pagehide", () => panel.dispose(), { once: true });
  addEventListener("live-support-panel-hidden", () => panel.stop("パネルを離れたため停止しました。"));
  void panel.refresh();
}
