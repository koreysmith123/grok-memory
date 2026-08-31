import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const requirements = await readFile(resolve("REQUIREMENTS.md"), "utf8");
const ids = [...new Set([...requirements.matchAll(/\| ([A-Z]{3}-\d{3}) \|/g)].map(match => match[1]))];
const sources = {};
for (const suite of ["deterministic", "postgres", "live"]) {
  const directory = resolve(suite === "deterministic" ? "test" : `test/${suite}`);
  const texts = await Promise.all((await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".test.ts")).map(entry => readFile(resolve(directory, entry.name), "utf8")));
  sources[suite] = texts.join("\n");
}
const evidence = {};
for (const suite of ["deterministic", "postgres", "install", "e2e", "live", "grokbot"]) {
  try { evidence[suite] = JSON.parse(await readFile(resolve(`artifacts/evidence/${suite}.json`), "utf8")); }
  catch { evidence[suite] = { suite, passed: false, missing: true }; }
}
const rows = ids.map(id => {
  const requiredSuites = ["deterministic", "postgres", "live"].filter(suite => sources[suite].includes(id));
  if (new Set(["INS-001", "INS-002", "INS-003", "INS-004", "INS-006", "INS-007", "INS-009", "INS-010", "INS-011"]).has(id)) requiredSuites.push("install");
  if (new Set(["MEM-002", "MEM-003", "MEM-007", "MEM-008", "MEM-010", "ISO-002", "HOK-001", "HOK-002", "HOK-004", "EMU-001", "EMU-003", "EMU-005", "EMU-006", "BLD-005"]).has(id)) requiredSuites.push("e2e");
  if (new Set(["LAT-003", "LAT-004"]).has(id)) requiredSuites.push("e2e");
  if (id.startsWith("BOT-")) requiredSuites.push("grokbot");
  if (id === "QUA-001") requiredSuites.push("postgres", "install", "e2e", "live");
  const uniqueSuites = [...new Set(requiredSuites)];
  const suitePass = suite => evidence[suite]?.requirements && id in evidence[suite].requirements ? evidence[suite].requirements[id] === true : evidence[suite]?.passed === true;
  const passed = uniqueSuites.length > 0 && uniqueSuites.every(suitePass);
  const missing = uniqueSuites.some(suite => evidence[suite]?.missing === true);
  return { id, status: passed ? "PASS" : uniqueSuites.length === 0 ? "FAIL" : missing ? "BLOCKED" : "FAIL", requiredSuites: uniqueSuites,
    evidence: uniqueSuites.map(suite => `artifacts/evidence/${suite}.json`) };
});
let commit = null;
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), commit, environment: { node: process.version, platform: process.platform, arch: process.arch },
  summary: { total: rows.length, pass: rows.filter(row => row.status === "PASS").length, blocked: rows.filter(row => row.status === "BLOCKED").length, fail: rows.filter(row => row.status === "FAIL").length }, requirements: rows };
await mkdir(resolve("artifacts"), { recursive: true });
await writeFile(resolve("artifacts/validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report.summary)}\n`);
if (report.summary.fail > 0 || report.summary.blocked > 0) process.exitCode = 1;
