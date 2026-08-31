import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const directory = join(root, ".grok-memory");
const manifest = {
  name: "grok-memory",
  transport: "stdio",
  command: process.execPath,
  args: [join(root, "dist", "cli.js"), "mcp"],
};
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "grokbot-mcp.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(manifest)}\n`);
