import { Hono } from "hono";
import { z } from "zod";

import { audit, requireAuth } from "./auth.js";
import { sql } from "./db.js";
import { databaseError, parseJson } from "./http.js";
import { normalizeEmail, normalizeLinkedInUrl } from "./security.js";
import type { AppVariables, SessionUser } from "./types.js";

const contactUpdateSchema = z.object({
  accountId: z.string().uuid().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  title: z.string().trim().max(160).optional(),
  department: z.string().trim().max(100).optional(),
  email: z.string().email().or(z.literal("")).optional(),
  linkedinUrl: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(80).optional(),
  buyerRole: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
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
    .optional(),
  notes: z.string().trim().max(5000).optional(),
  consentStatus: z.enum(["unknown", "legitimate_interest", "opted_in", "opted_out"]).optional(),
  preferredChannel: z.enum(["email", "phone", "linkedin"]).nullable().optional(),
});

const stakeholderSchema = z.object({
  contactId: z.string().uuid(),
  role: z.string().trim().min(1).max(120).optional().default("stakeholder"),
  isPrimary: z.boolean().optional().default(false),
});

const stageChangeSchema = z.object({
  stageId: z.string().uuid(),
  note: z.string().trim().max(2000).optional().default(""),
  lossReason: z.string().trim().max(1000).optional().default(""),
});

type AccessRecord = {
  id: string;
  ownerId: string | null;
  archivedAt: string | null;
};

type OpportunityAccess = AccessRecord & {
  accountId: string;
  stageId: string;
  primaryContactId: string | null;
};

function ownerScope(user: SessionUser) {
  return user.role === "ic" ? user.id : null;
}

async function activeWorkspaceMember(workspaceId: string, userId: string) {
  const [member] = await sql<{ id: string }[]>`
    SELECT u.id
    FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.active = true
    WHERE m.workspace_id = ${workspaceId} AND u.id = ${userId}
  `;
  return member ?? null;
}

async function contactAccess(user: SessionUser, id: string) {
  const ownerId = ownerScope(user);
  const [contact] = await sql<(AccessRecord & { accountId: string })[]>`
    SELECT c.id, c.owner_id AS "ownerId", c.account_id AS "accountId",
      c.archived_at AS "archivedAt"
    FROM contacts c
    WHERE c.id = ${id} AND c.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
  `;
  return contact ?? null;
}

async function accountAccess(user: SessionUser, id: string) {
  const ownerId = ownerScope(user);
  const [account] = await sql<AccessRecord[]>`
    SELECT a.id, a.owner_id AS "ownerId", a.archived_at AS "archivedAt"
    FROM accounts a
    WHERE a.id = ${id} AND a.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId})
  `;
  return account ?? null;
}

async function opportunityAccess(user: SessionUser, id: string) {
  const ownerId = ownerScope(user);
  const [opportunity] = await sql<OpportunityAccess[]>`
    SELECT o.id, o.owner_id AS "ownerId", o.account_id AS "accountId",
      o.stage_id AS "stageId", o.primary_contact_id AS "primaryContactId",
      o.archived_at AS "archivedAt"
    FROM opportunities o
    WHERE o.id = ${id} AND o.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
  `;
  return opportunity ?? null;
}

function archiveFilter(value: string | undefined) {
  if (value === "all") return "all" as const;
  if (value === "archived") return "archived" as const;
  return "active" as const;
}

export const crmEnhancementsRoutes = new Hono<{ Variables: AppVariables }>();
crmEnhancementsRoutes.use("*", requireAuth);

crmEnhancementsRoutes.get("/contacts", async (context) => {
  const user = context.get("user");
  const scopedOwnerId = ownerScope(user);
  const search = context.req.query("search")?.trim().slice(0, 200) ?? "";
  const accountId = context.req.query("accountId")?.trim() ?? "";
  const status = context.req.query("status")?.trim() ?? "";
  const requestedOwnerId = context.req.query("ownerId")?.trim() ?? "";
  const archive = archiveFilter(context.req.query("archived"));
  const limitResult = z.coerce
    .number()
    .int()
    .min(1)
    .max(250)
    .safeParse(context.req.query("limit") ?? 100);
  if (!limitResult.success) return context.json({ error: "limit must be between 1 and 250." }, 422);
  if (accountId && !z.string().uuid().safeParse(accountId).success) {
    return context.json({ error: "accountId must be a UUID." }, 422);
  }
  if (requestedOwnerId && !z.string().uuid().safeParse(requestedOwnerId).success) {
    return context.json({ error: "ownerId must be a UUID." }, 422);
  }
  if (requestedOwnerId && user.role === "ic" && requestedOwnerId !== user.id) {
    return context.json({ error: "You can only view your own contacts." }, 403);
  }
  if (requestedOwnerId && !(await activeWorkspaceMember(user.workspaceId, requestedOwnerId))) {
    return context.json({ error: "Owner is not an active workspace member." }, 422);
  }
  const ownerId = scopedOwnerId ?? (requestedOwnerId || null);
  const contacts = await sql`
    SELECT c.id, c.account_id AS "accountId", a.name AS "accountName",
      c.owner_id AS "ownerId", u.name AS "ownerName", c.first_name AS "firstName",
      c.last_name AS "lastName", c.title, c.department, c.email, c.country, c.state, c.city,
      c.linkedin_url AS "linkedinUrl", c.phone, c.buyer_role AS "buyerRole", c.status,
      c.consent_status AS "consentStatus", c.preferred_channel AS "preferredChannel",
      c.archived_at AS "archivedAt", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
      count(DISTINCT ac.id)::int AS "activityCount",
      max(coalesce(ac.occurred_at, ac.due_at, ac.created_at)) AS "lastActivityAt"
    FROM contacts c
    JOIN accounts a ON a.id = c.account_id AND a.workspace_id = c.workspace_id
    LEFT JOIN users u ON u.id = c.owner_id
    LEFT JOIN activities ac ON ac.contact_id = c.id AND ac.workspace_id = c.workspace_id
    WHERE c.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
      AND (${accountId} = '' OR c.account_id = ${accountId || null}::uuid)
      AND (${status} = '' OR c.status = ${status})
      AND (
        ${search} = '' OR concat_ws(' ', c.first_name, c.last_name) ILIKE ${`%${search}%`}
        OR coalesce(c.email, '') ILIKE ${`%${search}%`}
        OR coalesce(c.title, '') ILIKE ${`%${search}%`}
        OR a.name ILIKE ${`%${search}%`}
      )
      AND (${archive} = 'all'
        OR (${archive} = 'active' AND c.archived_at IS NULL)
        OR (${archive} = 'archived' AND c.archived_at IS NOT NULL))
    GROUP BY c.id, a.name, u.name
    ORDER BY c.updated_at DESC
    LIMIT ${limitResult.data}
  `;
  return context.json({ contacts });
});

crmEnhancementsRoutes.get("/contacts/:id", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const access = await contactAccess(user, id);
  if (!access) return context.json({ error: "Contact not found." }, 404);

  const [contactRows, activities, opportunities, channelStates] = await Promise.all([
    sql`
      SELECT c.*, a.name AS account_name, a.archived_at AS account_archived_at,
        u.name AS owner_name
      FROM contacts c
      JOIN accounts a ON a.id = c.account_id AND a.workspace_id = c.workspace_id
      LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = ${id} AND c.workspace_id = ${user.workspaceId}
    `,
    sql`
      SELECT ac.*, a.name AS account_name, o.name AS opportunity_name, actor.name AS actor_name
      FROM activities ac
      LEFT JOIN accounts a ON a.id = ac.account_id
      LEFT JOIN opportunities o ON o.id = ac.opportunity_id
      LEFT JOIN users actor ON actor.id = ac.actor_id
      WHERE ac.workspace_id = ${user.workspaceId} AND ac.contact_id = ${id}
      ORDER BY coalesce(ac.occurred_at, ac.due_at, ac.created_at) DESC
      LIMIT 100
    `,
    sql`
      SELECT o.id, o.name, o.owner_id, owner.name AS owner_name, o.value_amount, o.currency,
        o.next_action, o.next_action_at, o.expected_close_at, o.archived_at,
        s.id AS stage_id, s.key AS stage_key, s.name AS stage_name,
        oc.role AS stakeholder_role, oc.is_primary
      FROM opportunity_contacts oc
      JOIN opportunities o ON o.id = oc.opportunity_id AND o.workspace_id = oc.workspace_id
      JOIN opportunity_stages s ON s.id = o.stage_id
      LEFT JOIN users owner ON owner.id = o.owner_id
      WHERE oc.workspace_id = ${user.workspaceId} AND oc.contact_id = ${id}
        AND (${ownerScope(user)}::uuid IS NULL OR o.owner_id = ${ownerScope(user)})
      ORDER BY o.updated_at DESC
    `,
    sql`
      SELECT channel, state, connection_note AS "connectionNote",
        requested_at AS "requestedAt", connected_at AS "connectedAt",
        last_message_at AS "lastMessageAt", updated_at AS "updatedAt"
      FROM contact_channel_states
      WHERE workspace_id = ${user.workspaceId} AND contact_id = ${id}
      ORDER BY channel
    `,
  ]);
  return context.json({ contact: contactRows[0], activities, opportunities, channelStates });
});

crmEnhancementsRoutes.patch("/contacts/:id", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const access = await contactAccess(user, id);
  if (!access) return context.json({ error: "Contact not found." }, 404);
  if (access.archivedAt)
    return context.json({ error: "Restore this contact before editing it." }, 409);
  const parsed = await parseJson(context, contactUpdateSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.ownerId !== undefined && user.role === "ic") {
    return context.json({ error: "Only a Lead can reassign a contact." }, 403);
  }
  if (
    parsed.data.ownerId &&
    !(await activeWorkspaceMember(user.workspaceId, parsed.data.ownerId))
  ) {
    return context.json({ error: "Owner is not an active workspace member." }, 422);
  }
  if (parsed.data.accountId) {
    const account = await accountAccess(user, parsed.data.accountId);
    if (!account || account.archivedAt) {
      return context.json({ error: "Contact account must be an accessible active account." }, 422);
    }
  }
  const [current] = await sql<any[]>`
    SELECT * FROM contacts WHERE id = ${id} AND workspace_id = ${user.workspaceId}
  `;
  const changedFields = Object.keys(parsed.data);
  try {
    await sql`
      UPDATE contacts SET
        account_id = ${parsed.data.accountId ?? current.account_id},
        owner_id = ${parsed.data.ownerId !== undefined ? parsed.data.ownerId : current.owner_id},
        first_name = ${parsed.data.firstName ?? current.first_name},
        last_name = ${parsed.data.lastName !== undefined ? parsed.data.lastName || null : current.last_name},
        title = ${parsed.data.title !== undefined ? parsed.data.title || null : current.title},
        department = ${parsed.data.department !== undefined ? parsed.data.department || null : current.department},
        email = ${parsed.data.email !== undefined ? parsed.data.email || null : current.email},
        normalized_email = ${parsed.data.email !== undefined ? normalizeEmail(parsed.data.email) : current.normalized_email},
        linkedin_url = ${parsed.data.linkedinUrl !== undefined ? parsed.data.linkedinUrl || null : current.linkedin_url},
        normalized_linkedin_url = ${parsed.data.linkedinUrl !== undefined ? normalizeLinkedInUrl(parsed.data.linkedinUrl) : current.normalized_linkedin_url},
        phone = ${parsed.data.phone !== undefined ? parsed.data.phone || null : current.phone},
        buyer_role = ${parsed.data.buyerRole !== undefined ? parsed.data.buyerRole || null : current.buyer_role},
        country = ${parsed.data.country !== undefined ? parsed.data.country || null : current.country},
        state = ${parsed.data.state !== undefined ? parsed.data.state || null : current.state},
        city = ${parsed.data.city !== undefined ? parsed.data.city || null : current.city},
        status = ${parsed.data.status ?? current.status},
        notes = ${parsed.data.notes !== undefined ? parsed.data.notes || null : current.notes},
        consent_status = ${parsed.data.consentStatus ?? current.consent_status},
        preferred_channel = ${parsed.data.preferredChannel !== undefined ? parsed.data.preferredChannel : current.preferred_channel}
      WHERE id = ${id} AND workspace_id = ${user.workspaceId}
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "contact.updated",
      entityType: "contact",
      entityId: id,
      summary: { changedFields, ownerId: parsed.data.ownerId },
    });
    return context.json({ ok: true });
  } catch (error) {
    return databaseError(context, error);
  }
});

async function setContactArchived(user: SessionUser, id: string, archived: boolean) {
  const access = await contactAccess(user, id);
  if (!access) return { error: "Contact not found.", status: 404 as const };
  if (Boolean(access.archivedAt) === archived) return { ok: true, changed: false };
  await sql`
    UPDATE contacts SET archived_at = ${archived ? new Date().toISOString() : null}
    WHERE id = ${id} AND workspace_id = ${user.workspaceId}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: archived ? "contact.archived" : "contact.restored",
    entityType: "contact",
    entityId: id,
  });
  return { ok: true, changed: true };
}

crmEnhancementsRoutes.post("/contacts/:id/archive", async (context) => {
  const result = await setContactArchived(context.get("user"), context.req.param("id"), true);
  if ("error" in result) return context.json({ error: result.error }, result.status);
  return context.json(result);
});

crmEnhancementsRoutes.post("/contacts/:id/restore", async (context) => {
  const result = await setContactArchived(context.get("user"), context.req.param("id"), false);
  if ("error" in result) return context.json({ error: result.error }, result.status);
  return context.json(result);
});

crmEnhancementsRoutes.get("/opportunities/:id", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const access = await opportunityAccess(user, id);
  if (!access) return context.json({ error: "Opportunity not found." }, 404);
  const scopedOwnerId = ownerScope(user);
  const [opportunityRows, stakeholders, activities, stageHistory] = await Promise.all([
    sql`
      SELECT o.*, a.name AS account_name, a.archived_at AS account_archived_at,
        s.key AS stage_key, s.name AS stage_name, s.position AS stage_position,
        s.probability AS stage_probability, s.terminal AS stage_terminal, s.won AS stage_won,
        owner.name AS owner_name,
        concat_ws(' ', primary_contact.first_name, primary_contact.last_name) AS primary_contact_name
      FROM opportunities o
      JOIN accounts a ON a.id = o.account_id AND a.workspace_id = o.workspace_id
      JOIN opportunity_stages s ON s.id = o.stage_id AND s.workspace_id = o.workspace_id
      LEFT JOIN users owner ON owner.id = o.owner_id
      LEFT JOIN contacts primary_contact ON primary_contact.id = o.primary_contact_id
      WHERE o.id = ${id} AND o.workspace_id = ${user.workspaceId}
    `,
    sql`
      SELECT c.id, c.account_id, c.owner_id, c.first_name, c.last_name, c.title,
        c.department, c.email, c.linkedin_url, c.phone, c.buyer_role, c.status,
        c.consent_status, c.preferred_channel, c.archived_at,
        oc.role, oc.is_primary, oc.created_at
      FROM opportunity_contacts oc
      JOIN contacts c ON c.id = oc.contact_id AND c.workspace_id = oc.workspace_id
      WHERE oc.workspace_id = ${user.workspaceId} AND oc.opportunity_id = ${id}
        AND c.account_id = ${access.accountId}
        AND (${scopedOwnerId}::uuid IS NULL OR c.owner_id = ${scopedOwnerId})
      ORDER BY oc.is_primary DESC, c.first_name, c.last_name
    `,
    sql`
      SELECT ac.*, actor.name AS actor_name,
        concat_ws(' ', c.first_name, c.last_name) AS contact_name
      FROM activities ac
      LEFT JOIN users actor ON actor.id = ac.actor_id
      LEFT JOIN contacts c ON c.id = ac.contact_id
      WHERE ac.workspace_id = ${user.workspaceId} AND ac.opportunity_id = ${id}
      ORDER BY coalesce(ac.occurred_at, ac.due_at, ac.created_at) DESC
      LIMIT 100
    `,
    sql`
      SELECT h.id, h.from_stage_id, previous.name AS from_stage_name,
        h.to_stage_id, next.name AS to_stage_name, h.changed_by,
        actor.name AS changed_by_name, h.note, h.changed_at
      FROM opportunity_stage_history h
      LEFT JOIN opportunity_stages previous ON previous.id = h.from_stage_id
      JOIN opportunity_stages next ON next.id = h.to_stage_id
      LEFT JOIN users actor ON actor.id = h.changed_by
      WHERE h.workspace_id = ${user.workspaceId} AND h.opportunity_id = ${id}
      ORDER BY h.changed_at DESC
    `,
  ]);
  return context.json({
    opportunity: opportunityRows[0],
    stakeholders,
    activities,
    stageHistory,
  });
});

crmEnhancementsRoutes.post("/opportunities/:id/stakeholders", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const opportunity = await opportunityAccess(user, id);
  if (!opportunity) return context.json({ error: "Opportunity not found." }, 404);
  if (opportunity.archivedAt) {
    return context.json({ error: "Restore this opportunity before changing stakeholders." }, 409);
  }
  const parsed = await parseJson(context, stakeholderSchema);
  if (!parsed.ok) return parsed.response;
  const scopedOwnerId = ownerScope(user);
  const [contact] = await sql<{ id: string; archivedAt: string | null }[]>`
    SELECT c.id, c.archived_at AS "archivedAt"
    FROM contacts c
    WHERE c.id = ${parsed.data.contactId} AND c.workspace_id = ${user.workspaceId}
      AND c.account_id = ${opportunity.accountId}
      AND (${scopedOwnerId}::uuid IS NULL OR c.owner_id = ${scopedOwnerId})
  `;
  if (!contact) {
    return context.json(
      { error: "Stakeholder must be an accessible contact on the opportunity account." },
      422,
    );
  }
  if (contact.archivedAt)
    return context.json({ error: "Archived contacts cannot be stakeholders." }, 409);

  await sql.begin(async (transaction) => {
    if (parsed.data.isPrimary) {
      await transaction`
        UPDATE opportunity_contacts SET is_primary = false
        WHERE workspace_id = ${user.workspaceId} AND opportunity_id = ${id} AND is_primary = true
      `;
    }
    await transaction`
      INSERT INTO opportunity_contacts (
        workspace_id, opportunity_id, contact_id, role, is_primary, created_by
      ) VALUES (
        ${user.workspaceId}, ${id}, ${contact.id}, ${parsed.data.role}, ${parsed.data.isPrimary}, ${user.id}
      )
      ON CONFLICT (opportunity_id, contact_id) DO UPDATE SET
        role = excluded.role, is_primary = excluded.is_primary
    `;
    if (parsed.data.isPrimary) {
      await transaction`
        UPDATE opportunities SET primary_contact_id = ${contact.id}
        WHERE id = ${id} AND workspace_id = ${user.workspaceId}
      `;
    } else if (opportunity.primaryContactId === contact.id) {
      await transaction`
        UPDATE opportunities SET primary_contact_id = null
        WHERE id = ${id} AND workspace_id = ${user.workspaceId}
      `;
    }
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "opportunity.stakeholder_added",
    entityType: "opportunity",
    entityId: id,
    summary: {
      contactId: contact.id,
      role: parsed.data.role,
      isPrimary: parsed.data.isPrimary,
    },
  });
  return context.json({ ok: true }, 201);
});

crmEnhancementsRoutes.delete("/opportunities/:id/stakeholders/:contactId", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const contactId = context.req.param("contactId");
  const opportunity = await opportunityAccess(user, id);
  if (!opportunity) return context.json({ error: "Opportunity not found." }, 404);
  if (opportunity.archivedAt) {
    return context.json({ error: "Restore this opportunity before changing stakeholders." }, 409);
  }
  const scopedOwnerId = ownerScope(user);
  const [stakeholder] = await sql<{ isPrimary: boolean }[]>`
    SELECT oc.is_primary AS "isPrimary"
    FROM opportunity_contacts oc
    JOIN contacts c ON c.id = oc.contact_id AND c.workspace_id = oc.workspace_id
    WHERE oc.workspace_id = ${user.workspaceId} AND oc.opportunity_id = ${id}
      AND oc.contact_id = ${contactId} AND c.account_id = ${opportunity.accountId}
      AND (${scopedOwnerId}::uuid IS NULL OR c.owner_id = ${scopedOwnerId})
  `;
  if (!stakeholder) return context.json({ error: "Stakeholder not found." }, 404);
  await sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM opportunity_contacts
      WHERE workspace_id = ${user.workspaceId} AND opportunity_id = ${id} AND contact_id = ${contactId}
    `;
    if (stakeholder.isPrimary || opportunity.primaryContactId === contactId) {
      await transaction`
        UPDATE opportunities SET primary_contact_id = null
        WHERE id = ${id} AND workspace_id = ${user.workspaceId}
      `;
    }
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "opportunity.stakeholder_removed",
    entityType: "opportunity",
    entityId: id,
    summary: { contactId },
  });
  return context.json({ ok: true });
});

crmEnhancementsRoutes.get("/opportunities/:id/stage-history", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  if (!(await opportunityAccess(user, id))) {
    return context.json({ error: "Opportunity not found." }, 404);
  }
  const stageHistory = await sql`
    SELECT h.id, h.from_stage_id AS "fromStageId", previous.name AS "fromStageName",
      h.to_stage_id AS "toStageId", next.name AS "toStageName",
      h.changed_by AS "changedBy", actor.name AS "changedByName", h.note,
      h.changed_at AS "changedAt"
    FROM opportunity_stage_history h
    LEFT JOIN opportunity_stages previous ON previous.id = h.from_stage_id
    JOIN opportunity_stages next ON next.id = h.to_stage_id
    LEFT JOIN users actor ON actor.id = h.changed_by
    WHERE h.workspace_id = ${user.workspaceId} AND h.opportunity_id = ${id}
    ORDER BY h.changed_at DESC
  `;
  return context.json({ stageHistory });
});

crmEnhancementsRoutes.post("/opportunities/:id/stage", async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const opportunity = await opportunityAccess(user, id);
  if (!opportunity) return context.json({ error: "Opportunity not found." }, 404);
  if (opportunity.archivedAt) {
    return context.json({ error: "Restore this opportunity before moving its stage." }, 409);
  }
  const parsed = await parseJson(context, stageChangeSchema);
  if (!parsed.ok) return parsed.response;
  const [stage] = await sql<{ id: string; terminal: boolean; won: boolean }[]>`
    SELECT id, terminal, won FROM opportunity_stages
    WHERE id = ${parsed.data.stageId} AND workspace_id = ${user.workspaceId}
  `;
  if (!stage) return context.json({ error: "Pipeline stage not found." }, 404);
  if (stage.id === opportunity.stageId) return context.json({ ok: true, changed: false });
  if (stage.terminal && !stage.won && !parsed.data.lossReason) {
    return context.json(
      { error: "A loss reason is required before closing this opportunity." },
      422,
    );
  }
  const changedAt = new Date().toISOString();
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE opportunities SET stage_id = ${stage.id}, stage_entered_at = ${changedAt},
        closed_at = ${stage.terminal ? changedAt : null},
        loss_reason = ${stage.terminal && !stage.won ? parsed.data.lossReason : null}
      WHERE id = ${id} AND workspace_id = ${user.workspaceId}
    `;
    await transaction`
      INSERT INTO opportunity_stage_history (
        workspace_id, opportunity_id, from_stage_id, to_stage_id, changed_by, note, changed_at
      ) VALUES (
        ${user.workspaceId}, ${id}, ${opportunity.stageId}, ${stage.id}, ${user.id},
        ${parsed.data.note || null}, ${changedAt}
      )
    `;
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "opportunity.stage_changed",
    entityType: "opportunity",
    entityId: id,
    summary: { fromStageId: opportunity.stageId, toStageId: stage.id },
  });
  return context.json({ ok: true, changed: true });
});

async function setAccountArchived(user: SessionUser, id: string, archived: boolean) {
  const access = await accountAccess(user, id);
  if (!access) return { error: "Account not found.", status: 404 as const };
  if (Boolean(access.archivedAt) === archived) return { ok: true, changed: false };
  await sql`
    UPDATE accounts SET archived_at = ${archived ? new Date().toISOString() : null}
    WHERE id = ${id} AND workspace_id = ${user.workspaceId}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: archived ? "account.archived" : "account.restored",
    entityType: "account",
    entityId: id,
  });
  return { ok: true, changed: true };
}

crmEnhancementsRoutes.post("/accounts/:id/archive", async (context) => {
  const result = await setAccountArchived(context.get("user"), context.req.param("id"), true);
  if ("error" in result) return context.json({ error: result.error }, result.status);
  return context.json(result);
});

crmEnhancementsRoutes.post("/accounts/:id/restore", async (context) => {
  const result = await setAccountArchived(context.get("user"), context.req.param("id"), false);
  if ("error" in result) return context.json({ error: result.error }, result.status);
  return context.json(result);
});

async function setOpportunityArchived(user: SessionUser, id: string, archived: boolean) {
  const access = await opportunityAccess(user, id);
  if (!access) return { error: "Opportunity not found.", status: 404 as const };
  if (Boolean(access.archivedAt) === archived) return { ok: true, changed: false };
  await sql`
    UPDATE opportunities SET archived_at = ${archived ? new Date().toISOString() : null}
    WHERE id = ${id} AND workspace_id = ${user.workspaceId}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: archived ? "opportunity.archived" : "opportunity.restored",
    entityType: "opportunity",
    entityId: id,
  });
  return { ok: true, changed: true };
}

crmEnhancementsRoutes.post("/opportunities/:id/archive", async (context) => {
  const result = await setOpportunityArchived(context.get("user"), context.req.param("id"), true);
  if ("error" in result) return context.json({ error: result.error }, result.status);
  return context.json(result);
});

crmEnhancementsRoutes.post("/opportunities/:id/restore", async (context) => {
  const result = await setOpportunityArchived(context.get("user"), context.req.param("id"), false);
  if ("error" in result) return context.json({ error: result.error }, result.status);
  return context.json(result);
});

crmEnhancementsRoutes.get("/search", async (context) => {
  const user = context.get("user");
  const query = context.req.query("q")?.trim() ?? "";
  if (query.length < 2 || query.length > 200) {
    return context.json({ error: "q must contain between 2 and 200 characters." }, 422);
  }
  const type = context.req.query("type")?.trim() ?? "all";
  if (!["all", "account", "contact", "opportunity", "activity"].includes(type)) {
    return context.json({ error: "type is not supported." }, 422);
  }
  const includeArchived = context.req.query("includeArchived") === "true";
  const ownerId = ownerScope(user);
  const pattern = `%${query}%`;

  const [accounts, contacts, opportunities, activities] = await Promise.all([
    type === "all" || type === "account"
      ? sql`
          SELECT a.id, 'account'::text AS type, a.name AS title, a.domain AS subtitle,
            a.owner_id AS "ownerId", owner.name AS "ownerName", a.status,
            a.archived_at AS "archivedAt", a.updated_at AS "updatedAt"
          FROM accounts a LEFT JOIN users owner ON owner.id = a.owner_id
          WHERE a.workspace_id = ${user.workspaceId}
            AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId})
            AND (${includeArchived} OR a.archived_at IS NULL)
            AND (a.name ILIKE ${pattern} OR coalesce(a.domain, '') ILIKE ${pattern}
              OR coalesce(a.fit_summary, '') ILIKE ${pattern}
              OR coalesce(a.evidence_summary, '') ILIKE ${pattern})
          ORDER BY a.updated_at DESC LIMIT 15
        `
      : [],
    type === "all" || type === "contact"
      ? sql`
          SELECT c.id, 'contact'::text AS type,
            concat_ws(' ', c.first_name, c.last_name) AS title,
            concat_ws(' · ', nullif(c.title, ''), a.name) AS subtitle,
            c.account_id AS "accountId", c.owner_id AS "ownerId", owner.name AS "ownerName",
            c.status, c.archived_at AS "archivedAt", c.updated_at AS "updatedAt"
          FROM contacts c
          JOIN accounts a ON a.id = c.account_id AND a.workspace_id = c.workspace_id
          LEFT JOIN users owner ON owner.id = c.owner_id
          WHERE c.workspace_id = ${user.workspaceId}
            AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
            AND (${includeArchived} OR c.archived_at IS NULL)
            AND (concat_ws(' ', c.first_name, c.last_name) ILIKE ${pattern}
              OR coalesce(c.email, '') ILIKE ${pattern} OR coalesce(c.title, '') ILIKE ${pattern}
              OR a.name ILIKE ${pattern})
          ORDER BY c.updated_at DESC LIMIT 15
        `
      : [],
    type === "all" || type === "opportunity"
      ? sql`
          SELECT o.id, 'opportunity'::text AS type, o.name AS title,
            concat_ws(' · ', a.name, s.name) AS subtitle, o.account_id AS "accountId",
            o.owner_id AS "ownerId", owner.name AS "ownerName", s.key AS status,
            o.archived_at AS "archivedAt", o.updated_at AS "updatedAt"
          FROM opportunities o
          JOIN accounts a ON a.id = o.account_id AND a.workspace_id = o.workspace_id
          JOIN opportunity_stages s ON s.id = o.stage_id AND s.workspace_id = o.workspace_id
          LEFT JOIN users owner ON owner.id = o.owner_id
          WHERE o.workspace_id = ${user.workspaceId}
            AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
            AND (${includeArchived} OR o.archived_at IS NULL)
            AND (o.name ILIKE ${pattern} OR a.name ILIKE ${pattern}
              OR coalesce(o.problem_summary, '') ILIKE ${pattern}
              OR coalesce(o.next_action, '') ILIKE ${pattern})
          ORDER BY o.updated_at DESC LIMIT 15
        `
      : [],
    type === "all" || type === "activity"
      ? sql`
          SELECT ac.id, 'activity'::text AS type, initcap(replace(ac.type, '_', ' ')) AS title,
            coalesce(ac.details, ac.outcome, a.name, 'Activity') AS subtitle,
            ac.account_id AS "accountId", ac.contact_id AS "contactId",
            ac.opportunity_id AS "opportunityId", ac.actor_id AS "ownerId",
            actor.name AS "ownerName", ac.status,
            coalesce(ac.occurred_at, ac.due_at, ac.created_at) AS "updatedAt"
          FROM activities ac
          LEFT JOIN accounts a ON a.id = ac.account_id
          LEFT JOIN users actor ON actor.id = ac.actor_id
          WHERE ac.workspace_id = ${user.workspaceId}
            AND (${ownerId}::uuid IS NULL OR ac.actor_id = ${ownerId})
            AND (coalesce(ac.details, '') ILIKE ${pattern} OR coalesce(ac.outcome, '') ILIKE ${pattern}
              OR coalesce(a.name, '') ILIKE ${pattern})
          ORDER BY coalesce(ac.occurred_at, ac.due_at, ac.created_at) DESC LIMIT 15
        `
      : [],
  ]);
  return context.json({ query, results: { accounts, contacts, opportunities, activities } });
});
