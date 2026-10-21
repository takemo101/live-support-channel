import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../server/bridge.js";

const token = "test-pairing-token-with-at-least-32-characters";
const session = "00000000-0000-4000-8000-0000000000AB";
const jpeg = (extra = "") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic jpeg body " + extra), Buffer.from([0xff, 0xd9])]);
const batch = (sequence, transcript = "hello") => ({ sessionId: session, sequence, meetingId: "room", platform: "Teams",
  updates: [{ messageId: "m" + sequence, messageVersion: 1, speakerName: "Alice", transcript, timestamp: 100, version: 1 }] });

async function setup(t, { enabled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "live-support-shots-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const server = createBridge({ token, publish: async event => events.push(JSON.parse(event.params.content)), screenshots: enabled ? { directory } : null });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = "http://127.0.0.1:" + server.address().port;
  const auth = { authorization: "Bearer " + token };
  const shot = (sequence, body = jpeg(), { type = "image/jpeg", query = `sessionId=${session}&sequence=${sequence}`, headers = {} } = {}) =>
    fetch(`${url}/screenshots?${query}`, { method: "POST", headers: { "content-type": type, ...auth, ...headers }, body }).then(r => r.status);
  const caption = body => fetch(url + "/captions", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) }).then(r => r.status);
  return { directory, events, shot, caption, server, url };
}

test("a screenshot sent before its batch is stored privately and its path is added to that batch's event only", async t => {
  const { directory, events, shot, caption } = await setup(t);
  assert.equal(await shot(1), 202);
  const [name] = await readdir(directory); assert.equal(name, session.toLowerCase() + "-1.jpg");
  assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(join(directory, name)), jpeg());
  assert.equal(await caption(batch(1)), 202); assert.equal(await caption(batch(2, "no screenshot for this one")), 202);
  assert.equal(events[0].screenshot, join(directory, name)); assert.equal(events[1].screenshot, undefined);
  assert.equal(events[0].updates[0].transcript, "hello");
});
test("a resent batch keeps its screenshot, a re-uploaded screenshot replaces the file, and only the newest are kept", async t => {
  const { directory, events, shot, caption } = await setup(t);
  assert.equal(await shot(1, jpeg("first")), 202); assert.equal(await shot(1, jpeg("second")), 202);
  assert.deepEqual(await readFile(join(directory, session.toLowerCase() + "-1.jpg")), jpeg("second"));
  assert.equal(await caption(batch(1)), 202); assert.equal(await caption(batch(1)), 202);
  assert.equal(events.length, 1, "the identical resend is not delivered twice");
  for (let i = 2; i <= 40; i++) assert.equal(await shot(i), 202);
  const kept = (await readdir(directory)).filter(name => name.endsWith(".jpg")); assert.equal(kept.length, 30);
  assert.ok(!kept.includes(session.toLowerCase() + "-1.jpg") && kept.includes(session.toLowerCase() + "-40.jpg"));
});
test("screenshots are validated: auth, type, session, sequence, magic bytes and size", async t => {
  const { directory, shot, url } = await setup(t);
  assert.equal(await shot(1, jpeg(), { headers: { authorization: "Bearer wrong-token-wrong-token-wrong-token-0000" } }), 401);
  assert.equal(await shot(1, jpeg(), { type: "image/png" }), 415);
  assert.equal(await shot(1, jpeg(), { type: "application/json" }), 415);
  assert.equal(await shot(1, jpeg(), { query: "sessionId=../../etc&sequence=1" }), 400);
  assert.equal(await shot(1, jpeg(), { query: `sessionId=${session}&sequence=0` }), 400);
  assert.equal(await shot(1, jpeg(), { query: `sessionId=${session}&sequence=1.5` }), 400);
  assert.equal(await shot(1, Buffer.from("not a jpeg at all")), 400);
  assert.equal(await shot(1, Buffer.alloc(2097153, 0xff)), 413);
  assert.equal((await fetch(url + "/screenshots?x=1", { method: "GET", headers: { authorization: "Bearer " + token } })).status, 404);
  assert.deepEqual(await readdir(directory), []);
});
test("without a configured directory the endpoint does not exist and batches carry no screenshot", async t => {
  const { shot, caption, events } = await setup(t, { enabled: false });
  assert.equal(await shot(1), 404); assert.equal(await caption(batch(1)), 202); assert.equal(events[0].screenshot, undefined);
});
test("clearScreenshots removes every stored file and forgets the association", async t => {
  const { directory, shot, caption, events, server } = await setup(t);
  assert.equal(await shot(1), 202); await server.clearScreenshots(); assert.deepEqual(await readdir(directory), []);
  assert.equal(await caption(batch(1)), 202); assert.equal(events[0].screenshot, undefined);
});

test("real MCP server: the screenshot path rides in the channel event, lives beside the runtime directory, and is removed when the server stops", async t => {
  const { mkdtemp: temp, access } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const parent = await temp(join(tmpdir(), "live-support-e2e-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const runtime = join(parent, "runtime");
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("server/main.js")], env: { LIVE_SUPPORT_RUNTIME_DIR: runtime, LIVE_SUPPORT_PORT: "0" }, stderr: "pipe" });
  const client = new Client({ name: "shots-test", version: "1" }, { capabilities: {} });
  const events = []; client.fallbackNotificationHandler = async n => { if (n.method === "notifications/claude/channel") events.push(JSON.parse(n.params.content)); };
  await client.connect(transport);
  let logs = ""; const url = await new Promise((accept, reject) => { const timer = setTimeout(() => reject(Error("not ready")), 5000); transport.stderr.on("data", c => { logs += c; const m = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); accept(m[0]); } }); });
  const auth = { authorization: "Bearer " + (await readFile(join(runtime, "token"), "utf8")).trim() };
  assert.equal((await fetch(`${url}/screenshots?sessionId=${session}&sequence=1`, { method: "POST", headers: { ...auth, "content-type": "image/jpeg" }, body: jpeg("e2e") })).status, 202);
  assert.equal((await fetch(url + "/captions", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(batch(1)) })).status, 202);
  for (let i = 0; i < 50 && !events.length; i++) await new Promise(r => setTimeout(r, 20));
  const path = events[0].screenshot;
  assert.equal(path, join(runtime + "-screens", session.toLowerCase() + "-1.jpg")); assert.ok(!(path + "/").startsWith(runtime + "/"), "outside the runtime directory");
  assert.deepEqual(await readFile(path), jpeg("e2e"));
  await client.close();
  for (let i = 0; i < 100; i++) { try { await access(path); } catch { return; } await new Promise(r => setTimeout(r, 20)); }
  assert.fail("the screenshot should be removed when the server stops");
});
