import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readTactiq, TACTIQ_CONTEXT } from "../extension/snapshot.js";

const block = { messageId: "m1", messageVersion: 1, speakerName: "Alice", transcript: "hello", timestamp: 100, version: 101 };
function inspect(meetingId, { host = "meet.google.com", paused = false, stage = "meeting", invalidated = false, current, state } = {}) {
  const context = {
    location: { hostname: host, href: "https://" + host + "/test" },
    window: { tactiq: { content: { invalidated, store: { getState: () => state ?? { transcriptions: { current: current ?? { room: { id: "room", meetingTitle: "Demo", isPaused: paused, detectedMeetingStage: stage, blocks: [block] } } } } } } } },
  };
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${readTactiq.toString()})(${JSON.stringify(meetingId)})`, context)));
}
test("uses the specific Tactiq isolated world", () => {
  assert.equal(TACTIQ_CONTEXT, "chrome-extension://fggkaccpbmombhnjkjokndojfgagejfb");
});
for (const host of ["meet.google.com", "app.zoom.us", "teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) {
  test("reads post-processed captions on " + host, () => {
    const result = inspect("room", { host });
    assert.equal(result.status, "live");
    assert.equal(result.meetingId, "room");
    assert.deepEqual(result.blocks, [block]);
    assert.ok(result.platform);
  });
}
test("meeting picker metadata never includes transcript text or account state", () => {
  const result = inspect(null);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.meetings, [{ id: "room", title: "Demo" }]);
  assert.ok(!JSON.stringify(result).includes("hello"));
});
test("paused or unknown pause state cannot release any blocks", () => {
  for (const paused of [true, undefined, null, "false"]) {
    const result = inspect("room", { current: { room: { id: "room", isPaused: paused, detectedMeetingStage: "meeting", blocks: [block] } } });
    assert.notEqual(result.status, "live");
    assert.equal(result.blocks, undefined);
  }
});
test("meeting end, invalidation, context change, or missing selection fail closed", () => {
  for (const options of [{ stage: "left" }, { invalidated: true }, { host: "evil.example" }, { current: {} }, { state: {} }]) {
    const result = inspect("room", options);
    assert.notEqual(result.status, "live");
    assert.equal(result.blocks, undefined);
  }
});
test("extracts only selected meeting and whitelists fields", () => {
  const result = inspect("room", { current: {
    room: { id: "room", isPaused: false, detectedMeetingStage: "meeting", blocks: [{ ...block, secret: "no" }] },
    other: { id: "other", isPaused: false, detectedMeetingStage: "meeting", blocks: [{ ...block, transcript: "private other meeting" }] },
  } });
  assert.deepEqual(result.blocks, [block]);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("private other"));
});
test("malformed and overlarge snapshots do not silently truncate", () => {
  for (const blocks of [[{ ...block, transcript: {} }], [{ ...block, messageId: "" }], [{ ...block, speakerName: "" }], Array.from({ length: 100 }, () => ({ ...block, transcript: "x".repeat(32768) })), Array.from({ length: 4001 }, () => block)]) {
    const result = inspect("room", { current: { room: { id: "room", isPaused: false, detectedMeetingStage: "meeting", blocks } } });
    assert.equal(result.status, "unsupported");
    assert.equal(result.blocks, undefined);
  }
});
