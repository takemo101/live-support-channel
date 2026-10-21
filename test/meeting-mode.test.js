import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(".");
async function launch(t, fromHome = false, extraEnv = {}) {
  const temp = await mkdtemp(join(tmpdir(), "meeting-mode-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const project = join(temp, "project"), runtime = join(temp, "private-runtime"), bin = join(temp, "bin");
  await mkdir(project); await mkdir(bin);
  const record = join(temp, "args.json"), fake = join(bin, "claude");
  await writeFile(fake, "#!" + process.execPath + "\nrequire('node:fs').writeFileSync(process.env.MEETING_ARGS,JSON.stringify(process.argv.slice(2)));\n");
  await chmod(fake, 0o755);
  const env = { ...process.env, PATH: bin, LIVE_SUPPORT_PORT: "0", LIVE_SUPPORT_RUNTIME_DIR: runtime, MEETING_ARGS: record, ...extraEnv };
  if (fromHome) env.HOME = project;
  const result = spawnSync(process.execPath, [join(root, "bin/live-support.js"), "claude"], { cwd: project, env, encoding: "utf8", timeout: 10000 });
  return { result, args: result.status === 0 ? JSON.parse(await readFile(record, "utf8")) : [], runtime, project };
}
test("launch enables only Skill, project read tools and web search with session-local plugin", async t => {
  const { result, args } = await launch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Skill,WebSearch,WebFetch");
  const permissions = JSON.parse(args[args.indexOf("--settings") + 1]).permissions;
  assert.deepEqual(permissions.allow, ["WebSearch"], "search runs on its own; WebFetch stays behind the manual approval");
  assert.ok(!args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--restricted"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");
  assert.equal(args[args.indexOf("--plugin-dir") + 1], root);
  assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], join(root, "skills/meeting/SKILL.md"));
  assert.match(args.at(-1), /会議サポート/);
});
test("LIVE_SUPPORT_WEB=0 turns the web tools off completely", async t => {
  const { result, args } = await launch(t, false, { LIVE_SUPPORT_WEB: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Skill");
  assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).permissions.allow, undefined);
});
test("startup prompt is separated from the variadic development-channel option", async t => {
  const { result, args } = await launch(t);
  assert.equal(result.status, 0, result.stderr);
  const channel = args.indexOf("--dangerously-load-development-channels");
  const separator = args.indexOf("--");
  assert.ok(separator > channel, "startup prompt needs -- to end the variadic channel list");
  assert.deepEqual(args.slice(channel + 1, separator), ["server:live-support"]);
  assert.equal(args.slice(separator + 1).length, 1);
  assert.match(args[separator + 1], /^会議サポートモードを開始してください/);
});
test("read-only session disables hooks and fences secret/runtime files", async t => {
  const { result, args, runtime } = await launch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(args.includes("--settings"));
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.disableSkillShellExecution, true);
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  for (const rule of ["Read(//**/.env)", "Read(//**/.env.*)", "Read(//**/*.pem)", "Read(//**/*.key)", "Read(//**/.git/**)"]) assert.ok(settings.permissions.deny.includes(rule), rule);
  const canonical = await realpath(runtime);
  assert.ok(settings.permissions.deny.includes("Read(/" + canonical + "/**)"));
});
test("home-directory launch is refused before reading or preparing project context", async t => {
  const { result, runtime } = await launch(t, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Start from a project directory/);
  await assert.rejects(access(runtime));
});
test("plugin uses the repository-root skills directory and is included in npm files", async () => {
  const skill = join(root, "skills/meeting/SKILL.md");
  assert.equal(await access(skill).then(() => true, () => false), true, "meeting skill is missing");
  const text = await readFile(skill, "utf8");
  assert.match(text, /^---\nname: meeting\n/);
  assert.match(text, /description: Use when/);
  assert.match(text, /disable-model-invocation: true/);
  assert.ok(!text.includes("context: fork"));
  assert.match(text, /^allowed-tools: Read, Glob, Grep, WebSearch$/m, "the skill reads the project and searches the web, nothing else");
  assert.ok(text.includes("Chromeパネルの停止ボタン"), "ending advice must say the transport keeps running");
  const manifest = JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "live-support");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, undefined);
  const p = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(p.files.includes("skills/") && p.files.includes(".claude-plugin/"));
});
test("launch gives the agent a private screenshot directory beside, not inside, the runtime directory", async t => {
  const { result, args, runtime } = await launch(t);
  assert.equal(result.status, 0, result.stderr);
  const screens = runtime + "-screens";
  assert.equal(args[args.indexOf("--add-dir") + 1], screens, "the agent may read the screenshots");
  assert.ok(!args.includes(runtime), "the runtime directory (token) is never added");
  assert.ok(!(screens + "/").startsWith(runtime + "/"), "outside the denied runtime tree");
  assert.equal((await stat(screens)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers["live-support"].env.LIVE_SUPPORT_SCREENSHOT_DIR, screens);
});
