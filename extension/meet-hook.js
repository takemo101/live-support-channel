// MAIN/document_start. No transcript processing while idle; no token or HTTP access here.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1";
  if (page !== page.top || page.location.protocol !== "https:" || page.location.hostname !== "meet.google.com" || page[key]) return;
  const NativePeer = page.RTCPeerConnection, create = NativePeer?.prototype?.createDataChannel;
  const { Uint8Array: Bytes, ArrayBuffer: Buffer, TextDecoder: Decoder, Blob: BinaryBlob, DecompressionStream: Inflate } = page;
  const now = page.performance.now.bind(page.performance), wallTime = page.Date.now.bind(page.Date);
  const timeout = page.setTimeout.bind(page), cancel = page.clearTimeout.bind(page);
  const LIMIT = 262144, ACK_LIMIT = 16384, LEASE = 2000, peers = new Set(), tracked = new WeakMap();
  const NativeChannel = page.RTCDataChannel?.prototype, nativeSend = NativeChannel?.send, mediaSeen = new WeakMap(), mediaWritten = new WeakSet();
  const captionLabels = new Set(["captions", "captions_v2"]);
  let current = null, terminal = null, prepareError = null, generation = 0, decoding = null;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const invalid = () => fail("CAPTION_FORMAT_UNKNOWN");
  const currentMeeting = () => page.location.hostname === "meet.google.com" && page.location.protocol === "https:" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(page.location.pathname)
    ? `meet.google.com${page.location.pathname.replace(/\/$/, "")}` : null;
  function captionControl() {
    const buttons = [...page.document.querySelectorAll("button[aria-label]")].filter(b => b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    if (buttons.some(b => /^(Turn off captions|字幕をオフにする)(?:\s|[（(]|$)/i.test(b.getAttribute("aria-label")))) return "READY";
    return buttons.some(b => /^(Turn on captions|字幕をオンにする)(?:\s|[（(]|$)/i.test(b.getAttribute("aria-label"))) ? "CAPTIONS_OFF" : "CAPTION_CONTROL_NOT_FOUND";
  }
  function closeOwned(entry) { if (entry.owned) { try { entry.channel.close(); } catch {} } }
  function finish(code) {
    const s = current; if (!s) return generation;
    const retired = ++generation;
    current = null; cancel(s.timer);
    terminal = { owner: s.owner, generation: s.generation, meetingId: s.meetingId, code, assisted: s.assisted === true,
      stats: { ...s.stats, queued: 0, inFlight: decoding === s ? 1 : 0 } };
    for (const job of s.queue) job.data = null;
    s.queue.length = 0; s.stats.queued = 0;
    const reader = s.reader; s.reader = null;
    if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
    s.records.clear(); s.speakers.clear();
    for (const entry of s.entries) closeOwned(entry);
    s.entries.clear();
    return retired;
  }
  function valid(s) {
    if (current !== s) return false;
    if (now() >= s.deadline) { finish("CAPTURE_EXPIRED"); return false; }
    if (currentMeeting() !== s.meetingId) { finish("MEETING_CHANGED"); return false; }
    const code = captionControl(); if (current !== s) return false;
    if (code !== "READY" && !(s.assisted && code === "CAPTIONS_OFF")) { finish(code); return false; }
    return true;
  }
  function renew(s) {
    cancel(s.timer); s.deadline = now() + LEASE;
    s.timer = timeout(() => { if (current === s) finish("CAPTURE_EXPIRED"); }, LEASE);
  }
  function varint(bytes, cursor) {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (cursor.pos >= bytes.length) invalid();
      const b = bytes[cursor.pos++]; if (i === 9 && b > 1) invalid();
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) { if (i && b === 0) invalid(); return value; }
    }
    invalid();
  }
  function fields(bytes) {
    const out = new Map(), cursor = { pos: 0 };
    while (cursor.pos < bytes.length) {
      const tag = varint(bytes, cursor); if (tag > 0xffffffffn) invalid();
      const field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!field || out.has(field) || out.size >= 64) invalid();
      let value;
      if (wire === 0) value = varint(bytes, cursor);
      else {
        let length;
        if (wire === 2) { const n = varint(bytes, cursor); if (n > BigInt(LIMIT)) invalid(); length = Number(n); }
        else if (wire === 1) length = 8;
        else if (wire === 5) length = 4;
        else invalid();
        if (cursor.pos + length > bytes.length) invalid();
        value = bytes.subarray(cursor.pos, cursor.pos + length); cursor.pos += length;
      }
      out.set(field, { wire, value });
    }
    return out;
  }
  function get(map, field, wire, optional = false) {
    const item = map.get(field); if (!item && optional) return null;
    if (!item || item.wire !== wire) invalid(); return item.value;
  }
  function text(bytes, max) {
    let value;
    try { value = new Decoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid(); }
    if (value.length > max) fail("CAPTION_LIMIT"); return value;
  }
  function decode(bytes, label) {
    const outer = fields(bytes); let message, id, revision, device, body;
    if (label === "captions") {
      const control = get(outer, 2, 2, true); if (control?.length) return null;
      message = fields(get(outer, 1, 2));
      device = get(message, 1, 2); id = get(message, 2, 0); revision = get(message, 3, 0); body = get(message, 6, 2, true);
      const lang = get(message, 8, 0); if (lang > 65535n) invalid();
    } else {
      message = fields(get(outer, 1, 2)); id = get(message, 1, 0); revision = get(message, 2, 0);
      const caption = fields(get(message, 3, 2));
      device = get(caption, 6, 2); body = get(caption, 3, 2, true);
      const lang = get(caption, 4, 2, true); if (lang && lang.length > 64) invalid();
    }
    if (id < 1n || id > 0x7fffffffffffffffn || revision > BigInt(Number.MAX_SAFE_INTEGER) || device.length > 2048) invalid();
    const deviceId = text(device, 512);
    if (!deviceId || /\p{Cc}/u.test(deviceId)) invalid();
    return { id, revision: Number(revision), device: deviceId, text: body === null ? null : text(body, 32768) };
  }
  function integer(value) {
    const out = []; do { const b = Number(value & 127n); value >>= 7n; out.push(b | (value ? 128 : 0)); } while (value);
    return out;
  }
  function ack(id, revision) {
    const ref = [8, ...integer(id), 16, ...integer(BigInt(revision)), 24, 1];
    const body = [10, ref.length, ...ref]; return Bytes.from([10, body.length, ...body]);
  }
  function payloadSize(data) {
    let size;
    if (data instanceof BinaryBlob) size = data.size;
    else if (data instanceof Buffer || Buffer.isView(data)) size = data.byteLength;
    else invalid();
    if (size > LIMIT) fail("CAPTION_LIMIT");
  }
  async function unpack(data, label, s) {
    let raw;
    if (data instanceof BinaryBlob) {
      if (data.size > LIMIT) fail("CAPTION_LIMIT");
      raw = new Bytes(await data.arrayBuffer());
    } else if (data instanceof Buffer) {
      if (data.byteLength > LIMIT) fail("CAPTION_LIMIT"); raw = new Bytes(data).slice();
    } else if (Buffer.isView(data)) {
      if (data.byteLength > LIMIT) fail("CAPTION_LIMIT"); raw = new Bytes(data.buffer, data.byteOffset, data.byteLength).slice();
    } else invalid();
    if (!valid(s)) return null;
    if (raw.length > LIMIT) fail("CAPTION_LIMIT");
    const gzip = offset => raw.length >= offset + 3 && raw[offset] === 31 && raw[offset + 1] === 139 && raw[offset + 2] === 8;
    let offset = -1;
    if (gzip(0)) offset = 0;
    else if (gzip(3)) offset = 3;
    if (offset < 0) return raw;
    if (label !== "captions") invalid();
    const reader = new BinaryBlob([raw.subarray(offset)]).stream().pipeThrough(new Inflate("gzip")).getReader();
    s.reader = reader;
    const chunks = []; let size = 0;
    try {
      while (valid(s)) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > LIMIT) { await reader.cancel(); fail("CAPTION_LIMIT"); }
        chunks.push(value);
      }
      if (!valid(s)) { await reader.cancel().catch(() => {}); return null; }
      const output = new Bytes(size); let position = 0;
      for (const chunk of chunks) { output.set(chunk, position); position += chunk.length; }
      return output;
    } finally { if (s.reader === reader) s.reader = null; reader.releaseLock(); }
  }
  function ingest(s, entry, packet) {
    if (!s.selected) {
      s.selected = entry;
      for (const other of [...s.entries]) if (other !== entry) {
        s.entries.delete(other); closeOwned(other); if (!valid(s)) return;
      }
    }
    if (entry !== s.selected || !valid(s)) return;
    if (entry.owned && entry.label === "captions_v2") {
      const response = ack(packet.id, packet.revision), buffered = entry.channel.bufferedAmount;
      if (!valid(s)) return;
      if (!Number.isSafeInteger(buffered) || buffered < 0 || buffered + response.byteLength > ACK_LIMIT) fail("CAPTION_ACK_BACKLOG_LIMIT");
      entry.channel.send(response);
    }
    if (!valid(s)) return;
    let speaker = s.speakers.get(packet.device);
    if (!speaker) {
      if (s.speakers.size >= 256) fail("CAPTION_LIMIT");
      speaker = { number: s.speakers.size + 1, boundary: packet.id, max: packet.id };
      s.speakers.set(packet.device, speaker);
    }
    // shortcut: no verified generation timestamp; exclude each speaker's first ID and older IDs, not just one revision.
    if (packet.id <= speaker.boundary) { s.stats.baselineExcluded++; return; }
    const id = `${speaker.number}:${packet.id}`;
    let record = s.records.get(id);
    if (!record && packet.id < speaker.max) fail("CAPTION_SEQUENCE_UNKNOWN");
    if (packet.id > speaker.max) speaker.max = packet.id;
    if (!record) {
      if (s.records.size >= 4000) fail("CAPTION_LIMIT");
      record = { block: null, revision: -1, localId: `${s.owner}:${s.records.size + 1}` }; s.records.set(id, record);
    }
    if (packet.text === null || packet.revision < record.revision) return;
    if (packet.revision === record.revision) {
      if (packet.text !== record.block.transcript) fail("CAPTION_REVISION_CONFLICT");
      return;
    }
    s.characters += packet.text.length - (record.block?.transcript.length ?? 0);
    if (s.characters > 2_000_000) fail("CAPTION_LIMIT");
    record.revision = packet.revision;
    record.block = { messageId: record.localId,
      deviceId: `speaker-${speaker.number}`, messageVersion: packet.revision,
      speakerName: `話者 ${speaker.number}（名前未確認）`, transcript: packet.text,
      timestamp: record.block?.timestamp ?? wallTime(), version: packet.revision };
    s.stats.accepted++;
  }
  function receive(entry, event) {
    const s = current;
    if (!s || !s.entries.has(entry) || event.isTrusted !== true || event.timeStamp < s.started || !valid(s)) return;
    if (s.stats.queued >= 8) { finish("CAPTION_BACKLOG_LIMIT"); return; }
    let data;
    try { data = event.data; payloadSize(data); }
    catch (error) { if (current === s) finish(error?.code === "CAPTION_LIMIT" ? error.code : "CAPTION_FORMAT_UNKNOWN"); return; }
    if (!valid(s)) return;
    s.stats.received++; s.stats.queued++;
    s.queue.push({ entry, data }); void drain(s);
  }
  async function drain(s) {
    if (decoding) return;
    decoding = s;
    try {
      while (valid(s) && s.queue.length) {
        const job = s.queue.shift(), data = job.data; job.data = null;
        s.stats.inFlight = 1;
        try {
          if (!s.entries.has(job.entry)) continue;
          const bytes = await unpack(data, job.entry.label, s);
          if (!bytes || !valid(s) || !s.entries.has(job.entry)) continue;
          const packet = decode(bytes, job.entry.label); if (packet) ingest(s, job.entry, packet);
        } finally { s.stats.queued = Math.max(0, s.stats.queued - 1); s.stats.inFlight = 0; }
      }
    } catch (error) {
      if (current === s) finish(["CAPTION_LIMIT", "CAPTION_BACKLOG_LIMIT", "CAPTION_ACK_BACKLOG_LIMIT", "CAPTION_SEQUENCE_UNKNOWN", "CAPTION_REVISION_CONFLICT"].includes(error?.code) ? error.code : "CAPTION_FORMAT_UNKNOWN");
    } finally {
      if (decoding === s) decoding = null;
      if (terminal?.generation === s.generation) terminal.stats.inFlight = 0;
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
  function attach(connection, channel, owned = false) {
    const label = channel.label;
    if (!["captions", "captions_v2", "collections", "media-session"].includes(label)) return null;
    for (const entry of connection.channels) if (entry.channel === channel) return entry;
    if (connection.channels.size >= 32) { prepareError = "RTC_RESOURCE_LIMIT"; finish(prepareError); return null; }
    const entry = { channel, label, owned }; connection.channels.add(entry);
    try {
      if (captionLabels.has(label)) channel.addEventListener("message", event => receive(entry, event));
      channel.addEventListener("close", () => {
        connection.channels.delete(entry);
        if (current?.entries.has(entry)) finish("CAPTION_CHANNEL_CLOSED");
      });
    } catch (error) { connection.channels.delete(entry); throw error; }
    return entry;
  }
  function candidates() {
    const live = [...peers].filter(p => p.peer.connectionState === "connected");
    for (const labels of [["captions_v2", "captions"], ["collections"], ["media-session"]]) {
      const matches = live.filter(p => [...p.channels].some(entry => labels.includes(entry.label) && ["open", "connecting"].includes(entry.channel.readyState)));
      if (matches.length) return matches;
    }
    return [];
  }
  // Opt-in only. Observes Meet's own media-session control frames (numbers and a language code, nothing else is kept)
  // so that one caption-config command can be written when the caption button is OFF.
  const child = (data, field) => data ? get(fields(data), field, 2, true) : null;
  function observeMedia(channel, data) {
    if (channel.label !== "media-session") return;
    let view;
    if (data instanceof Buffer) view = new Bytes(data); else if (Buffer.isView(data)) view = new Bytes(data.buffer, data.byteOffset, data.byteLength); else return;
    if (view.length > 4096) return;
    const seen = mediaSeen.get(channel) ?? { op: 0, ack: 0, language: null };
    try {
      const command = child(child(view, 1), 2);
      const op = command ? get(fields(command), 1, 0, true) : null;
      if (op !== null && op < 0xfffffff0n) seen.op = Number(op);
      const code = child(child(child(child(command, 3), 1), 9), 1);
      if (code) { const language = text(code, 32); if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language)) seen.language = language; }
    } catch {}
    try {
      const ackBody = child(child(view, 1), 1);
      const sequence = ackBody ? get(fields(ackBody), 2, 0, true) : null;
      if (sequence !== null && sequence < 0xfffffff0n) seen.ack = Number(sequence);
    } catch {}
    mediaSeen.set(channel, seen);
  }
  const lengthDelimited = (field, body) => [(field << 3) | 2, ...integer(BigInt(body.length)), ...body];
  const numberField = (field, value) => [field << 3, ...integer(BigInt(value))];
  const stringField = (field, value) => lengthDelimited(field, [...value].map(c => c.charCodeAt(0)));
  function assistTarget(connection) {
    const entries = [...connection.channels].filter(entry => !entry.owned && entry.label === "media-session" && entry.channel.readyState === "open");
    if (entries.length !== 1 || typeof nativeSend !== "function") return { code: "MEDIA_SESSION_NOT_FOUND" };
    const seen = mediaSeen.get(entries[0].channel);
    return seen?.language ? { channel: entries[0].channel, seen } : { code: "CAPTION_LANGUAGE_UNKNOWN" };
  }
  // One attempt per media-session channel, no retry, no rewrite of Meet's own frames. Returns a failure code or null.
  function enableCaptions(s) {
    if (captionControl() !== "CAPTIONS_OFF") return null;
    const target = assistTarget(s.connection); if (target.code) { finish(target.code); return target.code; }
    const { channel, seen } = target; if (mediaWritten.has(channel)) return null;
    mediaWritten.add(channel);
    const config = [...stringField(1, seen.language), ...stringField(2, seen.language)];
    const update = [...lengthDelimited(1, lengthDelimited(9, config)), ...lengthDelimited(2, stringField(1, "client_config.caption_config"))];
    const frames = [lengthDelimited(1, lengthDelimited(2, [...numberField(1, seen.op + 1), ...lengthDelimited(3, update)])),
      ...[1, 2].map(n => lengthDelimited(1, lengthDelimited(1, [...numberField(2, seen.ack + n), ...numberField(3, 1)])))];
    try { for (const frame of frames) nativeSend.call(channel, Bytes.from(frame)); }
    catch { finish("CAPTION_ENABLE_FAILED"); return "CAPTION_ENABLE_FAILED"; }
    return current === s ? null : "CAPTURE_CHANGED";
  }
  function metadata(assist = false) {
    const id = currentMeeting(), choices = candidates(), selected = choices.length === 1 ? choices[0] : null;
    let code = prepareError ?? (id ? captionControl() : "NOT_MEETING_PAGE");
    if (assist && code === "CAPTIONS_OFF") code = selected ? (assistTarget(selected).code ?? "READY") : "READY";
    if (code === "READY" && !selected) code = choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND";
    if (code === "READY" && decoding && !current) code = "CAPTION_DECODE_BUSY";
    const stats = current?.stats ?? terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "meet-rtc-experimental", platform: "Google Meet",
      meetings: id ? [{ id, title: "Google Meet（字幕通信・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: peers.size, captionChannels: selected ? [...selected.channels].filter(entry => captionLabels.has(entry.label)).length : 0, ...stats, profile: current?.selected?.label ?? "pending" } };
  }
  function command({ action = "discover", meetingId, captureId, previousCaptureId, assistCaptions } = {}) {
    if (action === "reset") {
      if (current?.owner === captureId) {
        const retired = finish("CAPTURE_RESET"); if (generation === retired) terminal = null;
      }
      else if (terminal?.owner === captureId) terminal = null;
      return { status: "idle" };
    }
    if (action === "discover") return metadata(assistCaptions === true);
    if (!currentMeeting() || currentMeeting() !== meetingId) return { status: "ended", code: "MEETING_CHANGED" };
    if (typeof captureId !== "string" || !captureId.length || captureId.length > 128) return { status: "unavailable", code: "INVALID_CAPTURE" };
    // Recovery only continues the same meeting after its own lease lapsed; any other end state needs a user action.
    if (action === "recover" && (current || terminal?.code !== "CAPTURE_EXPIRED" || terminal.meetingId !== meetingId
      || typeof previousCaptureId !== "string" || terminal.owner !== previousCaptureId || previousCaptureId === captureId)) return { status: "ended", code: "CAPTURE_CHANGED" };
    if (action === "start" || action === "recover") {
      const assisted = action === "recover" ? terminal.assisted === true : assistCaptions === true;
      const meta = metadata(assisted); if (!meta.captionReady) return { status: "unavailable", code: meta.code };
      const retired = finish("CAPTURE_REPLACED");
      if (generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      if (decoding) return { status: "unavailable", code: "CAPTION_DECODE_BUSY" };
      const ready = metadata(assisted), choices = candidates();
      if (generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      if (currentMeeting() !== meetingId) return { status: "ended", code: "MEETING_CHANGED" };
      if (!ready.captionReady) return { status: "unavailable", code: ready.code };
      if (choices.length !== 1) return { status: "unavailable", code: choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND" };
      const target = choices[0]; terminal = null;
      const s = { owner: captureId, meetingId, connection: target, assisted, entries: new Set(), selected: null,
        records: new Map(), speakers: new Map(), characters: 0, started: now(), queue: [], reader: null,
        stats: { received: 0, accepted: 0, baselineExcluded: 0, queued: 0, inFlight: 0 } };
      current = s; s.generation = ++generation; renew(s);
      try {
        for (const entry of target.channels) if (!entry.owned && captionLabels.has(entry.label) && entry.channel.ordered && ["open", "connecting"].includes(entry.channel.readyState)) s.entries.add(entry);
        if (!s.entries.size) for (const label of ["captions_v2", "captions"]) {
          const channel = create.call(target.peer, label, { ordered: true, maxRetransmits: 10 });
          if (!valid(s)) { closeOwned({ channel, owned: true }); return { status: "ended", code: "CAPTURE_CHANGED" }; }
          let entry;
          try { entry = attach(target, channel, true); }
          catch (error) { closeOwned({ channel, owned: true }); throw error; }
          if (!valid(s)) { closeOwned({ channel, owned: true }); return { status: "ended", code: "CAPTURE_CHANGED" }; }
          if (!entry) { closeOwned({ channel, owned: true }); fail("CAPTION_SUBSCRIPTION_FAILED"); }
          s.entries.add(entry);
        }
      } catch {
        if (current !== s) return { status: "ended", code: "CAPTURE_CHANGED" };
        finish("CAPTION_SUBSCRIPTION_FAILED"); return { status: "unavailable", code: "CAPTION_SUBSCRIPTION_FAILED" };
      }
      if (assisted && action === "start") { const code = enableCaptions(s); if (code) return { status: code === "CAPTURE_CHANGED" ? "ended" : "unavailable", code }; }
    }
    if (!current || current.owner !== captureId) return { status: "ended", code: terminal?.owner === captureId ? terminal.code : "CAPTURE_CHANGED",
      diagnostics: terminal?.owner === captureId ? { ...terminal.stats } : undefined };
    if (action !== "start" && action !== "recover" && action !== "read") return { status: "unavailable", code: "INVALID_CAPTURE" };
    const s = current; if (!valid(s)) return { status: "ended", code: terminal?.code ?? "CAPTURE_CHANGED", diagnostics: { ...terminal?.stats } };
    renew(s);
    return { status: "live", meetingId, platform: "Google Meet", blocks: [...s.records.values()].flatMap(r => r.block ? [{ ...r.block }] : []), diagnostics: { ...s.stats } };
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
    if (typeof nativeSend === "function") try {
      NativeChannel.send = function (...args) { try { observeMedia(this, args[0]); } catch {} return nativeSend.apply(this, args); };
    } catch {}
  } catch { prepareError = "RTC_PREPARE_FAILED"; }
  page.addEventListener("pagehide", () => finish("MEETING_CHANGED"));
})();
