import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(process.argv[2] ?? process.cwd());
const cursorDir = join(homedir(), ".cursor");

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.grok-memory-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

const hooksPath = join(cursorDir, "hooks.json");
const hooks = await readJson(hooksPath, { version: 1, hooks: {} });
hooks.version = 1;
hooks.hooks ??= {};
const ownedHooks = {
  beforeSubmitPrompt: { type: "command", command: `node ${root}/dist/cli.js hook before`, timeout: 10, loop_limit: null, failClosed: false },
  afterAgentResponse: { type: "command", command: `node ${root}/dist/cli.js hook after`, timeout: 3, loop_limit: null, failClosed: false },
};
for (const [event, owned] of Object.entries(ownedHooks)) {
  const existing = Array.isArray(hooks.hooks[event]) ? hooks.hooks[event] : [];
  hooks.hooks[event] = [...existing.filter(item => String(item?.command ?? "") !== owned.command), owned];
}
await atomicJson(hooksPath, hooks);

const mcpPath = join(cursorDir, "mcp.json");
const mcp = await readJson(mcpPath, { mcpServers: {} });
mcp.mcpServers ??= {};
mcp.mcpServers["grok-memory"] = { command: "node", args: [join(root, "dist", "cli.js"), "mcp"] };
await atomicJson(mcpPath, mcp);

process.stdout.write(`Configured ${hooksPath} and ${mcpPath}\n`);
