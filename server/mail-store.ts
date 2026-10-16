import { sql } from "./db.js";
import { mailDomains } from "./mail-provider.js";
import type { InboundMailInput, InboundMailResult } from "./mail-types.js";
import type { SessionUser } from "./types.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function normalizeMailAddress(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeMailSubject(value: string) {
  return value
    .trim()
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

export async function accessibleMailbox(user: SessionUser, mailboxId: string) {
  const [mailbox] = await sql<
    Array<{
      id: string;
      workspaceId: string;
      email: string;
      displayName: string;
      kind: "private" | "shared";
      ownerId: string | null;
      signature: string;
      replyTo: string | null;
      enabled: boolean;
    }>
  >`
    SELECT id, workspace_id AS "workspaceId", email, display_name AS "displayName",
      kind, owner_id AS "ownerId", signature, reply_to AS "replyTo", enabled
    FROM mailboxes
    WHERE id = ${mailboxId} AND workspace_id = ${user.workspaceId}
      AND (kind = 'shared' OR owner_id = ${user.id})
  `;
  return mailbox ?? null;
}

export async function validateCrmLinks(
  user: SessionUser,
  accountId?: string | null,
  contactId?: string | null,
) {
  if (!accountId && !contactId) return true;
  const [row] = await sql<{ accountOk: boolean; contactOk: boolean }[]>`
    SELECT
      ${accountId ?? null}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM accounts a WHERE a.id = ${accountId ?? null}
          AND a.workspace_id = ${user.workspaceId}
          AND (${user.role} <> 'ic' OR a.owner_id = ${user.id})
      ) AS "accountOk",
      ${contactId ?? null}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM contacts c JOIN accounts a ON a.id = c.account_id
        WHERE c.id = ${contactId ?? null} AND c.workspace_id = ${user.workspaceId}
          AND (${user.role} <> 'ic' OR coalesce(c.owner_id, a.owner_id) = ${user.id})
          AND (${accountId ?? null}::uuid IS NULL OR c.account_id = ${accountId ?? null})
      ) AS "contactOk"
  `;
  return Boolean(row?.accountOk && row.contactOk);
}

export async function ingestMail(input: InboundMailInput): Promise<InboundMailResult> {
  const targetEmail = normalizeMailAddress(input.envelopeTo);
  const mailboxes = await sql<{ id: string; workspaceId: string; workspaceSlug: string }[]>`
    SELECT m.id, m.workspace_id AS "workspaceId", w.slug AS "workspaceSlug"
    FROM mailboxes m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.enabled = true AND m.normalized_email = ${targetEmail}
  `;
  if (!mailboxes.length) return { status: "unroutable", mailboxIds: [] };
  if (!mailDomains(mailboxes[0]!.workspaceSlug).includes(targetEmail.split("@")[1]!)) {
    return { status: "unroutable", mailboxIds: [] };
  }

  const workspaceIds = [...new Set(mailboxes.map((mailbox) => mailbox.workspaceId))];
  if (workspaceIds.length !== 1) return { status: "unroutable", mailboxIds: [] };
  const workspaceId = workspaceIds[0]!;
  const mailboxIds = mailboxes.map((mailbox) => mailbox.id);
  const attachmentBytes = (input.attachments ?? []).reduce(
    (total, attachment) => total + attachment.content.byteLength,
    0,
  );
  if (
    attachmentBytes > MAX_ATTACHMENT_BYTES ||
    (input.attachments ?? []).some(
      (attachment) => attachment.content.byteLength > MAX_ATTACHMENT_BYTES,
    )
  ) {
    throw new Error("Inbound mail attachments exceed the 10 MB limit.");
  }

  return sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`${mailboxIds[0]!}:${input.internetMessageId}`}, 0))`;
    const existing = await transaction<{ id: string; conversationId: string }[]>`
      SELECT id, conversation_id AS "conversationId" FROM mail_messages
      WHERE mailbox_id = ${mailboxIds[0]!} AND (internet_message_id = ${input.internetMessageId}
        OR (${input.providerMessageId ?? null}::text IS NOT NULL
          AND provider_message_id = ${input.providerMessageId ?? null}))
      LIMIT 1
    `;
    if (existing[0]) {
      return {
        status: "duplicate" as const,
        messageId: existing[0].id,
        conversationId: existing[0].conversationId,
        mailboxIds,
      };
    }

    const replyIds = [input.inReplyTo, ...(input.references ?? [])].filter(
      (value): value is string => Boolean(value),
    );
    let conversationId: string | undefined;
    if (replyIds.length) {
      const related = await transaction<{ conversationId: string }[]>`
        SELECT conversation_id AS "conversationId" FROM mail_messages
        WHERE workspace_id = ${workspaceId} AND mailbox_id = ${mailboxIds[0]!}
          AND internet_message_id = ANY(ARRAY(SELECT jsonb_array_elements_text(${transaction.json(replyIds)})))
        ORDER BY created_at DESC LIMIT 1
      `;
      conversationId = related[0]?.conversationId;
    }
    if (!conversationId) {
      const created = await transaction<{ id: string }[]>`
        INSERT INTO mail_conversations (workspace_id, subject, normalized_subject, last_message_at)
        VALUES (${workspaceId}, ${input.subject ?? ""}, ${normalizeMailSubject(input.subject ?? "")},
          ${input.receivedAt ? new Date(input.receivedAt) : new Date()})
        RETURNING id
      `;
      conversationId = created[0]!.id;
    }

    await transaction`
      INSERT INTO mail_conversation_mailboxes (conversation_id, mailbox_id, unread)
      VALUES (${conversationId}, ${mailboxIds[0]!}, true)
      ON CONFLICT (conversation_id, mailbox_id) DO UPDATE SET unread = true, archived = false
    `;
    const created = await transaction<{ id: string }[]>`
      INSERT INTO mail_messages (
        workspace_id, conversation_id, mailbox_id, direction, status, provider_message_id,
        internet_message_id, in_reply_to, reference_ids, sender, recipients_to, recipients_cc, recipients_reply_to,
        subject, text_body, headers, received_at
      ) VALUES (
        ${workspaceId}, ${conversationId}, ${mailboxIds[0]!}, 'inbound', 'received',
        ${input.providerMessageId ?? null}, ${input.internetMessageId}, ${input.inReplyTo ?? null},
        ARRAY(SELECT jsonb_array_elements_text(${transaction.json(input.references ?? [])})), ${transaction.json(input.from)}, ${transaction.json(input.to)},
        ${transaction.json(input.cc ?? [])}, ${transaction.json(input.replyTo ?? [])}, ${input.subject ?? ""}, ${input.text},
        ${transaction.json(input.headers ?? {})}, ${input.receivedAt ? new Date(input.receivedAt) : new Date()}
      ) RETURNING id
    `;
    const messageId = created[0]!.id;
    for (const attachment of input.attachments ?? []) {
      await transaction`
        INSERT INTO mail_attachments (
          workspace_id, message_id, filename, content_type, content, size_bytes
        ) VALUES (
          ${workspaceId}, ${messageId}, ${attachment.filename},
          ${attachment.contentType ?? "application/octet-stream"}, ${attachment.content},
          ${attachment.content.byteLength}
        )
      `;
    }
    await transaction`
      UPDATE mail_conversations SET last_message_at = ${input.receivedAt ? new Date(input.receivedAt) : new Date()}
      WHERE id = ${conversationId}
    `;
    return { status: "ingested" as const, messageId, conversationId, mailboxIds };
  });
}
