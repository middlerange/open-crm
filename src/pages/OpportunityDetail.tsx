import {
  ActivityIcon as Activity,
  ArchiveIcon as Archive,
  ArrowLeftIcon as ArrowLeft,
  ClockIcon as Clock,
  PencilIcon as Pencil,
  PlusIcon as Plus,
  ProjectIcon as OpportunityIcon,
  RefreshIcon as Restore,
  UserCircleIcon as ContactIcon,
} from "../components/icons";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { AppShell } from "../components/shell";
import { CrmRecordExtras } from "../components/crm-record-extras";
import {
  Avatar,
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
import { crmEditPayload } from "../lib/crm-edit";
import { api, formatDate, relativeDate, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Stage = {
  id: string;
  name: string;
  probability: number;
  terminal: boolean;
  won: boolean;
};

type Opportunity = {
  id: string;
  account_id: string;
  account_name: string;
  owner_id: string | null;
  owner_name: string | null;
  stage_id: string;
  stage_name: string;
  stage_probability: number;
  stage_terminal: boolean;
  stage_won: boolean;
  primary_contact_id: string | null;
  primary_contact_name: string | null;
  name: string;
  value_amount: string | number | null;
  currency: string;
  problem_summary: string | null;
  next_action: string;
  next_action_at: string;
  expected_close_at: string | null;
  loss_reason: string | null;
  stage_entered_at: string;
  closed_at: string | null;
  archived_at: string | null;
  created_at: string;
};

type Stakeholder = {
  id: string;
  first_name: string;
  last_name: string | null;
  title: string | null;
  email: string | null;
  role: string;
  is_primary: boolean;
  consent_status: string;
};

type ActivityRecord = {
  id: string;
  type: string;
  status: string;
  details: string | null;
  outcome: string | null;
  actor_name: string | null;
  contact_name: string | null;
  occurred_at: string | null;
  due_at: string | null;
  created_at: string;
};

type StageHistory = {
  id: string;
  from_stage_name: string | null;
  to_stage_name: string;
  changed_by_name: string | null;
  note: string | null;
  changed_at: string;
};

type DetailResponse = {
  opportunity: Opportunity;
  stakeholders: Stakeholder[];
  activities: ActivityRecord[];
  stageHistory: StageHistory[];
};

type ContactOption = {
  id: string;
  firstName: string;
  lastName: string;
  accountId: string;
  title: string;
};

function toLocalDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
}

function contactName(contact: {
  first_name?: string;
  last_name?: string | null;
  firstName?: string;
  lastName?: string;
}) {
  return `${contact.first_name ?? contact.firstName ?? ""} ${contact.last_name ?? contact.lastName ?? ""}`.trim();
}

export function OpportunityDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notify } = useToast();
  const { data, loading, error, reload } = useData<DetailResponse>(`/opportunities/${id}`);
  const { data: pipeline } = useData<{ stages: Stage[] }>("/pipeline");
  const { data: contactsData } = useData<{ contacts: Array<Record<string, unknown>> }>(
    "/contacts?archived=active&limit=250",
  );
  const { data: team } = useData<{ members: Array<{ id: string; name: string }> }>("/team");
  const [tab, setTab] = useState<"overview" | "stakeholders" | "activity" | "history">("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [stakeholderOpen, setStakeholderOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    ownerId: "",
    valueAmount: "",
    currency: "USD",
    problemSummary: "",
    nextAction: "",
    nextActionAt: "",
    expectedCloseAt: "",
    lossReason: "",
  });
  const [stageForm, setStageForm] = useState({ stageId: "", note: "", lossReason: "" });
  const [stakeholderForm, setStakeholderForm] = useState({
    contactId: "",
    role: "stakeholder",
    isPrimary: false,
  });
  const [activityForm, setActivityForm] = useState({
    contactId: "",
    type: "note",
    status: "completed",
    details: "",
    outcome: "",
    dueAt: "",
  });

  const opportunity = data?.opportunity;
  useEffect(() => {
    if (!opportunity) return;
    setEditForm({
      name: opportunity.name,
      ownerId: opportunity.owner_id ?? "",
      valueAmount: opportunity.value_amount === null ? "" : String(opportunity.value_amount),
      currency: opportunity.currency,
      problemSummary: opportunity.problem_summary ?? "",
      nextAction: opportunity.next_action,
      nextActionAt: toLocalDateTime(opportunity.next_action_at),
      expectedCloseAt: opportunity.expected_close_at?.slice(0, 10) ?? "",
      lossReason: opportunity.loss_reason ?? "",
    });
    setStageForm((current) => ({ ...current, stageId: opportunity.stage_id }));
  }, [opportunity]);

  const contactOptions = useMemo<ContactOption[]>(
    () =>
      (contactsData?.contacts ?? [])
        .map((raw) => ({
          id: String(raw.id ?? ""),
          firstName: String(raw.firstName ?? raw.first_name ?? ""),
          lastName: String(raw.lastName ?? raw.last_name ?? ""),
          accountId: String(raw.accountId ?? raw.account_id ?? ""),
          title: String(raw.title ?? ""),
        }))
        .filter((contact) => contact.accountId === opportunity?.account_id),
    [contactsData, opportunity?.account_id],
  );

  const selectedStage = pipeline?.stages.find((stage) => stage.id === stageForm.stageId);

  async function saveOpportunity(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api(`/opportunities/${id}`, {
        method: "PATCH",
        body: JSON.stringify(
          crmEditPayload("opportunity", user?.role, {
            ...editForm,
            ownerId: editForm.ownerId || null,
            valueAmount: editForm.valueAmount ? Number(editForm.valueAmount) : null,
            nextActionAt: new Date(editForm.nextActionAt).toISOString(),
            expectedCloseAt: editForm.expectedCloseAt || null,
            lossReason: editForm.lossReason || null,
          }),
        ),
      });
      notify("Opportunity updated.");
      setEditOpen(false);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update opportunity.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function changeStage(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api(`/opportunities/${id}/stage`, {
        method: "POST",
        body: JSON.stringify(stageForm),
      });
      notify("Pipeline stage updated.");
      setStageOpen(false);
      setStageForm((current) => ({ ...current, note: "", lossReason: "" }));
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to change stage.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function addStakeholder(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api(`/opportunities/${id}/stakeholders`, {
        method: "POST",
        body: JSON.stringify(stakeholderForm),
      });
      notify("Stakeholder added.");
      setStakeholderOpen(false);
      setStakeholderForm({ contactId: "", role: "stakeholder", isPrimary: false });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to add stakeholder.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function removeStakeholder(contactId: string) {
    try {
      await api(`/opportunities/${id}/stakeholders/${contactId}`, { method: "DELETE" });
      notify("Stakeholder removed.");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to remove stakeholder.", "error");
    }
  }

  async function logActivity(event: FormEvent) {
    event.preventDefault();
    if (!opportunity) return;
    setSaving(true);
    try {
      await api("/activities", {
        method: "POST",
        body: JSON.stringify({
          accountId: opportunity.account_id,
          opportunityId: opportunity.id,
          contactId: activityForm.contactId || null,
          type: activityForm.type,
          status: activityForm.status,
          details: activityForm.details,
          outcome: activityForm.outcome,
          dueAt: activityForm.dueAt ? new Date(activityForm.dueAt).toISOString() : null,
        }),
      });
      notify(activityForm.status === "planned" ? "Follow-up scheduled." : "Activity logged.");
      setActivityOpen(false);
      setActivityForm({
        contactId: "",
        type: "note",
        status: "completed",
        details: "",
        outcome: "",
        dueAt: "",
      });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to log activity.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(archived: boolean) {
    setSaving(true);
    try {
      await api(`/opportunities/${id}/${archived ? "archive" : "restore"}`, { method: "POST" });
      notify(archived ? "Opportunity archived." : "Opportunity restored.");
      await reload();
    } catch (caught) {
      notify(
        caught instanceof Error
          ? caught.message
          : `Unable to ${archived ? "archive" : "restore"} opportunity.`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return (
      <AppShell>
        <div className="loading-page loading-section-tall">
          <Spinner />
        </div>
      </AppShell>
    );

  if (error || !opportunity)
    return (
      <AppShell>
        <EmptyState
          icon={<OpportunityIcon size={20} />}
          title="Unable to load opportunity"
          description={error ?? "This opportunity is no longer available."}
          action={<Button onClick={() => navigate("/pipeline")}>Back to pipeline</Button>}
        />
      </AppShell>
    );

  const isArchived = Boolean(opportunity.archived_at);
  const amount = Number(opportunity.value_amount ?? 0);
  const weightedAmount = amount * (Number(opportunity.stage_probability) / 100);

  return (
    <AppShell
      title={opportunity.name}
      contentWidth="wide"
      actions={
        <>
          <Button onClick={() => navigate("/pipeline")}>
            <ArrowLeft size={14} /> Pipeline
          </Button>
          <Button disabled={saving} onClick={() => void setArchived(!isArchived)}>
            {isArchived ? <Restore size={14} /> : <Archive size={14} />}
            {isArchived ? "Restore" : "Archive"}
          </Button>
          {!isArchived ? (
            <Button variant="primary" onClick={() => setEditOpen(true)}>
              <Pencil size={14} /> Edit
            </Button>
          ) : null}
        </>
      }
      toolbar={
        <PageToolbar label="Opportunity sections">
          {[
            ["overview", "Overview"],
            ["stakeholders", `Stakeholders (${data.stakeholders.length})`],
            ["activity", `Activity (${data.activities.length})`],
            ["history", `Stage history (${data.stageHistory.length})`],
          ].map(([value, label]) => (
            <Button
              key={value}
              className={`root-filter ${tab === value ? "is-active" : ""}`}
              size="small"
              variant="plain"
              onClick={() => setTab(value as typeof tab)}
            >
              {label}
            </Button>
          ))}
        </PageToolbar>
      }
    >
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Stage</div>
          <div className="stat-value stat-value-small">{opportunity.stage_name}</div>
          <Button size="small" disabled={isArchived} onClick={() => setStageOpen(true)}>
            Change stage
          </Button>
        </div>
        <div className="stat-card">
          <div className="stat-label">Value</div>
          <div className="stat-value">
            {new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: opportunity.currency,
              maximumFractionDigits: 0,
            }).format(amount)}
          </div>
          <div className="stat-detail">Weighted {Math.round(weightedAmount).toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Next action</div>
          <div className="stat-value stat-value-small">
            {relativeDate(opportunity.next_action_at)}
          </div>
          <div className="stat-detail">{opportunity.next_action}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Close target</div>
          <div className="stat-value stat-value-small">
            {formatDate(opportunity.expected_close_at)}
          </div>
          <div className="stat-detail">
            In stage since {formatDate(opportunity.stage_entered_at)}
          </div>
        </div>
      </div>

      {tab === "overview" ? (
        <div className="detail-grid">
          <Panel>
            <div className="section-heading">
              <div>
                <h2>Opportunity context</h2>
                <p>The commercial problem, next commitment, and ownership.</p>
              </div>
            </div>
            <div className="form-grid">
              <Field label="Account">
                <Link to={`/accounts/${opportunity.account_id}`}>{opportunity.account_name}</Link>
              </Field>
              <Field label="Owner">
                <span>{opportunity.owner_name ?? "Unassigned"}</span>
              </Field>
              <Field label="Primary stakeholder">
                <span>{opportunity.primary_contact_name || "Not selected"}</span>
              </Field>
              <Field label="Created">
                <span>{formatDate(opportunity.created_at)}</span>
              </Field>
              <div className="field-wide">
                <Field label="Problem">
                  <p className="detail-copy">{opportunity.problem_summary || "Not documented"}</p>
                </Field>
              </div>
              <div className="field-wide">
                <Field label="Next action">
                  <p className="detail-copy">{opportunity.next_action}</p>
                </Field>
              </div>
              {opportunity.loss_reason ? (
                <div className="field-wide">
                  <Field label="Loss reason">
                    <p className="detail-copy">{opportunity.loss_reason}</p>
                  </Field>
                </div>
              ) : null}
            </div>
          </Panel>
          <CrmRecordExtras entityType="opportunity" entityId={opportunity.id} />
          <Panel>
            <div className="section-heading">
              <div>
                <h2>Quick actions</h2>
                <p>Keep the opportunity record complete while execution stays manual.</p>
              </div>
            </div>
            <div className="stack-list">
              <Button disabled={isArchived} onClick={() => setActivityOpen(true)}>
                <Activity size={15} /> Log activity
              </Button>
              <Button disabled={isArchived} onClick={() => setStakeholderOpen(true)}>
                <ContactIcon size={15} /> Add stakeholder
              </Button>
              <Button disabled={isArchived} onClick={() => setStageOpen(true)}>
                <OpportunityIcon size={15} /> Change stage
              </Button>
            </div>
          </Panel>
        </div>
      ) : tab === "stakeholders" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>Buying committee</h2>
              <p>People involved in evaluating, approving, championing, or blocking the deal.</p>
            </div>
            <Button disabled={isArchived} onClick={() => setStakeholderOpen(true)}>
              <Plus size={14} /> Add stakeholder
            </Button>
          </div>
          {data.stakeholders.length ? (
            <div className="list">
              {data.stakeholders.map((contact) => (
                <div className="list-row" key={contact.id}>
                  <Avatar name={contactName(contact)} size="small" />
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>{contactName(contact)}</span>
                      <Badge tone={contact.is_primary ? "green" : "neutral"}>
                        {contact.is_primary ? "Primary" : titleCase(contact.role)}
                      </Badge>
                    </div>
                    <div className="list-row-meta">
                      <span>{contact.title || "Title not set"}</span>
                      <span>{contact.email || "Email not set"}</span>
                      <span>{titleCase(contact.consent_status)}</span>
                    </div>
                  </div>
                  <Button
                    variant="plain"
                    size="small"
                    disabled={isArchived}
                    onClick={() => void removeStakeholder(contact.id)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<ContactIcon size={20} />}
              title="No stakeholders attached"
              description="Connect the people who influence this opportunity."
            />
          )}
        </Panel>
      ) : tab === "activity" ? (
        <Panel flush>
          <div className="section-heading section-heading-padded">
            <div>
              <h2>Opportunity timeline</h2>
              <p>Notes, meetings, calls, manual outreach, and planned follow-ups.</p>
            </div>
            <Button disabled={isArchived} onClick={() => setActivityOpen(true)}>
              <Plus size={14} /> Log activity
            </Button>
          </div>
          {data.activities.length ? (
            <div className="list">
              {data.activities.map((item) => (
                <div className="list-row" key={item.id}>
                  <span className="stat-icon">
                    <Activity size={14} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>{titleCase(item.type)}</span>
                      <Badge tone={item.status === "completed" ? "green" : "amber"}>
                        {titleCase(item.status)}
                      </Badge>
                    </div>
                    <div className="list-row-meta">
                      {item.contact_name ? <span>{item.contact_name}</span> : null}
                      <span>{item.details || item.outcome || "No details"}</span>
                    </div>
                  </div>
                  <div className="list-row-trailing">
                    <span>
                      {formatDate(item.occurred_at ?? item.due_at ?? item.created_at, true)}
                    </span>
                    <span>{item.actor_name ?? "Orbit"}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Activity size={20} />}
              title="No opportunity activity"
              description="Log the next meeting, note, or follow-up here."
            />
          )}
        </Panel>
      ) : (
        <Panel flush>
          {data.stageHistory.length ? (
            <div className="list">
              {data.stageHistory.map((entry) => (
                <div className="list-row" key={entry.id}>
                  <span className="stat-icon">
                    <Clock size={14} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>
                        {entry.from_stage_name ? `${entry.from_stage_name} → ` : ""}
                        {entry.to_stage_name}
                      </span>
                    </div>
                    <div className="list-row-meta">
                      <span>{entry.note || "Stage changed"}</span>
                      <span>{entry.changed_by_name ?? "Orbit"}</span>
                    </div>
                  </div>
                  <span>{formatDate(entry.changed_at, true)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No stage history"
              description="Future stage movement will appear here."
            />
          )}
        </Panel>
      )}

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit opportunity"
        footer={
          <>
            <Button onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="edit-opportunity" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <form id="edit-opportunity" className="form-grid" onSubmit={saveOpportunity}>
          <Field label="Opportunity">
            <Input
              required
              autoFocus
              value={editForm.name}
              onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
            />
          </Field>
          <Field label="Owner">
            <Select
              value={editForm.ownerId}
              disabled={user?.role === "ic"}
              onValueChange={(ownerId) => setEditForm({ ...editForm, ownerId })}
            >
              {team?.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Value">
            <Input
              type="number"
              min="0"
              value={editForm.valueAmount}
              onChange={(event) => setEditForm({ ...editForm, valueAmount: event.target.value })}
            />
          </Field>
          <Field label="Currency">
            <Input
              required
              maxLength={3}
              value={editForm.currency}
              onChange={(event) => setEditForm({ ...editForm, currency: event.target.value })}
            />
          </Field>
          <div className="field-wide">
            <Field label="Problem">
              <Textarea
                value={editForm.problemSummary}
                onChange={(event) =>
                  setEditForm({ ...editForm, problemSummary: event.target.value })
                }
              />
            </Field>
          </div>
          <div className="field-wide">
            <Field label="Next action">
              <Textarea
                required
                value={editForm.nextAction}
                onChange={(event) => setEditForm({ ...editForm, nextAction: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Next action due">
            <Input
              required
              type="datetime-local"
              value={editForm.nextActionAt}
              onChange={(event) => setEditForm({ ...editForm, nextActionAt: event.target.value })}
            />
          </Field>
          <Field label="Expected close">
            <Input
              type="date"
              value={editForm.expectedCloseAt}
              onChange={(event) =>
                setEditForm({ ...editForm, expectedCloseAt: event.target.value })
              }
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={stageOpen}
        onClose={() => setStageOpen(false)}
        title="Change pipeline stage"
        description="Every change is recorded in the opportunity history."
        footer={
          <>
            <Button onClick={() => setStageOpen(false)}>Cancel</Button>
            <Button variant="primary" form="stage-change" type="submit" disabled={saving}>
              {saving ? "Moving…" : "Change stage"}
            </Button>
          </>
        }
      >
        <form id="stage-change" className="form-grid" onSubmit={changeStage}>
          <Field label="Stage">
            <Select
              value={stageForm.stageId}
              onValueChange={(stageId) => setStageForm({ ...stageForm, stageId })}
            >
              {pipeline?.stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Change note">
            <Input
              value={stageForm.note}
              onChange={(event) => setStageForm({ ...stageForm, note: event.target.value })}
              placeholder="What changed?"
            />
          </Field>
          {selectedStage?.terminal && !selectedStage.won ? (
            <div className="field-wide">
              <Field label="Loss reason">
                <Textarea
                  required
                  value={stageForm.lossReason}
                  onChange={(event) =>
                    setStageForm({ ...stageForm, lossReason: event.target.value })
                  }
                />
              </Field>
            </div>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={stakeholderOpen}
        onClose={() => setStakeholderOpen(false)}
        title="Add stakeholder"
        description={`Choose a contact from ${opportunity.account_name}.`}
        footer={
          <>
            <Button onClick={() => setStakeholderOpen(false)}>Cancel</Button>
            <Button variant="primary" form="add-stakeholder" type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add stakeholder"}
            </Button>
          </>
        }
      >
        <form id="add-stakeholder" className="form-grid" onSubmit={addStakeholder}>
          <Field label="Contact">
            <Select
              required
              searchable
              value={stakeholderForm.contactId}
              onValueChange={(contactId) => setStakeholderForm({ ...stakeholderForm, contactId })}
            >
              <option value="">Choose contact</option>
              {contactOptions.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contactName(contact)}
                  {contact.title ? ` · ${contact.title}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Input
              required
              value={stakeholderForm.role}
              onChange={(event) =>
                setStakeholderForm({ ...stakeholderForm, role: event.target.value })
              }
              placeholder="Champion, decision maker, legal…"
            />
          </Field>
          <label className="checkbox-row field-wide">
            <input
              type="checkbox"
              checked={stakeholderForm.isPrimary}
              onChange={(event) =>
                setStakeholderForm({ ...stakeholderForm, isPrimary: event.target.checked })
              }
            />
            Make this the primary stakeholder
          </label>
        </form>
      </Modal>

      <Modal
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        title="Log opportunity activity"
        description="Orbit records the work; sending remains manual."
        footer={
          <>
            <Button onClick={() => setActivityOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              form="log-opportunity-activity"
              type="submit"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save activity"}
            </Button>
          </>
        }
      >
        <form id="log-opportunity-activity" className="form-grid" onSubmit={logActivity}>
          <Field label="Contact">
            <Select
              searchable
              value={activityForm.contactId}
              onValueChange={(contactId) => setActivityForm({ ...activityForm, contactId })}
            >
              <option value="">No specific contact</option>
              {contactOptions.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contactName(contact)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Activity type">
            <Select
              value={activityForm.type}
              onValueChange={(type) => setActivityForm({ ...activityForm, type })}
            >
              {["note", "call", "meeting", "email", "follow_up", "demo", "research"].map((type) => (
                <option key={type} value={type}>
                  {titleCase(type)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="State">
            <Select
              value={activityForm.status}
              onValueChange={(status) => setActivityForm({ ...activityForm, status })}
            >
              <option value="completed">Completed</option>
              <option value="planned">Planned</option>
              <option value="skipped">Skipped</option>
            </Select>
          </Field>
          {activityForm.status === "planned" ? (
            <Field label="Due">
              <Input
                required
                type="datetime-local"
                value={activityForm.dueAt}
                onChange={(event) =>
                  setActivityForm({ ...activityForm, dueAt: event.target.value })
                }
              />
            </Field>
          ) : (
            <Field label="Outcome">
              <Input
                value={activityForm.outcome}
                onChange={(event) =>
                  setActivityForm({ ...activityForm, outcome: event.target.value })
                }
              />
            </Field>
          )}
          <div className="field-wide">
            <Field label="Details">
              <Textarea
                required
                value={activityForm.details}
                onChange={(event) =>
                  setActivityForm({ ...activityForm, details: event.target.value })
                }
              />
            </Field>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}
