import {
  ArchiveIcon as Archive,
  CalendarIcon as CalendarClock,
  ChatBubblePlusIcon as MessageSquarePlus,
  ExternalLinkIcon as ExternalLink,
  LinkIcon as Link2,
  PaperAirplaneIcon as Send,
  PencilIcon as Pencil,
  PlusIcon as Plus,
  RefreshIcon as Restore,
  ShieldTickIcon as ShieldCheck,
  UserCirclePlusIcon as UserPlus,
} from "../components/icons";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { LocationFields } from "../components/location-fields";
import { AppShell } from "../components/shell";
import { CrmRecordExtras } from "../components/crm-record-extras";
import { TaskStatusDisplay } from "../components/task-status";
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
import { api, formatDate, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type AccountDetail = {
  account: Record<string, any>;
  contacts: Array<Record<string, any>>;
  activities: Array<Record<string, any>>;
  opportunities: Array<Record<string, any>>;
  tasks: Array<Record<string, any>>;
  approvals: Array<Record<string, any>>;
  signals: Array<Record<string, any>>;
};

export function AccountDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, loading, reload } = useData<AccountDetail>(`/accounts/${id}`);
  const { data: team } = useData<{ members: Array<{ id: string; name: string }> }>("/team");
  const { data: accountOptions } = useData<{ accounts: Array<{ id: string; name: string }> }>(
    "/accounts?pageSize=250",
  );
  const { notify } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [contact, setContact] = useState({
    country: "",
    state: "",
    city: "",
    firstName: "",
    lastName: "",
    title: "",
    email: "",
    linkedinUrl: "",
  });
  const [activity, setActivity] = useState({
    type: "research",
    status: "completed",
    details: "",
    outcome: "",
    dueAt: "",
  });
  const [editForm, setEditForm] = useState({
    name: "",
    domain: "",
    websiteUrl: "",
    linkedinUrl: "",
    ownerId: "",
    parentAccountId: "",
    tier: "C",
    status: "research",
    industry: "",
    country: "",
    state: "",
    city: "",
    employeeRange: "",
    productMotion: "",
    source: "",
    score: "0",
    fitSummary: "",
    evidenceSummary: "",
    triggerSummary: "",
    sourceLinks: "",
    nextAction: "",
    nextActionAt: "",
    disqualificationReason: "",
  });

  useEffect(() => {
    const account = data?.account;
    if (!account) return;
    const nextActionDate = account.next_action_at ? new Date(account.next_action_at) : null;
    const localNextActionAt =
      nextActionDate && !Number.isNaN(nextActionDate.valueOf())
        ? new Date(nextActionDate.valueOf() - nextActionDate.getTimezoneOffset() * 60_000)
            .toISOString()
            .slice(0, 16)
        : "";
    setEditForm({
      name: account.name ?? "",
      domain: account.domain ?? "",
      websiteUrl: account.website_url ?? "",
      linkedinUrl: account.linkedin_url ?? "",
      ownerId: account.owner_id ?? "",
      parentAccountId: account.parent_account_id ?? "",
      tier: account.tier ?? "C",
      status: account.status ?? "research",
      industry: account.industry ?? "",
      country: account.country ?? "",
      state: account.state ?? "",
      city: account.city ?? "",
      employeeRange: account.employee_range ?? "",
      productMotion: account.product_motion ?? "",
      source: account.source ?? "",
      score: String(account.score ?? 0),
      fitSummary: account.fit_summary ?? "",
      evidenceSummary: account.evidence_summary ?? "",
      triggerSummary: account.trigger_summary ?? "",
      sourceLinks: Array.isArray(account.source_links) ? account.source_links.join("\n") : "",
      nextAction: account.next_action ?? "",
      nextActionAt: localNextActionAt,
      disqualificationReason: account.disqualification_reason ?? "",
    });
  }, [data]);

  if (loading)
    return (
      <AppShell>
        <div className="loading-page loading-section-tall">
          <Spinner />
        </div>
      </AppShell>
    );
  if (!data)
    return (
      <AppShell>
        <EmptyState
          title="Account not found"
          description="It may be owned by someone else or no longer exist."
          action={
            <Link to="/accounts">
              <Button>Back to accounts</Button>
            </Link>
          }
        />
      </AppShell>
    );
  const account = data.account;
  const sources = Array.isArray(account.source_links) ? account.source_links : [];
  const isArchived = Boolean(account.archived_at);

  async function submitApproval() {
    try {
      await api(`/accounts/${id}/submit`, { method: "POST" });
      notify("Lead submitted for approval.");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to submit lead.", "error");
    }
  }
  async function addContact(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/contacts", {
        method: "POST",
        body: JSON.stringify({ ...contact, accountId: id }),
      });
      notify("Buyer added.");
      setContactOpen(false);
      setContact({
        firstName: "",
        lastName: "",
        title: "",
        email: "",
        linkedinUrl: "",
        country: "",
        state: "",
        city: "",
      });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to add contact.", "error");
    } finally {
      setSaving(false);
    }
  }
  async function logActivity(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/activities", {
        method: "POST",
        body: JSON.stringify({
          ...activity,
          accountId: id,
          dueAt: activity.dueAt ? new Date(activity.dueAt).toISOString() : null,
        }),
      });
      notify(activity.status === "planned" ? "Follow-up planned." : "Activity logged.");
      setActivityOpen(false);
      setActivity({ type: "research", status: "completed", details: "", outcome: "", dueAt: "" });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to log activity.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveAccount(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(
          crmEditPayload("account", user?.role, {
            ...editForm,
            ownerId: editForm.ownerId || undefined,
            parentAccountId: editForm.parentAccountId || null,
            score: Number(editForm.score),
            sourceLinks: editForm.sourceLinks
              .split(/\r?\n|,/)
              .map((value) => value.trim())
              .filter(Boolean),
            nextActionAt: editForm.nextActionAt
              ? new Date(editForm.nextActionAt).toISOString()
              : null,
            disqualificationReason: editForm.disqualificationReason || null,
          }),
        ),
      });
      notify("Account updated.");
      setEditOpen(false);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update account.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(archived: boolean) {
    setSaving(true);
    try {
      await api(`/accounts/${id}/${archived ? "archive" : "restore"}`, { method: "POST" });
      notify(archived ? "Account archived." : "Account restored.");
      await reload();
    } catch (caught) {
      notify(
        caught instanceof Error
          ? caught.message
          : `Unable to ${archived ? "archive" : "restore"} account.`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell
      title={account.name}
      contentWidth="wide"
      toolbar={
        <PageToolbar label="Account context">
          <Link to="/accounts" className="detail-back-link">
            Accounts
          </Link>
          <span className="toolbar-separator">/</span>
          <span className="detail-context">
            {account.domain ?? "No domain"} · {account.owner_name ?? "Unassigned"}
          </span>
        </PageToolbar>
      }
      actions={
        <>
          <Button disabled={saving} onClick={() => void setArchived(!isArchived)}>
            {isArchived ? <Restore size={15} /> : <Archive size={15} />}
            {isArchived ? "Restore" : "Archive"}
          </Button>
          <Button disabled={isArchived} onClick={() => setEditOpen(true)}>
            <Pencil size={15} /> Edit
          </Button>
          <Button disabled={isArchived} onClick={() => setActivityOpen(true)}>
            <MessageSquarePlus size={15} /> Log activity
          </Button>
          {account.status === "research" && !isArchived ? (
            <Button variant="primary" onClick={() => void submitApproval()}>
              <Send size={15} /> Submit lead
            </Button>
          ) : (
            <Badge
              tone={
                account.status === "approved" || account.status === "active"
                  ? "green"
                  : account.status === "pending_approval"
                    ? "amber"
                    : "neutral"
              }
            >
              {titleCase(account.status)}
            </Badge>
          )}
        </>
      }
    >
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Tier</div>
          <div className="stat-value">{account.tier}</div>
          <div className="stat-detail">Account priority</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Fit score</div>
          <div className="stat-value">{account.score}</div>
          <div className="stat-detail">Out of 100</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Buyers</div>
          <div className="stat-value">{data.contacts.length}</div>
          <div className="stat-detail">Mapped contacts</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Touchpoints</div>
          <div className="stat-value">{data.activities.length}</div>
          <div className="stat-detail">Logged activity</div>
        </div>
      </div>
      <div className="dashboard-grid">
        <div>
          <Panel>
            <div className="panel-header panel-header-inset">
              <div>
                <h2>Qualification brief</h2>
                <p>Evidence before outreach.</p>
              </div>
              <ShieldCheck size={16} />
            </div>
            <div className="form-grid">
              {account.parent_account_id ? (
                <div className="field-wide">
                  <div className="field-label">Parent account</div>
                  <p className="detail-copy">
                    <Link to={`/accounts/${account.parent_account_id}`}>
                      {account.parent_account_name ?? "Parent account"}
                    </Link>
                  </p>
                </div>
              ) : null}
              <div>
                <div className="field-label">Why it fits</div>
                <p className="detail-copy">{account.fit_summary || "Not documented"}</p>
              </div>
              <div>
                <div className="field-label">Current trigger</div>
                <p className="detail-copy">{account.trigger_summary || "Not documented"}</p>
              </div>
              <div className="field-wide">
                <div className="field-label">Evidence</div>
                <p className="detail-copy">{account.evidence_summary || "Not documented"}</p>
              </div>
              {account.research_status || account.outreach_status || account.last_verified_at ? (
                <div className="field-wide">
                  <div className="field-label">Tracker status</div>
                  <div className="source-list">
                    {account.research_status ? (
                      <Badge tone="neutral">Research: {account.research_status}</Badge>
                    ) : null}
                    {account.outreach_status ? (
                      <Badge tone="blue">Outreach: {account.outreach_status}</Badge>
                    ) : null}
                    {account.last_verified_at ? (
                      <Badge tone="neutral">Verified {formatDate(account.last_verified_at)}</Badge>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="field-wide">
                <div className="field-label">Industry vertical</div>
                <p className="detail-copy">{account.industry || "Not set"}</p>
              </div>
              {(
                [
                  ["country", "Country"],
                  ["state", "Company state"],
                  ["city", "Company city"],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <div className="field-label">{label}</div>
                  <p className="detail-copy">{account[key] || "Not set"}</p>
                </div>
              ))}
              {account.current_tools ? (
                <div className="field-wide">
                  <div className="field-label">Company context</div>
                  <p className="detail-copy">{account.current_tools}</p>
                </div>
              ) : null}
              <div className="field-wide">
                <div className="field-label">Sources</div>
                <div className="source-list">
                  {sources.length ? (
                    sources.map((source: string) => (
                      <a href={source} key={source} target="_blank" rel="noreferrer">
                        <Badge tone="blue">
                          <Link2 size={11} /> Source
                        </Badge>
                      </a>
                    ))
                  ) : (
                    <span className="subtle-copy">No sources attached</span>
                  )}
                </div>
              </div>
              {account.disqualification_reason ? (
                <div className="field-wide">
                  <div className="field-label">Disqualification reason</div>
                  <p className="detail-copy">{account.disqualification_reason}</p>
                </div>
              ) : null}
            </div>
          </Panel>
          {data.signals.length ? (
            <Panel flush>
              <div className="panel-header">
                <div>
                  <h2>Signals</h2>
                  <p>Evidence captured from the research tracker.</p>
                </div>
              </div>
              <div className="list">
                {data.signals.map((signal) => (
                  <div className="list-row" key={signal.id}>
                    <div className="list-row-main">
                      <div className="list-row-title">
                        <span>{signal.summary}</span>
                        <Badge tone="blue">{titleCase(signal.kind)}</Badge>
                      </div>
                      <div className="list-row-meta">
                        {signal.evidence ? <span>{signal.evidence}</span> : null}
                        {signal.observed_at ? <span>{formatDate(signal.observed_at)}</span> : null}
                        {signal.source_url ? (
                          <a href={signal.source_url} target="_blank" rel="noreferrer">
                            Open source <ExternalLink size={12} />
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
          <CrmRecordExtras entityType="account" entityId={account.id} />
          <Panel flush>
            <div className="panel-header">
              <div>
                <h2>Timeline</h2>
                <p>Research, touchpoints, follow-ups, and meetings.</p>
              </div>
            </div>
            {data.activities.length ? (
              <div className="list">
                {data.activities.map((item) => (
                  <div className="list-row" key={item.id}>
                    <span className="stat-icon">
                      <CalendarClock size={14} />
                    </span>
                    <div className="list-row-main">
                      <div className="list-row-title">
                        <span>{titleCase(item.type)}</span>
                        <Badge tone={item.status === "planned" ? "amber" : "green"}>
                          {item.status}
                        </Badge>
                      </div>
                      <div className="list-row-meta">
                        <span>{item.details || item.outcome || "No details"}</span>
                        <span>
                          {formatDate(item.occurred_at ?? item.due_at ?? item.created_at, true)}
                        </span>
                        <span>{item.actor_name}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No activity yet"
                description="Log the research that qualified this account or plan the first next action."
              />
            )}
          </Panel>
        </div>
        <div>
          <Panel flush>
            <div className="panel-header">
              <div>
                <h2>Buyer map</h2>
                <p>Reach multiple relevant people in strong accounts.</p>
              </div>
              <Button
                variant="plain"
                size="icon"
                aria-label="Add buyer"
                onClick={() => setContactOpen(true)}
              >
                <UserPlus size={16} />
              </Button>
            </div>
            {data.contacts.length ? (
              <div className="list">
                {data.contacts.map((person) => (
                  <div className="list-row" key={person.id}>
                    <Avatar name={`${person.first_name} ${person.last_name ?? ""}`} size="small" />
                    <div className="list-row-main">
                      <div className="list-row-title">
                        <Link to={`/contacts?contact=${person.id}`}>
                          {person.first_name} {person.last_name}
                        </Link>
                      </div>
                      <div className="list-row-meta">
                        <span>{person.title ?? "Title unknown"}</span>
                        <span>{person.linkedin_state ?? person.status}</span>
                        {person.linkedin_connection_note ? (
                          <span>Connection note saved</span>
                        ) : null}
                      </div>
                    </div>
                    {person.linkedin_url ? (
                      <a
                        href={person.linkedin_url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open LinkedIn"
                      >
                        <ExternalLink size={14} />
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No buyers mapped"
                description="At least one relevant buyer is required before lead approval."
                action={
                  <Button onClick={() => setContactOpen(true)}>
                    <Plus size={14} /> Add buyer
                  </Button>
                }
              />
            )}
          </Panel>
          <Panel flush>
            <div className="panel-header">
              <div>
                <h2>Opportunities</h2>
                <p>Commercial work connected to this account.</p>
              </div>
            </div>
            {data.opportunities.length ? (
              <div className="list">
                {data.opportunities.map((opportunity) => {
                  const amount = Number(opportunity.value_amount);
                  return (
                    <div className="list-row" key={opportunity.id}>
                      <div className="list-row-main">
                        <div className="list-row-title">
                          <Link to={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
                          <Badge tone={opportunity.archived_at ? "neutral" : "blue"}>
                            {opportunity.archived_at ? "Archived" : opportunity.stage_name}
                          </Badge>
                        </div>
                        <div className="list-row-meta">
                          <span>
                            {Number.isFinite(amount)
                              ? new Intl.NumberFormat(undefined, {
                                  style: "currency",
                                  currency: opportunity.currency ?? "USD",
                                  maximumFractionDigits: 0,
                                }).format(amount)
                              : "Value not set"}
                          </span>
                          <span>{opportunity.next_action || "No next action"}</span>
                          <span>{formatDate(opportunity.next_action_at, true)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                title="No opportunities"
                description="Create an opportunity from Pipeline after a real conversation."
                action={
                  <Link to="/pipeline">
                    <Button>Open pipeline</Button>
                  </Link>
                }
              />
            )}
          </Panel>
          <Panel flush>
            <div className="panel-header">
              <div>
                <h2>Open work</h2>
                <p>Tasks connected to this account.</p>
              </div>
            </div>
            {data.tasks.length ? (
              <div className="list">
                {data.tasks.map((task) => (
                  <div className="list-row" key={task.id}>
                    <div className="list-row-main">
                      <div className="list-row-title">
                        <span>{task.title}</span>
                      </div>
                      <div className="list-row-meta">
                        <span>{task.owner_name}</span>
                        <TaskStatusDisplay status={task.status} iconSize={14} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No linked work"
                description="Create tasks from the Tasks view and connect them to this account."
              />
            )}
          </Panel>
        </div>
      </div>
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit account"
        description="Keep qualification, ownership, and lifecycle context in one durable record."
        footer={
          <>
            <Button onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="primary" form="edit-account" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <form id="edit-account" className="form-grid" onSubmit={saveAccount}>
          <Field label="Company">
            <Input
              required
              autoFocus
              value={editForm.name}
              onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
            />
          </Field>
          <Field label="Domain">
            <Input
              value={editForm.domain}
              onChange={(event) => setEditForm({ ...editForm, domain: event.target.value })}
            />
          </Field>
          <Field label="Website">
            <Input
              type="url"
              value={editForm.websiteUrl}
              onChange={(event) => setEditForm({ ...editForm, websiteUrl: event.target.value })}
            />
          </Field>
          <Field label="LinkedIn">
            <Input
              type="url"
              value={editForm.linkedinUrl}
              onChange={(event) => setEditForm({ ...editForm, linkedinUrl: event.target.value })}
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
          <Field label="Parent account">
            <Select
              searchable
              value={editForm.parentAccountId}
              onValueChange={(parentAccountId) => setEditForm({ ...editForm, parentAccountId })}
            >
              <option value="">No parent</option>
              {accountOptions?.accounts
                .filter((option) => option.id !== account.id)
                .map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Tier">
            <Select
              value={editForm.tier}
              onValueChange={(tier) => setEditForm({ ...editForm, tier })}
            >
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
            </Select>
          </Field>
          <Field label="Lifecycle">
            <Select
              value={editForm.status}
              disabled={user?.role === "ic"}
              onValueChange={(status) => setEditForm({ ...editForm, status })}
            >
              {[
                "research",
                "pending_approval",
                "approved",
                "active",
                "nurture",
                "disqualified",
              ].map((status) => (
                <option key={status} value={status}>
                  {titleCase(status)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fit score">
            <Input
              type="number"
              min="0"
              max="100"
              value={editForm.score}
              onChange={(event) => setEditForm({ ...editForm, score: event.target.value })}
            />
          </Field>
          <Field label="Industry vertical">
            <Input
              value={editForm.industry}
              maxLength={120}
              placeholder="e.g. HR technology, Healthcare, Fintech"
              onChange={(event) => setEditForm({ ...editForm, industry: event.target.value })}
            />
          </Field>
          <LocationFields
            company
            value={editForm}
            onChange={(location) => setEditForm({ ...editForm, ...location })}
          />
          <Field label="Employee range">
            <Input
              value={editForm.employeeRange}
              onChange={(event) => setEditForm({ ...editForm, employeeRange: event.target.value })}
            />
          </Field>
          <Field label="Product motion">
            <Input
              value={editForm.productMotion}
              onChange={(event) => setEditForm({ ...editForm, productMotion: event.target.value })}
            />
          </Field>
          <Field label="Source">
            <Input
              value={editForm.source}
              onChange={(event) => setEditForm({ ...editForm, source: event.target.value })}
            />
          </Field>
          <Field label="Next action due">
            <Input
              type="datetime-local"
              value={editForm.nextActionAt}
              onChange={(event) => setEditForm({ ...editForm, nextActionAt: event.target.value })}
            />
          </Field>
          {[
            ["fitSummary", "Why it fits"],
            ["evidenceSummary", "Evidence"],
            ["triggerSummary", "Current trigger"],
            ["nextAction", "Next action"],
          ].map(([key, label]) => (
            <div className="field-wide" key={key}>
              <Field label={label}>
                <Textarea
                  value={editForm[key as keyof typeof editForm]}
                  onChange={(event) => setEditForm({ ...editForm, [key]: event.target.value })}
                />
              </Field>
            </div>
          ))}
          <div className="field-wide">
            <Field label="Source links" hint="One URL per line.">
              <Textarea
                value={editForm.sourceLinks}
                onChange={(event) => setEditForm({ ...editForm, sourceLinks: event.target.value })}
              />
            </Field>
          </div>
          {editForm.status === "disqualified" ? (
            <div className="field-wide">
              <Field label="Disqualification reason">
                <Textarea
                  required
                  value={editForm.disqualificationReason}
                  onChange={(event) =>
                    setEditForm({ ...editForm, disqualificationReason: event.target.value })
                  }
                />
              </Field>
            </div>
          ) : null}
        </form>
      </Modal>
      <Modal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        title="Add a relevant buyer"
        footer={
          <>
            <Button onClick={() => setContactOpen(false)}>Cancel</Button>
            <Button variant="primary" form="add-contact" type="submit" disabled={saving}>
              Add buyer
            </Button>
          </>
        }
      >
        <form id="add-contact" className="form-grid" onSubmit={addContact}>
          <Field label="First name">
            <Input
              required
              autoFocus
              value={contact.firstName}
              onChange={(event) => setContact({ ...contact, firstName: event.target.value })}
            />
          </Field>
          <Field label="Last name">
            <Input
              value={contact.lastName}
              onChange={(event) => setContact({ ...contact, lastName: event.target.value })}
            />
          </Field>
          <Field label="Title">
            <Input
              value={contact.title}
              onChange={(event) => setContact({ ...contact, title: event.target.value })}
            />
          </Field>
          <LocationFields
            value={contact}
            onChange={(location) => setContact({ ...contact, ...location })}
          />
          <Field label="Email">
            <Input
              type="email"
              value={contact.email}
              onChange={(event) => setContact({ ...contact, email: event.target.value })}
            />
          </Field>
          <Field label="LinkedIn">
            <Input
              value={contact.linkedinUrl}
              onChange={(event) => setContact({ ...contact, linkedinUrl: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
      <Modal
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        title="Log or plan activity"
        description="Orbit records work; sending stays manual."
        footer={
          <>
            <Button onClick={() => setActivityOpen(false)}>Cancel</Button>
            <Button variant="primary" form="log-activity" type="submit" disabled={saving}>
              Save activity
            </Button>
          </>
        }
      >
        <form id="log-activity" className="form-grid" onSubmit={logActivity}>
          <Field label="Activity">
            <Select
              value={activity.type}
              onValueChange={(type) => setActivity({ ...activity, type })}
            >
              {[
                "research",
                "email",
                "linkedin_request",
                "linkedin_message",
                "follow_up",
                "call",
                "meeting",
                "demo",
                "teardown",
                "note",
              ].map((type) => (
                <option key={type} value={type}>
                  {titleCase(type)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="State">
            <Select
              value={activity.status}
              onValueChange={(status) => setActivity({ ...activity, status })}
            >
              <option value="completed">Completed</option>
              <option value="planned">Planned</option>
              <option value="skipped">Skipped</option>
            </Select>
          </Field>
          {activity.status === "planned" ? (
            <Field label="Due">
              <Input
                type="datetime-local"
                required
                value={activity.dueAt}
                onChange={(event) => setActivity({ ...activity, dueAt: event.target.value })}
              />
            </Field>
          ) : (
            <Field label="Outcome">
              <Input
                value={activity.outcome}
                onChange={(event) => setActivity({ ...activity, outcome: event.target.value })}
                placeholder="substantive_conversation"
              />
            </Field>
          )}
          <Field label="Details">
            <Textarea
              required
              value={activity.details}
              onChange={(event) => setActivity({ ...activity, details: event.target.value })}
              placeholder="What happened, what changed, and what comes next?"
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
