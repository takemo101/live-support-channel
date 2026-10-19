import test from "node:test";
import assert from "node:assert/strict";
import { CaptionStream } from "../extension/stream.js";
const block = (id, transcript, version = 1) => ({ messageId: id, speakerName: "Demo", transcript, messageVersion: version, timestamp: 100, version });
const snapshot = blocks => ({ status: "live", meetingId: "room", platform: "Google Meet", blocks });
test("an utterance already in progress at start is never forwarded even when revised", async () => {
  const sent = [];
  const stream = new CaptionStream(async payload => sent.push(payload));
  stream.start(snapshot([block("old", "private before start")]));
  await stream.update(snapshot([block("old", "private before start plus new words", 2)]));
  assert.equal(sent.length, 0);
  await stream.update(snapshot([block("fresh", "new utterance")]));
  assert.equal(sent.length, 1);
});
test("a revised resume-baseline utterance cannot replay a paused prefix", async () => {
  const sent = [];
  const stream = new CaptionStream(async payload => sent.push(payload));
  stream.start(snapshot([]));
  await stream.update({ status: "paused" });
  await stream.update(snapshot([block("during", "private while paused")]));
  await stream.update(snapshot([block("during", "private while paused and continuation", 2)]));
  assert.equal(sent.length, 0);
  await stream.update(snapshot([block("after", "new after resume")]));
  assert.equal(sent.length, 1);
});
test("pause discards failed queued data instead of replaying it on resume", async () => {
  const sent = [];
  let fail = true;
  const stream = new CaptionStream(async payload => {
    if (fail) throw Error("offline");
    sent.push(payload);
  });
  stream.start(snapshot([]));
  await assert.rejects(stream.update(snapshot([block("before", "queued")])));
  await stream.update({ status: "paused" });
  fail = false;
  await stream.update(snapshot([block("before", "queued")]));
  await stream.update(snapshot([block("after", "fresh")]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sequence, 1);
  assert.equal(sent[0].updates[0].messageId, "after");
});
