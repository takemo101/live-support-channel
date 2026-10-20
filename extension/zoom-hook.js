// MAIN/document_start on the Zoom web client. Reads only the caption box the user has made visible, and only after an explicit start.
// No transcript processing while idle; never mutates the page, sends, or touches tokens, HTTP, sockets or app state.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1", core = page.__liveCaptionsHookCore;
  try { delete page.__liveCaptionsHookCore; } catch {}
  if (typeof core !== "function" || page !== page.top || page.location.protocol !== "https:" || page.location.hostname !== "app.zoom.us" || page[key]) return;
  const wallTime = page.Date.now.bind(page.Date);
  const BOX = ".live-transcription-subtitle__box", FRAME = "#webclient";
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const currentMeeting = () => {
    const match = page.location.protocol === "https:" && page.location.hostname === "app.zoom.us" ? /^\/wc\/(\d{5,15})\//.exec(page.location.pathname) : null;
    return match ? `app.zoom.us/wc/${match[1]}` : null;
  };
  const frameDocument = () => { try { return page.document.querySelector(FRAME)?.contentDocument ?? null; } catch { return null; } };
  const life = core(page, { meeting: currentMeeting, cleanup(s) { s.records.length = 0; s.speakers.clear(); s.names.clear(); s.tried.clear(); } });
  const { finish, valid } = life;
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
      out.push({ element, text, avatar: hash(String(image.src ?? "")), src: String(image.src ?? "") });
    }
    return out;
  }
  // Zoom shows the participant's name on their video tile, which uses the same avatar image as the caption row. Anonymous until that tile is visible.
  function lookupName(src) {
    const doc = frameDocument(), box = doc?.querySelector(BOX); if (!doc || !src) return "";
    let seen = 0;
    for (const image of doc.querySelectorAll("img")) {
      if (++seen > 400) break;
      if (image.src !== src || box?.contains(image)) continue;
      const name = life.displayName(image.parentElement?.nextSibling?.textContent ?? "");
      if (name) return name;
    }
    return "";
  }
  function learn(s, speaker, src) {
    if (s.names.has(speaker)) return;
    const at = wallTime(); if (at - (s.tried.get(speaker) ?? 0) < 2000) return;
    s.tried.set(speaker, at);
    const name = lookupName(src); if (name) s.names.set(speaker, name);
  }
  const nameOf = (s, speaker) => s.names.get(speaker) ?? `話者 ${speaker}（名前未確認）`;
  function update(s, record, text, added) {
    s.stats.received++;
    record.text = added === null ? text : record.text + added; record.shown = text; record.revision++;
    life.charge(s, record.text.length - (record.block?.transcript.length ?? 0));
    record.block = { messageId: record.localId, deviceId: `speaker-${record.speaker}`, messageVersion: record.revision,
      speakerName: nameOf(s, record.speaker), transcript: record.text, timestamp: record.block?.timestamp ?? wallTime(), version: record.revision };
    s.stats.accepted++;
  }
  function create(s, row, excluded) {
    const speaker = life.speakerNumber(s, row.avatar); learn(s, speaker, row.src);
    const record = { speaker, avatar: row.avatar, shown: row.text, text: row.text, revision: 0, excluded, block: null, localId: `${s.owner}:${s.records.length + 1}` };
    life.track(s, record); s.elements.set(row.element, record);
    if (excluded) { s.stats.baselineExcluded++; return; }
    update(s, record, row.text, null);
  }
  function sample(s, baseline = false) {
    const box = frameDocument()?.querySelector(BOX) ?? null;
    life.observe(s, box, watch);
    if (!box) return;
    for (const row of rows(box)) {
      const known = s.elements.get(row.element); learn(s, life.speakerNumber(s, row.avatar), row.src);
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
  const watch = s => life.watch(s, sample);
  function metadata() {
    const id = currentMeeting();
    const code = !id ? "NOT_MEETING_PAGE" : frameDocument() ? "READY" : "ZOOM_FRAME_NOT_FOUND";
    const stats = life.current?.stats ?? life.terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "zoom-dom-experimental", platform: "Zoom",
      meetings: id ? [{ id, title: "Zoom Webクライアント（画面字幕・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: 0, captionChannels: 0, ...stats } };
  }
  const command = params => life.domCommand(params ?? {}, { metadata, platform: "Zoom", sample, extra: { names: new Map(), tried: new Map() },
    blocks: s => s.records.flatMap(r => r.block ? [{ ...r.block, speakerName: nameOf(s, r.speaker) }] : []) });
  Object.defineProperty(page, key, { value: Object.freeze({ version: 1, command }), configurable: false, writable: false });
  page.addEventListener("pagehide", () => finish("MEETING_CHANGED"));
})();
