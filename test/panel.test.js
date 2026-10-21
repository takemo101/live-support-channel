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
function setup(t, fetcher, storage, screenshot) {
  const elements = Object.fromEntries(["token", "meeting", "refresh", "start", "pause", "stop", "status", "consent", "state", "setup", "assist", "batch", "shots"].map(id => [id, new Element()]));
  elements.batch.value = "pause"; elements.shots.checked = true; elements.token.value = "t".repeat(43); elements.consent.checked = true;
  const block = { messageId: "m", messageVersion: 1, speakerName: "Demo", transcript: "private baseline", timestamp: 100, version: 1 };
  const fixture = { captionReady: true, error: undefined, snapshot: { status: "live", meetingId: "meet.google.com/abc-defg-hij", platform: "Google Meet", blocks: [block] } };
  const calls = [], contexts = [], actions = [], navigation = new Set();
  const timers = new Map(), clock = { t: 0 };
  const inspectedWindow = { eval(expression, options, done) {
    contexts.push(options);
    const params = JSON.parse(expression.slice(expression.lastIndexOf("})(") + 3, -1));
    actions.push(params);
    if (fixture.error) { done(undefined, fixture.error); return; }
    if (fixture.respond) { const result = fixture.respond(params, done); if (result) { done(result, {}); return; } if (result === null) return; }
    if (params.action === "read" && fixture.deferRead) { fixture.pendingRead = done; return; }
    if (params.action === "reset") { done({ status: "idle" }); return; }
    if (params.action === "discover") done({ status: "ready", ...(fixture.platform ? { platform: fixture.platform } : {}), meetings: [{ id: fixture.snapshot.meetingId, title: "Google Meet（標準字幕・試験版）" }], captionReady: fixture.captionReady, code: fixture.discoveryCode ?? (fixture.captionReady ? "READY" : "CAPTIONS_OFF"), diagnostics: fixture.diagnostics ?? { peers: 1, captionChannels: 1, received: 0, accepted: 0, baselineExcluded: 0 } }, {});
    else done(JSON.parse(JSON.stringify(fixture.snapshot)), {});
  } };
  const onNavigated = { addListener(fn) { navigation.add(fn); }, removeListener(fn) { navigation.delete(fn); } };
  const panel = createPanel({
    document: { getElementById: id => elements[id], createElement: () => new Element() }, inspectedWindow, onNavigated,
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : { ok: true, status: 202 }; },
    setInterval: (fn, delay) => { timers.set(delay, fn); return delay; }, clearInterval: id => { timers.delete(id); }, storage, screenshot, now: () => clock.t,
  });
  t.after(() => panel.dispose());
  return { elements, block, fixture, calls, contexts, actions, navigation, clock,
    capture: () => timers.get(500)?.(), tick: async ms => { clock.t += ms; await timers.get(250)?.(); }, flush: async () => { clock.t += 5000; await timers.get(250)?.(); },
    // One read, then enough quiet time for the default batching to be due, then the send decision.
    async poll() { await timers.get(500)?.(); clock.t += 5000; await timers.get(250)?.(); },
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
const expired = { status: "ended", code: "CAPTURE_EXPIRED" };
const recovers = s => s.actions.filter(a => a.action === "recover");
const resetting = (s, id) => s.actions.some(a => a.action === "reset" && a.captureId === id);
test("lease expiry recovers the same meeting automatically and continues one series", async t => {
  const s = setup(t); await start(s);
  const first = s.actions.find(a => a.action === "start").captureId;
  fresh(s, "before", "sent before expiry"); await s.poll();
  let lapsed = true;
  s.fixture.respond = p => {
    if (p.action === "read" && lapsed) { lapsed = false; return expired; }
    if (p.action === "recover") return { ...s.fixture.snapshot, blocks: [] };
  };
  await s.capture();
  assert.equal(s.elements.stop.disabled, false); assert.equal(s.elements.pause.disabled, false);
  assert.doesNotMatch(s.elements.status.textContent, /停止/);
  const [recovery] = recovers(s); assert.equal(recovers(s).length, 1);
  assert.notEqual(recovery.captureId, first); assert.equal(recovery.previousCaptureId, first);
  assert.equal(recovery.meetingId, s.fixture.snapshot.meetingId);
  s.fixture.snapshot.blocks = [{ ...s.block, messageId: recovery.captureId + ":1", transcript: "after recovery", version: 2 }];
  await s.poll();
  assert.equal(s.actions.at(-1).captureId, recovery.captureId);
  assert.equal(posts(s).length, 2);
  const [one, two] = posts(s).map(c => JSON.parse(c.options.body));
  assert.equal(two.sessionId, one.sessionId); assert.equal(two.sequence, 2);
  assert.deepEqual(two.updates.map(b => b.transcript), ["after recovery"]);
});
test("recovery keeps an unacknowledged batch for exact retry", async t => {
  let fail = true;
  const s = setup(t, (url, options) => options.method === "POST" && fail ? ({ ok: false, status: 503 }) : { ok: true, status: 202 });
  await start(s); fresh(s, "before", "unacknowledged"); await s.poll();
  assert.equal(posts(s).length, 1);
  let lapsed = true;
  s.fixture.respond = p => {
    if (p.action === "read" && lapsed) { lapsed = false; return expired; }
    if (p.action === "recover") return { ...s.fixture.snapshot, blocks: [] };
  };
  await s.capture(); fail = false; await s.poll();
  assert.equal(posts(s).length, 2); assert.equal(posts(s)[1].options.body, posts(s)[0].options.body);
});
test("a refused recovery stops once instead of looping", async t => {
  const s = setup(t); await start(s);
  s.fixture.respond = p => p.action === "read" ? expired : p.action === "recover" ? { status: "ended", code: "CAPTURE_CHANGED" } : undefined;
  await s.capture(); await s.capture();
  assert.equal(recovers(s).length, 1); assert.equal(s.elements.stop.disabled, true);
  assert.match(s.elements.status.textContent, /CAPTURE_CHANGED/);
});
test("only lease expiry is recoverable", async t => {
  const s = setup(t); await start(s);
  s.fixture.snapshot = { status: "unavailable", code: "CAPTIONS_OFF" }; await s.poll();
  assert.equal(recovers(s).length, 0); assert.equal(s.elements.stop.disabled, true);
});
test("decoder drain delays recovery without a manual restart or status overwrite", async t => {
  const s = setup(t); await start(s);
  let busy = 2;
  s.fixture.respond = p => {
    if (p.action === "read") return expired;
    if (p.action === "recover") return busy-- > 0 ? { status: "unavailable", code: "CAPTION_DECODE_BUSY" } : { ...s.fixture.snapshot, blocks: [] };
  };
  await s.capture(); assert.equal(s.elements.stop.disabled, false);
  const note = s.elements.status.textContent; await s.flush(); assert.equal(s.elements.status.textContent, note);
  assert.equal(posts(s).length, 0);
  await s.capture(); await s.capture();
  const ids = new Set(recovers(s).map(a => a.captureId)), previous = new Set(recovers(s).map(a => a.previousCaptureId));
  assert.equal(recovers(s).length, 3); assert.equal(ids.size, 1); assert.equal(previous.size, 1);
  assert.equal(s.elements.stop.disabled, false); assert.doesNotMatch(s.elements.status.textContent, /停止/);
  assert.equal(s.actions.filter(a => a.action === "read").length, 1);
});
test("a decoder that never drains eventually stops with its reason", async t => {
  const s = setup(t); await start(s);
  s.fixture.respond = p => p.action === "read" ? expired : p.action === "recover" ? { status: "unavailable", code: "CAPTION_DECODE_BUSY" } : undefined;
  for (let i = 0; i < 40 && !s.elements.stop.disabled; i++) await s.capture();
  assert.equal(s.elements.stop.disabled, true); assert.match(s.elements.status.textContent, /CAPTION_DECODE_BUSY/);
});
for (const interrupt of ["stop", "pause"]) {
  test(`${interrupt} during recovery cannot be undone by the late response`, async t => {
    const s = setup(t); await start(s);
    let late;
    s.fixture.respond = (p, done) => {
      if (p.action === "read") return expired;
      if (p.action === "recover") { late = done; return null; }
    };
    const pending = s.capture(); await turn();
    const owner = recovers(s)[0].captureId;
    s.elements[interrupt].click();
    late({ ...s.fixture.snapshot, blocks: [] }, {}); await pending; await turn();
    assert.ok(resetting(s, owner), "the not-yet-adopted capture must be released");
    const count = s.actions.length; await s.poll(); assert.equal(s.actions.length, count);
    if (interrupt === "stop") assert.equal(s.elements.stop.disabled, true);
    else assert.match(s.elements.pause.textContent, /再開/);
    assert.equal(posts(s).length, 0);
  });
}

test("a single detected meeting is selected without a manual step", async t => {
  const s = setup(t); s.elements.refresh.click(); await turn();
  assert.equal(s.elements.meeting.value, s.fixture.snapshot.meetingId);
  s.elements.consent.dispatchEvent(new Event("change")); assert.equal(s.elements.start.disabled, false);
});
test("state badge and visible controls follow the capture phases", async t => {
  const s = setup(t); const view = () => [s.elements.state.textContent, s.elements.start.hidden, s.elements.pause.hidden, s.elements.stop.hidden, s.elements.setup.hidden];
  assert.deepEqual(view(), ["未準備", false, true, true, false]);
  s.elements.refresh.click(); await turn(); assert.equal(s.elements.state.textContent, "準備OK");
  await start(s); assert.deepEqual(view(), ["取得中", true, false, false, true]);
  s.elements.pause.click(); await turn(); assert.equal(s.elements.state.textContent, "一時停止中");
  s.elements.pause.click(); await turn(); assert.equal(s.elements.state.textContent, "取得中");
  s.fixture.respond = p => p.action === "read" ? expired : p.action === "recover" ? { status: "unavailable", code: "CAPTION_DECODE_BUSY" } : undefined;
  await s.capture(); assert.equal(s.elements.state.textContent, "自動復旧中"); assert.match(s.elements.state.className, /working/);
  s.elements.stop.click(); assert.equal(s.elements.state.textContent, "準備OK");
  assert.match(s.elements.state.className, /ready/);
});
test("failure stops are marked as needing attention; a manual stop is not", async t => {
  const s = setup(t); await start(s);
  s.fixture.snapshot = { status: "unavailable", code: "CAPTIONS_OFF" }; await s.capture();
  assert.equal(s.elements.state.textContent, "停止（要確認）"); assert.match(s.elements.state.className, /error/);
});
test("the pairing token is restored for the browser session and forgotten once the server rejects it", async t => {
  const saved = { token: undefined };
  const storage = { get: async () => saved.token, set: async token => { saved.token = token; }, remove: async () => { saved.token = undefined; } };
  const first = setup(t, undefined, storage); await start(first);
  assert.equal(saved.token, "t".repeat(43));
  const second = setup(t, undefined, storage); second.elements.token.value = ""; await turn();
  assert.equal(second.elements.token.value, "t".repeat(43));
  const rejected = setup(t, () => ({ ok: false, status: 401 }), storage); await start(rejected);
  assert.equal(saved.token, undefined);
});
test("a token is not stored before the local server accepted it", async t => {
  const saved = { token: undefined };
  const s = setup(t, () => ({ ok: false, status: 503 }), { get: async () => undefined, set: async token => { saved.token = token; }, remove: async () => {} });
  await start(s); assert.equal(saved.token, undefined);
});

test("caption-less start is opt-in, per start, and follows the checkbox in discovery and start", async t => {
  const s = setup(t); s.elements.refresh.click(); await turn();
  assert.equal(s.elements.assist.checked, undefined);
  assert.ok(s.actions.every(a => a.assistCaptions !== true));
  s.elements.assist.checked = true; s.elements.assist.dispatchEvent(new Event("change")); await turn();
  assert.equal(s.actions.at(-1).action, "discover"); assert.equal(s.actions.at(-1).assistCaptions, true);
  s.elements.meeting.value = s.fixture.snapshot.meetingId; s.elements.start.click(); await turn();
  assert.equal(s.actions.find(a => a.action === "start").assistCaptions, true);
  s.elements.stop.click();
  s.elements.assist.checked = false; s.elements.refresh.click(); await turn(); s.elements.start.click(); await turn();
  assert.ok(!s.actions.filter(a => a.action === "start").at(-1).assistCaptions);
});
test("assisted refusals are explained and stop a capture", async t => {
  for (const code of ["MEDIA_SESSION_NOT_FOUND", "CAPTION_LANGUAGE_UNKNOWN", "CAPTION_ENABLE_FAILED"]) {
    const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = code;
    s.elements.refresh.click(); await turn();
    assert.ok(s.elements.status.textContent.includes(code)); assert.ok(!s.elements.status.textContent.includes("READ_FAILED"));
  }
});

test("a Teams capture is discovered, explained, and sent as Teams", async t => {
  const s = setup(t); s.fixture.platform = "Teams"; s.fixture.snapshot.platform = "Teams"; s.fixture.snapshot.meetingId = "teams.microsoft.com/call";
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /Teams/); assert.match(s.elements.status.textContent, /ライブキャプション/);
  await start(s); fresh(s, "fresh", "teams words"); await s.poll();
  assert.equal(JSON.parse(posts(s)[0].options.body).platform, "Teams");
  assert.equal(JSON.parse(posts(s)[0].options.body).meetingId, "teams.microsoft.com/call");
});
test("a snapshot from a different platform than the discovered one stops the capture", async t => {
  const s = setup(t); s.fixture.platform = "Teams"; s.fixture.snapshot.meetingId = "teams.microsoft.com/call";
  await start(s); assert.equal(s.elements.stop.disabled, true); assert.match(s.elements.status.textContent, /READ_FAILED/);
  assert.equal(posts(s).length, 0);
});

test("a Zoom capture is discovered, explained, and sent as Zoom", async t => {
  const s = setup(t); s.fixture.platform = "Zoom"; s.fixture.snapshot.platform = "Zoom"; s.fixture.snapshot.meetingId = "app.zoom.us/wc/12345678";
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /Zoom/); assert.match(s.elements.status.textContent, /字幕/);
  await start(s); fresh(s, "fresh", "zoom words"); await s.poll();
  assert.equal(JSON.parse(posts(s)[0].options.body).platform, "Zoom");
});
test("Zoom frame and unsupported-host refusals are explained", async t => {
  for (const code of ["ZOOM_STORE_NOT_FOUND", "TEAMS_CALL_NOT_FOUND", "TEAMS_CALL_ENDED", "PLATFORM_NOT_IMPLEMENTED"]) {
    const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = code;
    s.elements.refresh.click(); await turn();
    assert.ok(s.elements.status.textContent.includes(code)); assert.ok(!s.elements.status.textContent.includes("READ_FAILED"));
  }
});
test("diagnostic counters are whitelisted integers, nothing else", async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = "CAPTION_FORMAT_UNKNOWN";
  s.fixture.diagnostics = { peers: 0, names: 3, dropped: 7, received: "PRIVATE_RAW", tids: ["secret-tid"], secret: "PRIVATE" };
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /名簿=3/); assert.match(s.elements.status.textContent, /不正=7/);
  assert.ok(!s.elements.status.textContent.includes("PRIVATE") && !s.elements.status.textContent.includes("secret-tid"));
});

test("default batching holds while speech continues and sends about a second after captions go quiet", async t => {
  const s = setup(t); await start(s);
  fresh(s, "a", "first words"); await s.capture(); await s.tick(500); assert.equal(posts(s).length, 0, "still within the quiet window");
  s.fixture.snapshot.blocks[1].transcript += " and more"; await s.capture(); await s.tick(700); assert.equal(posts(s).length, 0, "a change restarts the quiet window");
  await s.tick(600);
  assert.equal(posts(s).length, 1); assert.deepEqual(JSON.parse(posts(s)[0].options.body).updates.map(b => b.transcript), ["first words and more"]);
  await s.tick(10000); assert.equal(posts(s).length, 1, "nothing pending, nothing sent");
});
test("default batching still sends during continuous speech after the maximum hold", async t => {
  const s = setup(t); await start(s);
  fresh(s, "a", "x"); await s.capture();
  for (let i = 0; i < 19; i++) { s.fixture.snapshot.blocks[1].transcript += "."; await s.tick(500); await s.capture(); }
  assert.equal(posts(s).length, 0, "9.5s of constant change is still held");
  s.fixture.snapshot.blocks[1].transcript += "."; await s.tick(500);
  assert.equal(posts(s).length, 1, "the oldest unsent change is at most 10s old");
});
for (const [mode, ms] of [["5", 5000], ["30", 30000]]) test("fixed cadence " + mode + "s sends on schedule only", async t => {
  const s = setup(t); s.elements.batch.value = mode; await start(s);
  fresh(s, "a", "cadence caption"); await s.capture();
  await s.tick(ms - 500); assert.equal(posts(s).length, 0);
  await s.tick(500); assert.equal(posts(s).length, 1);
});
test("a failed send is retried after a pause, not on every tick", async t => {
  let fail = true;
  const s = setup(t, url => url.endsWith("/health") || !fail ? { ok: true, status: 202 } : { ok: false, status: 503 });
  await start(s); fresh(s, "a", "retry caption"); await s.capture();
  await s.tick(5000); assert.equal(posts(s).length, 1);
  await s.tick(500); await s.tick(500); assert.equal(posts(s).length, 1, "no retry inside the back-off");
  fail = false; await s.tick(5000); assert.equal(posts(s).length, 2);
});
test("Meet's drop reasons and caption profile are shown as whitelisted counters and fixed names only", async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = "CAPTION_FORMAT_UNKNOWN";
  s.fixture.diagnostics = { peers: 1, dropped: 60, frame: 3, utterance: 50, device: 7, id: 0, binary: 0, profile: "captions_v2", secret: "PRIVATE" };
  s.elements.refresh.click(); await turn();
  for (const part of [/不正=60/, /形式不正=3/, /発話なし=50/, /話者ID不正=7/, /方式=captions_v2/]) assert.match(s.elements.status.textContent, part);
  s.fixture.diagnostics = { profile: "<script>PRIVATE" }; s.elements.refresh.click(); await turn();
  assert.ok(!s.elements.status.textContent.includes("PRIVATE") && !s.elements.status.textContent.includes("方式="));
});

// --- screenshots
const fakeShot = (value, bytes = Uint8Array.of(0xff, 0xd8, 0xff, value)) => ({ bytes, signature: new Uint8Array(576).fill(value) });
const urls = (s, part) => s.calls.filter(c => c.url.includes(part));
function shooter(...shots) { const queue = [...shots]; const fn = async () => { fn.calls++; const next = queue.length > 1 ? queue.shift() : queue[0]; if (next instanceof Error) throw next; return next; }; fn.calls = 0; return fn; }

test("each batch uploads a screenshot of the meeting right before it, tied to the batch's session and sequence", async t => {
  const shot = shooter(fakeShot(10));
  const s = setup(t, undefined, undefined, shot); await start(s); fresh(s, "a", "first words"); await s.poll();
  const order = s.calls.filter(c => c.options.method === "POST").map(c => c.url.replace("http://127.0.0.1:43821", "").split("?")[0]);
  assert.deepEqual(order, ["/screenshots", "/captions"], "the screenshot goes first so the batch's event can carry it");
  const [upload] = urls(s, "/screenshots"), body = JSON.parse(urls(s, "/captions")[0].options.body);
  assert.equal(upload.options.headers["content-type"], "image/jpeg"); assert.match(upload.options.headers.authorization, /^Bearer /);
  assert.equal(new URL(upload.url).searchParams.get("sessionId"), body.sessionId); assert.equal(new URL(upload.url).searchParams.get("sequence"), String(body.sequence));
  assert.deepEqual([...upload.options.body], [0xff, 0xd8, 0xff, 10]);
  assert.match(s.elements.status.textContent, /画像=1/);
});
test("a screen that has not changed is not uploaded again; a changed one is", async t => {
  const shot = shooter(fakeShot(10), fakeShot(11), fakeShot(200));
  const s = setup(t, undefined, undefined, shot); await start(s);
  fresh(s, "a", "one"); await s.poll(); fresh(s, "b", "two"); await s.poll(); fresh(s, "c", "three"); await s.poll();
  assert.equal(shot.calls, 3, "every batch looks at the screen");
  assert.equal(urls(s, "/screenshots").length, 2, "the near-identical second picture is skipped, the changed third is sent");
  assert.equal(urls(s, "/captions").length, 3);
});
test("a screenshot problem of any kind never blocks or stops the captions", async t => {
  for (const [name, screenshot, fetcher] of [
    ["capture throws", shooter(new Error("no permission")), undefined],
    ["nothing captured", shooter(null), undefined],
    ["empty image", shooter({ bytes: new Uint8Array(0), signature: new Uint8Array(576) }), undefined],
    ["upload rejected", shooter(fakeShot(10)), url => url.includes("/screenshots") ? { ok: false, status: 400 } : { ok: true, status: 202 }],
    ["upload server error", shooter(fakeShot(10)), url => url.includes("/screenshots") ? { ok: false, status: 500 } : { ok: true, status: 202 }],
    ["upload network failure", shooter(fakeShot(10)), url => { if (url.includes("/screenshots")) throw new Error("offline"); return { ok: true, status: 202 }; }],
  ]) {
    const s = setup(t, fetcher, undefined, screenshot); await start(s); fresh(s, "a", "still sent"); await s.poll();
    assert.equal(urls(s, "/captions").length, 1, name); assert.match(s.elements.state.textContent, /取得中/, name);
  }
});
test("a resent batch neither takes nor uploads its screenshot again once the receiver has it", async t => {
  let fail = true;
  const shot = shooter(fakeShot(10), fakeShot(99));
  const s = setup(t, url => url.endsWith("/health") || url.includes("/screenshots") || !fail ? { ok: true, status: 202 } : { ok: false, status: 503 }, undefined, shot);
  await start(s); fresh(s, "a", "retry me"); await s.capture(); await s.tick(5000); assert.equal(urls(s, "/captions").length, 1);
  fail = false; await s.tick(5000);
  assert.equal(urls(s, "/captions").length, 2); assert.equal(shot.calls, 1, "one picture per batch, even across resends");
  assert.equal(urls(s, "/screenshots").length, 1, "an uploaded picture is not uploaded again; the receiver keeps it for the resend");
});
test("with the checkbox off, or no screenshot support, nothing is captured or uploaded", async t => {
  const shot = shooter(fakeShot(10));
  const off = setup(t, undefined, undefined, shot); off.elements.shots.checked = false; await start(off); fresh(off, "a", "no picture"); await off.poll();
  assert.equal(shot.calls, 0); assert.equal(urls(off, "/screenshots").length, 0); assert.equal(urls(off, "/captions").length, 1);
  const none = setup(t); await start(none); fresh(none, "a", "no picture"); await none.poll(); assert.equal(urls(none, "/screenshots").length, 0);
});
test("a screenshot whose upload failed is offered again with the resend, still from the same picture", async t => {
  let fail = true;
  const shot = shooter(fakeShot(10), fakeShot(99));
  const s = setup(t, url => url.includes("/screenshots") ? { ok: !fail, status: fail ? 503 : 202 } : url.endsWith("/health") || !fail ? { ok: true, status: 202 } : { ok: false, status: 503 }, undefined, shot);
  await start(s); fresh(s, "a", "retry me"); await s.capture(); await s.tick(5000);
  fail = false; await s.tick(5000);
  assert.equal(shot.calls, 1); assert.equal(urls(s, "/screenshots").length, 2); assert.equal(urls(s, "/captions").length, 2);
});
test("frame structures are shown only when they are pure structure (field numbers, wire types, a length)", async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = "CAPTION_FORMAT_UNKNOWN";
  s.fixture.diagnostics = { shapes: ["captions_v2:#58:1:2(1:0,3:2(6:2))", "captions:#7:1:2,2:0!", "captions_v2:#9:hello world", "captions:#3:" + "1:0,".repeat(80), 5, "<script>PRIVATE"], secret: "PRIVATE" };
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /形=captions_v2:#58:1:2\(1:0,3:2\(6:2\)\) \| captions:#7:1:2,2:0!/);
  assert.ok(!s.elements.status.textContent.includes("hello") && !s.elements.status.textContent.includes("PRIVATE"));
  assert.ok(!s.elements.status.textContent.includes("1:0,".repeat(80)), "over-long structure is refused");
});
test("when only unusable data has arrived the status says so while the capture keeps running", async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = "CAPTION_FORMAT_UNKNOWN";
  s.fixture.diagnostics = { dropped: 120, accepted: 0, baselineExcluded: 0, frame: 120 };
  s.elements.refresh.click(); await turn(); assert.match(s.elements.status.textContent, /字幕として使えないデータだけが届いています/);
  s.fixture.diagnostics = { dropped: 120, accepted: 1, baselineExcluded: 0 }; s.elements.refresh.click(); await turn();
  assert.doesNotMatch(s.elements.status.textContent, /字幕として使えないデータだけ/);
  s.fixture.diagnostics = { dropped: 49, accepted: 0, baselineExcluded: 0 }; s.elements.refresh.click(); await turn();
  assert.doesNotMatch(s.elements.status.textContent, /字幕として使えないデータだけ/);
});
test("roster counters and the structure of an empty device list are shown, nothing else", async t => {
  const s = setup(t); s.fixture.captionReady = false; s.fixture.discoveryCode = "CAPTION_FORMAT_UNKNOWN";
  s.fixture.diagnostics = { names: 0, rosterRpc: 4, rosterSync: 1, rosterSyncNames: 0, rosterChannel: 2, selfKnown: 0, rosterShape: "2:2(2:2(1:2))", secret: "PRIVATE" };
  s.elements.refresh.click(); await turn();
  assert.match(s.elements.status.textContent, /名簿=0／RPC観測=4／同期応答=1／同期名簿=0／名簿通信=2／自分ID=0/);
  assert.match(s.elements.status.textContent, /名簿形=2:2\(2:2\(1:2\)\)/);
  s.fixture.diagnostics = { rosterShape: "SECRET text", secret: "PRIVATE" }; s.elements.refresh.click(); await turn();
  assert.ok(!s.elements.status.textContent.includes("SECRET") && !s.elements.status.textContent.includes("PRIVATE"));
});
test("when no screenshot can be taken or uploaded the status says why, from a fixed vocabulary, and clears once one works", async t => {
  const coded = code => Object.assign(new Error(code), { code });
  const cases = [["worker", /背景処理に届きません/], ["inactive", /前面にありません/], ["permission", /権限がありません/], ["decode", /画像の変換/], ["<script>PRIVATE", /撮影に失敗/]];
  for (const [code, pattern] of cases) {
    const s = setup(t, undefined, undefined, shooter(coded(code))); await start(s); fresh(s, "a", "words"); await s.poll();
    assert.match(s.elements.status.textContent, /画像=0（/); assert.match(s.elements.status.textContent, pattern, code); assert.ok(!s.elements.status.textContent.includes("PRIVATE"));
  }
  const up = setup(t, url => url.includes("/screenshots") ? { ok: false, status: 400 } : { ok: true, status: 202 }, undefined, shooter(fakeShot(10))); await start(up); fresh(up, "a", "words"); await up.poll();
  assert.match(up.elements.status.textContent, /画像=0（画像の送信に失敗/);
  const recover = setup(t, undefined, undefined, shooter(coded("inactive"), fakeShot(10))); await start(recover);
  fresh(recover, "a", "one"); await recover.poll(); assert.match(recover.elements.status.textContent, /前面にありません/);
  fresh(recover, "b", "two"); await recover.poll(); assert.match(recover.elements.status.textContent, /画像=1/); assert.doesNotMatch(recover.elements.status.textContent, /前面にありません/);
});
