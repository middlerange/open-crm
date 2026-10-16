import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { audit, findSessionUser, requireAuth, requireRole } from "./auth.js";
import { consumeAuthAttempt } from "./auth-rate-limit.js";
import { seedGoalsForMember, seedWorkspaceDefaults } from "./bootstrap.js";
import { config, isProduction } from "./config.js";
import { sql } from "./db.js";
import { parseJson } from "./http.js";
import {
  createOpaqueToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  verifyPassword,
} from "./security.js";
import type { AppVariables } from "./types.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["manager", "ic"]),
});

const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2).max(80).optional(),
  password: z.string().min(1).max(200).optional(),
});

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

export const authRoutes = new Hono<{ Variables: AppVariables }>();

function sessionMetadata(context: { req: { header(name: string): string | undefined } }) {
  return {
    userAgent: context.req.header("user-agent") ?? null,
    ipAddress: context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}

authRoutes.post("/login", async (context) => {
  const parsed = await parseJson(context, loginSchema);
  if (!parsed.ok) return parsed.response;
  const email = normalizeEmail(parsed.data.email);
  const attempt = await consumeAuthAttempt("email", email!);
  if (!attempt.allowed) {
    context.header("Retry-After", String(attempt.retryAfter));
    return context.json({ error: "Too many authentication attempts. Try again later." }, 429);
  }
  const [record] = await sql<
    { id: string; passwordHash: string; active: boolean; workspaceId: string; role: string }[]
  >`
    SELECT
      u.id,
      u.password_hash AS "passwordHash",
      u.active,
      m.workspace_id AS "workspaceId",
      m.role
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE u.email = ${email}
    ORDER BY m.joined_at ASC
    LIMIT 1
  `;
  if (!record?.active || !(await verifyPassword(record.passwordHash, parsed.data.password))) {
    return context.json({ error: "Email or password is incorrect." }, 401);
  }

  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at, selected_workspace_id, user_agent, ip_address)
    VALUES (
      ${record.id}, ${hashToken(token)}, ${expiresAt.toISOString()}, ${record.workspaceId},
      ${context.req.header("user-agent") ?? null}, ${context.req.header("x-forwarded-for")?.split(",")[0] ?? null}
    )
  `;
  setCookie(context, config.SESSION_COOKIE_NAME, token, sessionCookieOptions());
  await audit({ workspaceId: record.workspaceId, actorUserId: record.id, action: "auth.login" });
  return context.json({ ok: true });
});

authRoutes.post("/logout", async (context) => {
  const token = getCookie(context, config.SESSION_COOKIE_NAME);
  if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
  deleteCookie(context, config.SESSION_COOKIE_NAME, { path: "/" });
  return context.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (context) => {
  const user = context.get("user");
  return context.json({ user });
});

authRoutes.get("/workspaces", requireAuth, async (context) => {
  const user = context.get("user");
  const workspaces = await sql<
    Array<{ id: string; name: string; slug: string; role: string; current: boolean }>
  >`
    SELECT w.id, w.name, w.slug, m.role, (w.id = ${user.workspaceId}) AS current
    FROM memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ${user.id}
    ORDER BY m.joined_at ASC, w.name ASC
  `;
  return context.json({ workspaces });
});

authRoutes.post("/workspaces/:id/switch", requireAuth, async (context) => {
  const user = context.get("user");
  const workspaceId = context.req.param("id");
  const [membership] = await sql<{ role: string }[]>`
    SELECT role FROM memberships WHERE user_id = ${user.id} AND workspace_id = ${workspaceId}
  `;
  if (!membership) return context.json({ error: "Workspace not found." }, 404);
  const token = getCookie(context, config.SESSION_COOKIE_NAME)!;
  await sql`
    UPDATE sessions SET selected_workspace_id = ${workspaceId}, last_seen_at = now()
    WHERE token_hash = ${hashToken(token)} AND user_id = ${user.id}
  `;
  await audit({
    workspaceId,
    actorUserId: user.id,
    action: "workspace.switched",
    entityType: "workspace",
    entityId: workspaceId,
  });
  return context.json({ ok: true });
});

authRoutes.post("/workspaces", requireAuth, async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, createWorkspaceSchema);
  if (!parsed.ok) return parsed.response;
  const baseSlug =
    parsed.data.name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "workspace";
  const slug = `${baseSlug}-${createOpaqueToken().slice(0, 8).toLowerCase()}`;
  const [workspace] = await sql.begin(async (transaction) => {
    const [created] = await transaction<{ id: string; name: string; slug: string }[]>`
      INSERT INTO workspaces (name, slug)
      VALUES (${parsed.data.name}, ${slug})
      RETURNING id, name, slug
    `;
    await transaction`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${created.id}, ${user.id}, 'founder')
    `;
    const token = getCookie(context, config.SESSION_COOKIE_NAME)!;
    await transaction`
      UPDATE sessions SET selected_workspace_id = ${created.id}, last_seen_at = now()
      WHERE token_hash = ${hashToken(token)} AND user_id = ${user.id}
    `;
    return [created];
  });
  await seedWorkspaceDefaults(workspace.id, user.id);
  await audit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    action: "workspace.created",
    entityType: "workspace",
    entityId: workspace.id,
  });
  return context.json({ workspace: { ...workspace, role: "founder", current: true } }, 201);
});

authRoutes.get("/invite/:token", async (context) => {
  const tokenHash = hashToken(context.req.param("token"));
  const [invite] = await sql<
    {
      email: string;
      role: string;
      workspaceName: string;
      expiresAt: string;
      existingAccount: boolean;
    }[]
  >`
    SELECT i.email, i.role, w.name AS "workspaceName", i.expires_at AS "expiresAt",
      EXISTS (SELECT 1 FROM users u WHERE u.email = lower(i.email)) AS "existingAccount"
    FROM invitations i
    JOIN workspaces w ON w.id = i.workspace_id
    WHERE i.token_hash = ${tokenHash} AND i.accepted_at IS NULL AND i.expires_at > now()
  `;
  if (!invite) return context.json({ error: "This invitation is invalid or expired." }, 404);
  return context.json({ invite });
});

authRoutes.post("/invite/accept", async (context) => {
  const parsed = await parseJson(context, acceptInviteSchema);
  if (!parsed.ok) return parsed.response;
  const tokenHash = hashToken(parsed.data.token);
  const attempt = await consumeAuthAttempt("invite", parsed.data.token);
  if (!attempt.allowed) {
    context.header("Retry-After", String(attempt.retryAfter));
    return context.json({ error: "Too many authentication attempts. Try again later." }, 429);
  }
  const cookieToken = getCookie(context, config.SESSION_COOKIE_NAME);
  const sessionUser = cookieToken ? await findSessionUser(cookieToken) : null;
  const newSessionToken = createOpaqueToken();
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const metadata = sessionMetadata(context);
  const result = await sql.begin(async (transaction) => {
    const [invite] = await transaction<
      { id: string; workspaceId: string; email: string; role: "manager" | "ic" }[]
    >`
      SELECT id, workspace_id AS "workspaceId", email, role
      FROM invitations
      WHERE token_hash = ${tokenHash} AND accepted_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!invite) return { error: "invalid" as const };
    const email = normalizeEmail(invite.email);
    const [existing] = await transaction<
      { id: string; passwordHash: string; active: boolean }[]
    >`SELECT id, password_hash AS "passwordHash", active FROM users WHERE email = ${email}`;

    let userId: string;
    if (existing) {
      if (!existing.active) return { error: "inactive" as const };
      const authenticatedBySession = sessionUser?.id === existing.id && sessionUser.email === email;
      if (!authenticatedBySession && parsed.data.password) {
        const emailAttempt = await consumeAuthAttempt("email", email!, transaction);
        if (!emailAttempt.allowed) {
          return { error: "rate-limit" as const, retryAfter: emailAttempt.retryAfter };
        }
      }
      const authenticatedByPassword =
        !authenticatedBySession && parsed.data.password
          ? await verifyPassword(existing.passwordHash, parsed.data.password)
          : false;
      if (!authenticatedBySession && !authenticatedByPassword) {
        return { error: "authentication" as const };
      }
      const [alreadyMember] = await transaction<{ found: boolean }[]>`
        SELECT true AS found FROM memberships
        WHERE workspace_id = ${invite.workspaceId} AND user_id = ${existing.id}
      `;
      if (alreadyMember) return { error: "member" as const };
      userId = existing.id;
    } else {
      if (!parsed.data.name || !parsed.data.password || parsed.data.password.length < 12) {
        return { error: "registration" as const };
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const [created] = await transaction<{ id: string }[]>`
        INSERT INTO users (email, name, password_hash)
        VALUES (${email}, ${parsed.data.name}, ${passwordHash})
        RETURNING id
      `;
      userId = created.id;
    }

    await transaction`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${invite.workspaceId}, ${userId}, ${invite.role})
    `;
    await transaction`UPDATE invitations SET accepted_at = now() WHERE id = ${invite.id}`;
    if (cookieToken && sessionUser?.id === userId) {
      await transaction`
        UPDATE sessions SET selected_workspace_id = ${invite.workspaceId}, last_seen_at = now()
        WHERE token_hash = ${hashToken(cookieToken)} AND user_id = ${userId}
      `;
    } else {
      await transaction`
        INSERT INTO sessions (
          user_id, token_hash, expires_at, selected_workspace_id, user_agent, ip_address
        ) VALUES (
          ${userId}, ${hashToken(newSessionToken)}, ${sessionExpiresAt.toISOString()},
          ${invite.workspaceId}, ${metadata.userAgent}, ${metadata.ipAddress}
        )
      `;
    }
    return {
      userId,
      workspaceId: invite.workspaceId,
      role: invite.role,
      reusedSession: Boolean(cookieToken && sessionUser?.id === userId),
    };
  });
  if ("error" in result) {
    if (result.error === "rate-limit") {
      context.header("Retry-After", String(result.retryAfter));
      return context.json({ error: "Too many authentication attempts. Try again later." }, 429);
    }
    if (result.error === "invalid")
      return context.json({ error: "This invitation is invalid or expired." }, 404);
    if (result.error === "authentication")
      return context.json(
        { error: "Sign in with the invited email or enter its current password." },
        401,
      );
    if (result.error === "registration")
      return context.json(
        { error: "Name and a password of at least 12 characters are required." },
        422,
      );
    if (result.error === "inactive")
      return context.json({ error: "This account is inactive." }, 403);
    return context.json({ error: "You already belong to this workspace." }, 409);
  }
  if (!result.reusedSession) {
    setCookie(context, config.SESSION_COOKIE_NAME, newSessionToken, sessionCookieOptions());
  }
  await seedGoalsForMember(result.workspaceId, result.userId);
  await audit({
    workspaceId: result.workspaceId,
    actorUserId: result.userId,
    action: "invitation.accepted",
    entityType: "user",
    entityId: result.userId,
    summary: { role: result.role },
  });
  return context.json({ ok: true, authenticated: true }, 201);
});

authRoutes.post("/invites", requireAuth, requireRole("founder"), async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, inviteSchema);
  if (!parsed.ok) return parsed.response;
  const email = normalizeEmail(parsed.data.email);
  const [existingMember] = await sql<{ id: string }[]>`
    SELECT u.id FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE u.email = ${email} AND m.workspace_id = ${user.workspaceId}
  `;
  if (existingMember)
    return context.json({ error: "This user already belongs to this workspace." }, 409);

  await sql`
    UPDATE invitations SET accepted_at = now()
    WHERE workspace_id = ${user.workspaceId} AND lower(email) = ${email} AND accepted_at IS NULL
  `;
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [invite] = await sql<{ id: string }[]>`
    INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
    VALUES (${user.workspaceId}, ${email}, ${parsed.data.role}, ${hashToken(token)}, ${user.id}, ${expiresAt.toISOString()})
    RETURNING id
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "invitation.created",
    entityType: "invitation",
    entityId: invite.id,
    summary: { email, role: parsed.data.role },
  });
  const inviteUrl = `${config.APP_ORIGIN}/accept-invite?token=${encodeURIComponent(token)}`;
  return context.json({ inviteUrl, expiresAt }, 201);
});
