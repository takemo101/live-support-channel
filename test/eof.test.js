import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("MCP stdin EOF closes the HTTP listener and process without a kill signal", { timeout: 8000 }, async t => {
  const runtime = await mkdtemp(join(tmpdir(), "live-support-eof-"));
  const child = spawn(process.execPath, [resolve("server/main.js")], {
    env: { LIVE_SUPPORT_RUNTIME_DIR: runtime, LIVE_SUPPORT_PORT: "0" }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } await rm(runtime, { recursive: true, force: true }); });
  let stderr = "", stdout = "";
  const waiting = new Map();
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    let end;
    while ((end = stdout.indexOf("\n")) >= 0) {
      const message = JSON.parse(stdout.slice(0, end)); stdout = stdout.slice(end + 1);
      waiting.get(message.id)?.(message); waiting.delete(message.id);
    }
  });
  const urlPromise = new Promise(accept => child.stderr.on("data", chunk => {
    stderr += chunk.toString();
    const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) accept(match[0]);
  }));
  function request(id, method, params) {
    const reply = new Promise(accept => waiting.set(id, accept));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    return reply;
  }
  await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eof-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await request(2, "ping");
  const url = await urlPromise;
  const token = (await readFile(join(runtime, "token"), "utf8")).trim();
  assert.equal((await fetch(url + "/health", { headers: { authorization: "Bearer " + token } })).status, 200);
  const exit = once(child, "exit");
  child.stdin.end();
  let timer;
  try {
    const [code] = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("MCP stdin EOF left the bridge running")), 1500); })]);
    assert.equal(code, 0);
  } finally { clearTimeout(timer); }
  await assert.rejects(fetch(url + "/health", { headers: { authorization: "Bearer " + token } }));
});
