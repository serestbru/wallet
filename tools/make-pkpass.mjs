#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return resolve(process.argv[index + 1]);
}

const input = argument("input");
const output = argument("output");
const certificate = argument("certificate");
const key = argument("key");
const wwdr = argument("wwdr");
const work = await mkdtemp(join(tmpdir(), "wallet-pass-"));

try {
  await cp(input, work, { recursive: true });
  await rm(join(work, "manifest.json"), { force: true });
  await rm(join(work, "signature"), { force: true });

  const manifest = {};
  for (const name of await readdir(work, { recursive: true })) {
    const path = join(work, name);
    if (!(await lstat(path)).isFile()) continue;
    const data = await readFile(path);
    manifest[name] = createHash("sha1").update(data).digest("hex");
  }
  await writeFile(join(work, "manifest.json"), JSON.stringify(manifest));

  execFileSync("openssl", [
    "smime", "-binary", "-sign", "-certfile", wwdr, "-signer", certificate,
    "-inkey", key, "-in", join(work, "manifest.json"), "-out", join(work, "signature"),
    "-outform", "DER", "-nodetach"
  ], { stdio: "inherit" });

  execFileSync("zip", ["-q", "-X", "-r", output, "."], { cwd: work, stdio: "inherit" });
  console.log(`Created ${output}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
