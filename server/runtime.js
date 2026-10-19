import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function runtimeDirectory(env = process.env) {
  return env.TACTIQ_RUNTIME_DIR ? resolve(env.TACTIQ_RUNTIME_DIR) : join(homedir(), ".tactiq-live-channel");
}
