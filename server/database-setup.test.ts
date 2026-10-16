import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test(
  "fresh database setup is safe under concurrent first requests",
  {
    skip: !process.env.ORBIT_INSTALL_TEST_DATABASE_URL,
    timeout: 30_000,
  },
  async () => {
    const { configureRuntime } = await import("./config.js");
    const { configureDatabase, sql, closeDatabase } = await import("./db.js");
    const { initializeDatabase, applyMigrations } = await import("./database-setup.js");
    const { runMigrations } = await import("./migrate.js");
    const databaseUrl = process.env.ORBIT_INSTALL_TEST_DATABASE_URL!;
    configureRuntime({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: process.env.DATABASE_SSL ?? "require",
      BOOTSTRAP_EMAIL: "founder@example.test",
      BOOTSTRAP_PASSWORD: "installation-test-only-password",
      BOOTSTRAP_NAME: "Test Founder",
    });
    configureDatabase(databaseUrl);
    try {
      const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'
    `;
      assert.equal(count, 0, "Use a new empty, disposable installation test database.");
      const migrations = await Promise.all(
        (await readdir("migrations"))
          .filter((file) => file.endsWith(".sql"))
          .sort()
          .map(async (version) => ({
            version,
            sql: await readFile(`migrations/${version}`, "utf8"),
          })),
      );
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          index % 2 === 0 ? initializeDatabase(migrations) : runMigrations(),
        ),
      );
      await initializeDatabase(migrations);
      const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM workspaces) AS workspaces,
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM memberships WHERE role = 'founder') AS founders,
        (SELECT count(*)::int FROM opportunity_stages) AS stages,
        (SELECT count(*)::int FROM work_items) AS tasks,
        (SELECT count(*)::int FROM schema_migrations) AS migrations
    `;
      assert.deepEqual(counts, {
        workspaces: 1,
        users: 1,
        founders: 1,
        stages: 9,
        tasks: 6,
        migrations: migrations.length,
      });
      await assert.rejects(
        applyMigrations([
          {
            version: "installation-test-failed.sql",
            sql: "CREATE TABLE installation_rollback_probe (id integer); SELECT * FROM installation_missing_relation;",
          },
        ]),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "42P01",
      );
      const [rolledBack] = await sql`
        SELECT to_regclass('installation_rollback_probe') AS relation,
          (SELECT count(*)::int FROM schema_migrations WHERE version = 'installation-test-failed.sql') AS recorded
      `;
      assert.deepEqual(rolledBack, { relation: null, recorded: 0 });

      const upgrade = {
        version: "installation-test-upgrade.sql",
        sql: "CREATE TABLE installation_upgrade_probe (id integer); INSERT INTO installation_upgrade_probe VALUES (1);",
      };
      await Promise.all(Array.from({ length: 8 }, () => applyMigrations([...migrations, upgrade])));
      const [upgraded] = await sql`
        SELECT (SELECT count(*)::int FROM installation_upgrade_probe) AS rows,
          (SELECT count(*)::int FROM schema_migrations WHERE version = ${upgrade.version}) AS recorded
      `;
      assert.deepEqual(upgraded, { rows: 1, recorded: 1 });
    } finally {
      await closeDatabase();
    }
  },
);
