// MAIN/document_start, loaded immediately before a platform hook in the same content-script entry.
// Shared capture lifecycle (owner, lease, terminal state, recover guard, command envelope) and the skeleton the message readers (Teams, Zoom) share:
// speaker numbering, per-message revisions with a baseline, and the start/recover/read command. It reads no page data itself; a hook hands it
// already-extracted messages (offer) and a speaker-label sanitiser (displayName).
// The factory is handed over through a one-shot window property that the hook removes before any page script can run.
(() => {
  const handoff = "__liveCaptionsHookCore";
  function createLifecycle(page, { meeting, check, cleanup, inFlight }) {
    const LEASE = 2000;
    const now = page.performance.now.bind(page.performance);
    const timeout = page.setTimeout.bind(page), cancel = page.clearTimeout.bind(page);
    let current = null, terminal = null, generation = 0;
    function finish(code) {
      const s = current; if (!s) return generation;
      const retired = ++generation;
      current = null; cancel(s.timer);
      try { s.detach?.(); } catch {}
      s.detach = null;
      terminal = { owner: s.owner, generation: s.generation, meetingId: s.meetingId, code, assisted: s.assisted === true,
        stats: { ...s.stats, queued: 0, inFlight: inFlight ? inFlight(s) : 0 } };
      cleanup(s);
      return retired;
    }
    function valid(s) {
      if (current !== s) return false;
      if (now() >= s.deadline) { finish("CAPTURE_EXPIRED"); return false; }
      if (meeting() !== s.meetingId) { finish("MEETING_CHANGED"); return false; }
      const code = check ? check(s) : null; if (current !== s) return false;
      if (code) { finish(code); return false; }
      return true;
    }
    function renew(s) {
      cancel(s.timer); s.deadline = now() + LEASE;
      s.timer = timeout(() => { if (current === s) finish("CAPTURE_EXPIRED"); }, LEASE);
    }
    function activate(s) { current = s; s.generation = ++generation; renew(s); }
    // Handles reset/discover and the checks every other action shares; returns a response, or null to continue.
    function prologue({ action = "discover", meetingId, captureId, previousCaptureId } = {}, discover) {
      if (action === "reset") {
        if (current?.owner === captureId) {
          const retired = finish("CAPTURE_RESET"); if (generation === retired) terminal = null;
        }
        else if (terminal?.owner === captureId) terminal = null;
        return { status: "idle" };
      }
      if (action === "discover") return discover();
      if (!meeting() || meeting() !== meetingId) return { status: "ended", code: "MEETING_CHANGED" };
      if (typeof captureId !== "string" || !captureId.length || captureId.length > 128) return { status: "unavailable", code: "INVALID_CAPTURE" };
      // Recovery only continues the same meeting after its own lease lapsed; any other end state needs a user action.
      if (action === "recover" && (current || terminal?.code !== "CAPTURE_EXPIRED" || terminal.meetingId !== meetingId
        || typeof previousCaptureId !== "string" || terminal.owner !== previousCaptureId || previousCaptureId === captureId)) return { status: "ended", code: "CAPTURE_CHANGED" };
      return null;
    }
    // Validates the caller's capture, runs `before` (e.g. a fresh scan on read), renews the lease and answers with the blocks.
    function epilogue({ action, meetingId, captureId }, { platform, blocks, before }) {
      const ended = () => ({ status: "ended", code: terminal?.code ?? "CAPTURE_CHANGED", diagnostics: { ...terminal?.stats } });
      if (!current || current.owner !== captureId) return { status: "ended", code: terminal?.owner === captureId ? terminal.code : "CAPTURE_CHANGED",
        diagnostics: terminal?.owner === captureId ? { ...terminal.stats } : undefined };
      if (action !== "start" && action !== "recover" && action !== "read") return { status: "unavailable", code: "INVALID_CAPTURE" };
      const s = current; if (!valid(s)) return ended();
      if (before) { before(s, action); if (current !== s) return ended(); }
      renew(s);
      return { status: "live", meetingId, platform, blocks: blocks(s), diagnostics: { ...s.stats } };
    }
    const limit = () => Object.assign(new Error("CAPTION_LIMIT"), { code: "CAPTION_LIMIT" });
    const clean = value => value.replace(/\s+/g, " ").trim();
    const invalid = () => Object.assign(new Error("CAPTION_FORMAT_UNKNOWN"), { code: "CAPTION_FORMAT_UNKNOWN" });
    // A speaker label is untrusted page text that ends up in the model's input: control and bidi-override characters are dropped and the length is bounded.
    const displayName = raw => typeof raw === "string" ? clean(raw.replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")).slice(0, 64) : "";
    const wallTime = page.Date.now.bind(page.Date);
    const anonymous = number => `話者 ${number}（名前未確認）`;
    // --- Message reader skeleton. A reader state holds s.records (key -> record), s.speakers (speaker key -> number), s.characters and s.detach.
    function speakerNumber(s, key) {
      let number = s.speakers.get(key);
      if (!number) { if (s.speakers.size >= 256) throw limit(); number = s.speakers.size + 1; s.speakers.set(key, number); }
      return number;
    }
    // One message (key = stable id of an utterance, speaker = stable id of who said it). The first sight of an `excluded` message, and every later
    // change to it, is never sent. Any other message is upserted: its text is the latest text, its version counts the changes.
    function offer(s, { key, speaker, text, excluded = false }) {
      let record = s.records.get(key);
      if (!record) {
        if (s.records.size >= 4000) throw limit();
        record = { speaker, number: speakerNumber(s, speaker), text: null, revision: 0, excluded, block: null, localId: `${s.owner}:${s.records.size + 1}` };
        s.records.set(key, record);
        if (excluded) { record.text = text; s.stats.baselineExcluded++; return; }
      } else if (record.excluded) {
        if (record.text !== text) { record.text = text; s.stats.baselineExcluded++; }
        return;
      }
      if (record.text === text) return;
      s.stats.received++;
      s.characters += text.length - (record.block?.transcript.length ?? 0);
      if (s.characters > 2_000_000) throw limit();
      record.text = text; record.revision++;
      record.block = { messageId: record.localId, deviceId: `speaker-${record.number}`, messageVersion: record.revision, speakerName: "",
        transcript: text, timestamp: record.block?.timestamp ?? wallTime(), version: record.revision };
      s.stats.accepted++;
    }
    // An item the reader could not use: it is never forwarded and never stops the capture (a channel can carry plenty of non-caption traffic
    // before the first caption); the count is what the panel shows.
    function drop(s) { s.stats.dropped++; }
    const stop = (s, error) => {
      if (current !== s) return;
      finish(error?.code === "CAPTION_LIMIT" ? "CAPTION_LIMIT" : "CAPTION_FORMAT_UNKNOWN");
    };
    // Runs reader code that was triggered by page code: a reader error stops the capture and is never rethrown into the page.
    function guard(s, run) { try { if (valid(s)) run(); } catch (error) { stop(s, error); } }
    // start / recover / read. `attach(s)` hooks the page and returns the function that unhooks; `nameOf(record, s)` gives the speaker's display name or "".
    function messageCommand(params, { metadata, platform, attach, nameOf, check, extra = {}, stats = {} }) {
      const assist = params.assistCaptions === true;
      const early = prologue(params, () => metadata(assist)); if (early) return early;
      const { action, meetingId, captureId } = params;
      if (action === "start" || action === "recover") {
        const assisted = action === "recover" ? terminal?.assisted === true : assist;
        const meta = metadata(assisted); if (!meta.captionReady) return { status: "unavailable", code: meta.code };
        const retired = finish("CAPTURE_REPLACED");
        if (generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
        terminal = null;
        const s = { owner: captureId, meetingId, assisted, records: new Map(), speakers: new Map(), characters: 0, detach: null, ...extra,
          stats: { ...stats, received: 0, accepted: 0, baselineExcluded: 0, dropped: 0, queued: 0, inFlight: 0 } };
        activate(s);
        try { s.detach = attach(s); if (current !== s) { s.detach?.(); s.detach = null; } } catch (error) { stop(s, error); return { status: "unavailable", code: terminal?.code ?? "CAPTURE_CHANGED" }; }
      }
      return epilogue(params, { platform, blocks: s => [...s.records.values()].flatMap(r => r.block ? [{ ...r.block, speakerName: nameOf(r, s) || anonymous(r.number) }] : []) });
    }
    return { finish, valid, renew, activate, prologue, epilogue, displayName, offer, drop, guard, messageCommand, clean, invalid,
      get current() { return current; }, get terminal() { return terminal; }, get generation() { return generation; }, clearTerminal() { terminal = null; } };
  }
  Object.defineProperty(window, handoff, { value: createLifecycle, configurable: true, writable: false });
})();
