import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createPanel } from "../extension/panel.js";
const turn = () => new Promise(resolve => setImmediate(resolve));
class Element extends EventTarget {
  value = ""; disabled = false; textContent = ""; children = [];
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.value = ""; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}
function setup(t, fetcher) {
  const elements = Object.fromEntries(["token", "meeting", "refresh", "start", "stop", "status", "consent"].map(id => [id, new Element()]));
  elements.token.value = "t".repeat(43);
  elements.consent.checked = true;
  const block = { messageId: "m", messageVersion: 1, speakerName: "Demo", transcript: "before start", timestamp: 100, version: 1 };
  const meeting = { id: "room", meetingTitle: "Demo meeting", detectedMeetingStage: "meeting", isPaused: false, blocks: [block] };
  const state = { transcriptions: { current: { room: meeting } } };
  const calls = [], contexts = [], navigation = new Set();
  let poll;
  const inspectedWindow = {
    eval(expression, options, done) {
      contexts.push(options);
      done(JSON.parse(JSON.stringify(vm.runInNewContext(expression, { location: { hostname: "meet.google.com" }, window: { tactiq: { content: { store: { getState: () => state } } } } }))));
    },
  };
  const onNavigated = { addListener(fn) { navigation.add(fn); }, removeListener(fn) { navigation.delete(fn); } };
  const panel = createPanel({
    document: { getElementById: id => elements[id], createElement: () => new Element() },
    inspectedWindow, onNavigated,
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : { ok: true, status: 202 }; },
    setInterval: fn => { poll = fn; return 1; }, clearInterval: () => { poll = undefined; },
  });
  t.after(() => panel.dispose());
  return { elements, meeting, block, state, calls, contexts, navigation, poll: () => poll?.() };
}
test("panel only reads metadata before explicit start; selected context is Tactiq's world", async t => {
  const s = setup(t);
  s.elements.refresh.click(); await turn();
  assert.equal(s.calls.length, 0);
  assert.ok(s.elements.meeting.children.some(child => child.textContent === "Demo meeting"));
  assert.ok(s.contexts.every(c => c.scriptExecutionContext === "chrome-extension://fggkaccpbmombhnjkjokndojfgagejfb"));
});
test("start baselines history; polling sends only fresh edits with auth and no redirect", async t => {
  const s = setup(t);
  s.elements.refresh.click(); await turn();
  s.elements.meeting.value = "room";
  s.elements.meeting.dispatchEvent(new Event("change"));
  s.elements.start.click(); await turn();
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls[0].url.endsWith("/health"));
  s.meeting.blocks.push({ ...s.block, messageId: "fresh", transcript: "new caption", version: 2 });
  await s.poll();
  assert.equal(s.calls.length, 2);
  const call = s.calls[1];
  assert.equal(call.options.headers.authorization, "Bearer " + "t".repeat(43));
  assert.equal(call.options.redirect, "error");
  assert.equal(JSON.parse(call.options.body).updates[0].transcript, "new caption");
  assert.ok(!call.options.body.includes("t".repeat(43)));
});
test("Tactiq pause and navigation gate forwarding, and stop prevents auto-resume", async t => {
  const s = setup(t);
  s.elements.refresh.click(); await turn();
  s.elements.meeting.value = "room";
  s.elements.meeting.dispatchEvent(new Event("change"));
  s.elements.start.click(); await turn();
  s.meeting.isPaused = true;
  s.block.transcript = "while paused"; await s.poll();
  assert.equal(s.calls.length, 1);
  s.meeting.isPaused = false; await s.poll();
  assert.equal(s.calls.length, 1);
  s.meeting.blocks.push({ ...s.block, messageId: "fresh", transcript: "after resume", version: 3 }); await s.poll();
  assert.equal(s.calls.length, 2);
  for (const onNavigate of s.navigation) onNavigate();
  s.block.transcript = "after navigation"; await s.poll();
  assert.equal(s.calls.length, 2);
});
test("stop during connection cannot be undone by a late response", async t => {
  let resolve;
  const s = setup(t, () => new Promise(r => { resolve = r; }));
  s.elements.refresh.click(); await turn();
  s.elements.meeting.value = "room";
  s.elements.meeting.dispatchEvent(new Event("change"));
  s.elements.start.click(); await turn();
  s.elements.stop.click();
  resolve({ ok: true, status: 200 }); await turn();
  s.block.transcript = "after stop"; await s.poll();
  assert.equal(s.calls.length, 1);
  assert.equal(s.elements.start.disabled, false);
});
test("failed authorization stops instead of retrying forever", async t => {
  const s = setup(t, async () => ({ ok: false, status: 401 }));
  s.elements.refresh.click(); await turn();
  s.elements.meeting.value = "room";
  s.elements.meeting.dispatchEvent(new Event("change"));
  s.elements.start.click(); await turn();
  assert.match(s.elements.status.textContent, /401/);
  assert.equal(s.elements.start.disabled, false);
  assert.ok(!s.elements.status.textContent.includes("t".repeat(43)));
});
