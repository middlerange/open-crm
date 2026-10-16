import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test(
  "sessions switch only to memberships and preserve fallback compatibility",
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
    const passwordHash = await security.hashPassword("test-password-1234");
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${`workspace-${suffix}@example.test`}, 'Workspace User', ${passwordHash})
      RETURNING id
    `;
    const workspaces = await sql<Array<{ id: string; name: string }>>`
      INSERT INTO workspaces (name, slug) VALUES
        ('First team', ${`first-${suffix}`}),
        ('Second team', ${`second-${suffix}`}),
        ('Forbidden team', ${`forbidden-${suffix}`})
      RETURNING id, name
    `;
    const first = workspaces.find((workspace) => workspace.name === "First team")!;
    const second = workspaces.find((workspace) => workspace.name === "Second team")!;
    const forbidden = workspaces.find((workspace) => workspace.name === "Forbidden team")!;
    const token = security.createOpaqueToken();
    let createdWorkspaceId: string | undefined;

    try {
      await sql`
        INSERT INTO memberships (workspace_id, user_id, role, joined_at) VALUES
          (${first.id}, ${user.id}, 'ic', now() - interval '1 minute'),
          (${second.id}, ${user.id}, 'manager', now())
      `;
      await sql`
        INSERT INTO sessions (user_id, token_hash, expires_at, selected_workspace_id)
        VALUES (${user.id}, ${security.hashToken(token)}, now() + interval '1 hour', NULL)
      `;
      const cookie = `${config.SESSION_COOKIE_NAME}=${token}`;
      const meBefore = await app.request("/api/auth/me", { headers: { cookie } });
      assert.equal(meBefore.status, 200);
      assert.equal(
        ((await meBefore.json()) as { user: { workspaceId: string } }).user.workspaceId,
        first.id,
      );

      const list = await app.request("/api/auth/workspaces", { headers: { cookie } });
      assert.equal(list.status, 200);
      const listed = (await list.json()) as {
        workspaces: Array<{ id: string; role: string; current: boolean }>;
      };
      assert.deepEqual(
        listed.workspaces.map(({ id, role, current }) => ({ id, role, current })),
        [
          { id: first.id, role: "ic", current: true },
          { id: second.id, role: "manager", current: false },
        ],
      );

      assert.equal(
        (
          await app.request(`/api/auth/workspaces/${forbidden.id}/switch`, {
            method: "POST",
            headers: { cookie },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await app.request(`/api/auth/workspaces/${second.id}/switch`, {
            method: "POST",
            headers: { cookie },
          })
        ).status,
        200,
      );
      const meAfter = await app.request("/api/auth/me", { headers: { cookie } });
      const switched = (await meAfter.json()) as { user: { workspaceId: string; role: string } };
      assert.deepEqual(switched.user, {
        id: user.id,
        name: "Workspace User",
        email: `workspace-${suffix}@example.test`,
        role: "manager",
        workspaceId: second.id,
        workspaceName: "Second team",
        workspaceSlug: `second-${suffix}`,
      });

      const create = await app.request("/api/auth/workspaces", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Third team" }),
      });
      assert.equal(create.status, 201);
      const created = (await create.json()) as {
        workspace: { id: string; role: string; current: boolean };
      };
      createdWorkspaceId = created.workspace.id;
      assert.equal(created.workspace.role, "founder");
      assert.equal(created.workspace.current, true);
      const [{ count: stageCount }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM opportunity_stages
        WHERE workspace_id = ${createdWorkspaceId}
      `;
      assert.equal(stageCount, 9);
    } finally {
      if (createdWorkspaceId) {
        await sql`DELETE FROM workspaces WHERE id = ${createdWorkspaceId}`;
      }
      await sql`DELETE FROM workspaces WHERE id IN ${sql(workspaces.map(({ id }) => id))}`;
      await sql`DELETE FROM users WHERE id = ${user.id}`;
      await closeDatabase();
    }
  },
);

test(
  "existing users accept an additional-team invite without changing their password",
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
    const password = "existing-password-1234";
    const passwordHash = await security.hashPassword(password);
    const [founder, invited] = await sql<Array<{ id: string; email: string }>>`
    INSERT INTO users (email, name, password_hash) VALUES
      (${`founder-${suffix}@example.test`}, 'Founder', ${passwordHash}),
      (${`invited-${suffix}@example.test`}, 'Invited User', ${passwordHash})
    RETURNING id, email
  `;
    const [source, destination] = await sql<Array<{ id: string }>>`
    INSERT INTO workspaces (name, slug) VALUES
      ('Source', ${`source-${suffix}`}),
      ('Destination', ${`destination-${suffix}`})
    RETURNING id
  `;
    const founderToken = security.createOpaqueToken();

    try {
      await sql`
      INSERT INTO memberships (workspace_id, user_id, role) VALUES
        (${destination.id}, ${founder.id}, 'founder'),
        (${source.id}, ${invited.id}, 'ic')
    `;
      await sql`
      INSERT INTO sessions (user_id, token_hash, expires_at, selected_workspace_id)
      VALUES (${founder.id}, ${security.hashToken(founderToken)}, now() + interval '1 hour', ${destination.id})
    `;
      const founderCookie = `${config.SESSION_COOKIE_NAME}=${founderToken}`;
      const created = await app.request("/api/auth/invites", {
        method: "POST",
        headers: { cookie: founderCookie, "content-type": "application/json" },
        body: JSON.stringify({ email: invited.email, role: "manager" }),
      });
      assert.equal(created.status, 201);
      const { inviteUrl } = (await created.json()) as { inviteUrl: string };
      const inviteToken = new URL(inviteUrl).searchParams.get("token")!;
      const lookup = await app.request(`/api/auth/invite/${inviteToken}`);
      assert.equal(lookup.status, 200);
      assert.equal(
        ((await lookup.json()) as { invite: { existingAccount: boolean } }).invite.existingAccount,
        true,
      );

      const wrongPassword = await app.request("/api/auth/invite/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: inviteToken, password: "wrong-password" }),
      });
      assert.equal(wrongPassword.status, 401);

      const accepted = await app.request("/api/auth/invite/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: inviteToken, password }),
      });
      assert.equal(accepted.status, 201);
      assert.match(
        accepted.headers.get("set-cookie") ?? "",
        new RegExp(`^${config.SESSION_COOKIE_NAME}=`),
      );
      const [stored] = await sql<{ passwordHash: string; role: string }[]>`
      SELECT u.password_hash AS "passwordHash", m.role
      FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.id = ${invited.id} AND m.workspace_id = ${destination.id}
    `;
      assert.equal(stored.passwordHash, passwordHash);
      assert.equal(stored.role, "manager");
      assert.equal(
        (
          await app.request("/api/auth/invite/accept", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: inviteToken, password }),
          })
        ).status,
        404,
      );
    } finally {
      await sql`DELETE FROM workspaces WHERE id IN (${source.id}, ${destination.id})`;
      await sql`DELETE FROM users WHERE id IN (${founder.id}, ${invited.id})`;
      await closeDatabase();
    }
  },
);
