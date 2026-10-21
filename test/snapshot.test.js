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
for (const host of ["us02web.zoom.us", "zoom.us"]) {
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

for (const host of ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) test("Teams is read only through the prepared hook, bound to its host: " + host, () => {
  const calls = [], api = { version: 1, command(params) { calls.push(params); return { status: "ready", captionReady: true, code: "READY" }; } };
  const options = { host, path: "/v2/", api };
  assert.equal(inspect({ action: "discover" }, options).code, "READY");
  assert.equal(calls[0].meetingId, host + "/call");
  assert.equal(inspect({ action: "read", meetingId: host + "/call", captureId: "c" }, options).status, "ready");
  assert.equal(inspect({ action: "read", meetingId: "meet.google.com/abc-defg-hij", captureId: "c" }, options).code, "MEETING_CHANGED");
  assert.equal(inspect({ action: "discover" }, { ...options, framed: true }).code, "UNSUPPORTED_FRAME");
  assert.equal(calls.length, 2);
});
test("Teams lookalike hosts and non-https stay unsupported", () => {
  for (const host of ["teams.microsoft.com.evil.example", "evilteams.live.com", "teams.cloud.microsoft.evil.example"]) assert.equal(inspect({ action: "discover" }, { host, path: "/v2/" }).code, "UNSUPPORTED_HOST");
});

test("Zoom web client is read only through the prepared hook, bound to its meeting number", () => {
  const calls = [], api = { version: 1, command(params) { calls.push(params); return { status: "ready", captionReady: true, code: "READY" }; } };
  const options = { host: "app.zoom.us", path: "/wc/12345678/join", api };
  assert.equal(inspect({ action: "discover" }, options).code, "READY");
  assert.equal(calls[0].meetingId, "app.zoom.us/wc/12345678");
  assert.equal(inspect({ action: "read", meetingId: "app.zoom.us/wc/12345678", captureId: "c" }, options).status, "ready");
  assert.equal(inspect({ action: "read", meetingId: "app.zoom.us/wc/99999999", captureId: "c" }, options).code, "MEETING_CHANGED");
  assert.equal(inspect({ action: "discover" }, { ...options, path: "/" }).code, "NOT_MEETING_PAGE");
  assert.equal(inspect({ action: "discover" }, { ...options, framed: true }).code, "UNSUPPORTED_FRAME");
  assert.equal(calls.length, 2);
});
test("Meet's /meet/<code> URL form is a meeting page; other prefixes are not", () => {
  const api = { version: 1, command: params => ({ status: "ready", captionReady: true, code: "READY", id: params.meetingId }) };
  const ok = inspect({ action: "discover" }, { api, path: "/meet/abc-defg-hij" });
  assert.equal(ok.code, "READY"); assert.equal(ok.id, "meet.google.com/meet/abc-defg-hij");
  for (const path of ["/foo/abc-defg-hij", "/meet/", "/meet/abc-defg-hij/extra", "/meet/abc-defg-hijk"]) assert.equal(inspect({ action: "discover" }, { api, path }).code, "NOT_MEETING_PAGE", path);
});
