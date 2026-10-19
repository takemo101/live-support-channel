import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

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
function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = chunk => {
      size += chunk.length;
      if (size > 262144) {
        req.removeListener("data", onData);
        req.resume();
        reject(413);
      } else chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(400));
    req.on("aborted", () => reject(400));
  });
}
export function createBridge({ token, publish, isReady = () => true }) {
  if (!text(token, 256) || token.length < 32) throw new Error("Pairing token must have at least 32 characters");
  const auth = Buffer.from("Bearer " + token);
  const sessions = new Map();
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
      if (req.method !== "POST" || req.url !== "/captions") { req.resume(); return reply(404); }
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
        const content = JSON.stringify({ meetingId: batch.meetingId, updates: batch.updates })
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
  return server;
}
