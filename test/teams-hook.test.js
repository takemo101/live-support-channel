import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const readSource = async name => readFile(new URL("../extension/" + name, import.meta.url), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
const source = await readSource("hook-core.js") + "\n" + await readSource("teams-hook.js");
const key = "__liveCaptionsRtc_v1", meetingId = "teams.microsoft.com/call";
const plain = value => JSON.parse(JSON.stringify(value));

// A stand-in for the app's active call: the participant list and the remote-event handler the calling code owns.
function makeCall({ handler = true } = {}) {
  const on = { name: "remoteUserEventsReceived", received: [], handler(type, payload) { on.received.push([type, payload]); } };
  const call = { on, participants: [{ mri: "u-alice", displayName: "Alice Example" }, { mri: "u-bob", displayName: "Bob\u202E Example\u0000" }],
    currentUserSkypeIdentity: { mri: "u-me", displayName: "Me Example" }, dataChannel: { subscriptions: [{ eventHandler: { on: { name: "other" } } }, ...(handler ? [{ eventHandler: { on } }] : [])] } };
  return call;
}
const item = (ts, user, version, text, extra = {}) => ({ id: `m${ts}/${version}`, userId: user, timestampAudioSent: ts, text, ...extra });
const results = (...items) => JSON.stringify({ recognitionResults: items });

function fixture({ host = "teams.microsoft.com", framed = false, protocol = "https:", call = makeCall(), api = true } = {}) {
  let now = 100, clock = 0; const timers = new Map(), state = { call };
  const page = {
    location: { protocol, hostname: host, pathname: "/v2/" },
    performance: { now: () => now }, Date, setTimeout: (fn, delay) => { timers.set(++clock, { fn, delay }); return clock; }, clearTimeout: id => timers.delete(id), addEventListener() {},
    get RTCPeerConnection() { throw Error("the Teams reader never touches RTC"); },
    get document() { throw Error("the Teams reader never reads the DOM"); },
    ...(api ? { msteamscalling: { deref: () => ({ callingService: { getActiveCall: () => state.call } }) } } : {}),
  };
  page.top = framed ? {} : page;
  vm.runInContext(source, vm.createContext({ window: page }));
  const command = (action, extra = {}, owner = "owner") => page[key]?.command({ action, meetingId, captureId: owner, ...extra });
  const emit = (type, payload) => call.on.handler(type, payload);
  return { api: page[key], call, state, command, emit, timers, say: (...items) => emit("3", results(...items)),
    expire() { now += 2100; for (const timer of [...timers.values()]) timer.fn(); },
    blocks: owner => plain(command("read", {}, owner).blocks ?? []) };
}

test("hook installs only in the top frame of the Teams hosts over https", () => {
  for (const host of ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) assert.ok(fixture({ host }).api, host);
  for (const options of [{ host: "microsoft.com" }, { host: "teams.microsoft.com.evil.example" }, { host: "app.zoom.us" }, { framed: true }, { protocol: "http:" }])
    assert.equal(fixture(options).api, undefined, JSON.stringify(options));
});
test("discover finds the call's handler without patching it, reading captions, the DOM or RTC", () => {
  const f = fixture(), original = f.call.on.handler; const meta = f.command("discover");
  assert.equal(meta.code, "READY"); assert.equal(meta.platform, "Teams"); assert.equal(meta.captionReady, true);
  assert.equal(plain(meta.meetings.map(m => m.id))[0], meetingId); assert.equal(f.call.on.handler, original, "nothing is patched while idle");
  f.say(item(1, "u-alice", 1, "idle text")); assert.equal(f.call.on.received.length, 1, "idle traffic reaches the app untouched");
  assert.equal(fixture({ call: null }).command("discover").code, "TEAMS_CALL_NOT_FOUND");
  assert.equal(fixture({ api: false }).command("discover").code, "TEAMS_CALL_NOT_FOUND");
  assert.equal(fixture({ call: { dataChannel: { subscriptions: [] } } }).command("discover").code, "TEAMS_CALL_NOT_FOUND");
});
test("a missing call or a changed meeting refuses to start", () => {
  assert.equal(fixture({ call: null }).command("start").code, "TEAMS_CALL_NOT_FOUND");
  assert.equal(fixture().command("start", { meetingId: "teams.microsoft.com/other" }).code, "MEETING_CHANGED");
});
test("start wraps the handler, always calls the original, and reset restores it", () => {
  const f = fixture(), original = f.call.on.handler;
  assert.equal(f.command("start").status, "live"); assert.notEqual(f.call.on.handler, original);
  f.say(item(1, "u-alice", 1, "first")); f.emit("3", "not json"); f.emit("9", results(item(5, "u-alice", 1, "other type"))); f.emit("3", { recognitionResults: "oops" });
  assert.equal(f.call.on.received.length, 4, "every event still reaches the original handler");
  f.command("reset"); assert.equal(f.call.on.handler, original, "the original handler is restored");
  f.say(item(2, "u-alice", 1, "after")); assert.equal(f.call.on.received.length, 5);
});
test("a handler wrapped on top by someone else stays intact and our wrapper goes passive", () => {
  const f = fixture(); f.command("start");
  const ours = f.call.on.handler, outer = function (...args) { return ours.apply(this, args); }; f.call.on.handler = outer;
  f.command("reset"); assert.equal(f.call.on.handler, outer);
  f.say(item(1, "u-alice", 1, "history")); f.say(item(2, "u-alice", 1, "later")); assert.equal(f.call.on.received.length, 2, "events still flow, unprocessed");
});
test("each speaker's first utterance is history; later utterances and their revisions are upserted with the participant's name", () => {
  const f = fixture(); f.command("start");
  f.say(item(100, "u-alice", 1, "history")); f.say(item(100, "u-alice", 2, "history revised"));
  assert.deepEqual(f.blocks(), []);
  f.say(item(101, "u-alice", 1, "hello")); f.say(item(101, "u-alice", 2, "hello there"));
  f.say(item(5, "u-bob", 1, "bob history")); f.say(item(6, "u-bob", 1, "bob first"), item(7, "u-me", 1, "mine")); f.say(item(8, "u-me", 1, "mine later"), item(9, "u-x", 1, "x history"), item(10, "u-x", 1, "stranger"));
  const blocks = f.blocks();
  assert.deepEqual(blocks.map(b => [b.deviceId, b.speakerName, b.transcript, b.messageVersion]), [
    ["speaker-1", "Alice Example", "hello there", 2], ["speaker-2", "Bob Example", "bob first", 1], ["speaker-3", "Me Example", "mine later", 1], ["speaker-4", "話者 4（名前未確認）", "stranger", 1]]);
  assert.ok(!JSON.stringify(blocks).includes("u-alice") && !/[\p{Cc}\u202e]/u.test(blocks[1].speakerName), "ids stay in the page; names are sanitised");
});
test("timestamps may be large integers or numeric strings; unusable items are dropped, not fatal", () => {
  const f = fixture(); f.command("start");
  f.say(item(6.4e17, "u-alice", 1, "history")); f.say(item("640000000000000500", "u-alice", 1, "string stamp"), item(6.4e17 + 4096, "u-alice", 1, "unsafe integer stamp"));
  f.say({ timestampAudioSent: 1, text: "no user" }, { timestampAudioSent: "x1", userId: "u-alice", text: "bad stamp" }, { id: "no-stamp", userId: "u-alice", text: "ignored" });
  assert.deepEqual(f.blocks().map(b => b.transcript), ["string stamp", "unsafe integer stamp"]);
  assert.equal(f.command("read").diagnostics.dropped, 2); assert.equal(f.command("read").status, "live");
});
test("unusable items never stop the capture, however many arrive before the first caption", () => {
  const f = fixture(); f.command("start");
  for (let i = 0; i < 300; i++) f.say({ timestampAudioSent: i, text: "x" });
  assert.equal(f.command("read").status, "live"); assert.equal(f.command("read").diagnostics.dropped, 300);
  f.say(item(1, "u-alice", 1, "history")); f.say(item(2, "u-alice", 1, "the first real caption"));
  assert.deepEqual(f.blocks().map(b => b.transcript), ["the first real caption"]); assert.equal(f.call.on.received.length, 302, "the page never saw an error");
});
test("the call ending stops the capture; an abandoned lease expires and recover continues without replaying history", () => {
  const f = fixture(); f.command("start"); f.say(item(1, "u-alice", 1, "history")); f.say(item(2, "u-alice", 1, "kept"));
  f.state.call = null; assert.equal(f.command("read").code, "TEAMS_CALL_ENDED"); f.state.call = f.call;
  const g = fixture(); g.command("start"); g.say(item(1, "u-alice", 1, "history")); g.say(item(2, "u-alice", 1, "kept"));
  g.expire(); assert.equal(g.command("read").code, "CAPTURE_EXPIRED");
  assert.equal(g.command("recover", { previousCaptureId: "owner" }, "next").status, "live");
  g.say(item(2, "u-alice", 2, "kept revised")); g.say(item(3, "u-alice", 1, "first after recovery"));
  assert.deepEqual(g.blocks("next").map(b => b.transcript), ["first after recovery"], "a speaker's first utterance after recovery is history again");
});
test("without the call's handler (captions not running) the capture is refused and nothing is started", () => {
  const f = fixture({ call: makeCall({ handler: false }) });
  assert.equal(f.command("discover").code, "TEAMS_CALL_NOT_FOUND"); assert.equal(f.command("start").code, "TEAMS_CALL_NOT_FOUND");
});
