import test from "node:test";
import assert from "node:assert/strict";
import { chrome, runInChrome } from "../test-support/chrome.js";

test("real Chrome loopback RTC: Teams main-channel results are observed without any own channel or send", { skip: !chrome, timeout: 30000 }, async t => {
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
  const result = await runInChrome(t, { hook: "teams-hook.js", hostname: "teams.microsoft.com", pathname: "/v2/", suite });
  assert.ok(result.checks >= 14);
  t.diagnostic(`Chrome loopback RTC (Teams): ${result.checks} assertions; synthetic main-channel only, no live meeting.`);
});
