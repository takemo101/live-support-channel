import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const source = await readFile(new URL("../extension/meet-hook.js", import.meta.url), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
const key = "__liveCaptionsRtc_v1", meetingId = "meet.google.com/abc-defg-hij";
const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => [...p]));
function uint(value) { let n = BigInt(value); const out = []; do { let b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n); return Uint8Array.from(out); }
const scalar = (field, value) => bytes(uint(field * 8), uint(value));
const blob = (field, value) => bytes(uint(field * 8 + 2), uint(value.length), value);
const string = (field, value) => blob(field, new TextEncoder().encode(value));
function packet(id, text, revision = 1, device = "synthetic-device", label = "captions_v2") {
  if (label === "captions") return blob(1, bytes(string(1, device), scalar(2, id), scalar(3, revision), text === null ? [] : string(6, text), scalar(8, 1)));
  return blob(1, bytes(scalar(1, id), scalar(2, revision), blob(3, bytes(text === null ? [] : string(3, text), string(4, "en-US"), string(6, device)))));
}
function fixture(t, { native = true, label = "captions_v2", host = "meet.google.com", framed = false, inflate = DecompressionStream } = {}) {
  const timers = new Map(), pageEvents = new Map(); let now = 100, clockId = 0;
  class Events {
    events = new Map();
    addEventListener(type, fn) { const list = this.events.get(type) ?? []; list.push(fn); this.events.set(type, list); this.onAddListener?.(type); }
    emit(type, event = {}) { for (const fn of this.events.get(type) ?? []) fn(event); }
  }
  class Channel extends Events {
    constructor(label, options = {}) { super(); this.label = label; this.ordered = options.ordered ?? true; this.readyState = "open"; this.sent = []; this.bufferedAmount = 0; this.closed = false; this.binaryType = "arraybuffer"; }
    send(data) { this.sent.push(new Uint8Array(data)); this.bufferedAmount += data.byteLength; this.onSend?.(data); }
    close() { this.closed = true; this.readyState = "closed"; this.emit("close"); this.onClose?.(); }
    message(data, extra = {}) { this.emit("message", { data, isTrusted: true, timeStamp: now, ...extra }); }
  }
  class Peer extends Events {
    constructor(...args) { super(); this.args = args; this.connectionState = "connected"; this.channels = []; this.sctp = {}; }
    createDataChannel(label, options) { if (label === this.failLabel) throw Error("native channel creation failed"); const c = new Channel(label, options); this.channels.push(c); this.onCreate?.(c); return c; }
    close() { this.connectionState = "closed"; this.emit("connectionstatechange"); }
  }
  const button = { checkVisibility: () => true, getAttribute: () => "Turn off captions (c)" };
  const page = {
    location: { protocol: "https:", hostname: host, pathname: "/abc-defg-hij" },
    document: { querySelectorAll(selector) { assert.equal(selector, "button[aria-label]"); return [button]; }, get body() { throw Error("no caption DOM access"); } },
    RTCPeerConnection: Peer, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, Blob, DecompressionStream: inflate,
    performance: { now: () => now }, Date,
    setTimeout(fn) { const id = ++clockId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { pageEvents.set(type, fn); },
  };
  page.top = framed ? {} : page;
  class ObservedMap extends Map {
    set(k, value) { if (k === "synthetic-device") page.onSpeakerWrite?.(); return super.set(k, value); }
  }
  const context = vm.createContext({ window: page, Map: ObservedMap });
  vm.runInContext(source, context);
  const api = page[key];
  if (host === "meet.google.com" && !framed) assert.ok(api, "early RTC hook API must be installed");
  const command = (action, owner = "synthetic-owner") => api.command({ action, meetingId, captureId: owner });
  const pc = new page.RTCPeerConnection("original-argument"); pc.createDataChannel("collections");
  const channel = native ? pc.createDataChannel(label) : null;
  t.after(() => api?.command({ action: "reset", captureId: "synthetic-owner" }));
  return { page, pc, channel, command, api, context, button, pageEvents,
    async drain() { for (let i = 0; i < 100 && command("discover").diagnostics.queued; i++) await new Promise(r => setTimeout(r, 2)); },
    expire() { now += 2100; for (const fn of [...timers.values()]) fn(); },
  };
}

test("document-start preparation preserves RTC calls and never reads inactive payloads", t => {
  const f = fixture(t); assert.deepEqual(f.pc.args, ["original-argument"]);
  assert.equal(f.api.version, 1); assert.equal(f.command("discover").code, "READY");
  f.channel.emit("message", { isTrusted: true, timeStamp: 100, get data() { assert.fail("payload accessed before consent"); } });
  assert.equal(f.command("discover").diagnostics.received, 0);
  const before = f.page.RTCPeerConnection; vm.runInContext(source, f.context);
  assert.equal(f.page.RTCPeerConnection, before);
});
for (const label of ["captions", "captions_v2"]) test("known wire profile forwards new IDs and revisions only: " + label, async t => {
  const f = fixture(t, { label }); assert.equal(f.command("start").status, "live");
  f.channel.message(packet(100, "private baseline", 1, "device-secret", label)); await f.drain();
  f.channel.message(packet(100, "private baseline revised", 2, "device-secret", label)); await f.drain();
  assert.equal(f.command("read").blocks.length, 0);
  f.channel.message(packet(101, "new caption", 1, "device-secret", label)); await f.drain();
  const first = f.command("read").blocks[0]; assert.equal(first.transcript, "new caption");
  assert.match(first.speakerName, /名前未確認/); assert.ok(!JSON.stringify(first).includes("device-secret"));
  f.channel.message(packet(101, "corrected caption", 2, "device-secret", label)); await f.drain();
  const changed = f.command("read").blocks[0]; assert.equal(changed.messageId, first.messageId); assert.equal(changed.messageVersion, 2);
  assert.equal(changed.transcript, "corrected caption"); assert.equal(changed.timestamp, first.timestamp);
  assert.equal(f.channel.sent.length, 0, "never ACK an original application channel");
});
test("own subscriptions ACK v2 only and stop closes only owned channels", async t => {
  const f = fixture(t, { native: false }); f.command("start");
  const v2 = f.pc.channels.find(c => c.label === "captions_v2"), legacy = f.pc.channels.find(c => c.label === "captions");
  assert.ok(v2 && legacy); assert.equal(v2.ordered, true);
  v2.message(packet(100, "baseline")); await f.drain();
  assert.deepEqual([...v2.sent[0]], [10, 8, 10, 6, 8, 100, 16, 1, 24, 1]);
  assert.equal(legacy.closed, true); f.command("reset");
  assert.equal(v2.closed, true); assert.equal(f.pc.channels[0].closed, false); assert.equal(f.pc.connectionState, "connected");
});
for (const buffered of [16380, 262145]) test("own ACK queue fails closed before exceeding its bound: " + buffered, async t => {
  const f = fixture(t, { native: false }); f.command("start");
  const v2 = f.pc.channels.find(c => c.label === "captions_v2"); v2.bufferedAmount = buffered;
  v2.message(packet(1, "baseline")); await f.drain();
  assert.equal(v2.sent.length, 0); assert.equal(f.command("read").code, "CAPTION_ACK_BACKLOG_LIMIT");
  assert.equal(v2.closed, true); assert.equal(f.pc.channels[0].closed, false);
});
test("repeated excluded-ID ACKs cannot grow a stalled outgoing queue", async t => {
  const f = fixture(t, { native: false }); f.command("start");
  const v2 = f.pc.channels.find(c => c.label === "captions_v2"); v2.bufferedAmount = 16369;
  v2.message(packet(1, "baseline")); await f.drain(); assert.equal(v2.sent.length, 1);
  v2.message(packet(1, "baseline revision", 2)); await f.drain();
  assert.equal(v2.sent.length, 1); assert.equal(f.command("read").code, "CAPTION_ACK_BACKLOG_LIMIT");
});
for (const stop of ["reset", "expiry", "replacement"]) test("reentrant create cannot leak owned channels: " + stop, t => {
  const f = fixture(t, { native: false }); let fired = false, first;
  f.pc.onCreate = channel => {
    if (fired || channel.label !== "captions_v2") return;
    fired = true; first = channel;
    if (stop === "expiry") f.expire(); else f.command("reset");
    if (stop === "replacement") f.command("start", "next-owner");
  };
  assert.equal(f.command("start").status, "ended");
  assert.equal(first.closed, true);
  assert.equal(f.pc.channels[0].closed, false);
  if (stop === "replacement") {
    assert.equal(f.command("read", "next-owner").status, "live");
    assert.equal(f.pc.channels.filter(c => c !== f.pc.channels[0] && !c.closed).length, 2);
    f.command("reset", "next-owner");
  } else {
    assert.equal(f.pc.channels.filter(c => c !== f.pc.channels[0] && !c.closed).length, 0);
    f.expire(); assert.equal(first.closed, true);
  }
});
for (const thrown of [false, true]) test("partial own-channel attachment is cleaned up: throws=" + thrown, t => {
  const f = fixture(t, { native: false }); let fired = false, first;
  f.pc.onCreate = channel => {
    if (fired) return; fired = true; first = channel;
    channel.onAddListener = type => {
      if (type !== "message") return;
      if (thrown) throw Error("observer failed during attach");
      f.command("reset"); f.command("start", "next-owner");
    };
  };
  assert.notEqual(f.command("start").status, "live"); assert.equal(first.closed, true);
  assert.equal(f.pc.channels[0].closed, false);
  if (!thrown) { assert.equal(f.command("read", "next-owner").status, "live"); f.command("reset", "next-owner"); }
});
test("ACK and unused-channel close observers cannot ingest after reset", async t => {
  for (const callback of ["onSend", "onClose"]) {
    const f = fixture(t, { native: false }); f.command("start"); let writes = 0;
    f.page.onSpeakerWrite = () => { writes++; };
    const v2 = f.pc.channels.find(c => c.label === "captions_v2");
    const observed = callback === "onSend" ? v2 : f.pc.channels.find(c => c.label === "captions");
    observed[callback] = () => f.command("reset");
    v2.message(packet(1, "in-flight baseline")); await new Promise(r => setImmediate(r));
    assert.equal(writes, 0); assert.equal(v2.closed, true);
    if (callback === "onClose") assert.equal(v2.sent.length, 0);
  }
});
test("cleanup close callbacks cannot replace a newer capture", t => {
  const f = fixture(t, { native: false }); f.command("start");
  const old = f.pc.channels.find(c => c.label === "captions_v2");
  old.onClose = () => { old.onClose = null; f.command("start", "next-owner"); };
  assert.equal(f.command("start", "outer-owner").status, "ended");
  assert.equal(f.command("read", "next-owner").status, "live");
  assert.equal(f.pc.channels.filter(c => c !== f.pc.channels[0] && !c.closed).length, 2);
  f.command("reset", "next-owner");
});
for (const change of ["ambiguous", "missing", "captions-off", "meeting"]) test("replacement revalidates readiness after cleanup: " + change, t => {
  const f = fixture(t, { native: false }); f.command("start");
  const legacy = f.pc.channels.find(c => c.label === "captions");
  legacy.onClose = () => {
    legacy.onClose = null;
    if (change === "ambiguous") new f.page.RTCPeerConnection().createDataChannel("collections");
    else if (change === "missing") f.pc.close();
    else if (change === "captions-off") f.button.getAttribute = () => "Turn on captions (c)";
    else f.page.location.pathname = "/xyz-abcd-efg";
  };
  const result = f.command("start", "next-owner");
  assert.notEqual(result.status, "live");
  assert.equal(result.code, { ambiguous: "RTC_CONNECTION_AMBIGUOUS", missing: "RTC_CONNECTION_NOT_FOUND", "captions-off": "CAPTIONS_OFF", meeting: "MEETING_CHANGED" }[change]);
  assert.equal(f.pc.channels.length, 3, "no new subscription after readiness changed");
  assert.equal(f.pc.channels[0].closed, false); assert.ok(f.pc.channels.slice(1).every(c => c.closed));
});
test("post-cleanup readiness callbacks cannot overwrite a replacement capture", t => {
  const f = fixture(t, { native: false }); f.command("start"); let checks = 0;
  f.button.getAttribute = () => {
    if (++checks === 2) assert.equal(f.command("start", "next-owner").status, "live");
    return "Turn off captions (c)";
  };
  const result = f.command("start", "outer-owner");
  assert.equal(result.code, "CAPTURE_CHANGED"); assert.equal(f.command("read", "next-owner").status, "live");
  assert.equal(f.pc.channels.filter(c => c !== f.pc.channels[0] && !c.closed).length, 2);
  f.command("reset", "next-owner");
});
test("reset/pause ignores payloads, resume excludes first IDs and their revisions", async t => {
  const f = fixture(t); f.command("start"); f.channel.message(packet(10, "baseline")); await f.drain();
  f.channel.message(packet(11, "unsent before pause")); await f.drain(); f.command("reset");
  f.channel.emit("message", { isTrusted: true, get data() { assert.fail("paused payload access"); } });
  f.command("start"); f.channel.message(packet(20, "private paused prefix")); await f.drain();
  f.channel.message(packet(20, "private paused prefix revised", 2)); await f.drain(); assert.equal(f.command("read").blocks.length, 0);
  f.channel.message(packet(21, "after resume")); await f.drain(); assert.equal(f.command("read").blocks[0].transcript, "after resume");
});
test("lease expires before further payload access and stale owners cannot reset a new capture", t => {
  const f = fixture(t); f.command("start"); f.expire();
  f.channel.emit("message", { isTrusted: true, get data() { assert.fail("expired payload access"); } });
  assert.equal(f.command("read").code, "CAPTURE_EXPIRED");
  f.command("start", "next-owner"); f.command("reset");
  assert.equal(f.command("read", "next-owner").status, "live"); f.command("reset", "next-owner");
});
test("native captions OFF and navigation stop capture before data access", t => {
  const f = fixture(t); f.command("start"); f.button.getAttribute = () => "Turn on captions (c)";
  f.channel.emit("message", { isTrusted: true, get data() { assert.fail("captions-off payload access"); } });
  assert.equal(f.command("read").code, "CAPTIONS_OFF");
  f.button.getAttribute = () => "Turn off captions (c)"; f.command("start"); f.page.location.pathname = "/landing";
  f.channel.emit("message", { isTrusted: true, get data() { assert.fail("navigation payload access"); } });
  assert.equal(f.command("read").code, "MEETING_CHANGED");
});
test("chat, unknown labels and synthetic JS events never enter the decoder", t => {
  const f = fixture(t); f.command("start");
  f.pc.emit("datachannel", { isTrusted: false, get channel() { assert.fail("synthetic remote channel must not be inspected"); } });
  const chat = f.pc.createDataChannel("meet_messages"); chat.emit("message", { isTrusted: true, get data() { assert.fail("chat access"); } });
  f.channel.emit("message", { isTrusted: false, get data() { assert.fail("synthetic event access"); } });
  assert.equal(f.command("read").blocks.length, 0);
});
for (const bad of [Uint8Array.of(10, 255), Uint8Array.of(10, 2, 8, 1), new Uint8Array(262145)]) {
  test("malformed/oversize frames stop without text fallback: " + bad.length, async t => {
    const f = fixture(t); f.command("start"); f.channel.message(bad); await f.drain();
    assert.notEqual(f.command("read").status, "live"); assert.equal(f.command("read").blocks, undefined);
    assert.equal(f.command("read").diagnostics?.received, bad.length > 262144 ? 0 : 1);
    assert.equal(f.command("read").diagnostics?.queued, 0);
  });
}
test("legacy gzip framing is bounded and decodes the known envelope", async t => {
  const f = fixture(t, { label: "captions" }); f.command("start");
  f.channel.message(gzipSync(packet(1, "baseline", 1, "d", "captions"))); await f.drain();
  f.channel.message(bytes([0, 0, 0], gzipSync(packet(2, "after gzip", 1, "d", "captions")))); await f.drain();
  assert.equal(f.command("read").blocks[0].transcript, "after gzip");
});
test("unknown out-of-order IDs and same-version conflicting text fail closed", async t => {
  for (const conflict of [false, true]) {
    const f = fixture(t); f.command("start"); f.channel.message(packet(10, "baseline")); await f.drain();
    f.channel.message(packet(12, "new")); await f.drain();
    f.channel.message(conflict ? packet(12, "different at same version") : packet(11, "unknown older history")); await f.drain();
    assert.notEqual(f.command("read").status, "live");
  }
});
test("metadata-only utterances cannot collide when text arrives later", async t => {
  const f = fixture(t); f.command("start");
  for (const [id, text] of [[1, "baseline"], [2, null], [3, null], [2, "second"], [3, "third"]]) { f.channel.message(packet(id, text)); await f.drain(); }
  const blocks = f.command("read").blocks;
  assert.equal(blocks.length, 2); assert.equal(new Set(blocks.map(b => b.messageId)).size, 2);
});
test("oversize payloads are rejected before entering the async queue", t => {
  const f = fixture(t); f.command("start"); f.channel.message(new Uint8Array(262145));
  assert.equal(f.command("read").code, "CAPTION_LIMIT");
});
test("connection diagnostics distinguish missing transport from ambiguity", t => {
  const f = fixture(t); f.channel.close(); f.pc.channels[0].close();
  assert.equal(f.command("discover").code, "RTC_CONNECTION_NOT_FOUND");
  f.pc.createDataChannel("collections");
  const second = new f.page.RTCPeerConnection(); second.createDataChannel("collections");
  assert.equal(f.command("discover").code, "RTC_CONNECTION_AMBIGUOUS");
});
test("own subscriptions use the captured native create method, not a later instance override", t => {
  const f = fixture(t, { native: false }); f.pc.createDataChannel = () => f.pc.channels[0];
  assert.equal(f.command("start").status, "live");
  assert.equal(f.pc.channels.length, 3); f.command("reset"); assert.equal(f.pc.channels[0].closed, false);
});
test("partial subscription failure closes the first owned channel only", t => {
  const f = fixture(t, { native: false }); f.pc.failLabel = "captions";
  assert.equal(f.command("start").code, "CAPTION_SUBSCRIPTION_FAILED");
  assert.equal(f.pc.channels.find(c => c.label === "captions_v2").closed, true);
  assert.equal(f.pc.channels[0].closed, false);
});
test("unfinished native conversion cannot accumulate across capture sessions", async t => {
  const f = fixture(t); f.command("start"); let release;
  class Delayed extends Blob { arrayBuffer() { return new Promise(r => { release = r; }); } }
  const raw = packet(1, "in-flight only"); f.channel.message(new Delayed([raw])); await new Promise(r => setImmediate(r));
  f.command("reset");
  try { assert.equal(f.command("start").code, "CAPTION_DECODE_BUSY"); }
  finally { release(raw.buffer); await new Promise(r => setImmediate(r)); }
  assert.equal(f.command("start").status, "live"); assert.equal(f.command("read").blocks.length, 0);
});
test("reset cancels an active gzip reader", async t => {
  let started = false, cancelled = 0;
  class StalledInflate {
    constructor() { started = true; this.readable = new ReadableStream({ cancel() { cancelled++; } }); this.writable = new WritableStream(); }
  }
  const f = fixture(t, { label: "captions", inflate: StalledInflate }); f.command("start");
  f.channel.message(gzipSync(packet(1, "synthetic", 1, "d", "captions")));
  for (let i = 0; i < 30 && !started; i++) await new Promise(r => setImmediate(r));
  assert.equal(started, true); f.command("reset"); assert.equal(cancelled, 1);
  await new Promise(r => setImmediate(r)); assert.equal(f.command("start").status, "live");
});
test("compressed bombs and late Blob results cannot escape limits or reset", async t => {
  const f = fixture(t, { label: "captions" }); f.command("start");
  f.channel.message(gzipSync(new Uint8Array(300000))); await f.drain(); assert.equal(f.command("read").code, "CAPTION_LIMIT");
  f.command("start"); let release;
  class Delayed extends Blob { arrayBuffer() { return new Promise(r => { release = r; }); } }
  const raw = packet(1, "late private bytes", 1, "d", "captions");
  f.channel.message(new Delayed([raw])); await new Promise(r => setImmediate(r));
  f.command("reset"); assert.equal(f.command("start").code, "CAPTION_DECODE_BUSY");
  release(raw.buffer); await new Promise(r => setImmediate(r));
  assert.equal(f.command("start").status, "live"); assert.equal(f.command("read").blocks.length, 0);
});
test("positive int64 IDs stay exact beyond JavaScript safe integer", async t => {
  const f = fixture(t); f.command("start");
  f.channel.message(packet(9007199254740992n, "baseline")); await f.drain();
  f.channel.message(packet(9007199254740993n, "distinct next ID")); await f.drain();
  assert.equal(f.command("read").blocks[0].transcript, "distinct next ID");
});
test("positive signed-int64 maximum is accepted without rounding", async t => {
  const f = fixture(t); f.command("start"); const max = (1n << 63n) - 1n;
  f.channel.message(packet(max - 1n, "baseline")); await f.drain();
  f.channel.message(packet(max, "signed maximum")); await f.drain();
  assert.equal(f.command("read").blocks[0].transcript, "signed maximum");
});
for (const id of [0n, 1n << 63n, (1n << 64n) - 1n]) test("ID outside positive signed-int64 is rejected: " + id, async t => {
  const f = fixture(t); f.command("start"); f.channel.message(packet(id, "out of domain")); await f.drain();
  assert.equal(f.command("read").code, "CAPTION_FORMAT_UNKNOWN"); assert.equal(f.command("read").blocks, undefined);
});
for (const options of [{ host: "evil.example" }, { framed: true }]) test("no hook installation outside Meet main frame", t => {
  assert.equal(fixture(t, options).api, undefined);
});
