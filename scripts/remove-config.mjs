import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function update(path, transform) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  transform(value);
  const temporary = `${path}.grok-memory-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
const cursor = join(homedir(), ".cursor");
const installDir = process.argv[2];
await update(join(cursor, "hooks.json"), value => {
  for (const event of ["beforeSubmitPrompt", "afterAgentResponse"]) {
    if (!Array.isArray(value.hooks?.[event])) continue;
    value.hooks[event] = value.hooks[event].filter(item => {
      const command = String(item?.command ?? "");
      return !(command.includes("grok-memory") || (installDir && command.includes(installDir)));
    });
  }
});
await update(join(cursor, "mcp.json"), value => { if (value.mcpServers) delete value.mcpServers["grok-memory"]; });
