import { timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { audit } from "./auth.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { databaseError, parseJson } from "./http.js";
import { hashToken, normalizeDomain, normalizeLinkedInUrl } from "./security.js";
import type { AppVariables, Role } from "./types.js";

type AgentIdentity = AppVariables["agent"];

const agentAuth = createMiddleware<{ Variables: AppVariables }>(async (context, next) => {
  const authorization = context.req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return context.json({ error: "Agent authentication required." }, 401);

  let identity: AgentIdentity | null = null;
  let label = "Hermes";
  let scopes = ["read", "write"];
  if (config.AGENT_API_TOKEN) {
    const provided = Buffer.from(hashToken(token));
    const expected = Buffer.from(hashToken(config.AGENT_API_TOKEN));
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      const [founder] = await sql<
        {
          workspaceId: string;
          userId: string;
          role: Role;
          userName: string;
          userEmail: string;
        }[]
      >`
        SELECT w.id AS "workspaceId", u.id AS "userId", m.role,
          u.name AS "userName", u.email AS "userEmail"
        FROM workspaces w
        JOIN memberships m ON m.workspace_id = w.id AND m.role = 'founder'
        JOIN users u ON u.id = m.user_id AND u.active = true
        ORDER BY w.created_at, m.joined_at
        LIMIT 1
      `;
      if (founder) identity = { ...founder, label, scopes };
    }
  }
  if (!identity) {
    const [agentToken] = await sql<
      {
        workspaceId: string;
        name: string;
        scopes: string[];
        userId: string;
        role: Role;
        userName: string;
        userEmail: string;
      }[]
    >`
      SELECT at.workspace_id AS "workspaceId", at.name, at.scopes,
        u.id AS "userId", m.role, u.name AS "userName", u.email AS "userEmail"
      FROM agent_tokens at
      JOIN users u ON u.id = at.created_by AND u.active = true
      JOIN memberships m ON m.workspace_id = at.workspace_id AND m.user_id = u.id
      WHERE at.token_hash = ${hashToken(token)} AND at.active = true
    `;
    if (agentToken) {
      label = agentToken.name;
      scopes = agentToken.scopes;
      identity = { ...agentToken, label, scopes };
      await sql`UPDATE agent_tokens SET last_used_at = now() WHERE token_hash = ${hashToken(token)}`;
    }
  }
  if (!identity)
    return context.json({ error: "Agent token is invalid or has no active user." }, 401);
  context.set("agent", identity);
  await next();
});

const requireAgentScope = createMiddleware<{ Variables: AppVariables }>(async (context, next) => {
  const requiredScope = ["GET", "HEAD", "OPTIONS"].includes(context.req.method) ? "read" : "write";
  if (!context.get("agent").scopes.includes(requiredScope)) {
    return context.json({ error: `Agent token requires the ${requiredScope} scope.` }, 403);
  }
  await next();
});

const taskInput = z.object({
  ownerId: z.string().uuid(),
  workstream: z.enum(["outbound", "content", "video", "sales", "operations"]),
  kind: z.string().trim().min(1).max(80),
  title: z.string().trim().min(2).max(240),
  description: z.string().trim().max(8000).optional().default(""),
  priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
  dueAt: z.string().datetime().optional().nullable(),
  entityType: z.string().trim().max(60).optional().nullable(),
  entityId: z.string().uuid().optional().nullable(),
  initiatingUserId: z.string().uuid().optional().nullable(),
  channel: z.string().trim().max(80).optional().default("discord"),
});

const taskUpdateInput = z.object({
  ownerId: z.string().uuid().optional(),
  workstream: z.enum(["outbound", "content", "video", "sales", "operations"]).optional(),
  kind: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(2).max(240).optional(),
  description: z.string().trim().max(8000).optional(),
  status: z
    .enum(["backlog", "ready", "in_progress", "blocked", "review", "done", "cancelled"])
    .optional(),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
  dueAt: z.string().datetime().optional().nullable(),
  entityType: z.string().trim().max(60).optional().nullable(),
  entityId: z.string().uuid().optional().nullable(),
  estimateMinutes: z.number().int().positive().max(100000).optional().nullable(),
  blockedReason: z.string().trim().max(3000).optional().nullable(),
  initiatingUserId: z.string().uuid().optional().nullable(),
  channel: z.string().trim().max(80).optional().default("codex"),
});

const assignmentInput = z.object({
  taskId: z.string().uuid(),
  ownerId: z.string().uuid(),
  initiatingUserId: z.string().uuid().optional().nullable(),
  channel: z.string().trim().max(80).optional().default("discord"),
});

const activityInput = z.object({
  actorId: z.string().uuid(),
  accountId: z.string().uuid().optional().nullable(),
  contactId: z.string().uuid().optional().nullable(),
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
  initiatingUserId: z.string().uuid().optional().nullable(),
  channel: z.string().trim().max(80).optional().default("discord"),
});

const draftInput = z.object({
  ownerId: z.string().uuid(),
  type: z.enum(["email_sequence", "outreach_draft", "content", "video", "demo", "teardown"]),
  title: z.string().trim().min(2).max(240),
  brief: z.string().trim().max(12000).optional().default(""),
  body: z.string().trim().max(50000).optional().default(""),
  useCase: z.string().trim().max(500).optional().default(""),
  campaignId: z.string().uuid().optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
  initiatingUserId: z.string().uuid().optional().nullable(),
  channel: z.string().trim().max(80).optional().default("discord"),
});

const accountInput = z
  .object({
    ownerId: z.string().uuid(),
    name: z.string().trim().min(2).max(180),
    domain: z.string().trim().max(255).optional().default(""),
    linkedinUrl: z.string().trim().max(500).optional().default(""),
    websiteUrl: z.string().trim().max(500).optional().default(""),
    tier: z.enum(["A", "B", "C"]).default("C"),
    employeeRange: z.string().trim().max(80).optional().default(""),
    country: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    city: z.string().trim().max(120).optional(),
    industry: z.string().trim().max(120).optional().default(""),
    productMotion: z.string().trim().max(120).optional().default(""),
    source: z.string().trim().max(120).optional().default("agent"),
    fitSummary: z.string().trim().max(5000).optional().default(""),
    evidenceSummary: z.string().trim().max(5000).optional().default(""),
    triggerSummary: z.string().trim().max(5000).optional().default(""),
    sourceLinks: z.array(z.string().url()).max(20).optional().default([]),
    score: z.number().int().min(0).max(100).optional().default(0),
    nextAction: z.string().trim().max(1000).optional().default(""),
    nextActionAt: z.string().datetime().optional().nullable(),
    initiatingUserId: z.string().uuid().optional().nullable(),
    channel: z.string().trim().max(80).optional().default("discord"),
  })
  .refine((value) => Boolean(value.domain || value.linkedinUrl), {
    message: "A company domain or LinkedIn URL is required for duplicate protection.",
    path: ["domain"],
  });

const accountUpdateInput = z.object({
  ownerId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(180).optional(),
  domain: z.string().trim().max(255).optional(),
  linkedinUrl: z.string().trim().max(500).optional(),
  websiteUrl: z.string().trim().max(500).optional(),
  tier: z.enum(["A", "B", "C"]).optional(),
  employeeRange: z.string().trim().max(80).optional(),
  country: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  industry: z.string().trim().max(120).optional(),
  productMotion: z.string().trim().max(120).optional(),
  source: z.string().trim().max(120).optional(),
  fitSummary: z.string().trim().max(5000).optional(),
  evidenceSummary: z.string().trim().max(5000).optional(),
  triggerSummary: z.string().trim().max(5000).optional(),
  sourceLinks: z.array(z.string().url()).max(20).optional(),
  score: z.number().int().min(0).max(100).optional(),
  nextAction: z.string().trim().max(1000).optional(),
  nextActionAt: z.string().datetime().optional().nullable(),
  status: z.enum(["research", "active", "nurture", "disqualified"]).optional(),
  disqualificationReason: z.string().trim().max(1000).optional().nullable(),
  initiatingUserId: z.string().uuid().optional().nullable(),
  channel: z.string().trim().max(80).optional().default("codex"),
});

const campaignInput = z.object({
  ownerId: z.string().uuid(),
  name: z.string().trim().min(2).max(240),
  segment: z.string().trim().max(500).optional().default(""),
  hypothesis: z.string().trim().max(5000).optional().default(""),
  valueProposition: z.string().trim().max(5000).optional().default(""),
  channels: z
    .array(z.enum(["email", "linkedin", "call", "content", "video"]))
    .max(5)
    .optional()
    .default([]),
  successMetric: z.string().trim().max(1000).optional().default(""),
  startAt: z.string().date().optional().nullable(),
  endAt: z.string().date().optional().nullable(),
  initiatingUserId: z.string().uuid().optional().nullable(),
  channel: z.string().trim().max(80).optional().default("codex"),
});

const campaignUpdateInput = campaignInput.partial().extend({
  status: z.enum(["draft", "active", "paused", "complete", "archived"]).optional(),
  channel: z.string().trim().max(80).optional().default("codex"),
});

const submissionInput = z.object({
  initiatingUserId: z.string().uuid().optional(),
  channel: z.string().trim().max(80).optional().default("codex"),
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

function scopedOwnerId(agent: AgentIdentity) {
  return agent.role === "ic" ? agent.userId : null;
}

function canUseOwner(agent: AgentIdentity, ownerId: string | null | undefined) {
  return agent.role !== "ic" || ownerId === agent.userId;
}

function rejectsImpersonation(agent: AgentIdentity, initiatingUserId?: string | null) {
  return Boolean(initiatingUserId && initiatingUserId !== agent.userId);
}

async function verifyMember(workspaceId: string, userId: string) {
  const [member] = await sql<{ id: string }[]>`
    SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
    WHERE u.id = ${userId} AND m.workspace_id = ${workspaceId} AND u.active = true
  `;
  return Boolean(member);
}

async function verifyEntity(
  workspaceId: string,
  entityType?: string | null,
  entityId?: string | null,
) {
  if (!entityType && !entityId) return true;
  if (!entityType || !entityId) return false;
  if (entityType === "account") {
    const [record] = await sql<{ id: string }[]>`
      SELECT id FROM accounts
      WHERE id = ${entityId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
    `;
    return Boolean(record);
  }
  if (entityType === "contact") {
    const [record] = await sql<{ id: string }[]>`
      SELECT id FROM contacts
      WHERE id = ${entityId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
    `;
    return Boolean(record);
  }
  if (entityType === "opportunity") {
    const [record] = await sql<{ id: string }[]>`
      SELECT id FROM opportunities
      WHERE id = ${entityId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
    `;
    return Boolean(record);
  }
  return true;
}

async function existingIdempotency(workspaceId: string, key: string | undefined) {
  if (!key) return false;
  const [existing] = await sql<{ id: string }[]>`
    SELECT id::text FROM audit_logs WHERE workspace_id = ${workspaceId} AND idempotency_key = ${key}
  `;
  return Boolean(existing);
}

export const agentRoutes = new Hono<{ Variables: AppVariables }>();
agentRoutes.use("*", agentAuth);
agentRoutes.use("*", requireAgentScope);

agentRoutes.get("/context", (context) => {
  const agent = context.get("agent");
  return context.json({
    product: "Orbit",
    authenticatedUser: {
      id: agent.userId,
      name: agent.userName,
      email: agent.userEmail,
      role: agent.role,
    },
    research: "https://app.notion.com/p/3b20e67ad25081f29e86d4a389d95231",
    workingIcp:
      "Product-led or hybrid B2B SaaS with 20–200 employees, frequent releases, lean product/customer teams, and visible release-to-adoption friction.",
    primaryWedge: "Release-to-adoption operations, beginning with onboarding and adoption.",
    roles: {
      founder: "Positioning, discovery, demos, pricing, content, and closing.",
      manager: "Lead execution, both approval gates, experiments, and day-to-day management.",
      ic: "Evidence-backed account research, buyer mapping, manual outreach, and follow-ups.",
    },
    gates: [
      "A researched account must be approved before any outbound activity.",
      "Campaigns, outreach drafts, demos, videos, and publishable content require Lead or founder approval.",
    ],
    launchEnvelope: {
      approvedAccounts: 160,
      relevantBuyers: 260,
      emails: 200,
      linkedinRequests: 200,
      followUpsAndCalls: 160,
      demosAndTeardowns: 4,
      youtubeVideos: 4,
    },
    constraints: [
      "Email and LinkedIn execution is manual in v1.",
      "One accountable owner per company; duplicates are blocked by domain, email, and LinkedIn URL.",
      "Agent mutations are audited and must never bypass human approvals.",
    ],
  });
});

agentRoutes.get("/members", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const members = await sql`
    SELECT u.id, u.name, u.email, m.role
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${agent.workspaceId} AND u.active = true
      AND (${ownerId}::uuid IS NULL OR u.id = ${ownerId})
    ORDER BY CASE m.role WHEN 'founder' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, m.joined_at
  `;
  return context.json({ members });
});

agentRoutes.get("/accounts", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const search = context.req.query("search")?.trim() ?? "";
  const status = context.req.query("status")?.trim() ?? "";
  const archived = context.req.query("archived") ?? "active";
  const limitResult = z.coerce
    .number()
    .int()
    .min(1)
    .max(250)
    .safeParse(context.req.query("limit") ?? 100);
  if (!limitResult.success) return context.json({ error: "limit must be between 1 and 250." }, 422);
  const accounts = await sql`
    SELECT a.id, a.name, a.domain, a.industry, a.linkedin_url, a.website_url, a.tier, a.status, a.score,
      a.owner_id, u.name AS owner_name, a.fit_summary, a.evidence_summary, a.trigger_summary,
      a.source_links, a.next_action, a.next_action_at, a.last_activity_at, a.archived_at,
      count(DISTINCT c.id)::int AS contacts
    FROM accounts a
    LEFT JOIN users u ON u.id = a.owner_id
    LEFT JOIN contacts c ON c.account_id = a.id
    WHERE a.workspace_id = ${agent.workspaceId}
      AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId})
      AND (${status} = '' OR a.status = ${status})
      AND (${search} = '' OR a.name ILIKE ${`%${search}%`} OR coalesce(a.domain, '') ILIKE ${`%${search}%`} OR coalesce(a.industry, '') ILIKE ${`%${search}%`})
      AND (${archived} = 'all'
        OR (${archived} = 'active' AND a.archived_at IS NULL)
        OR (${archived} = 'archived' AND a.archived_at IS NOT NULL))
    GROUP BY a.id, u.name
    ORDER BY a.updated_at DESC
    LIMIT ${limitResult.data}
  `;
  return context.json({ accounts });
});

agentRoutes.get("/tasks", async (context) => {
  const agent = context.get("agent");
  const requestedOwnerId = context.req.query("ownerId") || null;
  if (!canUseOwner(agent, requestedOwnerId ?? agent.userId)) {
    return context.json({ error: "You do not have permission to view this owner's tasks." }, 403);
  }
  const ownerId = scopedOwnerId(agent) ?? requestedOwnerId;
  const status = context.req.query("status") ?? "";
  const workstream = context.req.query("workstream") ?? "";
  const tasks = await sql`
    SELECT wi.*, u.name AS owner_name,
      coalesce(a.name, nullif(concat_ws(' ', c.first_name, c.last_name), ''), o.name) AS entity_name
    FROM work_items wi
    LEFT JOIN users u ON u.id = wi.owner_id
    LEFT JOIN accounts a ON wi.entity_type = 'account' AND a.id = wi.entity_id
    LEFT JOIN contacts c ON wi.entity_type = 'contact' AND c.id = wi.entity_id
    LEFT JOIN opportunities o ON wi.entity_type = 'opportunity' AND o.id = wi.entity_id
    WHERE wi.workspace_id = ${agent.workspaceId}
      AND (${ownerId}::uuid IS NULL OR wi.owner_id = ${ownerId})
      AND (${status} = '' OR wi.status = ${status})
      AND (${workstream} = '' OR wi.workstream = ${workstream})
    ORDER BY
      CASE wi.status WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'blocked' THEN 3
        WHEN 'review' THEN 4 WHEN 'backlog' THEN 5 ELSE 6 END,
      CASE wi.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      wi.due_at NULLS LAST, wi.created_at DESC
    LIMIT 250
  `;
  return context.json({ tasks });
});

agentRoutes.get("/tasks/:id", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const [task] = await sql`
    SELECT wi.*, u.name AS owner_name
    FROM work_items wi LEFT JOIN users u ON u.id = wi.owner_id
    WHERE wi.id = ${context.req.param("id")} AND wi.workspace_id = ${agent.workspaceId}
      AND (${ownerId}::uuid IS NULL OR wi.owner_id = ${ownerId})
  `;
  if (!task) return context.json({ error: "Task not found." }, 404);
  return context.json({ task });
});

agentRoutes.get("/campaigns", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const status = context.req.query("status") ?? "";
  const campaigns = await sql`
    SELECT c.*, u.name AS owner_name,
      count(DISTINCT a.id)::int AS assets,
      count(DISTINCT a.id) FILTER (WHERE a.status = 'pending_approval')::int AS assets_pending
    FROM campaigns c
    LEFT JOIN users u ON u.id = c.owner_id
    LEFT JOIN assets a ON a.campaign_id = c.id
    WHERE c.workspace_id = ${agent.workspaceId} AND (${status} = '' OR c.status = ${status})
      AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
    GROUP BY c.id, u.name
    ORDER BY c.updated_at DESC
    LIMIT 250
  `;
  return context.json({ campaigns });
});

agentRoutes.get("/campaigns/:id", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const id = context.req.param("id");
  const [campaign] = await sql`
    SELECT c.*, u.name AS owner_name
    FROM campaigns c LEFT JOIN users u ON u.id = c.owner_id
    WHERE c.id = ${id} AND c.workspace_id = ${agent.workspaceId}
      AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
  `;
  if (!campaign) return context.json({ error: "Campaign not found." }, 404);
  const [assets, approvals] = await Promise.all([
    sql`SELECT * FROM assets WHERE campaign_id = ${id} ORDER BY created_at`,
    sql`SELECT * FROM approvals WHERE subject_type = 'campaign' AND subject_id = ${id} ORDER BY requested_at DESC`,
  ]);
  return context.json({ campaign, assets, approvals });
});

agentRoutes.get("/status", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const [summary] = await sql<
    {
      openTasks: number;
      overdueTasks: number;
      pendingApprovals: number;
      activeAccounts: number;
      openOpportunities: number;
      activitiesToday: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM work_items WHERE workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId}) AND status NOT IN ('done', 'cancelled')) AS "openTasks",
      (SELECT count(*)::int FROM work_items WHERE workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId}) AND status NOT IN ('done', 'cancelled') AND due_at < now()) AS "overdueTasks",
      (SELECT count(*)::int FROM approvals WHERE workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR requested_by = ${ownerId}) AND status = 'pending') AS "pendingApprovals",
      (SELECT count(*)::int FROM accounts WHERE workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId}) AND status IN ('approved', 'active')) AS "activeAccounts",
      (SELECT count(*)::int FROM opportunities o JOIN opportunity_stages s ON s.id = o.stage_id
        WHERE o.workspace_id = ${agent.workspaceId} AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
          AND s.terminal = false) AS "openOpportunities",
      (SELECT count(*)::int FROM activities WHERE workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR actor_id = ${ownerId}) AND status = 'completed'
          AND occurred_at::date = current_date) AS "activitiesToday"
  `;
  const members = await sql`
    SELECT u.id, u.name, m.role,
      count(DISTINCT wi.id) FILTER (WHERE wi.status NOT IN ('done', 'cancelled'))::int AS open_tasks,
      count(DISTINCT wi.id) FILTER (WHERE wi.status NOT IN ('done', 'cancelled') AND wi.due_at < now())::int AS overdue_tasks
    FROM memberships m JOIN users u ON u.id = m.user_id
    LEFT JOIN work_items wi ON wi.owner_id = u.id AND wi.workspace_id = m.workspace_id
    WHERE m.workspace_id = ${agent.workspaceId} AND u.active = true
      AND (${ownerId}::uuid IS NULL OR u.id = ${ownerId})
    GROUP BY u.id, u.name, m.role, m.joined_at ORDER BY m.joined_at
  `;
  return context.json({ generatedAt: new Date().toISOString(), summary, members });
});

agentRoutes.get("/report", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const daysResult = z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .safeParse(context.req.query("days") ?? 7);
  if (!daysResult.success) return context.json({ error: "days must be between 1 and 90." }, 422);
  const days = daysResult.data;
  const [activityByOwner, pipeline, decisions, workload] = await Promise.all([
    sql`
      SELECT u.id AS owner_id, u.name AS owner_name, ac.type, count(*)::int AS completed
      FROM activities ac JOIN users u ON u.id = ac.actor_id
      WHERE ac.workspace_id = ${agent.workspaceId} AND ac.status = 'completed'
        AND (${ownerId}::uuid IS NULL OR ac.actor_id = ${ownerId})
        AND ac.occurred_at >= now() - ${days} * interval '1 day'
      GROUP BY u.id, u.name, ac.type ORDER BY u.name, ac.type
    `,
    sql`
      SELECT s.key, s.name, count(o.id)::int AS opportunities,
        coalesce(sum(o.value_amount), 0)::text AS value
      FROM opportunity_stages s LEFT JOIN opportunities o ON o.stage_id = s.id
      WHERE s.workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
      GROUP BY s.id ORDER BY s.position
    `,
    sql`
      SELECT status, count(*)::int AS decisions
      FROM approvals WHERE workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR requested_by = ${ownerId})
        AND decided_at >= now() - ${days} * interval '1 day'
      GROUP BY status ORDER BY status
    `,
    sql`
      SELECT u.id AS owner_id, u.name AS owner_name, m.role,
        count(wi.id) FILTER (WHERE wi.status NOT IN ('done', 'cancelled'))::int AS open_tasks,
        count(wi.id) FILTER (WHERE wi.status NOT IN ('done', 'cancelled') AND wi.due_at < now())::int AS overdue_tasks,
        count(wi.id) FILTER (WHERE wi.status = 'done' AND wi.completed_at >= now() - ${days} * interval '1 day')::int AS completed_tasks
      FROM memberships m JOIN users u ON u.id = m.user_id
      LEFT JOIN work_items wi ON wi.owner_id = u.id AND wi.workspace_id = m.workspace_id
      WHERE m.workspace_id = ${agent.workspaceId} AND u.active = true
        AND (${ownerId}::uuid IS NULL OR u.id = ${ownerId})
      GROUP BY u.id, u.name, m.role, m.joined_at ORDER BY m.joined_at
    `,
  ]);
  return context.json({
    generatedAt: new Date().toISOString(),
    days,
    activityByOwner,
    pipeline,
    decisions,
    workload,
  });
});

agentRoutes.get("/approvals", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const approvals = await sql`
    SELECT ap.id, ap.subject_type, ap.subject_id, ap.gate, ap.status, ap.requested_at,
      requester.name AS requested_by,
      coalesce(acc.name, cam.name, ast.title, 'Unknown subject') AS subject_title
    FROM approvals ap JOIN users requester ON requester.id = ap.requested_by
    LEFT JOIN accounts acc ON ap.subject_type = 'account' AND acc.id = ap.subject_id
    LEFT JOIN campaigns cam ON ap.subject_type = 'campaign' AND cam.id = ap.subject_id
    LEFT JOIN assets ast ON ap.subject_type = 'asset' AND ast.id = ap.subject_id
    WHERE ap.workspace_id = ${agent.workspaceId} AND ap.status = 'pending'
      AND (${ownerId}::uuid IS NULL OR ap.requested_by = ${ownerId})
    ORDER BY ap.requested_at LIMIT 100
  `;
  return context.json({ approvals });
});

agentRoutes.get("/search", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const query = context.req.query("q")?.trim() ?? "";
  if (query.length < 2)
    return context.json({ error: "q must contain at least two characters." }, 422);
  const pattern = `%${query}%`;
  const [accounts, contacts, tasks, campaigns, assets] = await Promise.all([
    sql`
      SELECT id, name, domain, industry, tier, status, owner_id FROM accounts
      WHERE workspace_id = ${agent.workspaceId} AND (name ILIKE ${pattern} OR coalesce(domain, '') ILIKE ${pattern} OR coalesce(industry, '') ILIKE ${pattern})
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
      ORDER BY updated_at DESC LIMIT 12
    `,
    sql`
      SELECT c.id, c.account_id, concat_ws(' ', c.first_name, c.last_name) AS name,
        c.title, c.email, c.status, a.name AS account_name
      FROM contacts c JOIN accounts a ON a.id = c.account_id
      WHERE c.workspace_id = ${agent.workspaceId}
        AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
        AND (concat_ws(' ', c.first_name, c.last_name) ILIKE ${pattern} OR coalesce(c.email, '') ILIKE ${pattern})
      ORDER BY c.updated_at DESC LIMIT 12
    `,
    sql`
      SELECT id, title, workstream, status, priority, owner_id, due_at FROM work_items
      WHERE workspace_id = ${agent.workspaceId} AND (title ILIKE ${pattern} OR coalesce(description, '') ILIKE ${pattern})
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
      ORDER BY updated_at DESC LIMIT 12
    `,
    sql`
      SELECT id, name, status, owner_id FROM campaigns
      WHERE workspace_id = ${agent.workspaceId} AND name ILIKE ${pattern}
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
      ORDER BY updated_at DESC LIMIT 12
    `,
    sql`
      SELECT id, title, type, status, owner_id, due_at FROM assets
      WHERE workspace_id = ${agent.workspaceId} AND title ILIKE ${pattern}
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId} OR status = 'approved')
      ORDER BY updated_at DESC LIMIT 12
    `,
  ]);
  return context.json({ accounts, contacts, tasks, campaigns, assets });
});

agentRoutes.get("/backlog", async (context) => {
  const agent = context.get("agent");
  const requestedOwnerId = context.req.query("ownerId") || null;
  if (!canUseOwner(agent, requestedOwnerId ?? agent.userId)) {
    return context.json({ error: "You do not have permission to view this owner's backlog." }, 403);
  }
  const ownerId = scopedOwnerId(agent) ?? requestedOwnerId;
  const backlog = await sql`
    SELECT wi.id, wi.title, wi.description, wi.workstream, wi.kind, wi.status, wi.priority,
      wi.due_at, wi.blocked_reason, u.name AS owner_name
    FROM work_items wi LEFT JOIN users u ON u.id = wi.owner_id
    WHERE wi.workspace_id = ${agent.workspaceId} AND wi.status NOT IN ('done', 'cancelled')
      AND (${ownerId}::uuid IS NULL OR wi.owner_id = ${ownerId})
    ORDER BY
      CASE WHEN wi.due_at < now() THEN 0 ELSE 1 END,
      CASE wi.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      wi.due_at NULLS LAST LIMIT 100
  `;
  return context.json({ backlog });
});

agentRoutes.get("/accounts/:id", async (context) => {
  const agent = context.get("agent");
  const ownerId = scopedOwnerId(agent);
  const id = context.req.param("id");
  const [account] =
    await sql`SELECT * FROM accounts WHERE id = ${id} AND workspace_id = ${agent.workspaceId}
      AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})`;
  if (!account) return context.json({ error: "Account not found." }, 404);
  const [contacts, activities, opportunities, tasks] = await Promise.all([
    sql`SELECT * FROM contacts WHERE account_id = ${id} ORDER BY created_at`,
    sql`SELECT * FROM activities WHERE account_id = ${id} ORDER BY coalesce(occurred_at, due_at, created_at) DESC LIMIT 100`,
    sql`SELECT o.*, s.name AS stage_name FROM opportunities o JOIN opportunity_stages s ON s.id = o.stage_id WHERE o.account_id = ${id}`,
    sql`SELECT * FROM work_items WHERE entity_type = 'account' AND entity_id = ${id} AND status NOT IN ('done', 'cancelled')`,
  ]);
  return context.json({ account, contacts, activities, opportunities, tasks });
});

agentRoutes.patch("/accounts/:id", async (context) => {
  const agent = context.get("agent");
  const id = context.req.param("id");
  const parsed = await parseJson(context, accountUpdateInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  const [current] = await sql<any[]>`
    SELECT * FROM accounts WHERE id = ${id} AND workspace_id = ${agent.workspaceId}
      AND (${scopedOwnerId(agent)}::uuid IS NULL OR owner_id = ${agent.userId})
  `;
  if (!current) return context.json({ error: "Account not found." }, 404);
  if (parsed.data.ownerId && !(await verifyMember(agent.workspaceId, parsed.data.ownerId))) {
    return context.json({ error: "Owner is not a workspace member." }, 422);
  }
  if (parsed.data.ownerId && !canUseOwner(agent, parsed.data.ownerId)) {
    return context.json({ error: "You do not have permission to reassign this account." }, 403);
  }
  if (
    parsed.data.status &&
    ["active", "nurture"].includes(parsed.data.status) &&
    !current.approved_at
  ) {
    return context.json({ error: "The account must be human-approved before activation." }, 422);
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey)) {
    return context.json({ ok: true, replayed: true });
  }
  try {
    await sql`
      UPDATE accounts SET
        name = ${parsed.data.name ?? current.name},
        domain = ${parsed.data.domain !== undefined ? parsed.data.domain || null : current.domain},
        normalized_domain = ${parsed.data.domain !== undefined ? normalizeDomain(parsed.data.domain) : current.normalized_domain},
        linkedin_url = ${parsed.data.linkedinUrl !== undefined ? parsed.data.linkedinUrl || null : current.linkedin_url},
        normalized_linkedin_url = ${parsed.data.linkedinUrl !== undefined ? normalizeLinkedInUrl(parsed.data.linkedinUrl) : current.normalized_linkedin_url},
        website_url = ${parsed.data.websiteUrl !== undefined ? parsed.data.websiteUrl || null : current.website_url},
        owner_id = ${parsed.data.ownerId ?? current.owner_id},
        tier = ${parsed.data.tier ?? current.tier},
        status = ${parsed.data.status ?? current.status},
        country = ${parsed.data.country !== undefined ? parsed.data.country || null : current.country},
        state = ${parsed.data.state !== undefined ? parsed.data.state || null : current.state},
        city = ${parsed.data.city !== undefined ? parsed.data.city || null : current.city},
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
      WHERE id = ${id} AND workspace_id = ${agent.workspaceId}
    `;
    await audit({
      workspaceId: agent.workspaceId,
      actorUserId: agent.userId,
      actorType: "agent",
      actorLabel: agent.label,
      action: "agent.account_updated",
      entityType: "account",
      entityId: id,
      channel: parsed.data.channel,
      summary: { ownerId: parsed.data.ownerId, status: parsed.data.status },
      idempotencyKey,
    });
    return context.json({ ok: true });
  } catch (error) {
    return databaseError(context, error);
  }
});

agentRoutes.post("/accounts/:id/submit", async (context) => {
  const agent = context.get("agent");
  const id = context.req.param("id");
  const parsed = await parseJson(context, submissionInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  const [account] = await sql<
    {
      status: string;
      archivedAt: string | null;
      evidenceSummary: string | null;
      triggerSummary: string | null;
      sourceLinks: string[];
      contacts: number;
    }[]
  >`
    SELECT a.status, a.archived_at AS "archivedAt", a.evidence_summary AS "evidenceSummary",
      a.trigger_summary AS "triggerSummary", a.source_links AS "sourceLinks",
      count(c.id)::int AS contacts
    FROM accounts a LEFT JOIN contacts c ON c.account_id = a.id
    WHERE a.id = ${id} AND a.workspace_id = ${agent.workspaceId}
      AND (${scopedOwnerId(agent)}::uuid IS NULL OR a.owner_id = ${agent.userId})
    GROUP BY a.id
  `;
  if (!account) return context.json({ error: "Account not found." }, 404);
  if (account.archivedAt)
    return context.json({ error: "Restore this account before submitting it." }, 409);
  if (account.status === "pending_approval") {
    return context.json({ error: "This account is already waiting for approval." }, 409);
  }
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
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey)) {
    return context.json({ ok: true, replayed: true });
  }
  const [approval] = await sql.begin(async (transaction) => {
    await transaction`UPDATE accounts SET status = 'pending_approval' WHERE id = ${id}`;
    return transaction<{ id: string }[]>`
      INSERT INTO approvals (workspace_id, subject_type, subject_id, gate, requested_by)
      VALUES (${agent.workspaceId}, 'account', ${id}, 'lead', ${agent.userId})
      RETURNING id
    `;
  });
  await audit({
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.account_submitted",
    entityType: "account",
    entityId: id,
    channel: parsed.data.channel,
    idempotencyKey,
  });
  return context.json({ approvalId: approval.id }, 201);
});

for (const action of ["archive", "restore"] as const) {
  agentRoutes.post(`/accounts/:id/${action}`, async (context) => {
    const agent = context.get("agent");
    const parsed = await parseJson(context, submissionInput);
    if (!parsed.ok) return parsed.response;
    if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
      return context.json({ error: "An API key can only act as its authenticated user." }, 403);
    }
    const [account] = await sql<{ id: string }[]>`
      UPDATE accounts SET archived_at = ${action === "archive" ? new Date().toISOString() : null}
      WHERE id = ${context.req.param("id")} AND workspace_id = ${agent.workspaceId}
        AND (${scopedOwnerId(agent)}::uuid IS NULL OR owner_id = ${agent.userId})
      RETURNING id
    `;
    if (!account) return context.json({ error: "Account not found." }, 404);
    await audit({
      workspaceId: agent.workspaceId,
      actorUserId: agent.userId,
      actorType: "agent",
      actorLabel: agent.label,
      action: `agent.account_${action}d`,
      entityType: "account",
      entityId: account.id,
      channel: parsed.data.channel,
    });
    return context.json({ ok: true });
  });
}

agentRoutes.post("/create-account", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, accountInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  if (!(await verifyMember(agent.workspaceId, parsed.data.ownerId)))
    return context.json({ error: "Owner is not a workspace member." }, 422);
  if (!canUseOwner(agent, parsed.data.ownerId)) {
    return context.json(
      { error: "You do not have permission to create an account for this owner." },
      403,
    );
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey))
    return context.json({ ok: true, replayed: true });

  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (
        workspace_id, name, domain, normalized_domain, linkedin_url, normalized_linkedin_url,
        website_url, owner_id, tier, country, state, city, employee_range, industry, product_motion, source, fit_summary,
        evidence_summary, trigger_summary, source_links, score, next_action, next_action_at, created_by
      ) VALUES (
        ${agent.workspaceId}, ${parsed.data.name}, ${parsed.data.domain || null}, ${normalizeDomain(parsed.data.domain)},
        ${parsed.data.linkedinUrl || null}, ${normalizeLinkedInUrl(parsed.data.linkedinUrl)},
        ${parsed.data.websiteUrl || null}, ${parsed.data.ownerId}, ${parsed.data.tier}, ${parsed.data.country || null}, ${parsed.data.state || null}, ${parsed.data.city || null},
        ${parsed.data.employeeRange || null}, ${parsed.data.industry || null}, ${parsed.data.productMotion || null}, ${parsed.data.source || null},
        ${parsed.data.fitSummary || null}, ${parsed.data.evidenceSummary || null}, ${parsed.data.triggerSummary || null},
        ${sql.json(parsed.data.sourceLinks)}, ${parsed.data.score}, ${parsed.data.nextAction || null},
        ${parsed.data.nextActionAt ?? null}, ${agent.userId}
      ) RETURNING id
    `;
    await audit({
      workspaceId: agent.workspaceId,
      actorUserId: agent.userId,
      actorType: "agent",
      actorLabel: agent.label,
      action: "agent.account_created",
      entityType: "account",
      entityId: account.id,
      channel: parsed.data.channel,
      summary: { ownerId: parsed.data.ownerId, tier: parsed.data.tier },
      idempotencyKey,
    });
    return context.json({ id: account.id, status: "research" }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

agentRoutes.post("/create-task", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, taskInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  if (!(await verifyMember(agent.workspaceId, parsed.data.ownerId)))
    return context.json({ error: "Owner is not a workspace member." }, 422);
  if (!canUseOwner(agent, parsed.data.ownerId)) {
    return context.json(
      { error: "You do not have permission to create a task for this owner." },
      403,
    );
  }
  if (
    !(await verifyEntity(
      agent.workspaceId,
      parsed.data.entityType ?? null,
      parsed.data.entityId ?? null,
    ))
  ) {
    return context.json({ error: "Related CRM record was not found." }, 422);
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey))
    return context.json({ ok: true, replayed: true });
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO work_items (
      workspace_id, owner_id, created_by, workstream, kind, title, description, status,
      priority, entity_type, entity_id, due_at
    ) VALUES (
      ${agent.workspaceId}, ${parsed.data.ownerId}, ${agent.userId}, ${parsed.data.workstream},
      ${parsed.data.kind}, ${parsed.data.title}, ${parsed.data.description || null}, 'ready', ${parsed.data.priority},
      ${parsed.data.entityType ?? null}, ${parsed.data.entityId ?? null}, ${parsed.data.dueAt ?? null}
    ) RETURNING id
  `;
  await audit({
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.task_created",
    entityType: "task",
    entityId: task.id,
    channel: parsed.data.channel,
    summary: { ownerId: parsed.data.ownerId, workstream: parsed.data.workstream },
    idempotencyKey,
  });
  return context.json({ id: task.id }, 201);
});

agentRoutes.patch("/tasks/:id", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, taskUpdateInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  const [current] = await sql<any[]>`
    SELECT * FROM work_items
    WHERE id = ${context.req.param("id")} AND workspace_id = ${agent.workspaceId}
      AND (${scopedOwnerId(agent)}::uuid IS NULL OR owner_id = ${agent.userId})
  `;
  if (!current) return context.json({ error: "Task not found." }, 404);
  if (parsed.data.ownerId && !(await verifyMember(agent.workspaceId, parsed.data.ownerId))) {
    return context.json({ error: "Owner is not a workspace member." }, 422);
  }
  if (parsed.data.ownerId && !canUseOwner(agent, parsed.data.ownerId)) {
    return context.json({ error: "You do not have permission to reassign this task." }, 403);
  }
  const entityType =
    parsed.data.entityType !== undefined ? parsed.data.entityType : current.entity_type;
  const entityId = parsed.data.entityId !== undefined ? parsed.data.entityId : current.entity_id;
  if (!(await verifyEntity(agent.workspaceId, entityType, entityId))) {
    return context.json({ error: "Related CRM record was not found." }, 422);
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey)) {
    return context.json({ ok: true, replayed: true });
  }
  const nextStatus = parsed.data.status ?? current.status;
  const now = new Date().toISOString();
  let nextCompletedAt = current.completed_at;
  if (nextStatus !== "done") nextCompletedAt = null;
  else if (current.status !== "done") nextCompletedAt = now;
  await sql`
    UPDATE work_items SET
      owner_id = ${parsed.data.ownerId ?? current.owner_id},
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
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.task_updated",
    entityType: "task",
    entityId: current.id,
    channel: parsed.data.channel,
    summary: { ownerId: parsed.data.ownerId, status: nextStatus },
    idempotencyKey,
  });
  return context.json({ ok: true });
});

agentRoutes.post("/assign", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, assignmentInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  if (!(await verifyMember(agent.workspaceId, parsed.data.ownerId)))
    return context.json({ error: "Owner is not a workspace member." }, 422);
  if (!canUseOwner(agent, parsed.data.ownerId)) {
    return context.json({ error: "You do not have permission to reassign this task." }, 403);
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey))
    return context.json({ ok: true, replayed: true });
  const [task] = await sql<{ id: string }[]>`
    UPDATE work_items SET owner_id = ${parsed.data.ownerId}
    WHERE id = ${parsed.data.taskId} AND workspace_id = ${agent.workspaceId}
      AND (${scopedOwnerId(agent)}::uuid IS NULL OR owner_id = ${agent.userId})
    RETURNING id
  `;
  if (!task) return context.json({ error: "Task not found." }, 404);
  await audit({
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.task_assigned",
    entityType: "task",
    entityId: task.id,
    channel: parsed.data.channel,
    summary: { ownerId: parsed.data.ownerId },
    idempotencyKey,
  });
  return context.json({ ok: true });
});

agentRoutes.post("/log-activity", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, activityInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  if (!(await verifyMember(agent.workspaceId, parsed.data.actorId)))
    return context.json({ error: "Actor is not a workspace member." }, 422);
  if (!canUseOwner(agent, parsed.data.actorId)) {
    return context.json(
      { error: "You do not have permission to log activity for this user." },
      403,
    );
  }
  const isOutreach = outreachActivityTypes.has(parsed.data.type);
  if (isOutreach && !parsed.data.accountId)
    return context.json({ error: "Outbound activity must be linked to an approved account." }, 422);
  if (parsed.data.accountId) {
    const [account] = await sql<{ status: string }[]>`
      SELECT status FROM accounts
      WHERE id = ${parsed.data.accountId} AND workspace_id = ${agent.workspaceId}
        AND (${scopedOwnerId(agent)}::uuid IS NULL OR owner_id = ${agent.userId})
    `;
    if (!account) return context.json({ error: "Account not found." }, 404);
    if (isOutreach && !["approved", "active", "nurture"].includes(account.status)) {
      return context.json(
        { error: "Lead approval is required before outbound activity can be logged." },
        422,
      );
    }
  }
  if (parsed.data.contactId) {
    const [contact] = await sql<{ id: string }[]>`
      SELECT id FROM contacts
      WHERE id = ${parsed.data.contactId} AND workspace_id = ${agent.workspaceId}
        AND (${parsed.data.accountId ?? null}::uuid IS NULL OR account_id = ${parsed.data.accountId ?? null})
    `;
    if (!contact) return context.json({ error: "Contact not found for this account." }, 404);
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey))
    return context.json({ ok: true, replayed: true });
  const occurredAt =
    parsed.data.status === "completed"
      ? (parsed.data.occurredAt ?? new Date().toISOString())
      : null;
  const [activity] = await sql<{ id: string }[]>`
    INSERT INTO activities (
      workspace_id, account_id, contact_id, actor_id, type, status, outcome, details, occurred_at, due_at
    ) VALUES (
      ${agent.workspaceId}, ${parsed.data.accountId ?? null}, ${parsed.data.contactId ?? null}, ${parsed.data.actorId},
      ${parsed.data.type}, ${parsed.data.status}, ${parsed.data.outcome || null}, ${parsed.data.details || null},
      ${occurredAt}, ${parsed.data.dueAt ?? null}
    ) RETURNING id
  `;
  if (parsed.data.accountId && occurredAt)
    await sql`UPDATE accounts SET last_activity_at = ${occurredAt} WHERE id = ${parsed.data.accountId}`;
  await audit({
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.activity_logged",
    entityType: "activity",
    entityId: activity.id,
    channel: parsed.data.channel,
    summary: { actorId: parsed.data.actorId, type: parsed.data.type },
    idempotencyKey,
  });
  return context.json({ id: activity.id }, 201);
});

agentRoutes.post("/campaigns", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, campaignInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  if (!(await verifyMember(agent.workspaceId, parsed.data.ownerId))) {
    return context.json({ error: "Owner is not a workspace member." }, 422);
  }
  if (!canUseOwner(agent, parsed.data.ownerId)) {
    return context.json(
      { error: "You do not have permission to create a campaign for this owner." },
      403,
    );
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey)) {
    return context.json({ ok: true, replayed: true });
  }
  const [campaign] = await sql<{ id: string }[]>`
    INSERT INTO campaigns (
      workspace_id, name, owner_id, segment, hypothesis, value_proposition, channels,
      success_metric, start_at, end_at, created_by
    ) VALUES (
      ${agent.workspaceId}, ${parsed.data.name}, ${parsed.data.ownerId},
      ${parsed.data.segment || null}, ${parsed.data.hypothesis || null},
      ${parsed.data.valueProposition || null}, ${parsed.data.channels},
      ${parsed.data.successMetric || null}, ${parsed.data.startAt ?? null},
      ${parsed.data.endAt ?? null}, ${agent.userId}
    ) RETURNING id
  `;
  await audit({
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.campaign_created",
    entityType: "campaign",
    entityId: campaign.id,
    channel: parsed.data.channel,
    summary: { ownerId: parsed.data.ownerId },
    idempotencyKey,
  });
  return context.json({ id: campaign.id, status: "draft" }, 201);
});

agentRoutes.patch("/campaigns/:id", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, campaignUpdateInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  const [current] = await sql<any[]>`
    SELECT * FROM campaigns
    WHERE id = ${context.req.param("id")} AND workspace_id = ${agent.workspaceId}
      AND (${scopedOwnerId(agent)}::uuid IS NULL OR owner_id = ${agent.userId})
  `;
  if (!current) return context.json({ error: "Campaign not found." }, 404);
  if (parsed.data.ownerId && !(await verifyMember(agent.workspaceId, parsed.data.ownerId))) {
    return context.json({ error: "Owner is not a workspace member." }, 422);
  }
  if (parsed.data.ownerId && !canUseOwner(agent, parsed.data.ownerId)) {
    return context.json({ error: "You do not have permission to reassign this campaign." }, 403);
  }
  if (
    parsed.data.status === "active" &&
    (!current.approved_at || !["approved", "active", "paused"].includes(current.status))
  ) {
    return context.json({ error: "A campaign must be human-approved before activation." }, 422);
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
      {
        error: "Approved campaign content is locked. Create a new draft for material changes.",
      },
      409,
    );
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey)) {
    return context.json({ ok: true, replayed: true });
  }
  await sql`
    UPDATE campaigns SET
      name = ${parsed.data.name ?? current.name},
      owner_id = ${parsed.data.ownerId ?? current.owner_id},
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
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.campaign_updated",
    entityType: "campaign",
    entityId: current.id,
    channel: parsed.data.channel,
    summary: { ownerId: parsed.data.ownerId, status: parsed.data.status },
    idempotencyKey,
  });
  return context.json({ ok: true });
});

agentRoutes.post("/campaigns/:id/submit", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, submissionInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  const [campaign] = await sql<any[]>`
    SELECT * FROM campaigns
    WHERE id = ${context.req.param("id")} AND workspace_id = ${agent.workspaceId}
      AND (${scopedOwnerId(agent)}::uuid IS NULL OR owner_id = ${agent.userId})
  `;
  if (!campaign) return context.json({ error: "Campaign not found." }, 404);
  if (campaign.status === "pending_approval") {
    return context.json({ error: "This campaign is already waiting for approval." }, 409);
  }
  if (["approved", "active", "paused", "complete"].includes(campaign.status)) {
    return context.json({ error: "This campaign has already passed approval." }, 409);
  }
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
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey)) {
    return context.json({ ok: true, replayed: true });
  }
  const [approval] = await sql.begin(async (transaction) => {
    await transaction`UPDATE campaigns SET status = 'pending_approval' WHERE id = ${campaign.id}`;
    return transaction<{ id: string }[]>`
      INSERT INTO approvals (workspace_id, subject_type, subject_id, gate, requested_by)
      VALUES (
        ${agent.workspaceId}, 'campaign', ${campaign.id}, 'campaign_asset',
        ${agent.userId}
      ) RETURNING id
    `;
  });
  await audit({
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.campaign_submitted",
    entityType: "campaign",
    entityId: campaign.id,
    channel: parsed.data.channel,
    idempotencyKey,
  });
  return context.json({ approvalId: approval.id }, 201);
});

agentRoutes.post("/draft", async (context) => {
  const agent = context.get("agent");
  const parsed = await parseJson(context, draftInput);
  if (!parsed.ok) return parsed.response;
  if (rejectsImpersonation(agent, parsed.data.initiatingUserId)) {
    return context.json({ error: "An API key can only act as its authenticated user." }, 403);
  }
  if (!(await verifyMember(agent.workspaceId, parsed.data.ownerId)))
    return context.json({ error: "Owner is not a workspace member." }, 422);
  if (!canUseOwner(agent, parsed.data.ownerId)) {
    return context.json(
      { error: "You do not have permission to create a draft for this owner." },
      403,
    );
  }
  const idempotencyKey = context.req.header("idempotency-key");
  if (await existingIdempotency(agent.workspaceId, idempotencyKey))
    return context.json({ ok: true, replayed: true });
  const initialStatus = parsed.data.body ? "draft" : parsed.data.brief ? "brief" : "idea";
  const [asset] = await sql<{ id: string }[]>`
    INSERT INTO assets (
      workspace_id, campaign_id, owner_id, type, title, status, use_case, brief, body, due_at, created_by
    ) VALUES (
      ${agent.workspaceId}, ${parsed.data.campaignId ?? null}, ${parsed.data.ownerId}, ${parsed.data.type},
      ${parsed.data.title}, ${initialStatus}, ${parsed.data.useCase || null}, ${parsed.data.brief || null}, ${parsed.data.body || null},
      ${parsed.data.dueAt ?? null}, ${agent.userId}
    ) RETURNING id
  `;
  await audit({
    workspaceId: agent.workspaceId,
    actorUserId: agent.userId,
    actorType: "agent",
    actorLabel: agent.label,
    action: "agent.draft_created",
    entityType: "asset",
    entityId: asset.id,
    channel: parsed.data.channel,
    summary: { ownerId: parsed.data.ownerId, type: parsed.data.type },
    idempotencyKey,
  });
  return context.json({ id: asset.id, status: initialStatus }, 201);
});
