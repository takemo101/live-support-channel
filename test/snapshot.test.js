import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readCaptions } from "../extension/snapshot.js";

function inspect(params, { host = "meet.google.com", path = "/abc-defg-hij", framed = false } = {}) {
  const window = {}; window.top = framed ? {} : window;
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${readCaptions.toString()})(${JSON.stringify(params)})`, {
    location: { hostname: host, pathname: path }, window,
    get document() { throw Error("DOM must not be read for rejected targets"); },
  })));
}
test("no foreign extension context or Tactiq store access remains", () => {
  assert.ok(!readCaptions.toString().includes("chrome-extension://"));
  assert.ok(!readCaptions.toString().includes("window.tactiq"));
});
for (const host of ["app.zoom.us", "teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) {
  test("unimplemented platform fails before reading DOM: " + host, () => {
    assert.equal(inspect({ action: "discover" }, { host }).code, "PLATFORM_NOT_IMPLEMENTED");
  });
}
test("unsupported host, wrong URL, iframe and mismatched meeting fail closed", () => {
  for (const [params, options, code] of [
    [{ action: "discover" }, { host: "meet.google.com.evil.example" }, "UNSUPPORTED_HOST"],
    [{ action: "discover" }, { path: "/" }, "NOT_MEETING_PAGE"],
    [{ action: "discover" }, { framed: true }, "UNSUPPORTED_FRAME"],
    [{ action: "read", meetingId: "other" }, {}, "MEETING_CHANGED"],
  ]) {
    const result = inspect(params, options);
    assert.equal(result.code, code); assert.equal(result.blocks, undefined);
  }
});
test("reset is metadata-only even when navigation moved to an unsupported host", () => {
  assert.deepEqual(inspect({ action: "reset", captureId: "expired" }, { host: "evil.example" }), { status: "idle" });
});
