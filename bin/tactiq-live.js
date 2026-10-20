#!/usr/bin/env node
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runtimeDirectory } from "../server/runtime.js";
import { prepareToken } from "../server/token.js";

const help = `Live Captions (Meet experimental) — one receiving Claude Code project at a time
  tactiq-live setup    Install Chrome extension assets in your user directory
  tactiq-live claude   Launch a meeting-enabled Claude Code in the current project
  tactiq-live token    Print the pairing token locally (never share it)
  tactiq-live --help   Show this help
`;

async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function setup(directory) {
  await prepareToken(directory);
  const destination = join(directory, "extension");
  const info = await existing(destination);
  if (info && !info.isDirectory()) throw new Error("Extension destination must be a real directory");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const source = fileURLToPath(new URL("../extension/", import.meta.url));
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const target = join(destination, entry.name);
    const before = await existing(target);
    if (!entry.isFile() || (before && !before.isFile())) throw new Error("Extension assets must be regular files");
    await copyFile(join(source, entry.name), target);
  }
  return destination;
}
async function renewToken(directory) {
  const temp = join(directory, ".token-" + randomUUID());
  try {
    await writeFile(temp, randomBytes(32).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, join(directory, "token"));
  } finally { await rm(temp, { force: true }); }
}
async function requireFreePort() {
  const port = Number(process.env.TACTIQ_PORT ?? 43821);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid receiver port");
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once("error", () => reject(new Error("Receiver port is in use. Stop the previous Claude Code before switching projects.")));
    probe.listen(port, "127.0.0.1", () => probe.close(accept));
  });
}
async function main() {
  const [command = "--help", ...extra] = process.argv.slice(2);
  if (extra.length || !["setup", "claude", "token", "--help", "-h"].includes(command)) throw new Error("Unknown command. Run tactiq-live --help.");
  if (command === "--help" || command === "-h") { console.log(help); return; }
  const directory = runtimeDirectory();
  if (command === "token") { console.log(await prepareToken(directory)); return; }
  if (command === "setup") {
    const extension = await setup(directory);
    console.log("Chrome extension directory:\n" + extension + "\nLoad it once via chrome://extensions.\nRun tactiq-live claude from your project, then tactiq-live token for pairing.");
    return;
  }
  const lockPath = join(directory, "launcher.lock");
  let lease, child, stopping;
  const cancel = signal => { stopping = signal; child?.kill(signal); };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  const checkCancellation = () => { if (stopping) throw new Error("Launch cancelled: " + stopping); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const project = process.cwd();
    if (dirname(project) === project || project === await realpath(homedir())) throw new Error("Start from a project directory, not your home or filesystem root.");
    checkCancellation();
    await requireFreePort();
    checkCancellation();
    await prepareToken(directory);
    checkCancellation();
    try { lease = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Previous launcher lock exists. Stop the previous Claude Code; after a crash, verify it has exited before removing launcher.lock.");
      throw error;
    }
    checkCancellation();
    await lease.writeFile(String(process.pid) + "\n");
    await setup(directory);
    checkCancellation();
    await renewToken(directory);
    checkCancellation();
    const config = { mcpServers: { "tactiq-live": {
      command: process.execPath,
      args: [fileURLToPath(new URL("../server/main.js", import.meta.url))],
      env: { TACTIQ_RUNTIME_DIR: directory },
    } } };
    const pluginRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
    const skillPath = join(pluginRoot, "skills/meeting/SKILL.md");
    const canonicalRuntime = await realpath(directory);
    const settings = {
      disableAllHooks: true,
      disableSkillShellExecution: true,
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        deny: [
          "Read(//**/.env)", "Read(//**/.env.*)", "Read(//**/*.pem)", "Read(//**/*.key)",
          "Read(//**/id_rsa*)", "Read(//**/id_ed25519*)", "Read(//**/.npmrc)", "Read(//**/.netrc)",
          "Read(//**/.git/**)", "Read(//**/.ssh/**)", "Read(//**/.aws/**)", "Read(//**/.claude/**)",
          "Read(/" + canonicalRuntime + "/**)",
        ],
      },
    };
    checkCancellation();
    console.error("Tactiq Live project: " + project);
    console.error("Meeting support: project read-only; pair with a fresh token from tactiq-live token.");
    child = spawn("claude", [
      "--mcp-config", JSON.stringify(config), "--strict-mcp-config",
      "--tools", "Read,Glob,Grep,Skill", "--restricted", "--permission-mode", "manual",
      "--plugin-dir", pluginRoot, "--settings", JSON.stringify(settings),
      "--append-system-prompt-file", skillPath,
      "--dangerously-load-development-channels", "server:tactiq-live", "--",
      "会議サポートモードを開始してください。まず本人の会議での表示名を確認し、このプロジェクトのCLAUDE.mdと必要な資料だけを読み取り、短く準備状況を伝えて字幕を待ってください。以後は字幕の変化に応じて、skillの書式（要点・相手の問い・返答案・提案）で、本人の発言を除き、字幕の不完全さに注意しながら日本語で短く更新してください。",
    ], { stdio: "inherit", env: process.env });
    try {
      const [code] = await once(child, "exit");
      process.exitCode = code ?? 1;
    } catch (error) { throw new Error("Could not launch Claude Code: " + error.code); }
  } finally {
    try {
      if (lease) {
        await lease.close();
        await rm(lockPath, { force: true });
      }
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  }
}
main().catch(error => { console.error("Tactiq Live: " + error.message); process.exitCode = 1; });
