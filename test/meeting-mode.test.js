import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(".");
async function launch(t, fromHome = false) {
  const temp = await mkdtemp(join(tmpdir(), "meeting-mode-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const project = join(temp, "project"), runtime = join(temp, "private-runtime"), bin = join(temp, "bin");
  await mkdir(project); await mkdir(bin);
  const record = join(temp, "args.json"), fake = join(bin, "claude");
  await writeFile(fake, "#!" + process.execPath + "\nrequire('node:fs').writeFileSync(process.env.MEETING_ARGS,JSON.stringify(process.argv.slice(2)));\n");
  await chmod(fake, 0o755);
  const env = { ...process.env, PATH: bin, TACTIQ_PORT: "0", TACTIQ_RUNTIME_DIR: runtime, MEETING_ARGS: record };
  if (fromHome) env.HOME = project;
  const result = spawnSync(process.execPath, [join(root, "bin/tactiq-live.js"), "claude"], { cwd: project, env, encoding: "utf8", timeout: 10000 });
  return { result, args: result.status === 0 ? JSON.parse(await readFile(record, "utf8")) : [], runtime, project };
}
test("launch enables only Skill and project read tools with session-local plugin", async t => {
  const { result, args } = await launch(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Skill");
  assert.ok(!args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--restricted"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");
  assert.equal(args[args.indexOf("--plugin-dir") + 1], root);
  assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], join(root, "skills/meeting/SKILL.md"));
  assert.match(args.at(-1), /会議サポート/);
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
  for (const label of ["今の話", "相手の問い", "返答案", "根拠", "未確認", "Chrome"]) assert.ok(text.includes(label), label);
  const manifest = JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "tactiq-live");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, undefined);
  const p = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(p.files.includes("skills/") && p.files.includes(".claude-plugin/"));
});
