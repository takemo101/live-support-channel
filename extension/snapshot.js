// Serialized into the inspected page; no imports, private extension context, or network access.
export function readCaptions({ action = "discover", meetingId, captureId } = {}) {
  const key = "__liveCaptionsReader_v1";
  if (action === "reset") {
    if (window[key]?.owner === captureId) delete window[key];
    return { status: "idle" };
  }
  const host = location.hostname;
  if (host !== "meet.google.com") {
    const pending = /(^|\.)zoom\.us$/.test(host) || ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(host);
    return { status: "unavailable", code: pending ? "PLATFORM_NOT_IMPLEMENTED" : "UNSUPPORTED_HOST" };
  }
  if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(location.pathname)) return { status: "ended", code: "NOT_MEETING_PAGE" };
  if (window !== window.top) return { status: "unavailable", code: "UNSUPPORTED_FRAME" };
  const id = host + location.pathname.replace(/\/$/, "");
  if (action !== "discover" && meetingId !== id) return { status: "ended", code: "MEETING_CHANGED" };
  const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const controls = [...document.querySelectorAll("button[aria-label]")];
  const enabledControls = controls.filter(button => visible(button) && /^(Turn off captions|字幕をオフにする)(?:\s|[（(]|$)/i.test(button.getAttribute("aria-label")));
  const captionsOn = enabledControls.length > 0;
  const captionsOff = controls.some(button => visible(button) && /^(Turn on captions|字幕をオンにする)(?:\s|[（(]|$)/i.test(button.getAttribute("aria-label")));
  const hidden = document.body?.classList.contains("tactiq-nocc") === true;
  let roots = [...document.querySelectorAll(".a4cQT")].filter(visible), profile = "legacy", unidentified = false;
  if (!roots.length) {
    const regions = [...document.querySelectorAll('div[role="region"][tabindex="0"]')].filter(visible);
    roots = regions.filter(region => /^(captions|subtitles|字幕)$/i.test(region.getAttribute("aria-label") ?? "")
      || (region.id && enabledControls.some(button => (button.getAttribute("aria-controls") ?? "").split(/\s+/).includes(region.id))));
    unidentified = regions.length > 0 && roots.length === 0;
    profile = "region";
  }
  const root = roots.length === 1 ? roots[0] : null;
  const rowRoot = root && (profile === "legacy" ? root.children[1]?.firstElementChild : root);
  const rows = rowRoot ? [...rowRoot.children].slice(0, profile === "region" ? -2 : undefined) : [];
  let code = "READY";
  if (hidden) code = "CAPTIONS_HIDDEN";
  else if (captionsOn === false) code = captionsOff ? "CAPTIONS_OFF" : "CAPTION_CONTROL_NOT_FOUND";
  else if (unidentified) code = "CAPTION_IDENTITY_UNKNOWN";
  else if (roots.length > 1) code = "AMBIGUOUS_CAPTIONS";
  else if (root === null) code = "CAPTIONS_NOT_FOUND";
  else if (rows.length === 0) code = "CAPTION_ROWS_NOT_FOUND";
  else if (rows.length > 4000) code = "CAPTION_LIMIT";
  if (action === "discover") return {
    status: "ready", platform: "Google Meet", source: "native-meet-experimental",
    meetings: [{ id, title: "Google Meet（標準字幕・試験版）" }],
    captionReady: code === "READY", code,
    diagnostics: { roots: roots.length, rows: rows.length, profile, captionsOn },
  };
  if (code !== "READY") return { status: "unavailable", code };
  if (!["start", "read"].includes(action) || typeof captureId !== "string" || !captureId.length || captureId.length > 128) return { status: "unavailable", code: "INVALID_CAPTURE" };
  if (action === "start") window[key] = { owner: captureId, meetingId: id, root, profile, previous: [], records: new WeakMap(), next: 0 };
  const state = window[key];
  if (!state || state.owner !== captureId || state.meetingId !== id) return { status: "ended", code: "CAPTURE_CHANGED" };
  if (state.root !== root || state.profile !== profile) return { status: "ended", code: "CAPTION_SURFACE_CHANGED" };

  // shortcut: ambiguous DOM replacements stop capture; upgrade only with verified provider-stable utterance IDs.
  if (state.previous.length) {
    const previous = new Set(state.previous);
    const retained = rows.filter(row => previous.has(row));
    const suffix = state.previous.slice(state.previous.indexOf(retained[0]));
    if (!retained.length || retained.length !== suffix.length
      || retained.some((row, index) => row !== suffix[index] || row !== rows[index])
      || rows.slice(retained.length).some(row => state.records.has(row))) {
      return { status: "ended", code: "CAPTION_SURFACE_CHANGED" };
    }
  }
  const blocks = [];
  let characters = 0;
  for (const row of rows) {
    if (row.children.length !== 2 || [row, ...row.querySelectorAll("*")].some(element => !visible(element))) return { status: "unsupported", code: "CAPTION_LAYOUT_UNKNOWN" };
    const speakerElement = row.children[0];
    const textElement = profile === "legacy" ? row.children[1].lastChild : row.children[1];
    if (!textElement || row.querySelector("button,input,textarea,[contenteditable=true]")) return { status: "unsupported", code: "CAPTION_LAYOUT_UNKNOWN" };
    const speaker = speakerElement.textContent.trim(), transcript = textElement.textContent.trim();
    if (!speaker || !transcript || speaker.length > 256 || transcript.length > 32768) return { status: "unsupported", code: "CAPTION_LAYOUT_UNKNOWN" };
    characters += transcript.length;
    if (characters > 2_000_000) return { status: "unsupported", code: "CAPTION_LIMIT" };
    const signature = JSON.stringify([speaker, transcript]);
    let record = state.records.get(row);
    if (!record) {
      record = { signature, block: { messageId: captureId + ":" + (++state.next), messageVersion: 1, speakerName: speaker, transcript, timestamp: Date.now(), version: 1 } };
      state.records.set(row, record);
    } else if (record.signature !== signature) {
      record.signature = signature;
      record.block = { ...record.block, messageVersion: record.block.messageVersion + 1, speakerName: speaker, transcript, version: record.block.version + 1 };
    }
    blocks.push(record.block);
  }
  state.previous = rows;
  return { status: "live", meetingId: id, platform: "Google Meet", blocks };
}
