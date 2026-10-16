import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { configureRuntime } from "./config.js";
import {
  mailIngressRoutes,
  parseInboundMail,
  plainTextFromHtml,
  readInboundBody,
  resolveInboundEnvelopeRecipient,
} from "./mail-ingress.js";

const aliasEnvironment = {
  NODE_ENV: "test",
  MAIL_DOMAINS: "mail.example.test",
  MAIL_DOMAIN_WORKSPACES: '{"mail.example.test":"sales"}',
  MAIL_INBOUND_ALIASES:
    '{"copy@inbound.example.test":"owner@mail.example.test","foreign@inbound.example.test":"foreign@mail.example.test"}',
} as const;

test("MIME parsing preserves real envelope routing, reply headers and safe HTML-only text", async () => {
  const raw = new TextEncoder().encode(
    [
      "From: Customer <customer@example.test>",
      "To: forged@other.test",
      "Reply-To: reply@example.test",
      "Subject: Re: Hello",
      "Message-ID: <message@example.test>",
      "In-Reply-To: <original@example.test>",
      "References: <original@example.test>",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<style>body {color: red}</style><p>Hi &amp; welcome</p><script>alert(1)</script><img src="https://tracker.test/pixel">',
    ].join("\r\n"),
  );
  const result = await parseInboundMail(raw, "actual@mail.example.test", "customer@example.test");
  assert.equal(result.envelopeTo, "actual@mail.example.test");
  assert.equal(result.to[0].email, "forged@other.test");
  assert.equal(result.replyTo[0].email, "reply@example.test");
  assert.equal(result.text, "Hi & welcome");
  assert.equal(result.inReplyTo, "<original@example.test>");
});

test("missing Message-ID gets a stable digest so redelivery deduplicates", async () => {
  const raw = new TextEncoder().encode("From: sender@example.test\r\nSubject: Test\r\n\r\nHello");
  const first = await parseInboundMail(raw, "me@example.test", "sender@example.test");
  const second = await parseInboundMail(raw, "me@example.test", "sender@example.test");
  assert.equal(first.internetMessageId, second.internetMessageId);
  assert.match(first.internetMessageId, /^<sha256-/);
});

test("trusted envelope aliases resolve once without trusting visible recipients", async () => {
  configureRuntime({
    ...aliasEnvironment,
    MAIL_INBOUND_ALIASES: '{" Copy@Inbound.Example.Test ":" Owner@Mail.Example.Test "}',
  });
  const raw = new TextEncoder().encode(
    [
      "From: Customer <customer@example.test>",
      "To: forged@other.test",
      "Subject: Alias delivery",
      "",
      "Hello",
    ].join("\r\n"),
  );
  const result = await parseInboundMail(raw, "COPY@INBOUND.EXAMPLE.TEST", "customer@example.test");
  assert.equal(result.envelopeTo, "owner@mail.example.test");
  assert.equal(result.to[0].email, "forged@other.test");
});

test("alias domains reject unknown recipients while direct mailbox routing keeps its behavior", () => {
  configureRuntime(aliasEnvironment);
  assert.equal(
    resolveInboundEnvelopeRecipient("owner@mail.example.test"),
    "owner@mail.example.test",
  );
  assert.throws(
    () => resolveInboundEnvelopeRecipient("unknown@inbound.example.test"),
    /Unknown inbound alias/,
  );

  configureRuntime({
    NODE_ENV: "test",
    MAIL_DOMAINS: "mail.example.test",
    MAIL_DOMAIN_WORKSPACES: '{"mail.example.test":"sales"}',
  });
  assert.equal(
    resolveInboundEnvelopeRecipient("unknown@inbound.example.test"),
    "unknown@inbound.example.test",
  );
});

test("alias configuration rejects normalized collisions, chains, and ambiguous domains", () => {
  assert.throws(
    () =>
      configureRuntime({
        ...aliasEnvironment,
        MAIL_INBOUND_ALIASES:
          '{"Copy@Inbound.Example.Test":"owner@mail.example.test"," copy@inbound.example.test ":"other@mail.example.test"}',
      }),
    /normalized collision/,
  );
  assert.throws(
    () =>
      configureRuntime({
        ...aliasEnvironment,
        MAIL_INBOUND_ALIASES:
          '{"first@inbound.example.test":"second@relay.example.test","second@relay.example.test":"owner@mail.example.test"}',
      }),
    /points to another configured alias/,
  );
  assert.throws(
    () =>
      configureRuntime({
        ...aliasEnvironment,
        MAIL_INBOUND_ALIASES: '{"alias@mail.example.test":"owner@mail.example.test"}',
      }),
    /cannot also be a direct mailbox domain/,
  );
  assert.throws(
    () =>
      configureRuntime({
        ...aliasEnvironment,
        MAIL_INBOUND_ALIASES: '{"alias@inbound.example.test":"owner@other.example.test"}',
      }),
    /not listed in MAIL_DOMAINS/,
  );
});

test(
  "alias delivery retains mailbox-domain workspace isolation",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [{ sql, closeDatabase }, { runMigrations }, { ingestMail }] = await Promise.all([
      import("./db.js"),
      import("./migrate.js"),
      import("./mail-store.js"),
    ]);
    const suffix = randomUUID();
    const ownerSlug = `alias-owner-${suffix}`;
    const foreignSlug = `alias-foreign-${suffix}`;
    const mailboxDomain = `mail-${suffix}.example.test`;
    const aliasDomain = `inbound-${suffix}.example.test`;
    configureRuntime({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_SSL: process.env.DATABASE_SSL,
      MAIL_DOMAINS: mailboxDomain,
      MAIL_DOMAIN_WORKSPACES: JSON.stringify({ [mailboxDomain]: ownerSlug }),
      MAIL_INBOUND_ALIASES: JSON.stringify({
        [`owner@${aliasDomain}`]: `owner@${mailboxDomain}`,
        [`foreign@${aliasDomain}`]: `foreign@${mailboxDomain}`,
      }),
    });
    await runMigrations();

    const [ownerWorkspace, foreignWorkspace] = await sql<Array<{ id: string }>>`
      INSERT INTO workspaces (name, slug) VALUES
        ('Alias owner', ${ownerSlug}),
        ('Alias foreign', ${foreignSlug})
      RETURNING id
    `;
    const [user] = await sql<Array<{ id: string }>>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${`alias-test-${suffix}@example.test`}, 'Alias Test', 'test-only')
      RETURNING id
    `;
    try {
      const [ownerMailbox, foreignMailbox] = await sql<Array<{ id: string }>>`
        INSERT INTO mailboxes (
          workspace_id, email, normalized_email, display_name, kind, created_by
        ) VALUES
          (${ownerWorkspace!.id}, ${`owner@${mailboxDomain}`}, ${`owner@${mailboxDomain}`},
            'Owner', 'shared', ${user!.id}),
          (${foreignWorkspace!.id}, ${`foreign@${mailboxDomain}`}, ${`foreign@${mailboxDomain}`},
            'Foreign', 'shared', ${user!.id})
        RETURNING id
      `;
      const raw = new TextEncoder().encode(
        "From: buyer@example.test\r\nSubject: Workspace isolation\r\n\r\nHello",
      );
      const ownerInput = await parseInboundMail(raw, `owner@${aliasDomain}`, "buyer@example.test");
      const ownerResult = await ingestMail(ownerInput);
      assert.equal(ownerResult.status, "ingested");
      assert.deepEqual(ownerResult.mailboxIds, [ownerMailbox!.id]);

      const foreignInput = await parseInboundMail(
        raw,
        `foreign@${aliasDomain}`,
        "buyer@example.test",
      );
      const foreignResult = await ingestMail(foreignInput);
      assert.deepEqual(foreignResult, { status: "unroutable", mailboxIds: [] });
      assert.notEqual(ownerMailbox!.id, foreignMailbox!.id);
    } finally {
      await sql`DELETE FROM workspaces WHERE id IN (${ownerWorkspace!.id}, ${foreignWorkspace!.id})`;
      await sql`DELETE FROM users WHERE id = ${user!.id}`;
      await closeDatabase();
      configureRuntime(process.env);
    }
  },
);

test("inbound bridge fails closed before parsing or touching the database", async () => {
  configureRuntime({ NODE_ENV: "test", MAIL_INGRESS_SECRET: "test-only-secret-".repeat(3) });
  const response = await mailIngressRoutes.request("/", {
    method: "POST",
    body: "anything",
    headers: { authorization: "Bearer invalid" },
  });
  assert.equal(response.status, 401);
});

test("stream size limits reject oversized mail and text conversion tolerates invalid entities", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(26 * 1024 * 1024));
      controller.close();
    },
  });
  await assert.rejects(readInboundBody(stream), /25 MiB/);
  assert.equal(plainTextFromHtml("<p>&#x110000;Hi&#33;</p>"), "Hi!");
});
