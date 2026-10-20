import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve("."), just = join(root, "justfile");
const available = spawnSync("just", ["--version"], { encoding: "utf8" }).status === 0;
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), "live-support-just-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bin = join(temp, "bin"), global = join(temp, "global packages"), runtime = join(temp, "runtime");
  await mkdir(bin); await mkdir(runtime);
  await writeFile(join(runtime, "keep"), "preserve user data");
  const record = join(temp, "commands.jsonl"), setup = join(temp, "setup.json");
  const packageBin = join(global, "live-support-channel/bin");
  await mkdir(packageBin, { recursive: true });
  await writeFile(join(packageBin, "live-support.js"), 'require("node:fs").writeFileSync(process.env.JUST_SETUP,JSON.stringify(process.argv.slice(2)));');
  const npm = join(bin, "npm");
  await writeFile(npm, "#!" + process.execPath + "\n" +
    'const fs=require("node:fs"),args=process.argv.slice(2);fs.appendFileSync(process.env.JUST_RECORD,JSON.stringify(args)+"\\n");' +
    'if(args[0]==="root")console.log(process.env.JUST_GLOBAL);if(args[0]==="install"&&process.env.JUST_FAIL)process.exit(7);\n');
  await chmod(npm, 0o755);
  await symlink(process.execPath, join(bin, "node"));
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, JUST_RECORD: record, JUST_GLOBAL: global, JUST_SETUP: setup, LIVE_SUPPORT_RUNTIME_DIR: runtime };
  return {
    env, runtime, setup,
    run(recipe) { return spawnSync("just", ["--justfile", just, recipe], { cwd: temp, env, encoding: "utf8", timeout: 10000 }); },
    async calls() { return (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse); },
  };
}
test("just install installs a copied local package then sets up that installed CLI", { skip: !available }, async t => {
  const f = await fixture(t), result = f.run("install");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.calls(), [
    ["install", "--global", "--ignore-scripts", "--install-links", "."],
    ["root", "--global"],
  ]);
  assert.deepEqual(JSON.parse(await readFile(f.setup, "utf8")), ["setup"]);
});
test("failed just install does not run setup", { skip: !available }, async t => {
  const f = await fixture(t); f.env.JUST_FAIL = "1";
  const result = f.run("install");
  assert.notEqual(result.status, 0);
  assert.deepEqual(await f.calls(), [["install", "--global", "--ignore-scripts", "--install-links", "."]]);
  await assert.rejects(readFile(f.setup, "utf8"));
});
test("just uninstall removes only the npm package and preserves runtime data", { skip: !available }, async t => {
  const f = await fixture(t), result = f.run("uninstall");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.calls(), [["uninstall", "--global", "live-support-channel"]]);
  assert.equal(await readFile(join(f.runtime, "keep"), "utf8"), "preserve user data");
  await assert.rejects(readFile(f.setup, "utf8"));
});
