import { sql } from "./db.js";
import { ensureBootstrap } from "./bootstrap.js";

export async function applyMigrations(migrations: Array<{ version: string; sql: string }>) {
  // Concurrent first installs can race while creating PostgreSQL's catalog entries.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      break;
    } catch (error) {
      const catalogRace =
        error instanceof Error &&
        "code" in error &&
        error.code === "23505" &&
        "constraint_name" in error &&
        (error.constraint_name === "pg_type_typname_nsp_index" ||
          error.constraint_name === "pg_class_relname_nsp_index");
      if (!catalogRace || attempt >= 2) throw error;
    }
  }
  // Table locks are transaction scoped and supported through Hyperdrive.
  await sql.begin(async (transaction) => {
    await transaction`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`;
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
