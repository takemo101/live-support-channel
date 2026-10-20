import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const readSource = async name => readFile(new URL("../extension/" + name, import.meta.url), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
const source = await readSource("hook-core.js") + "\n" + await readSource("teams-hook.js");
const key = "__liveCaptionsRtc_v1", meetingId = "teams.microsoft.com/call";
const encode = (value, prefix = "") => new TextEncoder().encode(prefix + (typeof value === "string" ? value : JSON.stringify(value))).buffer;
const item = (ts, userId, version, text, extra = {}) => ({ id: `msg-${ts}/${version}`, userId, timestampAudioSent: ts, text, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const results = (...items) => ({ recognitionResults: items });

function fixture(t, { host = "teams.microsoft.com", framed = false, protocol = "https:", label = "main-channel", peers = 1 } = {}) {
  const timers = new Map(), pageEvents = new Map(); let now = 100, clockId = 0;
  class Events {
    events = new Map();
    addEventListener(type, fn) { const list = this.events.get(type) ?? []; list.push(fn); this.events.set(type, list); }
    emit(type, event = {}) { for (const fn of this.events.get(type) ?? []) fn(event); }
  }
  class Channel extends Events {
    constructor(name) { super(); this.label = name; this.readyState = "open"; this.sent = []; this.closed = false; }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; this.readyState = "closed"; this.emit("close"); }
    message(data, extra = {}) { this.emit("message", { data, isTrusted: true, timeStamp: now, ...extra }); }
  }
  class Peer extends Events {
    constructor() { super(); this.connectionState = "connected"; this.channels = []; this.created = 0; }
    createDataChannel(name) { this.created++; const c = new Channel(name); this.channels.push(c); return c; }
    close() { this.connectionState = "closed"; this.emit("connectionstatechange"); }
  }
  const page = {
    location: { protocol, hostname: host, pathname: "/v2/" },
    get document() { throw Error("Teams hook must not touch the DOM"); },
    RTCPeerConnection: Peer, TextDecoder, Uint8Array, ArrayBuffer,
    performance: { now: () => now }, Date,
    setTimeout(fn) { const id = ++clockId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { pageEvents.set(type, fn); },
  };
  page.top = framed ? {} : page;
  vm.runInContext(source, vm.createContext({ window: page }));
  const api = page[key];
  const pcs = Array.from({ length: peers }, () => { const pc = new page.RTCPeerConnection(); pc.createDataChannel("collections"); return pc; });
  const pc = pcs[0], channel = pc.createDataChannel(label); pc.created = 0;
  const command = (action, owner = "synthetic-owner", extra = {}) => api?.command({ action, meetingId, captureId: owner, ...extra });
  t.after(() => { api?.command({ action: "reset", captureId: "synthetic-owner" }); });
  return { page, api, pc, pcs, channel, command, pageEvents,
    expire() { now += 2100; for (const fn of [...timers.values()]) fn(); },
    say(...items) { channel.message(encode(results(...items))); } };
}

test("hook installs only in the top frame of the Teams hosts over https", t => {
  for (const host of ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) assert.ok(fixture(t, { host }).api, host);
  for (const options of [{ host: "meet.google.com" }, { host: "evil.example" }, { host: "teams.microsoft.com.evil.example" }, { framed: true }, { protocol: "http:" }])
    assert.equal(fixture(t, options).api, undefined, JSON.stringify(options));
});
test("discover reports one Teams connection without reading any payload or the DOM", t => {
  const f = fixture(t);
  f.channel.emit("message", { isTrusted: true, get data() { assert.fail("idle payload access"); } });
  const meta = f.command("discover");
  assert.equal(meta.code, "READY"); assert.equal(meta.captionReady, true); assert.equal(meta.platform, "Teams");
  assert.deepEqual(plain(meta.meetings.map(m => m.id)), [meetingId]);
});
test("connection diagnostics distinguish missing, ambiguous and unrelated transports", t => {
  assert.equal(fixture(t, { label: "other" }).command("discover").code, "RTC_CONNECTION_NOT_FOUND");
  const two = fixture(t, { peers: 2 }); two.pcs[1].createDataChannel("main-channel");
  assert.equal(two.command("discover").code, "RTC_CONNECTION_AMBIGUOUS"); assert.equal(two.command("start").code, "RTC_CONNECTION_AMBIGUOUS");
});
test("start excludes each speaker's first utterance and its revisions, then upserts later ones", t => {
  const f = fixture(t); assert.equal(f.command("start").status, "live");
  f.say(item(1000, "u1", 1, "history prefix")); f.say(item(1000, "u1", 2, "history prefix revised")); f.say(item(500, "u1", 1, "older history"));
  f.say(item(900, "u2", 1, "other speaker first"));
  assert.equal(f.command("read").blocks.length, 0); assert.equal(f.command("read").diagnostics.baselineExcluded, 4);
  f.say(item(2000, "u1", 1, "first fresh")); f.say(item(2000, "u1", 3, "first fresh, revised")); f.say(item(2000, "u1", 2, "stale revision"));
  f.say(item(1500, "u2", 1, "second speaker fresh"));
  const blocks = f.command("read").blocks;
  assert.deepEqual(plain(blocks.map(b => [b.deviceId, b.transcript, b.messageVersion])), [["speaker-1", "first fresh, revised", 3], ["speaker-2", "second speaker fresh", 1]]);
  assert.ok(blocks.every(b => b.messageId.startsWith("synthetic-owner:")));
  assert.ok(!JSON.stringify(blocks).includes("u1") && !JSON.stringify(blocks).includes("u2"), "opaque user ids stay in the page");
  f.command("reset");
});
test("only filtered text is used and unrelated control traffic is ignored without stopping", t => {
  const f = fixture(t); f.command("start"); f.say(item(1, "u", 1, "boundary"));
  f.channel.message(encode("not json")); f.channel.message(encode({ other: 1 }, "3:::")); f.channel.message(encode([1, 2])); f.channel.message(new ArrayBuffer(0)); f.channel.message("string frame");
  f.channel.message(encode("x".repeat(300000)));
  f.channel.message(encode(results({ id: "x/1", userId: "u", text: "no audio timestamp" })));
  f.channel.message(encode(results(item(5, "u", 1, "filtered", { rawText: "unfiltered words" })), "\u0000\u0002"));
  f.channel.message(encode(results(item(6, "u", 1, "far prefix")), "x".repeat(40)));
  const read = f.command("read"); assert.equal(read.status, "live");
  assert.deepEqual(plain(read.blocks.map(b => b.transcript)), ["filtered"]);
  f.command("reset");
});
test("malformed, conflicting or unordered recognition results fail closed", t => {
  for (const [code, send] of [
    ["CAPTION_FORMAT_UNKNOWN", f => f.say({ id: "nope", userId: "u", timestampAudioSent: 9, text: "x" })],
    ["CAPTION_FORMAT_UNKNOWN", f => f.say(item(9, "", 1, "x"))],
    ["CAPTION_FORMAT_UNKNOWN", f => f.say(item(9, "u", 1, { nested: true }))],
    ["CAPTION_FORMAT_UNKNOWN", f => f.say(item(-1, "u", 1, "x"))],
    ["CAPTION_REVISION_CONFLICT", f => { f.say(item(20, "u", 1, "a")); f.say(item(20, "u", 1, "b")); }],
    ["CAPTION_SEQUENCE_UNKNOWN", f => { f.say(item(30, "u", 1, "a")); f.say(item(40, "u", 1, "b")); f.say(item(35, "u", 1, "unknown older")); }],
  ]) {
    const f = fixture(t); f.command("start"); f.say(item(10, "u", 1, "boundary")); send(f);
    const read = f.command("read"); assert.equal(read.code, code, code); assert.equal(read.blocks, undefined);
    assert.equal(f.command("start", "next").status, "live"); f.command("reset", "next");
  }
});
test("capture limits stop instead of dropping silently", t => {
  const f = fixture(t); f.command("start"); f.say(item(1, "u", 1, "boundary"));
  for (let i = 2; i < 4003; i++) f.channel.message(encode(results(item(i, "u", 1, "s"))));
  assert.equal(f.command("read").code, "CAPTION_LIMIT");
});
test("payloads are never touched while idle, paused, untrusted, early or after expiry", t => {
  const f = fixture(t), bomb = { isTrusted: true, get data() { assert.fail("payload access"); } };
  f.channel.emit("message", bomb);
  f.command("start"); f.channel.emit("message", { isTrusted: false, get data() { assert.fail("untrusted payload access"); } });
  f.channel.emit("message", { isTrusted: true, timeStamp: -1, get data() { assert.fail("pre-start payload access"); } });
  f.command("reset"); f.channel.emit("message", bomb);
  f.command("start"); f.expire(); f.channel.emit("message", bomb);
  assert.equal(f.command("read").code, "CAPTURE_EXPIRED");
});
test("recover continues only the owner's expired capture and re-excludes first utterances", t => {
  const f = fixture(t), recover = (captureId, previousCaptureId, id = meetingId) => f.api.command({ action: "recover", meetingId: id, captureId, previousCaptureId });
  f.command("start", "old"); f.say(item(10, "u", 1, "before")); f.expire();
  assert.equal(f.command("read", "old").code, "CAPTURE_EXPIRED");
  assert.equal(recover("new", "other").code, "CAPTURE_CHANGED"); assert.equal(recover("new", "old", "teams.live.com/call").code, "MEETING_CHANGED");
  assert.equal(recover("new", "old").status, "live"); assert.equal(f.command("read", "old").code, "CAPTURE_CHANGED");
  f.say(item(30, "u", 1, "first after")); assert.equal(f.command("read", "new").blocks.length, 0);
  f.say(item(31, "u", 1, "second after")); assert.equal(f.command("read", "new").blocks[0].transcript, "second after");
  f.command("reset", "new");
  f.command("start", "live"); assert.equal(recover("again", "live").code, "CAPTURE_CHANGED"); f.command("reset", "live");
  f.command("start", "reset"); f.expire(); f.command("reset", "reset"); assert.equal(recover("fresh", "reset").code, "CAPTURE_CHANGED");
});
test("lease expiry, channel close, connection close and page hide each stop with their own code", t => {
  const expired = fixture(t); expired.command("start"); expired.expire(); assert.equal(expired.command("read").code, "CAPTURE_EXPIRED");
  const channel = fixture(t); channel.command("start"); channel.channel.close(); assert.equal(channel.command("read").code, "CAPTION_CHANNEL_CLOSED");
  const connection = fixture(t); connection.command("start"); connection.pc.close(); assert.equal(connection.command("read").code, "RTC_CONNECTION_CLOSED");
  const hidden = fixture(t); hidden.command("start"); hidden.pageEvents.get("pagehide")(); assert.equal(hidden.command("read").code, "MEETING_CHANGED");
});
test("reader only observes: it never creates channels, sends, or replaces a newer capture", t => {
  const f = fixture(t); f.command("start", "one"); assert.equal(f.pc.created, 0); assert.equal(f.channel.sent.length, 0);
  assert.equal(f.command("start", "two").status, "live"); assert.equal(f.command("read", "one").code, "CAPTURE_CHANGED");
  assert.equal(f.command("reset", "one").status, "idle"); assert.equal(f.command("read", "two").status, "live");
  assert.equal(f.pc.created, 0); assert.equal(f.channel.closed, false);
  assert.equal(f.command("start", "x", { meetingId: "teams.live.com/call" }).code, "MEETING_CHANGED");
  f.command("reset", "two");
});
test("channels created before and after the peer connection are both observed", t => {
  const f = fixture(t, { label: "other" }); const late = f.pc.createDataChannel("main-channel");
  f.command("start"); late.message(encode(results(item(1, "u", 1, "boundary")))); late.message(encode(results(item(2, "u", 1, "seen"))));
  assert.equal(f.command("read").blocks[0].transcript, "seen"); f.command("reset");
});
test("the shared core is handed over once and never stays reachable by page scripts", async t => {
  const f = fixture(t);
  assert.equal(f.page.__liveCaptionsHookCore, undefined);
  const lone = { location: { protocol: "https:", hostname: "teams.microsoft.com", pathname: "/v2/" }, RTCPeerConnection: class {}, addEventListener() {} };
  lone.top = lone;
  vm.runInContext((await readFile(new URL("../extension/teams-hook.js", import.meta.url), "utf8")), vm.createContext({ window: lone }));
  assert.equal(lone[key], undefined, "a hook without its core installs nothing");
});
test("diagnostics list observed channel labels (sanitized, bounded) and count frames seen while capturing", t => {
  const f = fixture(t);
  for (const label of ["media-session", "bad label\n<x>", "x".repeat(64)]) f.pc.createDataChannel(label);
  for (let i = 0; i < 30; i++) f.pc.createDataChannel("extra-" + i);
  const meta = f.command("discover"), labels = plain(meta.diagnostics.channelLabels);
  assert.ok(labels.includes("main-channel") && labels.includes("collections") && labels.includes("media-session"));
  assert.ok(labels.every(l => /^[A-Za-z0-9_.-]{1,32}$/.test(l)) && labels.length <= 16);
  f.channel.message(encode("before start")); assert.equal(f.command("discover").diagnostics.frames ?? 0, 0);
  f.command("start"); f.channel.message(encode("unrelated")); f.channel.message(encode({ other: 1 })); f.say(item(1, "u", 1, "boundary"));
  const diagnostics = f.command("read").diagnostics;
  assert.equal(diagnostics.frames, 3); assert.equal(diagnostics.received, 1);
  f.command("reset");
});
