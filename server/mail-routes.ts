import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Buffer } from "node:buffer";
import { z } from "zod";

import { audit, requireAuth } from "./auth.js";
import { sql } from "./db.js";
import { databaseError, parseJson } from "./http.js";
import { MailProviderError, mailDomains, mailProviderReady, sendMail } from "./mail-provider.js";
import {
  accessibleMailbox,
  normalizeMailAddress,
  normalizeMailSubject,
  validateCrmLinks,
} from "./mail-store.js";
import type { AppEnv, SessionUser } from "./types.js";

const address = z.string().trim().email().max(320).transform(normalizeMailAddress);
const mailboxCreateSchema = z.object({
  email: address,
  displayName: z.string().trim().min(1).max(120),
  kind: z.enum(["private", "shared"]),
  ownerId: z.string().uuid().optional().nullable(),
});
const mailboxUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  signature: z.string().max(20_000).optional(),
  replyTo: address.optional().nullable(),
  enabled: z.boolean().optional(),
});
const draftSchema = z.object({
  mailboxId: z.string().uuid(),
  conversationId: z.string().uuid().optional().nullable(),
  forwardMessageId: z.string().uuid().optional(),
  to: z.array(address).max(50),
  cc: z.array(address).max(50).optional().default([]),
  bcc: z.array(address).max(50).optional().default([]),
  subject: z.string().max(998).default(""),
  text: z.string().max(1_000_000).default(""),
  accountId: z.string().uuid().optional().nullable(),
  contactId: z.string().uuid().optional().nullable(),
});
const draftUpdateSchema = draftSchema
  .omit({ mailboxId: true, conversationId: true, forwardMessageId: true })
  .partial();
const stateSchema = z.object({
  mailboxId: z.string().uuid(),
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
});
const sendSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(200).optional() });
const stalledSendInterval = "10 minutes";
const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(200).default("application/octet-stream"),
  contentBase64: z
    .string()
    .min(1)
    .max(2_800_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});

type MailboxRow = {
  id: string;
  email: string;
  displayName: string;
  kind: "private" | "shared";
  ownerId: string | null;
  signature: string;
  replyTo: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type DraftRow = {
  id: string;
  mailboxId: string;
  conversationId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  accountId: string | null;
  contactId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

async function listMailboxes(user: SessionUser) {
  return sql<Record<string, unknown>[]>`
    SELECT m.id, m.email, m.display_name AS "displayName", m.kind,
      m.owner_id AS "ownerId", u.name AS "ownerName", m.signature,
      m.reply_to AS "replyTo", m.enabled,
      count(cm.conversation_id) FILTER (WHERE cm.unread)::int AS "unreadCount",
      m.created_at AS "createdAt", m.updated_at AS "updatedAt"
    FROM mailboxes m
    LEFT JOIN users u ON u.id = m.owner_id
    LEFT JOIN mail_conversation_mailboxes cm ON cm.mailbox_id = m.id
    WHERE m.workspace_id = ${user.workspaceId}
      AND (m.kind = 'shared' OR m.owner_id = ${user.id})
    GROUP BY m.id, u.name ORDER BY m.kind, lower(m.email)
  `;
}

async function draftById(user: SessionUser, draftId: string) {
  const [draft] = await sql<DraftRow[]>`
    SELECT d.id, d.mailbox_id AS "mailboxId", d.conversation_id AS "conversationId",
      to_jsonb(d.recipients_to) AS "to", to_jsonb(d.recipients_cc) AS cc, to_jsonb(d.recipients_bcc) AS bcc,
      d.subject, d.text_body AS text, d.account_id AS "accountId", d.contact_id AS "contactId",
      d.status, d.created_at AS "createdAt", d.updated_at AS "updatedAt"
    FROM mail_drafts d JOIN mailboxes m ON m.id = d.mailbox_id
    WHERE d.id = ${draftId} AND d.workspace_id = ${user.workspaceId}
      AND (m.kind = 'shared' OR m.owner_id = ${user.id})
  `;
  return draft ?? null;
}

export const mailRoutes = new Hono<AppEnv>();
mailRoutes.use("*", requireAuth);
mailRoutes.use(
  "*",
  bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (context) =>
      context.json({ error: "This email request exceeds the 5 MiB limit." }, 413),
  }),
);
mailRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});

mailRoutes.get("/setup", async (context) => {
  const user = context.get("user");
  return context.json({
    providerReady: mailProviderReady(context.env?.MAILER),
    configuredDomains: mailDomains(user.workspaceSlug),
    canProvision: user.role === "founder" || user.role === "manager",
    mailboxes: await listMailboxes(user),
  });
});

mailRoutes.post("/mailboxes", async (context) => {
  const user = context.get("user");
  if (user.role === "ic")
    return context.json({ error: "Only managers can provision mailboxes." }, 403);
  const parsed = await parseJson(context, mailboxCreateSchema);
  if (!parsed.ok) return parsed.response;
  const domain = parsed.data.email.split("@")[1]!;
  if (!mailDomains(user.workspaceSlug).includes(domain)) {
    return context.json({ error: "This email domain is not configured for mail." }, 422);
  }
  const ownerId = parsed.data.kind === "private" ? parsed.data.ownerId : null;
  if (parsed.data.kind === "private" && !ownerId) {
    return context.json({ error: "Private mailboxes require an owner." }, 422);
  }
  if (ownerId) {
    const member = await sql<{ id: string }[]>`
      SELECT user_id AS id FROM memberships WHERE workspace_id = ${user.workspaceId} AND user_id = ${ownerId}
    `;
    if (!member[0])
      return context.json({ error: "Mailbox owner must be a workspace member." }, 422);
  }
  try {
    const [created] = await sql<MailboxRow[]>`
      INSERT INTO mailboxes (
        workspace_id, email, normalized_email, display_name, kind, owner_id, created_by
      ) VALUES (
        ${user.workspaceId}, ${parsed.data.email}, ${parsed.data.email}, ${parsed.data.displayName},
        ${parsed.data.kind}, ${ownerId ?? null}, ${user.id}
      ) RETURNING id, email, display_name AS "displayName", kind, owner_id AS "ownerId",
        signature, reply_to AS "replyTo", enabled, created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "mailbox.created",
      entityType: "mailbox",
      entityId: String(created!.id),
    });
    return context.json({ ...created, ownerName: null, unreadCount: 0 }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

mailRoutes.patch("/mailboxes/:id", async (context) => {
  const user = context.get("user");
  const mailbox = await accessibleMailbox(user, context.req.param("id"));
  if (!mailbox) return context.json({ error: "Mailbox not found." }, 404);
  const parsed = await parseJson(context, mailboxUpdateSchema);
  if (!parsed.ok) return parsed.response;
  if ((parsed.data.enabled !== undefined || mailbox.kind === "shared") && user.role === "ic") {
    return context.json(
      { error: "Only managers can change shared mailbox settings or availability." },
      403,
    );
  }
  await sql`
    UPDATE mailboxes SET
      display_name = coalesce(${parsed.data.displayName ?? null}, display_name),
      signature = coalesce(${parsed.data.signature ?? null}, signature),
      reply_to = CASE WHEN ${parsed.data.replyTo === null} THEN NULL ELSE coalesce(${parsed.data.replyTo ?? null}, reply_to) END,
      enabled = coalesce(${parsed.data.enabled ?? null}, enabled)
    WHERE id = ${mailbox.id}
  `;
  const result = (await listMailboxes(user)).find((item) => item.id === mailbox.id);
  return context.json(result);
});

mailRoutes.get("/conversations", async (context) => {
  const user = context.get("user");
  const mailboxId = context.req.query("mailboxId") ?? "";
  if (!(await accessibleMailbox(user, mailboxId)))
    return context.json({ error: "Mailbox not found." }, 404);
  const folder = ["inbox", "sent", "drafts", "archive"].includes(context.req.query("folder") ?? "")
    ? context.req.query("folder")!
    : "inbox";
  const search = context.req.query("search")?.trim() ?? "";
  const unread = context.req.query("unread") === "true";
  const starred = context.req.query("starred") === "true";
  const page = Math.max(1, Number.parseInt(context.req.query("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(context.req.query("pageSize") ?? "50", 10) || 50),
  );
  const offset = (page - 1) * pageSize;
  const rows = await sql<Array<Record<string, unknown> & { total: number }>>`
    SELECT c.id, d.id AS "draftId", c.subject,
      coalesce(last_message.recipients, '[]'::jsonb) AS participants,
      left(coalesce(d.text_body, last_message.text_body, ''), 180) AS preview,
      (SELECT count(*)::int FROM mail_messages msg WHERE msg.conversation_id = c.id) AS "messageCount",
      c.last_message_at AS "lastMessageAt", cm.unread, cm.starred, cm.archived,
      (d.id IS NOT NULL) AS draft, coalesce(d.status, last_message.status) AS "deliveryStatus",
      CASE WHEN a.id IS NOT NULL THEN c.account_id END AS "accountId", a.name AS "accountName",
      CASE WHEN co.id IS NOT NULL THEN c.contact_id END AS "contactId",
      nullif(trim(concat(co.first_name, ' ', co.last_name)), '') AS "contactName",
      count(*) OVER()::int AS total
    FROM mail_conversations c
    JOIN mail_conversation_mailboxes cm ON cm.conversation_id = c.id AND cm.mailbox_id = ${mailboxId}
    LEFT JOIN LATERAL (
      SELECT msg.status, msg.text_body,
        CASE WHEN msg.direction = 'inbound' THEN jsonb_build_array(msg.sender)
          ELSE msg.recipients_to END AS recipients
      FROM mail_messages msg WHERE msg.conversation_id = c.id ORDER BY msg.created_at DESC LIMIT 1
    ) last_message ON true
    LEFT JOIN LATERAL (
      SELECT md.* FROM mail_drafts md WHERE md.conversation_id = c.id AND md.mailbox_id = ${mailboxId}
        AND md.status IN ('draft', 'failed') ORDER BY md.updated_at DESC LIMIT 1
    ) d ON true
    LEFT JOIN accounts a ON a.id = c.account_id AND (${user.role} <> 'ic' OR a.owner_id = ${user.id})
    LEFT JOIN contacts co ON co.id = c.contact_id AND (${user.role} <> 'ic' OR coalesce(co.owner_id, a.owner_id) = ${user.id})
    WHERE (${unread} = false OR cm.unread = true) AND (${starred} = false OR cm.starred = true)
      AND (${search} = '' OR c.subject ILIKE ${`%${search}%`} OR coalesce(d.text_body, '') ILIKE ${`%${search}%`}
        OR EXISTS (SELECT 1 FROM mail_messages searched WHERE searched.conversation_id = c.id
          AND (searched.text_body ILIKE ${`%${search}%`} OR searched.sender->>'email' ILIKE ${`%${search}%`}
            OR searched.sender->>'name' ILIKE ${`%${search}%`} OR searched.recipients_to::text ILIKE ${`%${search}%`})))
      AND (
        (${folder} = 'drafts' AND d.id IS NOT NULL)
        OR (${folder} = 'archive' AND cm.archived = true)
        OR (${folder} = 'inbox' AND cm.archived = false AND EXISTS (SELECT 1 FROM mail_messages x WHERE x.conversation_id = c.id AND x.direction = 'inbound'))
        OR (${folder} = 'sent' AND cm.archived = false AND EXISTS (SELECT 1 FROM mail_messages x WHERE x.conversation_id = c.id AND x.direction = 'outbound'))
      )
    ORDER BY coalesce(d.updated_at, c.last_message_at) DESC LIMIT ${pageSize} OFFSET ${offset}
  `;
  const total = rows[0]?.total ?? 0;
  return context.json({
    conversations: rows.map(({ total: _total, ...row }) => ({ ...row, mailboxId })),
    pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

mailRoutes.get("/conversations/:id", async (context) => {
  const user = context.get("user");
  const mailboxId = context.req.query("mailboxId") ?? "";
  if (!(await accessibleMailbox(user, mailboxId)))
    return context.json({ error: "Mailbox not found." }, 404);
  const conversationId = context.req.param("id");
  const [conversation] = await sql<Record<string, unknown>[]>`
    SELECT c.id, d.id AS "draftId", c.subject, ${mailboxId}::uuid AS "mailboxId",
      '[]'::jsonb AS participants, left(coalesce(d.text_body, ''), 180) AS preview,
      (SELECT count(*)::int FROM mail_messages x WHERE x.conversation_id = c.id) AS "messageCount",
      c.last_message_at AS "lastMessageAt", cm.unread, cm.starred, cm.archived,
      (d.id IS NOT NULL) AS draft, d.status AS "deliveryStatus",
      coalesce(d.status = 'uncertain' OR (d.status = 'sending' AND d.send_started_at < now() - ${stalledSendInterval}::interval), false) AS "canMarkFailed",
      CASE WHEN a.id IS NOT NULL THEN c.account_id END AS "accountId",
      a.name AS "accountName", CASE WHEN co.id IS NOT NULL THEN c.contact_id END AS "contactId",
      nullif(trim(concat(co.first_name, ' ', co.last_name)), '') AS "contactName"
    FROM mail_conversations c JOIN mail_conversation_mailboxes cm ON cm.conversation_id = c.id
    LEFT JOIN LATERAL (SELECT * FROM mail_drafts x WHERE x.conversation_id = c.id AND x.mailbox_id = ${mailboxId} ORDER BY x.updated_at DESC LIMIT 1) d ON true
    LEFT JOIN accounts a ON a.id = c.account_id AND (${user.role} <> 'ic' OR a.owner_id = ${user.id})
    LEFT JOIN contacts co ON co.id = c.contact_id AND (${user.role} <> 'ic' OR coalesce(co.owner_id, a.owner_id) = ${user.id})
    WHERE c.id = ${conversationId} AND cm.mailbox_id = ${mailboxId} AND c.workspace_id = ${user.workspaceId}
  `;
  if (!conversation) return context.json({ error: "Conversation not found." }, 404);
  const messages = await sql<Record<string, unknown>[]>`
    SELECT msg.id, msg.conversation_id AS "conversationId", msg.direction, msg.status,
      msg.sender AS "from", msg.recipients_to AS "to", msg.recipients_cc AS cc,
      msg.recipients_reply_to AS "replyTo",
      CASE WHEN msg.direction = 'outbound' THEN msg.recipients_bcc ELSE '[]'::jsonb END AS bcc,
      msg.subject, msg.text_body AS text, msg.sent_at AS "sentAt", msg.received_at AS "receivedAt",
      msg.created_at AS "createdAt", msg.error,
      coalesce(jsonb_agg(jsonb_build_object('id', att.id, 'filename', att.filename,
        'contentType', att.content_type, 'size', att.size_bytes,
        'downloadUrl', '/api/mail/attachments/' || att.id)) FILTER (WHERE att.id IS NOT NULL), '[]'::jsonb) AS attachments
    FROM mail_messages msg LEFT JOIN mail_attachments att ON att.message_id = msg.id
    WHERE msg.conversation_id = ${conversationId} GROUP BY msg.id ORDER BY msg.created_at
  `;
  const [draftMessage] = await sql<Record<string, unknown>[]>`
    SELECT d.id, d.conversation_id AS "conversationId", 'outbound' AS direction, d.status,
      jsonb_build_object('name', m.display_name, 'email', m.email) AS "from",
      to_jsonb(d.recipients_to) AS "toEmails", to_jsonb(d.recipients_cc) AS "ccEmails",
      to_jsonb(d.recipients_bcc) AS "bccEmails", d.subject, d.text_body AS text,
      '[]'::jsonb AS "replyTo", NULL::timestamptz AS "sentAt", NULL::timestamptz AS "receivedAt",
      d.created_at AS "createdAt", d.error, '[]'::jsonb AS attachments
    FROM mail_drafts d JOIN mailboxes m ON m.id = d.mailbox_id
    WHERE d.conversation_id = ${conversationId} AND d.mailbox_id = ${mailboxId}
      AND (d.status IN ('draft', 'failed', 'uncertain')
        OR (d.status = 'sending' AND d.send_started_at < now() - ${stalledSendInterval}::interval))
    ORDER BY d.updated_at DESC LIMIT 1
  `;
  if (draftMessage) {
    const addresses = (key: "toEmails" | "ccEmails" | "bccEmails") =>
      ((draftMessage[key] as string[]) ?? []).map((email) => ({ name: null, email }));
    messages.push({
      ...draftMessage,
      to: addresses("toEmails"),
      cc: addresses("ccEmails"),
      bcc: addresses("bccEmails"),
    });
    delete messages.at(-1)!.toEmails;
    delete messages.at(-1)!.ccEmails;
    delete messages.at(-1)!.bccEmails;
  }
  return context.json({ conversation: { ...conversation, messages } });
});

mailRoutes.post("/drafts", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, draftSchema);
  if (!parsed.ok) return parsed.response;
  if (!(await accessibleMailbox(user, parsed.data.mailboxId)))
    return context.json({ error: "Mailbox not found." }, 404);
  if (!(await validateCrmLinks(user, parsed.data.accountId, parsed.data.contactId)))
    return context.json({ error: "Linked CRM record not found." }, 422);
  const result = await sql.begin(async (transaction) => {
    if (parsed.data.forwardMessageId) {
      const [source] = await transaction<{ id: string; total: number; largest: number }[]>`
        SELECT msg.id, coalesce(sum(att.size_bytes), 0)::int AS total,
          coalesce(max(att.size_bytes), 0)::int AS largest
        FROM mail_messages msg
        JOIN mail_conversation_mailboxes cm ON cm.conversation_id = msg.conversation_id
        LEFT JOIN mail_attachments att ON att.message_id = msg.id AND att.workspace_id = ${user.workspaceId}
        WHERE msg.id = ${parsed.data.forwardMessageId} AND msg.workspace_id = ${user.workspaceId}
          AND cm.mailbox_id = ${parsed.data.mailboxId}
        GROUP BY msg.id
      `;
      if (!source) return null;
      if (source.largest > 2 * 1024 * 1024 || source.total > 3 * 1024 * 1024) return "oversize";
    }
    let conversationId = parsed.data.forwardMessageId ? null : parsed.data.conversationId;
    if (conversationId) {
      const existing = await transaction<{ id: string }[]>`
        SELECT c.id FROM mail_conversations c JOIN mail_conversation_mailboxes cm ON cm.conversation_id = c.id
        WHERE c.id = ${conversationId} AND c.workspace_id = ${user.workspaceId} AND cm.mailbox_id = ${parsed.data.mailboxId}
      `;
      if (!existing[0]) return null;
    } else {
      const conversation = await transaction<{ id: string }[]>`
        INSERT INTO mail_conversations (workspace_id, subject, normalized_subject, account_id, contact_id)
        VALUES (${user.workspaceId}, ${parsed.data.subject}, ${normalizeMailSubject(parsed.data.subject)}, ${parsed.data.accountId ?? null}, ${parsed.data.contactId ?? null}) RETURNING id
      `;
      conversationId = conversation[0]!.id;
      await transaction`INSERT INTO mail_conversation_mailboxes (conversation_id, mailbox_id) VALUES (${conversationId}, ${parsed.data.mailboxId})`;
    }
    const [draft] = await transaction<Record<string, unknown>[]>`
      INSERT INTO mail_drafts (workspace_id, mailbox_id, conversation_id, recipients_to, recipients_cc,
        recipients_bcc, subject, text_body, account_id, contact_id, created_by)
      VALUES (${user.workspaceId}, ${parsed.data.mailboxId}, ${conversationId}, ARRAY(SELECT jsonb_array_elements_text(${transaction.json(parsed.data.to)})),
        ARRAY(SELECT jsonb_array_elements_text(${transaction.json(parsed.data.cc)})), ARRAY(SELECT jsonb_array_elements_text(${transaction.json(parsed.data.bcc)})), ${parsed.data.subject}, ${parsed.data.text},
        ${parsed.data.accountId ?? null}, ${parsed.data.contactId ?? null}, ${user.id}) RETURNING id
    `;
    if (parsed.data.forwardMessageId) {
      await transaction`
        INSERT INTO mail_attachments (workspace_id, draft_id, filename, content_type, content, size_bytes)
        SELECT ${user.workspaceId}, ${draft!.id as string}, filename, content_type, content, size_bytes
        FROM mail_attachments WHERE message_id = ${parsed.data.forwardMessageId} AND workspace_id = ${user.workspaceId}
      `;
    }
    return draft!.id as string;
  });
  if (!result) return context.json({ error: "Conversation or forwarded message not found." }, 404);
  if (result === "oversize")
    return context.json(
      { error: "Forwarded attachments exceed the sending limits (2 MB per file, 3 MB total)." },
      422,
    );
  const attachments = await sql<Record<string, unknown>[]>`
    SELECT id, filename, content_type AS "contentType", size_bytes AS size,
      '/api/mail/attachments/' || id AS "downloadUrl"
    FROM mail_attachments WHERE draft_id = ${result} AND workspace_id = ${user.workspaceId}
    ORDER BY created_at
  `;
  return context.json({ ...(await draftById(user, result)), attachments }, 201);
});

mailRoutes.patch("/drafts/:id", async (context) => {
  const user = context.get("user");
  const current = await draftById(user, context.req.param("id"));
  if (!current) return context.json({ error: "Draft not found." }, 404);
  if (!["draft", "failed"].includes(String(current.status)))
    return context.json({ error: "This draft can no longer be edited." }, 409);
  const parsed = await parseJson(context, draftUpdateSchema);
  if (!parsed.ok) return parsed.response;
  if (!(await validateCrmLinks(user, parsed.data.accountId, parsed.data.contactId)))
    return context.json({ error: "Linked CRM record not found." }, 422);
  const updated = await sql<{ id: string }[]>`
    UPDATE mail_drafts SET recipients_to = ${parsed.data.to ? sql`ARRAY(SELECT jsonb_array_elements_text(${sql.json(parsed.data.to)}))` : sql`recipients_to`},
      recipients_cc = ${parsed.data.cc ? sql`ARRAY(SELECT jsonb_array_elements_text(${sql.json(parsed.data.cc)}))` : sql`recipients_cc`}, recipients_bcc = ${parsed.data.bcc ? sql`ARRAY(SELECT jsonb_array_elements_text(${sql.json(parsed.data.bcc)}))` : sql`recipients_bcc`},
      subject = coalesce(${parsed.data.subject ?? null}, subject), text_body = coalesce(${parsed.data.text ?? null}, text_body),
      account_id = CASE WHEN ${parsed.data.accountId === null} THEN NULL ELSE coalesce(${parsed.data.accountId ?? null}, account_id) END,
      contact_id = CASE WHEN ${parsed.data.contactId === null} THEN NULL ELSE coalesce(${parsed.data.contactId ?? null}, contact_id) END,
      status = 'draft', error = NULL, idempotency_key = NULL, send_started_at = NULL,
      send_completed_at = NULL, provider_message_id = NULL, delivery_result = '{}'::jsonb
    WHERE id = ${context.req.param("id")} AND status IN ('draft', 'failed')
    RETURNING id
  `;
  if (!updated[0]) return context.json({ error: "This draft can no longer be edited." }, 409);
  return context.json(await draftById(user, context.req.param("id")));
});

mailRoutes.get("/drafts/:id", async (context) => {
  const user = context.get("user");
  const draft = await draftById(user, context.req.param("id"));
  if (!draft) return context.json({ error: "Draft not found." }, 404);
  const attachments = await sql<Record<string, unknown>[]>`
    SELECT id, filename, content_type AS "contentType", size_bytes AS size,
      '/api/mail/attachments/' || id AS "downloadUrl"
    FROM mail_attachments WHERE draft_id = ${draft.id} AND workspace_id = ${user.workspaceId}
    ORDER BY created_at
  `;
  return context.json({ ...draft, attachments });
});

mailRoutes.post("/drafts/:id/attachments", async (context) => {
  const user = context.get("user");
  const draft = await draftById(user, context.req.param("id"));
  if (!draft) return context.json({ error: "Draft not found." }, 404);
  if (!["draft", "failed"].includes(draft.status))
    return context.json({ error: "This draft can no longer be edited." }, 409);
  const parsed = await parseJson(context, attachmentSchema);
  if (!parsed.ok) return parsed.response;
  let content: Uint8Array;
  try {
    const decoded = atob(parsed.data.contentBase64);
    content = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return context.json({ error: "Attachment content is not valid base64." }, 422);
  }
  if (content.byteLength > 2 * 1024 * 1024)
    return context.json({ error: "Attachments must be 2 MB or smaller." }, 422);
  const attachment = await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${draft.id}, 1))`;
    const [usage] = await transaction<{ total: number }[]>`
      SELECT coalesce(sum(size_bytes), 0)::int AS total FROM mail_attachments WHERE draft_id = ${draft.id}
    `;
    if ((usage?.total ?? 0) + content.byteLength > 3 * 1024 * 1024) return "oversize" as const;
    const [created] = await transaction<Record<string, unknown>[]>`
      INSERT INTO mail_attachments (workspace_id, draft_id, filename, content_type, content, size_bytes)
      SELECT ${user.workspaceId}, ${draft.id}, ${parsed.data.filename}, ${parsed.data.contentType}, ${content}, ${content.byteLength}
      WHERE EXISTS (SELECT 1 FROM mail_drafts WHERE id = ${draft.id} AND status IN ('draft', 'failed'))
      RETURNING id, filename, content_type AS "contentType", size_bytes AS size,
        '/api/mail/attachments/' || id AS "downloadUrl"
    `;
    return created ?? null;
  });
  if (attachment === "oversize")
    return context.json({ error: "Draft attachments may total at most 3 MB." }, 422);
  if (!attachment) return context.json({ error: "This draft can no longer be edited." }, 409);
  return context.json(attachment, 201);
});

mailRoutes.delete("/drafts/:draftId/attachments/:id", async (context) => {
  const user = context.get("user");
  const draft = await draftById(user, context.req.param("draftId"));
  if (!draft) return context.json({ error: "Draft not found." }, 404);
  const deleted = await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${draft.id}, 1))`;
    return transaction<{ id: string }[]>`
      DELETE FROM mail_attachments att USING mail_drafts d
      WHERE att.id = ${context.req.param("id")} AND att.draft_id = d.id AND d.id = ${draft.id}
        AND d.workspace_id = ${user.workspaceId} AND d.status IN ('draft', 'failed') RETURNING att.id
    `;
  });
  if (!deleted[0]) return context.json({ error: "Attachment not found or draft is locked." }, 404);
  return context.body(null, 204);
});

mailRoutes.delete("/drafts/:id", async (context) => {
  const user = context.get("user");
  const current = await draftById(user, context.req.param("id"));
  if (!current) return context.json({ error: "Draft not found." }, 404);
  if (!["draft", "failed"].includes(String(current.status)))
    return context.json({ error: "This draft can no longer be deleted." }, 409);
  const deleted = await sql<{ id: string }[]>`
    DELETE FROM mail_drafts WHERE id = ${context.req.param("id")} AND status IN ('draft', 'failed') RETURNING id
  `;
  if (!deleted[0]) return context.json({ error: "This draft can no longer be deleted." }, 409);
  return context.body(null, 204);
});

mailRoutes.post("/drafts/:id/mark-failed", async (context) => {
  const user = context.get("user");
  const draftId = context.req.param("id");
  const current = await draftById(user, draftId);
  if (!current) return context.json({ error: "Draft not found." }, 404);
  const error = "Marked as failed manually. Check Sent before trying again.";
  const marked = await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${draftId}, 1))`;
    const [draft] = await transaction<
      { previousStatus: string; conversationId: string; mailboxId: string; sendStartedAt: Date }[]
    >`
      SELECT status AS "previousStatus", conversation_id AS "conversationId",
        mailbox_id AS "mailboxId", send_started_at AS "sendStartedAt"
      FROM mail_drafts
      WHERE id = ${draftId}
        AND (status = 'uncertain'
          OR (status = 'sending' AND send_started_at < now() - ${stalledSendInterval}::interval))
      FOR UPDATE
    `;
    if (!draft) return null;
    await transaction`
      UPDATE mail_drafts SET status = 'failed', error = ${error}, send_completed_at = now()
      WHERE id = ${draftId}
    `;
    if (draft.previousStatus === "sending") {
      await transaction`
        UPDATE mail_messages SET status = 'uncertain', error = ${error}
        WHERE conversation_id = ${draft.conversationId} AND mailbox_id = ${draft.mailboxId}
          AND direction = 'outbound' AND status = 'sending' AND created_at >= ${draft.sendStartedAt}
      `;
    }
    return draft;
  });
  if (!marked)
    return context.json(
      { error: "Only drafts with unconfirmed or stalled delivery can be marked as failed." },
      409,
    );
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "mail.draft.marked_failed",
    entityType: "mail_draft",
    entityId: draftId,
    summary: { previousStatus: marked.previousStatus },
  });
  return context.json(await draftById(user, draftId));
});

mailRoutes.post("/drafts/:id/send", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, sendSchema);
  if (!parsed.ok) return parsed.response;
  if (!mailProviderReady(context.env?.MAILER))
    return context.json({ error: "Email sending is not configured." }, 503);
  const draftId = context.req.param("id");
  const current = await draftById(user, draftId);
  if (!current) return context.json({ error: "Draft not found." }, 404);
  const mailbox = await accessibleMailbox(user, String(current.mailboxId));
  if (!mailbox?.enabled) return context.json({ error: "This mailbox is disabled." }, 409);
  if (!mailDomains(user.workspaceSlug).includes(mailbox.email.split("@")[1]!)) {
    return context.json(
      { error: "This mailbox domain is no longer assigned to this workspace." },
      409,
    );
  }
  const replyContext = await sql<{ internetMessageId: string; references: string[] }[]>`
    SELECT internet_message_id AS "internetMessageId", to_jsonb(reference_ids) AS references
    FROM mail_messages WHERE conversation_id = ${current.conversationId} AND internet_message_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `;
  let referenceIds = replyContext[0]
    ? [...replyContext[0].references, replyContext[0].internetMessageId]
    : [];
  while (referenceIds.join(" ").length > 2_048) referenceIds = referenceIds.slice(1);
  let claim;
  try {
    claim = await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${draftId}, 1))`;
      const claimed = await transaction<DraftRow[]>`
      UPDATE mail_drafts SET status = 'sending', idempotency_key = coalesce(idempotency_key, ${parsed.data.idempotencyKey ?? null}), send_started_at = now(), error = NULL
      WHERE id = ${draftId} AND status IN ('draft', 'failed')
        AND cardinality(recipients_to) + cardinality(recipients_cc) + cardinality(recipients_bcc) BETWEEN 1 AND 50
        AND (idempotency_key IS NULL OR idempotency_key = ${parsed.data.idempotencyKey ?? null})
      RETURNING id, mailbox_id AS "mailboxId", conversation_id AS "conversationId",
        to_jsonb(recipients_to) AS "to", to_jsonb(recipients_cc) AS cc, to_jsonb(recipients_bcc) AS bcc, subject,
        text_body AS text, account_id AS "accountId", contact_id AS "contactId", status,
        created_at AS "createdAt", updated_at AS "updatedAt"
    `;
      const draft = claimed[0];
      if (!draft) return null;
      const [message] = await transaction<{ id: string }[]>`
      INSERT INTO mail_messages (workspace_id, conversation_id, mailbox_id, direction, status,
        in_reply_to, reference_ids, sender, recipients_to, recipients_cc,
        recipients_bcc, recipients_reply_to, subject, text_body)
      VALUES (${user.workspaceId}, ${draft.conversationId}, ${mailbox.id}, 'outbound', 'sending',
        ${replyContext[0]?.internetMessageId ?? null}, ARRAY(SELECT jsonb_array_elements_text(${transaction.json(referenceIds)})),
        ${transaction.json({ name: mailbox.displayName, email: mailbox.email })},
        ${transaction.json(draft.to.map((email) => ({ name: null, email })))},
        ${transaction.json(draft.cc.map((email) => ({ name: null, email })))},
        ${transaction.json(draft.bcc.map((email) => ({ name: null, email })))}, '[]'::jsonb,
        ${draft.subject}, ${draft.text}) RETURNING id
    `;
      await transaction`
        INSERT INTO mail_attachments (
          workspace_id, message_id, filename, content_type, content, size_bytes
        )
        SELECT workspace_id, ${message!.id}, filename, content_type, content, size_bytes
        FROM mail_attachments WHERE draft_id = ${draftId}
      `;
      const attachments = await transaction<
        Array<{ filename: string; contentType: string; content: Uint8Array }>
      >`
      SELECT filename, content_type AS "contentType", content FROM mail_attachments
      WHERE draft_id = ${draftId} ORDER BY created_at
    `;
      return { draft, messageId: message!.id, attachments };
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "23505") {
      return context.json({ error: "This send request has already been used." }, 409);
    }
    throw error;
  }
  if (!claim)
    return context.json(
      {
        error: "This draft is already being sent, has been sent, or has no recipients.",
        draft: current,
      },
      409,
    );
  const headers: Record<string, string> = {};
  if (replyContext[0]) {
    headers["In-Reply-To"] = replyContext[0].internetMessageId;
    headers.References = referenceIds.join(" ");
  }
  let result;
  try {
    result = await sendMail(
      {
        from: mailbox.email,
        to: claim.draft.to,
        cc: claim.draft.cc,
        bcc: claim.draft.bcc,
        replyTo: mailbox.replyTo ?? undefined,
        subject: claim.draft.subject,
        text: claim.draft.text,
        headers,
        attachments: claim.attachments.map((attachment) => ({
          content: Buffer.from(attachment.content).toString("base64"),
          filename: attachment.filename,
          type: attachment.contentType,
          disposition: "attachment" as const,
        })),
      },
      context.env?.MAILER,
    );
  } catch (error) {
    const uncertain = error instanceof MailProviderError && error.uncertain;
    await sql.begin(async (transaction) => {
      await transaction`UPDATE mail_drafts SET status = ${uncertain ? "uncertain" : "failed"}, error = ${error instanceof Error ? error.message : "Email provider error."}, send_completed_at = now() WHERE id = ${draftId}`;
      await transaction`UPDATE mail_messages SET status = ${uncertain ? "uncertain" : "failed"}, error = ${error instanceof Error ? error.message : "Email provider error."} WHERE id = ${claim.messageId}`;
    });
    return context.json(
      {
        error: error instanceof Error ? error.message : "Email provider error.",
        uncertain,
        draft: await draftById(user, draftId),
      },
      uncertain ? 502 : 422,
    );
  }
  try {
    await sql.begin(async (transaction) => {
      const status = result.status;
      await transaction`
        UPDATE mail_drafts SET status = ${status}, provider_message_id = ${result.messageId}, delivery_result = ${transaction.json(result)}, send_completed_at = now() WHERE id = ${draftId}
      `;
      await transaction`UPDATE mail_messages SET status = ${status}, provider_message_id = ${result.messageId || null}, internet_message_id = ${result.messageId ? (result.messageId.startsWith("<") ? result.messageId : `<${result.messageId}>`) : null}, sent_at = now() WHERE id = ${claim.messageId}`;
      await transaction`UPDATE mail_conversations SET last_message_at = now() WHERE id = ${claim.draft.conversationId}`;
    });
    const draft = await draftById(user, draftId);
    return context.json({
      draft,
      delivered: result.delivered,
      queued: result.queued,
      permanentBounces: result.permanentBounces,
      suppressed: result.suppressed,
    });
  } catch {
    const message =
      "The provider accepted this message, but Orbit could not record confirmation. Check email logs before sending again.";
    await sql`UPDATE mail_drafts SET status = 'uncertain', error = ${message}, delivery_result = ${sql.json(result)}, send_completed_at = now() WHERE id = ${draftId}`.catch(
      () => undefined,
    );
    await sql`UPDATE mail_messages SET status = 'uncertain', error = ${message}, provider_message_id = ${result.messageId} WHERE id = ${claim.messageId}`.catch(
      () => undefined,
    );
    return context.json(
      { error: message, uncertain: true, draft: await draftById(user, draftId) },
      502,
    );
  }
});

mailRoutes.patch("/conversations/:id/state", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, stateSchema);
  if (!parsed.ok) return parsed.response;
  if (!(await accessibleMailbox(user, parsed.data.mailboxId)))
    return context.json({ error: "Mailbox not found." }, 404);
  const changed = await sql<{ id: string }[]>`
    UPDATE mail_conversation_mailboxes SET
      unread = coalesce(${parsed.data.read === undefined ? null : !parsed.data.read}, unread),
      starred = coalesce(${parsed.data.starred ?? null}, starred), archived = coalesce(${parsed.data.archived ?? null}, archived)
    WHERE conversation_id = ${context.req.param("id")} AND mailbox_id = ${parsed.data.mailboxId}
    RETURNING conversation_id AS id
  `;
  if (!changed[0]) return context.json({ error: "Conversation not found." }, 404);
  return context.json({
    id: changed[0].id,
    mailboxId: parsed.data.mailboxId,
    read: parsed.data.read,
    starred: parsed.data.starred,
    archived: parsed.data.archived,
  });
});

mailRoutes.get("/attachments/:id", async (context) => {
  const user = context.get("user");
  const [attachment] = await sql<{ filename: string; contentType: string; content: Uint8Array }[]>`
    SELECT att.filename, att.content_type AS "contentType", att.content
    FROM mail_attachments att
    LEFT JOIN mail_messages msg ON msg.id = att.message_id
    LEFT JOIN mail_drafts d ON d.id = att.draft_id
    JOIN mailboxes m ON m.id = coalesce(msg.mailbox_id, d.mailbox_id)
    WHERE att.id = ${context.req.param("id")} AND att.workspace_id = ${user.workspaceId}
      AND (m.kind = 'shared' OR m.owner_id = ${user.id})
  `;
  if (!attachment) return context.json({ error: "Attachment not found." }, 404);
  context.header("content-type", attachment.contentType);
  context.header(
    "content-disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
  );
  context.header("x-content-type-options", "nosniff");
  return context.body(Uint8Array.from(attachment.content).buffer);
});
