import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const platforms = new Set(["Google Meet", "Zoom", "Teams"]);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
function validBatch(b) {
  return b && typeof b === "object" && !Array.isArray(b)
    && keys(b, ["sessionId", "sequence", "meetingId", "platform", "updates"])
    && typeof b.sessionId === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(b.sessionId)
    && Number.isSafeInteger(b.sequence) && b.sequence > 0
    && text(b.meetingId, 512) && platforms.has(b.platform)
    && Array.isArray(b.updates) && b.updates.length > 0 && b.updates.length <= 64
    && b.updates.every(block => block && typeof block === "object" && !Array.isArray(block)
      && keys(block, ["messageId", "messageVersion", "speakerName", "transcript", "timestamp", "version", "deviceId"])
      && text(block.messageId, 512) && text(block.speakerName, 256)
      && typeof block.transcript === "string" && block.transcript.length <= 32768
      && Number.isSafeInteger(block.messageVersion) && block.messageVersion >= 0
      && Number.isFinite(block.timestamp) && block.timestamp >= 0
      && Number.isFinite(block.version) && block.version >= 0
      && (block.deviceId === undefined || text(block.deviceId, 512)));
}
const SCREENSHOT_LIMIT = 2097152, SCREENSHOT_KEEP = 30;
function bodyOf(req, limit = 262144, binary = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) {
        req.removeListener("data", onData);
        req.resume();
        reject(413);
      } else chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(400));
    req.on("aborted", () => reject(400));
  });
}
// `screenshots: { directory }` enables POST /screenshots: a JPEG of the meeting screen for the batch (sessionId, sequence) that is sent right after it.
// The file is stored privately and its absolute path is added to that batch's event; the newest SCREENSHOT_KEEP files are kept.
export function createBridge({ token, publish, isReady = () => true, screenshots = null }) {
  if (!text(token, 256) || token.length < 32) throw new Error("Pairing token must have at least 32 characters");
  const auth = Buffer.from("Bearer " + token);
  const sessions = new Map(), shots = new Map();
  let tail = Promise.resolve();
  const server = createServer(async (req, res) => {
    const reply = status => { res.writeHead(status, { "cache-control": "no-store" }); res.end(); };
    try {
      if (req.headers.host !== "127.0.0.1:" + server.address().port
        || (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin))) { req.resume(); return reply(403); }
      const provided = Buffer.from(req.headers.authorization ?? "");
      if (provided.length !== auth.length || !timingSafeEqual(provided, auth)) { req.resume(); return reply(401); }
      if (!isReady()) { req.resume(); return reply(503); }
      if (req.method === "GET" && req.url === "/health") return reply(200);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/screenshots" && screenshots) {
        const session = url.searchParams.get("sessionId"), sequence = Number(url.searchParams.get("sequence"));
        if (req.headers["content-type"]?.split(";")[0] !== "image/jpeg" || req.headers["content-encoding"]) { req.resume(); return reply(415); }
        if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(session ?? "") || !Number.isSafeInteger(sequence) || sequence < 1) { req.resume(); return reply(400); }
        const image = await bodyOf(req, SCREENSHOT_LIMIT, true);
        if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) return reply(400);
        await mkdir(screenshots.directory, { recursive: true, mode: 0o700 });
        const name = session.toLowerCase() + "-" + sequence + ".jpg", path = join(screenshots.directory, name), temp = join(screenshots.directory, ".tmp-" + randomUUID());
        try { await writeFile(temp, image, { mode: 0o600, flag: "wx" }); await rename(temp, path); } finally { await rm(temp, { force: true }); }
        const key = session.toLowerCase() + "/" + sequence;
        shots.delete(key); shots.set(key, path);
        while (shots.size > SCREENSHOT_KEEP) { const [oldKey, oldPath] = shots.entries().next().value; shots.delete(oldKey); await rm(oldPath, { force: true }); }
        return reply(202);
      }
      if (req.method !== "POST" || url.pathname !== "/captions") { req.resume(); return reply(404); }
      if (req.headers["content-type"]?.split(";")[0] !== "application/json" || req.headers["content-encoding"]) { req.resume(); return reply(415); }
      const raw = await bodyOf(req);
      let batch;
      try { batch = JSON.parse(raw); } catch { return reply(400); }
      if (!validBatch(batch)) return reply(400);
      const digest = createHash("sha256").update(raw).digest("hex");
      const delivery = tail.then(async () => {
        const previous = sessions.get(batch.sessionId);
        if (previous && (batch.meetingId !== previous.meetingId || batch.platform !== previous.platform)) throw 409;
        if (previous?.sequence === batch.sequence && previous.digest === digest) return;
        if (batch.sequence !== (previous?.sequence ?? 0) + 1) throw 409;
        if (!previous && sessions.size >= 32) throw 429;
        const screenshot = shots.get(batch.sessionId.toLowerCase() + "/" + batch.sequence);
        const content = JSON.stringify({ meetingId: batch.meetingId, updates: batch.updates, ...(screenshot ? { screenshot } : {}) })
          .replace(/[<>&]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
        await publish({
          method: "notifications/claude/channel",
          params: { content, meta: { platform: batch.platform, session_id: batch.sessionId, sequence: String(batch.sequence) } },
        });
        sessions.set(batch.sessionId, { meetingId: batch.meetingId, platform: batch.platform, sequence: batch.sequence, digest });
      });
      tail = delivery.catch(() => {});
      try { await delivery; } catch (error) { return reply(typeof error === "number" ? error : 503); }
      reply(202);
    } catch (error) { reply(error === 413 ? 413 : 400); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  // Removes every stored screenshot (the privacy default is to keep none once the receiver stops).
  server.clearScreenshots = async () => {
    shots.clear();
    if (!screenshots) return;
    try { for (const name of await readdir(screenshots.directory)) if (/^([\da-f-]{36}-\d+\.jpg|\.tmp-[\da-f-]{36})$/.test(name)) await rm(join(screenshots.directory, name), { force: true }); } catch {}
  };
  return server;
}
