import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, access, realpath, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { runtimeDirectory } from "../server/runtime.js";

const cli = resolve("bin/live-support.js");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "live-support-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  const runtime = join(root, "user-runtime");
  const env = { ...process.env, PATH: join(root, "no-executables"), LIVE_SUPPORT_RUNTIME_DIR: runtime };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8", timeout: 10000 });
  return { root, project, runtime, env, run };
}
test("default runtime is user-scoped, not package or project-scoped", () => {
  assert.equal(runtimeDirectory({}), join(homedir(), ".live-support"));
  assert.equal(runtimeDirectory({ LIVE_SUPPORT_RUNTIME_DIR: "/tmp/live-support-override" }), "/tmp/live-support-override");
});
test("package exposes an installable CLI and restricts shipped files", async () => {
  const p = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(p.bin?.["live-support"], "bin/live-support.js");
  for (const path of ["bin/", "server/", "extension/", "SPEC.md"]) assert.ok(p.files.includes(path));
  for (const path of ["artifacts/", "research/", "test/", ".runtime/"]) assert.ok(!p.files.includes(path));
});
test("help does not create a token or launch Claude; unknown commands fail", async t => {
  const f = await fixture(t);
  const p = f.run("--help");
  assert.equal(p.status, 0);
  assert.match(p.stdout, /setup/);
  await assert.rejects(access(f.runtime));
  assert.equal(f.run("unknown").status, 1);
});
test("agents prints runnable commands for omp, pi and agy that point at files that exist, and writes nothing", async t => {
  const f = await fixture(t);
  const p = f.run("agents");
  assert.equal(p.status, 0, p.stderr);
  await assert.rejects(access(f.runtime));
  for (const path of p.stdout.match(/\/[^\s"]+\.(?:js|md)\b/g)) await access(path);
  assert.match(p.stdout, /omp -e \S+integrations\/pi\/live-support\.js --append-system-prompt \S+SKILL\.md/);
  assert.match(p.stdout, /\bpi -e /); assert.match(p.stdout, /mcp\(live-support\/get_captions\)/); assert.match(p.stdout, /LIVE_SUPPORT_TOOLS/);
  const pack = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pack.files.includes("integrations/"), "the extension ships with the package");
});
test("setup installs extension assets outside projects without exposing the token", async t => {
  const f = await fixture(t);
  const p = f.run("setup");
  assert.equal(p.status, 0, p.stderr);
  const token = (await readFile(join(f.runtime, "token"), "utf8")).trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!p.stdout.includes(token));
  const expected = await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8");
  assert.equal(await readFile(join(f.runtime, "extension/manifest.json"), "utf8"), expected);
  assert.ok(p.stdout.includes(join(f.runtime, "extension")));
  await assert.rejects(access(join(f.project, ".runtime")));
});
test("token prints only the locally prepared pairing value", async t => {
  const f = await fixture(t);
  assert.equal(f.run("setup").status, 0);
  const p = f.run("token");
  assert.equal(p.status, 0);
  assert.equal(p.stdout.trim(), (await readFile(join(f.runtime, "token"), "utf8")).trim());
});
test("Claude launcher preserves each project cwd and isolates launch tokens", async t => {
  const f = await fixture(t);
  const bin = join(f.root, "fake-bin");
  const record = join(f.root, "claude-record.json");
  await mkdir(bin);
  const fake = join(bin, "claude");
  await writeFile(fake, "#!" + process.execPath + "\n" +
    'require("node:fs").writeFileSync(process.env.TEST_CLAUDE_RECORD, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n');
  await chmod(fake, 0o755);
  f.env.PATH = bin + ":" + f.env.PATH;
  f.env.TEST_CLAUDE_RECORD = record;
  f.env.LIVE_SUPPORT_PORT = "0";
  let previous;
  for (const name of ["project-a", "project-b"]) {
    const cwd = join(f.root, name);
    await mkdir(cwd);
    const p = spawnSync(process.execPath, [cli, "claude"], { cwd, env: f.env, encoding: "utf8", timeout: 10000 });
    assert.equal(p.status, 0, p.stderr);
    const actual = JSON.parse(await readFile(record, "utf8"));
    assert.equal(actual.cwd, await realpath(cwd));
    const index = actual.args.indexOf("--mcp-config");
    assert.ok(index >= 0);
    const config = JSON.parse(actual.args[index + 1]).mcpServers["live-support"];
    assert.equal(config.command, process.execPath);
    assert.ok(isAbsolute(config.args[0]));
    await access(config.args[0]);
    assert.equal(config.env.LIVE_SUPPORT_RUNTIME_DIR, f.runtime);
    assert.ok(actual.args.includes("--strict-mcp-config"));
    assert.equal(actual.args[actual.args.indexOf("--tools") + 1], "Read,Glob,Grep,Skill");
    assert.ok(actual.args.includes("server:live-support"));
    const token = (await readFile(join(f.runtime, "token"), "utf8")).trim();
    if (previous) assert.notEqual(token, previous);
    assert.ok(!p.stdout.includes(token) && !p.stderr.includes(token));
    previous = token;
    await assert.rejects(access(join(f.runtime, "launcher.lock")));
    await assert.rejects(access(join(cwd, "mcp.local.json")));
  }
});
test("an existing launcher lease blocks startup and token rotation before MCP binds", async t => {
  const f = await fixture(t);
  assert.equal(f.run("setup").status, 0);
  const before = await readFile(join(f.runtime, "token"), "utf8");
  await writeFile(join(f.runtime, "launcher.lock"), "test-owned lease\n", { mode: 0o600 });
  f.env.LIVE_SUPPORT_PORT = "0";
  const p = f.run("claude");
  assert.equal(p.status, 1);
  assert.match(p.stderr, /lock|previous|前の/i);
  assert.equal(await readFile(join(f.runtime, "token"), "utf8"), before);
});
for (const signal of ["SIGTERM", "SIGINT"]) test(signal + " with TTY stdin stops the child and releases the project lease", async t => {
  const f = await fixture(t);
  const bin = join(f.root, "signal-bin");
  await mkdir(bin);
  const fake = join(bin, "claude");
  await writeFile(fake, "#!" + process.execPath + "\nconsole.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);\n");
  await chmod(fake, 0o755);
  const hook = join(f.root, "tty.mjs");
  await writeFile(hook, 'Object.defineProperty(process.stdin, "isTTY", { value: true });');
  const child = spawn(process.execPath, ["--import", hook, cli, "claude"], {
    cwd: f.project, env: { ...f.env, PATH: bin + ":" + f.env.PATH, LIVE_SUPPORT_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let fakePid;
  t.after(() => {
    if (fakePid) { try { process.kill(fakePid, "SIGKILL"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const [ready] = await once(child.stdout, "data");
  fakePid = JSON.parse(ready.toString()).pid;
  const exit = once(child, "exit");
  child.kill(signal);
  let timer;
  try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("launcher did not stop")), 2000); })]); }
  finally { clearTimeout(timer); }
  await assert.rejects(access(join(f.runtime, "launcher.lock")));
});
test("startup interruption releases a lease before the Claude child exists", async t => {
  const f = await fixture(t);
  const hook = join(f.root, "slow-copy.mjs");
  await writeFile(hook, [
    'import fs from "node:fs/promises";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const original = fs.copyFile; let first = true;',
    'fs.copyFile = async (...args) => { if(first) { first=false; process.stdout.write("copy-start\\n"); await new Promise(r=>setTimeout(r,200)); } return original(...args); };',
    'syncBuiltinESMExports();',
  ].join("\n"));
  const child = spawn(process.execPath, ["--import", hook, cli, "claude"], {
    cwd: f.project, env: { ...f.env, LIVE_SUPPORT_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  await access(join(f.runtime, "launcher.lock"));
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
  await assert.rejects(access(join(f.runtime, "launcher.lock")));
});
test("occupied receiver port refuses another Claude launch", async t => {
  const f = await fixture(t);
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  f.env.LIVE_SUPPORT_PORT = String(server.address().port);
  const p = f.run("claude");
  assert.equal(p.status, 1);
  assert.match(p.stderr, /port|ポート/i);
  await assert.rejects(access(join(f.runtime, "token")));
});
