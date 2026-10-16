import {
  PlusIcon as Plus,
  ShieldTickIcon as Shield,
  SlidersIcon as Sliders,
  TagIcon as Tag,
  UploadCloudIcon as Upload,
} from "../components/icons";
import { useState, type ChangeEvent, type FormEvent } from "react";

import { ExportActions, ImportRecords } from "../components/crm-transfer";
import { AppShell } from "../components/shell";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageToolbar,
  Panel,
  Select,
  Spinner,
  Textarea,
  useToast,
} from "../components/ui";
import { api, titleCase } from "../lib/api";
import { useData } from "../lib/use-data";

type EntityType = "account" | "contact" | "opportunity";
type SettingsTab =
  | "fields"
  | "pipeline"
  | "tags"
  | "duplicates"
  | "suppression"
  | "connections"
  | "transfer";

type CustomField = {
  id: string;
  entityType: EntityType;
  key: string;
  label: string;
  fieldType: string;
  required: boolean;
  options: string[];
  archivedAt: string | null;
};

type TagRecord = { id: string; name: string; color: string; usageCount: number };
type PipelineStage = {
  id: string;
  key: string;
  name: string;
  position: number;
  probability: number;
  terminal: boolean;
  won: boolean;
  opportunityCount: number;
};
type Suppression = {
  id: string;
  kind: "email" | "domain";
  value: string;
  reason: string | null;
  active: boolean;
};
type Connection = {
  id: string;
  provider: "google" | "microsoft";
  accountEmail: string;
  status: string;
  syncMail: boolean;
  syncCalendar: boolean;
  autoCreateContacts: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
};
type DuplicateRecord = {
  id: string;
  name: string;
  domain?: string;
  email?: string;
  title?: string;
  ownerName?: string;
};
type StagedImportPreview = {
  label: string;
  source: string;
  ready: boolean;
  requiresNameMatchApproval: boolean;
  summary: {
    accounts: {
      total: number;
      create: number;
      matched: number;
      nameMatches: number;
      unchanged: number;
      conflicts: number;
    };
    contacts: {
      total: number;
      create: number;
      matched: number;
      nameMatches: number;
      unchanged: number;
      held: number;
      conflicts: number;
    };
    signals: number;
    activities: number;
  };
  issues: Array<{ path: string; message: string; blocking: boolean }>;
};

function fieldKey(label: string) {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 60);
}

export function CrmSettingsPage() {
  const { notify } = useToast();
  const [tab, setTab] = useState<SettingsTab>("fields");
  const [entityType, setEntityType] = useState<EntityType>("account");
  const {
    data: fields,
    loading: fieldsLoading,
    reload: reloadFields,
  } = useData<{
    fields: CustomField[];
  }>(`/crm/fields?entityType=${entityType}&includeArchived=true`);
  const { data: tags, reload: reloadTags } = useData<{ tags: TagRecord[] }>("/crm/tags");
  const { data: stages, reload: reloadStages } = useData<{ stages: PipelineStage[] }>(
    "/crm/stages",
  );
  const { data: suppressions, reload: reloadSuppressions } = useData<{
    suppressions: Suppression[];
  }>("/crm/suppressions");
  const { data: connections, reload: reloadConnections } = useData<{
    connections: Connection[];
    mode: "read_only";
  }>("/crm/connections");
  const [duplicateType, setDuplicateType] = useState<"account" | "contact">("account");
  const { data: duplicates, reload: reloadDuplicates } = useData<{
    groups: Array<{
      matchKey: string;
      accountName?: string;
      records: DuplicateRecord[];
    }>;
  }>(`/crm/duplicates?entityType=${duplicateType}`);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [suppressionOpen, setSuppressionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingMerge, setPendingMerge] = useState<{
    records: DuplicateRecord[];
    mergeId: string;
    keepId: string;
  } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<Connection | null>(null);
  const [fieldForm, setFieldForm] = useState({
    label: "",
    key: "",
    fieldType: "text",
    description: "",
    required: false,
    options: "",
  });
  const [stageForm, setStageForm] = useState({
    name: "",
    key: "",
    probability: 0,
    terminal: false,
    won: false,
  });
  const [tagForm, setTagForm] = useState({ name: "", color: "blue" });
  const [suppressionForm, setSuppressionForm] = useState({
    kind: "email",
    value: "",
    reason: "",
  });
  const [stagedPayload, setStagedPayload] = useState<Record<string, unknown> | null>(null);
  const [stagedFileName, setStagedFileName] = useState("");
  const [stagedPreview, setStagedPreview] = useState<StagedImportPreview | null>(null);
  const [acceptNameMatches, setAcceptNameMatches] = useState(false);

  async function createField(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/crm/fields", {
        method: "POST",
        body: JSON.stringify({
          entityType,
          label: fieldForm.label,
          key: fieldForm.key || fieldKey(fieldForm.label),
          fieldType: fieldForm.fieldType,
          description: fieldForm.description,
          required: fieldForm.required,
          options: fieldForm.options
            .split(",")
            .map((option) => option.trim())
            .filter(Boolean),
        }),
      });
      notify("Custom field created.");
      setFieldOpen(false);
      setFieldForm({
        label: "",
        key: "",
        fieldType: "text",
        description: "",
        required: false,
        options: "",
      });
      await reloadFields();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create field.", "error");
    } finally {
      setSaving(false);
    }
  }

  function openStage(stage?: PipelineStage) {
    setEditingStageId(stage?.id ?? null);
    setStageForm({
      name: stage?.name ?? "",
      key: stage?.key ?? "",
      probability: stage?.probability ?? 0,
      terminal: stage?.terminal ?? false,
      won: stage?.won ?? false,
    });
    setStageOpen(true);
  }

  async function saveStage(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: stageForm.name,
        probability: stageForm.probability,
        terminal: stageForm.terminal || stageForm.won,
        won: stageForm.won,
        ...(editingStageId ? {} : { key: stageForm.key || fieldKey(stageForm.name) }),
      };
      await api(editingStageId ? `/crm/stages/${editingStageId}` : "/crm/stages", {
        method: editingStageId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      notify(editingStageId ? "Pipeline stage updated." : "Pipeline stage created.");
      setStageOpen(false);
      await reloadStages();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to save pipeline stage.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function archiveField(field: CustomField) {
    try {
      await api(`/crm/fields/${field.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: !field.archivedAt }),
      });
      notify(field.archivedAt ? "Custom field restored." : "Custom field archived.");
      await reloadFields();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update field.", "error");
    }
  }

  async function createTag(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/crm/tags", { method: "POST", body: JSON.stringify(tagForm) });
      notify("Tag created.");
      setTagOpen(false);
      setTagForm({ name: "", color: "blue" });
      await reloadTags();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create tag.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function createSuppression(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/crm/suppressions", {
        method: "POST",
        body: JSON.stringify(suppressionForm),
      });
      notify("Suppression added.");
      setSuppressionOpen(false);
      setSuppressionForm({ kind: "email", value: "", reason: "" });
      await reloadSuppressions();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to add suppression.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleSuppression(suppression: Suppression) {
    try {
      await api(`/crm/suppressions/${suppression.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !suppression.active }),
      });
      await reloadSuppressions();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update suppression.", "error");
    }
  }

  async function mergeDuplicate(primaryId: string, duplicateId: string) {
    setSaving(true);
    try {
      await api("/crm/merge", {
        method: "POST",
        body: JSON.stringify({ entityType: duplicateType, primaryId, duplicateId }),
      });
      notify(`${titleCase(duplicateType)} records merged.`);
      setPendingMerge(null);
      await reloadDuplicates();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to merge records.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function updateConnection(connection: Connection, changes: Partial<Connection>) {
    try {
      await api(`/crm/connections/${connection.id}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      await reloadConnections();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update connection.", "error");
    }
  }

  async function revokeConnection(connection: Connection) {
    try {
      await api(`/crm/connections/${connection.id}`, { method: "DELETE" });
      notify("Connection revoked.");
      setPendingRevoke(null);
      await reloadConnections();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to revoke connection.", "error");
    }
  }

  async function readStagedImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 20_000_000) {
      notify("Staged import files must be smaller than 20 MB.", "error");
      return;
    }
    try {
      const payload = JSON.parse(await file.text()) as Record<string, unknown>;
      setStagedPayload(payload);
      setStagedFileName(file.name);
      setStagedPreview(null);
      setAcceptNameMatches(false);
    } catch {
      notify("This is not a valid staged import file.", "error");
    }
  }

  async function previewStagedImport() {
    if (!stagedPayload) return;
    setSaving(true);
    try {
      const result = await api<StagedImportPreview>("/crm/staged-import/preview", {
        method: "POST",
        body: JSON.stringify(stagedPayload),
      });
      setStagedPreview(result);
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Unable to preview staged import.",
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  async function runStagedImport() {
    if (!stagedPayload) return;
    setSaving(true);
    try {
      const response = await api<{
        result: { accountsCreated: number; contactsCreated: number; contactsHeld: number };
      }>("/crm/staged-import/commit", {
        method: "POST",
        body: JSON.stringify({ ...stagedPayload, acceptNameMatches }),
      });
      notify(
        `Import complete: ${response.result.accountsCreated} accounts and ${response.result.contactsCreated} contacts created; ${response.result.contactsHeld} contacts held back.`,
      );
      setStagedPayload(null);
      setStagedFileName("");
      setStagedPreview(null);
      setAcceptNameMatches(false);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to run staged import.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell
      contentWidth="wide"
      toolbar={
        <PageToolbar label="CRM settings sections">
          {[
            ["fields", "Custom fields"],
            ["pipeline", "Pipeline stages"],
            ["tags", "Tags"],
            ["duplicates", "Duplicates"],
            ["suppression", "Suppression"],
            ["connections", "Connections"],
            ["transfer", "Import & export"],
          ].map(([value, label]) => (
            <Button
              key={value}
              className={`root-filter ${tab === value ? "is-active" : ""}`}
              variant="plain"
              size="small"
              onClick={() => setTab(value as SettingsTab)}
            >
              {label}
            </Button>
          ))}
        </PageToolbar>
      }
    >
      {tab === "fields" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>Custom fields</h2>
              <p>Add workspace-specific context without changing Orbit's core record model.</p>
            </div>
            <div className="inline-cluster">
              <Select
                value={entityType}
                onValueChange={(value) => setEntityType(value as EntityType)}
              >
                <option value="account">Accounts</option>
                <option value="contact">Contacts</option>
                <option value="opportunity">Opportunities</option>
              </Select>
              <Button variant="primary" onClick={() => setFieldOpen(true)}>
                <Plus size={14} /> Add field
              </Button>
            </div>
          </div>
          {fieldsLoading ? (
            <div className="loading-page loading-section">
              <Spinner />
            </div>
          ) : fields?.fields.length ? (
            <div className="list">
              {fields.fields.map((field) => (
                <div className="list-row" key={field.id}>
                  <span className="stat-icon">
                    <Sliders size={14} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>{field.label}</span>
                      <Badge>{titleCase(field.fieldType)}</Badge>
                      {field.required ? <Badge tone="amber">Required</Badge> : null}
                      {field.archivedAt ? <Badge>Archived</Badge> : null}
                    </div>
                    <div className="list-row-meta">
                      <span>{field.key}</span>
                    </div>
                  </div>
                  <Button size="small" onClick={() => void archiveField(field)}>
                    {field.archivedAt ? "Restore" : "Archive"}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No custom fields"
              description={`Orbit's standard ${entityType} fields are currently in use.`}
            />
          )}
        </Panel>
      ) : tab === "pipeline" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>Pipeline stages</h2>
              <p>Control stage names, forecast probabilities, and closed outcomes.</p>
            </div>
            <Button variant="primary" onClick={() => openStage()}>
              <Plus size={14} /> Add stage
            </Button>
          </div>
          {stages?.stages.length ? (
            <div className="list">
              {stages.stages.map((stage) => (
                <div className="list-row" key={stage.id}>
                  <span className="stat-icon">{stage.position}</span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>{stage.name}</span>
                      <Badge tone={stage.won ? "green" : stage.terminal ? "red" : "blue"}>
                        {stage.won ? "Won" : stage.terminal ? "Lost" : `${stage.probability}%`}
                      </Badge>
                    </div>
                    <div className="list-row-meta">
                      <span>{stage.key}</span>
                      <span>{stage.opportunityCount} opportunities</span>
                    </div>
                  </div>
                  <Button size="small" onClick={() => openStage(stage)}>
                    Edit
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No pipeline stages"
              description="Add the first stage before creating opportunities."
            />
          )}
        </Panel>
      ) : tab === "tags" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>CRM tags</h2>
              <p>Shared labels for accounts, contacts, and opportunities.</p>
            </div>
            <Button variant="primary" onClick={() => setTagOpen(true)}>
              <Plus size={14} /> Add tag
            </Button>
          </div>
          {tags?.tags.length ? (
            <div className="list">
              {tags.tags.map((tag) => (
                <div className="list-row" key={tag.id}>
                  <span className="stat-icon">
                    <Tag size={14} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>{tag.name}</span>
                      <Badge>{tag.color}</Badge>
                    </div>
                  </div>
                  <span>{tag.usageCount} records</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No CRM tags"
              description="Create a small shared vocabulary for useful segmentation."
            />
          )}
        </Panel>
      ) : tab === "duplicates" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>Potential duplicates</h2>
              <p>
                Review exact normalized-name matches before merging their relationships and history.
              </p>
            </div>
            <Select
              value={duplicateType}
              onValueChange={(value) => setDuplicateType(value as typeof duplicateType)}
            >
              <option value="account">Accounts</option>
              <option value="contact">Contacts</option>
            </Select>
          </div>
          {duplicates?.groups.length ? (
            <div className="stack-list duplicate-groups">
              {duplicates.groups.map((group) => {
                const primary = group.records[0]!;
                return (
                  <div className="list" key={`${group.accountName ?? ""}-${group.matchKey}`}>
                    <div className="nav-section-label">
                      {group.accountName ? `${group.accountName} · ` : ""}
                      {group.matchKey}
                    </div>
                    {group.records.map((record, index) => (
                      <div className="list-row" key={record.id}>
                        <div className="list-row-main">
                          <div className="list-row-title">
                            <span>{record.name}</span>
                            {index === 0 ? (
                              <Badge tone="green">Keep</Badge>
                            ) : (
                              <Badge tone="amber">Review</Badge>
                            )}
                          </div>
                          <div className="list-row-meta">
                            <span>
                              {record.domain ||
                                record.email ||
                                record.title ||
                                "No distinguishing value"}
                            </span>
                            <span>{record.ownerName ?? "Unassigned"}</span>
                          </div>
                        </div>
                        {index > 0 ? (
                          <Button
                            size="small"
                            disabled={saving}
                            onClick={() =>
                              setPendingMerge({
                                records: group.records,
                                mergeId: record.id,
                                keepId: primary.id,
                              })
                            }
                          >
                            Merge into {primary.name}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No likely duplicates"
              description={`No active ${duplicateType} records share the same normalized name.`}
            />
          )}
        </Panel>
      ) : tab === "suppression" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>Do-not-contact suppression</h2>
              <p>Email addresses and domains Orbit should flag before manual outreach.</p>
            </div>
            <Button variant="primary" onClick={() => setSuppressionOpen(true)}>
              <Plus size={14} /> Add suppression
            </Button>
          </div>
          {suppressions?.suppressions.length ? (
            <div className="list">
              {suppressions.suppressions.map((item) => (
                <div className="list-row" key={item.id}>
                  <span className="stat-icon">
                    <Shield size={14} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>{item.value}</span>
                      <Badge tone={item.active ? "red" : "neutral"}>
                        {item.active ? "Active" : "Disabled"}
                      </Badge>
                    </div>
                    <div className="list-row-meta">
                      <span>{titleCase(item.kind)}</span>
                      <span>{item.reason || "No reason recorded"}</span>
                    </div>
                  </div>
                  <Button size="small" onClick={() => void toggleSuppression(item)}>
                    {item.active ? "Disable" : "Enable"}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No suppressions"
              description="Add explicit opt-outs before connecting communication history."
            />
          )}
        </Panel>
      ) : tab === "connections" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>Email and calendar capture</h2>
              <p>Read-only connection records; Orbit never sends email or LinkedIn outreach.</p>
            </div>
            <Badge tone="blue">Read only</Badge>
          </div>
          {connections?.connections.length ? (
            <div className="list">
              {connections.connections.map((connection) => (
                <div className="list-row" key={connection.id}>
                  <span className="stat-icon">
                    <Shield size={14} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>
                        {titleCase(connection.provider)} · {connection.accountEmail}
                      </span>
                      <Badge
                        tone={
                          connection.status === "connected"
                            ? "green"
                            : connection.status === "error"
                              ? "red"
                              : "neutral"
                        }
                      >
                        {titleCase(connection.status)}
                      </Badge>
                    </div>
                    <div className="list-row-meta">
                      <span>
                        {connection.lastSyncedAt
                          ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString()}`
                          : "Not synced yet"}
                      </span>
                      {connection.lastError ? <span>{connection.lastError}</span> : null}
                    </div>
                    <div className="inline-cluster">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={connection.syncMail}
                          onChange={(event) =>
                            void updateConnection(connection, { syncMail: event.target.checked })
                          }
                        />{" "}
                        Mail
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={connection.syncCalendar}
                          onChange={(event) =>
                            void updateConnection(connection, {
                              syncCalendar: event.target.checked,
                            })
                          }
                        />{" "}
                        Calendar
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={connection.autoCreateContacts}
                          onChange={(event) =>
                            void updateConnection(connection, {
                              autoCreateContacts: event.target.checked,
                            })
                          }
                        />{" "}
                        Auto-create contacts
                      </label>
                    </div>
                  </div>
                  <Button
                    size="small"
                    variant="danger"
                    onClick={() => setPendingRevoke(connection)}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No mailbox connected"
              description="The data model and read-only timeline are ready. Google or Microsoft OAuth credentials must be configured before a connection can be authorized."
            />
          )}
        </Panel>
      ) : (
        <div className="detail-grid">
          <Panel>
            <div className="section-heading">
              <div>
                <h2>Export CRM data</h2>
                <p>Download companies, leads, contacts, and opportunities as CSV or Excel.</p>
              </div>
            </div>
            <div className="stack-list">
              {(
                [
                  ["account", "companies"],
                  ["lead", "leads"],
                  ["contact", "contacts"],
                  ["opportunity", "opportunities"],
                ] as const
              ).map(([type, label]) => (
                <ExportActions key={type} type={type} label={`Export ${label}`} />
              ))}
            </div>
          </Panel>
          <Panel>
            <div className="section-heading">
              <div>
                <h2>Staged research import</h2>
                <p>
                  Reconcile companies and contacts before writing. Signals, LinkedIn notes, status,
                  ownership, and source history stay attached to the right records.
                </p>
              </div>
            </div>
            <div className="form-grid">
              <div className="field-wide">
                <Field label="Prepared import file">
                  <Input
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) => void readStagedImport(event)}
                  />
                </Field>
              </div>
              {stagedPayload ? (
                <div className="field-wide inline-cluster">
                  <Button onClick={() => void previewStagedImport()} disabled={saving}>
                    <Upload size={14} /> Preview {stagedFileName}
                  </Button>
                  {stagedPreview?.ready ? (
                    <Button
                      variant="primary"
                      onClick={() => void runStagedImport()}
                      disabled={
                        saving || (stagedPreview.requiresNameMatchApproval && !acceptNameMatches)
                      }
                    >
                      Import reviewed records
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {stagedPreview ? (
                <div className="field-wide stack-list">
                  <Badge tone={stagedPreview.ready ? "green" : "red"}>
                    {stagedPreview.ready ? "Ready after review" : "Blocking conflicts found"}
                  </Badge>
                  <p className="subtle-copy">
                    Accounts: {stagedPreview.summary.accounts.create} new,{" "}
                    {stagedPreview.summary.accounts.matched} matched,{" "}
                    {stagedPreview.summary.accounts.unchanged} unchanged · Contacts:{" "}
                    {stagedPreview.summary.contacts.create} new,{" "}
                    {stagedPreview.summary.contacts.matched} matched,{" "}
                    {stagedPreview.summary.contacts.held} held · {stagedPreview.summary.signals}{" "}
                    signals · {stagedPreview.summary.activities} historical activities
                  </p>
                  {stagedPreview.requiresNameMatchApproval ? (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={acceptNameMatches}
                        onChange={(event) => setAcceptNameMatches(event.target.checked)}
                      />
                      Accept the unique name-only matches listed below
                    </label>
                  ) : null}
                  {stagedPreview.issues.length ? (
                    <div className="list">
                      {stagedPreview.issues.slice(0, 25).map((issue) => (
                        <div className="list-row" key={`${issue.path}:${issue.message}`}>
                          <div className="list-row-main">
                            <div className="list-row-title">
                              <span>{issue.message}</span>
                              <Badge tone={issue.blocking ? "red" : "amber"}>
                                {issue.blocking ? "Conflict" : "Review"}
                              </Badge>
                            </div>
                            <div className="list-row-meta">{issue.path}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Panel>
          <Panel>
            <div className="section-heading">
              <div>
                <h2>Import CRM records</h2>
                <p>Upload, map, and review your companies, contacts, or leads.</p>
              </div>
            </div>
            <ImportRecords />
          </Panel>
        </div>
      )}

      <Modal
        open={fieldOpen}
        onClose={() => setFieldOpen(false)}
        title={`Add ${entityType} field`}
        footer={
          <>
            <Button onClick={() => setFieldOpen(false)}>Cancel</Button>
            <Button variant="primary" form="create-field" type="submit" disabled={saving}>
              Create field
            </Button>
          </>
        }
      >
        <form id="create-field" className="form-grid" onSubmit={createField}>
          <Field label="Label">
            <Input
              required
              autoFocus
              value={fieldForm.label}
              onChange={(event) =>
                setFieldForm({
                  ...fieldForm,
                  label: event.target.value,
                  key: fieldKey(event.target.value),
                })
              }
            />
          </Field>
          <Field label="Key">
            <Input
              required
              value={fieldForm.key}
              onChange={(event) => setFieldForm({ ...fieldForm, key: event.target.value })}
            />
          </Field>
          <Field label="Type">
            <Select
              value={fieldForm.fieldType}
              onValueChange={(fieldType) => setFieldForm({ ...fieldForm, fieldType })}
            >
              {[
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
              ].map((type) => (
                <option key={type} value={type}>
                  {titleCase(type)}
                </option>
              ))}
            </Select>
          </Field>
          {fieldForm.fieldType === "select" ? (
            <Field label="Options" hint="Comma separated">
              <Input
                required
                value={fieldForm.options}
                onChange={(event) => setFieldForm({ ...fieldForm, options: event.target.value })}
              />
            </Field>
          ) : (
            <div />
          )}
          <div className="field-wide">
            <Field label="Description">
              <Textarea
                value={fieldForm.description}
                onChange={(event) =>
                  setFieldForm({ ...fieldForm, description: event.target.value })
                }
              />
            </Field>
          </div>
          <label className="checkbox-row field-wide">
            <input
              type="checkbox"
              checked={fieldForm.required}
              onChange={(event) => setFieldForm({ ...fieldForm, required: event.target.checked })}
            />{" "}
            Required field
          </label>
        </form>
      </Modal>
      <Modal
        open={stageOpen}
        onClose={() => setStageOpen(false)}
        title={editingStageId ? "Edit pipeline stage" : "Add pipeline stage"}
        footer={
          <>
            <Button onClick={() => setStageOpen(false)}>Cancel</Button>
            <Button variant="primary" form="save-stage" type="submit" disabled={saving}>
              {editingStageId ? "Save changes" : "Create stage"}
            </Button>
          </>
        }
      >
        <form id="save-stage" className="form-grid" onSubmit={saveStage}>
          <Field label="Name">
            <Input
              required
              autoFocus
              value={stageForm.name}
              onChange={(event) =>
                setStageForm({
                  ...stageForm,
                  name: event.target.value,
                  key: editingStageId ? stageForm.key : fieldKey(event.target.value),
                })
              }
            />
          </Field>
          <Field label="Probability" hint="0–100%">
            <Input
              type="number"
              min={0}
              max={100}
              required
              value={stageForm.probability}
              onChange={(event) =>
                setStageForm({ ...stageForm, probability: Number(event.target.value) })
              }
            />
          </Field>
          {!editingStageId ? (
            <div className="field-wide">
              <Field label="Stable key" hint="Used by integrations and cannot be changed later">
                <Input
                  required
                  value={stageForm.key}
                  onChange={(event) => setStageForm({ ...stageForm, key: event.target.value })}
                />
              </Field>
            </div>
          ) : null}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={stageForm.terminal}
              onChange={(event) =>
                setStageForm({
                  ...stageForm,
                  terminal: event.target.checked,
                  won: event.target.checked ? stageForm.won : false,
                })
              }
            />{" "}
            Closed stage
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={stageForm.won}
              onChange={(event) =>
                setStageForm({
                  ...stageForm,
                  won: event.target.checked,
                  terminal: event.target.checked || stageForm.terminal,
                  probability: event.target.checked ? 100 : stageForm.probability,
                })
              }
            />{" "}
            Won outcome
          </label>
        </form>
      </Modal>
      <Modal
        open={tagOpen}
        onClose={() => setTagOpen(false)}
        title="Create CRM tag"
        footer={
          <>
            <Button onClick={() => setTagOpen(false)}>Cancel</Button>
            <Button variant="primary" form="create-tag" type="submit" disabled={saving}>
              Create tag
            </Button>
          </>
        }
      >
        <form id="create-tag" className="form-grid" onSubmit={createTag}>
          <Field label="Name">
            <Input
              required
              autoFocus
              value={tagForm.name}
              onChange={(event) => setTagForm({ ...tagForm, name: event.target.value })}
            />
          </Field>
          <Field label="Color">
            <Select
              value={tagForm.color}
              onValueChange={(color) => setTagForm({ ...tagForm, color })}
            >
              {["gray", "blue", "green", "amber", "red", "purple"].map((color) => (
                <option key={color} value={color}>
                  {titleCase(color)}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>
      <Modal
        open={suppressionOpen}
        onClose={() => setSuppressionOpen(false)}
        title="Add suppression"
        footer={
          <>
            <Button onClick={() => setSuppressionOpen(false)}>Cancel</Button>
            <Button variant="primary" form="create-suppression" type="submit" disabled={saving}>
              Add suppression
            </Button>
          </>
        }
      >
        <form id="create-suppression" className="form-grid" onSubmit={createSuppression}>
          <Field label="Type">
            <Select
              value={suppressionForm.kind}
              onValueChange={(kind) => setSuppressionForm({ ...suppressionForm, kind })}
            >
              <option value="email">Email</option>
              <option value="domain">Domain</option>
            </Select>
          </Field>
          <Field label="Value">
            <Input
              required
              autoFocus
              value={suppressionForm.value}
              onChange={(event) =>
                setSuppressionForm({ ...suppressionForm, value: event.target.value })
              }
            />
          </Field>
          <div className="field-wide">
            <Field label="Reason">
              <Textarea
                value={suppressionForm.reason}
                onChange={(event) =>
                  setSuppressionForm({ ...suppressionForm, reason: event.target.value })
                }
              />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(pendingMerge)}
        onClose={() => setPendingMerge(null)}
        title={`Merge ${duplicateType} records`}
        description="Choose the record to keep. The other record is merged into it."
        footer={
          <>
            <Button onClick={() => setPendingMerge(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={saving}
              onClick={() => {
                if (!pendingMerge) return;
                const duplicateId =
                  pendingMerge.keepId === pendingMerge.mergeId
                    ? pendingMerge.records[0]!.id
                    : pendingMerge.mergeId;
                void mergeDuplicate(pendingMerge.keepId, duplicateId);
              }}
            >
              Merge records
            </Button>
          </>
        }
      >
        <div className="stack-list">
          {(pendingMerge?.records ?? []).map((record) => (
            <label className="checkbox-row" key={record.id}>
              <input
                type="radio"
                name="merge-keep"
                checked={pendingMerge?.keepId === record.id}
                onChange={() =>
                  setPendingMerge((current) => current && { ...current, keepId: record.id })
                }
              />{" "}
              {record.name} ·{" "}
              {record.domain || record.email || record.title || "No distinguishing value"}
            </label>
          ))}
        </div>
      </Modal>

      <Modal
        open={Boolean(pendingRevoke)}
        onClose={() => setPendingRevoke(null)}
        title="Revoke connection"
        footer={
          <>
            <Button onClick={() => setPendingRevoke(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingRevoke) void revokeConnection(pendingRevoke);
              }}
            >
              Revoke
            </Button>
          </>
        }
      >
        {pendingRevoke ? (
          <p>
            Revoke the {titleCase(pendingRevoke.provider)} connection for{" "}
            {pendingRevoke.accountEmail}?
          </p>
        ) : null}
      </Modal>
    </AppShell>
  );
}
