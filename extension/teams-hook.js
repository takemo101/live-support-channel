// MAIN/document_start on Teams. Reads only the live-caption list the user has made visible, and only after an explicit start.
// No transcript processing while idle; never mutates the page, starts captions, sends, or touches tokens, HTTP, sockets, RTC or app state.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1", core = page.__liveCaptionsHookCore;
  try { delete page.__liveCaptionsHookCore; } catch {}
  const hosts = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);
  if (typeof core !== "function" || page !== page.top || page.location.protocol !== "https:" || !hosts.has(page.location.hostname) || page[key]) return;
  const { MutationObserver: Observer } = page;
  const wallTime = page.Date.now.bind(page.Date);
  const LIST = '[data-tid="closed-caption-v2-virtual-list-content"]';
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const currentMeeting = () => page.location.protocol === "https:" && hosts.has(page.location.hostname) ? `${page.location.hostname}/call` : null;
  const findList = () => { try { return page.document.querySelector(LIST); } catch { return null; } };
  const life = core(page, { meeting: currentMeeting, cleanup(s) {
    try { s.observer?.disconnect(); } catch {}
    s.records.length = 0; s.speakers.clear(); s.observed = null;
  } });
  const { finish, valid } = life;
  const PREFIX = 16;
  // Teams revises a caption in place (words are corrected, punctuation and case added); an element reused for a different sentence shares no real prefix.
  function related(a, b) {
    if (a === b) return true;
    const x = life.letters(a), y = life.letters(b), limit = Math.min(PREFIX, x.length, y.length); let i = 0;
    while (i < limit && x[i] === y[i]) i++;
    return limit > 0 && i === limit;
  }
  // The only structure relied on: a text element whose parent is preceded by a sibling element holding the speaker's label.
  // Text that cannot be attributed this way is unknown: if nothing at all in the list matches, the reader stops instead of guessing.
  function rows(list, stats) {
    const { rows: out, unmatched } = life.labelledRows(list, 1);
    stats.rows = out.length; stats.unmatched = unmatched;
    if (!out.length && unmatched) fail("CAPTION_FORMAT_UNKNOWN");
    if (out.length > 256) fail("CAPTION_LIMIT");
    return out;
  }
  function speakerNumber(s, name) {
    let number = s.speakers.get(name);
    if (!number) { if (s.speakers.size >= 256) fail("CAPTION_LIMIT"); number = s.speakers.size + 1; s.speakers.set(name, number); }
    return number;
  }
  function update(s, record, text) {
    s.stats.received++;
    record.text = text; record.revision++;
    s.characters += text.length - (record.block?.transcript.length ?? 0);
    if (s.characters > 2_000_000) fail("CAPTION_LIMIT");
    record.block = { messageId: record.localId, deviceId: `speaker-${record.speaker}`, messageVersion: record.revision,
      speakerName: record.name, transcript: text, timestamp: record.block?.timestamp ?? wallTime(), version: record.revision };
    s.stats.accepted++;
  }
  function create(s, row, excluded) {
    if (s.records.length >= 4000) fail("CAPTION_LIMIT");
    const speaker = speakerNumber(s, row.name);
    const record = { speaker, name: row.name, text: row.text, revision: 0, excluded, block: null, localId: `${s.owner}:${s.records.length + 1}` };
    s.records.push(record); s.elements.set(row.element, record);
    if (excluded) { s.stats.baselineExcluded++; return; }
    update(s, record, row.text);
  }
  function revise(s, record, text) {
    if (text === record.text) return;
    if (record.excluded) { record.text = text; s.stats.baselineExcluded++; return; }
    update(s, record, text);
  }
  function sample(s, baseline = false) {
    const list = findList();
    if (list !== s.observed) {
      try { s.observer?.disconnect(); } catch {}
      s.observed = list;
      if (list) { s.observer = new Observer(() => { if (valid(s)) watch(s); }); s.observer.observe(list, { subtree: true, childList: true, characterData: true }); }
    }
    if (!list) return;
    for (const row of rows(list, s.stats)) {
      const known = s.elements.get(row.element);
      if (known && known.name === row.name && related(known.text, row.text)) { revise(s, known, row.text); continue; }
      // A re-rendered row of an utterance already seen is the same utterance, not a new one.
      const same = s.records.slice(-32).findLast(r => r.name === row.name && related(r.text, row.text));
      if (same && !known) { s.elements.set(row.element, same); revise(s, same, row.text); continue; }
      create(s, row, baseline && !known);
    }
  }
  function watch(s) {
    try { sample(s); }
    catch (error) { if (life.current === s) { s.stats.tids = tids(); finish(error?.code === "CAPTION_LIMIT" ? "CAPTION_LIMIT" : "CAPTION_FORMAT_UNKNOWN"); } }
  }
  // Only the names of UI hooks (never text) help diagnose a changed Teams layout.
  function tids() {
    try {
      const wrapper = page.document.querySelector(LIST)?.closest('[data-tid="closed-caption-renderer-wrapper"]') ?? page.document.querySelector('[data-tid="closed-caption-renderer-wrapper"]');
      const found = new Set();
      for (const element of wrapper?.querySelectorAll("[data-tid]") ?? []) {
        const tid = element.getAttribute("data-tid");
        if (/^[A-Za-z0-9_.-]{1,48}$/.test(tid ?? "")) found.add(tid);
        if (found.size >= 12) break;
      }
      return [...found];
    } catch { return []; }
  }
  function metadata() {
    const id = currentMeeting();
    const code = !id ? "NOT_MEETING_PAGE" : findList() ? "READY" : "TEAMS_CAPTIONS_NOT_FOUND";
    const stats = life.current?.stats ?? life.terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "teams-dom-experimental", platform: "Teams",
      meetings: id ? [{ id, title: "Microsoft Teams（画面字幕・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: 0, captionChannels: 0, ...stats, ...(code === "READY" ? {} : { tids: tids() }) } };
  }
  function command(params = {}) {
    const early = life.prologue(params, metadata); if (early) return early;
    const { action, meetingId, captureId } = params;
    if (action === "start" || action === "recover") {
      const meta = metadata(); if (!meta.captionReady) return { status: "unavailable", code: meta.code };
      const retired = finish("CAPTURE_REPLACED");
      if (life.generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      life.clearTerminal();
      const s = { owner: captureId, meetingId, observer: null, observed: null, elements: new WeakMap(), records: [], speakers: new Map(), characters: 0,
        stats: { rows: 0, unmatched: 0, received: 0, accepted: 0, baselineExcluded: 0, queued: 0, inFlight: 0 } };
      life.activate(s);
      try { sample(s, true); }
      catch (error) { if (life.current === s) { s.stats.tids = tids(); finish(error?.code === "CAPTION_LIMIT" ? "CAPTION_LIMIT" : "CAPTION_FORMAT_UNKNOWN"); } return { status: "unavailable", code: life.terminal.code }; }
    }
    return life.epilogue(params, { platform: "Teams", blocks: s => s.records.flatMap(r => r.block ? [{ ...r.block }] : []),
      before: (s, action) => { if (action === "read") watch(s); } });
  }
  Object.defineProperty(page, key, { value: Object.freeze({ version: 1, command }), configurable: false, writable: false });
  page.addEventListener("pagehide", () => finish("MEETING_CHANGED"));
})();
