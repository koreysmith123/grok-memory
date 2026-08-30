import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const admin = randomBytes(24).toString("hex");
const app = randomBytes(24).toString("hex");
const body = `POSTGRES_PASSWORD=${admin}\nAPP_DB_PASSWORD=${app}\nDATABASE_URL=postgresql://grok_memory_app:${app}@127.0.0.1:54329/grok_memory\nGROK_MEMORY_MIGRATION_DATABASE_URL=postgresql://postgres:${admin}@127.0.0.1:54329/grok_memory\nGROK_MEMORY_APP_ROLE=grok_memory_app\nGROK_MEMORY_MANAGED_POSTGRES=1\nGROK_MEMORY_OWNER_ID=local-user\nGROK_MEMORY_RECALL_TIMEOUT_MS=8000\nGROK_MEMORY_JOB_POLL_MS=500\nGROK_MEMORY_TRANSCRIPT_RETENTION_DAYS=30\n`;
await writeFile(new URL("../.env", import.meta.url), body, { mode: 0o600, flag: "wx" });
