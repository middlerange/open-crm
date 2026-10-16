import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { closeDatabase } from "./db.js";
import { applyMigrations } from "./database-setup.js";

export async function runMigrations() {
  const migrationsDirectory = path.join(process.cwd(), "migrations");
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();

  const migrations = await Promise.all(
    files.map(async (version) => ({
      version,
      sql: await readFile(path.join(migrationsDirectory, version), "utf8"),
    })),
  );
  await applyMigrations(migrations);
}

const migrationCliPath = path.resolve(process.cwd(), "server/migrate.ts");
if (process.argv[1] && path.resolve(process.argv[1]) === migrationCliPath) {
  runMigrations()
    .then(async () => {
      console.log("Database migrations are up to date.");
      await closeDatabase();
    })
    .catch(async (error) => {
      console.error("Database migration failed:", error instanceof Error ? error.message : error);
      await closeDatabase();
      process.exitCode = 1;
    });
}
