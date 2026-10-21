import test from "node:test";
import assert from "node:assert/strict";
import { agents, help, launchBanner, setupDone, styler } from "../bin/text.js";

const strip = text => text.replace(/\u001b\[[0-9;]*m/g, "");
const columns = text => [...text].reduce((total, c) => total + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);

test("colour appears only on a terminal and never with NO_COLOR; stripping it leaves the plain text", () => {
  for (const options of [{}, { tty: true, noColor: true }, { tty: false }]) assert.ok(!/\u001b/.test(help(styler(options))), JSON.stringify(options));
  const colored = help(styler({ tty: true }));
  assert.ok(/\u001b\[1m/.test(colored)); assert.equal(strip(colored), help(styler()));
  assert.equal(strip(agents("/r", "omp", styler({ tty: true }))), agents("/r", "omp", styler()));
});
test("the launch banner lines up Japanese labels with their values by display width", () => {
  const lines = launchBanner({ project: "/p/x", web: true }).split("\n").filter(line => /^  \S/.test(line));
  assert.equal(lines.length, 4);
  const starts = lines.map(line => { const label = line.slice(2).match(/^(\S+)\s+/)[0]; return 2 + columns(label); });
  assert.equal(new Set(starts).size, 1, "every value starts in the same terminal column: " + starts);
  assert.match(launchBanner({ project: "/p", web: false }), /Web検索\s+OFF/);
});
test("each agent page names the next step; agents the overview does not know are refused", () => {
  for (const name of ["omp", "pi", "agy"]) assert.match(agents("/r", name), /live-support token/);
  assert.throws(() => agents("/r", "gpt"), /claude \/ omp \/ pi \/ agy/);
  assert.match(setupDone("/ext"), /\/ext/);
});
