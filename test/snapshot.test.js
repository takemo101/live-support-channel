import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readCaptions } from "../extension/snapshot.js";

function inspect(params, { host = "meet.google.com", path = "/abc-defg-hij", framed = false, api, getApi } = {}) {
  const window = { __liveCaptionsRtc_v1: api }; window.top = framed ? {} : window;
  if (getApi) Object.defineProperty(window, "__liveCaptionsRtc_v1", { get: getApi });
  let touched = false;
  const result = JSON.parse(JSON.stringify(vm.runInNewContext(`(${readCaptions.toString()})(${JSON.stringify(params)})`, {
    location: { protocol: "https:", hostname: host, pathname: path }, window,
    document: { querySelectorAll() { touched = true; return []; } },
  })));
  assert.equal(touched, false, "RTC adapter must not read caption DOM");
  return result;
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
    let calls = 0;
    const result = inspect(params, { ...options, getApi() { calls++; return undefined; } });
    assert.equal(calls, 0, "reject target before touching its hook namespace");
    assert.equal(result.code, code); assert.equal(result.blocks, undefined);
  }
});
test("missing early hook is diagnosed without falling back to DOM", () => {
  assert.equal(inspect({ action: "discover" }).code, "RTC_HOOK_NOT_READY");
});
test("adapter invokes only our prepared hook and returns metadata before start", () => {
  const calls = [], api = { version: 1, command(params) { calls.push(params); return { status: "ready", captionReady: true, code: "READY", diagnostics: { peers: 1 } }; } };
  const result = inspect({ action: "discover" }, { api });
  assert.equal(result.code, "READY"); assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "discover");
  assert.equal(calls[0].meetingId, "meet.google.com/abc-defg-hij");
});
test("reset is metadata-only even when navigation moved to an unsupported host", () => {
  assert.deepEqual(inspect({ action: "reset", captureId: "expired" }, { host: "evil.example" }), { status: "idle" });
});
test("recover forwards only the new and previous owner IDs with the verified meeting", () => {
  const calls = [], api = { version: 1, command(params) { calls.push(params); return { status: "live" }; } };
  inspect({ action: "recover", meetingId: "meet.google.com/abc-defg-hij", captureId: "new", previousCaptureId: "old", extra: "x" }, { api });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ action: "recover", meetingId: "meet.google.com/abc-defg-hij", captureId: "new", previousCaptureId: "old" }]);
  assert.equal(inspect({ action: "recover", meetingId: "other", captureId: "new", previousCaptureId: "old" }, { api }).code, "MEETING_CHANGED");
});
