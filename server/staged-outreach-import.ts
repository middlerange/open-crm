import { createHash } from "node:crypto";

import { z } from "zod";

import { sql } from "./db.js";
import { normalizeDomain, normalizeEmail, normalizeLinkedInUrl } from "./security.js";

const optionalText = z.string().trim().max(20_000).optional().default("");
const optionalDate = z.string().trim().max(40).optional().default("");
const sourceMetadata = z.record(z.string(), z.unknown()).optional().default({});

const importedActivitySchema = z.object({
  sourceKey: z.string().trim().min(1).max(500),
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
  status: z.enum(["planned", "completed", "skipped"]).optional().default("completed"),
  details: optionalText,
  outcome: optionalText,
  occurredAt: optionalDate,
  dueAt: optionalDate,
  sourceMeta: sourceMetadata,
});

const channelStateSchema = z.object({
  state: z.enum(["identified", "requested", "connected", "messaged", "replied"]),
  connectionNote: optionalText,
  requestedAt: optionalDate,
  connectedAt: optionalDate,
  lastMessageAt: optionalDate,
});

const importedContactSchema = z.object({
  sourceKey: z.string().trim().min(1).max(500),
  fullName: z.string().trim().min(1).max(240),
  title: optionalText,
  department: optionalText,
  email: z.string().trim().email().optional().or(z.literal("")),
  linkedinUrl: z.string().trim().url().optional().or(z.literal("")),
  buyerRole: optionalText,
  notes: optionalText,
  importDecision: z.enum(["import", "hold"]).optional().default("import"),
  channel: channelStateSchema.optional(),
  activities: z.array(importedActivitySchema).max(20).optional().default([]),
  sourceMeta: sourceMetadata,
});

const importedSignalSchema = z.object({
  sourceKey: z.string().trim().min(1).max(500),
  kind: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(2_000),
  evidence: optionalText,
  sourceUrl: z.string().trim().url().optional().or(z.literal("")),
  observedAt: optionalDate,
  confidence: z.enum(["low", "medium", "high"]).optional(),
  sourceMeta: sourceMetadata,
});

const importedAccountSchema = z.object({
  sourceKey: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(240),
  domain: z.string().trim().max(320).optional().default(""),
  websiteUrl: z.string().trim().url().optional().or(z.literal("")),
  linkedinUrl: z.string().trim().url().optional().or(z.literal("")),
  ownerName: z.string().trim().min(1).max(160),
  ownerEmail: z.string().trim().email().optional().or(z.literal("")),
  tier: z.enum(["A", "B", "C"]).optional().default("C"),
  score: z.number().int().min(0).max(100).optional().default(0),
  employeeRange: optionalText,
  productMotion: optionalText,
  country: optionalText,
  industry: optionalText,
  currentTools: optionalText,
  relevantCapability: optionalText,
  buyerFunction: optionalText,
  researchStatus: optionalText,
  outreachStatus: optionalText,
  lastVerifiedAt: optionalDate,
  sourceLabel: optionalText,
  fitSummary: optionalText,
  evidenceSummary: optionalText,
  triggerSummary: optionalText,
  sourceLinks: z.array(z.string().trim().url()).max(50).optional().default([]),
  contacts: z.array(importedContactSchema).max(100).optional().default([]),
  signals: z.array(importedSignalSchema).max(30).optional().default([]),
  sourceMeta: sourceMetadata,
});

export const stagedOutreachImportSchema = z.object({
  source: z.string().trim().min(1).max(240),
  label: z.string().trim().min(1).max(240),
  accounts: z.array(importedAccountSchema).min(1).max(1_000),
});

export const stagedOutreachCommitSchema = stagedOutreachImportSchema.extend({
  acceptNameMatches: z.boolean().optional().default(false),
});

type ImportPayload = z.infer<typeof stagedOutreachImportSchema>;
type ImportedAccount = ImportPayload["accounts"][number];
type ImportedContact = ImportedAccount["contacts"][number];
type ImportedSignal = ImportedAccount["signals"][number];
type ImportedActivity = ImportedContact["activities"][number];
type MatchKind = "create" | "matched" | "name_match" | "unchanged" | "conflict" | "hold";

type ExistingAccount = {
  id: string;
  name: string;
  normalizedDomain: string | null;
  normalizedLinkedInUrl: string | null;
  ownerId: string | null;
  archivedAt: string | null;
};

type ExistingContact = {
  id: string;
  accountId: string;
  firstName: string;
  lastName: string | null;
  normalizedEmail: string | null;
  normalizedLinkedInUrl: string | null;
  status: string;
  archivedAt: string | null;
};

type ImportRecord = {
  entityType: "account" | "contact" | "signal" | "activity";
  sourceRecordKey: string;
  entityId: string;
  contentHash: string;
};

type PlannedContact = {
  record: ImportedContact;
  matchKind: MatchKind;
  contactId: string | null;
  contentHash: string;
};

type PlannedAccount = {
  record: ImportedAccount;
  matchKind: MatchKind;
  accountId: string | null;
  ownerId: string | null;
  contentHash: string;
  contacts: PlannedContact[];
};

type ImportIssue = {
  path: string;
  message: string;
  blocking: boolean;
};

function normalizedName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function contentHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function uniqueMatch<T extends { id: string }>(matches: Array<T | undefined>) {
  return [...new Map(matches.filter(Boolean).map((match) => [match!.id, match!])).values()];
}

function contactDisplayName(contact: ExistingContact) {
  return `${contact.firstName} ${contact.lastName ?? ""}`.trim();
}

function mapBy<T>(items: T[], key: (item: T) => string | null) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (!value) continue;
    map.set(value, [...(map.get(value) ?? []), item]);
  }
  return map;
}

export async function buildStagedOutreachPlan(workspaceId: string, payload: ImportPayload) {
  const [members, accounts, contacts, importedRecords] = await Promise.all([
    sql<{ id: string; name: string; email: string }[]>`
      SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${workspaceId} AND u.active = true
    `,
    sql<ExistingAccount[]>`
      SELECT id, name, normalized_domain AS "normalizedDomain",
        normalized_linkedin_url AS "normalizedLinkedInUrl", owner_id AS "ownerId",
        archived_at AS "archivedAt"
      FROM accounts WHERE workspace_id = ${workspaceId}
    `,
    sql<ExistingContact[]>`
      SELECT id, account_id AS "accountId", first_name AS "firstName", last_name AS "lastName",
        normalized_email AS "normalizedEmail", normalized_linkedin_url AS "normalizedLinkedInUrl",
        status, archived_at AS "archivedAt"
      FROM contacts WHERE workspace_id = ${workspaceId}
    `,
    sql<ImportRecord[]>`
      SELECT entity_type AS "entityType", source_record_key AS "sourceRecordKey",
        entity_id AS "entityId", content_hash AS "contentHash"
      FROM crm_import_records
      WHERE workspace_id = ${workspaceId} AND import_source = ${payload.source}
    `,
  ]);

  const membersByName = mapBy(members, (member) => normalizedName(member.name));
  const membersByEmail = mapBy(members, (member) => normalizeEmail(member.email));
  const accountsByDomain = mapBy(accounts, (account) => account.normalizedDomain);
  const accountsByLinkedIn = mapBy(accounts, (account) => account.normalizedLinkedInUrl);
  const accountsByName = mapBy(accounts, (account) => normalizedName(account.name));
  const contactsByEmail = mapBy(contacts, (contact) => contact.normalizedEmail);
  const contactsByLinkedIn = mapBy(contacts, (contact) => contact.normalizedLinkedInUrl);
  const contactsByAccountName = mapBy(
    contacts,
    (contact) => `${contact.accountId}:${normalizedName(contactDisplayName(contact))}`,
  );
  const importRecordByKey = new Map(
    importedRecords.map((record) => [`${record.entityType}:${record.sourceRecordKey}`, record]),
  );
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  const issues: ImportIssue[] = [];
  const plannedAccounts: PlannedAccount[] = [];

  for (const [accountIndex, record] of payload.accounts.entries()) {
    const path = `accounts[${accountIndex}]`;
    const ownerMatches = record.ownerEmail
      ? (membersByEmail.get(normalizeEmail(record.ownerEmail) ?? "") ?? [])
      : (membersByName.get(normalizedName(record.ownerName)) ?? []);
    const ownerId = ownerMatches.length === 1 ? ownerMatches[0]!.id : null;
    if (!ownerId) {
      issues.push({
        path: record.ownerEmail ? `${path}.ownerEmail` : `${path}.ownerName`,
        message:
          ownerMatches.length === 0
            ? `No active teammate matches “${record.ownerEmail || record.ownerName}”.`
            : `More than one active teammate matches “${record.ownerEmail || record.ownerName}”.`,
        blocking: true,
      });
    }

    const recordHash = contentHash(record);
    const priorImport = importRecordByKey.get(`account:${record.sourceKey}`);
    const normalizedDomain = normalizeDomain(record.domain);
    const normalizedLinkedIn = normalizeLinkedInUrl(record.linkedinUrl);
    const strongMatches = uniqueMatch([
      ...(normalizedDomain ? (accountsByDomain.get(normalizedDomain) ?? []) : []),
      ...(normalizedLinkedIn ? (accountsByLinkedIn.get(normalizedLinkedIn) ?? []) : []),
    ]);
    let accountId: string | null = null;
    let matchKind: MatchKind = "create";

    if (priorImport) {
      const previousAccount = accountById.get(priorImport.entityId);
      if (!previousAccount) {
        matchKind = "conflict";
        issues.push({
          path,
          message: "The previous import mapping points to an account that no longer exists.",
          blocking: true,
        });
      } else {
        accountId = previousAccount.id;
        matchKind = priorImport.contentHash === recordHash ? "unchanged" : "matched";
      }
    } else if (strongMatches.length > 1) {
      matchKind = "conflict";
      issues.push({
        path,
        message: "The domain and LinkedIn URL point to different existing accounts.",
        blocking: true,
      });
    } else if (strongMatches.length === 1) {
      accountId = strongMatches[0]!.id;
      matchKind = "matched";
    } else {
      const nameMatches = accountsByName.get(normalizedName(record.name)) ?? [];
      if (nameMatches.length === 1) {
        accountId = nameMatches[0]!.id;
        matchKind = "name_match";
        issues.push({
          path,
          message: `“${record.name}” matches an existing account by name only.`,
          blocking: false,
        });
      } else if (nameMatches.length > 1) {
        matchKind = "conflict";
        issues.push({
          path,
          message: `More than one existing account is named “${record.name}”.`,
          blocking: true,
        });
      }
    }

    const matchedAccount = accountId ? accountById.get(accountId) : undefined;
    if (matchedAccount?.archivedAt) {
      matchKind = "conflict";
      issues.push({
        path,
        message: `“${record.name}” matches an archived account. Restore or resolve it first.`,
        blocking: true,
      });
    }

    const plannedContacts: PlannedContact[] = [];
    for (const [contactIndex, contact] of record.contacts.entries()) {
      const contactPath = `${path}.contacts[${contactIndex}]`;
      const contactHash = contentHash(contact);
      if (contact.importDecision === "hold") {
        plannedContacts.push({
          record: contact,
          matchKind: "hold",
          contactId: null,
          contentHash: contactHash,
        });
        continue;
      }
      const priorContact = importRecordByKey.get(`contact:${contact.sourceKey}`);
      const normalizedEmail = normalizeEmail(contact.email);
      const normalizedLinkedInUrl = normalizeLinkedInUrl(contact.linkedinUrl);
      const strongContactMatches = uniqueMatch([
        ...(normalizedEmail ? (contactsByEmail.get(normalizedEmail) ?? []) : []),
        ...(normalizedLinkedInUrl ? (contactsByLinkedIn.get(normalizedLinkedInUrl) ?? []) : []),
      ]);
      let contactId: string | null = null;
      let contactMatchKind: MatchKind = "create";

      if (priorContact) {
        const previousContact = contactById.get(priorContact.entityId);
        if (!previousContact) {
          contactMatchKind = "conflict";
          issues.push({
            path: contactPath,
            message: "The previous import mapping points to a contact that no longer exists.",
            blocking: true,
          });
        } else {
          contactId = previousContact.id;
          contactMatchKind = priorContact.contentHash === contactHash ? "unchanged" : "matched";
        }
      } else if (strongContactMatches.length > 1) {
        contactMatchKind = "conflict";
        issues.push({
          path: contactPath,
          message: "The email and LinkedIn URL point to different existing contacts.",
          blocking: true,
        });
      } else if (strongContactMatches.length === 1) {
        contactId = strongContactMatches[0]!.id;
        contactMatchKind = "matched";
      } else if (accountId) {
        const nameMatches =
          contactsByAccountName.get(`${accountId}:${normalizedName(contact.fullName)}`) ?? [];
        if (nameMatches.length === 1) {
          contactId = nameMatches[0]!.id;
          contactMatchKind = "name_match";
          issues.push({
            path: contactPath,
            message: `“${contact.fullName}” matches an existing contact at this company by name only.`,
            blocking: false,
          });
        } else if (nameMatches.length > 1) {
          contactMatchKind = "conflict";
          issues.push({
            path: contactPath,
            message: `More than one contact at this company is named “${contact.fullName}”.`,
            blocking: true,
          });
        }
      }

      const matchedContact = contactId ? contactById.get(contactId) : undefined;
      if (matchedContact && accountId && matchedContact.accountId !== accountId) {
        contactMatchKind = "conflict";
        issues.push({
          path: contactPath,
          message: `“${contact.fullName}” is already linked to a different account.`,
          blocking: true,
        });
      }
      if (matchedContact?.archivedAt) {
        contactMatchKind = "conflict";
        issues.push({
          path: contactPath,
          message: `“${contact.fullName}” matches an archived contact. Restore or resolve it first.`,
          blocking: true,
        });
      }
      plannedContacts.push({
        record: contact,
        matchKind: contactMatchKind,
        contactId,
        contentHash: contactHash,
      });
    }

    plannedAccounts.push({
      record,
      matchKind,
      accountId,
      ownerId,
      contentHash: recordHash,
      contacts: plannedContacts,
    });
  }

  const allContacts = plannedAccounts.flatMap((account) => account.contacts);
  const summary = {
    accounts: {
      total: plannedAccounts.length,
      create: plannedAccounts.filter((item) => item.matchKind === "create").length,
      matched: plannedAccounts.filter((item) => item.matchKind === "matched").length,
      nameMatches: plannedAccounts.filter((item) => item.matchKind === "name_match").length,
      unchanged: plannedAccounts.filter((item) => item.matchKind === "unchanged").length,
      conflicts: plannedAccounts.filter((item) => item.matchKind === "conflict").length,
    },
    contacts: {
      total: allContacts.length,
      create: allContacts.filter((item) => item.matchKind === "create").length,
      matched: allContacts.filter((item) => item.matchKind === "matched").length,
      nameMatches: allContacts.filter((item) => item.matchKind === "name_match").length,
      unchanged: allContacts.filter((item) => item.matchKind === "unchanged").length,
      held: allContacts.filter((item) => item.matchKind === "hold").length,
      conflicts: allContacts.filter((item) => item.matchKind === "conflict").length,
    },
    signals: payload.accounts.reduce((total, account) => total + account.signals.length, 0),
    activities: payload.accounts.reduce(
      (total, account) =>
        total +
        account.contacts.reduce((subtotal, contact) => subtotal + contact.activities.length, 0),
      0,
    ),
  };

  return {
    label: payload.label,
    source: payload.source,
    ready: !issues.some((issue) => issue.blocking),
    requiresNameMatchApproval: issues.some((issue) => !issue.blocking),
    summary,
    issues,
    plan: plannedAccounts,
  };
}

function progressedContactStatus(current: string, incoming: string) {
  const order = ["identified", "verified", "contacted", "engaged", "qualified"];
  if (["not_interested", "invalid"].includes(current)) return current;
  return order.indexOf(incoming) > order.indexOf(current) ? incoming : current;
}

function importedContactStatus(contact: ImportedContact) {
  if (contact.channel?.state === "replied" || contact.channel?.state === "messaged")
    return "engaged";
  if (["requested", "connected"].includes(contact.channel?.state ?? "")) return "contacted";
  return "identified";
}

async function upsertImportRecord(
  transaction: any,
  workspaceId: string,
  source: string,
  entityType: "account" | "contact" | "signal" | "activity",
  sourceRecordKey: string,
  entityId: string,
  hash: string,
  metadata: Record<string, unknown>,
  actorId: string,
) {
  await transaction`
    INSERT INTO crm_import_records (
      workspace_id, import_source, source_record_key, entity_type, entity_id,
      content_hash, source_metadata, imported_by
    ) VALUES (
      ${workspaceId}, ${source}, ${sourceRecordKey}, ${entityType}, ${entityId},
      ${hash}, ${sql.json(metadata as never)}, ${actorId}
    )
    ON CONFLICT (workspace_id, import_source, entity_type, source_record_key) DO UPDATE SET
      entity_id = EXCLUDED.entity_id,
      content_hash = EXCLUDED.content_hash,
      source_metadata = EXCLUDED.source_metadata,
      imported_by = EXCLUDED.imported_by
  `;
}

async function upsertSignal(
  transaction: any,
  workspaceId: string,
  source: string,
  accountId: string,
  signal: ImportedSignal,
  actorId: string,
) {
  const sourceKey = `${source}:${signal.sourceKey}`;
  const [saved] = await transaction<{ id: string }[]>`
    INSERT INTO account_signals (
      workspace_id, account_id, kind, summary, evidence, source_url, observed_at,
      confidence, source_key, source_metadata, created_by
    ) VALUES (
      ${workspaceId}, ${accountId}, ${signal.kind}, ${signal.summary}, ${signal.evidence || null},
      ${signal.sourceUrl || null}, ${signal.observedAt || null}, ${signal.confidence ?? null},
      ${sourceKey}, ${sql.json(signal.sourceMeta as never)}, ${actorId}
    )
    ON CONFLICT (workspace_id, source_key) DO UPDATE SET
      account_id = EXCLUDED.account_id,
      kind = EXCLUDED.kind,
      summary = EXCLUDED.summary,
      evidence = EXCLUDED.evidence,
      source_url = EXCLUDED.source_url,
      observed_at = EXCLUDED.observed_at,
      confidence = EXCLUDED.confidence,
      source_metadata = EXCLUDED.source_metadata
    RETURNING id
  `;
  await upsertImportRecord(
    transaction,
    workspaceId,
    source,
    "signal",
    signal.sourceKey,
    saved.id,
    contentHash(signal),
    signal.sourceMeta,
    actorId,
  );
}

async function upsertActivity(
  transaction: any,
  workspaceId: string,
  source: string,
  accountId: string,
  contactId: string,
  ownerId: string,
  activity: ImportedActivity,
  actorId: string,
) {
  const externalId = `${source}:${activity.sourceKey}`;
  const [saved] = await transaction<{ id: string }[]>`
    INSERT INTO activities (
      workspace_id, account_id, contact_id, actor_id, type, status, outcome, details,
      occurred_at, due_at, source, external_id
    ) VALUES (
      ${workspaceId}, ${accountId}, ${contactId}, ${ownerId}, ${activity.type}, ${activity.status},
      ${activity.outcome || null}, ${activity.details || null}, ${activity.occurredAt || null},
      ${activity.dueAt || null}, ${source}, ${externalId}
    )
    ON CONFLICT (workspace_id, source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
      account_id = EXCLUDED.account_id,
      contact_id = EXCLUDED.contact_id,
      actor_id = EXCLUDED.actor_id,
      type = EXCLUDED.type,
      status = EXCLUDED.status,
      outcome = EXCLUDED.outcome,
      details = EXCLUDED.details,
      occurred_at = EXCLUDED.occurred_at,
      due_at = EXCLUDED.due_at
    RETURNING id
  `;
  await upsertImportRecord(
    transaction,
    workspaceId,
    source,
    "activity",
    activity.sourceKey,
    saved.id,
    contentHash(activity),
    activity.sourceMeta,
    actorId,
  );
}

export async function commitStagedOutreachImport(
  workspaceId: string,
  actorId: string,
  payload: z.infer<typeof stagedOutreachCommitSchema>,
) {
  const preview = await buildStagedOutreachPlan(workspaceId, payload);
  if (!preview.ready) {
    return { ok: false as const, reason: "conflicts" as const, preview };
  }
  if (preview.requiresNameMatchApproval && !payload.acceptNameMatches) {
    return { ok: false as const, reason: "name_match_approval" as const, preview };
  }

  const result = {
    accountsCreated: 0,
    accountsUpdated: 0,
    accountsUnchanged: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    contactsUnchanged: 0,
    contactsHeld: 0,
    signalsUpserted: 0,
    activitiesUpserted: 0,
  };

  await sql.begin(async (transaction) => {
    for (const plannedAccount of preview.plan) {
      const record = plannedAccount.record;
      let accountId = plannedAccount.accountId;
      if (plannedAccount.matchKind === "create") {
        const [created] = await transaction<{ id: string }[]>`
          INSERT INTO accounts (
            workspace_id, name, domain, normalized_domain, linkedin_url, normalized_linkedin_url,
            website_url, owner_id, tier, status, employee_range, product_motion, source,
            fit_summary, evidence_summary, trigger_summary, source_links, score,
            country, industry, current_tools, relevant_capability, buyer_function,
            research_status, outreach_status, last_verified_at,
            external_source, external_id, created_by
          ) VALUES (
            ${workspaceId}, ${record.name}, ${record.domain || null}, ${normalizeDomain(record.domain)},
            ${record.linkedinUrl || null}, ${normalizeLinkedInUrl(record.linkedinUrl)},
            ${record.websiteUrl || null}, ${plannedAccount.ownerId}, ${record.tier}, 'research',
            ${record.employeeRange || null}, ${record.productMotion || null},
            ${record.sourceLabel || payload.label}, ${record.fitSummary || null},
            ${record.evidenceSummary || null}, ${record.triggerSummary || null},
            ${sql.json(record.sourceLinks)}, ${record.score}, ${record.country || null},
            ${record.industry || null}, ${record.currentTools || null},
            ${record.relevantCapability || null}, ${record.buyerFunction || null},
            ${record.researchStatus || null}, ${record.outreachStatus || null},
            ${record.lastVerifiedAt || null}, ${payload.source}, ${record.sourceKey}, ${actorId}
          ) RETURNING id
        `;
        accountId = created.id;
        result.accountsCreated += 1;
      } else if (plannedAccount.matchKind === "unchanged") {
        result.accountsUnchanged += 1;
      } else {
        await transaction`
          UPDATE accounts SET
            name = ${record.name},
            domain = coalesce(nullif(${record.domain}, ''), domain),
            normalized_domain = coalesce(${normalizeDomain(record.domain)}, normalized_domain),
            linkedin_url = coalesce(nullif(${record.linkedinUrl ?? ""}, ''), linkedin_url),
            normalized_linkedin_url = coalesce(${normalizeLinkedInUrl(record.linkedinUrl)}, normalized_linkedin_url),
            website_url = coalesce(nullif(${record.websiteUrl ?? ""}, ''), website_url),
            tier = ${record.tier},
            employee_range = coalesce(nullif(${record.employeeRange}, ''), employee_range),
            product_motion = coalesce(nullif(${record.productMotion}, ''), product_motion),
            source = coalesce(nullif(${record.sourceLabel}, ''), source),
            fit_summary = coalesce(nullif(${record.fitSummary}, ''), fit_summary),
            evidence_summary = coalesce(nullif(${record.evidenceSummary}, ''), evidence_summary),
            trigger_summary = coalesce(nullif(${record.triggerSummary}, ''), trigger_summary),
            source_links = CASE WHEN jsonb_array_length(${sql.json(record.sourceLinks)}::jsonb) > 0
              THEN ${sql.json(record.sourceLinks)}::jsonb ELSE source_links END,
            score = greatest(score, ${record.score}),
            country = coalesce(nullif(${record.country}, ''), country),
            industry = coalesce(nullif(${record.industry}, ''), industry),
            current_tools = coalesce(nullif(${record.currentTools}, ''), current_tools),
            relevant_capability = coalesce(nullif(${record.relevantCapability}, ''), relevant_capability),
            buyer_function = coalesce(nullif(${record.buyerFunction}, ''), buyer_function),
            research_status = coalesce(nullif(${record.researchStatus}, ''), research_status),
            outreach_status = coalesce(nullif(${record.outreachStatus}, ''), outreach_status),
            last_verified_at = coalesce(${record.lastVerifiedAt || null}, last_verified_at)
          WHERE id = ${accountId} AND workspace_id = ${workspaceId}
        `;
        result.accountsUpdated += 1;
      }
      if (!accountId) throw new Error(`Account ${record.sourceKey} could not be resolved.`);

      if (plannedAccount.matchKind === "unchanged") {
        result.contactsHeld += plannedAccount.contacts.filter(
          (contact) => contact.matchKind === "hold",
        ).length;
        result.contactsUnchanged += plannedAccount.contacts.filter(
          (contact) => contact.matchKind === "unchanged",
        ).length;
        continue;
      }

      await upsertImportRecord(
        transaction,
        workspaceId,
        payload.source,
        "account",
        record.sourceKey,
        accountId,
        plannedAccount.contentHash,
        record.sourceMeta,
        actorId,
      );

      for (const signal of record.signals) {
        await upsertSignal(transaction, workspaceId, payload.source, accountId, signal, actorId);
        result.signalsUpserted += 1;
      }

      for (const plannedContact of plannedAccount.contacts) {
        const contact = plannedContact.record;
        if (plannedContact.matchKind === "hold") {
          result.contactsHeld += 1;
          continue;
        }
        let contactId = plannedContact.contactId;
        const incomingStatus = importedContactStatus(contact);
        if (plannedContact.matchKind === "create") {
          const [created] = await transaction<{ id: string }[]>`
            INSERT INTO contacts (
              workspace_id, account_id, owner_id, first_name, title, department, email,
              normalized_email, linkedin_url, normalized_linkedin_url, buyer_role, status,
              preferred_channel, notes, external_source, external_id, created_by
            ) VALUES (
              ${workspaceId}, ${accountId}, ${plannedAccount.ownerId}, ${contact.fullName},
              ${contact.title || null}, ${contact.department || null}, ${contact.email || null},
              ${normalizeEmail(contact.email)}, ${contact.linkedinUrl || null},
              ${normalizeLinkedInUrl(contact.linkedinUrl)}, ${contact.buyerRole || null},
              ${incomingStatus}, ${contact.channel ? "linkedin" : null}, ${contact.notes || null},
              ${payload.source}, ${contact.sourceKey}, ${actorId}
            ) RETURNING id
          `;
          contactId = created.id;
          result.contactsCreated += 1;
        } else if (plannedContact.matchKind === "unchanged") {
          result.contactsUnchanged += 1;
        } else {
          const [current] = await transaction<{ status: string }[]>`
            SELECT status FROM contacts WHERE id = ${contactId} AND workspace_id = ${workspaceId}
          `;
          await transaction`
            UPDATE contacts SET
              title = coalesce(nullif(${contact.title}, ''), title),
              department = coalesce(nullif(${contact.department}, ''), department),
              email = coalesce(nullif(${contact.email || ""}, ''), email),
              normalized_email = coalesce(${normalizeEmail(contact.email)}, normalized_email),
              linkedin_url = coalesce(nullif(${contact.linkedinUrl || ""}, ''), linkedin_url),
              normalized_linkedin_url = coalesce(${normalizeLinkedInUrl(contact.linkedinUrl)}, normalized_linkedin_url),
              buyer_role = coalesce(nullif(${contact.buyerRole}, ''), buyer_role),
              status = ${progressedContactStatus(current.status, incomingStatus)},
              preferred_channel = CASE WHEN ${Boolean(contact.channel)} THEN 'linkedin' ELSE preferred_channel END,
              notes = coalesce(nullif(${contact.notes}, ''), notes)
            WHERE id = ${contactId} AND workspace_id = ${workspaceId}
          `;
          result.contactsUpdated += 1;
        }
        if (!contactId) throw new Error(`Contact ${contact.sourceKey} could not be resolved.`);

        if (plannedContact.matchKind === "unchanged") continue;

        await upsertImportRecord(
          transaction,
          workspaceId,
          payload.source,
          "contact",
          contact.sourceKey,
          contactId,
          plannedContact.contentHash,
          contact.sourceMeta,
          actorId,
        );

        if (contact.channel) {
          await transaction`
            INSERT INTO contact_channel_states (
              workspace_id, contact_id, channel, state, connection_note, requested_at,
              connected_at, last_message_at, source_metadata, updated_by
            ) VALUES (
              ${workspaceId}, ${contactId}, 'linkedin', ${contact.channel.state},
              ${contact.channel.connectionNote || null}, ${contact.channel.requestedAt || null},
              ${contact.channel.connectedAt || null}, ${contact.channel.lastMessageAt || null},
              ${sql.json(contact.sourceMeta as never)}, ${actorId}
            )
            ON CONFLICT (workspace_id, contact_id, channel) DO UPDATE SET
              state = EXCLUDED.state,
              connection_note = coalesce(EXCLUDED.connection_note, contact_channel_states.connection_note),
              requested_at = coalesce(EXCLUDED.requested_at, contact_channel_states.requested_at),
              connected_at = coalesce(EXCLUDED.connected_at, contact_channel_states.connected_at),
              last_message_at = coalesce(EXCLUDED.last_message_at, contact_channel_states.last_message_at),
              source_metadata = EXCLUDED.source_metadata,
              updated_by = EXCLUDED.updated_by
          `;
        }

        for (const activity of contact.activities) {
          await upsertActivity(
            transaction,
            workspaceId,
            payload.source,
            accountId,
            contactId,
            plannedAccount.ownerId!,
            activity,
            actorId,
          );
          result.activitiesUpserted += 1;
        }
      }
    }
  });

  return { ok: true as const, result, preview: { ...preview, plan: undefined } };
}

export function publicStagedOutreachPreview(
  preview: Awaited<ReturnType<typeof buildStagedOutreachPlan>>,
) {
  return {
    label: preview.label,
    source: preview.source,
    ready: preview.ready,
    requiresNameMatchApproval: preview.requiresNameMatchApproval,
    summary: preview.summary,
    issues: preview.issues,
  };
}
