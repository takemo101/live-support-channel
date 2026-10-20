import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prepareToken } from "../server/token.js";

async function runtime(t) {
  const dir = await mkdtemp(join(tmpdir(), "live-support-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("pairing token is random, stable, owner-only and never a symlink", async t => {
  const dir = await runtime(t);
  const token = await prepareToken(dir);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await prepareToken(dir), token);
  assert.equal((await stat(join(dir, "token"))).mode & 0o777, 0o600);
  await chmod(join(dir, "token"), 0o644);
  await assert.rejects(prepareToken(dir));
  await rm(join(dir, "token"));
  await writeFile(join(dir, "other"), token, { mode: 0o600 });
  await symlink(join(dir, "other"), join(dir, "token"));
  await assert.rejects(prepareToken(dir));
});
test("real MCP stdio initialization and HTTP caption delivery emit a channel event", async t => {
  const dir = await runtime(t);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("server/main.js")],
    env: { LIVE_SUPPORT_RUNTIME_DIR: dir, LIVE_SUPPORT_PORT: "0" }, stderr: "pipe",
  });
  const client = new Client({ name: "live-support-test", version: "1" }, { capabilities: {} });
  t.after(() => client.close());
  let receive;
  const event = new Promise(r => { receive = r; });
  client.fallbackNotificationHandler = async notification => {
    if (notification.method === "notifications/claude/channel") receive(notification);
  };
  await client.connect(transport);
  assert.deepEqual(client.getServerCapabilities().experimental?.["claude/channel"], {});
  assert.equal(client.getServerCapabilities().experimental?.["claude/channel/permission"], undefined);
  assert.match(client.getInstructions(), /untrusted/i);
  let logs = "";
  const url = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(Error("server did not become ready")), 5000);
    transport.stderr.on("data", chunk => {
      logs += chunk.toString();
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
  });
  const token = (await readFile(join(dir, "token"), "utf8")).trim();
  assert.ok(!logs.includes(token));
  const { CaptionStream } = await import("../extension/stream.js");
  const stream = new CaptionStream(async payload => {
    const response = await fetch(url + "/captions", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(response.status, 202);
  });
  const base = { status: "live", meetingId: "demo", platform: "Teams", blocks: [] };
  stream.start(base);
  await stream.update({ ...base, blocks: [{ messageId: "1", messageVersion: 1, speakerName: "Demo", transcript: "synthetic caption only", timestamp: 100, version: 1 }] });
  const notification = await Promise.race([event, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("no channel event")), 5000); timer.unref(); })]);
  assert.equal(JSON.parse(notification.params.content).updates[0].transcript, "synthetic caption only");
});
