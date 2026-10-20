// MAIN/document_start on Teams. Observation only: never creates channels, sends, reads the DOM, tokens or app state.
// No transcript processing while idle; no token or HTTP access here.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1", core = page.__liveCaptionsHookCore;
  try { delete page.__liveCaptionsHookCore; } catch {}
  const hosts = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);
  if (typeof core !== "function" || page !== page.top || page.location.protocol !== "https:" || !hosts.has(page.location.hostname) || page[key]) return;
  const NativePeer = page.RTCPeerConnection, create = NativePeer?.prototype?.createDataChannel;
  const { TextDecoder: Decoder, ArrayBuffer: Buffer } = page;
  const now = page.performance.now.bind(page.performance), wallTime = page.Date.now.bind(page.Date);
  const LIMIT = 262144, peers = new Set(), tracked = new WeakMap();
  let prepareError = null;
  const labels = new Set();
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  // Rejections carry a fixed-vocabulary reason (field + JS type, never a value) so an unknown Teams layout can be diagnosed without transcript content.
  const kind = v => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const invalid = reason => { throw Object.assign(new Error("CAPTION_FORMAT_UNKNOWN"), { code: "CAPTION_FORMAT_UNKNOWN", reason }); };
  let probe = null;
  const currentMeeting = () => page.location.protocol === "https:" && hosts.has(page.location.hostname) ? `${page.location.hostname}/call` : null;
  const life = core(page, { meeting: currentMeeting, cleanup(s) { s.records.clear(); s.speakers.clear(); s.entries.clear(); } });
  const { finish, valid } = life;
  // Teams' main channel also carries unrelated control traffic: anything that is not a recognition result is ignored, never an error.
  // Counters only (never content) show where frames are dropped. Decoding is lenient like Tactiq's: binary framing before the JSON must not hide captions.
  function results(data, stats) {
    let bytes;
    if (data instanceof Buffer) bytes = new page.Uint8Array(data); else if (ArrayBuffer.isView(data)) bytes = new page.Uint8Array(data.buffer, data.byteOffset, data.byteLength); else { stats.nonBinary++; return null; }
    if (!bytes.length || bytes.length > LIMIT) { stats.noJson++; return null; }
    const message = new Decoder("utf-8").decode(bytes);
    const start = message.indexOf("{"); if (start < 0 || start > 256) { stats.noJson++; return null; }
    let body; try { body = JSON.parse(message.slice(start)); } catch { stats.noJson++; return null; }
    if (body && Array.isArray(body.recognitionResults)) return body.recognitionResults.slice(0, 65);
    stats.nonCaption++; return null;
  }
  function ingest(s, raw) {
    if (!raw || typeof raw !== "object" || !("timestampAudioSent" in raw)) return;
    if (!valid(s)) return;
    probe = raw;
    const { id, userId, timestampAudioSent, text } = raw;
    const stamp = typeof timestampAudioSent === "number" && Number.isSafeInteger(timestampAudioSent) && timestampAudioSent >= 0 ? BigInt(timestampAudioSent)
      : typeof timestampAudioSent === "string" && /^\d{1,20}$/.test(timestampAudioSent) ? BigInt(timestampAudioSent)
      : invalid(typeof timestampAudioSent === "number" ? (Number.isInteger(timestampAudioSent) ? (timestampAudioSent < 0 ? "ts:negative" : "ts:unsafe-integer") : "ts:non-integer") : "ts:" + kind(timestampAudioSent));
    if (typeof userId !== "string" || !userId || userId.length > 512 || /\p{Cc}/u.test(userId)) invalid(typeof userId !== "string" ? "user:" + kind(userId) : !userId ? "user:empty" : userId.length > 512 ? "user:long" : "user:control");
    const version = typeof id === "string" ? /^[^/]{1,256}\/(\d{1,9})$/.exec(id) : null; if (!version) invalid(typeof id === "string" ? "id:shape" : "id:" + kind(id));
    if (text !== undefined && text !== null && typeof text !== "string") invalid("text:" + kind(text));
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
    const s = life.current;
    if (!s || !s.entries.has(entry) || event.isTrusted !== true || event.timeStamp < s.started || !valid(s)) return;
    s.stats.frames++;
    try {
      const items = results(event.data, s.stats); if (!items) return;
      for (const raw of items) { ingest(s, raw); if (life.current !== s) return; }
    } catch (error) {
      if (life.current === s && typeof error?.reason === "string") {
        s.stats.reason = error.reason;
        if (probe && typeof probe === "object") s.stats.itemKeys = Object.keys(probe).filter(k => /^[A-Za-z0-9_]{1,24}$/.test(k)).slice(0, 16);
      }
      if (life.current === s) finish(["CAPTION_LIMIT", "CAPTION_SEQUENCE_UNKNOWN", "CAPTION_REVISION_CONFLICT"].includes(error?.code) ? error.code : "CAPTION_FORMAT_UNKNOWN");
    }
  }
  function track(peer) {
    if (tracked.has(peer)) return tracked.get(peer);
    if (peers.size >= 16) { prepareError = "RTC_RESOURCE_LIMIT"; finish(prepareError); return null; }
    const record = { peer, channels: new Set() }; peers.add(record); tracked.set(peer, record);
    peer.addEventListener("datachannel", event => { if (event.isTrusted === true) attach(record, event.channel); });
    peer.addEventListener("connectionstatechange", () => {
      if (["closed", "failed"].includes(peer.connectionState)) {
        peers.delete(record); if (life.current?.connection === record) finish("RTC_CONNECTION_CLOSED");
      }
    });
    return record;
  }
  function attach(connection, channel) {
    // Labels are non-sensitive and only help diagnose a different Teams channel layout.
    if (typeof channel.label === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(channel.label) && labels.size < 16) labels.add(channel.label);
    if (channel.label !== "main-channel") return null;
    for (const entry of connection.channels) if (entry.channel === channel) return entry;
    if (connection.channels.size >= 32) { prepareError = "RTC_RESOURCE_LIMIT"; finish(prepareError); return null; }
    const entry = { channel }; connection.channels.add(entry);
    try {
      channel.addEventListener("message", event => receive(entry, event));
      channel.addEventListener("close", () => {
        connection.channels.delete(entry);
        if (life.current?.entries.has(entry)) finish("CAPTION_CHANNEL_CLOSED");
      });
    } catch (error) { connection.channels.delete(entry); throw error; }
    return entry;
  }
  const live = entry => ["open", "connecting"].includes(entry.channel.readyState);
  const candidates = () => [...peers].filter(p => p.peer.connectionState === "connected" && [...p.channels].some(live));
  function metadata() {
    const id = currentMeeting(), choices = candidates(), selected = choices.length === 1 ? choices[0] : null;
    const code = prepareError ?? (!id ? "NOT_MEETING_PAGE" : selected ? "READY" : choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND");
    const stats = life.current?.stats ?? life.terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "teams-rtc-experimental", platform: "Teams",
      meetings: id ? [{ id, title: "Microsoft Teams（字幕通信・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: peers.size, captionChannels: selected ? [...selected.channels].filter(live).length : 0, ...stats, channelLabels: [...labels] } };
  }
  function command(params = {}) {
    const early = life.prologue(params, metadata); if (early) return early;
    const { action, meetingId, captureId } = params;
    if (action === "start" || action === "recover") {
      const meta = metadata(); if (!meta.captionReady) return { status: "unavailable", code: meta.code };
      const retired = finish("CAPTURE_REPLACED");
      if (life.generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      const target = candidates()[0]; life.clearTerminal();
      life.activate({ owner: captureId, meetingId, connection: target, entries: new Set([...target.channels].filter(live)),
        records: new Map(), speakers: new Map(), characters: 0, started: now(),
        stats: { frames: 0, nonBinary: 0, noJson: 0, nonCaption: 0, received: 0, accepted: 0, baselineExcluded: 0, queued: 0, inFlight: 0 } });
    }
    return life.epilogue(params, { platform: "Teams", blocks: s => [...s.records.values()].flatMap(r => r.block ? [{ ...r.block }] : []) });
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
