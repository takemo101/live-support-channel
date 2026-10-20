import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptions } from "../extension/snapshot.js";

const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => p && existsSync(p));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("real Chrome loopback RTC: Teams main-channel results are observed without any own channel or send", { skip: !chrome, timeout: 30000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), "teams-rtc-"));
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
  const hook = await readFile(new URL("../extension/teams-hook.js", import.meta.url), "utf8");
  const suite = async function (window, capture, ServerPeer) {
    let checks = 0, owner = "browser-teams-1";
    const remote = [];
    const eq = (a, b, name) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(name + ": " + JSON.stringify(a)); checks++; };
    const wait = async (predicate, name) => { const start = performance.now(); while (!predicate()) { if (performance.now() - start > 7000) throw Error(name + " timeout"); await new Promise(r => setTimeout(r, 10)); } };
    const call = (action, extra = {}) => capture({ action, meetingId: "teams.microsoft.com/call", captureId: owner, ...extra });
    const item = (ts, userId, version, text) => ({ id: "m" + ts + "/" + version, userId, timestampAudioSent: ts, text });
    const client = new window.RTCPeerConnection({ iceServers: [] }), server = new ServerPeer({ iceServers: [] });
    const clientCandidates = [], serverCandidates = [];
    client.onicecandidate = e => { if (e.candidate) { if (server.remoteDescription) void server.addIceCandidate(e.candidate); else clientCandidates.push(e.candidate); } };
    server.onicecandidate = e => { if (e.candidate) { if (client.remoteDescription) void client.addIceCandidate(e.candidate); else serverCandidates.push(e.candidate); } };
    server.ondatachannel = event => { remote.push(event.channel); event.channel.binaryType = "arraybuffer"; };
    const collections = client.createDataChannel("collections"), main = client.createDataChannel("main-channel");
    const created = () => remote.map(c => c.label);
    try {
      eq(call("discover").captionReady, false, "not ready before connection");
      await client.setLocalDescription(await client.createOffer()); await server.setRemoteDescription(client.localDescription);
      await server.setLocalDescription(await server.createAnswer()); await client.setRemoteDescription(server.localDescription);
      for (const c of clientCandidates) await server.addIceCandidate(c);
      for (const c of serverCandidates) await client.addIceCandidate(c);
      await wait(() => client.connectionState === "connected" && main.readyState === "open" && remote.length === 2, "local RTC connection");
      const toServer = remote.find(c => c.label === "main-channel");
      const send = async (value, prefix = "") => { const before = call("discover").diagnostics.received; toServer.send(new TextEncoder().encode(prefix + JSON.stringify(value))); return before; };
      const settle = async received => wait(() => call("discover").diagnostics.received >= received, "message delivery");
      const meta = call("discover"); eq([meta.code, meta.platform], ["READY", "Teams"], "real RTC connection recognised");
      eq(call("discover").diagnostics.received, 0, "no pre-consent payload");
      eq(call("start").status, "live", "observation starts");
      await send({ recognitionResults: [item(100, "u1", 1, "private baseline")] }, "3:::"); await settle(1);
      await send({ recognitionResults: [item(100, "u1", 2, "private baseline revised")] }); await settle(2);
      await send({ somethingElse: true }); await send({ recognitionResults: [item(101, "u1", 1, "fresh caption")] }); await settle(3);
      await send({ recognitionResults: [item(101, "u1", 2, "fresh caption revised")] }); await settle(4);
      const read = call("read");
      eq(read.blocks.map(b => b.transcript), ["fresh caption revised"], "baseline excluded, revisions upserted");
      eq(read.blocks.map(b => b.deviceId), ["speaker-1"], "opaque user id stays in the page");
      eq(JSON.stringify(read).includes("u1"), false, "user id not exposed");
      eq(created(), ["collections", "main-channel"], "reader created no channel of its own");
      eq(call("read").status, "live", "still live");
      eq(collections.readyState + main.readyState, "openopen", "app channels untouched");
      call("start", { captureId: owner = "browser-teams-2" }); await new Promise(r => setTimeout(r, 2150));
      eq(call("read").code, "CAPTURE_EXPIRED", "abandoned lease expires in real Chrome");
      eq(call("recover", { captureId: "browser-teams-3", previousCaptureId: owner }).status, "live", "recover continues the same connection");
      owner = "browser-teams-3";
      await send({ recognitionResults: [item(300, "u1", 1, "first after recovery")] }); await settle(1);
      await send({ recognitionResults: [item(301, "u1", 1, "second after recovery")] }); await settle(2);
      eq(call("read").blocks.map(b => b.transcript), ["second after recovery"], "first utterance re-excluded after recovery");
      eq(main.readyState, "open", "recovery keeps the app channel");
      return { ok: true, checks };
    } finally { call("reset"); client.close(); server.close(); }
  };
  const html = '<!doctype html><html><body><script>'
    + 'const ServerPeer=window.RTCPeerConnection;const values={location:{protocol:"https:",hostname:"teams.microsoft.com",pathname:"/v2/"},RTCPeerConnection:ServerPeer};let scope;scope=new Proxy(window,{get(target,key){if(key==="top")return scope;if(Object.hasOwn(values,key))return values[key];const v=target[key];return ["setTimeout","clearTimeout","addEventListener"].includes(key)?v.bind(target):v;},set(target,key,value){values[key]=value;return true;}});'
    + '(function(window){' + hook + '})(scope);'
    + 'window.__testPromise=(async function(window,location){const capture=' + readCaptions.toString() + ';'
    + 'try{return await (' + suite.toString() + ')(window,capture,ServerPeer);}catch(e){return {ok:false,error:String(e),stack:e.stack};}})(scope,values.location);</script></body></html>';
  const file = join(temp, "fixture.html"), profile = join(temp, "profile"); await writeFile(file, html);
  browser = spawn(chrome, ["--headless=new", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profile, "file://" + file], { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.resume();
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch {}
    if (!port) { if (browser.exitCode !== null) throw Error("isolated Chrome exited"); await delay(20); }
  }
  assert.ok(port, "isolated Chrome did not expose its local test CDP endpoint");
  const pages = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const target = pages.find(p => p.type === "page"); assert.ok(target);
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  let next = 0; const pending = new Map();
  socket.addEventListener("message", event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result); } });
  const evaluate = expression => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(Error("Chrome test evaluation timeout")); }, 18000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });
  const evaluated = await evaluate("window.__testPromise");
  assert.equal(evaluated.exceptionDetails, undefined, evaluated.exceptionDetails?.text);
  const result = evaluated.result.value; assert.ok(result); assert.equal(result.ok, true, result.error + "\n" + result.stack);
  assert.ok(result.checks >= 14);
  t.diagnostic(`Chrome loopback RTC (Teams): ${result.checks} assertions; synthetic main-channel only, no live meeting.`);
});
