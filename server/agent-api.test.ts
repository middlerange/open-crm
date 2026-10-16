import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test(
  "agent API manages Orbit work while preserving scopes, ownership, and approval gates",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [{ app }, { sql, closeDatabase }, { runMigrations }, security] = await Promise.all([
      import("./app"),
      import("./db"),
      import("./migrate"),
      import("./security"),
    ]);
    await runMigrations();

    const suffix = randomUUID();
    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO workspaces (name, slug)
      VALUES (${`Agent API test ${suffix}`}, ${`agent-api-test-${suffix}`}) RETURNING id
    `;
    const [founder] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${`agent-founder-${suffix}@example.test`}, 'Agent Founder', 'test-only')
      RETURNING id
    `;
    const token = security.createOpaqueToken();
    const readOnlyToken = security.createOpaqueToken();

    try {
      await sql`
        INSERT INTO memberships (workspace_id, user_id, role)
        VALUES (${workspace.id}, ${founder.id}, 'founder')
      `;
      await sql`
        INSERT INTO agent_tokens (workspace_id, name, token_hash, scopes, created_by) VALUES
          (${workspace.id}, 'Test writer', ${security.hashToken(token)}, ARRAY['read', 'write'], ${founder.id}),
          (${workspace.id}, 'Test reader', ${security.hashToken(readOnlyToken)}, ARRAY['read'], ${founder.id})
      `;

      async function request(apiToken: string, path: string, method = "GET", body?: unknown) {
        return app.request(`/api/v1/agent${path}`, {
          method,
          headers: {
            authorization: `Bearer ${apiToken}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }

      const members = (await (await request(token, "/members")).json()) as {
        members: Array<{ id: string }>;
      };
      assert.deepEqual(
        members.members.map((member) => member.id),
        [founder.id],
      );
      assert.equal(
        (
          await request(readOnlyToken, "/campaigns", "POST", {
            ownerId: founder.id,
            name: "Forbidden campaign",
          })
        ).status,
        403,
      );

      const accountResponse = await request(token, "/create-account", "POST", {
        ownerId: founder.id,
        name: "Agent managed account",
        domain: `agent-${suffix}.example`,
        evidenceSummary: "Public launch evidence",
        triggerSummary: "Hiring for product adoption",
        sourceLinks: ["https://example.test/evidence"],
        initiatingUserId: founder.id,
        channel: "codex",
      });
      assert.equal(accountResponse.status, 201);
      const account = (await accountResponse.json()) as { id: string };
      assert.equal(
        (
          await request(token, `/accounts/${account.id}`, "PATCH", {
            status: "active",
            initiatingUserId: founder.id,
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await request(token, `/accounts/${account.id}`, "PATCH", {
            tier: "A",
            score: 91,
            initiatingUserId: founder.id,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(token, `/accounts/${account.id}/archive`, "POST", {
            initiatingUserId: founder.id,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(token, `/accounts/${account.id}/restore`, "POST", {
            initiatingUserId: founder.id,
          })
        ).status,
        200,
      );

      const taskResponse = await request(token, "/create-task", "POST", {
        ownerId: founder.id,
        workstream: "sales",
        kind: "research",
        title: "Map the buying group",
        entityType: "account",
        entityId: account.id,
        initiatingUserId: founder.id,
        channel: "codex",
      });
      assert.equal(taskResponse.status, 201);
      const task = (await taskResponse.json()) as { id: string };
      assert.equal(
        (
          await request(token, `/tasks/${task.id}`, "PATCH", {
            status: "blocked",
            blockedReason: "Waiting for research",
            initiatingUserId: founder.id,
          })
        ).status,
        200,
      );
      const taskDetail = (await (await request(token, `/tasks/${task.id}`)).json()) as {
        task: { status: string; blocked_reason: string };
      };
      assert.equal(taskDetail.task.status, "blocked");
      assert.equal(taskDetail.task.blocked_reason, "Waiting for research");
      assert.equal(
        (
          await request(token, `/tasks/${task.id}`, "PATCH", {
            status: "done",
            initiatingUserId: founder.id,
          })
        ).status,
        200,
      );
      const completedTaskDetail = (await (await request(token, `/tasks/${task.id}`)).json()) as {
        task: { completed_at: string | null };
      };
      assert.ok(completedTaskDetail.task.completed_at);
      assert.equal(
        (
          await request(token, `/tasks/${task.id}`, "PATCH", {
            title: "Map the updated buying group",
            initiatingUserId: founder.id,
          })
        ).status,
        200,
      );
      const editedCompletedTaskDetail = (await (
        await request(token, `/tasks/${task.id}`)
      ).json()) as { task: { completed_at: string | null } };
      assert.equal(
        editedCompletedTaskDetail.task.completed_at,
        completedTaskDetail.task.completed_at,
      );

      const campaignResponse = await request(token, "/campaigns", "POST", {
        ownerId: founder.id,
        name: "Agent managed campaign",
        segment: "B2B SaaS",
        hypothesis: "Adoption pain creates urgency",
        valueProposition: "Close the release-to-adoption gap",
        channels: ["email"],
        successMetric: "Ten qualified replies",
        initiatingUserId: founder.id,
        channel: "codex",
      });
      assert.equal(campaignResponse.status, 201);
      const campaign = (await campaignResponse.json()) as { id: string };
      assert.equal(
        (
          await request(token, `/campaigns/${campaign.id}`, "PATCH", {
            status: "active",
            initiatingUserId: founder.id,
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await request(token, `/campaigns/${campaign.id}/submit`, "POST", {
            initiatingUserId: founder.id,
            channel: "codex",
          })
        ).status,
        201,
      );

      const [auditCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM audit_logs
        WHERE workspace_id = ${workspace.id} AND actor_type = 'agent'
      `;
      assert.ok(auditCount.count >= 8);
    } finally {
      await sql`DELETE FROM workspaces WHERE id = ${workspace.id}`;
      await sql`DELETE FROM users WHERE id = ${founder.id}`;
      await closeDatabase();
    }
  },
);
