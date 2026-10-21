import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function prepareToken(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (dir.mode & 0o077)) throw new Error("Runtime directory must be a private real directory (0700)");
  const path = join(directory, "token");
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const token = randomBytes(32).toString("base64url");
      await file.writeFile(token + "\n");
      return token;
    } finally { await file.close(); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 100) throw new Error("Pairing token must be a private regular file (0600)");
    const token = (await file.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid pairing token; stop the bridge and remove its token file to re-pair");
    return token;
  } finally { await file.close(); }
}

// A fresh pairing token for one receiving session: a panel that still holds the previous token can no longer reach it.
export async function renewToken(directory) {
  const temp = join(directory, ".token-" + randomUUID());
  try {
    await writeFile(temp, randomBytes(32).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, join(directory, "token"));
  } finally { await rm(temp, { force: true }); }
}
