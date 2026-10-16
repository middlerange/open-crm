import { closeDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";
import { seedAllDefaults } from "./bootstrap.js";

runMigrations()
  .then(seedAllDefaults)
  .then(async () => {
    console.log("Orbit defaults are ready.");
    await closeDatabase();
  })
  .catch(async (error) => {
    console.error("Database seed failed:", error instanceof Error ? error.message : error);
    await closeDatabase();
    process.exitCode = 1;
  });
