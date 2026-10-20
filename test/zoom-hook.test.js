import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const readSource = async name => readFile(new URL("../extension/" + name, import.meta.url), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
const source = await readSource("hook-core.js") + "\n" + await readSource("zoom-hook.js");
const key = "__liveCaptionsRtc_v1", meetingId = "app.zoom.us/wc/12345678";

function fixture({ host = "app.zoom.us", pathname = "/wc/12345678/join", framed = false, protocol = "https:", frame = true } = {}) {
  const reads = [];
  const contentDocument = { querySelector(selector) { reads.push(selector); return null; }, get body() { throw Error("no caption DOM walk while idle"); } };
  const page = {
    location: { protocol, hostname: host, pathname },
    document: { querySelector(selector) { assert.equal(selector, "#webclient"); return frame ? { contentDocument } : null; } },
    MutationObserver: class { observe() { throw Error("no observer while idle"); } disconnect() {} },
    performance: { now: () => 100 }, Date, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
  };
  page.top = framed ? {} : page;
  vm.runInContext(source, vm.createContext({ window: page }));
  return { api: page[key], reads, command: (action, extra = {}) => page[key]?.command({ action, meetingId, captureId: "owner", ...extra }) };
}

test("hook installs only in the top frame of the Zoom web client over https", () => {
  assert.ok(fixture().api);
  for (const options of [{ host: "zoom.us" }, { host: "us02web.zoom.us" }, { host: "app.zoom.us.evil.example" }, { host: "meet.google.com" }, { framed: true }, { protocol: "http:" }])
    assert.equal(fixture(options).api, undefined, JSON.stringify(options));
});
test("discover reports readiness from the page and frame only, never reading caption text", () => {
  const f = fixture(); const meta = f.command("discover");
  assert.equal(meta.code, "READY"); assert.equal(meta.platform, "Zoom"); assert.equal(meta.captionReady, true);
  assert.equal(JSON.parse(JSON.stringify(meta.meetings.map(m => m.id)))[0], meetingId);
  assert.equal(f.reads.length, 0);
  assert.equal(fixture({ pathname: "/" }).command("discover").code, "NOT_MEETING_PAGE");
  assert.equal(fixture({ pathname: "/wc/12345678/join" , frame: false }).command("discover").code, "ZOOM_FRAME_NOT_FOUND");
  assert.equal(fixture({ pathname: "/wc/abc/join" }).command("discover").code, "NOT_MEETING_PAGE");
});
test("a changed meeting or missing frame refuses to start", () => {
  assert.equal(fixture().command("start", { meetingId: "app.zoom.us/wc/999999" }).code, "MEETING_CHANGED");
  assert.equal(fixture({ frame: false }).command("start").code, "ZOOM_FRAME_NOT_FOUND");
});
