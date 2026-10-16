import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test("private research is disabled by default and requires authentication when enabled", async () => {
  const { app } = await import("./app.js");
  const { config, configureRuntime } = await import("./config.js");
  const previous = { ...config };
  try {
    configureRuntime({});
    const publicConfig = await app.request("/api/public-config");
    assert.equal((await publicConfig.json()).features.contentResearch, false);
    for (const path of ["/", "/items", "/documents/example", "/references/example"]) {
      const response = await app.request(`/api/content-research${path}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    }
    configureRuntime({ CONTENT_RESEARCH_ENABLED: "true" });
    const publicConfigEnabled = await app.request("/api/public-config");
    assert.equal((await publicConfigEnabled.json()).features.contentResearch, true);
    assert.equal((await app.request("/api/content-research/")).status, 401);
  } finally {
    configureRuntime({
      ...previous,
      MAIL_DOMAIN_WORKSPACES: JSON.stringify(previous.MAIL_DOMAIN_WORKSPACES),
      MAIL_INBOUND_ALIASES: JSON.stringify(previous.MAIL_INBOUND_ALIASES),
    });
  }
});

test(
  "private research rejects IC sessions and permits management through the guard",
  {
    skip: !process.env.ORBIT_SECURITY_TEST_DATABASE_URL,
  },
  async () => {
    const databaseUrl = process.env.ORBIT_SECURITY_TEST_DATABASE_URL!;
    const target = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
    assert.match(target.pathname, /test/);
    const { configureDatabase, sql, closeDatabase } = await import("./db.js");
    const { config, configureRuntime } = await import("./config.js");
    const previous = { ...config };
    const { app } = await import("./app.js");
    const { runMigrations } = await import("./migrate.js");
    const { hashToken } = await import("./security.js");
    configureDatabase(databaseUrl);
    await runMigrations();
    const token = randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO users (name, email, password_hash)
    VALUES ('Research Test', ${`${randomUUID()}@example.test`}, 'unused') RETURNING id`;
    const [workspace] = await sql<{ id: string }[]>`INSERT INTO workspaces (name, slug)
    VALUES ('Research Test', ${randomUUID()}) RETURNING id`;
    try {
      configureRuntime({ CONTENT_RESEARCH_ENABLED: "true" });
      await sql`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${workspace.id}, ${user.id}, 'ic')`;
      await sql`INSERT INTO sessions (user_id, token_hash, expires_at, selected_workspace_id)
      VALUES (${user.id}, ${hashToken(token)}, now() + interval '1 hour', ${workspace.id})`;
      const headers = { cookie: `${config.SESSION_COOKIE_NAME}=${token}` };
      assert.equal((await app.request("/api/content-research/items", { headers })).status, 403);
      for (const role of ["manager", "founder"]) {
        await sql`UPDATE memberships SET role = ${role} WHERE workspace_id = ${workspace.id} AND user_id = ${user.id}`;
        assert.equal(
          (await app.request("/api/content-research/unknown-test-route", { headers })).status,
          404,
        );
      }
    } finally {
      await sql`DELETE FROM workspaces WHERE id = ${workspace.id}`;
      await sql`DELETE FROM users WHERE id = ${user.id}`;
      await closeDatabase();
      configureRuntime({
        ...previous,
        MAIL_DOMAIN_WORKSPACES: JSON.stringify(previous.MAIL_DOMAIN_WORKSPACES),
        MAIL_INBOUND_ALIASES: JSON.stringify(previous.MAIL_INBOUND_ALIASES),
      });
    }
  },
);
