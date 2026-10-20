// MAIN/document_start on Teams. Observation only: never creates channels, sends, reads the DOM, tokens or app state.
// No transcript processing while idle; no token or HTTP access here.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1";
  const hosts = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);
  if (page !== page.top || page.location.protocol !== "https:" || !hosts.has(page.location.hostname) || page[key]) return;
  const NativePeer = page.RTCPeerConnection, create = NativePeer?.prototype?.createDataChannel;
  const { TextDecoder: Decoder, ArrayBuffer: Buffer } = page;
  const now = page.performance.now.bind(page.performance), wallTime = page.Date.now.bind(page.Date);
  const timeout = page.setTimeout.bind(page), cancel = page.clearTimeout.bind(page);
  const LIMIT = 262144, LEASE = 2000, peers = new Set(), tracked = new WeakMap();
  let current = null, terminal = null, prepareError = null, generation = 0;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const invalid = () => fail("CAPTION_FORMAT_UNKNOWN");
  const currentMeeting = () => page.location.protocol === "https:" && hosts.has(page.location.hostname) ? `${page.location.hostname}/call` : null;
  function finish(code) {
    const s = current; if (!s) return generation;
    const retired = ++generation;
    current = null; cancel(s.timer);
    terminal = { owner: s.owner, generation: s.generation, meetingId: s.meetingId, code, stats: { ...s.stats, queued: 0, inFlight: 0 } };
    s.records.clear(); s.speakers.clear(); s.entries.clear();
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
  // Teams' main channel also carries unrelated control traffic: anything that is not a recognition result is ignored, never an error.
  function results(data) {
    let bytes;
    if (data instanceof Buffer) bytes = new page.Uint8Array(data); else if (ArrayBuffer.isView(data)) bytes = new page.Uint8Array(data.buffer, data.byteOffset, data.byteLength); else return null;
    if (!bytes.length || bytes.length > LIMIT) return null;
    let message; try { message = new Decoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
    const start = message.indexOf("{"); if (start < 0 || start > 32) return null;
    let body; try { body = JSON.parse(message.slice(start)); } catch { return null; }
    return body && Array.isArray(body.recognitionResults) ? body.recognitionResults.slice(0, 65) : null;
  }
  function ingest(s, raw) {
    if (!raw || typeof raw !== "object" || !("timestampAudioSent" in raw)) return;
    if (!valid(s)) return;
    const { id, userId, timestampAudioSent, text } = raw;
    const stamp = typeof timestampAudioSent === "number" && Number.isSafeInteger(timestampAudioSent) && timestampAudioSent >= 0 ? BigInt(timestampAudioSent)
      : typeof timestampAudioSent === "string" && /^\d{1,20}$/.test(timestampAudioSent) ? BigInt(timestampAudioSent) : invalid();
    if (typeof userId !== "string" || !userId || userId.length > 512 || /\p{Cc}/u.test(userId)) invalid();
    const version = typeof id === "string" ? /^[^/]{1,256}\/(\d{1,9})$/.exec(id) : null; if (!version) invalid();
    if (text !== undefined && text !== null && typeof text !== "string") invalid();
    if (typeof text === "string" && text.length > 32768) fail("CAPTION_LIMIT");
    s.stats.received++;
    const revision = Number(version[1]);
    let speaker = s.speakers.get(userId);
    if (!speaker) {
      if (s.speakers.size >= 256) fail("CAPTION_LIMIT");
      speaker = { number: s.speakers.size + 1, boundary: stamp, max: stamp };
      s.speakers.set(userId, speaker);
    }
    // No verified clock: exclude each speaker's first utterance and older ones, not just one revision.
    if (stamp <= speaker.boundary) { s.stats.baselineExcluded++; return; }
    const recordKey = `${speaker.number}:${stamp}`;
    let record = s.records.get(recordKey);
    if (!record && stamp < speaker.max) fail("CAPTION_SEQUENCE_UNKNOWN");
    if (stamp > speaker.max) speaker.max = stamp;
    if (!record) {
      if (s.records.size >= 4000) fail("CAPTION_LIMIT");
      record = { block: null, revision: -1, localId: `${s.owner}:${s.records.size + 1}` }; s.records.set(recordKey, record);
    }
    if (typeof text !== "string" || revision < record.revision) return;
    if (revision === record.revision) {
      if (text !== record.block.transcript) fail("CAPTION_REVISION_CONFLICT");
      return;
    }
    s.characters += text.length - (record.block?.transcript.length ?? 0);
    if (s.characters > 2_000_000) fail("CAPTION_LIMIT");
    record.revision = revision;
    record.block = { messageId: record.localId, deviceId: `speaker-${speaker.number}`, messageVersion: revision,
      speakerName: `話者 ${speaker.number}（名前未確認）`, transcript: text, timestamp: record.block?.timestamp ?? wallTime(), version: revision };
    s.stats.accepted++;
  }
  function receive(entry, event) {
    const s = current;
    if (!s || !s.entries.has(entry) || event.isTrusted !== true || event.timeStamp < s.started || !valid(s)) return;
    try {
      const items = results(event.data); if (!items) return;
      for (const raw of items) { ingest(s, raw); if (current !== s) return; }
    } catch (error) {
      if (current === s) finish(["CAPTION_LIMIT", "CAPTION_SEQUENCE_UNKNOWN", "CAPTION_REVISION_CONFLICT"].includes(error?.code) ? error.code : "CAPTION_FORMAT_UNKNOWN");
    }
  }
  function track(peer) {
    if (tracked.has(peer)) return tracked.get(peer);
    if (peers.size >= 16) { prepareError = "RTC_RESOURCE_LIMIT"; finish(prepareError); return null; }
    const record = { peer, channels: new Set() }; peers.add(record); tracked.set(peer, record);
    peer.addEventListener("datachannel", event => { if (event.isTrusted === true) attach(record, event.channel); });
    peer.addEventListener("connectionstatechange", () => {
      if (["closed", "failed"].includes(peer.connectionState)) {
        peers.delete(record); if (current?.connection === record) finish("RTC_CONNECTION_CLOSED");
      }
    });
    return record;
  }
  function attach(connection, channel) {
    if (channel.label !== "main-channel") return null;
    for (const entry of connection.channels) if (entry.channel === channel) return entry;
    if (connection.channels.size >= 32) { prepareError = "RTC_RESOURCE_LIMIT"; finish(prepareError); return null; }
    const entry = { channel }; connection.channels.add(entry);
    try {
      channel.addEventListener("message", event => receive(entry, event));
      channel.addEventListener("close", () => {
        connection.channels.delete(entry);
        if (current?.entries.has(entry)) finish("CAPTION_CHANNEL_CLOSED");
      });
    } catch (error) { connection.channels.delete(entry); throw error; }
    return entry;
  }
  const live = entry => ["open", "connecting"].includes(entry.channel.readyState);
  const candidates = () => [...peers].filter(p => p.peer.connectionState === "connected" && [...p.channels].some(live));
  function metadata() {
    const id = currentMeeting(), choices = candidates(), selected = choices.length === 1 ? choices[0] : null;
    const code = prepareError ?? (!id ? "NOT_MEETING_PAGE" : selected ? "READY" : choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND");
    const stats = current?.stats ?? terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "teams-rtc-experimental", platform: "Teams",
      meetings: id ? [{ id, title: "Microsoft Teams（字幕通信・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: peers.size, captionChannels: selected ? [...selected.channels].filter(live).length : 0, ...stats } };
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
      const target = candidates()[0]; terminal = null;
      const s = { owner: captureId, meetingId, connection: target, entries: new Set([...target.channels].filter(live)),
        records: new Map(), speakers: new Map(), characters: 0, started: now(),
        stats: { received: 0, accepted: 0, baselineExcluded: 0, queued: 0, inFlight: 0 } };
      current = s; s.generation = ++generation; renew(s);
    }
    if (!current || current.owner !== captureId) return { status: "ended", code: terminal?.owner === captureId ? terminal.code : "CAPTURE_CHANGED",
      diagnostics: terminal?.owner === captureId ? { ...terminal.stats } : undefined };
    if (action !== "start" && action !== "recover" && action !== "read") return { status: "unavailable", code: "INVALID_CAPTURE" };
    const s = current; if (!valid(s)) return { status: "ended", code: terminal?.code ?? "CAPTURE_CHANGED", diagnostics: { ...terminal?.stats } };
    renew(s);
    return { status: "live", meetingId, platform: "Teams", blocks: [...s.records.values()].flatMap(r => r.block ? [{ ...r.block }] : []), diagnostics: { ...s.stats } };
  }
  Object.defineProperty(page, key, { value: Object.freeze({ version: 1, command }), configurable: false, writable: false });
  try {
    if (typeof NativePeer !== "function" || typeof create !== "function") fail("RTC_UNAVAILABLE");
    NativePeer.prototype.createDataChannel = function (...args) {
      const channel = create.apply(this, args);
      try { const record = track(this); if (record) attach(record, channel); } catch { prepareError = "RTC_PREPARE_FAILED"; finish(prepareError); }
      return channel;
    };
    page.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      try { track(peer); } catch { prepareError = "RTC_PREPARE_FAILED"; }
      return peer;
    } });
  } catch { prepareError = "RTC_PREPARE_FAILED"; }
  page.addEventListener("pagehide", () => finish("MEETING_CHANGED"));
})();
