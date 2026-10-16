import { sql } from "./db.js";
import { ensureBootstrap } from "./bootstrap.js";

export async function applyMigrations(migrations: Array<{ version: string; sql: string }>) {
  // PostgreSQL serializes setup across Worker isolates and concurrent first requests.
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(72401601)`;
    await transaction`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    for (const migration of migrations) {
      const [applied] =
        await transaction`SELECT version FROM schema_migrations WHERE version = ${migration.version}`;
      if (applied) continue;
      await transaction.unsafe(migration.sql);
      await transaction`INSERT INTO schema_migrations (version) VALUES (${migration.version})`;
    }
  });
}

export async function initializeDatabase(migrations: Array<{ version: string; sql: string }>) {
  await applyMigrations(migrations);
  await ensureBootstrap();
}
