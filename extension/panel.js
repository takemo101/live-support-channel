import { readTactiq, TACTIQ_CONTEXT } from "./snapshot.js";
import { CaptionStream } from "./stream.js";

export function createPanel({ document, inspectedWindow, onNavigated, fetch, setInterval, clearInterval }) {
  const el = id => document.getElementById(id);
  const endpoint = "http://127.0.0.1:43821";
  let active = false, generation = 0, timer, controller, meetingId, pairingToken, polling = false;
  const status = message => { el("status").textContent = message; };
  function controls() {
    for (const id of ["token", "meeting", "refresh", "consent"]) el(id).disabled = active;
    el("start").disabled = active || !el("meeting").value || !el("consent").checked;
    el("stop").disabled = !active;
  }
  function stop(message = "停止しました。未送信の更新は破棄します。") {
    active = false;
    generation++;
    clearInterval(timer);
    timer = undefined;
    controller?.abort();
    stream.stop();
    controls();
    status(message);
  }
  function evaluate(id) {
    return new Promise((resolve, reject) => {
      inspectedWindow.eval(`(${readTactiq.toString()})(${JSON.stringify(id)})`,
        { scriptExecutionContext: TACTIQ_CONTEXT }, (result, error) => {
          if (error || !result || typeof result.status !== "string") reject(Error("Tactiqの状態を読めません。拡張が動作中か確認してください。"));
          else resolve(result);
        });
    });
  }
  async function request(path, body) {
    const response = await fetch(endpoint + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: "Bearer " + pairingToken, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) {
      const error = Error("受信先エラー HTTP " + response.status);
      error.fatal = response.status >= 400 && response.status < 500;
      throw error;
    }
  }
  const stream = new CaptionStream(payload => request("/captions", payload));
  async function refresh() {
    if (active) return;
    try {
      const result = await evaluate(null);
      if (active) return;
      el("meeting").replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.textContent = "会議を選択";
      placeholder.value = "";
      el("meeting").append(placeholder);
      if (result.status !== "ready") throw new Error("Tactiqの有効な会議を確認できません。");
      for (const meeting of result.meetings) {
        const option = document.createElement("option");
        option.value = meeting.id;
        option.textContent = meeting.title;
        el("meeting").append(option);
      }
      status(result.meetings.length ? "対象の会議を選択し、同意を確認して開始してください。" : "Tactiqで文字起こし中の会議がありません。");
    } catch { status("Tactiqを確認できません。会議とTactiqを起動してから再確認してください。"); }
    controls();
  }
  async function poll() {
    if (!active || polling) return;
    const run = generation;
    polling = true;
    try {
      let snapshot;
      try { snapshot = await evaluate(meetingId); }
      catch { if (run === generation) stop("Tactiqの状態が不明なため停止しました。"); return; }
      if (!active || run !== generation) return;
      await stream.update(snapshot);
      if (!active || run !== generation) return;
      if (!stream.run) { stop("会議終了または状態変更のため停止しました。再確認が必要です。"); return; }
      status(snapshot.status === "paused" ? "Tactiqが一時停止中です。転送しません。" : "転送中：約5秒ごとに更新。送信済みバッチ " + stream.run.sequence);
    } catch (error) {
      if (active && run === generation) {
        if (error.fatal) stop(error.message + "。停止しました。");
        else status("通信失敗：同じ未確認バッチを次回再送します。停止で破棄できます。");
      }
    } finally { polling = false; }
  }
  async function start() {
    if (active) return;
    if (!el("consent").checked || !el("meeting").value) { status("対象会議の選択と参加者同意の確認が必要です。"); return; }
    if (!/^[A-Za-z0-9_-]{43}$/.test(el("token").value.trim())) { status("ペアリングトークンを確認してください。"); return; }
    active = true;
    const run = ++generation;
    pairingToken = el("token").value.trim();
    meetingId = el("meeting").value;
    controller = new AbortController();
    controls();
    status("接続中。まだ字幕は転送していません。");
    try {
      await request("/health");
      if (!active || run !== generation) return;
      const snapshot = await evaluate(meetingId);
      if (!active || run !== generation) return;
      stream.start(snapshot);
      timer = setInterval(poll, 5000);
      status("転送開始。次の新しい発話から送ります。");
    } catch (error) {
      if (run === generation) stop(error.fatal ? error.message : "接続できないため停止しました。Claude側のサーバーとTactiqを確認してください。");
    }
  }
  const navigate = () => {
    stop("ページが移動したため停止しました。会議を再確認してください。");
    el("meeting").replaceChildren();
    controls();
  };
  el("refresh").addEventListener("click", refresh);
  el("start").addEventListener("click", start);
  el("stop").addEventListener("click", () => stop());
  el("meeting").addEventListener("change", controls);
  el("consent").addEventListener("change", controls);
  onNavigated.addListener(navigate);
  controls();
  return { stop, dispose() { stop(); onNavigated.removeListener(navigate); } };
}
if (globalThis.chrome?.devtools && globalThis.document) {
  const panel = createPanel({
    document, inspectedWindow: chrome.devtools.inspectedWindow, onNavigated: chrome.devtools.network.onNavigated,
    fetch: globalThis.fetch.bind(globalThis), setInterval, clearInterval,
  });
  addEventListener("pagehide", () => panel.dispose(), { once: true });
  addEventListener("tactiq-panel-hidden", () => panel.stop("パネルを離れたため停止しました。"));
}
