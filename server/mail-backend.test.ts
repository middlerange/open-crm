import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test(
  "mail enforces privacy, inbound dedupe, configuration, and atomic sending",
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
      { MailProviderError },
    ] = await Promise.all([
      import("hono"),
      import("./config"),
      import("./db"),
      import("./migrate"),
      import("./security"),
      import("./mail-routes"),
      import("./mail-store"),
      import("./mail-provider"),
    ]);
    await runMigrations();
    const suffix = randomUUID();
    const slug = `mail-test-${suffix}`;
    configureRuntime({
      ...process.env,
      NODE_ENV: "test",
      MAIL_DOMAINS: "mail.example",
      MAIL_DOMAIN_WORKSPACES: JSON.stringify({ "mail.example": slug }),
      MAIL_SENDING_ENABLED: "true",
    });
    const [workspace] = await sql<
      { id: string }[]
    >`INSERT INTO workspaces (name, slug) VALUES ('Mail test', ${slug}) RETURNING id`;
    const users = await sql<{ id: string; email: string }[]>`
    INSERT INTO users (email, name, password_hash) VALUES
      (${`founder-${suffix}@example.test`}, 'Founder', 'test-only'),
      (${`ic-${suffix}@example.test`}, 'IC', 'test-only') RETURNING id, email
  `;
    const [founder, ic] = users;
    const founderToken = security.createOpaqueToken();
    const icToken = security.createOpaqueToken();
    try {
      await sql`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${workspace!.id}, ${founder!.id}, 'founder'), (${workspace!.id}, ${ic!.id}, 'ic')`;
      await sql`INSERT INTO sessions (user_id, token_hash, selected_workspace_id, expires_at) VALUES
      (${founder!.id}, ${security.hashToken(founderToken)}, ${workspace!.id}, now() + interval '1 hour'),
      (${ic!.id}, ${security.hashToken(icToken)}, ${workspace!.id}, now() + interval '1 hour')`;

      const app = new Hono();
      app.route("/api/mail", mailRoutes);
      const request = (token: string, path: string, method = "GET", body?: unknown, env?: object) =>
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

      const privateResponse = await request(founderToken, "/mailboxes", "POST", {
        email: "owner@mail.example",
        displayName: "Owner",
        kind: "private",
        ownerId: founder!.id,
      });
      assert.equal(privateResponse.status, 201);
      const ownerMailbox = (await privateResponse.json()) as { id: string };
      const icPrivateResponse = await request(founderToken, "/mailboxes", "POST", {
        email: "ic@mail.example",
        displayName: "IC",
        kind: "private",
        ownerId: ic!.id,
      });
      assert.equal(icPrivateResponse.status, 201);
      const icMailbox = (await icPrivateResponse.json()) as { id: string };
      const sharedResponse = await request(founderToken, "/mailboxes", "POST", {
        email: "team@mail.example",
        displayName: "Team",
        kind: "shared",
      });
      assert.equal(sharedResponse.status, 201);
      const sharedMailbox = (await sharedResponse.json()) as { id: string };
      assert.equal(
        (await request(icToken, `/conversations?mailboxId=${ownerMailbox.id}`)).status,
        404,
      );
      const icSetup = (await (await request(icToken, "/setup")).json()) as {
        mailboxes: Array<{ id: string }>;
      };
      assert.deepEqual(
        new Set(icSetup.mailboxes.map((mailbox) => mailbox.id)),
        new Set([icMailbox.id, sharedMailbox.id]),
      );

      const inbound = {
        envelopeTo: "team@mail.example",
        internetMessageId: `<in-${suffix}@example.test>`,
        from: { email: "buyer@example.test" },
        to: [{ email: "team@mail.example" }],
        subject: "Question",
        text: "Hello",
        attachments: [
          { filename: "question.txt", contentType: "text/plain", content: Buffer.from("details") },
        ],
      };
      const [first, duplicate] = await Promise.all([ingestMail(inbound), ingestMail(inbound)]);
      assert.deepEqual(
        new Set([first.status, duplicate.status]),
        new Set(["ingested", "duplicate"]),
      );
      const messages = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM mail_messages WHERE mailbox_id = ${sharedMailbox.id} AND internet_message_id = ${inbound.internetMessageId}`;
      assert.equal(messages[0]!.count, 1);

      const [source] = await sql<{ id: string; conversationId: string; attachmentId: string }[]>`
        SELECT m.id, m.conversation_id AS "conversationId", a.id AS "attachmentId"
        FROM mail_messages m JOIN mail_attachments a ON a.message_id = m.id
        WHERE m.mailbox_id = ${sharedMailbox.id} AND m.internet_message_id = ${inbound.internetMessageId}
      `;
      const forwardInput = {
        mailboxId: sharedMailbox.id,
        forwardMessageId: source!.id,
        conversationId: source!.conversationId,
        to: ["colleague@example.test"],
        subject: "Fwd: Question",
        text: "Please review the forwarded question.",
      };
      const forwardResponse = await request(icToken, "/drafts", "POST", forwardInput);
      assert.equal(forwardResponse.status, 201);
      const forwarded = (await forwardResponse.json()) as {
        id: string;
        conversationId: string;
        to: string[];
        cc: string[];
        bcc: string[];
        attachments: Array<{ id: string; filename: string; downloadUrl: string }>;
      };
      assert.notEqual(forwarded.conversationId, source!.conversationId);
      assert.deepEqual(forwarded.to, ["colleague@example.test"]);
      assert.deepEqual(forwarded.cc, []);
      assert.deepEqual(forwarded.bcc, []);
      assert.equal(forwarded.attachments.length, 1);
      assert.equal(forwarded.attachments[0]!.filename, "question.txt");
      assert.notEqual(forwarded.attachments[0]!.id, source!.attachmentId);
      const forwardedDownload = await request(
        icToken,
        forwarded.attachments[0]!.downloadUrl.replace("/api/mail", ""),
      );
      assert.equal(forwardedDownload.status, 200);
      assert.equal(await forwardedDownload.text(), "details");
      const reopenedForward = await request(icToken, `/drafts/${forwarded.id}`);
      assert.deepEqual(
        ((await reopenedForward.json()) as typeof forwarded).attachments,
        forwarded.attachments,
      );
      assert.equal(
        (await request(icToken, "/drafts", "POST", { ...forwardInput, mailboxId: icMailbox.id }))
          .status,
        404,
      );
      const privateInbound = await ingestMail({
        ...inbound,
        envelopeTo: "owner@mail.example",
        to: [{ email: "owner@mail.example" }],
        internetMessageId: `<private-${suffix}@example.test>`,
      });
      assert.equal(
        (
          await request(icToken, "/drafts", "POST", {
            ...forwardInput,
            forwardMessageId: privateInbound.messageId,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request(icToken, "/drafts", "POST", {
            ...forwardInput,
            forwardMessageId: randomUUID(),
          })
        ).status,
        404,
      );

      for (const sizes of [[2 * 1024 * 1024 + 1], [2 * 1024 * 1024, 1024 * 1024 + 1]]) {
        const oversized = await ingestMail({
          ...inbound,
          internetMessageId: `<oversized-${randomUUID()}@example.test>`,
          attachments: sizes.map((size, index) => ({
            filename: `large-${index}.bin`,
            contentType: "application/octet-stream",
            content: Buffer.alloc(size),
          })),
        });
        const subject = `Fwd: too large ${randomUUID()}`;
        const oversizedResponse = await request(icToken, "/drafts", "POST", {
          ...forwardInput,
          subject,
          forwardMessageId: oversized.messageId,
        });
        assert.equal(oversizedResponse.status, 422);
        const [partial] = await sql<{ drafts: number; conversations: number }[]>`
          SELECT
            (SELECT count(*)::int FROM mail_drafts WHERE workspace_id = ${workspace!.id} AND subject = ${subject}) AS drafts,
            (SELECT count(*)::int FROM mail_conversations WHERE workspace_id = ${workspace!.id} AND subject = ${subject}) AS conversations
        `;
        assert.deepEqual(partial, { drafts: 0, conversations: 0 });
      }

      let forwardSends = 0;
      const forwardSend = await request(
        icToken,
        `/drafts/${forwarded.id}/send`,
        "POST",
        { idempotencyKey: `forward-${suffix}` },
        {
          MAILER: {
            send: async (message: {
              headers?: Record<string, string>;
              attachments?: Array<{ filename: string; content: string }>;
            }) => {
              assert.equal(message.headers?.["In-Reply-To"], undefined);
              assert.equal(message.headers?.References, undefined);
              assert.equal(message.attachments?.[0]?.filename, "question.txt");
              assert.equal(
                message.attachments?.[0]?.content,
                Buffer.from("details").toString("base64"),
              );
              forwardSends += 1;
              return { messageId: `forward-provider-${suffix}` };
            },
          },
        },
      );
      assert.equal(forwardSend.status, 200);
      assert.equal(forwardSends, 1);

      const draftResponse = await request(founderToken, "/drafts", "POST", {
        mailboxId: ownerMailbox.id,
        to: ["buyer@example.test"],
        subject: "Reply",
        text: "Thanks",
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()) as { id: string; conversationId: string };
      const attachmentResponse = await request(
        founderToken,
        `/drafts/${draft.id}/attachments`,
        "POST",
        {
          filename: "note.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("hello").toString("base64"),
        },
      );
      assert.equal(attachmentResponse.status, 201);
      const attachment = (await attachmentResponse.json()) as { id: string };
      assert.equal((await request(icToken, `/attachments/${attachment.id}`)).status, 404);
      assert.equal(
        (
          await request(founderToken, `/drafts/${draft.id}/attachments`, "POST", {
            filename: "too-large.bin",
            contentType: "application/octet-stream",
            contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
          })
        ).status,
        422,
      );
      assert.equal(
        (await request(founderToken, `/drafts/${draft.id}/send`, "POST", {})).status,
        503,
      );

      let sends = 0;
      const binding = {
        send: async (message: {
          headers?: Record<string, string>;
          attachments?: Array<{
            filename: string;
            type: string;
            content: string;
            disposition: string;
          }>;
        }) => {
          assert.equal(message.headers?.["Message-ID"], undefined);
          assert.equal(message.headers?.["Reply-To"], undefined);
          assert.deepEqual(message.attachments, [
            {
              filename: "note.txt",
              type: "text/plain",
              content: Buffer.from("hello").toString("base64"),
              disposition: "attachment",
            },
          ]);
          sends += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { messageId: `provider-${suffix}` };
        },
      };
      const [sendA, sendB] = await Promise.all([
        request(
          founderToken,
          `/drafts/${draft.id}/send`,
          "POST",
          { idempotencyKey: `send-${suffix}` },
          { MAILER: binding },
        ),
        request(
          founderToken,
          `/drafts/${draft.id}/send`,
          "POST",
          { idempotencyKey: `send-${suffix}` },
          { MAILER: binding },
        ),
      ]);
      assert.deepEqual(
        [sendA.status, sendB.status].sort((a, b) => a - b),
        [200, 409],
      );
      assert.equal(sends, 1);
      const outbound = await sql<{ status: string; count: number }[]>`
      SELECT max(status) AS status, count(*)::int AS count FROM mail_messages WHERE conversation_id = (SELECT conversation_id FROM mail_drafts WHERE id = ${draft.id}) AND direction = 'outbound'
    `;
      assert.equal(outbound[0]!.count, 1);
      assert.equal(outbound[0]!.status, "sent");

      const conversationResponse = await request(
        founderToken,
        `/conversations/${draft.conversationId}?mailboxId=${ownerMailbox.id}`,
      );
      assert.equal(conversationResponse.status, 200);
      const conversationPayload = (await conversationResponse.json()) as {
        conversation: {
          messages: Array<{ status: string; attachments: Array<{ downloadUrl: string }> }>;
        };
      };
      const sentAttachment = conversationPayload.conversation.messages
        .find((message) => message.status === "sent")
        ?.attachments.at(0);
      assert.ok(sentAttachment);
      const download = await request(
        founderToken,
        sentAttachment.downloadUrl.replace("/api/mail", ""),
      );
      assert.equal(download.status, 200);
      assert.equal(await download.text(), "hello");

      const uncertainDraftResponse = await request(founderToken, "/drafts", "POST", {
        mailboxId: ownerMailbox.id,
        to: ["buyer@example.test"],
        subject: "Ambiguous send",
        text: "Check provider logs",
      });
      const uncertainDraft = (await uncertainDraftResponse.json()) as { id: string };
      let uncertainAttempts = 0;
      const uncertainBinding = {
        send: async () => {
          uncertainAttempts += 1;
          throw new MailProviderError("Provider acceptance is unknown.", true);
        },
      };
      assert.equal(
        (
          await request(
            founderToken,
            `/drafts/${uncertainDraft.id}/send`,
            "POST",
            { idempotencyKey: `uncertain-${suffix}` },
            { MAILER: uncertainBinding },
          )
        ).status,
        502,
      );
      assert.equal(
        (
          await request(
            founderToken,
            `/drafts/${uncertainDraft.id}/send`,
            "POST",
            { idempotencyKey: `uncertain-${suffix}` },
            { MAILER: uncertainBinding },
          )
        ).status,
        409,
      );
      assert.equal(uncertainAttempts, 1);

      const acceptanceMigration = await readFile(
        new URL("../migrations/013_mail_sent_acceptance.sql", import.meta.url),
        "utf8",
      );
      const legacyResult = {
        messageId: `provider-${suffix}`,
        status: "queued",
        delivered: [],
        queued: ["buyer@example.test"],
        permanentBounces: [],
        suppressed: [],
      };
      for (const scenario of [
        { status: "queued", result: legacyResult, complete: true, expected: "sent" },
        { status: "queued", result: {}, complete: true, expected: "queued" },
        {
          status: "queued",
          result: { ...legacyResult, messageId: "unrelated" },
          complete: true,
          expected: "queued",
        },
        { status: "queued", result: legacyResult, complete: false, expected: "queued" },
        { status: "uncertain", result: legacyResult, complete: true, expected: "uncertain" },
        { status: "failed", result: legacyResult, complete: true, expected: "failed" },
        { status: "sending", result: legacyResult, complete: true, expected: "sending" },
      ]) {
        await sql`
          UPDATE mail_drafts SET status = ${scenario.status}, delivery_result = ${sql.json(scenario.result)},
            send_completed_at = CASE WHEN ${scenario.complete} THEN now() ELSE NULL END
          WHERE id = ${draft.id}
        `;
        await sql`
          UPDATE mail_messages SET status = ${scenario.status}
          WHERE conversation_id = ${draft.conversationId} AND direction = 'outbound'
        `;
        await sql.begin(async (transaction) => {
          await transaction.unsafe(acceptanceMigration);
          await transaction.unsafe(acceptanceMigration);
        });
        const [stored] = await sql<{ status: string; deliveryResult: object }[]>`
          SELECT status, delivery_result AS "deliveryResult" FROM mail_drafts WHERE id = ${draft.id}
        `;
        assert.equal(stored!.status, scenario.expected);
        assert.deepEqual(stored!.deliveryResult, scenario.result);
        const response = await request(
          founderToken,
          `/conversations/${draft.conversationId}?mailboxId=${ownerMailbox.id}`,
        );
        const payload = (await response.json()) as {
          conversation: { messages: Array<{ direction: string; status: string }> };
        };
        assert.equal(
          payload.conversation.messages.find((message) => message.direction === "outbound")!.status,
          scenario.expected,
        );
        if (scenario.expected === "sent") {
          assert.equal(
            (
              await request(
                founderToken,
                `/drafts/${draft.id}/send`,
                "POST",
                {},
                { MAILER: binding },
              )
            ).status,
            409,
          );
          assert.equal(sends, 1);
        }
      }
    } finally {
      await sql`DELETE FROM workspaces WHERE id = ${workspace!.id}`;
      await sql`DELETE FROM users WHERE id IN (${founder!.id}, ${ic!.id})`;
      await closeDatabase();
    }
  },
);
