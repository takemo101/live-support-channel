// MAIN/document_start on the Zoom web client. Reads only the caption box the user has made visible, and only after an explicit start.
// No transcript processing while idle; never mutates the page, sends, or touches tokens, HTTP, sockets or app state.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1";
  if (page !== page.top || page.location.protocol !== "https:" || page.location.hostname !== "app.zoom.us" || page[key]) return;
  const { MutationObserver: Observer } = page;
  const now = page.performance.now.bind(page.performance), wallTime = page.Date.now.bind(page.Date);
  const timeout = page.setTimeout.bind(page), cancel = page.clearTimeout.bind(page);
  const LEASE = 2000, BOX = ".live-transcription-subtitle__box", FRAME = "#webclient";
  let current = null, terminal = null, generation = 0;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const currentMeeting = () => {
    const match = page.location.protocol === "https:" && page.location.hostname === "app.zoom.us" ? /^\/wc\/(\d{5,15})\//.exec(page.location.pathname) : null;
    return match ? `app.zoom.us/wc/${match[1]}` : null;
  };
  const frameDocument = () => { try { return page.document.querySelector(FRAME)?.contentDocument ?? null; } catch { return null; } };
  function finish(code) {
    const s = current; if (!s) return generation;
    const retired = ++generation;
    current = null; cancel(s.timer);
    try { s.observer?.disconnect(); } catch {}
    terminal = { owner: s.owner, generation: s.generation, meetingId: s.meetingId, code, stats: { ...s.stats, queued: 0, inFlight: 0 } };
    s.records.length = 0; s.speakers.clear(); s.observed = null;
    return retired;
  }
  function valid(s) {
    if (current !== s) return false;
    if (now() >= s.deadline) { finish("CAPTURE_EXPIRED"); return false; }
    if (currentMeeting() !== s.meetingId) { finish("MEETING_CHANGED"); return false; }
    return true;
  }
  function renew(s) {
    cancel(s.timer); s.deadline = now() + LEASE;
    s.timer = timeout(() => { if (current === s) finish("CAPTURE_EXPIRED"); }, LEASE);
  }
  const clean = value => value.replace(/\s+/g, " ").trim();
  // Zoom shows rolling text: the new display either extends the old one or drops its beginning. Returns the appended part, or null if unrelated.
  function continuation(previous, next) {
    if (next.startsWith(previous)) return next.slice(previous.length);
    for (let length = Math.min(previous.length, next.length, 512); length >= 4; length--) if (next.startsWith(previous.slice(-length))) return next.slice(length);
    return null;
  }
  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length && i < 4096; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  // The only structure relied on: caption rows are <img avatar> followed by a text element. Anything else with text is unknown.
  function rows(box) {
    const images = [...box.querySelectorAll("img")];
    if (!images.length) { if (clean(box.textContent ?? "")) fail("CAPTION_FORMAT_UNKNOWN"); return []; }
    if (images.length > 64) fail("CAPTION_LIMIT");
    const out = [];
    for (const image of images) {
      const element = image.nextElementSibling; if (!element) continue;
      const text = clean(element.textContent ?? ""); if (!text) continue;
      if (text.length > 32768) fail("CAPTION_LIMIT");
      out.push({ element, text, avatar: hash(String(image.src ?? "")) });
    }
    return out;
  }
  function speakerNumber(s, avatar) {
    let number = s.speakers.get(avatar);
    if (!number) { if (s.speakers.size >= 256) fail("CAPTION_LIMIT"); number = s.speakers.size + 1; s.speakers.set(avatar, number); }
    return number;
  }
  function update(s, record, text, added) {
    s.stats.received++;
    record.text = added === null ? text : record.text + added; record.shown = text; record.revision++;
    s.characters += record.text.length - (record.block?.transcript.length ?? 0);
    if (s.characters > 2_000_000) fail("CAPTION_LIMIT");
    record.block = { messageId: record.localId, deviceId: `speaker-${record.speaker}`, messageVersion: record.revision,
      speakerName: `話者 ${record.speaker}（名前未確認）`, transcript: record.text, timestamp: record.block?.timestamp ?? wallTime(), version: record.revision };
    s.stats.accepted++;
  }
  function create(s, row, excluded) {
    if (s.records.length >= 4000) fail("CAPTION_LIMIT");
    const speaker = speakerNumber(s, row.avatar);
    const record = { speaker, avatar: row.avatar, shown: row.text, text: row.text, revision: 0, excluded, block: null, localId: `${s.owner}:${s.records.length + 1}` };
    s.records.push(record); s.elements.set(row.element, record);
    if (excluded) { s.stats.baselineExcluded++; return; }
    update(s, record, row.text, null);
  }
  function sample(s, baseline = false) {
    const box = frameDocument()?.querySelector(BOX) ?? null;
    if (box !== s.observed) {
      try { s.observer?.disconnect(); } catch {}
      s.observed = box;
      if (box) { s.observer = new Observer(() => { if (valid(s)) watch(s); }); s.observer.observe(box, { subtree: true, childList: true, characterData: true }); }
    }
    if (!box) return;
    for (const row of rows(box)) {
      const known = s.elements.get(row.element);
      if (!known) {
        // A re-rendered row that continues something already seen is the same utterance, not a new one.
        const same = s.records.slice(-32).findLast(r => r.avatar === row.avatar && !r.excluded && (continuation(r.text, row.text) !== null || r.text.startsWith(row.text)));
        if (same) { s.elements.set(row.element, same); if (row.text !== same.shown) { const added = continuation(same.shown, row.text); if (added !== null && added) update(s, same, row.text, added); else same.shown = row.text; } continue; }
        create(s, row, baseline); continue;
      }
      if (row.text === known.shown) continue;
      const added = row.avatar === known.avatar ? continuation(known.shown, row.text) : null;
      if (added === null) { create(s, row, false); continue; }
      if (known.excluded) { known.shown = row.text; s.stats.baselineExcluded++; continue; }
      if (added) update(s, known, row.text, added); else known.shown = row.text;
    }
  }
  function watch(s) {
    try { sample(s); }
    catch (error) { if (current === s) finish(["CAPTION_LIMIT"].includes(error?.code) ? error.code : "CAPTION_FORMAT_UNKNOWN"); }
  }
  function metadata() {
    const id = currentMeeting();
    const code = !id ? "NOT_MEETING_PAGE" : frameDocument() ? "READY" : "ZOOM_FRAME_NOT_FOUND";
    const stats = current?.stats ?? terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "zoom-dom-experimental", platform: "Zoom",
      meetings: id ? [{ id, title: "Zoom Webクライアント（画面字幕・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: 0, captionChannels: 0, ...stats } };
  }
  function command({ action = "discover", meetingId, captureId, previousCaptureId } = {}) {
    if (action === "reset") {
      if (current?.owner === captureId) {
        const retired = finish("CAPTURE_RESET"); if (generation === retired) terminal = null;
      }
      else if (terminal?.owner === captureId) terminal = null;
      return { status: "idle" };
    }
    if (action === "discover") return metadata();
    if (!currentMeeting() || currentMeeting() !== meetingId) return { status: "ended", code: "MEETING_CHANGED" };
    if (typeof captureId !== "string" || !captureId.length || captureId.length > 128) return { status: "unavailable", code: "INVALID_CAPTURE" };
    // Recovery only continues the same meeting after its own lease lapsed; any other end state needs a user action.
    if (action === "recover" && (current || terminal?.code !== "CAPTURE_EXPIRED" || terminal.meetingId !== meetingId
      || typeof previousCaptureId !== "string" || terminal.owner !== previousCaptureId || previousCaptureId === captureId)) return { status: "ended", code: "CAPTURE_CHANGED" };
    if (action === "start" || action === "recover") {
      const meta = metadata(); if (!meta.captionReady) return { status: "unavailable", code: meta.code };
      const retired = finish("CAPTURE_REPLACED");
      if (generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      terminal = null;
      const s = { owner: captureId, meetingId, observer: null, observed: null, elements: new WeakMap(), records: [], speakers: new Map(), characters: 0,
        stats: { received: 0, accepted: 0, baselineExcluded: 0, queued: 0, inFlight: 0 } };
      current = s; s.generation = ++generation; renew(s);
      try { sample(s, true); }
      catch (error) { if (current === s) finish(error?.code === "CAPTION_LIMIT" ? "CAPTION_LIMIT" : "CAPTION_FORMAT_UNKNOWN"); return { status: "unavailable", code: terminal.code }; }
    }
    if (!current || current.owner !== captureId) return { status: "ended", code: terminal?.owner === captureId ? terminal.code : "CAPTURE_CHANGED",
      diagnostics: terminal?.owner === captureId ? { ...terminal.stats } : undefined };
    if (action !== "start" && action !== "recover" && action !== "read") return { status: "unavailable", code: "INVALID_CAPTURE" };
    const s = current; if (!valid(s)) return { status: "ended", code: terminal?.code ?? "CAPTURE_CHANGED", diagnostics: { ...terminal?.stats } };
    if (action === "read") { watch(s); if (current !== s) return { status: "ended", code: terminal?.code ?? "CAPTURE_CHANGED", diagnostics: { ...terminal?.stats } }; }
    renew(s);
    return { status: "live", meetingId, platform: "Zoom", blocks: s.records.flatMap(r => r.block ? [{ ...r.block }] : []), diagnostics: { ...s.stats } };
  }
  Object.defineProperty(page, key, { value: Object.freeze({ version: 1, command }), configurable: false, writable: false });
  page.addEventListener("pagehide", () => finish("MEETING_CHANGED"));
})();
