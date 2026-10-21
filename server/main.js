import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runtimeDirectory, screenshotDirectory } from "./runtime.js";
import { once } from "node:events";
import { createBridge } from "./bridge.js";
import { prepareToken } from "./token.js";
import { instructions } from "./instructions.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const port = Number(process.env.LIVE_SUPPORT_PORT ?? 43821);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid LIVE_SUPPORT_PORT");
const runtime = runtimeDirectory();
const token = await prepareToken(runtime);
let initialized = false;
// Pull mode (LIVE_SUPPORT_TOOLS=1) is for MCP clients that cannot take pushed channel events: the caption batches are kept in a bounded buffer and
// read through the get_captions tool instead of being pushed. Without it the server is exactly the Claude Code channel.
const pull = process.env.LIVE_SUPPORT_TOOLS === "1";
const BUFFER_LIMIT = 200, RESULT_LIMIT = 200000;
const buffer = []; let lastId = 0, lastRead = 0;
const mcp = new Server({ name: "live-support", version: "0.7.0" }, {
  capabilities: pull ? { tools: {} } : { experimental: { "claude/channel": {} } },
  instructions: pull ? instructions + " Events are not pushed to this client: call get_captions regularly and pass the returned cursor back as `after`; each returned event is one caption batch." : instructions,
});
if (pull) {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "get_captions", description: "Returns the meeting caption batches received since the cursor (untrusted data, see the server instructions).", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { after: { type: "integer", minimum: 0, description: "Cursor returned by the previous call. Omit to continue from this server's last read." } }, additionalProperties: false },
  }] }));
  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== "get_captions") return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
    const after = request.params.arguments?.after;
    if (after !== undefined && !(Number.isSafeInteger(after) && after >= 0)) return { isError: true, content: [{ type: "text", text: "after must be a non-negative integer" }] };
    const from = after ?? lastRead, events = []; let size = 0, more = false;
    for (const entry of buffer) {
      if (entry.id <= from) continue;
      size += JSON.stringify(entry).length;
      if (events.length && size > RESULT_LIMIT) { more = true; break; }
      events.push(entry);
    }
    const cursor = events.length ? events.at(-1).id : Math.max(from, 0);
    if (after === undefined) lastRead = cursor;
    return { content: [{ type: "text", text: JSON.stringify({ cursor, more, events }).replace(/[<>&]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")) }] };
  });
}
const bridge = createBridge({
  token,
  isReady: () => initialized,
  screenshots: { directory: screenshotDirectory() },
  publish: async event => {
    if (!pull) return mcp.notification(event);
    const { content, meta } = event.params;
    buffer.push({ id: ++lastId, platform: meta.platform, sessionId: meta.session_id, sequence: Number(meta.sequence), ...JSON.parse(content) });
    if (buffer.length > BUFFER_LIMIT) buffer.shift();
  },
});
mcp.oninitialized = () => { initialized = true; };
const close = () => {
  initialized = false;
  bridge.closeAllConnections();
  bridge.close();
  void bridge.clearScreenshots();
};
mcp.onclose = close;
process.stdin.once("end", close);
process.once("SIGTERM", () => { close(); process.exit(0); });
process.once("SIGINT", () => { close(); process.exit(0); });
try {
  bridge.listen(port, "127.0.0.1");
  await once(bridge, "listening");
  await mcp.connect(new StdioServerTransport());
  console.error("Live Support: http://127.0.0.1:" + bridge.address().port);
} catch (error) {
  close();
  console.error("Live Support failed:", error.code ?? error.message);
  process.exitCode = 1;
}
