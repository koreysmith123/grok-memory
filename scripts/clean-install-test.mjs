import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appUrl = process.env.GROK_MEMORY_TEST_DATABASE_URL;
const adminUrl = process.env.GROK_MEMORY_TEST_ADMIN_DATABASE_URL;
if (!appUrl || !adminUrl) throw new Error("Set GROK_MEMORY_TEST_DATABASE_URL and GROK_MEMORY_TEST_ADMIN_DATABASE_URL");
const temporary = await mkdtemp(join(tmpdir(), "grok-memory-install-"));
const checkout = join(temporary, "grok-memory");
const home = join(temporary, "home");
const port = 17400 + Math.floor(Math.random() * 1000);
const run = (command, args, options = {}) => new Promise((done, reject) => {
  const child = spawn(command, args, { cwd: checkout, env: { ...process.env, HOME: home, ...options }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
  child.on("error", reject); child.on("close", code => code === 0 ? done({ stdout, stderr }) : reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
});
try {
  await cp(resolve("."), checkout, { recursive: true, filter: source => !/(^|\/)(node_modules|dist|artifacts|\.env|\.git)(\/|$)/.test(source) });
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ type: "command", command: "sentinel-hook", timeout: 1 }] } }));
  await writeFile(join(checkout, ".env"), `DATABASE_URL=${appUrl}\nGROK_MEMORY_MIGRATION_DATABASE_URL=${adminUrl}\nGROK_MEMORY_APP_ROLE=grok_memory_app\nGROK_MEMORY_OWNER_ID=install-test\nGROK_MEMORY_DAEMON_URL=http://127.0.0.1:${port}\nGROK_MEMORY_PORT=${port}\nGROK_MEMORY_MODEL_CACHE=${process.env.GROK_MEMORY_MODEL_CACHE ?? join(temporary, "model-cache")}\n`);
  await run("bash", ["./install.sh"]); await run("bash", ["./install.sh"]);
  const hooks = JSON.parse(await readFile(join(home, ".cursor", "hooks.json"), "utf8"));
  if (hooks.hooks.beforeSubmitPrompt.filter(item => item.command === "sentinel-hook").length !== 1) throw new Error("installer altered unrelated hook");
  if (hooks.hooks.beforeSubmitPrompt.filter(item => String(item.command).includes(checkout)).length !== 1) throw new Error("installer was not idempotent");
  const doctor = await run("bash", ["-lc", "set -a; . ./.env; set +a; node dist/cli.js doctor --json"]);
  const status = JSON.parse(doctor.stdout); if (!status.grokBuild?.ok || !status.embedding?.cachePresent || !status.daemon?.ok) throw new Error(`doctor failed: ${doctor.stdout}`);
  await run("bash", ["./uninstall.sh"]);
  const after = JSON.parse(await readFile(join(home, ".cursor", "hooks.json"), "utf8"));
  if (after.hooks.beforeSubmitPrompt.filter(item => item.command === "sentinel-hook").length !== 1) throw new Error("uninstall removed unrelated hook");
  await mkdir(resolve("artifacts/evidence"), { recursive: true });
  await writeFile(resolve("artifacts/evidence/install.json"), `${JSON.stringify({ suite: "install", passed: true, platform: process.platform, node: process.version, doubleInstall: true, doctor: status }, null, 2)}\n`);
  process.stdout.write("Clean isolated install, reinstall, doctor, and uninstall passed.\n");
} finally {
  await run("bash", ["./uninstall.sh"]).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
