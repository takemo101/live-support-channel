import test from "node:test";
import assert from "node:assert/strict";
import { createPanel } from "../extension/panel.js";
const turn = () => new Promise(resolve => setImmediate(resolve));
class Element extends EventTarget {
  value = ""; disabled = false; textContent = ""; children = [];
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.value = ""; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}
function setup(t, fetcher) {
  const elements = Object.fromEntries(["token", "meeting", "refresh", "start", "pause", "stop", "status", "consent"].map(id => [id, new Element()]));
  elements.token.value = "t".repeat(43); elements.consent.checked = true;
  const block = { messageId: "m", messageVersion: 1, speakerName: "Demo", transcript: "private baseline", timestamp: 100, version: 1 };
  const fixture = { captionReady: true, error: undefined, snapshot: { status: "live", meetingId: "meet.google.com/abc-defg-hij", platform: "Google Meet", blocks: [block] } };
  const calls = [], contexts = [], actions = [], navigation = new Set();
  const timers = new Map();
  const inspectedWindow = { eval(expression, options, done) {
    contexts.push(options);
    const params = JSON.parse(expression.slice(expression.lastIndexOf("})(") + 3, -1));
    actions.push(params);
    if (fixture.error) { done(undefined, fixture.error); return; }
    if (params.action === "read" && fixture.deferRead) { fixture.pendingRead = done; return; }
    if (params.action === "reset") { done({ status: "idle" }); return; }
    if (params.action === "discover") done({ status: "ready", meetings: [{ id: fixture.snapshot.meetingId, title: "Google Meet（標準字幕・試験版）" }], captionReady: fixture.captionReady, code: fixture.discoveryCode ?? (fixture.captionReady ? "READY" : "CAPTIONS_OFF"), diagnostics: fixture.diagnostics ?? { peers: 1, captionChannels: 1, received: 0, accepted: 0, baselineExcluded: 0 } }, {});
    else done(JSON.parse(JSON.stringify(fixture.snapshot)), {});
  } };
  const onNavigated = { addListener(fn) { navigation.add(fn); }, removeListener(fn) { navigation.delete(fn); } };
  const panel = createPanel({
    document: { getElementById: id => elements[id], createElement: () => new Element() }, inspectedWindow, onNavigated,
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : { ok: true, status: 202 }; },
    setInterval: (fn, delay) => { timers.set(delay, fn); return delay; }, clearInterval: id => { timers.delete(id); },
  });
  t.after(() => panel.dispose());
  return { elements, block, fixture, calls, contexts, actions, navigation,
    capture: () => timers.get(1000)?.(), flush: () => timers.get(5000)?.(),
    async poll() { await timers.get(1000)?.(); await timers.get(5000)?.(); },
  };
}
async function start(s) {
  s.elements.refresh.click(); await turn();
  s.elements.meeting.value = s.fixture.snapshot.meetingId;
  s.elements.meeting.dispatchEvent(new Event("change"));
  s.elements.start.click(); await turn();
}
const posts = s => s.calls.filter(c => c.options.method === "POST");
const fresh = (s, id, text) => s.fixture.snapshot.blocks.push({ ...s.block, messageId: id, transcript: text, version: 2 });

test("panel discovers metadata in the normal page world without sending text", async t => {
  const s = setup(t); s.elements.refresh.click(); await turn();
  assert.equal(s.calls.length, 0);
  assert.ok(s.elements.meeting.children.some(c => c.textContent.includes("標準字幕")));
  assert.deepEqual(s.actions.map(a => a.action), ["discover"]);
  assert.ok(s.contexts.every(c => Object.keys(c).length === 0));
});
test("missing early hook explains the required Meet reload", async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = "RTC_HOOK_NOT_READY";
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /RTC_HOOK_NOT_READY/); assert.match(s.elements.status.textContent, /再読み込み/);
  assert.equal(posts(s).length, 0);
});
for (const code of ["CAPTION_DECODE_BUSY", "CAPTION_ACK_BACKLOG_LIMIT"]) test("RTC resource error has an actionable message: " + code, async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = code;
  s.elements.refresh.click(); await turn();
  assert.ok(s.elements.status.textContent.includes(code)); assert.ok(!s.elements.status.textContent.includes("READ_FAILED"));
  assert.equal(posts(s).length, 0);
});
test("RTC diagnostics show whitelisted counters, never arbitrary details", async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = "CAPTION_FORMAT_UNKNOWN";
  s.fixture.diagnostics = { peers: 1, received: "PRIVATE_RAW", accepted: 2, payload: "PRIVATE_BYTES" };
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /CAPTION_FORMAT_UNKNOWN/); assert.match(s.elements.status.textContent, /採用=2/);
  assert.ok(!s.elements.status.textContent.includes("PRIVATE"));
});
test("active status distinguishes received packets from excluded initial IDs", async t => {
  const s = setup(t); await start(s); s.fixture.snapshot.diagnostics = { received: 7, baselineExcluded: 6, accepted: 1 };
  fresh(s, "fresh", "new caption"); await s.poll();
  assert.match(s.elements.status.textContent, /受信=7/); assert.match(s.elements.status.textContent, /初回ID除外=6/);
});
test("start baselines history; polls send only fresh native captions", async t => {
  const s = setup(t); await start(s);
  assert.equal(s.calls.length, 1); assert.ok(s.calls[0].url.endsWith("/health"));
  s.block.transcript += " revised"; await s.poll(); assert.equal(posts(s).length, 0);
  fresh(s, "fresh", "new caption"); await s.poll();
  assert.equal(posts(s).length, 1);
  const call = posts(s)[0];
  assert.equal(call.options.headers.authorization, "Bearer " + "t".repeat(43));
  assert.equal(call.options.redirect, "error");
  assert.equal(JSON.parse(call.options.body).updates[0].transcript, "new caption");
  assert.ok(!call.options.body.includes("private baseline"));
});
test("captures short-lived rows before the five-second send tick", async t => {
  const s = setup(t); await start(s);
  fresh(s, "short", "short-lived caption"); await s.capture();
  s.fixture.snapshot.blocks.pop();
  fresh(s, "later", "later caption"); await s.capture();
  assert.equal(posts(s).length, 0);
  await s.flush();
  assert.deepEqual(JSON.parse(posts(s)[0].options.body).updates.map(b => b.transcript), ["short-lived caption", "later caption"]);
});
test("capture continues while a caption POST is awaiting acknowledgment", async t => {
  let resolve;
  const s = setup(t, (url) => url.endsWith("/health") ? { ok: true, status: 200 } : new Promise(r => { resolve = r; }));
  await start(s);
  fresh(s, "first", "first caption"); await s.capture();
  const pending = s.flush(); await turn();
  const reads = s.actions.filter(a => a.action === "read").length;
  fresh(s, "second", "second caption"); await s.capture();
  assert.ok(s.actions.filter(a => a.action === "read").length > reads);
  assert.equal(posts(s).length, 1);
  resolve({ ok: true, status: 202 }); await pending;
});
for (const stop of [false, true]) {
  test("late caption evaluation cannot enter a restarted stream: stop=" + stop, async t => {
    const s = setup(t); await start(s);
    s.fixture.deferRead = true;
    const pending = s.capture();
    const finish = s.fixture.pendingRead;
    s.elements[stop ? "stop" : "pause"].click(); await turn();
    s.fixture.deferRead = false;
    if (stop) s.elements.start.click(); else s.elements.pause.click();
    await turn();
    finish({ ...s.fixture.snapshot, blocks: [{ ...s.block, messageId: "late", transcript: "private late result" }] }, {});
    await pending;
    fresh(s, "after", "after restart"); await s.poll();
    assert.equal(posts(s).length, 1);
    assert.deepEqual(JSON.parse(posts(s)[0].options.body).updates.map(b => b.transcript), ["after restart"]);
  });
}
test("pause and resume during an unacknowledged POST start a clean series", async t => {
  let resolve, first = true;
  const s = setup(t, url => {
    if (url.endsWith("/health") || !first) return { ok: true, status: 202 };
    first = false; return new Promise(r => { resolve = r; });
  });
  await start(s); fresh(s, "before", "in flight before pause"); await s.capture();
  const pending = s.flush(); await turn();
  const oldSession = JSON.parse(posts(s)[0].options.body).sessionId;
  s.elements.pause.click(); fresh(s, "private", "private paused speech");
  s.elements.pause.click(); await turn();
  resolve({ ok: true, status: 202 }); await pending;
  fresh(s, "after", "new after resume"); await s.poll();
  assert.equal(posts(s).length, 2);
  const payload = JSON.parse(posts(s)[1].options.body);
  assert.notEqual(payload.sessionId, oldSession); assert.equal(payload.sequence, 1);
  assert.deepEqual(payload.updates.map(b => b.transcript), ["new after resume"]);
});
test("pause reads nothing; resume rebaselines paused speech and its later revisions", async t => {
  const s = setup(t); await start(s);
  fresh(s, "discard", "unsent before pause"); await s.capture(); s.fixture.snapshot.blocks.pop();
  s.elements.pause.click(); await turn();
  assert.match(s.elements.pause.textContent, /再開/);
  const before = s.actions.length;
  fresh(s, "paused", "private pause"); await s.poll();
  assert.equal(s.actions.length, before); assert.equal(posts(s).length, 0);
  s.elements.pause.click(); await turn();
  s.fixture.snapshot.blocks[1].transcript += " revised"; await s.poll();
  assert.equal(posts(s).length, 0);
  fresh(s, "after", "after resume"); await s.poll();
  assert.equal(posts(s).length, 1); assert.ok(!posts(s)[0].options.body.includes("private pause"));
  assert.ok(!posts(s)[0].options.body.includes("unsent before pause"));
});
for (const [count, text] of [[4000, "small"], [70, "x".repeat(30000)]]) {
  test("capture buffer stops at its bounded limit: " + count, async t => {
    const s = setup(t); await start(s);
    for (let i = 0; i < count; i++) fresh(s, "limit-" + i, text);
    await s.capture();
    assert.match(s.elements.status.textContent, /CAPTURE_BUFFER_LIMIT/);
    assert.equal(s.elements.stop.disabled, true);
    assert.equal(posts(s).length, 0);
  });
}
test("caption loss and navigation stop capture and require confirmation", async t => {
  const s = setup(t); await start(s);
  s.fixture.snapshot = { status: "unavailable", code: "CAPTIONS_OFF" }; await s.poll();
  assert.equal(s.elements.pause.disabled, true); assert.equal(s.elements.start.disabled, true);
  assert.match(s.elements.status.textContent, /CAPTIONS_OFF/);
  assert.equal(posts(s).length, 0);
  for (const navigate of s.navigation) navigate();
  assert.equal(s.elements.meeting.children.length, 0);
});
test("captions-off discovery gives an actionable code and disables start", async t => {
  const s = setup(t); s.fixture.captionReady = false;
  s.elements.refresh.click(); await turn();
  s.elements.meeting.value = s.fixture.snapshot.meetingId; s.elements.meeting.dispatchEvent(new Event("change"));
  assert.equal(s.elements.start.disabled, true);
  assert.match(s.elements.status.textContent, /CAPTIONS_OFF/);
  assert.ok(!s.elements.status.textContent.includes(s.block.transcript));
});
test("Chrome permission denial is distinguished without echoing arbitrary error details", async t => {
  const s = setup(t); s.fixture.error = { isError: true, code: "E_FAILED", details: ["PRIVATE_ERROR_TOKEN"] };
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /PAGE_ACCESS_DENIED/);
  assert.ok(!s.elements.status.textContent.includes("PRIVATE_ERROR_TOKEN"));
});
test("stop during connection cannot be undone by a late response", async t => {
  let resolve;
  const s = setup(t, () => new Promise(r => { resolve = r; }));
  await start(s); assert.equal(s.elements.pause.disabled, true);
  s.elements.stop.click(); resolve({ ok: true, status: 200 }); await turn();
  assert.equal(s.calls.length, 1); assert.equal(s.elements.start.disabled, false);
  assert.ok(!s.actions.some(a => a.action === "start"));
});
test("stop during resume cannot be undone by late health response", async t => {
  let count = 0, resolve;
  const s = setup(t, () => ++count === 1 ? { ok: true, status: 200 } : new Promise(r => { resolve = r; }));
  await start(s); s.elements.pause.click(); await turn();
  s.elements.pause.click(); await turn();
  s.elements.stop.click(); resolve({ ok: true, status: 200 }); await turn();
  fresh(s, "after", "must not send"); await s.poll();
  assert.equal(posts(s).length, 0); assert.equal(s.elements.pause.disabled, true);
});
test("resume with a changed meeting stops instead of starting a dead timer", async t => {
  const s = setup(t); await start(s);
  s.elements.pause.click(); await turn();
  s.fixture.snapshot.meetingId = "meet.google.com/xxx-yyyy-zzz";
  s.elements.pause.click(); await turn();
  assert.equal(s.elements.pause.disabled, true);
  assert.equal(s.elements.stop.disabled, true);
  assert.match(s.elements.status.textContent, /MEETING_CHANGED/);
  assert.equal(posts(s).length, 0);
});
test("authorization failure stops instead of retrying forever", async t => {
  const s = setup(t, () => ({ ok: false, status: 401 })); await start(s);
  assert.match(s.elements.status.textContent, /401/);
  assert.equal(s.elements.start.disabled, false);
  assert.ok(!s.elements.status.textContent.includes("t".repeat(43)));
});
