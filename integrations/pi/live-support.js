// Live Support for pi and omp (same extension API): receives the caption batches the Chrome extension sends to 127.0.0.1 and hands them to the
// session as messages. No MCP server and no second process: the receiver runs inside the agent for as long as the session lives.
//
//   omp -e <this file> --append-system-prompt <skills/meeting/SKILL.md>
//   pi  -e <this file> --append-system-prompt <skills/meeting/SKILL.md>
//
// Pair the Chrome panel with `live-support token`. The token is renewed at every session start, like `live-support claude` does.
import { once } from "node:events";
import { createBridge } from "../../server/bridge.js";
import { instructions } from "../../server/instructions.js";
import { runtimeDirectory } from "../../server/runtime.js";
import { prepareToken, renewToken } from "../../server/token.js";

// Child sessions of one agent process load this module again with fresh APIs: only the session that started the receiver owns it.
const shared = { bridge: null, owner: null, ready: false, delivered: 0, introduced: false, url: null };

export default function liveSupport(pi) {
  const port = Number(process.env.LIVE_SUPPORT_PORT ?? 43821);

  // Resolves when the message is queued for the session; a failure becomes HTTP 503 so the panel resends it.
  async function publish(event) {
    const { content, meta } = event.params;
    const channel = `<channel source="live-support" platform="${meta.platform}" session_id="${meta.session_id}" sequence="${meta.sequence}">\n${content}\n</channel>`;
    const text = shared.introduced ? channel : `${instructions}\n\n${channel}`;
    await shared.owner.sendMessage({ customType: "live-support", content: text, display: true }, { deliverAs: "followUp", triggerTurn: true });
    shared.introduced = true; shared.delivered++;
  }

  async function start(ctx) {
    if (shared.bridge) return;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid LIVE_SUPPORT_PORT");
    const directory = runtimeDirectory();
    await prepareToken(directory); await renewToken(directory);
    const token = await prepareToken(directory);
    const bridge = createBridge({ token, isReady: () => shared.ready, publish });
    shared.bridge = bridge; shared.owner = pi;
    try {
      bridge.listen(port, "127.0.0.1"); await once(bridge, "listening");
    } catch (error) {
      shared.bridge = shared.owner = null;
      throw new Error(error.code === "EADDRINUSE" ? `port ${port} is in use (another live-support receiver, e.g. live-support claude?)` : (error.code ?? error.message));
    }
    shared.url = `http://127.0.0.1:${bridge.address().port}`; shared.ready = true; shared.delivered = 0; shared.introduced = false;
    ctx?.ui?.notify?.(`Live Support: receiving captions on ${shared.url}. Pair the Chrome panel with \`live-support token\`.`, "info");
  }

  function stop() {
    const bridge = shared.bridge;
    shared.bridge = shared.owner = null; shared.ready = false; shared.url = null;
    if (bridge) { bridge.closeAllConnections(); bridge.close(); }
  }

  pi.on("session_start", async (_event, ctx) => {
    try { await start(ctx); } catch (error) { ctx?.ui?.notify?.(`Live Support could not start: ${error.message}`, "error"); }
  });
  pi.on("session_shutdown", () => { if (shared.owner === pi) stop(); });
  pi.registerCommand("live-support", {
    description: "Show the Live Support caption receiver status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(shared.bridge ? `Live Support: listening on ${shared.url}; ${shared.delivered} caption batch(es) delivered to this session. Pair with \`live-support token\`.`
        : "Live Support: the receiver is not running (see the start error, or another session owns it).", "info");
    },
  });
}
