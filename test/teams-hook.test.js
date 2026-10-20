import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const readSource = async name => readFile(new URL("../extension/" + name, import.meta.url), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
const source = await readSource("hook-core.js") + "\n" + await readSource("teams-hook.js");
const key = "__liveCaptionsRtc_v1", meetingId = "teams.microsoft.com/call";
const LIST = '[data-tid="closed-caption-v2-virtual-list-content"]';

function fixture({ host = "teams.microsoft.com", framed = false, protocol = "https:", list = true } = {}) {
  const reads = [];
  const page = {
    location: { protocol, hostname: host, pathname: "/v2/" },
    document: { querySelector(selector) { reads.push(selector); return selector === LIST && list ? { get textContent() { throw Error("no caption text read while idle"); } } : null; } },
    MutationObserver: class { observe() { throw Error("no observer while idle"); } disconnect() {} },
    performance: { now: () => 100 }, Date, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    get RTCPeerConnection() { throw Error("the Teams reader never touches RTC"); },
  };
  page.top = framed ? {} : page;
  vm.runInContext(source, vm.createContext({ window: page }));
  return { api: page[key], reads, command: (action, extra = {}) => page[key]?.command({ action, meetingId, captureId: "owner", ...extra }) };
}

test("hook installs only in the top frame of the Teams hosts over https", () => {
  for (const host of ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) assert.ok(fixture({ host }).api, host);
  for (const options of [{ host: "microsoft.com" }, { host: "teams.microsoft.com.evil.example" }, { host: "app.zoom.us" }, { framed: true }, { protocol: "http:" }])
    assert.equal(fixture(options).api, undefined, JSON.stringify(options));
});
test("discover reports readiness from the presence of the caption list only, never reading caption text or touching RTC", () => {
  const f = fixture(); const meta = f.command("discover");
  assert.equal(meta.code, "READY"); assert.equal(meta.platform, "Teams"); assert.equal(meta.captionReady, true);
  assert.equal(JSON.parse(JSON.stringify(meta.meetings.map(m => m.id)))[0], meetingId);
  const off = fixture({ list: false }).command("discover");
  assert.equal(off.code, "TEAMS_CAPTIONS_NOT_FOUND"); assert.equal(off.captionReady, false);
});
test("a missing caption list or a changed meeting refuses to start", () => {
  assert.equal(fixture({ list: false }).command("start").code, "TEAMS_CAPTIONS_NOT_FOUND");
  assert.equal(fixture().command("start", { meetingId: "teams.microsoft.com/other" }).code, "MEETING_CHANGED");
});
