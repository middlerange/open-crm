import { Hono } from "hono";
import { z } from "zod";

import { audit, requireAuth } from "./auth.js";
import { sql } from "./db.js";
import { parseJson } from "./http.js";
import { createOpaqueToken, hashToken } from "./security.js";
import type { AppVariables } from "./types.js";

const createKeyInput = z.object({
  name: z.string().trim().min(2).max(80).default("Local agent"),
});

export const agentKeyRoutes = new Hono<{ Variables: AppVariables }>();

agentKeyRoutes.use("*", requireAuth);

agentKeyRoutes.get("/", async (context) => {
  const user = context.get("user");
  const keys = await sql`
    SELECT id, name, token_hint AS "tokenHint", scopes, active,
      last_used_at AS "lastUsedAt", created_at AS "createdAt"
    FROM agent_tokens
    WHERE workspace_id = ${user.workspaceId} AND created_by = ${user.id}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return context.json({ keys });
});

agentKeyRoutes.post("/", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, createKeyInput);
  if (!parsed.ok) return parsed.response;

  const [usage] = await sql<{ activeKeys: number }[]>`
    SELECT count(*)::int AS "activeKeys"
    FROM agent_tokens
    WHERE workspace_id = ${user.workspaceId} AND created_by = ${user.id} AND active = true
  `;
  if ((usage?.activeKeys ?? 0) >= 10) {
    return context.json({ error: "Revoke an existing key before creating another." }, 409);
  }

  const token = `orbit_${createOpaqueToken(32)}`;
  const tokenHint = `${token.slice(0, 12)}…${token.slice(-4)}`;
  const [key] = await sql<{ id: string; createdAt: string }[]>`
    INSERT INTO agent_tokens (workspace_id, name, token_hash, token_hint, scopes, created_by)
    VALUES (
      ${user.workspaceId}, ${parsed.data.name}, ${hashToken(token)}, ${tokenHint},
      ARRAY['read', 'write']::text[], ${user.id}
    )
    RETURNING id, created_at AS "createdAt"
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "agent_key.created",
    entityType: "agent_token",
    entityId: key.id,
    summary: { name: parsed.data.name, scopes: ["read", "write"] },
  });
  return context.json(
    {
      key: {
        id: key.id,
        name: parsed.data.name,
        token,
        tokenHint,
        scopes: ["read", "write"],
        createdAt: key.createdAt,
      },
    },
    201,
  );
});

agentKeyRoutes.delete("/:id", async (context) => {
  const user = context.get("user");
  const [key] = await sql<{ id: string; name: string }[]>`
    UPDATE agent_tokens SET active = false
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
      AND created_by = ${user.id} AND active = true
    RETURNING id, name
  `;
  if (!key) return context.json({ error: "API key not found." }, 404);
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "agent_key.revoked",
    entityType: "agent_token",
    entityId: key.id,
    summary: { name: key.name },
  });
  return context.json({ ok: true });
});
