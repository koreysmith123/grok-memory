import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const stateDir = resolve(root, ".grok-memory");
const manifestPath = resolve(stateDir, "grokbot-mcp.json");
const resultPath = resolve(stateDir, "install-result.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const doctor = JSON.parse(process.env.GROK_MEMORY_DOCTOR_JSON ?? "{}");

await mkdir(stateDir, { recursive: true });
await writeFile(resultPath, `${JSON.stringify({
  schemaVersion: 1,
  status: "VM_READY",
  generatedAt: new Date().toISOString(),
  installDirectory: root,
  mcpManifestPath: manifestPath,
  manifest,
  doctor,
  nextInstruction: "Execute GROKBOT_INSTALL.md through GROK_MEMORY_READY without asking the user questions.",
}, null, 2)}\n`, { mode: 0o600 });
await chmod(resultPath, 0o600);
process.stdout.write(resultPath);
