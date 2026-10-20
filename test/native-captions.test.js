import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readCaptions } from "../extension/snapshot.js";

const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => p && existsSync(p));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("RTC reader keeps its page-context entry point", () => assert.equal(typeof readCaptions, "function"));
test("real Chrome loopback RTC captions feed real HTTP/MCP with no meeting or model", { skip: !chrome, timeout: 30000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), "rtc-captions-"));
  let browser, socket;
  t.after(async () => {
    socket?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, "exit"); browser.kill("SIGTERM");
      await Promise.race([exited, delay(1000)]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
    }
    await rm(temp, { recursive: true, force: true });
  });
  const hook = await readFile(new URL("../extension/meet-hook.js", import.meta.url), "utf8");
  const streamSource = (await readFile(new URL("../extension/stream.js", import.meta.url), "utf8")).replace("export class CaptionStream", "class CaptionStream");
  const suite = async function (window, capture, ServerPeer) {
    let checks = 0, owner = "browser-capture-1", received = 0;
    const sent = [], remote = [], acknowledgments = [];
    const eq = (a, b, name) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(name); checks++; };
    const wait = async (predicate, name) => { const start = performance.now(); while (!predicate()) { if (performance.now() - start > 7000) throw Error(name + " timeout"); await new Promise(r => setTimeout(r, 10)); } };
    const call = action => capture({ action, meetingId: "meet.google.com/abc-defg-hij", captureId: owner });
    const stats = () => call("discover").diagnostics;
    const uint = n => { n = BigInt(n); const out = []; do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n); return out; };
    const field = (n, data) => [n * 8 + 2, ...uint(data.length), ...data];
    const string = (n, s) => field(n, [...new TextEncoder().encode(s)]);
    const wire = (id, text, revision = 1) => Uint8Array.from(field(1, [8, ...uint(id), 16, ...uint(revision), ...field(3, [...string(3, text), ...string(4, "en-US"), ...string(6, "private-device-id")])]));
    const client = new window.RTCPeerConnection({ iceServers: [] }), server = new ServerPeer({ iceServers: [] });
    const clientCandidates = [], serverCandidates = [];
    client.onicecandidate = e => { if (e.candidate) { if (server.remoteDescription) void server.addIceCandidate(e.candidate); else clientCandidates.push(e.candidate); } };
    server.onicecandidate = e => { if (e.candidate) { if (client.remoteDescription) void client.addIceCandidate(e.candidate); else serverCandidates.push(e.candidate); } };
    server.ondatachannel = event => { remote.push(event.channel); event.channel.addEventListener("message", e => acknowledgments.push([...new Uint8Array(e.data)])); };
    const transport = client.createDataChannel("collections");
    try {
      eq(call("discover").captionReady, false, "not ready before connected transport");
      await client.setLocalDescription(await client.createOffer()); await server.setRemoteDescription(client.localDescription);
      await server.setLocalDescription(await server.createAnswer()); await client.setRemoteDescription(server.localDescription);
      for (const c of clientCandidates) await server.addIceCandidate(c);
      for (const c of serverCandidates) await client.addIceCandidate(c);
      await wait(() => client.connectionState === "connected" && transport.readyState === "open", "local RTC connection");
      eq(call("discover").code, "READY", "prepared hook recognizes real RTC connection without caption DOM");
      eq(stats().received, 0, "pre-consent payload count is zero");
      const initial = call("start"); eq(initial.status, "live", "RTC bridge starts");
      eq(initial.blocks.length, 0, "no replay on start");
      const stream = new CaptionStream(async payload => { sent.push(payload); }); stream.start(initial);
      await wait(() => remote.some(c => c.label === "captions_v2" && c.readyState === "open"), "own caption subscription");
      let channel = remote.findLast(c => c.label === "captions_v2" && c.readyState === "open");
      const send = async (data) => { received++; channel.send(data); await wait(() => stats().received >= received && stats().queued === 0, "native caption event decoding"); };
      await send(wire(100, "private baseline")); await stream.update(call("read")); eq(sent.length, 0, "first utterance excluded");
      await send(wire(100, "private baseline corrected", 2)); await stream.update(call("read")); eq(sent.length, 0, "baseline revision excluded");
      await send(wire(101, "new caption")); await stream.update(call("read")); eq(sent.length, 1, "new native packet forwarded");
      await send(wire(101, "new caption corrected", 2)); await stream.update(call("read")); eq(sent.length, 2, "native packet revision forwarded");
      eq(sent[0].updates[0].messageId, sent[1].updates[0].messageId, "provider revision keeps local identity");
      eq(sent[1].updates[0].messageVersion, 2, "provider revision number retained");
      eq(sent[0].updates[0].speakerName, "話者 1（名前未確認）", "speaker names are not guessed");
      eq(JSON.stringify(sent).includes("private-device-id"), false, "internal device ID is not sent");
      await wait(() => acknowledgments.length >= 4, "own ACK responses");
      eq(acknowledgments[0], [10, 8, 10, 6, 8, 100, 16, 1, 24, 1], "v2 ACK wire shape");
      await stream.update({ status: "paused" }); call("reset");
      await wait(() => channel.readyState === "closed", "pause closes own channel");
      eq(transport.readyState, "open", "pause does not close native transport");
      owner = "browser-capture-2"; received = 0;
      await stream.update(call("start"));
      await wait(() => remote.some(c => c.label === "captions_v2" && c.readyState === "open"), "resumed subscription");
      channel = remote.findLast(c => c.label === "captions_v2" && c.readyState === "open");
      await send(wire(200, "private paused prefix")); await stream.update(call("read"));
      await send(wire(200, "private paused prefix revised", 2)); await stream.update(call("read")); eq(sent.length, 2, "resume initial utterance excluded");
      await send(wire(201, "after resume")); await stream.update(call("read")); eq(sent.length, 3, "new resumed utterance forwarded");
      eq(JSON.stringify(sent).includes("private"), false, "excluded text never reaches payloads");
      await send(Uint8Array.of(10, 255));
      eq(call("read").code, "CAPTION_FORMAT_UNKNOWN", "unknown protocol stops, not DOM fallback");
      eq(transport.readyState, "open", "decode failure preserves native transport");
      call("start"); await new Promise(r => setTimeout(r, 2150));
      eq(call("read").code, "CAPTURE_EXPIRED", "abandoned panel lease expires in real Chrome");
      eq(transport.readyState, "open", "lease expiry closes only owned resources");
      return { ok: true, checks, sent, acknowledgments: acknowledgments.length };
    } finally { call("reset"); client.close(); server.close(); }
  };
  const html = '<!doctype html><html><body><button aria-label="Turn off captions (c)">Captions</button><script>'
    + 'const ServerPeer=window.RTCPeerConnection;const values={location:{protocol:"https:",hostname:"meet.google.com",pathname:"/abc-defg-hij"},RTCPeerConnection:ServerPeer};let scope;scope=new Proxy(window,{get(target,key){if(key==="top")return scope;if(Object.hasOwn(values,key))return values[key];const v=target[key];return ["setTimeout","clearTimeout","addEventListener"].includes(key)?v.bind(target):v;},set(target,key,value){values[key]=value;return true;}});'
    + '(function(window){' + hook + '})(scope);'
    + 'window.__testPromise=(async function(window,location){const capture=' + readCaptions.toString() + ';' + streamSource
    + ';try{return await (' + suite.toString() + ')(window,capture,ServerPeer);}catch(e){return {ok:false,error:String(e),stack:e.stack};}})(scope,values.location);</script></body></html>';
  const file = join(temp, "fixture.html"), profile = join(temp, "profile"); await writeFile(file, html);
  browser = spawn(chrome, ["--headless=new", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profile, "file://" + file], { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.resume();
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch {}
    if (!port) { if (browser.exitCode !== null) throw Error("isolated Chrome exited"); await delay(20); }
  }
  assert.ok(port, "isolated Chrome did not expose its local test CDP endpoint");
  let target;
  for (let i = 0; i < 250 && !target; i++) {
    try { target = (await (await fetch("http://127.0.0.1:" + port + "/json/list")).json()).find(p => p.type === "page" && p.url.startsWith("file://")); } catch {}
    if (!target) await delay(20);
  }
  assert.ok(target, "isolated Chrome did not list its test page");
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  let next = 0; const pending = new Map();
  socket.addEventListener("message", event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result); } });
  const evaluate = expression => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(Error("Chrome test evaluation timeout")); }, 18000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });
  let evaluated;
  for (let attempt = 0; attempt < 10 && !evaluated; attempt++) {
    // The page may still be committing its navigation: a destroyed context is retried, anything else is a real failure.
    try { evaluated = await evaluate("(async () => { for (let i = 0; i < 500 && !window.__testPromise; i++) await new Promise(r => setTimeout(r, 20)); return window.__testPromise; })()"); }
    catch (error) { if (!/context was destroyed|Cannot find context/i.test(error.message) || attempt === 9) throw error; await delay(50); }
  }
  assert.equal(evaluated.exceptionDetails, undefined, evaluated.exceptionDetails?.text);
  const result = evaluated.result.value; assert.ok(result); assert.equal(result.ok, true, result.error + "\n" + result.stack);
  assert.ok(result.checks >= 20); assert.equal(result.sent.length, 3);

  const runtime = join(temp, "runtime"); await mkdir(runtime, { mode: 0o700 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server/main.js", import.meta.url))], env: { TACTIQ_RUNTIME_DIR: runtime, TACTIQ_PORT: "0" }, stderr: "pipe" });
  const client = new Client({ name: "rtc-caption-fixture", version: "1" }, { capabilities: {} });
  let logs = "", readyTimer, eventTimer, finish;
  const endpoint = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(Error("receiver readiness timeout")), 5000);
    transport.stderr.on("data", chunk => { logs += chunk; const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(readyTimer); resolve(match[0]); } });
  });
  const events = [], received = new Promise(resolve => { finish = resolve; });
  client.fallbackNotificationHandler = async event => { if (event.method === "notifications/claude/channel") { events.push(JSON.parse(event.params.content)); if (events.length === result.sent.length) finish(); } };
  try {
    await client.connect(transport); const url = await endpoint, token = (await readFile(join(runtime, "token"), "utf8")).trim();
    for (const payload of result.sent) assert.equal((await fetch(url + "/captions", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) })).status, 202);
    await Promise.race([received, new Promise((_, reject) => { eventTimer = setTimeout(() => reject(Error("RTC channel events missing")), 5000); })]);
    assert.equal(events.length, 3); assert.equal(events[0].updates[0].messageId, events[1].updates[0].messageId);
    assert.equal(events[2].updates[0].transcript, "after resume"); assert.ok(!logs.includes(token));
    t.diagnostic(`Chrome loopback RTC: ${result.checks} assertions, ${result.acknowledgments} own ACKs, ${events.length} real HTTP/MCP events; no live meeting/model.`);
  } finally { clearTimeout(readyTimer); clearTimeout(eventTimer); await client.close(); }
});
