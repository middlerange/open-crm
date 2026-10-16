import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test(
  "self-service keys inherit the authenticated user's role and ownership boundary",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [{ app }, { sql, closeDatabase }, { runMigrations }, security, { config }] =
      await Promise.all([
        import("./app"),
        import("./db"),
        import("./migrate"),
        import("./security"),
        import("./config"),
      ]);
    await runMigrations();

    const suffix = randomUUID();
    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO workspaces (name, slug)
      VALUES (${`Agent access test ${suffix}`}, ${`agent-access-test-${suffix}`}) RETURNING id
    `;
    const [founder] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${`access-founder-${suffix}@example.test`}, 'Access Founder', 'test-only')
      RETURNING id
    `;
    const [ic] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${`access-ic-${suffix}@example.test`}, 'Access IC', 'test-only')
      RETURNING id
    `;
    const sessionToken = security.createOpaqueToken();

    try {
      await sql`
        INSERT INTO memberships (workspace_id, user_id, role) VALUES
          (${workspace.id}, ${founder.id}, 'founder'),
          (${workspace.id}, ${ic.id}, 'ic')
      `;
      await sql`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${ic.id}, ${security.hashToken(sessionToken)}, now() + interval '1 hour')
      `;
      const [founderAccount] = await sql<{ id: string }[]>`
        INSERT INTO accounts (workspace_id, owner_id, name, domain, normalized_domain, created_by)
        VALUES (
          ${workspace.id}, ${founder.id}, 'Founder account', ${`founder-${suffix}.test`},
          ${`founder-${suffix}.test`}, ${founder.id}
        ) RETURNING id
      `;
      const [icAccount] = await sql<{ id: string }[]>`
        INSERT INTO accounts (workspace_id, owner_id, name, domain, normalized_domain, created_by)
        VALUES (
          ${workspace.id}, ${ic.id}, 'IC account', ${`ic-${suffix}.test`},
          ${`ic-${suffix}.test`}, ${ic.id}
        ) RETURNING id
      `;

      const cookie = `${config.SESSION_COOKIE_NAME}=${sessionToken}`;
      const createResponse = await app.request("/api/agent-keys", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "IC laptop" }),
      });
      assert.equal(createResponse.status, 201);
      const created = (await createResponse.json()) as {
        key: { id: string; token: string; tokenHint: string };
      };
      assert.match(created.key.token, /^orbit_/);
      assert.ok(!created.key.tokenHint.includes(created.key.token));

      const listResponse = await app.request("/api/agent-keys", { headers: { cookie } });
      const listed = (await listResponse.json()) as { keys: Array<{ id: string }> };
      assert.deepEqual(
        listed.keys.map((key) => key.id),
        [created.key.id],
      );

      async function agentRequest(path: string, method = "GET", body?: unknown) {
        return app.request(`/api/v1/agent${path}`, {
          method,
          headers: {
            authorization: `Bearer ${created.key.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }

      const context = (await (await agentRequest("/context")).json()) as {
        authenticatedUser: { id: string; role: string };
      };
      assert.deepEqual(context.authenticatedUser, {
        id: ic.id,
        name: "Access IC",
        email: `access-ic-${suffix}@example.test`,
        role: "ic",
      });

      const members = (await (await agentRequest("/members")).json()) as {
        members: Array<{ id: string }>;
      };
      assert.deepEqual(
        members.members.map((member) => member.id),
        [ic.id],
      );

      const accounts = (await (await agentRequest("/accounts")).json()) as {
        accounts: Array<{ id: string }>;
      };
      assert.deepEqual(
        accounts.accounts.map((account) => account.id),
        [icAccount.id],
      );
      assert.equal((await agentRequest(`/accounts/${founderAccount.id}`)).status, 404);
      assert.equal(
        (
          await agentRequest("/create-task", "POST", {
            ownerId: founder.id,
            workstream: "sales",
            kind: "research",
            title: "Forbidden task",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await agentRequest("/create-task", "POST", {
            ownerId: ic.id,
            workstream: "sales",
            kind: "research",
            title: "Allowed task",
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await agentRequest(`/accounts/${icAccount.id}`, "PATCH", {
            initiatingUserId: founder.id,
            tier: "A",
          })
        ).status,
        403,
      );

      assert.equal(
        (
          await app.request(`/api/agent-keys/${created.key.id}`, {
            method: "DELETE",
            headers: { cookie },
          })
        ).status,
        200,
      );
      assert.equal((await agentRequest("/context")).status, 401);
    } finally {
      await sql`DELETE FROM workspaces WHERE id = ${workspace.id}`;
      await sql`DELETE FROM users WHERE id IN (${founder.id}, ${ic.id})`;
      await closeDatabase();
    }
  },
);
