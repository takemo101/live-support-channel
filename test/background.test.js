import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const PANEL = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html";

function worker({ tab = { id: 5, active: true, windowId: 9, url: "https://meet.google.com/abc-defg-hij" }, captureError } = {}) {
  let listener; const captured = [];
  const chrome = { runtime: { id: "abcdefghijklmnopabcdefghijklmnop", getURL: path => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/" + path, onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { get: async id => { if (id !== tab.id) throw Error("No tab"); return tab; }, captureVisibleTab: async (windowId, options) => { if (captureError) throw Error(captureError); captured.push({ windowId, options }); return "data:image/jpeg;base64,AAAA"; } } };
  vm.runInNewContext(source, { chrome, URL, Date, Number });
  const ask = (message, sender = { id: chrome.runtime.id, url: PANEL }) => new Promise(resolve => { const keep = listener(message, sender, value => resolve(JSON.parse(JSON.stringify(value)))); if (!keep) resolve("ignored"); });
  return { ask, captured, tab };
}
const message = tabId => ({ type: "live-support-screenshot", tabId });

test("the worker photographs only the active meeting tab, as a JPEG, for the panel", async () => {
  const w = worker();
  assert.deepEqual(await w.ask(message(5)), { ok: true, dataUrl: "data:image/jpeg;base64,AAAA" });
  assert.deepEqual(JSON.parse(JSON.stringify(w.captured)), [{ windowId: 9, options: { format: "jpeg", quality: 70 } }]);
});
test("it refuses other sites, inactive tabs, and non-https pages without taking any picture", async () => {
  for (const [url, active, reason] of [["https://mail.google.com/", true, "host"], ["https://meet.google.com.evil.example/", true, "host"], ["http://meet.google.com/abc", true, "host"], ["not a url", true, "url"], ["https://app.zoom.us/wc/123/join", false, "inactive"]]) {
    const w = worker({ tab: { id: 5, active, windowId: 9, url } });
    assert.deepEqual(await w.ask(message(5)), { ok: false, reason }, url); assert.equal(w.captured.length, 0);
  }
});
test("it answers only the extension's own panel and only well-formed requests", async () => {
  const w = worker();
  assert.equal(await w.ask(message(5), { id: "someone-else", url: PANEL }), "ignored");
  assert.equal(await w.ask(message(5), { id: "abcdefghijklmnopabcdefghijklmnop", url: "https://meet.google.com/abc-defg-hij" }), "ignored", "not from a page");
  for (const bad of [{ type: "other", tabId: 5 }, { type: "live-support-screenshot" }, { type: "live-support-screenshot", tabId: "5" }, { type: "live-support-screenshot", tabId: 1.5 }, null])
    assert.equal(await w.ask(bad), "ignored");
  assert.equal(w.captured.length, 0);
});
test("captures are rate limited and a failing capture is reported, never thrown", async () => {
  const w = worker(); assert.equal((await w.ask(message(5))).ok, true); assert.deepEqual(await w.ask(message(5)), { ok: false, reason: "rate" });
  assert.deepEqual(await worker({ captureError: "denied" }).ask(message(5)), { ok: false, reason: "failed" });
  assert.deepEqual(await worker().ask(message(6)), { ok: false, reason: "failed" }, "an unknown tab");
});
