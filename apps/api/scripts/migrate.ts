// Release-command runner for Fly deploys.
//
// Fly runs `node apps/api/dist/scripts/migrate.js` once per deploy, before
// rolling new machines into traffic. The job: apply pending Prisma
// migrations against both schemas (apps/api/prisma + packages/inbox/prisma)
// so the new app code never starts before the DB matches it.
//
// Both schemas live in the same Postgres DB but are tracked by separate
// Prisma migration tables (`_prisma_migrations` in each schema's own
// search_path). We invoke each via the prisma CLI so the standard
// migration log + advisory-lock semantics apply.
//
// Failure here makes Fly fail the release and roll back. That's the
// desired behavior — we'd rather block a bad deploy than let app code
// run against a schema it doesn't match.

import { spawn } from "node:child_process";
import process from "node:process";

const STEPS: { name: string; cwd: string; databaseUrlEnv: string }[] = [
  // API schema (auth, machine_tokens, llm_usage_events, pairing_tokens,
  // accounts, mandates, etc.). DATABASE_URL fallback is for local dev
  // where AUTH_DATABASE_URL might not be set explicitly.
  {
    name: "api",
    cwd: "apps/api",
    databaseUrlEnv: process.env.AUTH_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
  // Inbox schema (email_alias, received_email).
  {
    name: "inbox",
    cwd: "packages/inbox",
    databaseUrlEnv: process.env.INBOX_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
];

async function runStep(step: (typeof STEPS)[number]): Promise<void> {
  if (step.databaseUrlEnv === "") {
    // Don't fail the release if a schema's URL isn't configured —
    // some envs (early dev) only have one DB. Just skip.
    console.warn(`[migrate:${step.name}] no database URL configured; skipping`);
    return;
  }
  console.warn(`[migrate:${step.name}] applying migrations…`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: step.cwd,
      env: { ...process.env, DATABASE_URL: step.databaseUrlEnv },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
  });
  console.warn(`[migrate:${step.name}] done`);
}

async function main(): Promise<void> {
  for (const step of STEPS) {
    await runStep(step);
  }
  console.warn("[migrate] all schemas up to date");
}

main().catch((err: unknown) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
