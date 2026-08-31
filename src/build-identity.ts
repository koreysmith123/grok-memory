import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

const PREFIX = "grok-build:";

export async function getOrCreateBuildIdentity(dataDir: string): Promise<string> {
  const path = join(dataDir, "grok-build-id");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.startsWith(PREFIX) && existing.length > PREFIX.length) return existing;
  } catch {}
  await mkdir(dataDir, { recursive: true });
  const botId = `${PREFIX}${randomUUID()}`;
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(`${botId}\n`); } finally { await file.close(); }
  } catch (error) {
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (existing.startsWith(PREFIX) && existing.length > PREFIX.length) return existing;
    } catch {}
    throw error;
  }
  return botId;
}
