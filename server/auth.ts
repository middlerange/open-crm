import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import { config } from "./config.js";
import { sql } from "./db.js";
import { hashToken } from "./security.js";
import type { AppVariables, Role, SessionUser } from "./types.js";

export async function findSessionUser(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const [user] = await sql<SessionUser[]>`
    SELECT
      u.id,
      u.name,
      u.email,
      m.role,
      w.id AS "workspaceId",
      w.name AS "workspaceName",
      w.slug AS "workspaceSlug"
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.active = true
    JOIN LATERAL (
      SELECT membership.workspace_id, membership.role, membership.joined_at
      FROM memberships membership
      WHERE membership.user_id = u.id
      ORDER BY
        (membership.workspace_id = s.selected_workspace_id) DESC,
        membership.joined_at ASC,
        membership.workspace_id ASC
      LIMIT 1
    ) m ON true
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()
    ORDER BY m.joined_at ASC
    LIMIT 1
  `;
  if (!user) return null;
  await sql`
    UPDATE sessions
    SET last_seen_at = now(), selected_workspace_id = ${user.workspaceId}
    WHERE token_hash = ${tokenHash}
  `;
  return user;
}

export const requireAuth = createMiddleware<{ Variables: AppVariables }>(async (context, next) => {
  const token = getCookie(context, config.SESSION_COOKIE_NAME);
  if (!token) return context.json({ error: "Authentication required." }, 401);
  const user = await findSessionUser(token);
  if (!user) return context.json({ error: "Your session has expired." }, 401);
  context.set("user", user);
  await next();
});

export function roleAtLeast(role: Role, required: "manager" | "founder") {
  if (required === "founder") return role === "founder";
  return role === "founder" || role === "manager";
}

export function requireRole(required: "manager" | "founder") {
  return createMiddleware<{ Variables: AppVariables }>(async (context, next) => {
    const user = context.get("user");
    if (!roleAtLeast(user.role, required)) {
      return context.json({ error: "You do not have permission to perform this action." }, 403);
    }
    await next();
  });
}

export async function audit(input: {
  workspaceId: string;
  actorUserId?: string | null;
  actorType?: "user" | "agent" | "system";
  actorLabel?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  channel?: string | null;
  summary?: Record<string, unknown>;
  idempotencyKey?: string | null;
}) {
  await sql`
    INSERT INTO audit_logs (
      workspace_id, actor_user_id, actor_type, actor_label, action, entity_type, entity_id,
      channel, summary, idempotency_key
    ) VALUES (
      ${input.workspaceId}, ${input.actorUserId ?? null}, ${input.actorType ?? "user"},
      ${input.actorLabel ?? null}, ${input.action}, ${input.entityType ?? null}, ${input.entityId ?? null},
      ${input.channel ?? null}, ${sql.json((input.summary ?? {}) as never)}, ${input.idempotencyKey ?? null}
    )
  `;
}

export function canAccessOwner(user: SessionUser, ownerId: string | null) {
  return user.role !== "ic" || ownerId === user.id;
}
