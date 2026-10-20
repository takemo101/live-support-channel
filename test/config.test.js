import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("extension prepares a MAIN-world hook on Meet only with no broad permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.devtools_page, "devtools.html");
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.content_scripts, [
    { matches: ["https://meet.google.com/*"], js: ["hook-core.js", "meet-hook.js"], run_at: "document_start", world: "MAIN", all_frames: false },
    { matches: ["https://teams.microsoft.com/*", "https://teams.live.com/*", "https://teams.cloud.microsoft/*"], js: ["hook-core.js", "teams-hook.js"], run_at: "document_start", world: "MAIN", all_frames: false },
    { matches: ["https://app.zoom.us/*"], js: ["hook-core.js", "zoom-hook.js"], run_at: "document_start", world: "MAIN", all_frames: false },
  ]);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src http:\/\/127\.0\.0\.1:43821;/);
  const html = await readFile(new URL("../extension/panel.html", import.meta.url), "utf8");
  for (const id of ["token", "meeting", "consent", "refresh", "start", "pause", "stop", "status"]) assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /role="status"/);
  assert.match(html, /字幕通信/);
  assert.match(html, /会議参加前/);
  assert.match(html, /Tactiqの一時停止とは連動しません/);
  assert.match(html, /Zoom/); assert.match(html, /Teams/);
  assert.ok(!/<script[^>]*>[^<\s]/.test(html));
});
test("leaving the DevTools panel signals a stop", async () => {
  let onShown, onHidden, callbackCalled = false, event;
  const source = await readFile(new URL("../extension/devtools.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    chrome: { devtools: { panels: { create(name, _icon, page, callback) {
      assert.equal(name, "Live Captions"); assert.equal(page, "panel.html");
      callback({ onShown: { addListener(fn) { onShown = fn; } }, onHidden: { addListener(fn) { onHidden = fn; } } });
      callbackCalled = true;
    } } } },
  });
  assert.ok(callbackCalled);
  onShown({ Event, dispatchEvent(e) { event = e; } });
  onHidden();
  assert.equal(event.type, "live-support-panel-hidden");
});
