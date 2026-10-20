// MAIN/document_start, loaded immediately before a platform hook in the same content-script entry.
// Shared capture lifecycle (owner, lease, terminal state, recover guard, command envelope) plus two pure helpers over an element the hook hands in:
// displayName (sanitising a visible speaker label) and labelledRows (pairing visible caption text with its speaker label). Nothing else reads page data.
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
    const clean = value => value.replace(/\s+/g, " ").trim();
    const letters = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    // A speaker label is untrusted page text that ends up in the model's input: control and bidi-override characters are dropped and the length is bounded.
    const displayName = raw => typeof raw === "string" ? clean(raw.replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")).slice(0, 64) : "";
    // Caption text elements with their speaker label. `up` = 0: the label is the text element's previous sibling; 1: the previous sibling of its parent.
    // A label that itself holds a complete (label, text) pair is really an enclosing item and is never taken as a label.
    function labelledRows(list, up) {
      const walker = list.ownerDocument.createTreeWalker(list, 4);
      const anchorOf = element => up ? element.parentElement : element;
      const candidates = new Map();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!clean(node.nodeValue ?? "")) continue;
        const element = node.parentElement;
        if (!element || element === list || candidates.has(element)) continue;
        const anchor = anchorOf(element);
        candidates.set(element, anchor && anchor !== list && list.contains(anchor) ? anchor.previousElementSibling : null);
        if (candidates.size > 512) throw Object.assign(new Error("CAPTION_LIMIT"), { code: "CAPTION_LIMIT" });
      }
      const elements = [...candidates.keys()];
      const holdsRow = item => elements.some(x => { const a = anchorOf(x), label = a?.previousElementSibling; return item.contains(x) && a !== item && label && item.contains(label) && clean(label.textContent ?? ""); });
      const genuine = new Map();
      for (const [element, label] of candidates) if (label && displayName(label.textContent ?? "") && !holdsRow(label)) genuine.set(element, label);
      const labels = new Set(genuine.values());
      const rows = []; let unmatched = 0;
      for (const element of elements) {
        if ([...labels].some(l => l.contains(element))) continue;
        const label = genuine.get(element), name = label ? displayName(label.textContent ?? "") : "", text = clean(element.textContent ?? "");
        if (!name || !text) { unmatched++; continue; }
        if (text.length > 32768) throw Object.assign(new Error("CAPTION_LIMIT"), { code: "CAPTION_LIMIT" });
        rows.push({ element, name, text });
      }
      return { rows, unmatched };
    }
    return { finish, valid, renew, activate, prologue, epilogue, displayName, labelledRows, letters,
      get current() { return current; }, get terminal() { return terminal; }, get generation() { return generation; }, clearTerminal() { terminal = null; } };
  }
  Object.defineProperty(window, handoff, { value: createLifecycle, configurable: true, writable: false });
})();
