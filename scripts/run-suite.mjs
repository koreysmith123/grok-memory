import { mkdir, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const suite = process.argv[2];
if (!new Set(["deterministic", "postgres", "live"]).has(suite)) throw new Error("suite must be deterministic, postgres, or live");
const directory = resolve(suite === "deterministic" ? "test" : `test/${suite}`);
const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".test.ts")).map(entry => resolve(directory, entry.name)).sort();
const env = { ...process.env, ...(suite === "postgres" ? { GROK_MEMORY_POSTGRES_TEST: "1" } : {}), ...(suite === "live" ? { GROK_MEMORY_LIVE_TEST: "1" } : {}) };
const startedAt = new Date().toISOString();
let tap = "";
const code = await new Promise((done, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: ["inherit", "pipe", "pipe"], env });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { tap += value; process.stdout.write(value); });
  child.stderr.on("data", value => process.stderr.write(value));
  child.on("error", reject); child.on("close", value => done(value ?? 1));
});
const testResults = [...tap.matchAll(/^(not )?ok \d+ - ([^\n]+?)(?: # SKIP.*)?$/gm)].map(match => ({ name: match[2], passed: !match[1] && !match[0].includes("# SKIP") }));
const requirements = {};
for (const result of testResults) for (const id of result.name.match(/[A-Z]{3}-\d{3}/g) ?? []) requirements[id] = (requirements[id] ?? true) && result.passed;
await mkdir(resolve("artifacts/evidence"), { recursive: true });
await writeFile(resolve(`artifacts/evidence/${suite}.json`), `${JSON.stringify({ suite, passed: code === 0, startedAt, finishedAt: new Date().toISOString(),
  files: files.map(file => file.slice(process.cwd().length + 1)), testResults, requirements }, null, 2)}\n`);
process.exitCode = code;
