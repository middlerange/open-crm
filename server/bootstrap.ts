import { config } from "./config.js";
import { sql } from "./db.js";
import { hashPassword, normalizeEmail } from "./security.js";

const defaultStages = [
  ["conversation", "Conversation", 1, 10, false, false],
  ["meeting_booked", "Meeting booked", 2, 20, false, false],
  ["meeting_held", "Meeting held", 3, 30, false, false],
  ["sql", "SQL", 4, 45, false, false],
  ["sao", "SAO", 5, 60, false, false],
  ["trial", "Trial", 6, 70, false, false],
  ["proposal", "Proposal", 7, 85, false, false],
  ["won", "Won", 8, 100, true, true],
  ["lost", "Lost", 9, 0, true, false],
] as const;

const icGoals = [
  ["qualified_accounts", "Approved accounts", 60],
  ["relevant_buyers", "Relevant buyers", 100],
  ["emails", "Emails logged", 80],
  ["linkedin_requests", "LinkedIn requests", 80],
  ["follow_ups", "Follow-ups & calls", 60],
  ["demos", "Demos & teardowns", 1],
  ["conversations", "Substantive conversations", 4],
  ["meetings", "Calls held", 2],
  ["sqls", "SQLs", 1],
  ["saos", "SAOs", 1],
] as const;

const managerGoals = [
  ["qualified_accounts", "Approved accounts", 40],
  ["relevant_buyers", "Relevant buyers", 60],
  ["emails", "Emails logged", 40],
  ["linkedin_requests", "LinkedIn requests", 40],
  ["follow_ups", "Follow-ups & calls", 40],
  ["demos", "Demos & teardowns", 2],
  ["conversations", "Substantive conversations", 2],
  ["meetings", "Calls held", 1],
  ["sqls", "SQLs", 1],
  ["customers", "Customers", 1],
] as const;

export async function seedGoalsForMember(workspaceId: string, userId: string) {
  const [membership] = await sql<{ role: "founder" | "manager" | "ic" }[]>`
    SELECT role FROM memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
  `;
  if (!membership || membership.role === "founder") return;
  const defaultGoals = membership.role === "manager" ? managerGoals : icGoals;
  const periodStart = new Date();
  periodStart.setHours(0, 0, 0, 0);
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + 30);

  for (const [metric, label, target] of defaultGoals) {
    await sql`
      INSERT INTO goals (workspace_id, owner_id, metric, label, target, period_start, period_end)
      VALUES (
        ${workspaceId}, ${userId}, ${metric}, ${label}, ${target},
        ${periodStart.toISOString().slice(0, 10)}, ${periodEnd.toISOString().slice(0, 10)}
      )
      ON CONFLICT (workspace_id, owner_id, metric, period_start, period_end) DO NOTHING
    `;
  }
}

export async function seedWorkspaceDefaults(workspaceId: string, founderId: string) {
  for (const [key, name, position, probability, terminal, won] of defaultStages) {
    await sql`
      INSERT INTO opportunity_stages (workspace_id, key, name, position, probability, terminal, won)
      VALUES (${workspaceId}, ${key}, ${name}, ${position}, ${probability}, ${terminal}, ${won})
      ON CONFLICT (workspace_id, key) DO NOTHING
    `;
  }

  const starterTasks = [
    [
      "operations",
      "planning",
      "Publish the ICP v1 hypothesis",
      "Turn current assumptions into a falsifiable one-page working ICP.",
      "urgent",
      0,
    ],
    [
      "outbound",
      "research",
      "Scout the first 10 Tier A accounts",
      "Require fit evidence, a live trigger, a relevant buyer and source links.",
      "urgent",
      1,
    ],
    [
      "outbound",
      "campaign",
      "Draft two message hypotheses",
      "Keep messages short, prospect-centred and connected to visible evidence.",
      "high",
      1,
    ],
    [
      "video",
      "planning",
      "Build the top 10 use-case video backlog",
      "Map every video to a buyer problem, product workflow and clear CTA.",
      "high",
      3,
    ],
    [
      "content",
      "brand",
      "Create the approved brand and writing source pack",
      "Collect current claims, proof, tone rules and disallowed statements.",
      "high",
      2,
    ],
    [
      "operations",
      "cadence",
      "Start the daily closeout ritual",
      "Record what moved, what did not, what was learned and tomorrow's change.",
      "medium",
      0,
    ],
  ] as const;

  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM work_items WHERE workspace_id = ${workspaceId}
  `;
  if (count === 0) {
    for (const [workstream, kind, title, description, priority, dueInDays] of starterTasks) {
      const dueAt = new Date();
      dueAt.setHours(18, 0, 0, 0);
      dueAt.setDate(dueAt.getDate() + dueInDays);
      await sql`
        INSERT INTO work_items (
          workspace_id, owner_id, created_by, workstream, kind, title, description, status, priority, due_at
        ) VALUES (
          ${workspaceId}, ${founderId}, ${founderId}, ${workstream}, ${kind}, ${title}, ${description},
          'ready', ${priority}, ${dueAt.toISOString()}
        )
      `;
    }
  }
}

export async function ensureBootstrap() {
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM workspaces`;
  if (count > 0) return;

  if (!config.BOOTSTRAP_EMAIL || !config.BOOTSTRAP_PASSWORD || !config.BOOTSTRAP_NAME) {
    throw new Error(
      "No workspace exists. Set BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, and BOOTSTRAP_NAME before first start.",
    );
  }

  const email = normalizeEmail(config.BOOTSTRAP_EMAIL);
  if (!email) throw new Error("BOOTSTRAP_EMAIL is invalid.");
  const bootstrapName = config.BOOTSTRAP_NAME;
  const passwordHash = await hashPassword(config.BOOTSTRAP_PASSWORD);

  const created = await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(72401602)`;
    const [{ count: workspaceCount }] = await transaction<{ count: number }[]>`
      SELECT count(*)::int AS count FROM workspaces
    `;
    if (workspaceCount > 0) return false;
    const [workspace] = await transaction<{ id: string }[]>`
      INSERT INTO workspaces (name, slug) VALUES ('Orbit', 'orbit-gtm') RETURNING id
    `;
    const [founder] = await transaction<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${email}, ${bootstrapName}, ${passwordHash})
      RETURNING id
    `;
    await transaction`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspace.id}, ${founder.id}, 'founder')
    `;
    await transaction`
      INSERT INTO audit_logs (workspace_id, actor_user_id, actor_type, action, entity_type, entity_id)
      VALUES (${workspace.id}, ${founder.id}, 'system', 'workspace.bootstrapped', 'workspace', ${workspace.id})
    `;
    return true;
  });
  if (!created) return;

  const [workspace] = await sql<
    { id: string }[]
  >`SELECT id FROM workspaces WHERE slug = 'orbit-gtm'`;
  const [founder] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  await seedWorkspaceDefaults(workspace.id, founder.id);
}

export async function seedAllDefaults() {
  await ensureBootstrap();
  const [workspace] = await sql<
    { id: string }[]
  >`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`;
  const [founder] = await sql<{ id: string }[]>`
    SELECT u.id FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE m.workspace_id = ${workspace.id} AND m.role = 'founder'
    LIMIT 1
  `;
  await seedWorkspaceDefaults(workspace.id, founder.id);
}
