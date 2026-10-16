import { Hono } from "hono";
import { z } from "zod";

import { audit, canAccessOwner, requireAuth } from "./auth.js";
import { cascadeAccountOwner, normalizePagination } from "./crm-utils.js";
import { sql } from "./db.js";
import { databaseError, parseJson } from "./http.js";
import { normalizeDomain, normalizeEmail, normalizeLinkedInUrl } from "./security.js";
import type { AppVariables } from "./types.js";

const contactInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional().default(""),
  title: z.string().trim().max(160).optional().default(""),
  department: z.string().trim().max(100).optional().default(""),
  email: z.string().email().optional().or(z.literal("")),
  linkedinUrl: z.string().trim().max(500).optional().default(""),
  phone: z.string().trim().max(80).optional().default(""),
  buyerRole: z.string().trim().max(120).optional().default(""),
  country: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
});

const accountSchema = z.object({
  name: z.string().trim().min(2).max(180),
  parentAccountId: z.string().uuid().optional().nullable(),
  domain: z.string().trim().max(255).optional().default(""),
  linkedinUrl: z.string().trim().max(500).optional().default(""),
  websiteUrl: z.string().trim().max(500).optional().default(""),
  ownerId: z.string().uuid().optional(),
  tier: z.enum(["A", "B", "C"]).default("C"),
  employeeRange: z.string().trim().max(80).optional().default(""),
  country: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  industry: z.string().trim().max(120).optional().default(""),
  productMotion: z.string().trim().max(120).optional().default(""),
  source: z.string().trim().max(120).optional().default(""),
  fitSummary: z.string().trim().max(5000).optional().default(""),
  evidenceSummary: z.string().trim().max(5000).optional().default(""),
  triggerSummary: z.string().trim().max(5000).optional().default(""),
  sourceLinks: z.array(z.string().url()).max(20).optional().default([]),
  score: z.number().int().min(0).max(100).optional().default(0),
  nextAction: z.string().trim().max(1000).optional().default(""),
  nextActionAt: z.string().datetime().optional().nullable(),
  contact: contactInput.optional(),
});

export const accountUpdateSchema = accountSchema
  .partial()
  .omit({ contact: true })
  .extend({
    status: z
      .enum(["research", "pending_approval", "approved", "active", "nurture", "disqualified"])
      .optional(),
    disqualificationReason: z.string().trim().max(1000).optional().nullable(),
  });

const contactSchema = contactInput.extend({
  accountId: z.string().uuid(),
  ownerId: z.string().uuid().optional(),
  status: z
    .enum([
      "identified",
      "verified",
      "contacted",
      "engaged",
      "qualified",
      "not_interested",
      "invalid",
    ])
    .optional()
    .default("identified"),
  consentStatus: z
    .enum(["unknown", "legitimate_interest", "opted_in", "opted_out"])
    .optional()
    .default("unknown"),
  preferredChannel: z.enum(["email", "phone", "linkedin"]).optional().nullable(),
  notes: z.string().trim().max(5000).optional().default(""),
});

const activitySchema = z.object({
  accountId: z.string().uuid().optional().nullable(),
  contactId: z.string().uuid().optional().nullable(),
  opportunityId: z.string().uuid().optional().nullable(),
  workItemId: z.string().uuid().optional().nullable(),
  type: z.enum([
    "email",
    "linkedin_request",
    "linkedin_message",
    "follow_up",
    "call",
    "meeting",
    "note",
    "research",
    "demo",
    "teardown",
  ]),
  status: z.enum(["planned", "completed", "skipped"]).default("completed"),
  outcome: z.string().trim().max(200).optional().default(""),
  details: z.string().trim().max(10000).optional().default(""),
  occurredAt: z.string().datetime().optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
});

const opportunitySchema = z.object({
  accountId: z.string().uuid(),
  primaryContactId: z.string().uuid().optional().nullable(),
  ownerId: z.string().uuid().optional(),
  stageId: z.string().uuid(),
  name: z.string().trim().min(2).max(200),
  valueAmount: z.number().nonnegative().optional().nullable(),
  currency: z.string().trim().length(3).default("USD"),
  problemSummary: z.string().trim().max(5000).optional().default(""),
  nextAction: z.string().trim().min(2).max(1000),
  nextActionAt: z.string().datetime(),
  expectedCloseAt: z.string().date().optional().nullable(),
});

const opportunityUpdateSchema = z.object({
  stageId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional().nullable(),
  primaryContactId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(2).max(200).optional(),
  valueAmount: z.number().nonnegative().optional().nullable(),
  currency: z.string().trim().length(3).optional(),
  problemSummary: z.string().trim().max(5000).optional(),
  nextAction: z.string().trim().min(2).max(1000).optional(),
  nextActionAt: z.string().datetime().optional(),
  expectedCloseAt: z.string().date().optional().nullable(),
  lossReason: z.string().trim().max(1000).optional().nullable(),
});

const outreachActivityTypes = new Set([
  "email",
  "linkedin_request",
  "linkedin_message",
  "follow_up",
  "call",
  "meeting",
  "demo",
  "teardown",
]);

function ownerScope(user: { role: string; id: string }) {
  return user.role === "ic" ? user.id : null;
}

async function workspaceMember(workspaceId: string, userId: string) {
  const [member] = await sql<{ id: string }[]>`
    SELECT u.id
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE u.id = ${userId} AND u.active = true AND m.workspace_id = ${workspaceId}
  `;
  return member ?? null;
}

async function accountAccess(workspaceId: string, accountId: string, userId: string, role: string) {
  const [account] = await sql<
    { id: string; ownerId: string | null; status: string; archivedAt: string | null }[]
  >`
    SELECT id, owner_id AS "ownerId", status, archived_at AS "archivedAt" FROM accounts
    WHERE id = ${accountId} AND workspace_id = ${workspaceId}
  `;
  if (!account || (role === "ic" && account.ownerId !== userId)) return null;
  return account;
}

export const crmRoutes = new Hono<{ Variables: AppVariables }>();
crmRoutes.use("*", requireAuth);

crmRoutes.get("/accounts", async (context) => {
  const user = context.get("user");
  const ownerId = ownerScope(user);
  const search = context.req.query("search")?.trim() ?? "";
  const status = context.req.query("status")?.trim() ?? "";
  const archived = context.req.query("archived") ?? "active";
  const sort = ["name", "score", "updated", "activity"].includes(context.req.query("sort") ?? "")
    ? context.req.query("sort")!
    : "score";
  const direction = context.req.query("direction") === "asc" ? "asc" : "desc";
  const pagination = normalizePagination(
    { page: context.req.query("page"), pageSize: context.req.query("pageSize") },
    { defaultPageSize: 100, maxPageSize: 250 },
  );
  const [countRow] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total FROM accounts a
    WHERE a.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId})
      AND (${status} = '' OR a.status = ${status})
      AND (${search} = '' OR a.name ILIKE ${`%${search}%`} OR coalesce(a.domain, '') ILIKE ${`%${search}%`} OR coalesce(a.industry, '') ILIKE ${`%${search}%`})
      AND (${archived} = 'all'
        OR (${archived} = 'active' AND a.archived_at IS NULL)
        OR (${archived} = 'archived' AND a.archived_at IS NOT NULL))
  `;
  const accounts = await sql<
    {
      id: string;
      name: string;
      domain: string | null;
      industry: string | null;
      tier: string;
      status: string;
      score: number;
      ownerId: string | null;
      ownerName: string | null;
      fitSummary: string | null;
      triggerSummary: string | null;
      nextAction: string | null;
      nextActionAt: string | null;
      lastActivityAt: string | null;
      archivedAt: string | null;
      contacts: number;
      pendingApproval: boolean;
    }[]
  >`
    SELECT a.id, a.name, a.domain, a.country, a.state, a.city, a.industry, a.tier, a.status, a.score,
      a.owner_id AS "ownerId", u.name AS "ownerName", a.fit_summary AS "fitSummary",
      a.trigger_summary AS "triggerSummary", a.next_action AS "nextAction",
      a.next_action_at AS "nextActionAt", a.last_activity_at AS "lastActivityAt",
      a.archived_at AS "archivedAt",
      count(DISTINCT c.id)::int AS contacts,
      bool_or(ap.status = 'pending') AS "pendingApproval"
    FROM accounts a
    LEFT JOIN users u ON u.id = a.owner_id
    LEFT JOIN contacts c ON c.account_id = a.id
    LEFT JOIN approvals ap ON ap.subject_type = 'account' AND ap.subject_id = a.id
    WHERE a.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId})
      AND (${status} = '' OR a.status = ${status})
      AND (${search} = '' OR a.name ILIKE ${`%${search}%`} OR coalesce(a.domain, '') ILIKE ${`%${search}%`} OR coalesce(a.industry, '') ILIKE ${`%${search}%`})
      AND (${archived} = 'all'
        OR (${archived} = 'active' AND a.archived_at IS NULL)
        OR (${archived} = 'archived' AND a.archived_at IS NOT NULL))
    GROUP BY a.id, u.name
    ORDER BY
      CASE WHEN ${sort} = 'name' AND ${direction} = 'asc' THEN lower(a.name) END ASC,
      CASE WHEN ${sort} = 'name' AND ${direction} = 'desc' THEN lower(a.name) END DESC,
      CASE WHEN ${sort} = 'score' AND ${direction} = 'asc' THEN a.score END ASC,
      CASE WHEN ${sort} = 'score' AND ${direction} = 'desc' THEN a.score END DESC,
      CASE WHEN ${sort} = 'updated' AND ${direction} = 'asc' THEN a.updated_at END ASC,
      CASE WHEN ${sort} = 'updated' AND ${direction} = 'desc' THEN a.updated_at END DESC,
      CASE WHEN ${sort} = 'activity' AND ${direction} = 'asc' THEN a.last_activity_at END ASC NULLS LAST,
      CASE WHEN ${sort} = 'activity' AND ${direction} = 'desc' THEN a.last_activity_at END DESC NULLS LAST,
      a.created_at DESC
    LIMIT ${pagination.limit} OFFSET ${pagination.offset}
  `;
  return context.json({
    accounts,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: countRow?.total ?? 0,
      pages: Math.max(1, Math.ceil((countRow?.total ?? 0) / pagination.pageSize)),
    },
  });
});

crmRoutes.post("/accounts", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, accountSchema);
  if (!parsed.ok) return parsed.response;
  const ownerId = user.role === "ic" ? user.id : (parsed.data.ownerId ?? user.id);
  if (!(await workspaceMember(user.workspaceId, ownerId))) {
    return context.json({ error: "Account owner must be an active workspace member." }, 422);
  }
  if (parsed.data.parentAccountId) {
    const parent = await accountAccess(
      user.workspaceId,
      parsed.data.parentAccountId,
      user.id,
      user.role,
    );
    if (!parent || parent.archivedAt) {
      return context.json({ error: "Parent account must be an accessible active account." }, 422);
    }
  }
  try {
    const account = await sql.begin(async (transaction) => {
      const [created] = await transaction<{ id: string }[]>`
        INSERT INTO accounts (
          workspace_id, parent_account_id, name, domain, normalized_domain, linkedin_url, normalized_linkedin_url,
          website_url, owner_id, tier, country, state, city, employee_range, industry, product_motion, source, fit_summary,
          evidence_summary, trigger_summary, source_links, score, next_action, next_action_at, created_by
        ) VALUES (
          ${user.workspaceId}, ${parsed.data.parentAccountId ?? null}, ${parsed.data.name}, ${parsed.data.domain || null}, ${normalizeDomain(parsed.data.domain)},
          ${parsed.data.linkedinUrl || null}, ${normalizeLinkedInUrl(parsed.data.linkedinUrl)},
          ${parsed.data.websiteUrl || null}, ${ownerId}, ${parsed.data.tier}, ${parsed.data.country || null}, ${parsed.data.state || null}, ${parsed.data.city || null}, ${parsed.data.employeeRange || null}, ${parsed.data.industry || null},
          ${parsed.data.productMotion || null}, ${parsed.data.source || null}, ${parsed.data.fitSummary || null},
          ${parsed.data.evidenceSummary || null}, ${parsed.data.triggerSummary || null}, ${sql.json(parsed.data.sourceLinks)},
          ${parsed.data.score}, ${parsed.data.nextAction || null}, ${parsed.data.nextActionAt ?? null}, ${user.id}
        ) RETURNING id
      `;
      if (parsed.data.contact) {
        const contact = parsed.data.contact;
        await transaction`
          INSERT INTO contacts (
            workspace_id, account_id, owner_id, first_name, last_name, title, department, email,
            normalized_email, linkedin_url, normalized_linkedin_url, phone, buyer_role, country, state, city, created_by
          ) VALUES (
            ${user.workspaceId}, ${created.id}, ${ownerId}, ${contact.firstName}, ${contact.lastName || null},
            ${contact.title || null}, ${contact.department || null}, ${contact.email || null}, ${normalizeEmail(contact.email)},
            ${contact.linkedinUrl || null}, ${normalizeLinkedInUrl(contact.linkedinUrl)}, ${contact.phone || null},
            ${contact.buyerRole || null}, ${contact.country || null}, ${contact.state || null}, ${contact.city || null}, ${user.id}
          )
        `;
      }
      return created;
    });
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "account.created",
      entityType: "account",
      entityId: account.id,
      summary: { ownerId, tier: parsed.data.tier },
    });
    return context.json({ id: account.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmRoutes.get("/accounts/:id", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const access = await accountAccess(user.workspaceId, id, user.id, user.role);
  if (!access) return context.json({ error: "Account not found." }, 404);
  const [account, contacts, activities, opportunities, tasks, approvals, signals] =
    await Promise.all([
      sql`
      SELECT a.*, u.name AS owner_name, parent.name AS parent_account_name
      FROM accounts a LEFT JOIN users u ON u.id = a.owner_id
      LEFT JOIN accounts parent ON parent.id = a.parent_account_id
      WHERE a.id = ${id} AND a.workspace_id = ${user.workspaceId}
    `,
      sql`
      SELECT c.*, cs.state AS linkedin_state, cs.connection_note AS linkedin_connection_note,
        cs.requested_at AS linkedin_requested_at, cs.connected_at AS linkedin_connected_at,
        cs.last_message_at AS linkedin_last_message_at
      FROM contacts c
      LEFT JOIN contact_channel_states cs ON cs.contact_id = c.id AND cs.channel = 'linkedin'
      WHERE c.account_id = ${id} ORDER BY c.created_at
    `,
      sql`
      SELECT ac.*, u.name AS actor_name FROM activities ac LEFT JOIN users u ON u.id = ac.actor_id
      WHERE ac.account_id = ${id} ORDER BY coalesce(ac.occurred_at, ac.due_at, ac.created_at) DESC LIMIT 100
    `,
      sql`
      SELECT o.*, s.key AS stage_key, s.name AS stage_name, u.name AS owner_name
      FROM opportunities o JOIN opportunity_stages s ON s.id = o.stage_id LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.account_id = ${id} ORDER BY o.created_at DESC
    `,
      sql`
      SELECT wi.*, u.name AS owner_name FROM work_items wi LEFT JOIN users u ON u.id = wi.owner_id
      WHERE wi.entity_type = 'account' AND wi.entity_id = ${id} ORDER BY wi.created_at DESC
    `,
      sql`
      SELECT ap.*, requester.name AS requester_name, reviewer.name AS reviewer_name
      FROM approvals ap JOIN users requester ON requester.id = ap.requested_by
      LEFT JOIN users reviewer ON reviewer.id = ap.reviewer_id
      WHERE ap.subject_type = 'account' AND ap.subject_id = ${id} ORDER BY ap.requested_at DESC
    `,
      sql`
      SELECT * FROM account_signals
      WHERE workspace_id = ${user.workspaceId} AND account_id = ${id}
      ORDER BY observed_at DESC NULLS LAST, created_at DESC
    `,
    ]);
  return context.json({
    account: account[0],
    contacts,
    activities,
    opportunities,
    tasks,
    approvals,
    signals,
  });
});

crmRoutes.patch("/accounts/:id", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const access = await accountAccess(user.workspaceId, id, user.id, user.role);
  if (!access) return context.json({ error: "Account not found." }, 404);
  const parsed = await parseJson(context, accountUpdateSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.ownerId && user.role === "ic")
    return context.json({ error: "Only a Lead can reassign an account." }, 403);
  if (parsed.data.status && user.role === "ic") {
    return context.json({ error: "Only a Lead can change account lifecycle status." }, 403);
  }
  if (parsed.data.ownerId && !(await workspaceMember(user.workspaceId, parsed.data.ownerId))) {
    return context.json({ error: "Account owner must be an active workspace member." }, 422);
  }
  if (parsed.data.parentAccountId === id) {
    return context.json({ error: "An account cannot be its own parent." }, 422);
  }
  if (parsed.data.parentAccountId) {
    const parent = await accountAccess(
      user.workspaceId,
      parsed.data.parentAccountId,
      user.id,
      user.role,
    );
    if (!parent || parent.archivedAt) {
      return context.json({ error: "Parent account must be an accessible active account." }, 422);
    }
    const [descendant] = await sql<{ id: string }[]>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM accounts
        WHERE parent_account_id = ${id} AND workspace_id = ${user.workspaceId}
        UNION
        SELECT a.id FROM accounts a JOIN descendants d ON a.parent_account_id = d.id
        WHERE a.workspace_id = ${user.workspaceId}
      )
      SELECT id FROM descendants WHERE id = ${parsed.data.parentAccountId} LIMIT 1
    `;
    if (descendant) {
      return context.json({ error: "This parent would create an account hierarchy cycle." }, 422);
    }
  }
  const [current] = await sql<any[]>`SELECT * FROM accounts WHERE id = ${id}`;
  const ownerId = parsed.data.ownerId ?? current.owner_id;
  try {
    await sql.begin(async (transaction) => {
      await transaction`
      UPDATE accounts SET
        parent_account_id = ${parsed.data.parentAccountId !== undefined ? parsed.data.parentAccountId : current.parent_account_id},
        name = ${parsed.data.name ?? current.name},
        domain = ${parsed.data.domain !== undefined ? parsed.data.domain || null : current.domain},
        normalized_domain = ${parsed.data.domain !== undefined ? normalizeDomain(parsed.data.domain) : current.normalized_domain},
        linkedin_url = ${parsed.data.linkedinUrl !== undefined ? parsed.data.linkedinUrl || null : current.linkedin_url},
        normalized_linkedin_url = ${parsed.data.linkedinUrl !== undefined ? normalizeLinkedInUrl(parsed.data.linkedinUrl) : current.normalized_linkedin_url},
        website_url = ${parsed.data.websiteUrl !== undefined ? parsed.data.websiteUrl || null : current.website_url},
        owner_id = ${ownerId},
        tier = ${parsed.data.tier ?? current.tier},
        country = ${parsed.data.country !== undefined ? parsed.data.country || null : current.country},
        state = ${parsed.data.state !== undefined ? parsed.data.state || null : current.state},
        city = ${parsed.data.city !== undefined ? parsed.data.city || null : current.city},
        status = ${parsed.data.status ?? current.status},
        employee_range = ${parsed.data.employeeRange !== undefined ? parsed.data.employeeRange || null : current.employee_range},
        industry = ${parsed.data.industry !== undefined ? parsed.data.industry || null : current.industry},
        product_motion = ${parsed.data.productMotion !== undefined ? parsed.data.productMotion || null : current.product_motion},
        source = ${parsed.data.source !== undefined ? parsed.data.source || null : current.source},
        fit_summary = ${parsed.data.fitSummary !== undefined ? parsed.data.fitSummary || null : current.fit_summary},
        evidence_summary = ${parsed.data.evidenceSummary !== undefined ? parsed.data.evidenceSummary || null : current.evidence_summary},
        trigger_summary = ${parsed.data.triggerSummary !== undefined ? parsed.data.triggerSummary || null : current.trigger_summary},
        source_links = ${parsed.data.sourceLinks !== undefined ? sql.json(parsed.data.sourceLinks) : current.source_links},
        score = ${parsed.data.score ?? current.score},
        disqualification_reason = ${parsed.data.disqualificationReason !== undefined ? parsed.data.disqualificationReason : current.disqualification_reason},
        next_action = ${parsed.data.nextAction !== undefined ? parsed.data.nextAction || null : current.next_action},
        next_action_at = ${parsed.data.nextActionAt !== undefined ? parsed.data.nextActionAt : current.next_action_at}
      WHERE id = ${id} AND workspace_id = ${user.workspaceId}
    `;
      if (parsed.data.ownerId) await cascadeAccountOwner(transaction, user.workspaceId, [id]);
    });
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "account.updated",
      entityType: "account",
      entityId: id,
      summary: { ownerId },
    });
    return context.json({ ok: true });
  } catch (error) {
    return databaseError(context, error);
  }
});

crmRoutes.post("/accounts/:id/submit", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const access = await accountAccess(user.workspaceId, id, user.id, user.role);
  if (!access) return context.json({ error: "Account not found." }, 404);
  if (access.archivedAt) {
    return context.json({ error: "Restore this account before submitting it." }, 409);
  }
  if (access.status === "pending_approval") {
    return context.json({ error: "This account is already waiting for approval." }, 409);
  }
  if (!["research", "nurture"].includes(access.status)) {
    return context.json(
      { error: "Only research or nurture accounts can be submitted for approval." },
      409,
    );
  }
  const [account] = await sql<
    {
      evidenceSummary: string | null;
      triggerSummary: string | null;
      sourceLinks: string[];
      contacts: number;
    }[]
  >`
    SELECT a.evidence_summary AS "evidenceSummary", a.trigger_summary AS "triggerSummary", a.source_links AS "sourceLinks",
      count(c.id)::int AS contacts
    FROM accounts a LEFT JOIN contacts c ON c.account_id = a.id
    WHERE a.id = ${id} GROUP BY a.id
  `;
  if (
    !account.evidenceSummary ||
    !account.triggerSummary ||
    account.sourceLinks.length === 0 ||
    account.contacts === 0
  ) {
    return context.json(
      {
        error:
          "Lead approval requires fit evidence, a trigger, at least one source link, and one buyer contact.",
      },
      422,
    );
  }
  try {
    const [approval] = await sql.begin(async (transaction) => {
      await transaction`UPDATE accounts SET status = 'pending_approval' WHERE id = ${id}`;
      return transaction<{ id: string }[]>`
      INSERT INTO approvals (workspace_id, subject_type, subject_id, gate, requested_by)
      VALUES (${user.workspaceId}, 'account', ${id}, 'lead', ${user.id}) RETURNING id
    `;
    });
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "account.submitted",
      entityType: "account",
      entityId: id,
    });
    return context.json({ approvalId: approval.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmRoutes.post("/contacts", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, contactSchema);
  if (!parsed.ok) return parsed.response;
  const account = await accountAccess(user.workspaceId, parsed.data.accountId, user.id, user.role);
  if (!account) return context.json({ error: "Account not found." }, 404);
  if (account.archivedAt)
    return context.json({ error: "Restore this account before adding contacts." }, 409);
  const ownerId =
    user.role === "ic" ? user.id : (parsed.data.ownerId ?? account.ownerId ?? user.id);
  if (!(await workspaceMember(user.workspaceId, ownerId))) {
    return context.json({ error: "Contact owner must be an active workspace member." }, 422);
  }
  try {
    const [contact] = await sql<{ id: string }[]>`
      INSERT INTO contacts (
        workspace_id, account_id, owner_id, first_name, last_name, title, department, email,
        normalized_email, linkedin_url, normalized_linkedin_url, phone, buyer_role, country, state, city, status,
        consent_status, preferred_channel, notes, created_by
      ) VALUES (
        ${user.workspaceId}, ${parsed.data.accountId}, ${ownerId}, ${parsed.data.firstName}, ${parsed.data.lastName || null},
        ${parsed.data.title || null}, ${parsed.data.department || null}, ${parsed.data.email || null}, ${normalizeEmail(parsed.data.email)},
        ${parsed.data.linkedinUrl || null}, ${normalizeLinkedInUrl(parsed.data.linkedinUrl)}, ${parsed.data.phone || null},
        ${parsed.data.buyerRole || null}, ${parsed.data.country || null}, ${parsed.data.state || null}, ${parsed.data.city || null}, ${parsed.data.status}, ${parsed.data.consentStatus},
        ${parsed.data.preferredChannel ?? null}, ${parsed.data.notes || null}, ${user.id}
      ) RETURNING id
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "contact.created",
      entityType: "contact",
      entityId: contact.id,
      summary: { accountId: parsed.data.accountId },
    });
    return context.json({ id: contact.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmRoutes.get("/activities", async (context) => {
  const user = context.get("user");
  const ownerId = ownerScope(user);
  const activities = await sql`
    SELECT ac.*, a.name AS account_name, concat_ws(' ', c.first_name, c.last_name) AS contact_name, u.name AS actor_name
    FROM activities ac
    LEFT JOIN accounts a ON a.id = ac.account_id
    LEFT JOIN contacts c ON c.id = ac.contact_id
    LEFT JOIN users u ON u.id = ac.actor_id
    WHERE ac.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR ac.actor_id = ${ownerId})
    ORDER BY coalesce(ac.due_at, ac.occurred_at, ac.created_at) DESC LIMIT 250
  `;
  return context.json({ activities });
});

crmRoutes.post("/activities", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, activitySchema);
  if (!parsed.ok) return parsed.response;
  const isOutreach = outreachActivityTypes.has(parsed.data.type);
  if (isOutreach && !parsed.data.accountId)
    return context.json({ error: "Outbound activity must be linked to an approved account." }, 422);
  if (parsed.data.accountId) {
    const account = await accountAccess(
      user.workspaceId,
      parsed.data.accountId,
      user.id,
      user.role,
    );
    if (!account) return context.json({ error: "Account not found." }, 404);
    if (account.archivedAt)
      return context.json({ error: "Restore this account before logging activity." }, 409);
    if (isOutreach && !["approved", "active", "nurture"].includes(account.status)) {
      return context.json(
        { error: "Lead approval is required before outbound activity can be logged." },
        422,
      );
    }
  }
  if (parsed.data.contactId) {
    const [contact] = await sql<{ id: string; accountId: string }[]>`
      SELECT c.id, c.account_id AS "accountId"
      FROM contacts c
      JOIN accounts a ON a.id = c.account_id AND a.workspace_id = c.workspace_id
      WHERE c.id = ${parsed.data.contactId} AND c.workspace_id = ${user.workspaceId}
        AND c.archived_at IS NULL
        AND (${parsed.data.accountId ?? null}::uuid IS NULL OR c.account_id = ${parsed.data.accountId ?? null})
        AND (${user.role === "ic" ? user.id : null}::uuid IS NULL OR a.owner_id = ${user.id})
    `;
    if (!contact) return context.json({ error: "Contact not found for this account." }, 404);
  }
  if (parsed.data.opportunityId) {
    const [opportunity] = await sql<{ id: string; accountId: string }[]>`
      SELECT id, account_id AS "accountId" FROM opportunities
      WHERE id = ${parsed.data.opportunityId} AND workspace_id = ${user.workspaceId}
        AND archived_at IS NULL
        AND (${user.role === "ic" ? user.id : null}::uuid IS NULL OR owner_id = ${user.id})
        AND (${parsed.data.accountId ?? null}::uuid IS NULL OR account_id = ${parsed.data.accountId ?? null})
    `;
    if (!opportunity)
      return context.json({ error: "Opportunity not found for this account." }, 404);
  }
  if (parsed.data.workItemId) {
    const [workItem] = await sql<{ id: string }[]>`
      SELECT id FROM work_items
      WHERE id = ${parsed.data.workItemId} AND workspace_id = ${user.workspaceId}
        AND (${user.role === "ic" ? user.id : null}::uuid IS NULL OR owner_id = ${user.id})
    `;
    if (!workItem) return context.json({ error: "Task not found." }, 404);
  }
  const occurredAt =
    parsed.data.status === "completed"
      ? (parsed.data.occurredAt ?? new Date().toISOString())
      : null;
  const [activity] = await sql.begin(async (transaction) => {
    const [created] = await transaction<{ id: string }[]>`
      INSERT INTO activities (
        workspace_id, account_id, contact_id, opportunity_id, work_item_id, actor_id,
        type, status, outcome, details, occurred_at, due_at
      ) VALUES (
        ${user.workspaceId}, ${parsed.data.accountId ?? null}, ${parsed.data.contactId ?? null},
        ${parsed.data.opportunityId ?? null}, ${parsed.data.workItemId ?? null}, ${user.id},
        ${parsed.data.type}, ${parsed.data.status}, ${parsed.data.outcome || null}, ${parsed.data.details || null},
        ${occurredAt}, ${parsed.data.dueAt ?? null}
      ) RETURNING id
    `;
    if (parsed.data.accountId && parsed.data.status === "completed") {
      await transaction`
        UPDATE accounts SET last_activity_at = GREATEST(coalesce(last_activity_at, ${occurredAt}), ${occurredAt}) WHERE id = ${parsed.data.accountId}
      `;
    }
    return [created];
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "activity.logged",
    entityType: "activity",
    entityId: activity.id,
    summary: { type: parsed.data.type, status: parsed.data.status },
  });
  return context.json({ id: activity.id }, 201);
});

crmRoutes.get("/pipeline", async (context) => {
  const user = context.get("user");
  const ownerId = ownerScope(user);
  const [stages, opportunities] = await Promise.all([
    sql`SELECT * FROM opportunity_stages WHERE workspace_id = ${user.workspaceId} ORDER BY position`,
    sql`
      SELECT o.*, a.name AS account_name, s.key AS stage_key, s.name AS stage_name, u.name AS owner_name
      FROM opportunities o JOIN accounts a ON a.id = o.account_id
      JOIN opportunity_stages s ON s.id = o.stage_id LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.workspace_id = ${user.workspaceId}
        AND o.archived_at IS NULL
        AND a.archived_at IS NULL
        AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
      ORDER BY o.next_action_at, o.created_at DESC
    `,
  ]);
  return context.json({ stages, opportunities });
});

crmRoutes.post("/opportunities", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, opportunitySchema);
  if (!parsed.ok) return parsed.response;
  const account = await accountAccess(user.workspaceId, parsed.data.accountId, user.id, user.role);
  if (!account) return context.json({ error: "Account not found." }, 404);
  if (account.archivedAt) {
    return context.json({ error: "Restore this account before creating an opportunity." }, 409);
  }
  if (!["approved", "active", "nurture"].includes(account.status)) {
    return context.json(
      { error: "Lead approval is required before an opportunity can be created." },
      422,
    );
  }
  const ownerId =
    user.role === "ic" ? user.id : (parsed.data.ownerId ?? account.ownerId ?? user.id);
  if (!(await workspaceMember(user.workspaceId, ownerId))) {
    return context.json({ error: "Opportunity owner must be an active workspace member." }, 422);
  }
  const [stage] = await sql<{ id: string }[]>`
    SELECT id FROM opportunity_stages WHERE id = ${parsed.data.stageId} AND workspace_id = ${user.workspaceId}
  `;
  if (!stage) return context.json({ error: "Pipeline stage not found." }, 404);
  if (parsed.data.primaryContactId) {
    const [primaryContact] = await sql<{ id: string }[]>`
      SELECT id FROM contacts
      WHERE id = ${parsed.data.primaryContactId} AND workspace_id = ${user.workspaceId}
        AND account_id = ${parsed.data.accountId} AND archived_at IS NULL
    `;
    if (!primaryContact) {
      return context.json({ error: "Primary contact must belong to this account." }, 422);
    }
  }
  const opportunity = await sql.begin(async (transaction) => {
    const [created] = await transaction<{ id: string }[]>`
      INSERT INTO opportunities (
        workspace_id, account_id, primary_contact_id, owner_id, stage_id, name, value_amount,
        currency, problem_summary, next_action, next_action_at, expected_close_at, created_by
      ) VALUES (
        ${user.workspaceId}, ${parsed.data.accountId}, ${parsed.data.primaryContactId ?? null}, ${ownerId},
        ${stage.id}, ${parsed.data.name}, ${parsed.data.valueAmount ?? null}, ${parsed.data.currency.toUpperCase()},
        ${parsed.data.problemSummary || null}, ${parsed.data.nextAction}, ${parsed.data.nextActionAt},
        ${parsed.data.expectedCloseAt ?? null}, ${user.id}
      ) RETURNING id
    `;
    await transaction`
      INSERT INTO opportunity_stage_history (
        workspace_id, opportunity_id, to_stage_id, changed_by, note
      ) VALUES (${user.workspaceId}, ${created.id}, ${stage.id}, ${user.id}, 'Initial stage')
    `;
    if (parsed.data.primaryContactId) {
      await transaction`
        INSERT INTO opportunity_contacts (
          workspace_id, opportunity_id, contact_id, role, is_primary, created_by
        ) VALUES (
          ${user.workspaceId}, ${created.id}, ${parsed.data.primaryContactId}, 'primary', true, ${user.id}
        )
      `;
    }
    return created;
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "opportunity.created",
    entityType: "opportunity",
    entityId: opportunity.id,
    summary: { accountId: parsed.data.accountId, stageId: stage.id },
  });
  return context.json({ id: opportunity.id }, 201);
});

crmRoutes.patch("/opportunities/:id", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, opportunityUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [current] = await sql<any[]>`
    SELECT * FROM opportunities WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
  `;
  if (!current || !canAccessOwner(user, current.owner_id))
    return context.json({ error: "Opportunity not found." }, 404);
  if (parsed.data.ownerId !== undefined && user.role === "ic")
    return context.json({ error: "Only a Lead can reassign an opportunity." }, 403);
  if (parsed.data.ownerId && !(await workspaceMember(user.workspaceId, parsed.data.ownerId))) {
    return context.json({ error: "Opportunity owner must be an active workspace member." }, 422);
  }
  if (parsed.data.primaryContactId) {
    const [contact] = await sql<{ id: string }[]>`
      SELECT id FROM contacts
      WHERE id = ${parsed.data.primaryContactId} AND workspace_id = ${user.workspaceId}
        AND account_id = ${current.account_id} AND archived_at IS NULL
    `;
    if (!contact) {
      return context.json(
        { error: "Primary contact must belong to this opportunity's account." },
        422,
      );
    }
  }
  let nextStage: { id: string; terminal: boolean; won: boolean } | null = null;
  if (parsed.data.stageId) {
    const [stage] = await sql<{ id: string; terminal: boolean; won: boolean }[]>`
      SELECT id, terminal, won FROM opportunity_stages
      WHERE id = ${parsed.data.stageId} AND workspace_id = ${user.workspaceId}
    `;
    if (!stage) return context.json({ error: "Pipeline stage not found." }, 404);
    nextStage = stage;
    if (stage.terminal && !stage.won && !parsed.data.lossReason && !current.loss_reason) {
      return context.json(
        { error: "A loss reason is required before closing this opportunity." },
        422,
      );
    }
  }
  const stageChanged = Boolean(parsed.data.stageId && parsed.data.stageId !== current.stage_id);
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE opportunities SET
        stage_id = ${parsed.data.stageId ?? current.stage_id},
        stage_entered_at = ${stageChanged ? new Date().toISOString() : current.stage_entered_at},
        closed_at = ${stageChanged && nextStage?.terminal ? new Date().toISOString() : stageChanged ? null : current.closed_at},
        owner_id = ${parsed.data.ownerId !== undefined ? parsed.data.ownerId : current.owner_id},
        primary_contact_id = ${parsed.data.primaryContactId !== undefined ? parsed.data.primaryContactId : current.primary_contact_id},
        name = ${parsed.data.name ?? current.name},
        value_amount = ${parsed.data.valueAmount !== undefined ? parsed.data.valueAmount : current.value_amount},
        currency = ${parsed.data.currency ? parsed.data.currency.toUpperCase() : current.currency},
        problem_summary = ${parsed.data.problemSummary !== undefined ? parsed.data.problemSummary || null : current.problem_summary},
        next_action = ${parsed.data.nextAction ?? current.next_action},
        next_action_at = ${parsed.data.nextActionAt ?? current.next_action_at},
        expected_close_at = ${parsed.data.expectedCloseAt !== undefined ? parsed.data.expectedCloseAt : current.expected_close_at},
        loss_reason = ${parsed.data.lossReason !== undefined ? parsed.data.lossReason : current.loss_reason}
      WHERE id = ${current.id}
    `;
    if (stageChanged && parsed.data.stageId) {
      await transaction`
        INSERT INTO opportunity_stage_history (
          workspace_id, opportunity_id, from_stage_id, to_stage_id, changed_by
        ) VALUES (
          ${user.workspaceId}, ${current.id}, ${current.stage_id}, ${parsed.data.stageId}, ${user.id}
        )
      `;
    }
    if (parsed.data.primaryContactId !== undefined) {
      await transaction`
        UPDATE opportunity_contacts SET is_primary = false
        WHERE workspace_id = ${user.workspaceId} AND opportunity_id = ${current.id}
      `;
      if (parsed.data.primaryContactId) {
        await transaction`
          INSERT INTO opportunity_contacts (
            workspace_id, opportunity_id, contact_id, role, is_primary, created_by
          ) VALUES (
            ${user.workspaceId}, ${current.id}, ${parsed.data.primaryContactId}, 'primary', true, ${user.id}
          )
          ON CONFLICT (opportunity_id, contact_id) DO UPDATE SET is_primary = true
        `;
      }
    }
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "opportunity.updated",
    entityType: "opportunity",
    entityId: current.id,
    summary: { stageId: parsed.data.stageId },
  });
  return context.json({ ok: true });
});
