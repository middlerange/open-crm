import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test(
  "lightweight CRM routes preserve workspace ownership and record complete CRM history",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [{ app }, { config }, { sql, closeDatabase }, { runMigrations }, security] =
      await Promise.all([
        import("./app"),
        import("./config"),
        import("./db"),
        import("./migrate"),
        import("./security"),
      ]);
    await runMigrations();

    const suffix = randomUUID();
    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO workspaces (name, slug)
      VALUES (${`CRM test ${suffix}`}, ${`crm-test-${suffix}`}) RETURNING id
    `;
    const users = await sql<{ id: string; email: string }[]>`
      INSERT INTO users (email, name, password_hash) VALUES
        (${`founder-${suffix}@example.test`}, 'CRM Founder', 'test-only'),
        (${`ic-${suffix}@example.test`}, 'CRM IC', 'test-only'),
        (${`outsider-${suffix}@example.test`}, 'CRM Outsider', 'test-only')
      RETURNING id, email
    `;
    const founder = users[0]!;
    const ic = users[1]!;
    const outsider = users[2]!;
    const founderToken = security.createOpaqueToken();
    const icToken = security.createOpaqueToken();

    try {
      await sql`
        INSERT INTO memberships (workspace_id, user_id, role) VALUES
          (${workspace.id}, ${founder.id}, 'founder'),
          (${workspace.id}, ${ic.id}, 'ic')
      `;
      const stages = await sql<{ id: string; key: string }[]>`
        INSERT INTO opportunity_stages (
          workspace_id, key, name, position, probability, terminal, won
        ) VALUES
          (${workspace.id}, 'open', 'Open', 1, 25, false, false),
          (${workspace.id}, 'won', 'Won', 2, 100, true, true),
          (${workspace.id}, 'lost', 'Lost', 3, 0, true, false)
        RETURNING id, key
      `;
      await sql`
        INSERT INTO sessions (user_id, token_hash, expires_at) VALUES
          (${founder.id}, ${security.hashToken(founderToken)}, now() + interval '10 minutes'),
          (${ic.id}, ${security.hashToken(icToken)}, now() + interval '10 minutes')
      `;

      async function request(token: string, path: string, method = "GET", body?: unknown) {
        return app.request(`/api${path}`, {
          method,
          headers: {
            cookie: `${config.SESSION_COOKIE_NAME}=${token}`,
            origin: config.APP_ORIGIN,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }

      const stageList = (await (await request(founderToken, "/crm/stages")).json()) as {
        stages: Array<{ id: string; key: string; probability: number }>;
      };
      assert.equal(stageList.stages.length, 3);
      assert.equal(
        (
          await request(icToken, "/crm/stages", "POST", {
            name: "IC-created stage",
            probability: 40,
          })
        ).status,
        403,
      );
      const customStageResponse = await request(founderToken, "/crm/stages", "POST", {
        name: "Evaluation",
        probability: 55,
      });
      assert.equal(customStageResponse.status, 201);
      const customStage = (await customStageResponse.json()) as { id: string };
      assert.equal(
        (
          await request(founderToken, `/crm/stages/${customStage.id}`, "PATCH", {
            won: true,
            terminal: false,
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await request(founderToken, `/crm/stages/${customStage.id}`, "PATCH", {
            name: "Technical evaluation",
            probability: 60,
          })
        ).status,
        200,
      );

      const accountResponse = await request(founderToken, "/accounts", "POST", {
        name: "=Formula-safe Account",
        country: " India ",
        state: " Karnataka ",
        city: " Bengaluru ",
        domain: `acme-${suffix}.example`,
        tier: "A",
        fitSummary: "Strong product-led fit",
        evidenceSummary: "Evidence",
        triggerSummary: "Trigger",
        sourceLinks: ["https://example.com/source"],
      });
      assert.equal(accountResponse.status, 201);
      const account = (await accountResponse.json()) as { id: string };
      const createdAccount = (await (
        await request(founderToken, `/accounts/${account.id}`)
      ).json()) as {
        account: { country: string; state: string; city: string };
      };
      assert.deepEqual(
        [createdAccount.account.country, createdAccount.account.state, createdAccount.account.city],
        ["India", "Karnataka", "Bengaluru"],
      );
      assert.equal(
        (await request(founderToken, `/accounts/${account.id}`, "PATCH", { city: "Mysuru" }))
          .status,
        200,
      );
      const updatedAccount = (await (
        await request(founderToken, `/accounts/${account.id}`)
      ).json()) as {
        account: { country: string; state: string; city: string };
      };
      assert.deepEqual(
        [updatedAccount.account.country, updatedAccount.account.state, updatedAccount.account.city],
        ["India", "Karnataka", "Mysuru"],
      );

      const childAccountResponse = await request(founderToken, "/accounts", "POST", {
        name: "Formula-safe Account Subsidiary",
        parentAccountId: account.id,
      });
      assert.equal(childAccountResponse.status, 201);
      const childAccount = (await childAccountResponse.json()) as { id: string };
      assert.equal(
        (
          await request(founderToken, `/accounts/${account.id}`, "PATCH", {
            parentAccountId: childAccount.id,
          })
        ).status,
        422,
      );

      const invalidOwner = await request(founderToken, "/accounts", "POST", {
        name: "Invalid owner",
        domain: `invalid-${suffix}.example`,
        ownerId: outsider.id,
      });
      assert.equal(invalidOwner.status, 422);

      const duplicateResponse = await request(founderToken, "/accounts", "POST", {
        name: "=Formula-safe Account",
      });
      assert.equal(duplicateResponse.status, 201);
      const duplicate = (await duplicateResponse.json()) as { id: string };
      const duplicateGroups = (await (
        await request(founderToken, "/crm/duplicates?entityType=account")
      ).json()) as { groups: Array<{ records: Array<{ id: string }> }> };
      assert.equal(
        duplicateGroups.groups.some((group) =>
          group.records.some((record) => record.id === duplicate.id),
        ),
        true,
      );
      assert.equal(
        (
          await request(founderToken, "/crm/merge", "POST", {
            entityType: "account",
            primaryId: account.id,
            duplicateId: duplicate.id,
          })
        ).status,
        200,
      );

      const icAccountResponse = await request(icToken, "/accounts", "POST", {
        name: "IC Account",
        domain: `ic-${suffix}.example`,
      });
      assert.equal(icAccountResponse.status, 201);
      const icAccounts = (await (await request(icToken, "/accounts")).json()) as {
        accounts: Array<{ id: string }>;
      };
      assert.equal(icAccounts.accounts.length, 1);
      assert.notEqual(icAccounts.accounts[0]?.id, account.id);
      assert.equal((await request(icToken, `/accounts/${account.id}`)).status, 404);

      const approve = await request(founderToken, `/accounts/${account.id}`, "PATCH", {
        status: "approved",
      });
      assert.equal(approve.status, 200);
      assert.equal((await request(founderToken, `/accounts/${account.id}`)).status, 200);

      const contactResponse = await request(founderToken, "/contacts", "POST", {
        accountId: account.id,
        firstName: "Jane",
        country: " United States ",
        state: " California ",
        city: " Oakland ",
        lastName: "Buyer",
        email: `jane-${suffix}@example.test`,
        consentStatus: "opted_in",
        preferredChannel: "email",
      });
      assert.equal(contactResponse.status, 201);
      const contact = (await contactResponse.json()) as { id: string };
      const contactDetail = (await (
        await request(founderToken, `/contacts/${contact.id}`)
      ).json()) as {
        contact: {
          consent_status: string;
          preferred_channel: string;
          country: string;
          state: string;
          city: string;
        };
      };
      assert.equal(contactDetail.contact.consent_status, "opted_in");
      assert.equal(contactDetail.contact.preferred_channel, "email");
      assert.deepEqual(
        [contactDetail.contact.country, contactDetail.contact.state, contactDetail.contact.city],
        ["United States", "California", "Oakland"],
      );
      assert.equal(
        (
          await request(founderToken, `/contacts/${contact.id}`, "PATCH", {
            city: " San Francisco ",
          })
        ).status,
        200,
      );
      const updatedContact = (await (
        await request(founderToken, `/contacts/${contact.id}`)
      ).json()) as {
        contact: { country: string; state: string; city: string };
      };
      assert.deepEqual(
        [updatedContact.contact.country, updatedContact.contact.state, updatedContact.contact.city],
        ["United States", "California", "San Francisco"],
      );
      assert.equal(
        (await request(founderToken, `/contacts/${contact.id}`, "PATCH", { state: "", city: "" }))
          .status,
        200,
      );
      const clearedContact = (await (
        await request(founderToken, `/contacts/${contact.id}`)
      ).json()) as {
        contact: { country: string; state: null; city: null };
      };
      assert.deepEqual(
        [clearedContact.contact.country, clearedContact.contact.state, clearedContact.contact.city],
        ["United States", null, null],
      );
      assert.equal(
        (
          await request(founderToken, `/contacts/${contact.id}`, "PATCH", {
            country: "x".repeat(121),
          })
        ).status,
        422,
      );

      const openStage = stages.find((stage) => stage.key === "open")!;
      const lostStage = stages.find((stage) => stage.key === "lost")!;
      const opportunityResponse = await request(founderToken, "/opportunities", "POST", {
        accountId: account.id,
        primaryContactId: contact.id,
        stageId: openStage.id,
        name: "CRM expansion",
        valueAmount: 12000,
        currency: "USD",
        problemSummary: "Scattered GTM context",
        nextAction: "Run workflow demo",
        nextActionAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(opportunityResponse.status, 201);
      const opportunity = (await opportunityResponse.json()) as { id: string };

      const relatedTaskResponse = await request(founderToken, "/tasks", "POST", {
        ownerId: founder.id,
        workstream: "sales",
        kind: "follow_up",
        title: "Prepare the workflow review",
        entityType: "opportunity",
        entityId: opportunity.id,
      });
      assert.equal(relatedTaskResponse.status, 201);
      const relatedTask = (await relatedTaskResponse.json()) as { id: string };
      assert.equal(
        (
          await request(founderToken, "/tasks", "POST", {
            ownerId: outsider.id,
            workstream: "sales",
            kind: "follow_up",
            title: "Invalid owner task",
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await request(icToken, "/tasks", "POST", {
            workstream: "sales",
            kind: "follow_up",
            title: "Inaccessible CRM task",
            entityType: "account",
            entityId: account.id,
          })
        ).status,
        422,
      );
      const taskList = (await (await request(founderToken, "/tasks")).json()) as {
        tasks: Array<{ entity_name: string | null }>;
      };
      assert.equal(
        taskList.tasks.some((task) => task.entity_name === "CRM expansion"),
        true,
      );
      assert.equal(
        (
          await request(founderToken, `/tasks/${relatedTask.id}`, "PATCH", {
            status: "done",
          })
        ).status,
        200,
      );
      const completedTaskList = (await (await request(founderToken, "/tasks")).json()) as {
        tasks: Array<{ id: string; completed_at: string | null }>;
      };
      const completedAt = completedTaskList.tasks.find(
        (task) => task.id === relatedTask.id,
      )?.completed_at;
      assert.ok(completedAt);
      assert.equal(
        (
          await request(founderToken, `/tasks/${relatedTask.id}`, "PATCH", {
            title: "Prepare the updated workflow review",
          })
        ).status,
        200,
      );
      const editedCompletedTaskList = (await (await request(founderToken, "/tasks")).json()) as {
        tasks: Array<{ id: string; completed_at: string | null }>;
      };
      assert.equal(
        editedCompletedTaskList.tasks.find((task) => task.id === relatedTask.id)?.completed_at,
        completedAt,
      );

      assert.equal(
        (
          await request(founderToken, `/opportunities/${opportunity.id}/stage`, "POST", {
            stageId: lostStage.id,
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await request(founderToken, `/opportunities/${opportunity.id}/stage`, "POST", {
            stageId: lostStage.id,
            lossReason: "Budget moved",
            note: "Closed after review",
          })
        ).status,
        200,
      );
      const history = (await (
        await request(founderToken, `/opportunities/${opportunity.id}/stage-history`)
      ).json()) as { stageHistory: unknown[] };
      assert.equal(history.stageHistory.length, 2);

      const fieldResponse = await request(founderToken, "/crm/fields", "POST", {
        entityType: "account",
        key: "annual_contract_value",
        label: "Annual contract value",
        fieldType: "number",
      });
      assert.equal(fieldResponse.status, 201);
      const field = (await fieldResponse.json()) as { id: string };
      assert.equal(
        (
          await request(founderToken, "/crm/field-values", "PUT", {
            fieldDefinitionId: field.id,
            entityType: "account",
            entityId: account.id,
            value: 24000,
          })
        ).status,
        200,
      );

      const tagResponse = await request(founderToken, "/crm/tags", "POST", {
        name: "Design partner",
        color: "purple",
      });
      assert.equal(tagResponse.status, 201);
      const tag = (await tagResponse.json()) as { id: string };
      assert.equal(
        (
          await request(founderToken, `/crm/entities/account/${account.id}/tags`, "PUT", {
            tagIds: [tag.id],
          })
        ).status,
        200,
      );
      const assignedTags = (await (
        await request(founderToken, `/crm/entities/account/${account.id}/tags`)
      ).json()) as { tags: Array<{ id: string }> };
      assert.deepEqual(
        assignedTags.tags.map((item) => item.id),
        [tag.id],
      );
      assert.equal(
        (
          await request(founderToken, "/crm/bulk", "POST", {
            entityType: "account",
            ids: [account.id],
            action: "tag",
            tagId: tag.id,
          })
        ).status,
        200,
      );

      assert.equal(
        (
          await request(founderToken, "/crm/suppressions", "POST", {
            kind: "email",
            value: `optout-${suffix}@example.test`,
            reason: "Requested no contact",
          })
        ).status,
        201,
      );

      const savedViewResponse = await request(founderToken, "/crm/saved-views", "POST", {
        entityType: "account",
        name: "Approved accounts",
        filters: { status: "approved" },
        sort: { field: "score", direction: "desc" },
        shared: true,
      });
      assert.equal(savedViewResponse.status, 201);
      const savedView = (await savedViewResponse.json()) as { id: string };
      const savedViews = (await (
        await request(founderToken, "/crm/saved-views?entityType=account")
      ).json()) as { views: Array<{ id: string }> };
      assert.equal(
        savedViews.views.some((view) => view.id === savedView.id),
        true,
      );

      const evidenceResponse = await request(founderToken, "/crm/evidence", "POST", {
        entityType: "account",
        entityId: account.id,
        fieldKey: "employee_range",
        proposedValue: "51-100",
        sourceUrl: "https://example.com/company",
        excerpt: "Public company profile",
      });
      assert.equal(evidenceResponse.status, 201);
      const evidence = (await evidenceResponse.json()) as { id: string };
      assert.equal(
        (
          await request(founderToken, `/crm/evidence/${evidence.id}`, "PATCH", {
            status: "accepted",
          })
        ).status,
        200,
      );

      const search = (await (await request(founderToken, "/search?q=Formula-safe")).json()) as {
        results: { accounts: Array<{ id: string }> };
      };
      assert.equal(search.results.accounts[0]?.id, account.id);
      assert.equal((await request(founderToken, "/crm/reports")).status, 200);
      const connections = (await (await request(founderToken, "/crm/connections")).json()) as {
        connections: unknown[];
        mode: string;
      };
      assert.deepEqual(connections, { connections: [], mode: "read_only" });
      const synced = (await (
        await request(founderToken, `/crm/sync/account/${account.id}`)
      ).json()) as { threads: unknown[]; events: unknown[]; mode: string };
      assert.deepEqual(synced, { threads: [], events: [], mode: "read_only" });

      assert.equal(
        (await request(founderToken, `/contacts/${contact.id}/archive`, "POST")).status,
        200,
      );
      const archivedContacts = (await (
        await request(founderToken, "/contacts?archived=archived")
      ).json()) as { contacts: Array<{ id: string }> };
      assert.equal(
        archivedContacts.contacts.some((item) => item.id === contact.id),
        true,
      );
      assert.equal(
        (await request(founderToken, `/contacts/${contact.id}/restore`, "POST")).status,
        200,
      );

      const preview = await request(founderToken, "/crm/import/preview", "POST", {
        entityType: "account",
        csv: "name,domain\nImported account,imported.example\n",
      });
      assert.equal(preview.status, 200);
      assert.equal(((await preview.json()) as { valid: boolean }).valid, true);

      const importResponse = await request(founderToken, "/crm/import", "POST", {
        entityType: "account",
        csv: `name,domain\nImported account,imported-${suffix}.example\n`,
      });
      assert.equal(importResponse.status, 200);
      assert.equal(((await importResponse.json()) as { created: number }).created, 1);

      const stagedPayload = {
        source: `test-sheet:${suffix}`,
        label: "Staged outreach test",
        accounts: [
          {
            sourceKey: `account:staged-${suffix}`,
            name: "Staged account",
            domain: `staged-${suffix}.example`,
            linkedinUrl: `https://www.linkedin.com/company/staged-${suffix}`,
            ownerName: "CRM Founder",
            tier: "A",
            score: 88,
            researchStatus: "sequence ready",
            outreachStatus: "Started",
            lastVerifiedAt: "2026-08-16T00:00:00Z",
            sourceLinks: ["https://example.com/signal"],
            sourceMeta: { sheet: "Current Targets", row: 2 },
            signals: [
              {
                sourceKey: `staged-${suffix}:signal`,
                kind: "primary_signal",
                summary: "Product team is expanding",
                sourceUrl: "https://example.com/signal",
                observedAt: "2026-08-16",
                sourceMeta: { sheet: "Current Targets", row: 2 },
              },
            ],
            contacts: [
              {
                sourceKey: `contact:buyer-${suffix}`,
                fullName: "Staged Buyer",
                title: "Head of Product",
                linkedinUrl: `https://www.linkedin.com/in/buyer-${suffix}`,
                channel: {
                  state: "requested",
                  connectionNote: "A specific connection note",
                  requestedAt: "2026-08-18T00:00:00Z",
                },
                activities: [
                  {
                    sourceKey: `buyer-${suffix}:request`,
                    type: "linkedin_request",
                    status: "completed",
                    details: "A specific connection note",
                    occurredAt: "2026-08-18T00:00:00Z",
                  },
                ],
                sourceMeta: { sheet: "CRM Founder", row: 2 },
              },
              {
                sourceKey: `contact:held-${suffix}`,
                fullName: "Held Buyer",
                linkedinUrl: `https://www.linkedin.com/in/held-${suffix}`,
                importDecision: "hold",
                sourceMeta: { sheet: "CRM Founder", row: 3 },
              },
            ],
          },
        ],
      };
      assert.equal(
        (await request(icToken, "/crm/staged-import/preview", "POST", stagedPayload)).status,
        403,
      );
      const stagedPreviewResponse = await request(
        founderToken,
        "/crm/staged-import/preview",
        "POST",
        stagedPayload,
      );
      assert.equal(stagedPreviewResponse.status, 200);
      const stagedPreview = (await stagedPreviewResponse.json()) as {
        ready: boolean;
        summary: {
          accounts: { create: number };
          contacts: { create: number; held: number };
          signals: number;
          activities: number;
        };
      };
      assert.equal(stagedPreview.ready, true);
      assert.equal(stagedPreview.summary.accounts.create, 1);
      assert.equal(stagedPreview.summary.contacts.create, 1);
      assert.equal(stagedPreview.summary.contacts.held, 1);
      assert.equal(stagedPreview.summary.signals, 1);
      assert.equal(stagedPreview.summary.activities, 1);

      const stagedCommitResponse = await request(
        founderToken,
        "/crm/staged-import/commit",
        "POST",
        stagedPayload,
      );
      assert.equal(stagedCommitResponse.status, 200);
      const stagedCommit = (await stagedCommitResponse.json()) as {
        result: { accountsCreated: number; contactsCreated: number; contactsHeld: number };
      };
      assert.equal(stagedCommit.result.accountsCreated, 1);
      assert.equal(stagedCommit.result.contactsCreated, 1);
      assert.equal(stagedCommit.result.contactsHeld, 1);

      const [stagedAccount] = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM accounts
        WHERE workspace_id = ${workspace.id} AND external_source = ${stagedPayload.source}
      `;
      assert.equal(stagedAccount.status, "research");
      const [stagedCounts] = await sql<
        {
          contacts: number;
          signals: number;
          activities: number;
          channelStates: number;
        }[]
      >`
        SELECT
          (SELECT count(*)::int FROM contacts WHERE account_id = ${stagedAccount.id}) AS contacts,
          (SELECT count(*)::int FROM account_signals WHERE account_id = ${stagedAccount.id}) AS signals,
          (SELECT count(*)::int FROM activities WHERE account_id = ${stagedAccount.id}) AS activities,
          (SELECT count(*)::int FROM contact_channel_states cs
            JOIN contacts c ON c.id = cs.contact_id WHERE c.account_id = ${stagedAccount.id}) AS "channelStates"
      `;
      assert.deepEqual(stagedCounts, { contacts: 1, signals: 1, activities: 1, channelStates: 1 });

      const secondCommitResponse = await request(
        founderToken,
        "/crm/staged-import/commit",
        "POST",
        stagedPayload,
      );
      assert.equal(secondCommitResponse.status, 200);
      const secondCommit = (await secondCommitResponse.json()) as {
        result: { accountsUnchanged: number; contactsUnchanged: number };
      };
      assert.equal(secondCommit.result.accountsUnchanged, 1);
      assert.equal(secondCommit.result.contactsUnchanged, 1);
      const [rerunCounts] = await sql<{ contacts: number; signals: number; activities: number }[]>`
        SELECT
          (SELECT count(*)::int FROM contacts WHERE account_id = ${stagedAccount.id}) AS contacts,
          (SELECT count(*)::int FROM account_signals WHERE account_id = ${stagedAccount.id}) AS signals,
          (SELECT count(*)::int FROM activities WHERE account_id = ${stagedAccount.id}) AS activities
      `;
      assert.deepEqual(rerunCounts, { contacts: 1, signals: 1, activities: 1 });

      const nameMatchAccountResponse = await request(founderToken, "/accounts", "POST", {
        name: `Name-only staged match ${suffix}`,
      });
      assert.equal(nameMatchAccountResponse.status, 201);
      const nameMatchPayload = {
        source: `name-match-sheet:${suffix}`,
        label: "Name-only staged match test",
        accounts: [
          {
            sourceKey: `account:name-match-${suffix}`,
            name: `Name-only staged match ${suffix}`,
            ownerName: "CRM Founder",
          },
        ],
      };
      const nameMatchPreview = (await (
        await request(founderToken, "/crm/staged-import/preview", "POST", nameMatchPayload)
      ).json()) as { ready: boolean; requiresNameMatchApproval: boolean };
      assert.equal(nameMatchPreview.ready, true);
      assert.equal(nameMatchPreview.requiresNameMatchApproval, true);
      assert.equal(
        (await request(founderToken, "/crm/staged-import/commit", "POST", nameMatchPayload)).status,
        409,
      );
      const approvedNameMatch = await request(founderToken, "/crm/staged-import/commit", "POST", {
        ...nameMatchPayload,
        acceptNameMatches: true,
      });
      assert.equal(approvedNameMatch.status, 200);
      assert.equal(
        (
          (await approvedNameMatch.json()) as {
            result: { accountsCreated: number; accountsUpdated: number };
          }
        ).result.accountsUpdated,
        1,
      );

      const exported = await request(founderToken, "/crm/export/account");
      assert.equal(exported.status, 200);
      assert.match(await exported.text(), /'=Formula-safe Account/);
      assert.equal(
        (await request(founderToken, `/crm/saved-views/${savedView.id}`, "DELETE")).status,
        200,
      );

      const auditRows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM audit_logs
        WHERE workspace_id = ${workspace.id} AND action LIKE 'crm_%'
      `;
      assert.ok((auditRows[0]?.count ?? 0) >= 5);
    } finally {
      await sql`DELETE FROM workspaces WHERE id = ${workspace.id}`;
      await sql`DELETE FROM users WHERE id = ANY(${users.map((user) => user.id)}::uuid[])`;
      await closeDatabase();
    }
  },
);
