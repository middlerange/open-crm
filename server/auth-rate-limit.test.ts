import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test(
  "authentication limits persist, serialize concurrent requests, and expire",
  {
    skip: !process.env.ORBIT_SECURITY_TEST_DATABASE_URL,
  },
  async () => {
    const databaseUrl = process.env.ORBIT_SECURITY_TEST_DATABASE_URL!;
    const target = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
    assert.match(target.pathname, /test/);
    const { configureDatabase, sql, closeDatabase } = await import("./db.js");
    configureDatabase(databaseUrl);
    const { runMigrations } = await import("./migrate.js");
    const { consumeAuthAttempt } = await import("./auth-rate-limit.js");
    const { hashToken, hashPassword } = await import("./security.js");
    const { app } = await import("./app.js");
    await runMigrations();
    const identifier = `${randomUUID()}@example.test`;
    const loginEmail = `${randomUUID()}@example.test`;
    const inviteToken = randomUUID();
    const existingInviteToken = randomUUID();
    let workspaceId: string | undefined;
    let userId: string | undefined;
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, () => consumeAuthAttempt("email", identifier)),
      );
      assert.equal(results.filter((result) => result.allowed).length, 10);
      assert.ok(results.every((result) => result.retryAfter > 0 && result.retryAfter <= 900));
      assert.equal((await consumeAuthAttempt("invite", identifier)).allowed, true);

      await sql`UPDATE auth_rate_limits SET expires_at = now() - interval '1 second'
      WHERE key_hash = ${hashToken(`email:${identifier}`)}`;
      assert.equal((await consumeAuthAttempt("email", identifier)).allowed, true);

      for (let index = 0; index < 11; index++) {
        const response = await app.request("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: index % 2 ? loginEmail.toUpperCase() : loginEmail,
            password: "incorrect",
          }),
        });
        assert.equal(response.status, index < 10 ? 401 : 429);
        if (index === 10) assert.ok(Number(response.headers.get("Retry-After")) > 0);
      }
      const passwordHash = await hashPassword("existing-user-test-password");
      const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${loginEmail}, 'Rate Limit Test', ${passwordHash}) RETURNING id
    `;
      userId = user.id;
      const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO workspaces (name, slug) VALUES ('Rate Limit Test', ${randomUUID()}) RETURNING id
    `;
      workspaceId = workspace.id;
      await sql`INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${workspaceId}, ${loginEmail}, 'ic', ${hashToken(existingInviteToken)}, ${userId}, now() + interval '1 hour')`;
      const existingInvite = await app.request("/api/auth/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: existingInviteToken,
          password: "existing-user-test-password",
        }),
      });
      assert.equal(
        existingInvite.status,
        429,
        "an invitation must not bypass the email password limit",
      );
      const [membership] = await sql`SELECT 1 FROM memberships WHERE user_id = ${userId}`;
      assert.equal(membership, undefined);
      for (let index = 0; index < 11; index++) {
        const response = await app.request("/api/auth/invite/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: inviteToken }),
        });
        assert.equal(response.status, index < 10 ? 404 : 429);
      }
    } finally {
      const keys = [
        hashToken(`email:${identifier}`),
        hashToken(`invite:${identifier}`),
        hashToken(`email:${loginEmail}`),
        hashToken(`invite:${inviteToken}`),
        hashToken(`invite:${existingInviteToken}`),
      ];
      await sql`DELETE FROM auth_rate_limits WHERE key_hash IN ${sql(keys)}`;
      if (workspaceId) await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
      await closeDatabase();
    }
  },
);
