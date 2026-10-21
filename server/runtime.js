import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where the meeting-screen screenshots the panel uploads are kept (a sibling of the runtime directory, never inside it: the agent may read this one,
// and the pairing token lives in the other). LIVE_SUPPORT_SCREENSHOT_DIR overrides.
export function screenshotDirectory(env = process.env) {
  return env.LIVE_SUPPORT_SCREENSHOT_DIR ? resolve(env.LIVE_SUPPORT_SCREENSHOT_DIR) : runtimeDirectory(env) + "-screens";
}
export function runtimeDirectory(env = process.env) {
  return env.LIVE_SUPPORT_RUNTIME_DIR ? resolve(env.LIVE_SUPPORT_RUNTIME_DIR) : join(homedir(), ".live-support");
}
