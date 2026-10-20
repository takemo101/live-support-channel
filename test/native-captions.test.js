import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as reader from "../extension/snapshot.js";

const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => p && existsSync(p));

test("native reader exposes a self-contained page-context entry point", () => {
  assert.equal(typeof reader.readCaptions, "function");
});

test("native Meet reader and stream work against real Chrome synthetic DOM", { skip: !chrome }, async t => {
  assert.equal(typeof reader.readCaptions, "function");
  const temp = await mkdtemp(join(tmpdir(), "native-captions-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const streamSource = (await readFile(new URL("../extension/stream.js", import.meta.url), "utf8")).replace("export class CaptionStream", "class CaptionStream");
  const suite = async function () {
    const checks = [], sent = [];
    const eq = (a, b, name) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(name + ": " + JSON.stringify({ actual: a, expected: b })); checks.push(name); };
    const ok = (a, name) => eq(!!a, true, name);
    const meetingId = "meet.google.com/abc-defg-hij";
    let counter = 0, owner, firstRead = true;
    const command = (action, extra = {}) => {
      if (action === "read" && firstRead) { action = "start"; firstRead = false; }
      return capture({ action, meetingId, captureId: owner, ...extra });
    };
    function row(speaker, text) {
      const r = document.createElement("div");
      const name = document.createElement("div"), body = document.createElement("div");
      name.textContent = speaker; body.textContent = text; r.append(name, body); return r;
    }
    function fixture() {
      if (owner) command("reset");
      owner = "synthetic-" + (++counter); firstRead = true;
      location.hostname = "meet.google.com"; location.pathname = "/abc-defg-hij";
      document.body.innerHTML = '<button aria-label="Turn off captions (c)"></button><div role="region" tabindex="0" aria-label="Captions"><div><div>Alice</div><div>private baseline</div></div><div></div><div></div></div><div id="tactiq-content-div">PRIVATE_UNRELATED</div><div>PRIVATE_CHAT</div>';
      return document.querySelector('[role="region"]');
    }
    const add = (root, speaker, text) => { const r = row(speaker, text); root.insertBefore(r, root.children[root.children.length - 2]); return r; };

    let root = fixture();
    Object.defineProperty(window, "tactiq", { configurable: true, get() { throw Error("must never access another extension"); } });
    for (const node of [root, root.firstElementChild, ...root.firstElementChild.children]) Object.defineProperty(node, "textContent", { configurable: true, get() { throw Error("text read before consent"); } });
    const discovered = command("discover");
    eq(discovered.status, "ready", "metadata is ready without reading caption text");
    eq(discovered.meetings[0].id, meetingId, "metadata identifies current tab only");
    ok(!JSON.stringify(discovered).includes("PRIVATE_"), "metadata excludes all page text");

    root = fixture();
    const baseline = command("read");
    eq(baseline.status, "live", "read recognizes the native caption layout");
    eq(baseline.blocks[0].transcript, "private baseline", "caption text only");
    eq(baseline.blocks[0].speakerName, "Alice", "speaker paired to same row");
    ok(!JSON.stringify(baseline).includes("PRIVATE_CHAT"), "unrelated chat excluded");
    const stream = new CaptionStream(async payload => { sent.push(payload); });
    stream.start(baseline);
    root.firstElementChild.lastElementChild.textContent = "private baseline revised";
    await stream.update(command("read"));
    eq(sent.length, 0, "start-baseline revision never replays private prefix");
    const fresh = add(root, "Bob", "new caption");
    let snapshot = command("read");
    const first = snapshot.blocks[1];
    await stream.update(snapshot);
    eq(sent.length, 1, "new utterance is forwarded");
    eq(sent[0].updates.length, 1, "only new utterance sent");
    eq(command("read").blocks[1], first, "unchanged polls keep id and version stable");
    fresh.lastElementChild.textContent = "new caption corrected";
    snapshot = command("read");
    eq(snapshot.blocks[1].messageId, first.messageId, "revision retains utterance identity");
    ok(snapshot.blocks[1].messageVersion > first.messageVersion, "revision advances version");
    await stream.update(snapshot);
    eq(sent.length, 2, "revision reaches stream");
    add(root, "Bob", "new caption corrected");
    const repeated = command("read");
    ok(repeated.blocks[1].messageId !== repeated.blocks[2].messageId, "identical repeated utterances remain distinct");

    await stream.update({ status: "paused" });
    const oldOwner = owner;
    command("reset");
    add(root, "Carol", "private paused speech");
    owner = "resumed-" + (++counter); firstRead = true;
    const resumed = command("read");
    await stream.update(resumed);
    root.children[root.children.length - 3].lastElementChild.textContent += " revised";
    await stream.update(command("read"));
    eq(sent.length, 2, "resume excludes paused utterance including later revisions");
    command("reset", { captureId: oldOwner });
    eq(command("read").blocks[0].messageId, resumed.blocks[0].messageId, "stale cleanup cannot reset a new capture owner");
    add(root, "Dave", "after resume");
    await stream.update(command("read"));
    eq(sent.length, 3, "new post-resume utterance is sent");

    root = fixture(); command("read");
    root.replaceWith(root.cloneNode(true));
    eq(command("read").status, "ended", "root replacement fails closed");
    root = fixture(); command("read");
    root.firstElementChild.replaceWith(row("Alice", "private baseline revised"));
    eq(command("read").status, "ended", "unanchored row replacement fails closed");
    for (const resume of [false, true]) {
      root = fixture();
      if (!resume) add(root, "Bob", "private trailing baseline");
      const leaked = [], guarded = new CaptionStream(async payload => { leaked.push(payload); });
      guarded.start(command("read"));
      if (resume) {
        await guarded.update({ status: "paused" }); command("reset");
        add(root, "Bob", "private paused tail");
        owner = "tail-resume-" + (++counter); firstRead = true;
        await guarded.update(command("read"));
      }
      const tail = root.children[root.children.length - 3];
      tail.replaceWith(tail.cloneNode(true));
      const replaced = command("read"); await guarded.update(replaced);
      eq(leaked.length, 0, "trailing baseline replacement cannot leak: " + resume);
      eq(replaced.code, "CAPTION_SURFACE_CHANGED", "trailing replacement stops: " + resume);
    }
    root = fixture(); command("read");
    const anchor = add(root, "Bob", "anchor"); command("read");
    root.firstElementChild.remove();
    add(root, "Carol", "new after retained anchor");
    eq(command("read").status, "live", "append and old-row removal with retained anchor is allowed");
    root.insertBefore(row("Alice", "private old history"), anchor);
    eq(command("read").status, "ended", "inserted history before retained anchor fails closed");

    root = fixture(); root.removeAttribute("aria-label");
    eq(command("read").code, "CAPTION_IDENTITY_UNKNOWN", "generic regions are not assumed to be captions");
    root = fixture(); root.removeAttribute("aria-label"); root.id = "native-captions";
    document.querySelector("button").setAttribute("aria-controls", root.id);
    eq(command("read").status, "live", "explicit caption-control binding identifies a region");

    root = fixture();
    document.body.innerHTML = '<button aria-label="字幕をオフにする（c）"></button><div class="a4cQT"><div></div><div><section><div><div>Alice</div><div><span>legacy native caption</span></div></div></section></div></div>';
    eq(command("read").blocks[0].transcript, "legacy native caption", "historical layout is explicitly scoped");
    root = fixture();
    const second = root.cloneNode(true); document.body.append(second);
    eq(command("read").code, "AMBIGUOUS_CAPTIONS", "multiple regions are not guessed");
    root = fixture();
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    const framed = iframe.contentWindow.eval('(function(){const location={hostname:"meet.google.com",pathname:"/abc-defg-hij"};return (' + capture.toString() + ')({action:"discover"});})()');
    eq(framed.code, "UNSUPPORTED_FRAME", "child frame is not captured");

    for (const kind of ["row", "body", "descendant", "speaker"]) {
      root = fixture();
      const leaked = [], guarded = new CaptionStream(async payload => { leaked.push(payload); });
      guarded.start(command("read"));
      const hiddenRow = add(root, "Carol", "non-displayed caption");
      const surface = kind === "speaker" ? hiddenRow.firstElementChild : hiddenRow.lastElementChild;
      if (kind === "row") hiddenRow.style.display = "none";
      if (kind === "body") surface.style.visibility = "hidden";
      if (kind === "descendant") surface.innerHTML = '<span>visible words</span><span style="display:none">hidden history</span>';
      if (kind === "speaker") surface.style.opacity = "0";
      let textReads = 0;
      const getText = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").get;
      Object.defineProperty(surface, "textContent", { configurable: true, get() { textReads++; return getText.call(this); } });
      const rejected = command("read"); await guarded.update(rejected);
      eq(textReads, 0, "hidden surfaces are rejected before text access: " + kind);
      eq(leaked.length, 0, "non-displayed text is never forwarded: " + kind);
      eq(rejected.code, "CAPTION_LAYOUT_UNKNOWN", "hidden/unknown rows stop: " + kind);
    }
    root = fixture(); root.style.display = "none";
    ok(command("discover").captionReady === false, "hidden captions are not offered as ready");
    root = fixture(); document.querySelector("button").setAttribute("aria-label", "Turn on captions (c)");
    eq(command("read").code, "CAPTIONS_OFF", "captions off cannot release stale DOM");
    root = fixture(); document.querySelector("button").setAttribute("aria-label", "unrecognized captions UI");
    eq(command("read").code, "CAPTION_CONTROL_NOT_FOUND", "unknown controls are not mislabeled as captions-off");
    root = fixture(); root.firstElementChild.lastElementChild.textContent = "x".repeat(32769);
    eq(command("read").status, "unsupported", "oversize caption fails closed");
    root = fixture(); root.firstElementChild.firstElementChild.remove();
    eq(command("read").status, "unsupported", "unknown row shape fails closed");
    root = fixture(); document.body.classList.add("tactiq-nocc");
    eq(command("read").code, "CAPTIONS_HIDDEN", "Tactiq-hidden native captions are not captured");
    document.body.classList.remove("tactiq-nocc");
    root = fixture(); location.pathname = "/landing";
    eq(command("read").status, "ended", "URL change fails closed");
    root = fixture(); location.hostname = "evil.example";
    eq(command("discover").code, "UNSUPPORTED_HOST", "unsupported site is not read");
    location.hostname = "teams.microsoft.com";
    eq(command("discover").code, "PLATFORM_NOT_IMPLEMENTED", "Teams is explicitly not implemented");
    location.hostname = "app.zoom.us";
    eq(command("discover").code, "PLATFORM_NOT_IMPLEMENTED", "Zoom is explicitly not implemented");
    delete window.tactiq;
    return { checks, sent };
  };
  const html = '<!doctype html><html><body><script>(async()=>{const location={hostname:"meet.google.com",pathname:"/abc-defg-hij"};const capture=' + reader.readCaptions.toString() + ';' + streamSource + ';try{const result=await (' + suite.toString() + ')();document.body.innerHTML="";const p=document.createElement("pre");p.id="test-result";p.textContent=JSON.stringify({ok:true,...result});document.body.append(p);}catch(e){document.body.innerHTML="";const p=document.createElement("pre");p.id="test-result";p.textContent=JSON.stringify({ok:false,error:String(e),stack:e.stack});document.body.append(p);}})();</script></body></html>';
  const file = join(temp, "fixture.html"); await writeFile(file, html);
  const output = execFileSync(chrome, ["--headless=new", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + join(temp, "profile"), "--dump-dom", "--virtual-time-budget=2000", "file://" + file], { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const match = output.match(/<pre id="test-result">([\s\S]*?)<\/pre>/);
  assert.ok(match, "Chrome fixture did not return its results");
  const result = JSON.parse(match[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  assert.equal(result.ok, true, result.error + "\n" + result.stack);
  assert.ok(result.checks.length >= 25);
  assert.equal(result.sent.length, 3);
  assert.ok(!JSON.stringify(result.sent).includes("private baseline"));
  assert.ok(!JSON.stringify(result.sent).includes("private paused"));

  const runtime = join(temp, "runtime"); await mkdir(runtime, { mode: 0o700 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server/main.js", import.meta.url))], env: { TACTIQ_RUNTIME_DIR: runtime, TACTIQ_PORT: "0" }, stderr: "pipe" });
  const client = new Client({ name: "native-caption-fixture", version: "1" }, { capabilities: {} });
  let logs = "", readyTimer, eventTimer, finish;
  const endpoint = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(Error("receiver readiness timeout")), 5000);
    transport.stderr.on("data", chunk => {
      logs += chunk;
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(readyTimer); resolve(match[0]); }
    });
  });
  const events = [], received = new Promise(resolve => { finish = resolve; });
  client.fallbackNotificationHandler = async event => {
    if (event.method === "notifications/claude/channel") {
      events.push(JSON.parse(event.params.content));
      if (events.length === result.sent.length) finish();
    }
  };
  try {
    await client.connect(transport);
    const url = await endpoint, token = (await readFile(join(runtime, "token"), "utf8")).trim();
    for (const payload of result.sent) {
      const response = await fetch(url + "/captions", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) });
      assert.equal(response.status, 202);
    }
    await Promise.race([received, new Promise((_, reject) => { eventTimer = setTimeout(() => reject(Error("native fixture channel events missing")), 5000); })]);
    assert.equal(events.length, 3);
    assert.equal(events[0].updates[0].messageId, events[1].updates[0].messageId);
    assert.ok(events[1].updates[0].messageVersion > events[0].updates[0].messageVersion);
    assert.equal(events[2].updates[0].transcript, "after resume");
    assert.ok(!logs.includes(token));
    t.diagnostic(`Chrome synthetic DOM: ${result.checks.length} assertions; ${events.length} real HTTP/MCP events; no live meeting or model.`);
  } finally { clearTimeout(readyTimer); clearTimeout(eventTimer); await client.close(); }
});
