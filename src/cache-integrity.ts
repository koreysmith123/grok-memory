import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const MANIFEST = ".grok-memory-integrity.json";

async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === MANIFEST || entry.name.endsWith(".tmp")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path)); else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path); stream.on("data", chunk => hash.update(chunk)); stream.on("error", reject); stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifyOrCreateCacheManifest(root: string): Promise<{ status: "created" | "verified"; digest: string; files: number }> {
  const paths = await files(root);
  if (paths.length === 0) throw new Error("Embedding cache is empty");
  const hash = createHash("sha256");
  for (const path of paths) hash.update(relative(root, path)).update("\0").update(await digestFile(path)).update("\0");
  const current = { algorithm: "sha256", digest: hash.digest("hex"), files: paths.length };
  const manifestPath = join(root, MANIFEST);
  try {
    const saved = JSON.parse(await readFile(manifestPath, "utf8"));
    if (saved.digest !== current.digest || saved.files !== current.files) throw new Error("Embedding cache integrity check failed; remove the cache and reinstall");
    return { status: "verified", digest: current.digest, files: current.files };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, manifestPath);
  return { status: "created", digest: current.digest, files: current.files };
}
