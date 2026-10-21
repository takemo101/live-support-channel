// MAIN/document_start. No transcript processing while idle; no token, and no HTTP request of its own (Meet's own fetch responses are only read, from a clone).
(() => {
  const page = window, key = "__liveCaptionsRtc_v1", core = page.__liveCaptionsHookCore, wire = page.__liveCaptionsMeetWire;
  try { delete page.__liveCaptionsHookCore; delete page.__liveCaptionsMeetWire; } catch {}
  if (typeof core !== "function" || typeof wire !== "function" || page !== page.top || page.location.protocol !== "https:" || page.location.hostname !== "meet.google.com" || page[key]) return;
  const NativePeer = page.RTCPeerConnection, create = NativePeer?.prototype?.createDataChannel;
  const { Uint8Array: Bytes, ArrayBuffer: Buffer, TextDecoder: Decoder, Blob: BinaryBlob, DecompressionStream: Inflate } = page, nativeFetch = page.fetch, nativeAtob = page.atob;
  const now = page.performance.now.bind(page.performance), wallTime = page.Date.now.bind(page.Date);
  const LIMIT = 262144, ACK_LIMIT = 16384, peers = new Set(), tracked = new WeakMap();
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
    check() { const code = captionControl(); return code === "READY" ? null : code; },
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
  const { scan, part, text, decode, integer, ack, items, walk, shapeOf } = wire({ Bytes, Decoder, LIMIT });
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
      learnBytes(bytes);
    } catch {}
  }
  function learnBytes(bytes) {
    for (const device of walk(bytes, [2, 2, 2])) note(device);
    for (const device of walk(bytes, [1, 2, 13, 1, 2])) note(device);
  }
  // Meet sends the full device list (everyone already in the meeting, and yourself) only in the response of SyncMeetingSpaceCollections;
  // the "collections" channel carries just the changes after that. The own device id shows up in that request and in CreateMeetingDevice.
  const SYNC_PATH = "/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections";
  const DEVICE_PATH = "/google.rtc.meetings.v1.MeetingDeviceService/CreateMeetingDevice";
  // Counters only (what the panel shows when names are missing): how many of Meet's own RPC calls were seen, how many device lists were read and how many names they gave.
  const rosterStats = { rpc: 0, sync: 0, syncNames: 0, channel: 0, shape: "" };
  const rpcKind = url => {
    if (!url.includes("/$rpc/") || !(url.startsWith("https://meet.google.com/") || (url.startsWith("/") && !url.startsWith("//")))) return null;
    rosterStats.rpc++;
    return url.includes(SYNC_PATH) ? "sync" : url.includes(DEVICE_PATH) ? "device" : null;
  };
  const SELF_PATTERN = /spaces\/[A-Za-z0-9_-]{1,64}\/devices\/[A-Za-z0-9_-]{1,64}/;
  let selfDevice = null;
  const latin1 = bytes => { let out = ""; for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]); return out; };
  function noteSelf(text, replace) { const match = typeof text === "string" ? SELF_PATTERN.exec(text) : null; if (match && (replace || !selfDevice)) selfDevice = match[0]; }
  function bodyText(body) {
    if (typeof body === "string") return body.length <= LIMIT ? body : null;
    if (body instanceof Buffer && body.byteLength <= LIMIT) return latin1(new Bytes(body));
    if (Buffer.isView(body) && body.byteLength <= LIMIT) return latin1(new Bytes(body.buffer, body.byteOffset, body.byteLength));
    return null;
  }
  // The response body is base64 text (as the app's own client reads it) or, failing that, plain protobuf bytes.
  async function inspectResponse(kind, response) {
    try {
      if (!response || response.ok === false || typeof response.clone !== "function") return;
      const buffer = await response.clone().arrayBuffer();
      if (!(buffer instanceof Buffer) || buffer.byteLength > LIMIT * 2) return;
      let bytes = new Bytes(buffer);
      const text = latin1(bytes);
      if (/^[A-Za-z0-9+/=_\s-]+$/.test(text)) {
        try {
          const raw = nativeAtob(text.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/")), decoded = new Bytes(raw.length);
          for (let i = 0; i < raw.length; i++) decoded[i] = raw.charCodeAt(i);
          bytes = decoded;
        } catch {}
      }
      if (kind === "device") { noteSelf(latin1(bytes), true); return; }
      const before = roster.size;
      try { learnBytes(bytes); } catch {}
      if (roster.size === before && bytes.length > 5 && bytes[0] === 0) { try { learnBytes(bytes.subarray(5)); } catch {} }   // a gRPC-web frame header
      rosterStats.sync++; rosterStats.syncNames += roster.size - before;
      if (!rosterStats.syncNames) rosterStats.shape = shapeOf(bytes, 4).slice(0, 200);
    } catch {}
  }
  let rosterBusy = 0;
  function rosterFrame(event) {
    if (event.isTrusted !== true || rosterBusy >= 8) return;
    rosterStats.channel++; rosterBusy++; learn(event.data).finally(() => { rosterBusy--; });
  }
  const nameOf = speaker => {
    const device = deviceKey(speaker.device);
    return roster.get(device) || (selfDevice && device === selfDevice ? "あなた（自分）" : `話者 ${speaker.number}（名前未確認）`);
  };
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
  function metadata() {
    const id = currentMeeting(), choices = candidates(), selected = choices.length === 1 ? choices[0] : null;
    let code = prepareError ?? (id ? captionControl() : "NOT_MEETING_PAGE");
    if (code === "READY" && !selected) code = choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND";
    if (code === "READY" && decoding && !life.current) code = "CAPTION_DECODE_BUSY";
    const stats = life.current?.stats ?? life.terminal?.stats ?? { received: 0, accepted: 0, baselineExcluded: 0, queued: 0 };
    return { status: "ready", source: "meet-rtc-experimental", platform: "Google Meet",
      meetings: id ? [{ id, title: "Google Meet（字幕通信・試験版）" }] : [], captionReady: code === "READY", code,
      diagnostics: { peers: peers.size, captionChannels: selected ? [...selected.channels].filter(entry => captionLabels.has(entry.label)).length : 0, ...stats, names: roster.size, rosterRpc: rosterStats.rpc, rosterSync: rosterStats.sync, rosterSyncNames: rosterStats.syncNames, rosterChannel: rosterStats.channel, selfKnown: selfDevice ? 1 : 0, ...(rosterStats.shape ? { rosterShape: rosterStats.shape } : {}), profile: life.current?.selected?.label ?? "pending" } };
  }
  function command(params = {}) {
    const { action, meetingId, captureId } = params;
    const early = life.prologue(params, metadata); if (early) return early;
    if (action === "start" || action === "recover") {
      const meta = metadata(); if (!meta.captionReady) return { status: "unavailable", code: meta.code };
      const retired = finish("CAPTURE_REPLACED");
      if (life.generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      if (decoding) return { status: "unavailable", code: "CAPTION_DECODE_BUSY" };
      const ready = metadata(), choices = candidates();
      if (life.generation !== retired) return { status: "ended", code: "CAPTURE_CHANGED" };
      if (currentMeeting() !== meetingId) return { status: "ended", code: "MEETING_CHANGED" };
      if (!ready.captionReady) return { status: "unavailable", code: ready.code };
      if (choices.length !== 1) return { status: "unavailable", code: choices.length > 1 ? "RTC_CONNECTION_AMBIGUOUS" : "RTC_CONNECTION_NOT_FOUND" };
      const target = choices[0]; life.clearTerminal();
      const s = { owner: captureId, meetingId, connection: target, entries: new Set(), selected: null,
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
  } catch { prepareError = "RTC_PREPARE_FAILED"; }
  if (typeof nativeFetch === "function" && typeof nativeAtob === "function") try {
    page.fetch = function (...args) {
      let url = "";
      try { const input = args[0]; url = typeof input === "string" ? input : String(input?.url ?? ""); } catch {}
      let kind = null; try { kind = rpcKind(url); } catch {}
      if (kind === "sync") { try { noteSelf(bodyText(args[1]?.body), false); } catch {} }
      const result = nativeFetch.apply(this, args);
      if (kind) { try { result.then(response => { void inspectResponse(kind, response); }, () => {}); } catch {} }
      return result;
    };
  } catch {}
  page.addEventListener("pagehide", () => { roster.clear(); selfDevice = null; Object.assign(rosterStats, { rpc: 0, sync: 0, syncNames: 0, channel: 0, shape: "" }); finish("MEETING_CHANGED"); });
})();
