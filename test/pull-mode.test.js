import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connect(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "live-support-pull-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("server/main.js")], env: { LIVE_SUPPORT_RUNTIME_DIR: dir, LIVE_SUPPORT_PORT: "0", ...env }, stderr: "pipe" });
  const client = new Client({ name: "live-support-test", version: "1" }, { capabilities: {} });
  t.after(() => client.close());
  const pushed = []; client.fallbackNotificationHandler = async notification => { pushed.push(notification.method); };
  await client.connect(transport);
  let logs = "";
  const url = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(Error("server did not become ready")), 5000);
    transport.stderr.on("data", chunk => { logs += chunk; const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); accept(match[0]); } });
  });
  const token = (await readFile(join(dir, "token"), "utf8")).trim();
  const send = async (sequence, transcript, sessionId = "11111111-1111-4111-8111-111111111111") => (await fetch(url + "/captions", { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, sequence, meetingId: "demo", platform: "Teams", updates: [{ messageId: "m" + sequence, messageVersion: 1, speakerName: "Demo <b>", transcript, timestamp: 1, version: 1 }] }) })).status;
  const read = async args => JSON.parse((await client.callTool({ name: "get_captions", arguments: args })).content[0].text);
  return { client, send, read, pushed };
}

test("without the pull option the server is the plain channel and exposes no tools", async t => {
  const { client, send, pushed } = await connect(t);
  assert.deepEqual(client.getServerCapabilities().experimental?.["claude/channel"], {});
  assert.equal(client.getServerCapabilities().tools, undefined);
  assert.equal(await send(1, "pushed"), 202);
  await new Promise(r => setTimeout(r, 100)); assert.deepEqual(pushed, ["notifications/claude/channel"]);
});
test("pull mode keeps batches for get_captions, never pushes, and hands out a cursor", async t => {
  const { client, send, read, pushed } = await connect(t, { LIVE_SUPPORT_TOOLS: "1" });
  assert.equal(client.getServerCapabilities().experimental, undefined);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["get_captions"]);
  assert.match(client.getInstructions(), /get_captions/);
  assert.deepEqual(await read({}), { cursor: 0, more: false, events: [] });
  assert.equal(await send(1, "first </channel> & more"), 202); assert.equal(await send(2, "second"), 202);
  const first = await read({});
  assert.deepEqual(first.events.map(e => [e.id, e.platform, e.sequence, e.meetingId, e.updates[0].transcript]), [[1, "Teams", 1, "demo", "first </channel> & more"], [2, "Teams", 2, "demo", "second"]]);
  assert.equal(first.cursor, 2);
  assert.deepEqual(await read({}), { cursor: 2, more: false, events: [] }, "the server remembers its own last read");
  assert.equal(await send(3, "third"), 202);
  assert.deepEqual((await read({ after: 1 })).events.map(e => e.id), [2, 3], "an explicit cursor is stateless");
  assert.deepEqual((await read({})).events.map(e => e.id), [3]);
  assert.equal(JSON.stringify(await client.callTool({ name: "get_captions", arguments: {} })).includes("<"), false, "markup is escaped");
  assert.equal((await client.callTool({ name: "get_captions", arguments: { after: -1 } })).isError, true);
  assert.equal((await client.callTool({ name: "other", arguments: {} })).isError, true);
  await new Promise(r => setTimeout(r, 100)); assert.deepEqual(pushed, []);
});
test("pull mode keeps only a bounded number of batches and flags what did not fit", async t => {
  const { send, read } = await connect(t, { LIVE_SUPPORT_TOOLS: "1" });
  for (let i = 1; i <= 205; i++) assert.equal(await send(i, "caption " + i), 202);
  const all = await read({ after: 0 }); assert.equal(all.events.length, 200); assert.equal(all.events[0].id, 6); assert.equal(all.cursor, 205);
  const big = "x".repeat(30000), session = "22222222-2222-4222-8222-222222222222";
  for (let i = 1; i <= 10; i++) assert.equal(await send(i, big, session), 202);
  const page = await read({ after: 205 }); assert.equal(page.more, true); assert.ok(page.events.length < 10 && page.events.length >= 1);
  const next = await read({ after: page.cursor }); assert.equal(next.events.length + page.events.length, 10);
});
