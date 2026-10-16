import { Hono } from "hono";
import { z } from "zod";

import { audit, requireAuth, requireRole } from "./auth.js";
import { seedGoalsForMember } from "./bootstrap.js";
import { sql } from "./db.js";
import { parseJson } from "./http.js";
import type { AppVariables } from "./types.js";

const dailyUpdateSchema = z.object({
  moved: z.string().trim().min(1).max(4000),
  stuck: z.string().trim().max(4000).optional().default(""),
  learned: z.string().trim().max(4000).optional().default(""),
  tomorrow: z.string().trim().min(1).max(4000),
});

const goalUpdateSchema = z.object({
  target: z.number().nonnegative(),
});

function scopeOwner(user: { role: string; id: string }) {
  return user.role === "ic" ? user.id : null;
}

export const workspaceRoutes = new Hono<{ Variables: AppVariables }>();
workspaceRoutes.use("*", requireAuth);

workspaceRoutes.get("/dashboard", async (context) => {
  const user = context.get("user");
  const ownerId = scopeOwner(user);

  const [
    taskSummary,
    accountSummary,
    activitySummary,
    approvals,
    pipeline,
    work,
    attention,
    goals,
  ] = await Promise.all([
    sql<{ open: number; overdue: number; dueToday: number; doneThisWeek: number }[]>`
        SELECT
          count(*) FILTER (WHERE status NOT IN ('done', 'cancelled'))::int AS open,
          count(*) FILTER (WHERE status NOT IN ('done', 'cancelled') AND due_at < now())::int AS overdue,
          count(*) FILTER (WHERE status NOT IN ('done', 'cancelled') AND due_at::date = current_date)::int AS "dueToday",
          count(*) FILTER (WHERE status = 'done' AND completed_at >= date_trunc('week', now()))::int AS "doneThisWeek"
        FROM work_items
        WHERE workspace_id = ${user.workspaceId}
          AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
      `,
    sql<{ total: number; pending: number; approved: number; active: number; tierA: number }[]>`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'pending_approval')::int AS pending,
          count(*) FILTER (WHERE status = 'approved')::int AS approved,
          count(*) FILTER (WHERE status = 'active')::int AS active,
          count(*) FILTER (WHERE tier = 'A')::int AS "tierA"
        FROM accounts
        WHERE workspace_id = ${user.workspaceId}
          AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
      `,
    sql<{ today: number; thisWeek: number; planned: number }[]>`
        SELECT
          count(*) FILTER (WHERE status = 'completed' AND occurred_at::date = current_date)::int AS today,
          count(*) FILTER (WHERE status = 'completed' AND occurred_at >= date_trunc('week', now()))::int AS "thisWeek",
          count(*) FILTER (WHERE status = 'planned' AND due_at <= now() + interval '7 days')::int AS planned
        FROM activities
        WHERE workspace_id = ${user.workspaceId}
          AND (${ownerId}::uuid IS NULL OR actor_id = ${ownerId})
      `,
    sql<{ pending: number }[]>`
        SELECT count(*)::int AS pending
        FROM approvals
        WHERE workspace_id = ${user.workspaceId} AND status = 'pending'
          AND (${ownerId}::uuid IS NULL OR requested_by = ${ownerId})
      `,
    sql<{ key: string; name: string; count: number; value: string }[]>`
        SELECT s.key, s.name, count(o.id)::int AS count,
          coalesce(sum(o.value_amount), 0)::text AS value
        FROM opportunity_stages s
        LEFT JOIN opportunities o ON o.stage_id = s.id
          AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
        WHERE s.workspace_id = ${user.workspaceId}
        GROUP BY s.id, s.key, s.name, s.position
        ORDER BY s.position
      `,
    sql<
      {
        id: string;
        title: string;
        workstream: string;
        status: string;
        priority: string;
        dueAt: string | null;
        ownerName: string | null;
      }[]
    >`
        SELECT wi.id, wi.title, wi.workstream, wi.status, wi.priority, wi.due_at AS "dueAt", u.name AS "ownerName"
        FROM work_items wi
        LEFT JOIN users u ON u.id = wi.owner_id
        WHERE wi.workspace_id = ${user.workspaceId}
          AND wi.status NOT IN ('done', 'cancelled')
          AND (${ownerId}::uuid IS NULL OR wi.owner_id = ${ownerId})
        ORDER BY
          CASE wi.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          wi.due_at NULLS LAST, wi.created_at
        LIMIT 8
      `,
    sql<
      {
        type: string;
        id: string;
        title: string;
        detail: string;
        dueAt: string | null;
        ownerName: string | null;
      }[]
    >`
        SELECT * FROM (
          SELECT 'task'::text AS type, wi.id, wi.title,
            CASE WHEN wi.status = 'blocked' THEN coalesce(wi.blocked_reason, 'Blocked') ELSE 'Overdue work' END AS detail,
            wi.due_at AS "dueAt", u.name AS "ownerName", wi.created_at AS sort_at
          FROM work_items wi
          LEFT JOIN users u ON u.id = wi.owner_id
          WHERE wi.workspace_id = ${user.workspaceId}
            AND wi.status NOT IN ('done', 'cancelled')
            AND (wi.due_at < now() OR wi.status = 'blocked')
            AND (${ownerId}::uuid IS NULL OR wi.owner_id = ${ownerId})
          UNION ALL
          SELECT 'account'::text AS type, a.id, a.name AS title,
            'No next action is scheduled' AS detail, a.next_action_at AS "dueAt", u.name AS "ownerName", a.created_at AS sort_at
          FROM accounts a
          LEFT JOIN users u ON u.id = a.owner_id
          WHERE a.workspace_id = ${user.workspaceId}
            AND a.status IN ('approved', 'active') AND a.next_action_at IS NULL
            AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId})
        ) attention_items
        ORDER BY "dueAt" NULLS LAST, sort_at
        LIMIT 8
      `,
    sql<
      {
        id: string;
        metric: string;
        label: string;
        target: string;
        ownerId: string | null;
        ownerName: string | null;
        periodStart: string;
        periodEnd: string;
      }[]
    >`
        SELECT g.id, g.metric, g.label, g.target::text, g.owner_id AS "ownerId", u.name AS "ownerName",
          g.period_start::text AS "periodStart", g.period_end::text AS "periodEnd"
        FROM goals g
        LEFT JOIN users u ON u.id = g.owner_id
        WHERE g.workspace_id = ${user.workspaceId}
          AND current_date BETWEEN g.period_start AND g.period_end
          AND (${ownerId}::uuid IS NULL OR g.owner_id = ${ownerId})
        ORDER BY u.name NULLS FIRST, g.created_at
      `,
  ]);

  const actualRows = await sql<{ ownerId: string; metric: string; actual: number }[]>`
    WITH member_metrics AS (
      SELECT a.owner_id AS owner_id, 'qualified_accounts'::text AS metric,
        count(*) FILTER (WHERE a.status IN ('approved', 'active', 'nurture'))::int AS actual
      FROM accounts a WHERE a.workspace_id = ${user.workspaceId} GROUP BY a.owner_id
      UNION ALL
      SELECT c.owner_id, 'relevant_buyers', count(*)::int FROM contacts c
      WHERE c.workspace_id = ${user.workspaceId} GROUP BY c.owner_id
      UNION ALL
      SELECT ac.actor_id, CASE ac.type
        WHEN 'email' THEN 'emails'
        WHEN 'linkedin_request' THEN 'linkedin_requests'
        WHEN 'meeting' THEN 'meetings'
        WHEN 'demo' THEN 'demos'
        WHEN 'teardown' THEN 'demos'
        ELSE 'follow_ups' END,
        count(*)::int
      FROM activities ac
      WHERE ac.workspace_id = ${user.workspaceId} AND ac.status = 'completed'
        AND ac.type IN ('email', 'linkedin_request', 'follow_up', 'call', 'meeting', 'demo', 'teardown')
        AND ac.created_at >= now() - interval '31 days'
      GROUP BY ac.actor_id, CASE ac.type
        WHEN 'email' THEN 'emails'
        WHEN 'linkedin_request' THEN 'linkedin_requests'
        WHEN 'meeting' THEN 'meetings'
        WHEN 'demo' THEN 'demos'
        WHEN 'teardown' THEN 'demos'
        ELSE 'follow_ups' END
      UNION ALL
      SELECT ac.actor_id, 'conversations', count(*)::int FROM activities ac
      WHERE ac.workspace_id = ${user.workspaceId} AND ac.status = 'completed'
        AND ac.outcome = 'substantive_conversation' AND ac.created_at >= now() - interval '31 days'
      GROUP BY ac.actor_id
      UNION ALL
      SELECT o.owner_id, 'sqls', count(*)::int FROM opportunities o
      JOIN opportunity_stages s ON s.id = o.stage_id
      WHERE o.workspace_id = ${user.workspaceId} AND s.position >= 4 AND s.key <> 'lost'
      GROUP BY o.owner_id
      UNION ALL
      SELECT o.owner_id, 'saos', count(*)::int FROM opportunities o
      JOIN opportunity_stages s ON s.id = o.stage_id
      WHERE o.workspace_id = ${user.workspaceId} AND s.position >= 5 AND s.key <> 'lost'
      GROUP BY o.owner_id
      UNION ALL
      SELECT o.owner_id, 'customers', count(*)::int FROM opportunities o
      JOIN opportunity_stages s ON s.id = o.stage_id
      WHERE o.workspace_id = ${user.workspaceId} AND s.won = true GROUP BY o.owner_id
    )
    SELECT owner_id AS "ownerId", metric, sum(actual)::int AS actual
    FROM member_metrics WHERE owner_id IS NOT NULL GROUP BY owner_id, metric
  `;
  const actuals = new Map(actualRows.map((row) => [`${row.ownerId}:${row.metric}`, row.actual]));

  return context.json({
    scope: ownerId ? "personal" : "team",
    summaries: {
      tasks: taskSummary[0],
      accounts: accountSummary[0],
      activities: activitySummary[0],
      approvals: approvals[0],
    },
    pipeline,
    work,
    attention,
    goals: goals.map((goal) => ({
      ...goal,
      target: Number(goal.target),
      actual: goal.ownerId ? (actuals.get(`${goal.ownerId}:${goal.metric}`) ?? 0) : 0,
    })),
  });
});

workspaceRoutes.get("/team", async (context) => {
  const user = context.get("user");
  if (user.role === "ic") {
    return context.json({
      members: [{ id: user.id, name: user.name, email: user.email, role: user.role }],
    });
  }
  const members = await sql<
    {
      id: string;
      name: string;
      email: string;
      role: string;
      openTasks: number;
      overdueTasks: number;
      accounts: number;
    }[]
  >`
    SELECT u.id, u.name, u.email, m.role,
      count(DISTINCT wi.id) FILTER (WHERE wi.status NOT IN ('done', 'cancelled'))::int AS "openTasks",
      count(DISTINCT wi.id) FILTER (WHERE wi.status NOT IN ('done', 'cancelled') AND wi.due_at < now())::int AS "overdueTasks",
      count(DISTINCT a.id)::int AS accounts
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN work_items wi ON wi.owner_id = u.id AND wi.workspace_id = m.workspace_id
    LEFT JOIN accounts a ON a.owner_id = u.id AND a.workspace_id = m.workspace_id
    WHERE m.workspace_id = ${user.workspaceId} AND u.active = true
    GROUP BY u.id, u.name, u.email, m.role, m.joined_at
    ORDER BY CASE m.role WHEN 'founder' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, m.joined_at
  `;
  return context.json({ members });
});

workspaceRoutes.get("/updates", async (context) => {
  const user = context.get("user");
  const ownerId = scopeOwner(user);
  const updates = await sql<
    {
      id: string;
      userId: string;
      userName: string;
      updateDate: string;
      moved: string;
      stuck: string;
      learned: string;
      tomorrow: string;
    }[]
  >`
    SELECT d.id, d.user_id AS "userId", u.name AS "userName", d.update_date::text AS "updateDate",
      d.moved, d.stuck, d.learned, d.tomorrow
    FROM daily_updates d JOIN users u ON u.id = d.user_id
    WHERE d.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR d.user_id = ${ownerId})
    ORDER BY d.update_date DESC, u.name LIMIT 30
  `;
  return context.json({ updates });
});

workspaceRoutes.put("/updates/today", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, dailyUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [update] = await sql<{ id: string }[]>`
    INSERT INTO daily_updates (workspace_id, user_id, moved, stuck, learned, tomorrow)
    VALUES (${user.workspaceId}, ${user.id}, ${parsed.data.moved}, ${parsed.data.stuck}, ${parsed.data.learned}, ${parsed.data.tomorrow})
    ON CONFLICT (workspace_id, user_id, update_date) DO UPDATE SET
      moved = excluded.moved, stuck = excluded.stuck, learned = excluded.learned, tomorrow = excluded.tomorrow
    RETURNING id
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "daily_update.saved",
    entityType: "daily_update",
    entityId: update.id,
  });
  return context.json({ ok: true });
});

workspaceRoutes.patch("/goals/:id", requireRole("manager"), async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, goalUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [goal] = await sql<{ id: string }[]>`
    UPDATE goals SET target = ${parsed.data.target}
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
    RETURNING id
  `;
  if (!goal) return context.json({ error: "Goal not found." }, 404);
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "goal.updated",
    entityType: "goal",
    entityId: goal.id,
    summary: { target: parsed.data.target },
  });
  return context.json({ ok: true });
});

workspaceRoutes.post("/team/:id/goals/seed", requireRole("manager"), async (context) => {
  const user = context.get("user");
  const [member] = await sql<{ id: string }[]>`
    SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
    WHERE u.id = ${context.req.param("id")} AND m.workspace_id = ${user.workspaceId}
  `;
  if (!member) return context.json({ error: "Team member not found." }, 404);
  await seedGoalsForMember(user.workspaceId, member.id);
  return context.json({ ok: true });
});
