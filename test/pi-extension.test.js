import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let n = 0;
async function agent(t, { port = "0", directory } = {}) {
  const runtime = directory ?? await mkdtemp(join(tmpdir(), "live-support-pi-"));
  if (!directory) t.after(() => rm(runtime, { recursive: true, force: true }));
  process.env.LIVE_SUPPORT_RUNTIME_DIR = runtime; process.env.LIVE_SUPPORT_PORT = port;
  const { default: extension } = await import(pathToFileURL(join(process.cwd(), "integrations/pi/live-support.js")).href + "?run=" + ++n);
  const handlers = new Map(), commands = new Map(), sent = [], notes = [];
  const pi = { on: (name, fn) => handlers.set(name, fn), registerCommand: (name, def) => commands.set(name, def),
    sendMessage: async (message, options) => { if (pi.fail) throw new Error("queue closed"); sent.push({ message, options }); } };
  extension(pi);
  const ctx = { ui: { notify: (text, level) => notes.push([text, level]) } };
  const session = { start: () => handlers.get("session_start")({}, ctx), shutdown: () => handlers.get("session_shutdown")({}, ctx) };
  return { pi, sent, notes, runtime, session, commands, ctx, url: () => notes.at(-1)[0].match(/http:\/\/127\.0\.0\.1:\d+/)[0] };
}
const batch = (sequence, transcript, sessionId = "33333333-3333-4333-8333-333333333333") => ({ sessionId, sequence, meetingId: "demo", platform: "Zoom",
  updates: [{ messageId: "m" + sequence, messageVersion: 1, speakerName: "Demo", transcript, timestamp: 1, version: 1 }] });
const post = async (url, token, body) => (await fetch(url + "/captions", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) })).status;

test("the extension starts a receiver with a fresh token and delivers each batch to the session as a follow-up that starts a turn", async t => {
  const a = await agent(t); await mkdir(a.runtime, { recursive: true, mode: 0o700 });
  const old = "o".repeat(43); await writeFile(join(a.runtime, "token"), old + "\n", { mode: 0o600 });
  await a.session.start(); t.after(() => a.session.shutdown());
  const token = (await readFile(join(a.runtime, "token"), "utf8")).trim();
  assert.notEqual(token, old, "the pairing token is renewed for this session"); assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await post(a.url(), old, batch(1, "stale")), 401); assert.equal(a.sent.length, 0);
  assert.equal(await post(a.url(), token, batch(1, "hello <b>")), 202);
  assert.equal(await post(a.url(), token, batch(2, "again")), 202);
  assert.equal(a.sent.length, 2);
  const [first, second] = a.sent;
  assert.equal(first.message.customType, "live-support"); assert.deepEqual(first.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(first.message.content, /untrusted/i, "the first message carries the instructions"); assert.doesNotMatch(second.message.content, /untrusted/i);
  assert.match(second.message.content, /^<channel source="live-support" platform="Zoom" session_id="33333333-3333-4333-8333-333333333333" sequence="2">\n\{.*"transcript":"again".*\}\n<\/channel>$/s);
  assert.ok(!first.message.content.includes("<b>"), "markup in captions is escaped");
});
test("a failed hand-over answers 503 so the panel resends; shutdown closes the receiver; the status command reports it", async t => {
  const a = await agent(t); await a.session.start();
  const url = a.url(), token = (await readFile(join(a.runtime, "token"), "utf8")).trim();
  a.pi.fail = true; assert.equal(await post(url, token, batch(1, "lost")), 503);
  a.pi.fail = false; assert.equal(await post(url, token, batch(1, "lost")), 202, "the same batch is accepted once the session takes it");
  await a.commands.get("live-support").handler("", a.ctx);
  assert.match(a.notes.at(-1)[0], /listening on http:\/\/127\.0\.0\.1:\d+; 1 caption batch/);
  await a.session.shutdown();
  await assert.rejects(fetch(url + "/health", { headers: { authorization: "Bearer " + token } }));
  await a.commands.get("live-support").handler("", a.ctx); assert.match(a.notes.at(-1)[0], /not running/);
});
test("a child session of the same process neither starts a second receiver nor stops the owner's", async t => {
  const a = await agent(t); await a.session.start(); t.after(() => a.session.shutdown());
  const url = a.url(), token = (await readFile(join(a.runtime, "token"), "utf8")).trim();
  const noteCount = a.notes.length;
  const handlers = new Map(), childPi = { on: (name, fn) => handlers.set(name, fn), registerCommand() {}, sendMessage: async () => { throw new Error("must not receive"); } };
  const { default: extension } = await import(pathToFileURL(join(process.cwd(), "integrations/pi/live-support.js")).href + "?run=" + n);
  extension(childPi); await handlers.get("session_start")({}, { ui: { notify() { throw new Error("child must stay silent"); } } });
  await handlers.get("session_shutdown")({}, {});
  assert.equal(await post(url, token, batch(1, "owner still serves")), 202); assert.equal(a.sent.length, 1); assert.equal(a.notes.length, noteCount);
});
test("a port that is already in use is reported to the user without crashing the session", async t => {
  const busy = createServer(); await new Promise(r => busy.listen(0, "127.0.0.1", r)); t.after(() => busy.close());
  const a = await agent(t, { port: String(busy.address().port) });
  await assert.doesNotReject(a.session.start());
  assert.equal(a.notes.at(-1)[1], "error"); assert.match(a.notes.at(-1)[0], /in use/);
});
