import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test(
  "domain reassignment revokes stale workspace sending, receiving, and new address claims",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [
      { Hono },
      { config, configureRuntime },
      { sql, closeDatabase },
      { runMigrations },
      security,
      { mailRoutes },
      { ingestMail },
    ] = await Promise.all([
      import("hono"),
      import("./config"),
      import("./db"),
      import("./migrate"),
      import("./security"),
      import("./mail-routes"),
      import("./mail-store"),
    ]);
    await runMigrations();
    const suffix = randomUUID();
    const oldSlug = `old-domain-owner-${suffix}`;
    const newSlug = `new-domain-owner-${suffix}`;
    configureRuntime({
      ...process.env,
      NODE_ENV: "test",
      MAIL_DOMAINS: "mail.example",
      MAIL_DOMAIN_WORKSPACES: JSON.stringify({ "mail.example": newSlug }),
      MAIL_SENDING_ENABLED: "true",
    });
    const [oldWorkspace, newWorkspace] = await sql<Array<{ id: string }>>`
      INSERT INTO workspaces (name, slug) VALUES
        ('Old domain owner', ${oldSlug}),
        ('New domain owner', ${newSlug})
      RETURNING id
    `;
    const [oldFounder] = await sql<Array<{ id: string }>>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${`old-founder-${suffix}@example.test`}, 'Old Founder', 'test-only')
      RETURNING id
    `;
    const token = security.createOpaqueToken();

    try {
      await sql`
        INSERT INTO memberships (workspace_id, user_id, role)
        VALUES (${oldWorkspace!.id}, ${oldFounder!.id}, 'founder')
      `;
      await sql`
        INSERT INTO sessions (user_id, token_hash, selected_workspace_id, expires_at)
        VALUES (
          ${oldFounder!.id}, ${security.hashToken(token)}, ${oldWorkspace!.id},
          now() + interval '1 hour'
        )
      `;
      const [staleMailbox] = await sql<Array<{ id: string }>>`
        INSERT INTO mailboxes (
          workspace_id, email, normalized_email, display_name, kind, owner_id, created_by
        ) VALUES (
          ${oldWorkspace!.id}, 'stale@mail.example', 'stale@mail.example', 'Stale mailbox',
          'private', ${oldFounder!.id}, ${oldFounder!.id}
        ) RETURNING id
      `;

      const app = new Hono();
      app.route("/api/mail", mailRoutes);
      let sends = 0;
      const env = {
        MAILER: {
          send: async () => {
            sends += 1;
            return { messageId: `unexpected-${suffix}` };
          },
        },
      };
      const request = (path: string, method = "GET", body?: unknown) =>
        app.request(
          `/api/mail${path}`,
          {
            method,
            headers: {
              cookie: `${config.SESSION_COOKIE_NAME}=${token}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          env,
        );

      const provision = await request("/mailboxes", "POST", {
        email: "another@mail.example",
        displayName: "Another",
        kind: "private",
        ownerId: oldFounder!.id,
      });
      assert.equal(provision.status, 422);

      const draftResponse = await request("/drafts", "POST", {
        mailboxId: staleMailbox!.id,
        to: ["buyer@example.test"],
        subject: "Must not send",
        text: "This domain belongs to another workspace now.",
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()) as { id: string };
      const send = await request(`/drafts/${draft.id}/send`, "POST", {
        idempotencyKey: `stale-domain-${suffix}`,
      });
      assert.notEqual(send.status, 200);
      assert.equal(sends, 0);

      const inbound = await ingestMail({
        envelopeTo: "stale@mail.example",
        internetMessageId: `<stale-${suffix}@example.test>`,
        from: { email: "buyer@example.test" },
        to: [{ email: "stale@mail.example" }],
        subject: "Must not route",
        text: "This domain belongs to another workspace now.",
      });
      assert.deepEqual(inbound, { status: "unroutable", mailboxIds: [] });

      await sql`
        INSERT INTO memberships (workspace_id, user_id, role)
        VALUES (${newWorkspace!.id}, ${oldFounder!.id}, 'founder')
      `;
      await sql`
        DELETE FROM memberships
        WHERE workspace_id = ${oldWorkspace!.id} AND user_id = ${oldFounder!.id}
      `;
      const setupAfterRemoval = await request("/setup");
      assert.equal(setupAfterRemoval.status, 200);
      const setup = (await setupAfterRemoval.json()) as { mailboxes: Array<{ id: string }> };
      assert.deepEqual(setup.mailboxes, []);
      assert.equal((await request(`/conversations?mailboxId=${staleMailbox!.id}`)).status, 404);
    } finally {
      await sql`DELETE FROM workspaces WHERE id IN (${oldWorkspace!.id}, ${newWorkspace!.id})`;
      await sql`DELETE FROM users WHERE id = ${oldFounder!.id}`;
      await closeDatabase();
    }
  },
);
