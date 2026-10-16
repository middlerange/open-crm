import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { crmEditPayload } from "../src/lib/crm-edit.js";
import { validateImportRow } from "./crm-config-routes.js";
import { accountUpdateSchema } from "./crm-routes.js";

test("account location PATCH preserves omitted fields and accepts explicit clearing", () => {
  const unchangedLocations = accountUpdateSchema.parse({ name: "Updated company" });
  for (const field of ["country", "state", "city"]) {
    assert.equal(Object.hasOwn(unchangedLocations, field), false);
  }
  const cityOnly = accountUpdateSchema.parse({ city: " Mysuru " });
  assert.equal(cityOnly.city, "Mysuru");
  assert.equal(Object.hasOwn(cityOnly, "country"), false);
  assert.equal(Object.hasOwn(cityOnly, "state"), false);
  const cleared = accountUpdateSchema.parse({ country: "", state: " ", city: "" });
  assert.deepEqual([cleared.country, cleared.state, cleared.city], ["", "", ""]);
});

test("CRM import validates values before writing each row", () => {
  assert.match(
    validateImportRow({ name: "Acme", industry: "x".repeat(121) }, "account")!,
    /industry/,
  );
  assert.equal(validateImportRow({ name: "Acme", industry: "Fintech" }, "account"), null);
  assert.equal(validateImportRow({ name: "Acme", score: "100", tier: "a" }, "account"), null);
  assert.match(validateImportRow({ name: "Acme", score: "100.5" }, "account")!, /integer/);
  assert.match(validateImportRow({ name: "A" }, "account")!, /at least 2/);
  assert.match(
    validateImportRow({ first_name: "Jo", account_domain: "acme.test", email: "bad" }, "lead")!,
    /email/,
  );
  assert.equal(validateImportRow({ first_name: "Jo", account_domain: "acme.test" }, "lead"), null);
  assert.match(validateImportRow({ first_name: "Jo" }, "contact")!, /account_domain/);
  for (const field of ["country", "state", "city"]) {
    assert.match(
      validateImportRow({ name: "Acme", [field]: "x".repeat(121) }, "account")!,
      new RegExp(field),
    );
    assert.match(
      validateImportRow(
        { first_name: "Jo", account_domain: "acme.test", [field]: "x".repeat(121) },
        "contact",
      )!,
      new RegExp(field),
    );
  }
  assert.equal(
    validateImportRow(
      { name: "Acme", country: "India", state: "Karnataka", city: "Bengaluru" },
      "account",
    ),
    null,
  );
});

test("CRM edit payload removes restricted IC fields and preserves manager controls", () => {
  const fields = { ownerId: "owner", status: "active", name: "Updated" };
  assert.deepEqual(crmEditPayload("account", "ic", fields), { name: "Updated" });
  assert.deepEqual(crmEditPayload("contact", "ic", fields), { status: "active", name: "Updated" });
  assert.deepEqual(crmEditPayload("opportunity", "ic", fields), {
    status: "active",
    name: "Updated",
  });
  assert.deepEqual(crmEditPayload("account", "manager", fields), fields);
  assert.deepEqual(fields, { ownerId: "owner", status: "active", name: "Updated" });
});

test("CRM import rejects malformed web identities", () => {
  assert.match(validateImportRow({ name: "Acme", domain: "not a domain" }, "account")!, /domain/);
  assert.match(
    validateImportRow(
      { name: "Acme", linkedin_url: "https://example.com/company/acme" },
      "account",
    )!,
    /LinkedIn/,
  );
  assert.equal(
    validateImportRow(
      { name: "Acme", domain: "acme.example", linkedin_url: "linkedin.com/company/acme" },
      "account",
    ),
    null,
  );
});

test(
  "CRM transfer isolates row failures, checks duplicates, filters exports and preserves IC ownership",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [{ app }, { config }, { sql, closeDatabase }, { runMigrations }, security] =
      await Promise.all([
        import("./app.js"),
        import("./config.js"),
        import("./db.js"),
        import("./migrate.js"),
        import("./security.js"),
      ]);
    await runMigrations();
    const suffix = randomUUID();
    const [workspace] = await sql<
      { id: string }[]
    >`INSERT INTO workspaces (name, slug) VALUES ('Transfer test', ${`transfer-${suffix}`}) RETURNING id`;
    const users = await sql<{ id: string }[]>`INSERT INTO users (email, name, password_hash) VALUES
    (${`transfer-founder-${suffix}@example.test`}, 'Transfer Founder', 'test-only'),
    (${`transfer-ic-${suffix}@example.test`}, 'Transfer IC', 'test-only') RETURNING id`;
    const founder = users[0]!;
    const ic = users[1]!;
    const founderToken = security.createOpaqueToken();
    const icToken = security.createOpaqueToken();
    async function request(token: string, path: string, body?: unknown, method?: string) {
      return app.request(`/api${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          cookie: `${config.SESSION_COOKIE_NAME}=${token}`,
          origin: config.APP_ORIGIN,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    try {
      await sql`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${workspace.id}, ${founder.id}, 'founder'), (${workspace.id}, ${ic.id}, 'ic')`;
      await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES
      (${founder.id}, ${security.hashToken(founderToken)}, now() + interval '10 minutes'),
      (${ic.id}, ${security.hashToken(icToken)}, now() + interval '10 minutes')`;
      assert.equal((await app.request("/api/crm/export/account")).status, 401);
      const accountCsv = `name,domain,linkedin_url,external_source,external_id,score\nAlpha,alpha-${suffix}.test,https://linkedin.com/company/${suffix},test,one,10\nLinkedIn duplicate,other-${suffix}.test,https://www.linkedin.com/company/${suffix}/,test,two,20\nExternal duplicate,external-${suffix}.test,,test,one,20\nInvalid score,invalid-${suffix}.test,,test,four,101\nBeta,beta-${suffix}.test,,test,five,20\nAlpha,,,test,six,20`;
      const imported = await request(founderToken, "/crm/import", {
        entityType: "account",
        csv: accountCsv,
      });
      assert.equal(imported.status, 200);
      const summary = (await imported.json()) as {
        created: number;
        duplicates: number;
        failed: number;
        skipped: number;
        issues: Array<{ row: number; kind: string }>;
      };
      assert.deepEqual(
        [summary.created, summary.duplicates, summary.failed, summary.skipped],
        [2, 3, 1, 4],
      );
      assert.equal(summary.issues.find((issue) => issue.row === 5)?.kind, "failed");
      const accounts = await sql<
        { id: string; ownerId: string }[]
      >`SELECT id, owner_id AS "ownerId" FROM accounts WHERE workspace_id = ${workspace.id}`;
      assert.equal(accounts.length, 2);
      assert.ok(accounts.every((account) => account.ownerId === founder.id));
      const leadImport = await request(founderToken, "/crm/import", {
        entityType: "lead",
        csv: `first_name,last_name,account_domain,email,linkedin_url\nJo,Smith,alpha-${suffix}.test,jo-${suffix}@example.test,https://linkedin.com/in/${suffix}\nJoseph,Smith,alpha-${suffix}.test,,https://www.linkedin.com/in/${suffix}/\nJo,Smith,alpha-${suffix}.test,,\nBad,Email,alpha-${suffix}.test,invalid,`,
      });
      assert.equal(leadImport.status, 200);
      const leadSummary = (await leadImport.json()) as {
        created: number;
        duplicates: number;
        failed: number;
      };
      assert.deepEqual(
        [leadSummary.created, leadSummary.duplicates, leadSummary.failed],
        [1, 2, 1],
      );
      await sql`UPDATE contacts SET title = 'Preserved title', notes = 'Preserved notes' WHERE workspace_id = ${workspace.id}`;
      const upsert = await request(founderToken, "/crm/import", {
        entityType: "contact",
        mode: "upsert",
        csv: `first_name,account_domain,email\nJo,alpha-${suffix}.test,jo-${suffix}@example.test`,
      });
      assert.equal(((await upsert.json()) as { updated: number }).updated, 1);
      const [preserved] = await sql<
        { title: string; notes: string }[]
      >`SELECT title, notes FROM contacts WHERE workspace_id = ${workspace.id}`;
      assert.deepEqual(preserved, { title: "Preserved title", notes: "Preserved notes" });
      const simultaneous = await Promise.all(
        [1, 2].map((index) =>
          request(founderToken, "/crm/import", {
            entityType: "account",
            csv: `name,domain\nConcurrent,concurrent-${index}-${suffix}.test`,
          }),
        ),
      );
      const concurrentSummaries = await Promise.all(
        simultaneous.map(
          (response) => response.json() as Promise<{ created: number; duplicates: number }>,
        ),
      );
      assert.equal(
        concurrentSummaries.reduce((sum, summary) => sum + summary.created, 0),
        1,
      );
      assert.equal(
        concurrentSummaries.reduce((sum, summary) => sum + summary.duplicates, 0),
        1,
      );
      const changedFields = await request(founderToken, "/crm/import", {
        entityType: "account",
        mode: "upsert",
        csv: `name,domain,tier,score,industry\nAlpha,alpha-${suffix}.test,A,88,Fintech`,
      });
      assert.equal(((await changedFields.json()) as { updated: number }).updated, 1);
      const [changedAccount] = await sql<
        { tier: string; score: number; industry: string }[]
      >`SELECT tier, score, industry FROM accounts WHERE workspace_id = ${workspace.id} AND name = 'Alpha'`;
      assert.deepEqual(changedAccount, { tier: "A", score: 88, industry: "Fintech" });
      const preservedIndustry = await request(founderToken, "/crm/import", {
        entityType: "account",
        mode: "upsert",
        csv: `name,domain\nAlpha,alpha-${suffix}.test`,
      });
      assert.equal(((await preservedIndustry.json()) as { updated: number }).updated, 1);
      const [industryAfterUpsert] = await sql<
        { industry: string }[]
      >`SELECT industry FROM accounts WHERE workspace_id = ${workspace.id} AND name = 'Alpha'`;
      assert.equal(industryAfterUpsert.industry, "Fintech");
      const changedEmail = await request(founderToken, "/crm/import", {
        entityType: "contact",
        mode: "upsert",
        csv: `first_name,last_name,account_domain,email\nJo,Smith,alpha-${suffix}.test,new-${suffix}@example.test`,
      });
      assert.equal(((await changedEmail.json()) as { updated: number }).updated, 1);
      const [changedContact] = await sql<
        { email: string; normalizedEmail: string }[]
      >`SELECT email, normalized_email AS "normalizedEmail" FROM contacts WHERE workspace_id = ${workspace.id}`;
      assert.deepEqual(changedContact, {
        email: `new-${suffix}@example.test`,
        normalizedEmail: `new-${suffix}@example.test`,
      });
      const icImport = await request(icToken, "/crm/import", {
        entityType: "account",
        mode: "upsert",
        csv: `name,domain\nAlpha,alpha-${suffix}.test`,
      });
      assert.equal(icImport.status, 200);
      assert.equal(((await icImport.json()) as { failed: number }).failed, 1);
      const forbiddenContact = await request(icToken, "/crm/import", {
        entityType: "lead",
        csv: `first_name,account_domain\nHidden,alpha-${suffix}.test`,
      });
      assert.equal(((await forbiddenContact.json()) as { failed: number }).failed, 1);
      const filtered = await request(
        founderToken,
        "/crm/export/account?search=Alpha&status=research",
      );
      const exportCsv = await filtered.text();
      assert.match(exportCsv, /Alpha/);
      assert.match(exportCsv, /industry/);
      assert.match(exportCsv, /Fintech/);
      const industrySearch = await request(founderToken, "/accounts?search=Fintech");
      const matchingAccounts = (await industrySearch.json()) as {
        accounts: Array<{ name: string; industry: string }>;
      };
      assert.deepEqual(
        matchingAccounts.accounts.map(({ name, industry }) => ({ name, industry })),
        [{ name: "Alpha", industry: "Fintech" }],
      );
      assert.match(
        await (await request(founderToken, "/crm/export/account?search=Fintech")).text(),
        /Alpha/,
      );
      assert.doesNotMatch(exportCsv, /Beta/);
      assert.doesNotMatch(
        await (await request(icToken, "/crm/export/account?archived=all")).text(),
        /Alpha/,
      );
      const leads = await request(
        founderToken,
        "/crm/export/lead?search=Transfer%20Founder&consentStatus=unknown",
      );
      assert.match(await leads.text(), /Smith/);
      assert.doesNotMatch(await (await request(icToken, "/crm/export/lead")).text(), /Smith/);
      assert.equal(
        (await request(founderToken, "/crm/export/contact?accountId=invalid")).status,
        422,
      );
      const ownAccountResponse = await request(icToken, "/accounts", {
        name: "IC save test",
        industry: "HR technology",
        domain: `ic-save-${suffix}.test`,
      });
      assert.equal(ownAccountResponse.status, 201);
      const ownAccount = (await ownAccountResponse.json()) as { id: string };
      const createdDetail = await request(icToken, `/accounts/${ownAccount.id}`);
      assert.equal(
        ((await createdDetail.json()) as { account: { industry: string } }).account.industry,
        "HR technology",
      );
      const accountEdit = {
        name: "IC account updated",
        ownerId: ic.id,
        status: "research",
        fitSummary: "Updated research",
        industry: "Insurance",
      };
      assert.equal(
        (await request(icToken, `/accounts/${ownAccount.id}`, accountEdit, "PATCH")).status,
        403,
      );
      assert.equal(
        (
          await request(
            icToken,
            `/accounts/${ownAccount.id}`,
            crmEditPayload("account", "ic", accountEdit),
            "PATCH",
          )
        ).status,
        200,
      );
      const [savedAccount] = await sql<
        { name: string; status: string; ownerId: string; industry: string }[]
      >`SELECT name, status, owner_id AS "ownerId", industry FROM accounts WHERE id = ${ownAccount.id}`;
      assert.deepEqual(savedAccount, {
        name: "IC account updated",
        industry: "Insurance",
        status: "research",
        ownerId: ic.id,
      });
      const ownContactResponse = await request(icToken, "/contacts", {
        accountId: ownAccount.id,
        firstName: "IC contact",
      });
      assert.equal(ownContactResponse.status, 201);
      const ownContact = (await ownContactResponse.json()) as { id: string };
      const contactEdit = {
        firstName: "IC contact updated",
        ownerId: ic.id,
        status: "verified",
        notes: "Updated notes",
      };
      assert.equal(
        (await request(icToken, `/contacts/${ownContact.id}`, contactEdit, "PATCH")).status,
        403,
      );
      assert.equal(
        (
          await request(
            icToken,
            `/contacts/${ownContact.id}`,
            crmEditPayload("contact", "ic", contactEdit),
            "PATCH",
          )
        ).status,
        200,
      );
      const [savedContact] = await sql<
        { firstName: string; status: string; ownerId: string }[]
      >`SELECT first_name AS "firstName", status, owner_id AS "ownerId" FROM contacts WHERE id = ${ownContact.id}`;
      assert.deepEqual(savedContact, {
        firstName: "IC contact updated",
        status: "verified",
        ownerId: ic.id,
      });
      const [stage] = await sql<
        { id: string }[]
      >`INSERT INTO opportunity_stages (workspace_id, key, name, position, probability, terminal, won) VALUES (${workspace.id}, 'open', 'Open', 1, 25, false, false) RETURNING id`;
      await sql`UPDATE accounts SET status = 'approved' WHERE id = ${ownAccount.id}`;
      const nextActionAt = new Date(Date.now() + 86400000).toISOString();
      const opportunityResponse = await request(icToken, "/opportunities", {
        accountId: ownAccount.id,
        name: "IC opportunity",
        stageId: stage.id,
        nextAction: "Book meeting",
        nextActionAt,
      });
      assert.equal(opportunityResponse.status, 201);
      const ownOpportunity = (await opportunityResponse.json()) as { id: string };
      const opportunityEdit = {
        name: "IC opportunity updated",
        ownerId: ic.id,
        nextAction: "Updated next action",
        nextActionAt,
      };
      assert.equal(
        (await request(icToken, `/opportunities/${ownOpportunity.id}`, opportunityEdit, "PATCH"))
          .status,
        403,
      );
      assert.equal(
        (
          await request(
            icToken,
            `/opportunities/${ownOpportunity.id}`,
            crmEditPayload("opportunity", "ic", opportunityEdit),
            "PATCH",
          )
        ).status,
        200,
      );
      const [savedOpportunity] = await sql<
        { name: string; ownerId: string }[]
      >`SELECT name, owner_id AS "ownerId" FROM opportunities WHERE id = ${ownOpportunity.id}`;
      assert.deepEqual(savedOpportunity, { name: "IC opportunity updated", ownerId: ic.id });
      for (const [entity, record] of [
        ["accounts", ownAccount],
        ["contacts", ownContact],
        ["opportunities", ownOpportunity],
      ] as const) {
        assert.equal(
          (await request(icToken, `/${entity}/${record.id}`, { ownerId: founder.id }, "PATCH"))
            .status,
          403,
        );
      }
      const foreignAccount = accounts[0]!;
      assert.equal(
        (
          await request(
            icToken,
            `/accounts/${foreignAccount.id}`,
            crmEditPayload("account", "ic", accountEdit),
            "PATCH",
          )
        ).status,
        404,
      );
      const [foreignContact] = await sql<
        { id: string }[]
      >`SELECT id FROM contacts WHERE workspace_id = ${workspace.id} AND owner_id = ${founder.id}`;
      assert.equal(
        (
          await request(
            icToken,
            `/contacts/${foreignContact.id}`,
            crmEditPayload("contact", "ic", contactEdit),
            "PATCH",
          )
        ).status,
        404,
      );
      await sql`UPDATE opportunities SET owner_id = ${founder.id} WHERE id = ${ownOpportunity.id}`;
      assert.equal(
        (
          await request(
            icToken,
            `/opportunities/${ownOpportunity.id}`,
            crmEditPayload("opportunity", "ic", opportunityEdit),
            "PATCH",
          )
        ).status,
        404,
      );
    } finally {
      await sql`DELETE FROM workspaces WHERE id = ${workspace.id}`;
      await sql`DELETE FROM users WHERE id = ANY(${users.map((user) => user.id)}::uuid[])`;
      await closeDatabase();
    }
  },
);
