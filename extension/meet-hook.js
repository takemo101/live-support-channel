// MAIN/document_start. No transcript processing while idle; no token or HTTP access here.
(() => {
  const page = window, key = "__liveCaptionsRtc_v1", core = page.__liveCaptionsHookCore;
  try { delete page.__liveCaptionsHookCore; } catch {}
  if (typeof core !== "function" || page !== page.top || page.location.protocol !== "https:" || page.location.hostname !== "meet.google.com" || page[key]) return;
  const NativePeer = page.RTCPeerConnection, create = NativePeer?.prototype?.createDataChannel;
  const { Uint8Array: Bytes, ArrayBuffer: Buffer, TextDecoder: Decoder, Blob: BinaryBlob, DecompressionStream: Inflate } = page;
  const now = page.performance.now.bind(page.performance), wallTime = page.Date.now.bind(page.Date);
  const LIMIT = 262144, ACK_LIMIT = 16384, peers = new Set(), tracked = new WeakMap();
  const NativeChannel = page.RTCDataChannel?.prototype, nativeSend = NativeChannel?.send, mediaSeen = new WeakMap(), mediaWritten = new WeakSet();
  const captionLabels = new Set(["captions", "captions_v2"]);
  let prepareError = null, decoding = null;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const invalid = () => fail("CAPTION_FORMAT_UNKNOWN");
  const currentMeeting = () => page.location.hostname === "meet.google.com" && page.location.protocol === "https:" && /^\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(page.location.pathname)
    ? `meet.google.com${page.location.pathname.replace(/\/$/, "")}` : null;
  function captionControl() {
    const buttons = [...page.document.querySelectorAll("button[aria-label]")].filter(b => b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    if (buttons.some(b => /^(Turn off captions|字幕をオフにする)(?:\s|[（(]|$)/i.test(b.getAttribute("aria-label")))) return "READY";
    return buttons.some(b => /^(Turn on captions|字幕をオンにする)(?:\s|[（(]|$)/i.test(b.getAttribute("aria-label"))) ? "CAPTIONS_OFF" : "CAPTION_CONTROL_NOT_FOUND";
  }
  function closeOwned(entry) { if (entry.owned) { try { entry.channel.close(); } catch {} } }
  const life = core(page, {
    meeting: currentMeeting,
    inFlight: s => decoding === s ? 1 : 0,
    check(s) { const code = captionControl(); return code === "READY" || (s.assisted && code === "CAPTIONS_OFF") ? null : code; },
    cleanup(s) {
      for (const job of s.queue) job.data = null;
      s.queue.length = 0; s.stats.queued = 0;
      const reader = s.reader; s.reader = null;
      if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
      s.records.clear(); s.speakers.clear();
      for (const entry of s.entries) closeOwned(entry);
      s.entries.clear();
    },
  });
  const { finish, valid } = life;
  function varint(bytes, cursor) {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (cursor.pos >= bytes.length) invalid();
      const b = bytes[cursor.pos++]; if (i === 9 && b > 1) invalid();
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return value;
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
  // Decoding follows protobuf semantics (unknown fields skipped, a repeated field keeps its last value, zero-valued fields are absent on the wire),
  // like the app's own decoder. A frame that is not a usable caption is dropped and counted, never fatal: only a stream of nothing usable stops the capture.
  function scan(bytes) {
    const out = new Map(), cursor = { pos: 0 };
    while (cursor.pos < bytes.length) {
      const tag = varint(bytes, cursor), field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!field) invalid();
      let value;
      if (wire === 0) value = varint(bytes, cursor);
      else if (wire === 1 || wire === 2 || wire === 5) {
        let length = wire === 1 ? 8 : 4;
        if (wire === 2) { const n = varint(bytes, cursor); if (n > BigInt(LIMIT)) invalid(); length = Number(n); }
        if (cursor.pos + length > bytes.length) invalid();
        value = bytes.subarray(cursor.pos, cursor.pos + length); cursor.pos += length;
      } else invalid();
      out.set(field, { wire, value });
    }
    return out;
  }
  const part = (map, field, wire) => { const item = map.get(field); return item && item.wire === wire ? item.value : null; };
  function text(bytes, max) {
    const value = new Decoder("utf-8").decode(bytes);
    if (value.length > max) fail("CAPTION_LIMIT"); return value;
  }
  // Returns a packet, null for a control frame, or the reason ("frame", "utterance", "device", "id") why the frame is not a usable caption.
  function decode(bytes, label) {
    let id, revision, device, body;
    try {
      const outer = scan(bytes);
      if (label === "captions") {
        if (part(outer, 2, 2)?.length) return null;
        const message = part(outer, 1, 2); if (!message) return "utterance";
        const fields = scan(message);
        device = part(fields, 1, 2); id = part(fields, 2, 0); revision = part(fields, 3, 0) ?? 0n; body = part(fields, 6, 2);
      } else {
        const message = part(outer, 1, 2); if (!message) return "utterance";
        // The real wire (seen on Meet, structure only) nests the utterance one level deeper: {1: {1: id, 2: version, 3: caption}, 6: {...}}. The app's own
        // decoder reads a field by number whatever its wire type, so it flattens that nesting by accident; we open it explicitly (at most twice).
        let fields = scan(message);
        for (let depth = 0; depth < 2 && !part(fields, 3, 2); depth++) { const wrapped = part(fields, 1, 2); if (!wrapped) break; fields = scan(wrapped); }
        const caption = part(fields, 3, 2); if (!caption) return "utterance";
        id = part(fields, 1, 0); revision = part(fields, 2, 0) ?? 0n;
        const inner = scan(caption); device = part(inner, 6, 2); body = part(inner, 3, 2);
      }
    } catch { return "frame"; }
    if (id === null || id < 1n || id > 0x7fffffffffffffffn || revision > BigInt(Number.MAX_SAFE_INTEGER)) return "id";
    if (!device || device.length > 2048) return "device";
    const deviceId = text(device, 512);
    if (!deviceId || /\p{Cc}/u.test(deviceId)) return "device";
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
    if (label !== "captions") return raw;
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
      speaker = { number: s.speakers.size + 1, boundary: packet.id, max: packet.id, device: packet.device };
      s.speakers.set(packet.device, speaker);
    }
    // shortcut: no verified generation timestamp; exclude each speaker's first ID and older IDs, not just one revision.
    if (packet.id <= speaker.boundary) { s.stats.baselineExcluded++; return; }
    const id = `${speaker.number}:${packet.id}`;
    let record = s.records.get(id);
    if (packet.id > speaker.max) speaker.max = packet.id;
    if (!record) {
      if (s.records.size >= 4000) fail("CAPTION_LIMIT");
      record = { speaker, block: null, revision: -1, localId: `${s.owner}:${s.records.size + 1}` }; s.records.set(id, record);
    }
    // The same version may arrive again with newer text (the app's own pipeline replaces on an equal version): newest wins, an older version never does.
    if (!packet.text || packet.revision < record.revision || (packet.revision === record.revision && packet.text === record.block?.transcript)) return;
    s.characters += packet.text.length - (record.block?.transcript.length ?? 0);
    if (s.characters > 2_000_000) fail("CAPTION_LIMIT");
    record.revision = packet.revision;
    record.block = { messageId: record.localId,
      deviceId: `speaker-${speaker.number}`, messageVersion: packet.revision,
      speakerName: nameOf(speaker), transcript: packet.text,
      timestamp: record.block?.timestamp ?? wallTime(), version: packet.revision };
    s.stats.accepted++;
  }
  // Meet's caption packets carry only an opaque device id. The names come from Meet's own roster messages on the "collections" channel
  // (device id -> display name). Unlike captions this is read from the moment the channel exists, because the roster is sent at join and a
  // later start would never see it. Only (device id, sanitised name) pairs are kept, in memory, at most 256, and nothing is sent before consent.
  const roster = new Map();
  const deviceKey = id => String(id).replace(/^@/, "");
  function items(bytes) {
    const out = []; const cursor = { pos: 0 };
    while (cursor.pos < bytes.length) {
      const tag = varint(bytes, cursor), field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!field) invalid();
      if (wire === 0) { varint(bytes, cursor); continue; }
      let length;
      if (wire === 2) { const n = varint(bytes, cursor); if (n > BigInt(LIMIT)) invalid(); length = Number(n); }
      else if (wire === 1) length = 8; else if (wire === 5) length = 4; else invalid();
      if (cursor.pos + length > bytes.length) invalid();
      if (wire === 2) out.push({ field, value: bytes.subarray(cursor.pos, cursor.pos + length) });
      cursor.pos += length;
    }
    return out;
  }
  // Follows a path of length-delimited field numbers; a repeated field fans out.
  function walk(bytes, path) {
    let layer = [bytes];
    for (const field of path) { const next = []; for (const part of layer) for (const item of items(part)) if (item.field === field) next.push(item.value); layer = next.slice(0, 256); }
    return layer;
  }
  function note(device) {
    let id = "", name = "";
    for (const item of items(device)) {
      let value; try { value = new Decoder("utf-8", { fatal: true }).decode(item.value); } catch { return; }
      if (item.field === 1 && !id) id = value; else if (item.field === 2 && !name) name = value;
    }
    name = life.displayName(name); id = deviceKey(id);
    if (id && id.length <= 512 && name && (roster.has(id) || roster.size < 256)) roster.set(id, name);
  }
  // Roster frames follow the same wrapping as captions: raw protobuf, or gzip at offset 0 or 3.
  async function learn(data) {
    try {
      let raw;
      if (data instanceof BinaryBlob) { if (data.size > LIMIT) return; raw = new Bytes(await data.arrayBuffer()); }
      else if (data instanceof Buffer) { if (data.byteLength > LIMIT) return; raw = new Bytes(data).slice(); }
      else if (Buffer.isView(data)) { if (data.byteLength > LIMIT) return; raw = new Bytes(data.buffer, data.byteOffset, data.byteLength).slice(); }
      else return;
      const gzip = offset => raw.length >= offset + 3 && raw[offset] === 31 && raw[offset + 1] === 139 && raw[offset + 2] === 8;
      const offset = gzip(0) ? 0 : gzip(3) ? 3 : -1;
      let bytes = raw;
      if (offset >= 0) {
        const reader = new BinaryBlob([raw.subarray(offset)]).stream().pipeThrough(new Inflate("gzip")).getReader();
        const chunks = []; let size = 0;
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > LIMIT) { await reader.cancel(); return; }
          chunks.push(value);
        }
        bytes = new Bytes(size); let position = 0;
        for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
      }
      for (const device of walk(bytes, [2, 2, 2])) note(device);
      for (const device of walk(bytes, [1, 2, 13, 1, 2])) note(device);
    } catch {}
  }
  let rosterBusy = 0;
  function rosterFrame(event) {
    if (event.isTrusted !== true || rosterBusy >= 8) return;
    rosterBusy++; learn(event.data).finally(() => { rosterBusy--; });
  }
  const nameOf = speaker => roster.get(deviceKey(speaker.device)) || `話者 ${speaker.number}（名前未確認）`;
  // Structure only (field numbers and wire types, never values): lets a mismatch with the real wire be diagnosed without any caption text.
  // A length-delimited field is opened only if it holds a control byte, which plain text never does.
  function shapeOf(bytes, depth = 5) {
    const parts = [], cursor = { pos: 0 };
    try {
      while (cursor.pos < bytes.length && parts.length < 12) {
        const tag = varint(bytes, cursor), field = Number(tag >> 3n), wire = Number(tag & 7n);
        if (!field || field > 1000) { parts.push("!"); break; }
        if (wire === 0) { varint(bytes, cursor); parts.push(field + ":0"); }
        else if (wire === 1 || wire === 5) { cursor.pos += wire === 1 ? 8 : 4; if (cursor.pos > bytes.length) { parts.push("!"); break; } parts.push(field + ":" + wire); }
        else if (wire === 2) {
          const length = Number(varint(bytes, cursor)); if (cursor.pos + length > bytes.length) { parts.push("!"); break; }
          const inner = bytes.subarray(cursor.pos, cursor.pos + length); cursor.pos += length;
          const nested = depth > 1 && length > 1 && inner.some(b => b < 0x20) ? shapeOf(inner, depth - 1) : "";
          parts.push(field + ":2" + (nested && !nested.includes("!") ? "(" + nested + ")" : ""));
        } else { parts.push("!"); break; }
      }
    } catch { parts.push("!"); }
    return parts.join(",");
  }
  // Subscribes with channels of our own, the way the app's own client does (both profiles, ordered, limited retransmits), when Meet has none to observe.
  function subscribe(s) {
    const target = s.connection;
    for (const label of ["captions_v2", "captions"]) {
      const channel = create.call(target.peer, label, { ordered: true, maxRetransmits: 10 });
      if (!valid(s)) { closeOwned({ channel, owned: true }); return "ended"; }
      let entry;
      try { entry = attach(target, channel, true); }
      catch (error) { closeOwned({ channel, owned: true }); throw error; }
      if (!valid(s)) { closeOwned({ channel, owned: true }); return "ended"; }
      if (!entry) { closeOwned({ channel, owned: true }); fail("CAPTION_SUBSCRIPTION_FAILED"); }
      s.entries.add(entry);
    }
    return null;
  }
  function reject(s, entry, reason, bytes) {
    s.stats[reason] = (s.stats[reason] ?? 0) + 1; s.stats.dropped++;
    if (bytes && s.stats.shapes.length < 3) {
      const shape = `${entry.label}:#${bytes.length}:${shapeOf(bytes)}`;
      if (!s.stats.shapes.includes(shape)) s.stats.shapes.push(shape);
    }
  }
  function receive(entry, event) {
    const s = life.current;
    if (!s || !s.entries.has(entry) || event.isTrusted !== true || event.timeStamp < s.started || !valid(s)) return;
    if (s.stats.queued >= 8) { finish("CAPTION_BACKLOG_LIMIT"); return; }
    let data = event.data;
    if (!(data instanceof BinaryBlob || data instanceof Buffer || Buffer.isView(data))) { life.guard(s, () => reject(s, entry, "binary", null)); return; }
    try { payloadSize(data); }
    catch (error) { if (life.current === s) finish(error?.code === "CAPTION_LIMIT" ? error.code : "CAPTION_FORMAT_UNKNOWN"); return; }
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
          let bytes;
          try { bytes = await unpack(data, job.entry.label, s); }
          catch (error) { if (error?.code === "CAPTION_LIMIT") throw error; if (valid(s)) reject(s, job.entry, "frame", null); continue; }
          if (!bytes || !valid(s) || !s.entries.has(job.entry)) continue;
          const packet = decode(bytes, job.entry.label);
          if (typeof packet === "string") reject(s, job.entry, packet, bytes);
          else if (packet) ingest(s, job.entry, packet);
        } finally { s.stats.queued = Math.max(0, s.stats.queued - 1); s.stats.inFlight = 0; }
      }
    } catch (error) {
      if (life.current === s) finish(["CAPTION_LIMIT", "CAPTION_BACKLOG_LIMIT", "CAPTION_ACK_BACKLOG_LIMIT"].includes(error?.code) ? error.code : "CAPTION_FORMAT_UNKNOWN");
    } finally {
      if (decoding === s) decoding = null;
      if (life.terminal?.generation === s.generation) life.terminal.stats.inFlight = 0;
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
  function attach(connection, channel, owned = false) {
    const label = channel.label;
    if (!["captions", "captions_v2", "collections", "media-session"].includes(label)) return null;
    for (const entry of connection.channels) if (entry.channel === channel) return entry;
    if (connection.channels.size >= 32) { prepareError = "RTC_RESOURCE_LIMIT"; finish(prepareError); return null; }
    const entry = { channel, label, owned }; connection.channels.add(entry);
    try {
      if (captionLabels.has(label)) channel.addEventListener("message", event => receive(entry, event));
      else if (label === "collections") channel.addEventListener("message", rosterFrame);
      channel.addEventListener("close", () => {
        connection.channels.delete(entry);
        if (life.current?.entries.has(entry)) finish("CAPTION_CHANNEL_CLOSED");
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
    return life.current === s ? null : "CAPTURE_CHANGED";
  }
  function metadata(assist = false) {
    const id = currentMeeting(), choices = candidates(), selected = choices.length === 1 ? choices[0] : null;
    let code = prepareError ?? (id ? captionControl() : "NOT_MEETING_PAGE");
    if (assist && code === "CAPTIONS_OFF") code = selected ? (assistTarget(selected).code ?? "READY") : "READY";
    if (code === "READY" && !selected) code = choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND";
    if (code === "READY" && decoding && !life.current) code = "CAPTION_DECODE_BUSY";
    const stats = life.current?.stats ?? life.terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "meet-rtc-experimental", platform: "Google Meet",
      meetings: id ? [{ id, title: "Google Meet（字幕通信・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: peers.size, captionChannels: selected ? [...selected.channels].filter(entry => captionLabels.has(entry.label)).length : 0, ...stats, names: roster.size, profile: life.current?.selected?.label ?? "pending" } };
  }
  function command(params = {}) {
    const { action, meetingId, captureId, assistCaptions } = params;
    const early = life.prologue(params, () => metadata(assistCaptions === true)); if (early) return early;
    if (action === "start" || action === "recover") {
      const assisted = action === "recover" ? life.terminal.assisted === true : assistCaptions === true;
      const meta = metadata(assisted); if (!meta.captionReady) return { status: "unavailable", code: meta.code };
      const retired = finish("CAPTURE_REPLACED");
      if (life.generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      if (decoding) return { status: "unavailable", code: "CAPTION_DECODE_BUSY" };
      const ready = metadata(assisted), choices = candidates();
      if (life.generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      if (currentMeeting() !== meetingId) return { status: "ended", code: "MEETING_CHANGED" };
      if (!ready.captionReady) return { status: "unavailable", code: ready.code };
      if (choices.length !== 1) return { status: "unavailable", code: choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND" };
      const target = choices[0]; life.clearTerminal();
      const s = { owner: captureId, meetingId, connection: target, assisted, entries: new Set(), selected: null,
        records: new Map(), speakers: new Map(), characters: 0, started: now(), queue: [], reader: null,
        stats: { received: 0, accepted: 0, baselineExcluded: 0, dropped: 0, queued: 0, inFlight: 0, shapes: [] } };
      life.activate(s);
      try {
        for (const entry of target.channels) if (!entry.owned && captionLabels.has(entry.label) && entry.channel.ordered && ["open", "connecting"].includes(entry.channel.readyState)) s.entries.add(entry);
        if (!s.entries.size && subscribe(s) === "ended") return { status: "ended", code: "CAPTURE_CHANGED" };
      } catch {
        if (life.current !== s) return { status: "ended", code: "CAPTURE_CHANGED" };
        finish("CAPTION_SUBSCRIPTION_FAILED"); return { status: "unavailable", code: "CAPTION_SUBSCRIPTION_FAILED" };
      }
      if (assisted && action === "start") { const code = enableCaptions(s); if (code) return { status: code === "CAPTURE_CHANGED" ? "ended" : "unavailable", code }; }
    }
    return life.epilogue(params, { platform: "Google Meet", blocks: s => [...s.records.values()].flatMap(r => r.block ? [{ ...r.block, speakerName: nameOf(r.speaker) }] : []) });
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
  page.addEventListener("pagehide", () => { roster.clear(); finish("MEETING_CHANGED"); });
})();
