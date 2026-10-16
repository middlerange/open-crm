import { Hono } from "hono";
import { z } from "zod";

import { audit, canAccessOwner, requireAuth, requireRole } from "./auth.js";
import { sql } from "./db.js";
import { parseJson } from "./http.js";
import type { AppVariables, SessionUser } from "./types.js";

const taskStatusSchema = z.enum([
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled",
]);
const taskPrioritySchema = z.enum(["urgent", "high", "medium", "low"]);
const taskDescriptionSchema = z.string().trim().max(8000);

const taskSchema = z.object({
  ownerId: z.string().uuid().optional().nullable(),
  workstream: z.enum(["outbound", "content", "video", "sales", "operations"]),
  kind: z.string().trim().min(1).max(80),
  title: z.string().trim().min(2).max(240),
  description: taskDescriptionSchema.optional().default(""),
  status: taskStatusSchema.optional().default("backlog"),
  priority: taskPrioritySchema.optional().default("medium"),
  entityType: z.string().trim().max(60).optional().nullable(),
  entityId: z.string().uuid().optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
  estimateMinutes: z.number().int().positive().max(100000).optional().nullable(),
});

const taskUpdateSchema = taskSchema.partial().extend({
  description: taskDescriptionSchema.optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  blockedReason: z.string().trim().max(3000).optional().nullable(),
});

const campaignSchema = z.object({
  name: z.string().trim().min(2).max(240),
  ownerId: z.string().uuid().optional(),
  segment: z.string().trim().max(500).optional().default(""),
  hypothesis: z.string().trim().max(5000).optional().default(""),
  valueProposition: z.string().trim().max(5000).optional().default(""),
  channels: z
    .array(z.enum(["email", "linkedin", "call", "content", "video"]))
    .max(5)
    .default([]),
  successMetric: z.string().trim().max(1000).optional().default(""),
  startAt: z.string().date().optional().nullable(),
  endAt: z.string().date().optional().nullable(),
});

const campaignUpdateSchema = campaignSchema.partial().extend({
  status: z
    .enum(["draft", "pending_approval", "approved", "active", "paused", "complete", "archived"])
    .optional(),
});

const assetSchema = z.object({
  campaignId: z.string().uuid().optional().nullable(),
  ownerId: z.string().uuid().optional(),
  type: z.enum(["email_sequence", "outreach_draft", "content", "video", "demo", "teardown"]),
  title: z.string().trim().min(2).max(240),
  useCase: z.string().trim().max(500).optional().default(""),
  channel: z.string().trim().max(120).optional().default(""),
  brief: z.string().trim().max(12000).optional().default(""),
  body: z.string().trim().max(50000).optional().default(""),
  externalUrl: z.string().url().optional().or(z.literal("")),
  dueAt: z.string().datetime().optional().nullable(),
});

const assetUpdateSchema = assetSchema.partial().extend({
  status: z
    .enum([
      "idea",
      "brief",
      "draft",
      "production",
      "pending_approval",
      "changes_requested",
      "approved",
      "scheduled",
      "published",
      "archived",
    ])
    .optional(),
  publishedAt: z.string().datetime().optional().nullable(),
});

const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "changes_requested", "rejected"]),
  note: z.string().trim().max(5000).optional().default(""),
});

function ownerScope(user: { role: string; id: string }) {
  return user.role === "ic" ? user.id : null;
}

async function activeWorkspaceMember(workspaceId: string, userId: string) {
  const [member] = await sql<{ id: string }[]>`
    SELECT u.id FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.active = true
    WHERE m.workspace_id = ${workspaceId} AND u.id = ${userId}
  `;
  return member ?? null;
}

async function crmEntityAccess(
  user: SessionUser,
  entityType: string | null,
  entityId: string | null,
) {
  if (!entityType && !entityId) return true;
  if (!entityType || !entityId) return false;
  const ownerId = ownerScope(user);
  if (entityType === "account") {
    const [record] = await sql<{ id: string }[]>`
      SELECT id FROM accounts
      WHERE id = ${entityId} AND workspace_id = ${user.workspaceId} AND archived_at IS NULL
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
    `;
    return Boolean(record);
  }
  if (entityType === "contact") {
    const [record] = await sql<{ id: string }[]>`
      SELECT id FROM contacts
      WHERE id = ${entityId} AND workspace_id = ${user.workspaceId} AND archived_at IS NULL
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
    `;
    return Boolean(record);
  }
  if (entityType === "opportunity") {
    const [record] = await sql<{ id: string }[]>`
      SELECT id FROM opportunities
      WHERE id = ${entityId} AND workspace_id = ${user.workspaceId} AND archived_at IS NULL
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
    `;
    return Boolean(record);
  }
  return true;
}

export const workRoutes = new Hono<{ Variables: AppVariables }>();
workRoutes.use("*", requireAuth);

workRoutes.get("/tasks", async (context) => {
  const user = context.get("user");
  const ownerId = ownerScope(user);
  const status = context.req.query("status") ?? "";
  const workstream = context.req.query("workstream") ?? "";
  const tasks = await sql`
    SELECT wi.*, u.name AS owner_name, creator.name AS created_by_name,
      coalesce(a.name, nullif(concat_ws(' ', c.first_name, c.last_name), ''), o.name) AS entity_name
    FROM work_items wi
    LEFT JOIN users u ON u.id = wi.owner_id
    LEFT JOIN users creator ON creator.id = wi.created_by
    LEFT JOIN accounts a ON wi.entity_type = 'account' AND a.id = wi.entity_id
    LEFT JOIN contacts c ON wi.entity_type = 'contact' AND c.id = wi.entity_id
    LEFT JOIN opportunities o ON wi.entity_type = 'opportunity' AND o.id = wi.entity_id
    WHERE wi.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR wi.owner_id = ${ownerId})
      AND (${status} = '' OR wi.status = ${status})
      AND (${workstream} = '' OR wi.workstream = ${workstream})
    ORDER BY
      CASE wi.status WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'blocked' THEN 3 WHEN 'review' THEN 4 WHEN 'backlog' THEN 5 ELSE 6 END,
      CASE wi.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      wi.due_at NULLS LAST, wi.created_at DESC
  `;
  return context.json({ tasks });
});

workRoutes.post("/tasks", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, taskSchema);
  if (!parsed.ok) return parsed.response;
  const ownerId = user.role === "ic" ? user.id : (parsed.data.ownerId ?? user.id);
  if (!(await activeWorkspaceMember(user.workspaceId, ownerId))) {
    return context.json({ error: "Task owner must be an active workspace member." }, 422);
  }
  if (
    !(await crmEntityAccess(user, parsed.data.entityType ?? null, parsed.data.entityId ?? null))
  ) {
    return context.json({ error: "Related CRM record was not found." }, 422);
  }
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO work_items (
      workspace_id, owner_id, created_by, workstream, kind, title, description, status,
      priority, entity_type, entity_id, due_at, estimate_minutes
    ) VALUES (
      ${user.workspaceId}, ${ownerId}, ${user.id}, ${parsed.data.workstream}, ${parsed.data.kind},
      ${parsed.data.title}, ${parsed.data.description || null}, ${parsed.data.status}, ${parsed.data.priority},
      ${parsed.data.entityType ?? null}, ${parsed.data.entityId ?? null}, ${parsed.data.dueAt ?? null},
      ${parsed.data.estimateMinutes ?? null}
    ) RETURNING id
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "task.created",
    entityType: "task",
    entityId: task.id,
    summary: { ownerId, workstream: parsed.data.workstream },
  });
  return context.json({ id: task.id }, 201);
});

workRoutes.patch("/tasks/:id", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, taskUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [current] = await sql<
    any[]
  >`SELECT * FROM work_items WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}`;
  if (!current || !canAccessOwner(user, current.owner_id))
    return context.json({ error: "Task not found." }, 404);
  if (parsed.data.ownerId !== undefined && user.role === "ic")
    return context.json({ error: "Only a Lead can reassign work." }, 403);
  if (
    parsed.data.ownerId &&
    !(await activeWorkspaceMember(user.workspaceId, parsed.data.ownerId))
  ) {
    return context.json({ error: "Task owner must be an active workspace member." }, 422);
  }
  const entityType =
    parsed.data.entityType !== undefined ? parsed.data.entityType : current.entity_type;
  const entityId = parsed.data.entityId !== undefined ? parsed.data.entityId : current.entity_id;
  if (!(await crmEntityAccess(user, entityType, entityId))) {
    return context.json({ error: "Related CRM record was not found." }, 422);
  }
  const nextStatus = parsed.data.status ?? current.status;
  const now = new Date().toISOString();
  let nextCompletedAt = current.completed_at;
  if (nextStatus !== "done") nextCompletedAt = null;
  else if (current.status !== "done") nextCompletedAt = now;
  await sql`
    UPDATE work_items SET
      owner_id = ${parsed.data.ownerId !== undefined ? parsed.data.ownerId : current.owner_id},
      workstream = ${parsed.data.workstream ?? current.workstream},
      kind = ${parsed.data.kind ?? current.kind},
      title = ${parsed.data.title ?? current.title},
      description = ${parsed.data.description !== undefined ? parsed.data.description || null : current.description},
      status = ${nextStatus},
      priority = ${parsed.data.priority ?? current.priority},
      entity_type = ${parsed.data.entityType !== undefined ? parsed.data.entityType : current.entity_type},
      entity_id = ${parsed.data.entityId !== undefined ? parsed.data.entityId : current.entity_id},
      due_at = ${parsed.data.dueAt !== undefined ? parsed.data.dueAt : current.due_at},
      estimate_minutes = ${parsed.data.estimateMinutes !== undefined ? parsed.data.estimateMinutes : current.estimate_minutes},
      blocked_reason = ${parsed.data.blockedReason !== undefined ? parsed.data.blockedReason : current.blocked_reason},
      started_at = ${nextStatus === "in_progress" && !current.started_at ? now : current.started_at},
      completed_at = ${nextCompletedAt}
    WHERE id = ${current.id}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "task.updated",
    entityType: "task",
    entityId: current.id,
    summary: { status: nextStatus, ownerId: parsed.data.ownerId },
  });
  return context.json({ ok: true });
});

workRoutes.get("/campaigns", async (context) => {
  const user = context.get("user");
  const ownerId = ownerScope(user);
  const campaigns = await sql`
    SELECT c.*, u.name AS owner_name,
      count(DISTINCT a.id)::int AS assets,
      count(DISTINCT a.id) FILTER (WHERE a.status = 'pending_approval')::int AS assets_pending
    FROM campaigns c LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN assets a ON a.campaign_id = c.id
    WHERE c.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
    GROUP BY c.id, u.name ORDER BY c.created_at DESC
  `;
  return context.json({ campaigns });
});

workRoutes.post("/campaigns", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, campaignSchema);
  if (!parsed.ok) return parsed.response;
  const ownerId = user.role === "ic" ? user.id : (parsed.data.ownerId ?? user.id);
  const [campaign] = await sql<{ id: string }[]>`
    INSERT INTO campaigns (
      workspace_id, name, owner_id, segment, hypothesis, value_proposition, channels,
      success_metric, start_at, end_at, created_by
    ) VALUES (
      ${user.workspaceId}, ${parsed.data.name}, ${ownerId}, ${parsed.data.segment || null},
      ${parsed.data.hypothesis || null}, ${parsed.data.valueProposition || null}, ${parsed.data.channels},
      ${parsed.data.successMetric || null}, ${parsed.data.startAt ?? null}, ${parsed.data.endAt ?? null}, ${user.id}
    ) RETURNING id
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "campaign.created",
    entityType: "campaign",
    entityId: campaign.id,
    summary: { ownerId },
  });
  return context.json({ id: campaign.id }, 201);
});

workRoutes.patch("/campaigns/:id", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, campaignUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [current] = await sql<
    any[]
  >`SELECT * FROM campaigns WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}`;
  if (!current || !canAccessOwner(user, current.owner_id))
    return context.json({ error: "Campaign not found." }, 404);
  if (["pending_approval", "approved"].includes(parsed.data.status ?? "")) {
    return context.json({ error: "Use the approval workflow to approve a campaign." }, 422);
  }
  if (
    parsed.data.status === "active" &&
    (!current.approved_at || !["approved", "active", "paused"].includes(current.status))
  ) {
    return context.json({ error: "A campaign must be approved before it can become active." }, 422);
  }
  const changesApprovedCampaign =
    parsed.data.name !== undefined ||
    parsed.data.segment !== undefined ||
    parsed.data.hypothesis !== undefined ||
    parsed.data.valueProposition !== undefined ||
    parsed.data.channels !== undefined ||
    parsed.data.successMetric !== undefined;
  if (current.approved_at && changesApprovedCampaign) {
    return context.json(
      { error: "Approved campaign content is locked. Create a new draft for material changes." },
      409,
    );
  }
  if (
    (parsed.data.ownerId !== undefined || parsed.data.status === "approved") &&
    user.role === "ic"
  ) {
    return context.json({ error: "Only a Lead can reassign or approve a campaign." }, 403);
  }
  await sql`
    UPDATE campaigns SET
      name = ${parsed.data.name ?? current.name}, owner_id = ${parsed.data.ownerId ?? current.owner_id},
      segment = ${parsed.data.segment !== undefined ? parsed.data.segment || null : current.segment},
      hypothesis = ${parsed.data.hypothesis !== undefined ? parsed.data.hypothesis || null : current.hypothesis},
      value_proposition = ${parsed.data.valueProposition !== undefined ? parsed.data.valueProposition || null : current.value_proposition},
      channels = ${parsed.data.channels ?? current.channels},
      success_metric = ${parsed.data.successMetric !== undefined ? parsed.data.successMetric || null : current.success_metric},
      start_at = ${parsed.data.startAt !== undefined ? parsed.data.startAt : current.start_at},
      end_at = ${parsed.data.endAt !== undefined ? parsed.data.endAt : current.end_at},
      status = ${parsed.data.status ?? current.status}
    WHERE id = ${current.id}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "campaign.updated",
    entityType: "campaign",
    entityId: current.id,
  });
  return context.json({ ok: true });
});

workRoutes.post("/campaigns/:id/submit", async (context) => {
  const user = context.get("user");
  const [campaign] = await sql<
    any[]
  >`SELECT * FROM campaigns WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}`;
  if (!campaign || !canAccessOwner(user, campaign.owner_id))
    return context.json({ error: "Campaign not found." }, 404);
  if (campaign.status === "pending_approval")
    return context.json({ error: "This campaign is already waiting for approval." }, 409);
  if (["approved", "active", "paused", "complete"].includes(campaign.status))
    return context.json({ error: "This campaign has already passed approval." }, 409);
  if (
    !campaign.segment ||
    !campaign.hypothesis ||
    !campaign.value_proposition ||
    !campaign.success_metric
  ) {
    return context.json(
      {
        error:
          "Campaign approval requires a segment, hypothesis, value proposition, and success metric.",
      },
      422,
    );
  }
  const [approval] = await sql.begin(async (transaction) => {
    await transaction`UPDATE campaigns SET status = 'pending_approval' WHERE id = ${campaign.id}`;
    return transaction<{ id: string }[]>`
      INSERT INTO approvals (workspace_id, subject_type, subject_id, gate, requested_by)
      VALUES (${user.workspaceId}, 'campaign', ${campaign.id}, 'campaign_asset', ${user.id}) RETURNING id
    `;
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "campaign.submitted",
    entityType: "campaign",
    entityId: campaign.id,
  });
  return context.json({ approvalId: approval.id }, 201);
});

workRoutes.get("/assets", async (context) => {
  const user = context.get("user");
  const ownerId = ownerScope(user);
  const type = context.req.query("type") ?? "";
  const assets = await sql`
    SELECT a.*, u.name AS owner_name, c.name AS campaign_name
    FROM assets a LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId} OR a.status IN ('approved', 'scheduled', 'published'))
      AND (${type} = '' OR a.type = ${type})
    ORDER BY a.due_at NULLS LAST, a.created_at DESC
  `;
  return context.json({ assets });
});

workRoutes.post("/assets", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, assetSchema);
  if (!parsed.ok) return parsed.response;
  const ownerId = user.role === "ic" ? user.id : (parsed.data.ownerId ?? user.id);
  const initialStatus = parsed.data.body ? "draft" : parsed.data.brief ? "brief" : "idea";
  const [asset] = await sql<{ id: string }[]>`
    INSERT INTO assets (
      workspace_id, campaign_id, owner_id, type, title, status, use_case, channel, brief, body,
      external_url, due_at, created_by
    ) VALUES (
      ${user.workspaceId}, ${parsed.data.campaignId ?? null}, ${ownerId}, ${parsed.data.type},
      ${parsed.data.title}, ${initialStatus}, ${parsed.data.useCase || null}, ${parsed.data.channel || null},
      ${parsed.data.brief || null}, ${parsed.data.body || null}, ${parsed.data.externalUrl || null},
      ${parsed.data.dueAt ?? null}, ${user.id}
    ) RETURNING id
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "asset.created",
    entityType: "asset",
    entityId: asset.id,
    summary: { type: parsed.data.type, ownerId },
  });
  return context.json({ id: asset.id }, 201);
});

workRoutes.patch("/assets/:id", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, assetUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [current] = await sql<
    any[]
  >`SELECT * FROM assets WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}`;
  if (!current || !canAccessOwner(user, current.owner_id))
    return context.json({ error: "Asset not found." }, 404);
  if (["pending_approval", "approved"].includes(parsed.data.status ?? "")) {
    return context.json({ error: "Use the approval workflow to approve an asset." }, 422);
  }
  if (["scheduled", "published"].includes(parsed.data.status ?? "") && !current.approved_at) {
    return context.json(
      { error: "An asset must be approved before scheduling or publishing." },
      422,
    );
  }
  const changesApprovedAsset =
    parsed.data.campaignId !== undefined ||
    parsed.data.type !== undefined ||
    parsed.data.title !== undefined ||
    parsed.data.useCase !== undefined ||
    parsed.data.channel !== undefined ||
    parsed.data.brief !== undefined ||
    parsed.data.body !== undefined ||
    parsed.data.externalUrl !== undefined;
  if (current.approved_at && changesApprovedAsset) {
    return context.json(
      { error: "Approved asset content is locked. Create a new draft for material changes." },
      409,
    );
  }
  if (
    (parsed.data.ownerId !== undefined || parsed.data.status === "approved") &&
    user.role === "ic"
  ) {
    return context.json({ error: "Only a Lead can reassign or approve an asset." }, 403);
  }
  await sql`
    UPDATE assets SET
      campaign_id = ${parsed.data.campaignId !== undefined ? parsed.data.campaignId : current.campaign_id},
      owner_id = ${parsed.data.ownerId ?? current.owner_id}, type = ${parsed.data.type ?? current.type},
      title = ${parsed.data.title ?? current.title},
      use_case = ${parsed.data.useCase !== undefined ? parsed.data.useCase || null : current.use_case},
      channel = ${parsed.data.channel !== undefined ? parsed.data.channel || null : current.channel},
      brief = ${parsed.data.brief !== undefined ? parsed.data.brief || null : current.brief},
      body = ${parsed.data.body !== undefined ? parsed.data.body || null : current.body},
      external_url = ${parsed.data.externalUrl !== undefined ? parsed.data.externalUrl || null : current.external_url},
      due_at = ${parsed.data.dueAt !== undefined ? parsed.data.dueAt : current.due_at},
      status = ${parsed.data.status ?? current.status},
      published_at = ${parsed.data.publishedAt !== undefined ? parsed.data.publishedAt : current.published_at}
    WHERE id = ${current.id}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "asset.updated",
    entityType: "asset",
    entityId: current.id,
    summary: { status: parsed.data.status },
  });
  return context.json({ ok: true });
});

workRoutes.post("/assets/:id/submit", async (context) => {
  const user = context.get("user");
  const [asset] = await sql<
    any[]
  >`SELECT * FROM assets WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}`;
  if (!asset || !canAccessOwner(user, asset.owner_id))
    return context.json({ error: "Asset not found." }, 404);
  if (asset.status === "pending_approval")
    return context.json({ error: "This asset is already waiting for approval." }, 409);
  if (["approved", "scheduled", "published"].includes(asset.status))
    return context.json({ error: "This asset has already passed approval." }, 409);
  if (!asset.brief || !asset.body)
    return context.json({ error: "Approval requires both a brief and a completed draft." }, 422);
  const [approval] = await sql.begin(async (transaction) => {
    await transaction`UPDATE assets SET status = 'pending_approval' WHERE id = ${asset.id}`;
    return transaction<{ id: string }[]>`
      INSERT INTO approvals (workspace_id, subject_type, subject_id, gate, requested_by)
      VALUES (${user.workspaceId}, 'asset', ${asset.id}, 'campaign_asset', ${user.id}) RETURNING id
    `;
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "asset.submitted",
    entityType: "asset",
    entityId: asset.id,
  });
  return context.json({ approvalId: approval.id }, 201);
});

workRoutes.get("/approvals", async (context) => {
  const user = context.get("user");
  const ownerId = ownerScope(user);
  const approvals = await sql<
    {
      id: string;
      subjectType: string;
      subjectId: string;
      gate: string;
      status: string;
      requestedAt: string;
      requesterName: string;
      reviewerName: string | null;
      subjectTitle: string;
      requestNote: string | null;
      decisionNote: string | null;
    }[]
  >`
    SELECT ap.id, ap.subject_type AS "subjectType", ap.subject_id AS "subjectId", ap.gate, ap.status,
      ap.requested_at AS "requestedAt", requester.name AS "requesterName", reviewer.name AS "reviewerName",
      coalesce(acc.name, cam.name, ast.title, 'Unknown subject') AS "subjectTitle",
      ap.request_note AS "requestNote", ap.decision_note AS "decisionNote"
    FROM approvals ap
    JOIN users requester ON requester.id = ap.requested_by
    LEFT JOIN users reviewer ON reviewer.id = ap.reviewer_id
    LEFT JOIN accounts acc ON ap.subject_type = 'account' AND acc.id = ap.subject_id
    LEFT JOIN campaigns cam ON ap.subject_type = 'campaign' AND cam.id = ap.subject_id
    LEFT JOIN assets ast ON ap.subject_type = 'asset' AND ast.id = ap.subject_id
    WHERE ap.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR ap.requested_by = ${ownerId})
    ORDER BY CASE ap.status WHEN 'pending' THEN 1 ELSE 2 END, ap.requested_at DESC
    LIMIT 200
  `;
  return context.json({ approvals });
});

workRoutes.post("/approvals/:id/decision", requireRole("manager"), async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, approvalDecisionSchema);
  if (!parsed.ok) return parsed.response;
  const [approval] = await sql<any[]>`
    SELECT * FROM approvals WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId} AND status = 'pending'
  `;
  if (!approval) return context.json({ error: "Pending approval not found." }, 404);
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE approvals SET status = ${parsed.data.decision}, reviewer_id = ${user.id},
        decision_note = ${parsed.data.note || null}, decided_at = now()
      WHERE id = ${approval.id}
    `;
    if (approval.subject_type === "account") {
      const accountStatus =
        parsed.data.decision === "approved"
          ? "approved"
          : parsed.data.decision === "rejected"
            ? "disqualified"
            : "research";
      await transaction`
        UPDATE accounts SET status = ${accountStatus},
          approved_by = ${parsed.data.decision === "approved" ? user.id : null},
          approved_at = ${parsed.data.decision === "approved" ? new Date().toISOString() : null}
        WHERE id = ${approval.subject_id}
      `;
    } else if (approval.subject_type === "campaign") {
      const campaignStatus =
        parsed.data.decision === "approved"
          ? "approved"
          : parsed.data.decision === "rejected"
            ? "archived"
            : "draft";
      await transaction`
        UPDATE campaigns SET status = ${campaignStatus},
          approved_by = ${parsed.data.decision === "approved" ? user.id : null},
          approved_at = ${parsed.data.decision === "approved" ? new Date().toISOString() : null}
        WHERE id = ${approval.subject_id}
      `;
    } else {
      const assetStatus =
        parsed.data.decision === "approved"
          ? "approved"
          : parsed.data.decision === "rejected"
            ? "archived"
            : "changes_requested";
      await transaction`
        UPDATE assets SET status = ${assetStatus},
          approved_by = ${parsed.data.decision === "approved" ? user.id : null},
          approved_at = ${parsed.data.decision === "approved" ? new Date().toISOString() : null}
        WHERE id = ${approval.subject_id}
      `;
    }
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "approval.decided",
    entityType: approval.subject_type,
    entityId: approval.subject_id,
    summary: { decision: parsed.data.decision, gate: approval.gate },
  });
  return context.json({ ok: true });
});
