import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function runtimeDirectory(env = process.env) {
  return env.LIVE_SUPPORT_RUNTIME_DIR ? resolve(env.LIVE_SUPPORT_RUNTIME_DIR) : join(homedir(), ".live-support");
}
