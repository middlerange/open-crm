import { Hono, type Context } from "hono";
import { z } from "zod";

import { audit, requireAuth, roleAtLeast } from "./auth.js";
import {
  cascadeAccountOwner,
  CsvParseError,
  normalizeCustomFieldKey,
  parseCsv,
  serializeCsv,
} from "./crm-utils.js";
import { sql } from "./db.js";
import { databaseError, parseJson } from "./http.js";
import { normalizeDomain, normalizeEmail, normalizeLinkedInUrl } from "./security.js";
import {
  buildStagedOutreachPlan,
  commitStagedOutreachImport,
  publicStagedOutreachPreview,
  stagedOutreachCommitSchema,
  stagedOutreachImportSchema,
} from "./staged-outreach-import.js";
import type { AppVariables, SessionUser } from "./types.js";

const entityTypeSchema = z.enum(["account", "contact", "opportunity"]);
const fieldTypeSchema = z.enum([
  "text",
  "long_text",
  "number",
  "date",
  "checkbox",
  "select",
  "url",
  "email",
  "phone",
  "user",
]);

const fieldSchema = z.object({
  entityType: entityTypeSchema,
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().trim().min(1).max(120),
  fieldType: fieldTypeSchema,
  description: z.string().trim().max(500).optional().default(""),
  required: z.boolean().optional().default(false),
  options: z.array(z.string().trim().min(1).max(120)).max(100).optional().default([]),
  position: z.number().int().min(0).max(1000).optional().default(0),
});

const fieldUpdateSchema = fieldSchema
  .omit({ entityType: true, key: true })
  .partial()
  .extend({ archived: z.boolean().optional() });

const fieldValueSchema = z.object({
  fieldDefinitionId: z.string().uuid(),
  entityType: entityTypeSchema,
  entityId: z.string().uuid(),
  value: z.unknown(),
});

const tagSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().min(1).max(40).optional().default("gray"),
});

const entityTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(50),
});

const savedViewSchema = z.object({
  entityType: z.enum(["account", "contact", "opportunity", "activity"]),
  name: z.string().trim().min(1).max(100),
  filters: z.record(z.string(), z.unknown()).optional().default({}),
  columns: z.array(z.string().trim().min(1).max(80)).max(50).optional().default([]),
  sort: z.record(z.string(), z.unknown()).optional().default({}),
  shared: z.boolean().optional().default(false),
});

const suppressionSchema = z.object({
  kind: z.enum(["email", "domain"]),
  value: z.string().trim().min(1).max(320),
  reason: z.string().trim().max(1000).optional().default(""),
});

const evidenceSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.string().uuid(),
  fieldKey: z.string().trim().min(1).max(120),
  proposedValue: z.unknown(),
  sourceUrl: z.string().url().optional().or(z.literal("")),
  excerpt: z.string().trim().max(3000).optional().default(""),
});

const importSchema = z.object({
  entityType: z.enum(["account", "contact", "lead"]),
  csv: z.string().min(1).max(5_000_000),
  mode: z.enum(["create", "upsert"]).optional().default("create"),
});

const bulkSchema = z.object({
  entityType: entityTypeSchema,
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(["assign", "archive", "restore", "status", "tag"]),
  ownerId: z.string().uuid().optional(),
  status: z.string().trim().min(1).max(80).optional(),
  tagId: z.string().uuid().optional(),
});

const mergeSchema = z.object({
  entityType: z.enum(["account", "contact"]),
  primaryId: z.string().uuid(),
  duplicateId: z.string().uuid(),
});

const stageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  key: z.string().trim().max(80).optional(),
  probability: z.number().int().min(0).max(100).optional().default(0),
  terminal: z.boolean().optional().default(false),
  won: z.boolean().optional().default(false),
});
const stageUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  terminal: z.boolean().optional(),
  won: z.boolean().optional(),
});

function requireManager(user: SessionUser) {
  return roleAtLeast(user.role, "manager");
}

function cleanSuppressionValue(kind: "email" | "domain", value: string) {
  const normalized = value.trim().toLowerCase();
  if (kind === "domain") return normalized.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  return normalized;
}

async function entityAccess(
  user: SessionUser,
  entityType: z.infer<typeof entityTypeSchema>,
  id: string,
) {
  if (entityType === "account") {
    const [record] = await sql<{ id: string; ownerId: string | null }[]>`
      SELECT id, owner_id AS "ownerId" FROM accounts
      WHERE id = ${id} AND workspace_id = ${user.workspaceId}
    `;
    return record && (user.role !== "ic" || record.ownerId === user.id) ? record : null;
  }
  if (entityType === "contact") {
    const [record] = await sql<{ id: string; ownerId: string | null }[]>`
      SELECT id, owner_id AS "ownerId" FROM contacts
      WHERE id = ${id} AND workspace_id = ${user.workspaceId}
    `;
    return record && (user.role !== "ic" || record.ownerId === user.id) ? record : null;
  }
  const [record] = await sql<{ id: string; ownerId: string | null }[]>`
    SELECT id, owner_id AS "ownerId" FROM opportunities
    WHERE id = ${id} AND workspace_id = ${user.workspaceId}
  `;
  return record && (user.role !== "ic" || record.ownerId === user.id) ? record : null;
}

function fieldValueValid(field: { fieldType: string; options: unknown }, value: unknown): boolean {
  if (value === null || value === "") return true;
  if (field.fieldType === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.fieldType === "checkbox") return typeof value === "boolean";
  if (field.fieldType === "select") {
    return Array.isArray(field.options) && field.options.includes(value);
  }
  if (typeof value !== "string") return false;
  if (field.fieldType === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (field.fieldType === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (field.fieldType === "url") {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  return value.length <= (field.fieldType === "long_text" ? 20_000 : 2_000);
}

function normalizedCsvRow(row: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
      value.trim(),
    ]),
  );
}

export function validateImportRow(
  row: Record<string, string>,
  entityType: "account" | "contact" | "lead",
) {
  const limits =
    entityType === "account"
      ? {
          country: 120,
          state: 120,
          city: 120,
          name: 180,
          domain: 255,
          linkedin_url: 500,
          website_url: 500,
          employee_range: 80,
          industry: 120,
          product_motion: 120,
          source: 120,
          fit_summary: 5000,
          evidence_summary: 5000,
          trigger_summary: 5000,
        }
      : {
          country: 120,
          state: 120,
          city: 120,
          first_name: 80,
          last_name: 80,
          title: 160,
          department: 100,
          email: 320,
          linkedin_url: 500,
          phone: 80,
          buyer_role: 120,
          notes: 5000,
        };
  for (const [field, limit] of Object.entries(limits)) {
    if ((row[field]?.length ?? 0) > limit) return `${field} must be at most ${limit} characters`;
  }
  if (entityType === "account" && (row.name?.length ?? 0) < 2)
    return "name must contain at least 2 characters";
  if (entityType !== "account" && !row.first_name) return "first_name is required";
  if (entityType !== "account" && !row.account_domain) return "account_domain is required";
  if (row.email && !z.string().email().safeParse(row.email).success) return "email is invalid";
  for (const field of ["domain", "account_domain", "website_url", "linkedin_url"]) {
    if (!row[field]) continue;
    try {
      const value = row[field];
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname.includes(".") ||
        /\s/.test(value)
      )
        return `${field} is invalid`;
      if (field === "linkedin_url" && !/(^|\.)linkedin\.com$/i.test(url.hostname))
        return "linkedin_url must be a LinkedIn URL";
    } catch {
      return `${field} is invalid`;
    }
  }
  if (row.tier && !["A", "B", "C"].includes(row.tier.toUpperCase()))
    return "tier must be A, B, or C";
  if (row.score && (!/^\d+$/.test(row.score) || Number(row.score) > 100))
    return "score must be an integer between 0 and 100";
  return null;
}

function currentImportSource(entityType: "account" | "contact" | "lead") {
  return `orbit_csv_${entityType}`;
}

function csvResponse(context: Context, name: string, body: string) {
  context.header("Content-Type", "text/csv; charset=utf-8");
  context.header("Content-Disposition", `attachment; filename="${name}"`);
  return context.body(body);
}

export const crmConfigRoutes = new Hono<{ Variables: AppVariables }>();
crmConfigRoutes.use("*", requireAuth);

crmConfigRoutes.get("/crm/fields", async (context) => {
  const user = context.get("user");
  const parsedType = entityTypeSchema.safeParse(context.req.query("entityType"));
  if (!parsedType.success) return context.json({ error: "A valid entityType is required." }, 422);
  const includeArchived = context.req.query("includeArchived") === "true" && requireManager(user);
  const fields = await sql`
    SELECT id, entity_type AS "entityType", key, label, field_type AS "fieldType",
      description, required, options, position, archived_at AS "archivedAt"
    FROM crm_field_definitions
    WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsedType.data}
      AND (${includeArchived} OR archived_at IS NULL)
    ORDER BY position, created_at
  `;
  return context.json({ fields });
});

crmConfigRoutes.get("/crm/stages", async (context) => {
  const user = context.get("user");
  const stages = await sql`
    SELECT s.id, s.key, s.name, s.position, s.probability, s.terminal, s.won,
      count(o.id)::int AS "opportunityCount"
    FROM opportunity_stages s
    LEFT JOIN opportunities o ON o.stage_id = s.id AND o.archived_at IS NULL
    WHERE s.workspace_id = ${user.workspaceId}
    GROUP BY s.id
    ORDER BY s.position
  `;
  return context.json({ stages });
});

crmConfigRoutes.post("/crm/stages", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, stageSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.won && !parsed.data.terminal) {
    return context.json({ error: "A won stage must also be terminal." }, 422);
  }
  const key = normalizeCustomFieldKey(parsed.data.key || parsed.data.name);
  if (!key) return context.json({ error: "Stage key could not be generated." }, 422);
  try {
    const [stage] = await sql<{ id: string }[]>`
      INSERT INTO opportunity_stages (
        workspace_id, key, name, position, probability, terminal, won
      ) VALUES (
        ${user.workspaceId}, ${key}, ${parsed.data.name},
        (SELECT coalesce(max(position), 0) + 1 FROM opportunity_stages WHERE workspace_id = ${user.workspaceId}),
        ${parsed.data.probability}, ${parsed.data.terminal}, ${parsed.data.won}
      ) RETURNING id
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "opportunity_stage.created",
      entityType: "opportunity_stage",
      entityId: stage.id,
      summary: { key },
    });
    return context.json({ id: stage.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmConfigRoutes.patch("/crm/stages/:id", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, stageUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [current] = await sql<any[]>`
    SELECT * FROM opportunity_stages
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
  `;
  if (!current) return context.json({ error: "Pipeline stage not found." }, 404);
  const terminal = parsed.data.terminal ?? current.terminal;
  const won = parsed.data.won ?? current.won;
  if (won && !terminal) return context.json({ error: "A won stage must also be terminal." }, 422);
  await sql`
    UPDATE opportunity_stages SET name = ${parsed.data.name ?? current.name},
      probability = ${parsed.data.probability ?? current.probability}, terminal = ${terminal}, won = ${won}
    WHERE id = ${current.id}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "opportunity_stage.updated",
    entityType: "opportunity_stage",
    entityId: current.id,
  });
  return context.json({ ok: true });
});

crmConfigRoutes.post("/crm/fields", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, fieldSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.fieldType === "select" && parsed.data.options.length === 0) {
    return context.json({ error: "Select fields require at least one option." }, 422);
  }
  try {
    const [field] = await sql<{ id: string }[]>`
      INSERT INTO crm_field_definitions (
        workspace_id, entity_type, key, label, field_type, description, required, options,
        position, created_by
      ) VALUES (
        ${user.workspaceId}, ${parsed.data.entityType}, ${parsed.data.key}, ${parsed.data.label},
        ${parsed.data.fieldType}, ${parsed.data.description || null}, ${parsed.data.required},
        ${sql.json(parsed.data.options)}, ${parsed.data.position}, ${user.id}
      ) RETURNING id
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "crm_field.created",
      entityType: "crm_field",
      entityId: field.id,
      summary: { entityType: parsed.data.entityType, key: parsed.data.key },
    });
    return context.json({ id: field.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmConfigRoutes.patch("/crm/fields/:id", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, fieldUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const [current] = await sql<any[]>`
    SELECT * FROM crm_field_definitions
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
  `;
  if (!current) return context.json({ error: "Custom field not found." }, 404);
  await sql`
    UPDATE crm_field_definitions SET
      label = ${parsed.data.label ?? current.label},
      field_type = ${parsed.data.fieldType ?? current.field_type},
      description = ${parsed.data.description !== undefined ? parsed.data.description || null : current.description},
      required = ${parsed.data.required ?? current.required},
      options = ${parsed.data.options ? sql.json(parsed.data.options) : current.options},
      position = ${parsed.data.position ?? current.position},
      archived_at = ${parsed.data.archived === undefined ? current.archived_at : parsed.data.archived ? new Date().toISOString() : null}
    WHERE id = ${current.id}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: parsed.data.archived ? "crm_field.archived" : "crm_field.updated",
    entityType: "crm_field",
    entityId: current.id,
  });
  return context.json({ ok: true });
});

crmConfigRoutes.get("/crm/field-values/:entityType/:id", async (context) => {
  const user = context.get("user");
  const parsedType = entityTypeSchema.safeParse(context.req.param("entityType"));
  if (!parsedType.success) return context.json({ error: "Invalid entity type." }, 422);
  const id = context.req.param("id");
  if (!(await entityAccess(user, parsedType.data, id))) {
    return context.json({ error: "Record not found." }, 404);
  }
  const values = await sql`
    SELECT fv.field_definition_id AS "fieldDefinitionId", fd.key, fd.label,
      fd.field_type AS "fieldType", fv.value
    FROM crm_field_values fv
    JOIN crm_field_definitions fd ON fd.id = fv.field_definition_id
    WHERE fv.workspace_id = ${user.workspaceId} AND fv.entity_type = ${parsedType.data}
      AND fv.entity_id = ${id} AND fd.archived_at IS NULL
    ORDER BY fd.position, fd.created_at
  `;
  return context.json({ values });
});

crmConfigRoutes.put("/crm/field-values", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, fieldValueSchema);
  if (!parsed.ok) return parsed.response;
  if (!(await entityAccess(user, parsed.data.entityType, parsed.data.entityId))) {
    return context.json({ error: "Record not found." }, 404);
  }
  const [field] = await sql<
    { id: string; entityType: string; fieldType: string; options: unknown }[]
  >`
    SELECT id, entity_type AS "entityType", field_type AS "fieldType", options
    FROM crm_field_definitions
    WHERE id = ${parsed.data.fieldDefinitionId} AND workspace_id = ${user.workspaceId}
      AND archived_at IS NULL
  `;
  if (!field || field.entityType !== parsed.data.entityType) {
    return context.json({ error: "Custom field not found for this record type." }, 404);
  }
  if (!fieldValueValid(field, parsed.data.value)) {
    return context.json({ error: "The value does not match the custom field type." }, 422);
  }
  await sql`
    INSERT INTO crm_field_values (
      workspace_id, field_definition_id, entity_type, entity_id, value, updated_by
    ) VALUES (
      ${user.workspaceId}, ${field.id}, ${parsed.data.entityType}, ${parsed.data.entityId},
      ${sql.json(parsed.data.value as never)}, ${user.id}
    )
    ON CONFLICT (field_definition_id, entity_id) DO UPDATE SET
      value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "crm_field_value.updated",
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
    summary: { fieldDefinitionId: field.id },
  });
  return context.json({ ok: true });
});

crmConfigRoutes.get("/crm/tags", async (context) => {
  const user = context.get("user");
  const tags = await sql`
    SELECT t.id, t.name, t.color, count(et.tag_id)::int AS "usageCount"
    FROM crm_tags t
    LEFT JOIN crm_entity_tags et ON et.tag_id = t.id
    WHERE t.workspace_id = ${user.workspaceId}
    GROUP BY t.id
    ORDER BY lower(t.name)
  `;
  return context.json({ tags });
});

crmConfigRoutes.post("/crm/tags", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, tagSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const [tag] = await sql<{ id: string }[]>`
      INSERT INTO crm_tags (workspace_id, name, color, created_by)
      VALUES (${user.workspaceId}, ${parsed.data.name}, ${parsed.data.color}, ${user.id})
      RETURNING id
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "crm_tag.created",
      entityType: "crm_tag",
      entityId: tag.id,
      summary: { name: parsed.data.name },
    });
    return context.json({ id: tag.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmConfigRoutes.get("/crm/entities/:entityType/:id/tags", async (context) => {
  const user = context.get("user");
  const parsedType = entityTypeSchema.safeParse(context.req.param("entityType"));
  if (!parsedType.success) return context.json({ error: "Invalid entity type." }, 422);
  const entityId = context.req.param("id");
  if (!(await entityAccess(user, parsedType.data, entityId))) {
    return context.json({ error: "Record not found." }, 404);
  }
  const tags = await sql`
    SELECT t.id, t.name, t.color
    FROM crm_entity_tags et
    JOIN crm_tags t ON t.id = et.tag_id AND t.workspace_id = et.workspace_id
    WHERE et.workspace_id = ${user.workspaceId} AND et.entity_type = ${parsedType.data}
      AND et.entity_id = ${entityId}
    ORDER BY lower(t.name)
  `;
  return context.json({ tags });
});

crmConfigRoutes.put("/crm/entities/:entityType/:id/tags", async (context) => {
  const user = context.get("user");
  const parsedType = entityTypeSchema.safeParse(context.req.param("entityType"));
  if (!parsedType.success) return context.json({ error: "Invalid entity type." }, 422);
  const entityId = context.req.param("id");
  if (!(await entityAccess(user, parsedType.data, entityId))) {
    return context.json({ error: "Record not found." }, 404);
  }
  const parsed = await parseJson(context, entityTagsSchema);
  if (!parsed.ok) return parsed.response;
  const tags = parsed.data.tagIds.length
    ? await sql<{ id: string }[]>`
        SELECT id FROM crm_tags WHERE workspace_id = ${user.workspaceId}
          AND id = ANY(${parsed.data.tagIds}::uuid[])
      `
    : [];
  if (tags.length !== parsed.data.tagIds.length) {
    return context.json({ error: "One or more tags were not found." }, 422);
  }
  await sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM crm_entity_tags
      WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsedType.data}
        AND entity_id = ${entityId}
    `;
    for (const tag of tags) {
      await transaction`
        INSERT INTO crm_entity_tags (workspace_id, tag_id, entity_type, entity_id, added_by)
        VALUES (${user.workspaceId}, ${tag.id}, ${parsedType.data}, ${entityId}, ${user.id})
      `;
    }
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "crm_tags.updated",
    entityType: parsedType.data,
    entityId,
    summary: { tagIds: parsed.data.tagIds },
  });
  return context.json({ ok: true });
});

crmConfigRoutes.get("/crm/saved-views", async (context) => {
  const user = context.get("user");
  const entityType = context.req.query("entityType") ?? "";
  const views = await sql`
    SELECT id, entity_type AS "entityType", name, filters, columns, sort, shared,
      owner_id AS "ownerId", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM crm_saved_views
    WHERE workspace_id = ${user.workspaceId}
      AND (${entityType} = '' OR entity_type = ${entityType})
      AND (owner_id = ${user.id} OR shared = true)
    ORDER BY shared DESC, lower(name)
  `;
  return context.json({ views });
});

crmConfigRoutes.post("/crm/saved-views", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, savedViewSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.shared && !requireManager(user)) {
    return context.json({ error: "Only Leads can create shared views." }, 403);
  }
  try {
    const [view] = await sql<{ id: string }[]>`
      INSERT INTO crm_saved_views (
        workspace_id, owner_id, entity_type, name, filters, columns, sort, shared
      ) VALUES (
        ${user.workspaceId}, ${user.id}, ${parsed.data.entityType}, ${parsed.data.name},
        ${sql.json(parsed.data.filters as never)}, ${sql.json(parsed.data.columns)},
        ${sql.json(parsed.data.sort as never)},
        ${parsed.data.shared}
      ) RETURNING id
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "crm_saved_view.created",
      entityType: "crm_saved_view",
      entityId: view.id,
      summary: { entityType: parsed.data.entityType, shared: parsed.data.shared },
    });
    return context.json({ id: view.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmConfigRoutes.delete("/crm/saved-views/:id", async (context) => {
  const user = context.get("user");
  const [view] = await sql<{ id: string; ownerId: string }[]>`
    SELECT id, owner_id AS "ownerId" FROM crm_saved_views
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
  `;
  if (!view || (view.ownerId !== user.id && !requireManager(user))) {
    return context.json({ error: "Saved view not found." }, 404);
  }
  await sql`DELETE FROM crm_saved_views WHERE id = ${view.id}`;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "crm_saved_view.deleted",
    entityType: "crm_saved_view",
    entityId: view.id,
  });
  return context.json({ ok: true });
});

crmConfigRoutes.get("/crm/suppressions", async (context) => {
  const user = context.get("user");
  const suppressions = await sql`
    SELECT id, kind, value, reason, active, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM crm_suppressions WHERE workspace_id = ${user.workspaceId}
    ORDER BY active DESC, kind, value
  `;
  return context.json({ suppressions });
});

crmConfigRoutes.post("/crm/suppressions", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, suppressionSchema);
  if (!parsed.ok) return parsed.response;
  const value = cleanSuppressionValue(parsed.data.kind, parsed.data.value);
  try {
    const [suppression] = await sql<{ id: string }[]>`
      INSERT INTO crm_suppressions (workspace_id, kind, value, reason, created_by)
      VALUES (${user.workspaceId}, ${parsed.data.kind}, ${value}, ${parsed.data.reason || null}, ${user.id})
      ON CONFLICT (workspace_id, kind, (lower(value))) DO UPDATE SET
        active = true, reason = EXCLUDED.reason, updated_at = now()
      RETURNING id
    `;
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "crm_suppression.created",
      entityType: "crm_suppression",
      entityId: suppression.id,
      summary: { kind: parsed.data.kind },
    });
    return context.json({ id: suppression.id }, 201);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmConfigRoutes.patch("/crm/suppressions/:id", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, z.object({ active: z.boolean() }));
  if (!parsed.ok) return parsed.response;
  const [suppression] = await sql<{ id: string }[]>`
    UPDATE crm_suppressions SET active = ${parsed.data.active}
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
    RETURNING id
  `;
  if (!suppression) return context.json({ error: "Suppression not found." }, 404);
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: parsed.data.active ? "crm_suppression.enabled" : "crm_suppression.disabled",
    entityType: "crm_suppression",
    entityId: suppression.id,
  });
  return context.json({ ok: true });
});

crmConfigRoutes.post("/crm/bulk", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, bulkSchema);
  if (!parsed.ok) return parsed.response;
  const { entityType, ids, action } = parsed.data;
  for (const id of ids) {
    if (!(await entityAccess(user, entityType, id))) {
      return context.json({ error: "One or more selected records were not found." }, 404);
    }
  }
  if (
    (action === "assign" || (action === "status" && entityType === "account")) &&
    !requireManager(user)
  ) {
    return context.json({ error: "Lead access is required for this bulk action." }, 403);
  }
  if (action === "assign") {
    if (!parsed.data.ownerId) return context.json({ error: "ownerId is required." }, 422);
    const [member] = await sql<{ id: string }[]>`
      SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.id = ${parsed.data.ownerId} AND u.active = true
        AND m.workspace_id = ${user.workspaceId}
    `;
    if (!member) return context.json({ error: "Owner must be an active workspace member." }, 422);
  }
  const validStatuses =
    entityType === "account"
      ? ["research", "pending_approval", "approved", "active", "nurture", "disqualified"]
      : entityType === "contact"
        ? [
            "identified",
            "verified",
            "contacted",
            "engaged",
            "qualified",
            "not_interested",
            "invalid",
          ]
        : [];
  if (action === "status" && (!parsed.data.status || !validStatuses.includes(parsed.data.status))) {
    return context.json({ error: "A supported status is required for this record type." }, 422);
  }
  if (action === "tag") {
    if (!parsed.data.tagId) return context.json({ error: "tagId is required." }, 422);
    const [tag] = await sql<{ id: string }[]>`
      SELECT id FROM crm_tags WHERE id = ${parsed.data.tagId} AND workspace_id = ${user.workspaceId}
    `;
    if (!tag) return context.json({ error: "Tag not found." }, 404);
  }

  await sql.begin(async (transaction) => {
    if (action === "tag" && parsed.data.tagId) {
      for (const id of ids) {
        await transaction`
          INSERT INTO crm_entity_tags (workspace_id, tag_id, entity_type, entity_id, added_by)
          VALUES (${user.workspaceId}, ${parsed.data.tagId}, ${entityType}, ${id}, ${user.id})
          ON CONFLICT DO NOTHING
        `;
      }
      return;
    }
    const archivedAt = action === "archive" ? new Date().toISOString() : null;
    if (entityType === "account") {
      if (action === "assign") {
        await transaction`UPDATE accounts SET owner_id = ${parsed.data.ownerId!} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
        await cascadeAccountOwner(transaction, user.workspaceId, ids);
      } else if (action === "status") {
        await transaction`UPDATE accounts SET status = ${parsed.data.status!} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
      } else {
        await transaction`UPDATE accounts SET archived_at = ${archivedAt} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
      }
    } else if (entityType === "contact") {
      if (action === "assign") {
        await transaction`UPDATE contacts SET owner_id = ${parsed.data.ownerId!} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
      } else if (action === "status") {
        await transaction`UPDATE contacts SET status = ${parsed.data.status!} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
      } else {
        await transaction`UPDATE contacts SET archived_at = ${archivedAt} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
      }
    } else if (action === "assign") {
      await transaction`UPDATE opportunities SET owner_id = ${parsed.data.ownerId!} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
    } else {
      await transaction`UPDATE opportunities SET archived_at = ${archivedAt} WHERE workspace_id = ${user.workspaceId} AND id = ANY(${ids}::uuid[])`;
    }
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: `crm_bulk.${action}`,
    entityType,
    summary: {
      ids,
      ownerId: parsed.data.ownerId,
      status: parsed.data.status,
      tagId: parsed.data.tagId,
    },
  });
  return context.json({ ok: true, updated: ids.length });
});

crmConfigRoutes.get("/crm/duplicates", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const entityType = context.req.query("entityType");
  if (entityType !== "account" && entityType !== "contact") {
    return context.json({ error: "entityType must be account or contact." }, 422);
  }
  if (entityType === "account") {
    const groups = await sql`
      WITH candidates AS (
        SELECT regexp_replace(lower(name), '[^a-z0-9]', '', 'g') AS match_key
        FROM accounts
        WHERE workspace_id = ${user.workspaceId} AND archived_at IS NULL
          AND regexp_replace(lower(name), '[^a-z0-9]', '', 'g') <> ''
        GROUP BY regexp_replace(lower(name), '[^a-z0-9]', '', 'g')
        HAVING count(*) > 1
      )
      SELECT c.match_key AS "matchKey",
        json_agg(json_build_object(
          'id', a.id, 'name', a.name, 'domain', a.domain, 'ownerName', u.name,
          'createdAt', a.created_at
        ) ORDER BY a.created_at) AS records
      FROM candidates c
      JOIN accounts a ON regexp_replace(lower(a.name), '[^a-z0-9]', '', 'g') = c.match_key
        AND a.workspace_id = ${user.workspaceId} AND a.archived_at IS NULL
      LEFT JOIN users u ON u.id = a.owner_id
      GROUP BY c.match_key
      ORDER BY c.match_key
    `;
    return context.json({ entityType, groups });
  }
  const groups = await sql`
    WITH candidates AS (
      SELECT account_id, lower(concat_ws(' ', first_name, last_name)) AS match_key
      FROM contacts
      WHERE workspace_id = ${user.workspaceId} AND archived_at IS NULL
      GROUP BY account_id, lower(concat_ws(' ', first_name, last_name))
      HAVING count(*) > 1
    )
    SELECT c.match_key AS "matchKey", a.name AS "accountName",
      json_agg(json_build_object(
        'id', p.id, 'name', concat_ws(' ', p.first_name, p.last_name), 'email', p.email,
        'title', p.title, 'ownerName', u.name, 'createdAt', p.created_at
      ) ORDER BY p.created_at) AS records
    FROM candidates c
    JOIN accounts a ON a.id = c.account_id
    JOIN contacts p ON p.account_id = c.account_id
      AND lower(concat_ws(' ', p.first_name, p.last_name)) = c.match_key
      AND p.workspace_id = ${user.workspaceId} AND p.archived_at IS NULL
    LEFT JOIN users u ON u.id = p.owner_id
    GROUP BY c.match_key, a.name
    ORDER BY a.name, c.match_key
  `;
  return context.json({ entityType, groups });
});

crmConfigRoutes.post("/crm/merge", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) return context.json({ error: "Lead access is required." }, 403);
  const parsed = await parseJson(context, mergeSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.primaryId === parsed.data.duplicateId) {
    return context.json({ error: "Choose two different records." }, 422);
  }
  const primary = await entityAccess(user, parsed.data.entityType, parsed.data.primaryId);
  const duplicate = await entityAccess(user, parsed.data.entityType, parsed.data.duplicateId);
  if (!primary || !duplicate)
    return context.json({ error: "One or more records were not found." }, 404);
  const states = await sql<
    { id: string; archivedAt: string | null; mergedIntoId: string | null }[]
  >`
    SELECT id, archived_at AS "archivedAt", merged_into_id AS "mergedIntoId"
    FROM ${sql(parsed.data.entityType === "account" ? "accounts" : "contacts")}
    WHERE id IN (${parsed.data.primaryId}, ${parsed.data.duplicateId})
      AND workspace_id = ${user.workspaceId}
  `;
  const primaryState = states.find((state) => state.id === parsed.data.primaryId);
  const duplicateState = states.find((state) => state.id === parsed.data.duplicateId);
  if (primaryState?.archivedAt || primaryState?.mergedIntoId) {
    return context.json({ error: "Restore the primary record before merging into it." }, 409);
  }
  if (duplicateState?.mergedIntoId) {
    return context.json({ error: "This duplicate has already been merged." }, 409);
  }

  await sql.begin(async (transaction) => {
    if (parsed.data.entityType === "account") {
      await transaction`
        UPDATE contacts SET account_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND account_id = ${parsed.data.duplicateId}
      `;
      await transaction`
        UPDATE opportunities SET account_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND account_id = ${parsed.data.duplicateId}
      `;
      await cascadeAccountOwner(transaction, user.workspaceId, [parsed.data.primaryId]);
      await transaction`
        UPDATE account_signals SET account_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND account_id = ${parsed.data.duplicateId}
      `;
      await transaction`
        UPDATE approvals SET status = 'cancelled', reviewer_id = ${user.id}, decided_at = now()
        WHERE workspace_id = ${user.workspaceId} AND subject_type = 'account'
          AND subject_id = ${parsed.data.duplicateId} AND status = 'pending'
      `;
      await transaction`
        UPDATE approvals SET subject_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND subject_type = 'account'
          AND subject_id = ${parsed.data.duplicateId}
      `;
      await transaction`
        WITH RECURSIVE descendants AS (
          SELECT id FROM accounts
          WHERE parent_account_id = ${parsed.data.duplicateId} AND workspace_id = ${user.workspaceId}
          UNION
          SELECT a.id FROM accounts a JOIN descendants d ON a.parent_account_id = d.id
          WHERE a.workspace_id = ${user.workspaceId}
        )
        UPDATE accounts SET parent_account_id = NULL
        WHERE workspace_id = ${user.workspaceId} AND id = ${parsed.data.primaryId}
          AND id IN (SELECT id FROM descendants)
      `;
      await transaction`
        UPDATE accounts SET parent_account_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND parent_account_id = ${parsed.data.duplicateId}
          AND id <> ${parsed.data.primaryId}
      `;
    } else {
      await transaction`
        UPDATE opportunities SET primary_contact_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND primary_contact_id = ${parsed.data.duplicateId}
      `;
      await transaction`
        INSERT INTO opportunity_contacts (
          workspace_id, opportunity_id, contact_id, role, is_primary, created_by, created_at
        )
        SELECT workspace_id, opportunity_id, ${parsed.data.primaryId}, role, false, created_by, created_at
        FROM opportunity_contacts
        WHERE workspace_id = ${user.workspaceId} AND contact_id = ${parsed.data.duplicateId}
        ON CONFLICT (opportunity_id, contact_id) DO NOTHING
      `;
      await transaction`
        DELETE FROM opportunity_contacts
        WHERE workspace_id = ${user.workspaceId} AND contact_id = ${parsed.data.duplicateId}
      `;
      await transaction`
        UPDATE opportunity_contacts oc SET is_primary = true
        FROM opportunities o
        WHERE oc.workspace_id = ${user.workspaceId} AND oc.contact_id = ${parsed.data.primaryId}
          AND o.id = oc.opportunity_id AND o.primary_contact_id = ${parsed.data.primaryId}
      `;
      await transaction`
        DELETE FROM contact_channel_states duplicate
        USING contact_channel_states primary_state
        WHERE duplicate.workspace_id = ${user.workspaceId}
          AND duplicate.contact_id = ${parsed.data.duplicateId}
          AND primary_state.workspace_id = duplicate.workspace_id
          AND primary_state.contact_id = ${parsed.data.primaryId}
          AND primary_state.channel = duplicate.channel
      `;
      await transaction`
        UPDATE contact_channel_states SET contact_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND contact_id = ${parsed.data.duplicateId}
      `;
    }
    const linkColumn = parsed.data.entityType === "account" ? "account_id" : "contact_id";
    for (const table of [
      "activities",
      "crm_email_threads",
      "crm_calendar_events",
      "mail_conversations",
      "mail_drafts",
    ]) {
      await transaction`
        UPDATE ${transaction(table)} SET ${transaction(linkColumn)} = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId}
          AND ${transaction(linkColumn)} = ${parsed.data.duplicateId}
      `;
    }
    for (const table of ["work_items", "crm_import_records", "crm_enrichment_evidence"]) {
      await transaction`
        UPDATE ${transaction(table)} SET entity_id = ${parsed.data.primaryId}
        WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsed.data.entityType}
          AND entity_id = ${parsed.data.duplicateId}
      `;
    }
    await transaction`
      DELETE FROM crm_external_mappings duplicate
      USING crm_external_mappings primary_mapping
      WHERE duplicate.workspace_id = ${user.workspaceId}
        AND duplicate.entity_type = ${parsed.data.entityType}
        AND duplicate.entity_id = ${parsed.data.duplicateId}
        AND primary_mapping.workspace_id = duplicate.workspace_id
        AND primary_mapping.provider = duplicate.provider
        AND primary_mapping.entity_type = duplicate.entity_type
        AND primary_mapping.entity_id = ${parsed.data.primaryId}
    `;
    await transaction`
      UPDATE crm_external_mappings SET entity_id = ${parsed.data.primaryId}
      WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsed.data.entityType}
        AND entity_id = ${parsed.data.duplicateId}
    `;
    await transaction`
      INSERT INTO crm_entity_tags (workspace_id, tag_id, entity_type, entity_id, added_by, added_at)
      SELECT workspace_id, tag_id, entity_type, ${parsed.data.primaryId}, added_by, added_at
      FROM crm_entity_tags
      WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsed.data.entityType}
        AND entity_id = ${parsed.data.duplicateId}
      ON CONFLICT DO NOTHING
    `;
    await transaction`
      DELETE FROM crm_entity_tags
      WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsed.data.entityType}
        AND entity_id = ${parsed.data.duplicateId}
    `;
    await transaction`
      INSERT INTO crm_field_values (
        workspace_id, field_definition_id, entity_type, entity_id, value, updated_by, updated_at
      )
      SELECT workspace_id, field_definition_id, entity_type, ${parsed.data.primaryId}, value,
        updated_by, updated_at
      FROM crm_field_values
      WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsed.data.entityType}
        AND entity_id = ${parsed.data.duplicateId}
      ON CONFLICT (field_definition_id, entity_id) DO NOTHING
    `;
    await transaction`
      DELETE FROM crm_field_values
      WHERE workspace_id = ${user.workspaceId} AND entity_type = ${parsed.data.entityType}
        AND entity_id = ${parsed.data.duplicateId}
    `;
    if (parsed.data.entityType === "account") {
      const [source] = await transaction<
        {
          domain: string | null;
          normalizedDomain: string | null;
          linkedinUrl: string | null;
          normalizedLinkedinUrl: string | null;
        }[]
      >`
        SELECT domain, normalized_domain AS "normalizedDomain", linkedin_url AS "linkedinUrl",
          normalized_linkedin_url AS "normalizedLinkedinUrl"
        FROM accounts WHERE id = ${parsed.data.duplicateId} AND workspace_id = ${user.workspaceId}
      `;
      await transaction`
        UPDATE accounts SET archived_at = now(), merged_into_id = ${parsed.data.primaryId},
          normalized_domain = NULL, normalized_linkedin_url = NULL
        WHERE id = ${parsed.data.duplicateId} AND workspace_id = ${user.workspaceId}
      `;
      await transaction`
        UPDATE accounts SET
          domain = CASE WHEN normalized_domain IS NULL AND ${source.normalizedDomain}::text IS NOT NULL THEN ${source.domain} ELSE domain END,
          normalized_domain = coalesce(normalized_domain, ${source.normalizedDomain}),
          linkedin_url = CASE WHEN normalized_linkedin_url IS NULL AND ${source.normalizedLinkedinUrl}::text IS NOT NULL THEN ${source.linkedinUrl} ELSE linkedin_url END,
          normalized_linkedin_url = coalesce(normalized_linkedin_url, ${source.normalizedLinkedinUrl})
        WHERE id = ${parsed.data.primaryId} AND workspace_id = ${user.workspaceId}
      `;
    } else {
      const [source] = await transaction<
        {
          email: string | null;
          normalizedEmail: string | null;
          linkedinUrl: string | null;
          normalizedLinkedinUrl: string | null;
        }[]
      >`
        SELECT email, normalized_email AS "normalizedEmail", linkedin_url AS "linkedinUrl",
          normalized_linkedin_url AS "normalizedLinkedinUrl"
        FROM contacts WHERE id = ${parsed.data.duplicateId} AND workspace_id = ${user.workspaceId}
      `;
      await transaction`
        UPDATE contacts SET archived_at = now(), merged_into_id = ${parsed.data.primaryId},
          normalized_email = NULL, normalized_linkedin_url = NULL
        WHERE id = ${parsed.data.duplicateId} AND workspace_id = ${user.workspaceId}
      `;
      await transaction`
        UPDATE contacts SET
          email = CASE WHEN normalized_email IS NULL AND ${source.normalizedEmail}::text IS NOT NULL THEN ${source.email} ELSE email END,
          normalized_email = coalesce(normalized_email, ${source.normalizedEmail}),
          linkedin_url = CASE WHEN normalized_linkedin_url IS NULL AND ${source.normalizedLinkedinUrl}::text IS NOT NULL THEN ${source.linkedinUrl} ELSE linkedin_url END,
          normalized_linkedin_url = coalesce(normalized_linkedin_url, ${source.normalizedLinkedinUrl})
        WHERE id = ${parsed.data.primaryId} AND workspace_id = ${user.workspaceId}
      `;
    }
  });
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: `${parsed.data.entityType}.merged`,
    entityType: parsed.data.entityType,
    entityId: parsed.data.primaryId,
    summary: { duplicateId: parsed.data.duplicateId },
  });
  return context.json({ ok: true, id: parsed.data.primaryId });
});

crmConfigRoutes.get("/crm/export/:entityType", async (context) => {
  const user = context.get("user");
  const parsedType = z
    .enum(["account", "contact", "lead", "opportunity"])
    .safeParse(context.req.param("entityType"));
  if (!parsedType.success) return context.json({ error: "Invalid entity type." }, 422);
  const includeArchived = context.req.query("includeArchived") === "true" && requireManager(user);
  const ownerId = user.role === "ic" ? user.id : null;
  const filters = z
    .object({
      search: z.string().trim().max(200).default(""),
      status: z.string().trim().max(80).default(""),
      consentStatus: z.string().trim().max(80).default(""),
      accountId: z.string().uuid().optional(),
      archived: z.enum(["active", "archived", "all"]).optional(),
    })
    .safeParse(context.req.query());
  if (!filters.success) return context.json({ error: "Invalid export filters." }, 422);
  const { search, consentStatus } = filters.data;
  const status = parsedType.data === "lead" ? "identified" : filters.data.status;
  const accountId = filters.data.accountId ?? null;
  const archived = requireManager(user)
    ? (filters.data.archived ?? (includeArchived ? "all" : "active"))
    : "active";
  const timestamp = new Date().toISOString().slice(0, 10);

  if (parsedType.data === "account") {
    const headers = [
      "id",
      "name",
      "domain",
      "linkedin_url",
      "website_url",
      "owner_name",
      "tier",
      "status",
      "country",
      "state",
      "city",
      "employee_range",
      "industry",
      "product_motion",
      "source",
      "fit_summary",
      "evidence_summary",
      "trigger_summary",
      "score",
      "next_action",
      "next_action_at",
      "last_activity_at",
      "external_source",
      "external_id",
      "archived_at",
      "created_at",
      "updated_at",
    ];
    const rows = await sql<Record<string, string | number | null>[]>`
      SELECT a.id, a.name, a.domain, a.linkedin_url, a.website_url, u.name AS owner_name,
        a.tier, a.status, a.country, a.state, a.city, a.employee_range, a.industry, a.product_motion, a.source, a.fit_summary,
        a.evidence_summary, a.trigger_summary, a.score, a.next_action, a.next_action_at,
        a.last_activity_at, a.external_source, a.external_id, a.archived_at, a.created_at, a.updated_at
      FROM accounts a LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.workspace_id = ${user.workspaceId}
        AND (${ownerId}::uuid IS NULL OR a.owner_id = ${ownerId})
        AND (${status} = '' OR a.status = ${status})
        AND (${search} = '' OR a.name ILIKE ${`%${search}%`} OR coalesce(a.domain, '') ILIKE ${`%${search}%`} OR coalesce(a.industry, '') ILIKE ${`%${search}%`})
        AND (${archived} = 'all' OR (${archived} = 'active' AND a.archived_at IS NULL) OR (${archived} = 'archived' AND a.archived_at IS NOT NULL))
      ORDER BY lower(a.name), a.created_at
    `;
    return csvResponse(
      context,
      `orbit-accounts-${timestamp}.csv`,
      serializeCsv(headers, rows, { includeBom: true }),
    );
  }

  if (parsedType.data === "contact" || parsedType.data === "lead") {
    const headers = [
      "id",
      "first_name",
      "last_name",
      "account_name",
      "account_domain",
      "owner_name",
      "title",
      "department",
      "email",
      "linkedin_url",
      "phone",
      "country",
      "state",
      "city",
      "buyer_role",
      "status",
      "consent_status",
      "preferred_channel",
      "notes",
      "external_source",
      "external_id",
      "archived_at",
      "created_at",
      "updated_at",
    ];
    const rows = await sql<Record<string, string | number | null>[]>`
      SELECT c.id, c.first_name, c.last_name, a.name AS account_name, a.domain AS account_domain,
        u.name AS owner_name, c.title, c.department, c.email, c.linkedin_url, c.phone,
        c.country, c.state, c.city, c.buyer_role, c.status, c.consent_status, c.preferred_channel, c.notes,
        c.external_source, c.external_id, c.archived_at, c.created_at, c.updated_at
      FROM contacts c
      JOIN accounts a ON a.id = c.account_id AND a.workspace_id = c.workspace_id
      LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.workspace_id = ${user.workspaceId}
        AND (${ownerId}::uuid IS NULL OR c.owner_id = ${ownerId})
        AND (${status} = '' OR c.status = ${status})
        AND (${consentStatus} = '' OR c.consent_status = ${consentStatus})
        AND (${accountId}::uuid IS NULL OR c.account_id = ${accountId})
        AND (${search} = '' OR concat_ws(' ', c.first_name, c.last_name, c.email, c.title, a.name, u.name) ILIKE ${`%${search}%`})
        AND (${archived} = 'all' OR (${archived} = 'active' AND c.archived_at IS NULL) OR (${archived} = 'archived' AND c.archived_at IS NOT NULL))
      ORDER BY lower(c.first_name), lower(coalesce(c.last_name, '')), c.created_at
    `;
    return csvResponse(
      context,
      `orbit-${parsedType.data === "lead" ? "leads" : "contacts"}-${timestamp}.csv`,
      serializeCsv(headers, rows, { includeBom: true }),
    );
  }

  const headers = [
    "id",
    "name",
    "account_name",
    "account_domain",
    "owner_name",
    "stage",
    "value_amount",
    "currency",
    "problem_summary",
    "next_action",
    "next_action_at",
    "expected_close_at",
    "loss_reason",
    "stage_entered_at",
    "closed_at",
    "external_source",
    "external_id",
    "archived_at",
    "created_at",
    "updated_at",
  ];
  const rows = await sql<Record<string, string | number | null>[]>`
    SELECT o.id, o.name, a.name AS account_name, a.domain AS account_domain,
      u.name AS owner_name, s.name AS stage, o.value_amount, o.currency, o.problem_summary,
      o.next_action, o.next_action_at, o.expected_close_at, o.loss_reason,
      o.stage_entered_at, o.closed_at, o.external_source, o.external_id, o.archived_at,
      o.created_at, o.updated_at
    FROM opportunities o
    JOIN accounts a ON a.id = o.account_id AND a.workspace_id = o.workspace_id
    JOIN opportunity_stages s ON s.id = o.stage_id AND s.workspace_id = o.workspace_id
    LEFT JOIN users u ON u.id = o.owner_id
    WHERE o.workspace_id = ${user.workspaceId}
      AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
      AND (${accountId}::uuid IS NULL OR o.account_id = ${accountId})
      AND (${status} = '' OR s.key = ${status})
      AND (${search} = '' OR o.name ILIKE ${`%${search}%`} OR a.name ILIKE ${`%${search}%`})
      AND (${archived} = 'all' OR (${archived} = 'active' AND o.archived_at IS NULL) OR (${archived} = 'archived' AND o.archived_at IS NOT NULL))
    ORDER BY o.created_at DESC
  `;
  return csvResponse(
    context,
    `orbit-opportunities-${timestamp}.csv`,
    serializeCsv(headers, rows, { includeBom: true }),
  );
});

crmConfigRoutes.get("/crm/reports", async (context) => {
  const user = context.get("user");
  const ownerId = user.role === "ic" ? user.id : null;
  const [summaryRows, byStage, closingSoon, overdue, trend] = await Promise.all([
    sql<
      {
        openCount: number;
        openValue: string;
        weightedValue: string;
        wonThisMonth: number;
        wonValueThisMonth: string;
        winRate: string;
        averageWonDeal: string;
        averageCycleDays: string;
      }[]
    >`
      SELECT
        count(*) FILTER (WHERE s.terminal = false)::int AS "openCount",
        coalesce(sum(o.value_amount) FILTER (WHERE s.terminal = false), 0)::text AS "openValue",
        coalesce(sum(o.value_amount * s.probability / 100.0) FILTER (WHERE s.terminal = false), 0)::text AS "weightedValue",
        count(*) FILTER (WHERE s.won = true AND o.closed_at >= date_trunc('month', now()))::int AS "wonThisMonth",
        coalesce(sum(o.value_amount) FILTER (WHERE s.won = true AND o.closed_at >= date_trunc('month', now())), 0)::text AS "wonValueThisMonth",
        coalesce(
          100.0 * count(*) FILTER (WHERE s.won = true AND o.closed_at >= now() - interval '90 days') /
          nullif(count(*) FILTER (WHERE s.terminal = true AND o.closed_at >= now() - interval '90 days'), 0),
          0
        )::text AS "winRate",
        coalesce(avg(o.value_amount) FILTER (WHERE s.won = true), 0)::text AS "averageWonDeal",
        coalesce(avg(extract(epoch FROM (o.closed_at - o.created_at)) / 86400.0) FILTER (WHERE s.won = true), 0)::text AS "averageCycleDays"
      FROM opportunities o
      JOIN opportunity_stages s ON s.id = o.stage_id AND s.workspace_id = o.workspace_id
      WHERE o.workspace_id = ${user.workspaceId} AND o.archived_at IS NULL
        AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
    `,
    sql`
      SELECT s.id, s.name, s.position, s.probability,
        count(o.id)::int AS count,
        coalesce(sum(o.value_amount), 0)::text AS value,
        coalesce(sum(o.value_amount * s.probability / 100.0), 0)::text AS "weightedValue",
        coalesce(avg(extract(epoch FROM (now() - o.stage_entered_at)) / 86400.0), 0)::text AS "averageAgeDays"
      FROM opportunity_stages s
      LEFT JOIN opportunities o ON o.stage_id = s.id AND o.workspace_id = s.workspace_id
        AND o.archived_at IS NULL AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
      WHERE s.workspace_id = ${user.workspaceId}
      GROUP BY s.id
      ORDER BY s.position
    `,
    sql`
      SELECT o.id, o.name, a.name AS "accountName", o.value_amount AS "valueAmount",
        o.currency, o.expected_close_at AS "expectedCloseAt", s.name AS "stageName",
        owner.name AS "ownerName"
      FROM opportunities o
      JOIN accounts a ON a.id = o.account_id AND a.workspace_id = o.workspace_id
      JOIN opportunity_stages s ON s.id = o.stage_id AND s.workspace_id = o.workspace_id
      LEFT JOIN users owner ON owner.id = o.owner_id
      WHERE o.workspace_id = ${user.workspaceId} AND o.archived_at IS NULL
        AND s.terminal = false AND o.expected_close_at BETWEEN current_date AND current_date + 30
        AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
      ORDER BY o.expected_close_at, o.value_amount DESC NULLS LAST
      LIMIT 25
    `,
    sql`
      SELECT o.id, o.name, a.name AS "accountName", o.next_action AS "nextAction",
        o.next_action_at AS "nextActionAt", s.name AS "stageName", owner.name AS "ownerName"
      FROM opportunities o
      JOIN accounts a ON a.id = o.account_id AND a.workspace_id = o.workspace_id
      JOIN opportunity_stages s ON s.id = o.stage_id AND s.workspace_id = o.workspace_id
      LEFT JOIN users owner ON owner.id = o.owner_id
      WHERE o.workspace_id = ${user.workspaceId} AND o.archived_at IS NULL
        AND s.terminal = false AND o.next_action_at < now()
        AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
      ORDER BY o.next_action_at
      LIMIT 25
    `,
    sql`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month'
        ) AS month
      )
      SELECT to_char(m.month, 'YYYY-MM') AS month,
        count(o.id) FILTER (WHERE o.created_at >= m.month AND o.created_at < m.month + interval '1 month')::int AS created,
        count(o.id) FILTER (WHERE s.won = true AND o.closed_at >= m.month AND o.closed_at < m.month + interval '1 month')::int AS won
      FROM months m
      LEFT JOIN opportunities o ON o.workspace_id = ${user.workspaceId}
        AND o.archived_at IS NULL AND (${ownerId}::uuid IS NULL OR o.owner_id = ${ownerId})
      LEFT JOIN opportunity_stages s ON s.id = o.stage_id
      GROUP BY m.month
      ORDER BY m.month
    `,
  ]);
  return context.json({ summary: summaryRows[0], byStage, closingSoon, overdue, trend });
});

crmConfigRoutes.get("/crm/connections", async (context) => {
  const user = context.get("user");
  const connections = await sql`
    SELECT id, provider, account_email AS "accountEmail", status, scopes,
      sync_mail AS "syncMail", sync_calendar AS "syncCalendar",
      auto_create_contacts AS "autoCreateContacts", last_synced_at AS "lastSyncedAt",
      last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM crm_connections
    WHERE workspace_id = ${user.workspaceId} AND user_id = ${user.id}
    ORDER BY provider, account_email
  `;
  return context.json({ connections, mode: "read_only" });
});

crmConfigRoutes.patch("/crm/connections/:id", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(
    context,
    z.object({
      syncMail: z.boolean().optional(),
      syncCalendar: z.boolean().optional(),
      autoCreateContacts: z.boolean().optional(),
    }),
  );
  if (!parsed.ok) return parsed.response;
  const [current] = await sql<any[]>`
    SELECT * FROM crm_connections
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
      AND user_id = ${user.id} AND status <> 'revoked'
  `;
  if (!current) return context.json({ error: "Connection not found." }, 404);
  await sql`
    UPDATE crm_connections SET
      sync_mail = ${parsed.data.syncMail ?? current.sync_mail},
      sync_calendar = ${parsed.data.syncCalendar ?? current.sync_calendar},
      auto_create_contacts = ${parsed.data.autoCreateContacts ?? current.auto_create_contacts}
    WHERE id = ${current.id}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "crm_connection.settings_updated",
    entityType: "crm_connection",
    entityId: current.id,
  });
  return context.json({ ok: true });
});

crmConfigRoutes.delete("/crm/connections/:id", async (context) => {
  const user = context.get("user");
  const [connection] = await sql<{ id: string }[]>`
    UPDATE crm_connections SET status = 'revoked', sync_mail = false, sync_calendar = false
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
      AND user_id = ${user.id} AND status <> 'revoked'
    RETURNING id
  `;
  if (!connection) return context.json({ error: "Connection not found." }, 404);
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "crm_connection.revoked",
    entityType: "crm_connection",
    entityId: connection.id,
  });
  return context.json({ ok: true });
});

crmConfigRoutes.get("/crm/sync/:entityType/:id", async (context) => {
  const user = context.get("user");
  const parsedType = entityTypeSchema.safeParse(context.req.param("entityType"));
  if (!parsedType.success) return context.json({ error: "Invalid entity type." }, 422);
  const entityId = context.req.param("id");
  if (!(await entityAccess(user, parsedType.data, entityId))) {
    return context.json({ error: "Record not found." }, 404);
  }
  const accountId = parsedType.data === "account" ? entityId : null;
  const contactId = parsedType.data === "contact" ? entityId : null;
  const opportunityId = parsedType.data === "opportunity" ? entityId : null;
  const [threads, events] = await Promise.all([
    sql`
      SELECT t.id, t.subject, t.snippet, t.latest_message_at AS "latestMessageAt",
        c.provider, c.account_email AS "accountEmail",
        count(m.id)::int AS "messageCount"
      FROM crm_email_threads t
      JOIN crm_connections c ON c.id = t.connection_id AND c.workspace_id = t.workspace_id
      LEFT JOIN crm_email_messages m ON m.thread_id = t.id
      WHERE t.workspace_id = ${user.workspaceId}
        AND (${accountId}::uuid IS NULL OR t.account_id = ${accountId})
        AND (${contactId}::uuid IS NULL OR t.contact_id = ${contactId})
        AND (${opportunityId}::uuid IS NULL OR t.opportunity_id = ${opportunityId})
      GROUP BY t.id, c.provider, c.account_email
      ORDER BY t.latest_message_at DESC NULLS LAST
      LIMIT 50
    `,
    sql`
      SELECT e.id, e.title, e.description, e.starts_at AS "startsAt", e.ends_at AS "endsAt",
        e.location, e.meeting_url AS "meetingUrl", e.attendees,
        c.provider, c.account_email AS "accountEmail"
      FROM crm_calendar_events e
      JOIN crm_connections c ON c.id = e.connection_id AND c.workspace_id = e.workspace_id
      WHERE e.workspace_id = ${user.workspaceId}
        AND (${accountId}::uuid IS NULL OR e.account_id = ${accountId})
        AND (${contactId}::uuid IS NULL OR e.contact_id = ${contactId})
        AND (${opportunityId}::uuid IS NULL OR e.opportunity_id = ${opportunityId})
      ORDER BY e.starts_at DESC
      LIMIT 50
    `,
  ]);
  return context.json({ threads, events, mode: "read_only" });
});

crmConfigRoutes.post("/crm/staged-import/preview", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) {
    return context.json({ error: "Only a Lead can preview staged CRM imports." }, 403);
  }
  const parsed = await parseJson(context, stagedOutreachImportSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const preview = await buildStagedOutreachPlan(user.workspaceId, parsed.data);
    return context.json(publicStagedOutreachPreview(preview));
  } catch (error) {
    return databaseError(context, error);
  }
});

crmConfigRoutes.post("/crm/staged-import/commit", async (context) => {
  const user = context.get("user");
  if (!requireManager(user)) {
    return context.json({ error: "Only a Lead can commit staged CRM imports." }, 403);
  }
  const parsed = await parseJson(context, stagedOutreachCommitSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const committed = await commitStagedOutreachImport(user.workspaceId, user.id, parsed.data);
    if (!committed.ok) {
      return context.json(
        {
          error:
            committed.reason === "name_match_approval"
              ? "Review and accept the unique name-only matches before importing."
              : "Resolve the blocking import conflicts before importing.",
          reason: committed.reason,
          preview: publicStagedOutreachPreview(committed.preview),
        },
        409,
      );
    }
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "crm_staged_import.completed",
      entityType: "account",
      summary: {
        source: parsed.data.source,
        label: parsed.data.label,
        ...committed.result,
      },
    });
    return context.json(committed);
  } catch (error) {
    return databaseError(context, error);
  }
});

crmConfigRoutes.post("/crm/import/preview", async (context) => {
  const parsed = await parseJson(context, importSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = parseCsv(parsed.data.csv, { maxRows: 2_000 });
    const normalizedHeaders = Object.keys(
      normalizedCsvRow(Object.fromEntries(result.headers.map((header) => [header, ""]))),
    );
    const required =
      parsed.data.entityType === "account" ? ["name"] : ["first_name", "account_domain"];
    const missing = required.filter((header) => !normalizedHeaders.includes(header));
    return context.json({
      entityType: parsed.data.entityType,
      headers: result.headers,
      normalizedHeaders,
      rowCount: result.rows.length,
      sample: result.rows.slice(0, 10),
      missingRequiredHeaders: missing,
      valid: missing.length === 0 && result.rows.length > 0,
    });
  } catch (error) {
    if (error instanceof CsvParseError) return context.json({ error: error.message }, 422);
    throw error;
  }
});

crmConfigRoutes.post("/crm/import", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, importSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const csv = parseCsv(parsed.data.csv, { maxRows: 2_000 });
    const rows = csv.rows.map(normalizedCsvRow);
    let created = 0;
    let updated = 0;
    const issues: Array<{ row: number; message: string; kind: "duplicate" | "failed" }> = [];
    let duplicates = 0;
    let failed = 0;
    const addIssue = (row: number, message: string, kind: "duplicate" | "failed" = "failed") => {
      issues.push({ row, message, kind });
      if (kind === "duplicate") duplicates += 1;
      else failed += 1;
    };

    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${user.workspaceId}, 0))`;
      for (const [index, row] of rows.entries()) {
        const rowNumber = index + 2;
        try {
          await transaction.savepoint(async (transaction) => {
            const validation = validateImportRow(row, parsed.data.entityType);
            if (validation) {
              addIssue(rowNumber, validation);
              return;
            }
            if (parsed.data.entityType === "account") {
              const normalizedDomain = normalizeDomain(row.domain ?? "");
              const linkedin = normalizeLinkedInUrl(row.linkedin_url);
              const matches = await transaction<
                { id: string; ownerId: string | null; archivedAt: string | null }[]
              >`
            SELECT id, owner_id AS "ownerId", archived_at AS "archivedAt" FROM accounts
            WHERE workspace_id = ${user.workspaceId} AND (
              (${normalizedDomain}::text IS NOT NULL AND normalized_domain = ${normalizedDomain})
              OR (${linkedin}::text IS NOT NULL AND normalized_linkedin_url = ${linkedin})
              OR lower(trim(name)) = ${row.name.toLowerCase().trim()}
              OR (${row.external_id || null}::text IS NOT NULL AND external_id = ${row.external_id || null}
                AND external_source = ${row.external_source || currentImportSource(parsed.data.entityType)})
            )
          `;
              if (matches.length > 1) {
                addIssue(rowNumber, "identity fields match multiple accounts");
                return;
              }
              const existing = matches[0];
              if (existing) {
                if (parsed.data.mode !== "upsert") {
                  addIssue(rowNumber, "a matching account already exists", "duplicate");
                  return;
                }
                if (existing.archivedAt) {
                  addIssue(rowNumber, "restore the matching record before updating");
                  return;
                }
                if (user.role === "ic" && existing.ownerId !== user.id) {
                  addIssue(rowNumber, "you do not own the matching account");
                  return;
                }
                await transaction`
              UPDATE accounts SET
                name = ${row.name},
                domain = CASE WHEN ${"domain" in row} THEN ${row.domain || null} ELSE domain END,
                normalized_domain = CASE WHEN ${"domain" in row} THEN ${normalizeDomain(row.domain)} ELSE normalized_domain END,
                tier = CASE WHEN ${"tier" in row} THEN ${row.tier?.toUpperCase() || "C"} ELSE tier END,
                score = CASE WHEN ${"score" in row} THEN ${Number(row.score || "0")} ELSE score END,
                website_url = CASE WHEN ${"website_url" in row} THEN ${row.website_url || null} ELSE website_url END,
                linkedin_url = CASE WHEN ${"linkedin_url" in row} THEN ${row.linkedin_url || null} ELSE linkedin_url END,
                normalized_linkedin_url = CASE WHEN ${"linkedin_url" in row} THEN ${normalizeLinkedInUrl(row.linkedin_url ?? "")} ELSE normalized_linkedin_url END,
                country = CASE WHEN ${"country" in row} THEN ${row.country || null} ELSE country END,
                state = CASE WHEN ${"state" in row} THEN ${row.state || null} ELSE state END,
                city = CASE WHEN ${"city" in row} THEN ${row.city || null} ELSE city END,
                employee_range = CASE WHEN ${"employee_range" in row} THEN ${row.employee_range || null} ELSE employee_range END,
                industry = CASE WHEN ${"industry" in row} THEN ${row.industry || null} ELSE industry END,
                product_motion = CASE WHEN ${"product_motion" in row} THEN ${row.product_motion || null} ELSE product_motion END,
                source = CASE WHEN ${"source" in row} THEN ${row.source || "csv_import"} ELSE source END,
                fit_summary = CASE WHEN ${"fit_summary" in row} THEN ${row.fit_summary || null} ELSE fit_summary END,
                evidence_summary = CASE WHEN ${"evidence_summary" in row} THEN ${row.evidence_summary || null} ELSE evidence_summary END,
                trigger_summary = CASE WHEN ${"trigger_summary" in row} THEN ${row.trigger_summary || null} ELSE trigger_summary END,
                external_source = CASE WHEN ${"external_source" in row} THEN ${row.external_source || currentImportSource(parsed.data.entityType)} ELSE external_source END,
                external_id = CASE WHEN ${"external_id" in row} THEN ${row.external_id || null} ELSE external_id END
              WHERE id = ${existing.id}
            `;
                updated += 1;
              } else {
                const tier = row.tier?.toUpperCase() || "C";
                await transaction`
              INSERT INTO accounts (
                workspace_id, name, domain, normalized_domain, linkedin_url, normalized_linkedin_url,
                website_url, owner_id, tier, status, country, state, city, employee_range, industry, product_motion, source,
                fit_summary, evidence_summary, trigger_summary, score, external_source, external_id, created_by
              ) VALUES (
                ${user.workspaceId}, ${row.name}, ${row.domain || null}, ${normalizedDomain},
                ${row.linkedin_url || null}, ${normalizeLinkedInUrl(row.linkedin_url ?? "")},
                ${row.website_url || null}, ${user.id}, ${tier}, 'research', ${row.country || null}, ${row.state || null}, ${row.city || null}, ${row.employee_range || null}, ${row.industry || null},
                ${row.product_motion || null}, ${row.source || "csv_import"}, ${row.fit_summary || null},
                ${row.evidence_summary || null}, ${row.trigger_summary || null},
                ${Number(row.score || "0")},
                ${row.external_source || currentImportSource(parsed.data.entityType)}, ${row.external_id || null}, ${user.id}
              )
            `;
                created += 1;
              }
              return;
            }

            const accountDomain = normalizeDomain(row.account_domain);
            const [account] = await transaction<{ id: string; ownerId: string | null }[]>`
          SELECT id, owner_id AS "ownerId" FROM accounts
          WHERE workspace_id = ${user.workspaceId} AND normalized_domain = ${accountDomain}
            AND archived_at IS NULL
        `;
            if (!account || (user.role === "ic" && account.ownerId !== user.id)) {
              addIssue(rowNumber, "a visible account matching account_domain was not found");
              return;
            }
            const normalizedEmail = normalizeEmail(row.email ?? "");
            const linkedin = normalizeLinkedInUrl(row.linkedin_url);
            const matches = await transaction<
              { id: string; ownerId: string | null; archivedAt: string | null; accountId: string }[]
            >`
          SELECT id, owner_id AS "ownerId", archived_at AS "archivedAt", account_id AS "accountId" FROM contacts
          WHERE workspace_id = ${user.workspaceId} AND (
            (${normalizedEmail}::text IS NOT NULL AND normalized_email = ${normalizedEmail})
            OR (${linkedin}::text IS NOT NULL AND normalized_linkedin_url = ${linkedin})
            OR (account_id = ${account.id} AND lower(trim(first_name)) = ${row.first_name.toLowerCase()}
              AND lower(trim(coalesce(last_name, ''))) = ${(row.last_name ?? "").toLowerCase()})
            OR (${row.external_id || null}::text IS NOT NULL AND external_id = ${row.external_id || null}
              AND external_source = ${row.external_source || currentImportSource(parsed.data.entityType)})
          )
        `;
            if (matches.length > 1) {
              addIssue(rowNumber, "identity fields match multiple contacts");
              return;
            }
            const existing = matches[0];
            if (existing) {
              if (parsed.data.mode !== "upsert") {
                addIssue(rowNumber, "a matching contact already exists", "duplicate");
                return;
              }
              if (existing.archivedAt || existing.accountId !== account.id) {
                addIssue(rowNumber, "matching contact is archived or belongs to another account");
                return;
              }
              if (user.role === "ic" && existing.ownerId !== user.id) {
                addIssue(rowNumber, "you do not own the matching contact");
                return;
              }
              await transaction`
            UPDATE contacts SET
              account_id = ${account.id}, first_name = ${row.first_name},
              email = CASE WHEN ${"email" in row} THEN ${row.email || null} ELSE email END,
              normalized_email = CASE WHEN ${"email" in row} THEN ${normalizeEmail(row.email)} ELSE normalized_email END,
              last_name = CASE WHEN ${"last_name" in row} THEN ${row.last_name || null} ELSE last_name END,
              title = CASE WHEN ${"title" in row} THEN ${row.title || null} ELSE title END, department = CASE WHEN ${"department" in row} THEN ${row.department || null} ELSE department END,
              linkedin_url = CASE WHEN ${"linkedin_url" in row} THEN ${row.linkedin_url || null} ELSE linkedin_url END,
              normalized_linkedin_url = CASE WHEN ${"linkedin_url" in row} THEN ${normalizeLinkedInUrl(row.linkedin_url ?? "")} ELSE normalized_linkedin_url END,
              country = CASE WHEN ${"country" in row} THEN ${row.country || null} ELSE country END,
              state = CASE WHEN ${"state" in row} THEN ${row.state || null} ELSE state END,
              city = CASE WHEN ${"city" in row} THEN ${row.city || null} ELSE city END,
              phone = CASE WHEN ${"phone" in row} THEN ${row.phone || null} ELSE phone END, buyer_role = CASE WHEN ${"buyer_role" in row} THEN ${row.buyer_role || null} ELSE buyer_role END, notes = CASE WHEN ${"notes" in row} THEN ${row.notes || null} ELSE notes END,
              external_source = CASE WHEN ${"external_source" in row} THEN ${row.external_source || currentImportSource(parsed.data.entityType)} ELSE external_source END,
              external_id = CASE WHEN ${"external_id" in row} THEN ${row.external_id || null} ELSE external_id END
            WHERE id = ${existing.id}
          `;
              updated += 1;
            } else {
              await transaction`
            INSERT INTO contacts (
              workspace_id, account_id, owner_id, first_name, last_name, title, department, email,
              normalized_email, linkedin_url, normalized_linkedin_url, phone, buyer_role, country, state, city, status,
              notes, external_source, external_id, created_by
            ) VALUES (
              ${user.workspaceId}, ${account.id}, ${account.ownerId ?? user.id}, ${row.first_name}, ${row.last_name || null},
              ${row.title || null}, ${row.department || null}, ${row.email || null}, ${normalizedEmail},
              ${row.linkedin_url || null}, ${normalizeLinkedInUrl(row.linkedin_url ?? "")},
              ${row.phone || null}, ${row.buyer_role || null}, ${row.country || null}, ${row.state || null}, ${row.city || null}, 'identified', ${row.notes || null},
              ${row.external_source || currentImportSource(parsed.data.entityType)}, ${row.external_id || null}, ${user.id}
            )
          `;
              created += 1;
            }
          });
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "";
          addIssue(
            rowNumber,
            code === "23505" ? "a matching record already exists" : "record could not be imported",
            code === "23505" ? "duplicate" : "failed",
          );
        }
      }
    });
    await audit({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      action: "crm_import.completed",
      entityType: parsed.data.entityType,
      summary: {
        created,
        updated,
        duplicates,
        failed,
        skipped: issues.length,
        mode: parsed.data.mode,
      },
    });
    return context.json({ created, updated, duplicates, failed, skipped: issues.length, issues });
  } catch (error) {
    if (error instanceof CsvParseError) return context.json({ error: error.message }, 422);
    return databaseError(context, error);
  }
});

crmConfigRoutes.get("/crm/evidence/:entityType/:id", async (context) => {
  const user = context.get("user");
  const parsedType = entityTypeSchema.safeParse(context.req.param("entityType"));
  if (!parsedType.success) return context.json({ error: "Invalid entity type." }, 422);
  const entityId = context.req.param("id");
  if (!(await entityAccess(user, parsedType.data, entityId))) {
    return context.json({ error: "Record not found." }, 404);
  }
  const evidence = await sql`
    SELECT e.*, creator.name AS created_by_name, reviewer.name AS reviewed_by_name
    FROM crm_enrichment_evidence e
    LEFT JOIN users creator ON creator.id = e.created_by
    LEFT JOIN users reviewer ON reviewer.id = e.reviewed_by
    WHERE e.workspace_id = ${user.workspaceId} AND e.entity_type = ${parsedType.data}
      AND e.entity_id = ${entityId}
    ORDER BY e.status = 'pending' DESC, e.created_at DESC
  `;
  return context.json({ evidence });
});

crmConfigRoutes.post("/crm/evidence", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, evidenceSchema);
  if (!parsed.ok) return parsed.response;
  if (!(await entityAccess(user, parsed.data.entityType, parsed.data.entityId))) {
    return context.json({ error: "Record not found." }, 404);
  }
  const [evidence] = await sql<{ id: string }[]>`
    INSERT INTO crm_enrichment_evidence (
      workspace_id, entity_type, entity_id, field_key, proposed_value, source_url, excerpt, created_by
    ) VALUES (
      ${user.workspaceId}, ${parsed.data.entityType}, ${parsed.data.entityId}, ${parsed.data.fieldKey},
      ${sql.json(parsed.data.proposedValue as never)}, ${parsed.data.sourceUrl || null},
      ${parsed.data.excerpt || null}, ${user.id}
    ) RETURNING id
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: "crm_evidence.proposed",
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
    summary: { evidenceId: evidence.id, fieldKey: parsed.data.fieldKey },
  });
  return context.json({ id: evidence.id }, 201);
});

crmConfigRoutes.patch("/crm/evidence/:id", async (context) => {
  const user = context.get("user");
  const parsed = await parseJson(context, z.object({ status: z.enum(["accepted", "dismissed"]) }));
  if (!parsed.ok) return parsed.response;
  const [evidence] = await sql<
    { id: string; entityType: "account" | "contact" | "opportunity"; entityId: string }[]
  >`
    SELECT id, entity_type AS "entityType", entity_id AS "entityId"
    FROM crm_enrichment_evidence
    WHERE id = ${context.req.param("id")} AND workspace_id = ${user.workspaceId}
      AND status = 'pending'
  `;
  if (!evidence || !(await entityAccess(user, evidence.entityType, evidence.entityId))) {
    return context.json({ error: "Evidence proposal not found." }, 404);
  }
  await sql`
    UPDATE crm_enrichment_evidence SET status = ${parsed.data.status}, reviewed_by = ${user.id},
      reviewed_at = now()
    WHERE id = ${evidence.id}
  `;
  await audit({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    action: `crm_evidence.${parsed.data.status}`,
    entityType: evidence.entityType,
    entityId: evidence.entityId,
    summary: { evidenceId: evidence.id },
  });
  return context.json({ ok: true });
});
