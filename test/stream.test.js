import test from "node:test";
import assert from "node:assert/strict";
import { CaptionStream } from "../extension/stream.js";
const b = (text = "hello", version = 1, id = "m1") => ({ messageId: id, messageVersion: version, speakerName: "Alice", transcript: text, timestamp: 100, version });
const snapshot = (blocks, status = "live", meetingId = "room") => ({ status, meetingId, platform: "Google Meet", blocks });
test("start baselines old captions, only new or revised text is sent", async () => {
  const sent = [];
  const stream = new CaptionStream(async payload => { sent.push(payload); });
  stream.start(snapshot([b()]));
  await stream.update(snapshot([b()]));
  assert.equal(sent.length, 0);
  await stream.update(snapshot([b("hello world", 2, "fresh")]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sequence, 1);
  assert.deepEqual(sent[0].updates, [b("hello world", 2, "fresh")]);
  await stream.update(snapshot([b("hello world", 2, "fresh")]));
  assert.equal(sent.length, 1);
});
test("retries the exact unacknowledged batch before newer text", async () => {
  const sent = [];
  let fail = true;
  const stream = new CaptionStream(async payload => {
    sent.push(structuredClone(payload));
    if (fail) throw Error("offline");
  });
  stream.start(snapshot([]));
  await assert.rejects(stream.update(snapshot([b()])), /offline/);
  fail = false;
  await stream.update(snapshot([b("latest", 3)]));
  assert.deepEqual(sent[1], sent[0]);
  await stream.update(snapshot([b("latest", 3)]));
  assert.equal(sent[2].sequence, 2);
  assert.equal(sent[2].updates[0].transcript, "latest");
});
test("pause freezes retry and skips the paused interval on resume", async () => {
  const sent = [];
  const stream = new CaptionStream(async payload => sent.push(payload));
  stream.start(snapshot([]));
  await stream.update({ status: "paused" });
  await stream.update(snapshot([b("private during pause", 2)]));
  assert.equal(sent.length, 0);
  await stream.update(snapshot([b("new after resume", 3, "fresh")]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].updates[0].transcript, "new after resume");
});
test("resume baselines immediately while a pre-pause batch is still in flight", async () => {
  const sent = []; let release;
  const stream = new CaptionStream(payload => {
    sent.push(payload);
    return sent.length === 1 ? new Promise(r => { release = r; }) : Promise.resolve();
  });
  stream.start(snapshot([]));
  const pending = stream.update(snapshot([b("allowed before pause")]));
  await stream.update({ status: "paused" });
  const paused = b("private paused speech", 1, "paused");
  await stream.update(snapshot([paused]));
  release(); await pending;
  await stream.update(snapshot([paused, b("first new after resume", 1, "fresh")]));
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].sessionId, sent[1].sessionId);
  assert.equal(sent[1].sequence, 1);
  assert.deepEqual(sent[1].updates.map(block => block.transcript), ["first new after resume"]);
});
test("stop or context loss never auto-restarts; meeting mismatch fails closed", async () => {
  const sent = [];
  const stream = new CaptionStream(async payload => sent.push(payload));
  stream.start(snapshot([]));
  await stream.update(snapshot([b()], "live", "other"));
  await stream.update(snapshot([b()]));
  assert.equal(sent.length, 0);
  stream.start(snapshot([]));
  stream.stop();
  await stream.update(snapshot([b()]));
  assert.equal(sent.length, 0);
});
test("concurrent polling cannot send the same batch twice", async () => {
  let resolve;
  const sent = [];
  const stream = new CaptionStream(payload => {
    sent.push(payload);
    return new Promise(r => { resolve = r; });
  });
  stream.start(snapshot([]));
  const first = stream.update(snapshot([b()]));
  await stream.update(snapshot([b()]));
  assert.equal(sent.length, 1);
  resolve();
  await first;
});
