import { createHash, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { audit, findSessionUser, requireAuth } from "./auth.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { databaseError, parseJson } from "./http.js";
import { createOpaqueToken, hashToken, normalizeLinkedInUrl } from "./security.js";
import type { AppVariables, SessionUser } from "./types.js";

class SourceOwnershipError extends Error {}

const authorizeSchema = z.object({
  redirectUri: z.string().url().max(500),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  tokenLabel: z.string().trim().min(2).max(80).default("Chrome extension"),
});

const browserAuthorizeSchema = z.object({
  redirectUri: z.string().url().max(500),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  tokenLabel: z.string().trim().min(2).max(80).default("Chrome extension"),
});

const exchangeSchema = z.object({
  code: z.string().min(20).max(200),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.string().url().max(500),
});

const engagementSchema = z.object({
  personName: z.string().trim().min(1).max(160),
  profileUrl: z.string().url().max(500),
  headline: z.string().trim().max(500).optional().default(""),
  companyName: z.string().trim().max(180).optional().default(""),
  location: z.string().trim().max(180).optional().default(""),
  connectionDegree: z.string().trim().max(20).optional().default(""),
  engagementType: z.enum(["reaction", "comment"]),
  reactionType: z.string().trim().max(80).optional().default(""),
  commentText: z.string().trim().max(5000).optional().default(""),
});

const ingestSchema = z.object({
  postUrl: z.string().url().max(1000),
  postAuthorName: z.string().trim().max(160).optional().default(""),
  postText: z.string().trim().max(10000).optional().default(""),
  postPublishedAt: z.string().datetime().optional().nullable(),
  competitorName: z.string().trim().max(180).optional().default(""),
  postReactionCount: z.number().int().min(0).max(100_000_000).optional().default(0),
  postCommentCount: z.number().int().min(0).max(100_000_000).optional().default(0),
  postRepostCount: z.number().int().min(0).max(100_000_000).optional().default(0),
  capturedAt: z.string().datetime(),
  engagements: z.array(engagementSchema).min(1).max(500),
});

const statusSchema = z.object({
  status: z.enum(["new", "reviewed", "dismissed"]),
});

function canonicalLinkedInUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "linkedin.com") throw new Error("Only LinkedIn URLs are accepted.");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `https://www.linkedin.com${pathname}`;
}

function isLinkedInPostUrl(value: string) {
  const pathname = new URL(value).pathname;
  return pathname.includes("/feed/update/urn:li:activity:") || pathname.includes("/posts/");
}

function validExtensionRedirect(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname) &&
      config.ORBIT_EXTENSION_IDS.includes(url.hostname.slice(0, 32)) &&
      url.pathname === "/orbit" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function extensionRedirectError(value: string) {
  if (config.ORBIT_EXTENSION_IDS.length === 0) {
    return "Extension authorization is disabled. Set ORBIT_EXTENSION_IDS to the allowed Chrome extension IDs.";
  }
  return validExtensionRedirect(value) ? null : "Extension redirect address is invalid.";
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function createExtensionAuthorization(
  user: SessionUser,
  input: z.infer<typeof authorizeSchema>,
) {
  const code = createOpaqueToken(32);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const [created] = await sql<{ id: string }[]>`
    INSERT INTO linkedin_extension_authorization_codes (
      workspace_id, user_id, code_hash, code_challenge, redirect_uri, token_label, expires_at
    ) VALUES (
      ${user.workspaceId}, ${user.id}, ${hashToken(code)}, ${input.codeChallenge},
      ${input.redirectUri}, ${input.tokenLabel}, ${expiresAt.toISOString()}
    )
    RETURNING id
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "linkedin.extension_authorization.approved",
    entityType: "linkedin_extension_authorization",
    entityId: created.id,
    summary: { label: input.tokenLabel },
  });
  const redirectUrl = new URL(input.redirectUri);
  redirectUrl.searchParams.set("code", code);
  return redirectUrl;
}

function engagementDedupeKey(input: {
  postUrl: string;
  profileUrl: string;
  engagementType: string;
  commentText: string;
}) {
  const comment = input.commentText.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256")
    .update([input.postUrl, input.profileUrl, input.engagementType, comment].join("\n"))
    .digest("hex");
}

const requireExtensionToken = createMiddleware<{ Variables: AppVariables }>(
  async (context, next) => {
    const authorization = context.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) return context.json({ error: "Extension token required." }, 401);

    const [record] = await sql<(SessionUser & { extensionTokenId: string })[]>`
      SELECT
        u.id,
        u.name,
        u.email,
        m.role,
        w.id AS "workspaceId",
        w.name AS "workspaceName",
        w.slug AS "workspaceSlug",
        t.id AS "extensionTokenId"
      FROM linkedin_extension_tokens t
      JOIN users u ON u.id = t.user_id AND u.active = true
      JOIN memberships m ON m.user_id = u.id AND m.workspace_id = t.workspace_id
      JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.token_hash = ${hashToken(token)} AND t.active = true
      LIMIT 1
    `;
    if (!record) return context.json({ error: "Extension token is invalid or revoked." }, 401);
    await sql`
      UPDATE linkedin_extension_tokens SET last_used_at = now()
      WHERE token_hash = ${hashToken(token)}
    `;
    context.set("user", record);
    context.set("extensionTokenId", record.extensionTokenId);
    await next();
  },
);

export const linkedinRoutes = new Hono<{ Variables: AppVariables }>();

linkedinRoutes.get("/linkedin/tokens", requireAuth, async (context) => {
  const user = context.get("user");
  const tokens = await sql`
    SELECT id, label, token_prefix AS "tokenPrefix", active,
      last_used_at AS "lastUsedAt", created_at AS "createdAt"
    FROM linkedin_extension_tokens
    WHERE workspace_id = ${user.workspaceId} AND user_id = ${user.id}
    ORDER BY created_at DESC
  `;
  return context.json({ tokens });
});

linkedinRoutes.post("/linkedin/authorize", requireAuth, async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, authorizeSchema);
  if (!parsed.ok) return parsed.response;
  const redirectError = extensionRedirectError(parsed.data.redirectUri);
  if (redirectError) return context.json({ error: redirectError }, 400);
  const redirectUrl = await createExtensionAuthorization(user, parsed.data);
  return context.json({ redirectUrl: redirectUrl.toString() }, 201);
});

linkedinRoutes.get("/linkedin/authorize-browser", async (context) => {
  const parsed = browserAuthorizeSchema.safeParse({
    redirectUri: context.req.query("redirect_uri"),
    codeChallenge: context.req.query("code_challenge"),
    state: context.req.query("state"),
    tokenLabel: context.req.query("token_label") || "Chrome extension",
  });
  if (!parsed.success) {
    return context.text("This Orbit extension authorization request is invalid.", 400);
  }
  const redirectError = extensionRedirectError(parsed.data.redirectUri);
  if (redirectError) return context.text(redirectError, 400);

  const sessionToken = getCookie(context, config.SESSION_COOKIE_NAME);
  const user = sessionToken ? await findSessionUser(sessionToken) : null;
  if (!user) {
    const requestUrl = new URL(context.req.url);
    const loginUrl = new URL("/login", config.APP_ORIGIN);
    loginUrl.searchParams.set("return_to", `${requestUrl.pathname}${requestUrl.search}`);
    return context.redirect(loginUrl.toString());
  }

  const redirectUrl = await createExtensionAuthorization(user, {
    redirectUri: parsed.data.redirectUri,
    codeChallenge: parsed.data.codeChallenge,
    tokenLabel: parsed.data.tokenLabel,
  });
  redirectUrl.searchParams.set("state", parsed.data.state);
  return context.redirect(redirectUrl.toString());
});

linkedinRoutes.post("/v1/linkedin/auth/exchange", async (context) => {
  const parsed = await parseJson(context, exchangeSchema);
  if (!parsed.ok) return parsed.response;
  const redirectError = extensionRedirectError(parsed.data.redirectUri);
  if (redirectError) return context.json({ error: redirectError }, 400);

  const challenge = pkceChallenge(parsed.data.codeVerifier);
  try {
    const result = await sql.begin(async (transaction) => {
      const [authorization] = await transaction<
        {
          id: string;
          workspaceId: string;
          userId: string;
          codeChallenge: string;
          redirectUri: string;
          tokenLabel: string;
          name: string;
          email: string;
          role: SessionUser["role"];
          workspaceName: string;
          workspaceSlug: string;
        }[]
      >`
        SELECT c.id, c.workspace_id AS "workspaceId", c.user_id AS "userId",
          c.code_challenge AS "codeChallenge", c.redirect_uri AS "redirectUri",
          c.token_label AS "tokenLabel", u.name, u.email, m.role,
          w.name AS "workspaceName", w.slug AS "workspaceSlug"
        FROM linkedin_extension_authorization_codes c
        JOIN users u ON u.id = c.user_id AND u.active = true
        JOIN memberships m ON m.user_id = c.user_id AND m.workspace_id = c.workspace_id
        JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.code_hash = ${hashToken(parsed.data.code)}
          AND c.used_at IS NULL AND c.expires_at > now()
        FOR UPDATE OF c
      `;
      if (!authorization || authorization.redirectUri !== parsed.data.redirectUri) return null;
      const expected = Buffer.from(authorization.codeChallenge);
      const received = Buffer.from(challenge);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

      const token = `olt_${createOpaqueToken(32)}`;
      const tokenPrefix = `${token.slice(0, 12)}…`;
      const [tokenRecord] = await transaction<{ id: string }[]>`
        INSERT INTO linkedin_extension_tokens (
          workspace_id, user_id, label, token_hash, token_prefix
        ) VALUES (
          ${authorization.workspaceId}, ${authorization.userId}, ${authorization.tokenLabel},
          ${hashToken(token)}, ${tokenPrefix}
        )
        RETURNING id
      `;
      await transaction`
        UPDATE linkedin_extension_authorization_codes SET used_at = now()
        WHERE id = ${authorization.id}
      `;
      return {
        token,
        tokenId: tokenRecord.id,
        user: {
          id: authorization.userId,
          name: authorization.name,
          email: authorization.email,
          role: authorization.role,
          workspaceId: authorization.workspaceId,
          workspaceName: authorization.workspaceName,
          workspaceSlug: authorization.workspaceSlug,
        },
      };
    });
    if (!result) return context.json({ error: "Authorization code is invalid or expired." }, 400);
    await audit({
      workspaceId: result.user.workspaceId,
      actorUserId: result.user.id,
      action: "linkedin.extension_token.created",
      entityType: "linkedin_extension_token",
      entityId: result.tokenId,
      summary: { label: "Browser authorization" },
    });
    return context.json(result, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

linkedinRoutes.delete("/v1/linkedin/auth/session", requireExtensionToken, async (context) => {
  const user = context.get("user");
  const tokenId = context.get("extensionTokenId");
  await sql`
    UPDATE linkedin_extension_tokens SET active = false, revoked_at = now()
    WHERE id = ${tokenId} AND workspace_id = ${user.workspaceId}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "linkedin.extension_token.revoked",
    entityType: "linkedin_extension_token",
    entityId: tokenId,
    channel: "chrome_extension",
  });
  return context.json({ ok: true });
});

linkedinRoutes.get("/v1/linkedin/auth/me", requireExtensionToken, async (context) => {
  return context.json({ user: context.get("user") });
});

linkedinRoutes.delete("/linkedin/tokens/:id", requireAuth, async (context) => {
  const user = context.get("user");
  const id = context.req.param("id");
  const [revoked] = await sql<{ id: string }[]>`
    UPDATE linkedin_extension_tokens
    SET active = false, revoked_at = now()
    WHERE id = ${id} AND workspace_id = ${user.workspaceId} AND user_id = ${user.id} AND active = true
    RETURNING id
  `;
  if (!revoked) return context.json({ error: "Active token not found." }, 404);
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "linkedin.extension_token.revoked",
    entityType: "linkedin_extension_token",
    entityId: id,
  });
  return context.json({ ok: true });
});

linkedinRoutes.post("/v1/linkedin/engagements", requireExtensionToken, async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, ingestSchema);
  if (!parsed.ok) return parsed.response;

  let postUrl: string;
  try {
    postUrl = canonicalLinkedInUrl(parsed.data.postUrl);
  } catch (error) {
    return context.json(
      { error: error instanceof Error ? error.message : "Invalid post URL." },
      400,
    );
  }
  if (!isLinkedInPostUrl(postUrl)) {
    return context.json({ error: "Open the LinkedIn post permalink before saving leads." }, 400);
  }

  const normalizedPostUrl = normalizeLinkedInUrl(postUrl);
  const [existingSource] = await sql<{ ownerId: string }[]>`
    SELECT owner_id AS "ownerId"
    FROM linkedin_sources
    WHERE workspace_id = ${user.workspaceId} AND normalized_post_url = ${normalizedPostUrl}
  `;
  if (existingSource && user.role === "ic" && existingSource.ownerId !== user.id) {
    return context.json({ error: "This source post already belongs to another team member." }, 409);
  }

  let accepted = 0;
  let duplicates = 0;
  try {
    await sql.begin(async (transaction) => {
      const [source] = await transaction<{ id: string }[]>`
        INSERT INTO linkedin_sources (
          workspace_id, owner_id, normalized_post_url, post_url, post_author_name,
          competitor_name, post_text, post_published_at, reaction_count, comment_count,
          repost_count, first_captured_at, last_captured_at
        ) VALUES (
          ${user.workspaceId}, ${user.id}, ${normalizedPostUrl}, ${postUrl},
          ${parsed.data.postAuthorName || null}, ${parsed.data.competitorName || null},
          ${parsed.data.postText || null}, ${parsed.data.postPublishedAt ?? null},
          ${parsed.data.postReactionCount}, ${parsed.data.postCommentCount},
          ${parsed.data.postRepostCount}, ${parsed.data.capturedAt}, ${parsed.data.capturedAt}
        )
        ON CONFLICT (workspace_id, normalized_post_url) DO UPDATE SET
          post_url = EXCLUDED.post_url,
          post_author_name = coalesce(EXCLUDED.post_author_name, linkedin_sources.post_author_name),
          competitor_name = coalesce(EXCLUDED.competitor_name, linkedin_sources.competitor_name),
          post_text = coalesce(EXCLUDED.post_text, linkedin_sources.post_text),
          post_published_at = coalesce(
            EXCLUDED.post_published_at,
            linkedin_sources.post_published_at
          ),
          reaction_count = greatest(linkedin_sources.reaction_count, EXCLUDED.reaction_count),
          comment_count = greatest(linkedin_sources.comment_count, EXCLUDED.comment_count),
          repost_count = greatest(linkedin_sources.repost_count, EXCLUDED.repost_count),
          capture_runs = linkedin_sources.capture_runs + 1,
          last_captured_at = EXCLUDED.last_captured_at
        WHERE linkedin_sources.owner_id = ${user.id} OR ${user.role !== "ic"}
        RETURNING id
      `;
      if (!source) throw new SourceOwnershipError();
      for (const engagement of parsed.data.engagements) {
        let profileUrl: string;
        try {
          profileUrl = canonicalLinkedInUrl(engagement.profileUrl);
        } catch {
          duplicates += 1;
          continue;
        }
        const normalizedProfileUrl = normalizeLinkedInUrl(profileUrl);
        if (!normalizedProfileUrl?.includes("linkedin.com/in/")) {
          duplicates += 1;
          continue;
        }
        const dedupeKey = engagementDedupeKey({
          postUrl,
          profileUrl: normalizedProfileUrl,
          engagementType: engagement.engagementType,
          commentText: engagement.commentText,
        });
        const [created] = await transaction<{ id: string }[]>`
          INSERT INTO linkedin_engagements (
            workspace_id, owner_id, source_id, normalized_post_url, post_url, post_author_name,
            post_text, post_published_at,
            competitor_name, person_name, profile_url, normalized_profile_url, headline,
            company_name, location, connection_degree, engagement_type, reaction_type,
            comment_text, dedupe_key, captured_at
          ) VALUES (
            ${user.workspaceId}, ${user.id}, ${source.id}, ${normalizedPostUrl}, ${postUrl},
            ${parsed.data.postAuthorName || null}, ${parsed.data.postText || null},
            ${parsed.data.postPublishedAt ?? null}, ${parsed.data.competitorName || null},
            ${engagement.personName}, ${profileUrl}, ${normalizedProfileUrl},
            ${engagement.headline || null}, ${engagement.companyName || null},
            ${engagement.location || null}, ${engagement.connectionDegree || null},
            ${engagement.engagementType},
            ${engagement.reactionType || null}, ${engagement.commentText || null}, ${dedupeKey},
            ${parsed.data.capturedAt}
          )
          ON CONFLICT (workspace_id, dedupe_key) DO NOTHING
          RETURNING id
        `;
        if (created) accepted += 1;
        else duplicates += 1;
      }
    });
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "linkedin.engagements.captured",
      entityType: "linkedin_engagement_batch",
      channel: "chrome_extension",
      summary: { accepted, duplicates, submitted: parsed.data.engagements.length, postUrl },
    });
    return context.json({ accepted, duplicates });
  } catch (error) {
    if (error instanceof SourceOwnershipError) {
      return context.json(
        { error: "This source post already belongs to another team member." },
        409,
      );
    }
    return databaseError(context, error);
  }
});

linkedinRoutes.get("/linkedin/sources", requireAuth, async (context) => {
  const user = context.get("user");
  const ownerId = user.role === "ic" ? user.id : null;
  const sources = await sql`
    SELECT s.id, s.post_url AS "postUrl", s.post_author_name AS "postAuthorName",
      s.competitor_name AS "competitorName", s.post_text AS "postText",
      s.post_published_at AS "postPublishedAt", s.reaction_count AS "reactionCount",
      s.comment_count AS "commentCount", s.repost_count AS "repostCount",
      s.capture_runs AS "captureRuns", s.active,
      s.first_captured_at AS "firstCapturedAt", s.last_captured_at AS "lastCapturedAt",
      u.name AS "ownerName", count(e.id)::int AS "signalCount",
      count(DISTINCT e.normalized_profile_url)::int AS "peopleCount"
    FROM linkedin_sources s
    JOIN users u ON u.id = s.owner_id
    LEFT JOIN linkedin_engagements e ON e.source_id = s.id
    WHERE s.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR s.owner_id = ${ownerId})
    GROUP BY s.id, u.name
    ORDER BY s.last_captured_at DESC
    LIMIT 100
  `;
  return context.json({ sources });
});

linkedinRoutes.get("/linkedin/engagements", requireAuth, async (context) => {
  const user = context.get("user");
  const ownerId = user.role === "ic" ? user.id : null;
  const [engagements, [summary]] = await Promise.all([
    sql`
      SELECT e.id, e.source_id AS "sourceId", e.person_name AS "personName",
        e.profile_url AS "profileUrl",
        e.headline, e.engagement_type AS "engagementType", e.reaction_type AS "reactionType",
        e.company_name AS "companyName", e.location, e.connection_degree AS "connectionDegree",
        e.comment_text AS "commentText", e.status, e.post_url AS "postUrl",
        e.post_author_name AS "postAuthorName", e.post_text AS "postText",
        e.post_published_at AS "postPublishedAt", e.competitor_name AS "competitorName",
        e.captured_at AS "capturedAt", e.created_at AS "createdAt", u.name AS "ownerName",
        history.posts AS "postsEngaged",
        least(100,
          CASE WHEN e.engagement_type = 'comment' THEN 60 ELSE 30 END
          + CASE WHEN e.comment_text LIKE '%?%' THEN 15 ELSE 0 END
          + CASE WHEN length(coalesce(e.comment_text, '')) >= 120 THEN 10 ELSE 0 END
          + least(20, greatest(0, history.posts - 1) * 10)
        )::int AS "intentScore"
      FROM linkedin_engagements e
      JOIN users u ON u.id = e.owner_id
      JOIN (
        SELECT workspace_id, normalized_profile_url, count(DISTINCT normalized_post_url)::int AS posts
        FROM linkedin_engagements
        GROUP BY workspace_id, normalized_profile_url
      ) history ON history.workspace_id = e.workspace_id
        AND history.normalized_profile_url = e.normalized_profile_url
      WHERE e.workspace_id = ${user.workspaceId}
        AND (${ownerId}::uuid IS NULL OR e.owner_id = ${ownerId})
      ORDER BY e.created_at DESC
      LIMIT 500
    `,
    sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status = 'new')::int AS new,
        count(*) FILTER (WHERE engagement_type = 'reaction')::int AS reactions,
        count(*) FILTER (WHERE engagement_type = 'comment')::int AS comments
      FROM linkedin_engagements
      WHERE workspace_id = ${user.workspaceId}
        AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
    `,
  ]);
  return context.json({ engagements, summary });
});

linkedinRoutes.patch("/linkedin/engagements/:id", requireAuth, async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, statusSchema);
  if (!parsed.ok) return parsed.response;
  const id = context.req.param("id");
  const ownerId = user.role === "ic" ? user.id : null;
  const [updated] = await sql<{ id: string }[]>`
    UPDATE linkedin_engagements SET status = ${parsed.data.status}
    WHERE id = ${id} AND workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId})
    RETURNING id
  `;
  if (!updated) return context.json({ error: "Engagement not found." }, 404);
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "linkedin.engagement.status_changed",
    entityType: "linkedin_engagement",
    entityId: id,
    summary: { status: parsed.data.status },
  });
  return context.json({ ok: true });
});
