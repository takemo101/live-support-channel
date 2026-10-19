import test from "node:test";
import assert from "node:assert/strict";
import { CaptionStream } from "../extension/stream.js";
const live = blocks => ({ status: "live", platform: "Zoom", meetingId: "room", blocks });
test("the largest schema-valid escaped block is delivered within the HTTP body budget", async () => {
  const sent = [];
  const stream = new CaptionStream(async payload => sent.push(payload));
  const c = String.fromCharCode(1);
  const block = { messageId: c.repeat(512), deviceId: c.repeat(512), messageVersion: 1, speakerName: c.repeat(256), transcript: c.repeat(32768), timestamp: 100, version: 1 };
  stream.start(live([]));
  await stream.update(live([block]));
  assert.equal(sent.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(sent[0])) < 262144);
});
test("a single block that cannot fit fails visibly instead of silently stalling", async () => {
  const stream = new CaptionStream(async () => assert.fail("must not send"));
  stream.start(live([]));
  await assert.rejects(stream.update(live([{ messageId: "m", transcript: "x".repeat(250000) }])), error => error.fatal === true);
});
test("more than 64 updates are delivered in subsequent bounded batches", async () => {
  const sent = [];
  const stream = new CaptionStream(async payload => sent.push(payload));
  const blocks = Array.from({ length: 80 }, (_, i) => ({ messageId: String(i), deviceId: "d", messageVersion: 1, speakerName: "Demo", transcript: "hello", timestamp: 100, version: 1 }));
  stream.start(live([]));
  await stream.update(live(blocks));
  await stream.update(live(blocks));
  assert.deepEqual(sent.map(p => p.updates.length), [64, 16]);
  assert.equal(new Set(sent.flatMap(p => p.updates.map(b => b.messageId))).size, 80);
});
