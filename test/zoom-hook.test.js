import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const readSource = async name => readFile(new URL("../extension/" + name, import.meta.url), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
const source = await readSource("hook-core.js") + "\n" + await readSource("zoom-hook.js");
const key = "__liveCaptionsRtc_v1", meetingId = "app.zoom.us/wc/12345678";
const plain = value => JSON.parse(JSON.stringify(value));

// A stand-in for the app's Redux store. Messages are replaced immutably, like a reducer would.
function makeStore(messages = {}) {
  const store = { listeners: new Set(), subscribed: 0, state: { newLiveTranscription: { newLTMessage: messages } },
    getState: () => store.state, dispatch() {},
    subscribe(fn) { store.subscribed++; store.listeners.add(fn); return () => store.listeners.delete(fn); },
    set(next) { store.state = { newLiveTranscription: { newLTMessage: next } }; for (const fn of [...store.listeners]) fn(); } };
  return store;
}
const message = (id, zoomID, name, text, extra = {}) => ({ msgId: id, user: { zoomID, displayName: name }, text, language: "en", ...extra });
const byId = (...items) => Object.fromEntries(items.map(item => [item.msgId, item]));

function fixture({ host = "app.zoom.us", pathname = "/wc/12345678/join", framed = false, protocol = "https:", store = makeStore(), inFrame = true } = {}) {
  let now = 100, clock = 0; const timers = new Map();
  const element = { "__reactContainer$test": { memoizedProps: {}, child: { memoizedProps: { other: 1 }, sibling: { memoizedProps: { store } } } } };
  const body = { querySelectorAll: () => [element] };
  const page = {
    location: { protocol, hostname: host, pathname },
    document: { body: inFrame ? null : body, querySelector(selector) { return inFrame && selector === "#webclient" ? { contentDocument: { body } } : null; } },
    performance: { now: () => now }, Date, setTimeout: fn => { timers.set(++clock, fn); return clock; }, clearTimeout: id => timers.delete(id), addEventListener() {},
  };
  page.top = framed ? {} : page;
  vm.runInContext(source, vm.createContext({ window: page }));
  const command = (action, extra = {}, owner = "owner") => page[key]?.command({ action, meetingId, captureId: owner, ...extra });
  return { api: page[key], store, command, expire() { now += 2100; for (const fn of [...timers.values()]) fn(); },
    blocks: () => plain(command("read").blocks ?? []) };
}

test("hook installs only in the top frame of the Zoom web client over https", () => {
  assert.ok(fixture().api);
  for (const options of [{ host: "zoom.us" }, { host: "us02web.zoom.us" }, { host: "app.zoom.us.evil.example" }, { host: "meet.google.com" }, { framed: true }, { protocol: "http:" }])
    assert.equal(fixture(options).api, undefined, JSON.stringify(options));
});
test("discover finds the store without subscribing or reading captions, in the iframe or the top document", () => {
  for (const inFrame of [true, false]) {
    const f = fixture({ store: makeStore(byId(message("m1", 1, "Alice", "secret"))), inFrame }); const meta = f.command("discover");
    assert.equal(meta.code, "READY"); assert.equal(meta.platform, "Zoom"); assert.equal(meta.captionReady, true);
    assert.equal(plain(meta.meetings.map(m => m.id))[0], meetingId); assert.equal(f.store.subscribed, 0);
  }
  const bare = fixture({ store: { getState: () => ({}), subscribe() {}, dispatch() {} } });
  assert.equal(bare.command("discover").code, "ZOOM_STORE_NOT_FOUND");
  assert.equal(fixture({ pathname: "/" }).command("discover").code, "NOT_MEETING_PAGE");
  assert.equal(fixture({ pathname: "/wc/abc/join" }).command("discover").code, "NOT_MEETING_PAGE");
});
test("a missing store or a changed meeting refuses to start", () => {
  assert.equal(fixture({ store: { getState: () => ({}), subscribe() {}, dispatch() {} } }).command("start").code, "ZOOM_STORE_NOT_FOUND");
  assert.equal(fixture().command("start", { meetingId: "app.zoom.us/wc/999999" }).code, "MEETING_CHANGED");
});
test("captions present at start are never sent; new and revised messages are upserted under one id", () => {
  const f = fixture({ store: makeStore(byId(message("old", 1, "Alice Example", "history before start"))) });
  assert.equal(f.command("start").status, "live");
  f.store.set(byId(message("old", 1, "Alice Example", "history before start and its growth")));
  assert.deepEqual(f.blocks(), [], "baseline and its later growth stay private");
  f.store.set({ ...f.store.state.newLiveTranscription.newLTMessage, n1: message("n1", 2, "Bob Example", "hello") });
  f.store.set({ ...f.store.state.newLiveTranscription.newLTMessage, n1: message("n1", 2, "Bob Example", "hello world") });
  const [block] = f.blocks(); assert.equal(block.transcript, "hello world"); assert.equal(block.messageVersion, 2); assert.equal(block.speakerName, "Bob Example");
  assert.equal(f.blocks().length, 1);
  f.command("reset"); assert.equal(f.store.listeners.size, 0, "the subscription is removed on reset");
});
test("speakers are numbered by first sight and named from the message; a hostile name is sanitised", () => {
  const f = fixture(); f.command("start");
  f.store.set(byId(message("a", 7, "Carol Example", "one"), message("b", 8, "Eve\u202Edanger\u0000 " + "x".repeat(100), "two"), message("c", 7, "Carol Example", "three")));
  const blocks = f.blocks();
  assert.deepEqual(blocks.map(b => [b.deviceId, b.transcript]), [["speaker-1", "one"], ["speaker-2", "two"], ["speaker-1", "three"]]);
  assert.equal(blocks[0].speakerName, "Carol Example");
  assert.ok(blocks[1].speakerName.length <= 64 && !/[\p{Cc}\u202e]/u.test(blocks[1].speakerName) && blocks[1].speakerName.startsWith("Eve danger"));
  assert.ok(!JSON.stringify(blocks).includes("zoomID") && !blocks.some(b => [7, 8].includes(b.deviceId)), "internal ids stay in the page");
});
test("zoom text artefacts are removed and empty text is ignored", () => {
  const f = fixture(); f.command("start");
  f.store.set(byId(message("a", 1, "A", "\fhello\u0000 wor\ufffdld"), message("b", 1, "A", "   "), message("c", 1, "A", "x".repeat(40000))));
  assert.deepEqual(f.blocks().map(b => b.transcript), ["hello world"]);
  assert.equal(f.command("read").diagnostics.dropped, 1, "an oversized message is dropped, not forwarded");
});
test("unusable items are counted and never stop the capture, however many arrive before the first caption", () => {
  const f = fixture(); f.command("start");
  const junk = {}; for (let i = 0; i < 300; i++) junk["j" + i] = { msgId: "j" + i, text: "no user" };
  f.store.set(junk);
  assert.equal(f.command("read").status, "live"); assert.equal(f.command("read").diagnostics.dropped, 300);
  f.store.set({ ...f.store.state.newLiveTranscription.newLTMessage, a: message("a", 1, "A", "the first real caption") });
  assert.deepEqual(f.blocks().map(b => b.transcript), ["the first real caption"]);
});
test("a reader error never reaches the page's store subscribers path and stops the capture", () => {
  const f = fixture(); f.command("start");
  const hostile = {}; for (let i = 0; i < 5000; i++) hostile["m" + i] = message("m" + i, i, "N" + i, "t");
  assert.doesNotThrow(() => f.store.set(hostile));
  assert.equal(f.command("read").code, "CAPTION_LIMIT");
});
test("an abandoned lease expires and recover continues the same meeting excluding what is on screen again", () => {
  const f = fixture(); f.command("start");
  f.store.set(byId(message("a", 1, "A", "before expiry"))); assert.equal(f.blocks().length, 1);
  f.expire(); assert.equal(f.command("read").code, "CAPTURE_EXPIRED");
  assert.equal(f.command("recover", { previousCaptureId: "owner" }, "next").status, "live");
  f.store.set({ ...f.store.state.newLiveTranscription.newLTMessage, b: message("b", 1, "A", "after recovery") });
  assert.deepEqual(plain(f.command("read", {}, "next").blocks).map(b => b.transcript), ["after recovery"]);
});
