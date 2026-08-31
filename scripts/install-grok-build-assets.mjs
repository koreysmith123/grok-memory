import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const target = join(homedir(), ".grok", "skills", "recallsmith");
await mkdir(target, { recursive: true });
await copyFile(join(root, "skills", "recallsmith", "SKILL.md"), join(target, "SKILL.md"));
process.stdout.write(`${target}\n`);
