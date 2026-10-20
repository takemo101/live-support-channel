import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { isAbsolute } from "node:path";

test("MCP launch configuration is portable from the repository root", async () => {
  const config = JSON.parse(await readFile(new URL("../mcp.local.json", import.meta.url), "utf8"));
  const server = config.mcpServers["live-support"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["server/main.js"]);
  assert.equal(isAbsolute(server.args[0]), false);
  await access(new URL("../" + server.args[0], import.meta.url));
});
test("public docs exist and local runtime and third-party analysis files are excluded", async () => {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const entry of [".runtime/", "node_modules/", "artifacts/", "research/"]) assert.ok(ignore.split("\n").includes(entry));
  for (const file of ["README.md", "SPEC.md", "docs/rea-analysis-report.md"]) {
    const text = await readFile(new URL("../" + file, import.meta.url), "utf8");
    assert.ok(text.length > 100);
  }
});
