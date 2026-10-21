// MAIN/document_start on the Zoom web client. Intercepts Zoom's own live-transcription state; reads nothing from the page DOM text and never mutates the page.
// Only after an explicit start: subscribes (read-only) to the app's Redux store and forwards changes of its caption messages.
// No transcript processing while idle; never sends, or touches tokens, HTTP or sockets.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1", core = page.__liveCaptionsHookCore;
  try { delete page.__liveCaptionsHookCore; } catch {}
  if (typeof core !== "function" || page !== page.top || page.location.protocol !== "https:" || page.location.hostname !== "app.zoom.us" || page[key]) return;
  const currentMeeting = () => {
    const match = page.location.protocol === "https:" && page.location.hostname === "app.zoom.us" ? /^\/wc\/(\d{5,15})\//.exec(page.location.pathname) : null;
    return match ? `app.zoom.us/wc/${match[1]}` : null;
  };
  const life = core(page, { meeting: currentMeeting, cleanup(s) { s.records.clear(); s.speakers.clear(); s.names.clear(); } });
  const { finish } = life;
  // The meeting UI may live in an iframe. The store is found the way the app's own React tree holds it: a props.store with getState/subscribe/dispatch.
  const isStore = value => typeof value === "object" && value !== null && typeof value.getState === "function" && typeof value.subscribe === "function" && typeof value.dispatch === "function";
  const hasTranscription = store => { try { const state = store.getState(); return typeof state === "object" && state !== null && "newLiveTranscription" in state; } catch { return false; } };
  const documents = () => {
    const out = [];
    try { for (const selector of ["#webclient", ".pwa-webclient__iframe-wrapper iframe"]) { const doc = page.document.querySelector(selector)?.contentDocument; if (doc) out.push(doc); } } catch {}
    out.push(page.document);
    return out;
  };
  function searchStore(doc) {
    const roots = [];
    try { for (const element of doc.body ? doc.body.querySelectorAll(":scope > *, :scope > * > *, :scope > * > * > *") : []) {
      const name = Object.keys(element).find(k => k.startsWith("__reactContainer")); if (name) roots.push(element[name]);
    } } catch { return null; }
    for (const root of roots) {
      const stack = [root]; let visited = 0;
      while (stack.length && visited < 5000) {
        const fiber = stack.pop(); visited++;
        const candidate = fiber?.memoizedProps?.store;
        if (isStore(candidate) && hasTranscription(candidate)) return candidate;
        if (fiber?.sibling) stack.push(fiber.sibling);
        if (fiber?.child) stack.push(fiber.child);
      }
    }
    return null;
  }
  let known = null;
  const findStore = () => {
    if (known && hasTranscription(known)) return known;
    known = null;
    for (const doc of documents()) { const store = searchStore(doc); if (store) { known = store; break; } }
    return known;
  };
  // Zoom text can carry a leading form feed, NULs and replacement characters.
  const sanitize = text => {
    if (typeof text !== "string" || text.length > 32768) return null;
    let value = text; if (value.codePointAt(0) === 12) value = value.substring(1);
    value = value.replace(/\0/g, "").replace(/\ufffd/g, "");
    return value.trim() ? value : "";
  };
  function ingest(s, message, excluded) {
    const user = message?.user, text = sanitize(message?.text);
    if (!message || typeof message.msgId === "undefined" || message.msgId === null || text === null || !user || typeof user !== "object" || user.zoomID === undefined || user.zoomID === null) { life.drop(s); return; }
    if (!text) return;
    const speaker = String(user.zoomID), name = life.displayName(user.displayName);
    if (name) s.names.set(speaker, name);
    life.offer(s, { key: `${message.msgId}/${speaker}`, speaker, text, excluded });
  }
  function scan(s, messages, previous, excluded) {
    for (const message of Object.values(messages)) if (previous?.[message?.msgId] !== message) ingest(s, message, excluded);
  }
  function attach(s) {
    const store = findStore(); if (!store) throw life.invalid();
    const read = () => { const live = store.getState()?.newLiveTranscription?.newLTMessage; return live && typeof live === "object" ? live : null; };
    let last = read();
    if (last) scan(s, last, null, true);
    const unsubscribe = store.subscribe(() => life.guard(s, () => {
      const next = read();
      if (next && next !== last) { scan(s, next, last, false); last = next; }
    }));
    return () => { try { unsubscribe(); } catch {} };
  }
  function metadata() {
    const id = currentMeeting();
    const code = !id ? "NOT_MEETING_PAGE" : findStore() ? "READY" : "ZOOM_STORE_NOT_FOUND";
    const stats = life.current?.stats ?? life.terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, dropped: 0, queued: 0 };
    return { status: "ready", source: "zoom-store-experimental", platform: "Zoom",
      meetings: id ? [{ id, title: "Zoom Webクライアント（字幕の内部状態・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: 0, captionChannels: 0, ...stats } };
  }
  const command = params => life.messageCommand(params ?? {}, { metadata, platform: "Zoom", attach, nameOf: (record, s) => s.names.get(record.speaker) ?? "", extra: { names: new Map() } });
  Object.defineProperty(page, key, { value: Object.freeze({ version: 1, command }), configurable: false, writable: false });
  page.addEventListener("pagehide", () => finish("MEETING_CHANGED"));
})();
