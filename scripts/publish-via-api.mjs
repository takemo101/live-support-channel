#!/usr/bin/env node
// Publishes a local commit as a new remote branch through the GitHub API, without `but push`/`git push`.
// Why: in this GitButler workspace `but push` also pushes the old base segment and can rewind the remote default branch (see AGENTS.md).
//
//   node scripts/publish-via-api.mjs <commit> <new-branch> [--since <commit>] [--message <text>] [--dry-run]
//
// The remote default branch must hold exactly the content that <commit>'s parent (or --since) holds; otherwise nothing is written.
// It only creates a new branch (never updates or deletes one) and checks that the resulting tree equals <commit>'s tree.
// Open and merge the pull request afterwards with `gh pr create` / `gh pr merge`.
import { execFileSync } from "node:child_process";

process.on("uncaughtException", error => { console.error("publish-via-api: " + error.message); process.exit(1); });
const run = (command, args, input) => execFileSync(command, args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 }).trim();
const git = (...args) => run("git", args);
const usage = "usage: publish-via-api.mjs <commit> <new-branch> [--since <commit>] [--message <text>] [--dry-run]";

const positional = [], options = { dryRun: false, since: null, message: null };
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === "--dry-run") options.dryRun = true;
  else if (argument === "--since" || argument === "--message") {
    const value = process.argv[++i]; if (value === undefined) throw new Error(usage);
    options[argument === "--since" ? "since" : "message"] = value;
  } else if (argument.startsWith("--")) throw new Error(usage);
  else positional.push(argument);
}
if (positional.length !== 2) throw new Error(usage);
const [revision, branch] = positional;
if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) throw new Error("invalid branch name");

const commit = git("rev-parse", "--verify", `${revision}^{commit}`);
const since = git("rev-parse", "--verify", `${options.since ?? `${commit}^`}^{commit}`);
const { nameWithOwner, defaultBranchRef } = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]));
const repo = nameWithOwner, base = defaultBranchRef.name;
const api = (path, method, body) => JSON.parse(run("gh", ["api", `repos/${repo}/${path}`, ...(method ? ["-X", method] : []), ...(body ? ["--input", "-"] : [])], body && JSON.stringify(body)));

const baseHead = api(`git/ref/heads/${base}`).object.sha;
const baseTree = api(`git/commits/${baseHead}`).tree.sha;
const sinceTree = git("rev-parse", `${since}^{tree}`);
if (baseTree !== sinceTree) throw new Error(`${base} (${baseHead.slice(0, 7)}) does not hold the content of ${since.slice(0, 7)}; nothing written. Compare the trees or pass --since.`);

// --no-renames: a rename is a delete plus an add; modes come from the target commit.
const changes = git("diff", "--name-status", "--no-renames", "-z", since, commit).split("\0").filter(Boolean);
const files = [];
for (let i = 0; i < changes.length; i += 2) files.push({ status: changes[i], path: changes[i + 1] });
if (!files.length) throw new Error("no changes between the two commits");
const message = options.message ?? git("log", "-1", "--format=%B", commit);
console.error(`repo=${repo} base=${base}@${baseHead.slice(0, 7)} commit=${commit.slice(0, 7)} since=${since.slice(0, 7)} branch=${branch}`);
for (const file of files) console.error(`  ${file.status} ${file.path}`);
if (options.dryRun) { console.error("dry run: nothing written"); process.exit(0); }

const entries = files.map(({ status, path }) => {
  if (status === "D") return { path, mode: "100644", type: "blob", sha: null };
  const mode = git("ls-tree", commit, "--", path).split(" ")[0];
  const content = execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], { maxBuffer: 256 * 1024 * 1024 });
  return { path, mode, type: "blob", sha: api("git/blobs", "POST", { content: content.toString("base64"), encoding: "base64" }).sha };
});
const tree = api("git/trees", "POST", { base_tree: baseTree, tree: entries });
const localTree = git("rev-parse", `${commit}^{tree}`);
if (tree.sha !== localTree) throw new Error(`resulting tree ${tree.sha.slice(0, 7)} differs from the local tree ${localTree.slice(0, 7)}; no branch created`);
const created = api("git/commits", "POST", { message, tree: tree.sha, parents: [baseHead] });
api("git/refs", "POST", { ref: `refs/heads/${branch}`, sha: created.sha });
console.log(JSON.stringify({ repo, branch, commit: created.sha, tree: tree.sha }));
