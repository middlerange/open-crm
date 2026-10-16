import {
  ActivityIcon as Activity,
  ArchiveIcon as Archive,
  BuildingsIcon as Building,
  ChatBubbleIcon as MessageCircle,
  ExternalLinkIcon as ExternalLink,
  MailIcon as Mail,
  MicrophoneIcon as Phone,
  PencilIcon as Pencil,
  PlusIcon as Plus,
  RefreshIcon as Restore,
  UserCircleIcon as UserCircle,
} from "../components/icons";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";

import { LocationFields } from "../components/location-fields";
import { TransferActions } from "../components/crm-transfer";
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
  SearchInput,
  Select,
  Spinner,
  Textarea,
  useToast,
} from "../components/ui";
import { api, formatDate, titleCase } from "../lib/api";
import { crmEditPayload } from "../lib/crm-edit";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Account = { id: string; name: string };
type TeamMember = { id: string; name: string; role: string };

type ContactWire = {
  id: string;
  firstName?: string | null;
  first_name?: string | null;
  lastName?: string | null;
  last_name?: string | null;
  accountId?: string | null;
  account_id?: string | null;
  accountName?: string | null;
  account_name?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  ownerName?: string | null;
  owner_name?: string | null;
  title?: string | null;
  department?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  linkedin_url?: string | null;
  buyerRole?: string | null;
  buyer_role?: string | null;
  status?: string | null;
  consentStatus?: string | null;
  consent_status?: string | null;
  preferredChannel?: string | null;
  preferred_channel?: string | null;
  notes?: string | null;
  archivedAt?: string | null;
  archived_at?: string | null;
  archived?: boolean;
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
};

type Contact = {
  id: string;
  firstName: string;
  lastName: string;
  accountId: string;
  accountName: string;
  ownerId: string;
  ownerName: string;
  title: string;
  department: string;
  country: string;
  state: string;
  city: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  buyerRole: string;
  status: string;
  consentStatus: string;
  preferredChannel: string;
  notes: string;
  archivedAt: string | null;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type OpportunityWire = {
  id: string;
  name: string;
  stageName?: string | null;
  stage_name?: string | null;
  valueAmount?: number | string | null;
  value_amount?: number | string | null;
  currency?: string | null;
  nextAction?: string | null;
  next_action?: string | null;
  nextActionAt?: string | null;
  next_action_at?: string | null;
};

type ActivityWire = {
  id: string;
  type: string;
  status: string;
  outcome?: string | null;
  details?: string | null;
  actorName?: string | null;
  actor_name?: string | null;
  occurredAt?: string | null;
  occurred_at?: string | null;
  dueAt?: string | null;
  due_at?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
};

type ContactDetailResponse = {
  contact: ContactWire;
  opportunities?: OpportunityWire[];
  activities?: ActivityWire[];
  channelStates?: Array<{
    channel: string;
    state: string;
    connectionNote: string | null;
    requestedAt: string | null;
    connectedAt: string | null;
    lastMessageAt: string | null;
  }>;
};

type ContactForm = {
  firstName: string;
  lastName: string;
  accountId: string;
  ownerId: string;
  title: string;
  department: string;
  country: string;
  state: string;
  city: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  buyerRole: string;
  status: string;
  consentStatus: string;
  preferredChannel: string;
  notes: string;
};

const contactStatuses = [
  "identified",
  "verified",
  "contacted",
  "engaged",
  "qualified",
  "not_interested",
  "invalid",
] as const;

const consentStatuses = ["unknown", "legitimate_interest", "opted_in", "opted_out"] as const;
const preferredChannels = ["email", "phone", "linkedin"] as const;

function blankContact(accountId = "", ownerId = ""): ContactForm {
  return {
    firstName: "",
    lastName: "",
    accountId,
    ownerId,
    title: "",
    department: "",
    country: "",
    state: "",
    city: "",
    email: "",
    phone: "",
    linkedinUrl: "",
    buyerRole: "",
    status: "identified",
    consentStatus: "unknown",
    preferredChannel: "",
    notes: "",
  };
}

function normalizeContact(value: ContactWire): Contact {
  const archivedAt = value.archivedAt ?? value.archived_at ?? null;
  return {
    id: value.id,
    firstName: value.firstName ?? value.first_name ?? "",
    lastName: value.lastName ?? value.last_name ?? "",
    accountId: value.accountId ?? value.account_id ?? "",
    accountName: value.accountName ?? value.account_name ?? "Unassigned account",
    ownerId: value.ownerId ?? value.owner_id ?? "",
    ownerName: value.ownerName ?? value.owner_name ?? "Unassigned",
    title: value.title ?? "",
    department: value.department ?? "",
    country: value.country ?? "",
    state: value.state ?? "",
    city: value.city ?? "",
    email: value.email ?? "",
    phone: value.phone ?? "",
    linkedinUrl: value.linkedinUrl ?? value.linkedin_url ?? "",
    buyerRole: value.buyerRole ?? value.buyer_role ?? "",
    status: value.status ?? "identified",
    consentStatus: value.consentStatus ?? value.consent_status ?? "unknown",
    preferredChannel: value.preferredChannel ?? value.preferred_channel ?? "",
    notes: value.notes ?? "",
    archivedAt,
    archived: value.archived ?? Boolean(archivedAt),
    createdAt: value.createdAt ?? value.created_at ?? null,
    updatedAt: value.updatedAt ?? value.updated_at ?? null,
  };
}

function formFromContact(contact: Contact): ContactForm {
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    accountId: contact.accountId,
    ownerId: contact.ownerId,
    title: contact.title,
    department: contact.department,
    country: contact.country,
    state: contact.state,
    city: contact.city,
    email: contact.email,
    phone: contact.phone,
    linkedinUrl: contact.linkedinUrl,
    buyerRole: contact.buyerRole,
    status: contact.status,
    consentStatus: contact.consentStatus,
    preferredChannel: contact.preferredChannel,
    notes: contact.notes,
  };
}

function contactPayload(form: ContactForm) {
  return {
    ...form,
    ownerId: form.ownerId || undefined,
    preferredChannel: form.preferredChannel || null,
  };
}

function contactName(contact: Contact) {
  return `${contact.firstName} ${contact.lastName}`.trim() || "Unnamed contact";
}

function statusTone(status: string): "neutral" | "blue" | "green" | "amber" | "red" {
  if (status === "qualified" || status === "engaged") return "green";
  if (status === "contacted" || status === "verified") return "blue";
  if (status === "not_interested" || status === "invalid") return "red";
  return "neutral";
}

function consentTone(status: string): "neutral" | "blue" | "green" | "amber" | "red" {
  if (status === "opted_in") return "green";
  if (status === "legitimate_interest") return "blue";
  if (status === "opted_out") return "red";
  return "amber";
}

function ActivityTypeIcon({ type }: { type: string }) {
  if (type === "email") return <Mail size={14} />;
  if (type.startsWith("linkedin")) return <MessageCircle size={14} />;
  if (type === "call") return <Phone size={14} />;
  return <Activity size={14} />;
}

function ContactFields({
  form,
  setForm,
  accounts,
  members,
  ownerLocked,
  autoFocus = false,
}: {
  form: ContactForm;
  setForm: (form: ContactForm) => void;
  accounts: Account[];
  members: TeamMember[];
  ownerLocked: boolean;
  autoFocus?: boolean;
}) {
  return (
    <>
      <Field label="First name">
        <Input
          required
          autoFocus={autoFocus}
          value={form.firstName}
          onChange={(event) => setForm({ ...form, firstName: event.target.value })}
        />
      </Field>
      <Field label="Last name">
        <Input
          value={form.lastName}
          onChange={(event) => setForm({ ...form, lastName: event.target.value })}
        />
      </Field>
      <Field label="Account">
        <Select
          required
          searchable
          value={form.accountId}
          onValueChange={(accountId) => setForm({ ...form, accountId })}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Owner" hint={ownerLocked ? "IC contacts stay assigned to you." : undefined}>
        <Select
          required
          searchable
          disabled={ownerLocked}
          value={form.ownerId}
          onValueChange={(ownerId) => setForm({ ...form, ownerId })}
        >
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Title">
        <Input
          value={form.title}
          onChange={(event) => setForm({ ...form, title: event.target.value })}
          placeholder="Head of Product"
        />
      </Field>
      <Field label="Department">
        <Input
          value={form.department}
          onChange={(event) => setForm({ ...form, department: event.target.value })}
          placeholder="Product"
        />
      </Field>
      <LocationFields value={form} onChange={(location) => setForm({ ...form, ...location })} />
      <Field label="Email">
        <Input
          type="email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          placeholder="name@company.com"
        />
      </Field>
      <Field label="Phone">
        <Input
          type="tel"
          value={form.phone}
          onChange={(event) => setForm({ ...form, phone: event.target.value })}
        />
      </Field>
      <Field label="LinkedIn">
        <Input
          type="url"
          value={form.linkedinUrl}
          onChange={(event) => setForm({ ...form, linkedinUrl: event.target.value })}
          placeholder="https://linkedin.com/in/…"
        />
      </Field>
      <Field label="Buyer role">
        <Input
          value={form.buyerRole}
          onChange={(event) => setForm({ ...form, buyerRole: event.target.value })}
          placeholder="Champion, decision maker, evaluator…"
        />
      </Field>
      <Field label="Relationship status">
        <Select value={form.status} onValueChange={(status) => setForm({ ...form, status })}>
          {contactStatuses.map((status) => (
            <option key={status} value={status}>
              {titleCase(status)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Consent">
        <Select
          value={form.consentStatus}
          onValueChange={(consentStatus) => setForm({ ...form, consentStatus })}
        >
          {consentStatuses.map((status) => (
            <option key={status} value={status}>
              {titleCase(status)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Preferred channel">
        <Select
          value={form.preferredChannel}
          onValueChange={(preferredChannel) => setForm({ ...form, preferredChannel })}
        >
          <option value="">Not specified</option>
          {preferredChannels.map((channel) => (
            <option key={channel} value={channel}>
              {titleCase(channel)}
            </option>
          ))}
        </Select>
      </Field>
      <div />
      <div className="field-wide">
        <Field label="Notes">
          <Textarea
            value={form.notes}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
            placeholder="Context, priorities, objections, and useful relationship history."
          />
        </Field>
      </div>
    </>
  );
}

function DetailValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <p className="detail-copy">{children || "—"}</p>
    </div>
  );
}

function formatOpportunityValue(opportunity: OpportunityWire) {
  const raw = opportunity.valueAmount ?? opportunity.value_amount;
  const value = raw === null || raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return "Value not set";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: opportunity.currency ?? "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function ContactDetailModal({
  contactId,
  accounts,
  members,
  ownerLocked,
  onClose,
  onChanged,
}: {
  contactId: string;
  accounts: Account[];
  members: TeamMember[];
  ownerLocked: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { data, loading, error, reload } = useData<ContactDetailResponse>(`/contacts/${contactId}`);
  const { notify } = useToast();
  const contact = useMemo(() => (data ? normalizeContact(data.contact) : null), [data]);
  const [tab, setTab] = useState<"overview" | "opportunities" | "activity">("overview");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ContactForm>(() => blankContact());

  useEffect(() => {
    if (contact) setForm(formFromContact(contact));
  }, [contact]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api(`/contacts/${contactId}`, {
        method: "PATCH",
        body: JSON.stringify(
          crmEditPayload("contact", ownerLocked ? "ic" : "manager", contactPayload(form)),
        ),
      });
      notify("Contact updated.");
      setEditing(false);
      await Promise.all([reload(), onChanged()]);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update contact.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(archived: boolean) {
    setSaving(true);
    try {
      await api(`/contacts/${contactId}/${archived ? "archive" : "restore"}`, { method: "POST" });
      notify(archived ? "Contact archived." : "Contact restored.");
      await onChanged();
      onClose();
    } catch (caught) {
      notify(
        caught instanceof Error
          ? caught.message
          : `Unable to ${archived ? "archive" : "restore"} contact.`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  const title = contact ? contactName(contact) : "Contact details";
  const opportunities = data?.opportunities ?? [];
  const activities = data?.activities ?? [];
  const channelStates = data?.channelStates ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={
        contact ? `${contact.title || "Title unknown"} · ${contact.accountName}` : undefined
      }
      footer={
        contact ? (
          editing ? (
            <>
              <Button
                type="button"
                onClick={() => {
                  setForm(formFromContact(contact));
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                key="save-contact"
                variant="primary"
                form="edit-contact"
                type="submit"
                disabled={saving}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant={contact.archived ? "secondary" : "danger"}
                disabled={saving}
                onClick={() => void setArchived(!contact.archived)}
              >
                {contact.archived ? <Restore size={14} /> : <Archive size={14} />}
                {contact.archived ? "Restore" : "Archive"}
              </Button>
              <Button
                key="edit-contact"
                type="button"
                variant="primary"
                disabled={saving}
                onClick={() => setEditing(true)}
              >
                <Pencil size={14} /> Edit contact
              </Button>
            </>
          )
        ) : null
      }
    >
      <div className="form-grid">
        {loading ? (
          <div className="field-wide loading-page loading-section-compact">
            <Spinner />
          </div>
        ) : error || !contact ? (
          <div className="field-wide">
            <EmptyState
              title="Unable to load contact"
              description={error ?? "This contact may no longer be available."}
            />
          </div>
        ) : editing ? (
          <form id="edit-contact" className="field-wide form-grid" onSubmit={save}>
            <ContactFields
              form={form}
              setForm={setForm}
              accounts={accounts}
              members={members}
              ownerLocked={ownerLocked}
              autoFocus
            />
          </form>
        ) : (
          <>
            <div className="field-wide inline-cluster-start">
              <Avatar name={contactName(contact)} size="large" />
              <div className="stack-compact">
                <div className="inline-cluster">
                  <Badge tone={statusTone(contact.status)}>{titleCase(contact.status)}</Badge>
                  <Badge tone={consentTone(contact.consentStatus)}>
                    {titleCase(contact.consentStatus)}
                  </Badge>
                  {contact.archived ? <Badge tone="neutral">Archived</Badge> : null}
                </div>
                <div className="inline-cluster">
                  {contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : null}
                  {contact.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : null}
                  {contact.linkedinUrl ? (
                    <a href={contact.linkedinUrl} target="_blank" rel="noreferrer">
                      LinkedIn <ExternalLink size={12} />
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
            <PageToolbar className="field-wide" label="Contact detail sections">
              {[
                ["overview", "Overview"],
                ["opportunities", `Opportunities (${opportunities.length})`],
                ["activity", `Activity (${activities.length})`],
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
            {tab === "overview" ? (
              <>
                <Panel className="field-wide">
                  <div className="form-grid">
                    <DetailValue label="Account">
                      {contact.accountId ? (
                        <Link to={`/accounts/${contact.accountId}`}>{contact.accountName}</Link>
                      ) : (
                        contact.accountName
                      )}
                    </DetailValue>
                    <DetailValue label="Owner">{contact.ownerName}</DetailValue>
                    <DetailValue label="Country">{contact.country}</DetailValue>
                    <DetailValue label="State">{contact.state}</DetailValue>
                    <DetailValue label="City">{contact.city}</DetailValue>
                    <DetailValue label="Department">{contact.department}</DetailValue>
                    <DetailValue label="Buyer role">{contact.buyerRole}</DetailValue>
                    <DetailValue label="Preferred channel">
                      {contact.preferredChannel
                        ? titleCase(contact.preferredChannel)
                        : "Not specified"}
                    </DetailValue>
                    <DetailValue label="Added">{formatDate(contact.createdAt)}</DetailValue>
                    <div className="field-wide">
                      <DetailValue label="Notes">{contact.notes}</DetailValue>
                    </div>
                  </div>
                </Panel>
                {channelStates.map((channel) => (
                  <Panel className="field-wide" key={channel.channel}>
                    <div className="form-grid">
                      <DetailValue label={`${titleCase(channel.channel)} status`}>
                        {titleCase(channel.state)}
                      </DetailValue>
                      <DetailValue label="Request sent">
                        {formatDate(channel.requestedAt)}
                      </DetailValue>
                      <div className="field-wide">
                        <DetailValue label="Connection note">
                          {channel.connectionNote || "No connection note captured"}
                        </DetailValue>
                      </div>
                    </div>
                  </Panel>
                ))}
                <div className="field-wide">
                  <CrmRecordExtras entityType="contact" entityId={contact.id} />
                </div>
              </>
            ) : tab === "opportunities" ? (
              <Panel className="field-wide" flush>
                {opportunities.length ? (
                  <div className="list">
                    {opportunities.map((opportunity) => (
                      <div className="list-row" key={opportunity.id}>
                        <span className="stat-icon">
                          <Building size={14} />
                        </span>
                        <div className="list-row-main">
                          <div className="list-row-title">
                            <Link to={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
                            <Badge tone="blue">
                              {opportunity.stageName ?? opportunity.stage_name ?? "Open"}
                            </Badge>
                          </div>
                          <div className="list-row-meta">
                            <span>{formatOpportunityValue(opportunity)}</span>
                            <span>
                              {opportunity.nextAction ??
                                opportunity.next_action ??
                                "No next action"}
                            </span>
                          </div>
                        </div>
                        <span className="activity-time">
                          {formatDate(opportunity.nextActionAt ?? opportunity.next_action_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No related opportunities"
                    description="Attach this contact when an opportunity needs their involvement."
                  />
                )}
              </Panel>
            ) : (
              <Panel className="field-wide" flush>
                {activities.length ? (
                  <div className="list">
                    {activities.map((item) => (
                      <div className="list-row" key={item.id}>
                        <span className="stat-icon">
                          <ActivityTypeIcon type={item.type} />
                        </span>
                        <div className="list-row-main">
                          <div className="list-row-title">
                            <span>{titleCase(item.type)}</span>
                            <Badge
                              tone={
                                item.status === "completed"
                                  ? "green"
                                  : item.status === "planned"
                                    ? "amber"
                                    : "neutral"
                              }
                            >
                              {titleCase(item.status)}
                            </Badge>
                          </div>
                          <div className="list-row-meta">
                            <span>{item.details || item.outcome || "No details"}</span>
                          </div>
                        </div>
                        <div className="list-row-trailing activity-trailing">
                          <span className="activity-time">
                            {formatDate(
                              item.occurredAt ??
                                item.occurred_at ??
                                item.dueAt ??
                                item.due_at ??
                                item.createdAt ??
                                item.created_at,
                              true,
                            )}
                          </span>
                          <span className="activity-actor">
                            {item.actorName ?? item.actor_name ?? "Orbit"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No activity yet"
                    description="Contact-linked outreach and notes will appear here."
                  />
                )}
              </Panel>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export function ContactsPage() {
  const { user } = useAuth();
  const [urlSearchParams, setUrlSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [consentFilter, setConsentFilter] = useState("");
  const [archiveFilter, setArchiveFilter] = useState<"active" | "archived" | "all">("active");
  const deferredSearch = useDeferredValue(search.trim());
  const contactsQuery = new URLSearchParams({ archived: archiveFilter, limit: "250" });
  if (deferredSearch) contactsQuery.set("search", deferredSearch);
  const { data, loading, error, reload } = useData<{ contacts: ContactWire[] }>(
    `/contacts?${contactsQuery}`,
  );
  const { data: accountData } = useData<{ accounts: Account[] }>("/accounts?pageSize=250");
  const { data: teamData } = useData<{ members: TeamMember[] }>("/team");
  const { notify } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    urlSearchParams.get("contact"),
  );
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ContactForm>(() => blankContact("", user?.id ?? ""));

  useEffect(() => {
    setSelectedContactId(urlSearchParams.get("contact"));
  }, [urlSearchParams]);

  const contacts = useMemo(() => (data?.contacts ?? []).map(normalizeContact), [data]);
  const accounts = accountData?.accounts ?? [];
  const members = teamData?.members ?? [];
  const visibleContacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return contacts.filter((contact) => {
      const matchesSearch =
        !query ||
        `${contactName(contact)} ${contact.email} ${contact.title} ${contact.accountName} ${contact.ownerName}`
          .toLowerCase()
          .includes(query);
      const matchesArchive =
        archiveFilter === "all" ||
        (archiveFilter === "archived" ? contact.archived : !contact.archived);
      return (
        matchesSearch &&
        matchesArchive &&
        (!statusFilter || contact.status === statusFilter) &&
        (!consentFilter || contact.consentStatus === consentFilter)
      );
    });
  }, [archiveFilter, consentFilter, contacts, search, statusFilter]);

  const hasContacts = contacts.length > 0 || Boolean(deferredSearch);
  const hasFilters = Boolean(search || statusFilter || consentFilter || archiveFilter !== "active");
  const canCreate = accounts.length > 0;
  const ownerLocked = user?.role === "ic";

  function openCreate() {
    setForm(blankContact(accounts[0]?.id ?? "", user?.id ?? members[0]?.id ?? ""));
    setCreateOpen(true);
  }

  function selectContact(contactId: string | null) {
    setSelectedContactId(contactId);
    const next = new URLSearchParams(urlSearchParams);
    if (contactId) next.set("contact", contactId);
    else next.delete("contact");
    setUrlSearchParams(next, { replace: true });
  }

  async function createContact(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const created = await api<{ id: string }>("/contacts", {
        method: "POST",
        body: JSON.stringify(contactPayload(form)),
      });
      notify("Contact added.");
      setCreateOpen(false);
      setForm(blankContact(accounts[0]?.id ?? "", user?.id ?? ""));
      await reload();
      selectContact(created.id);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to add contact.", "error");
    } finally {
      setSaving(false);
    }
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setConsentFilter("");
    setArchiveFilter("active");
  }

  return (
    <AppShell
      contentWidth="wide"
      actions={
        <>
          <TransferActions
            type="contact"
            filters={new URLSearchParams({
              search,
              status: statusFilter,
              consentStatus: consentFilter,
              archived: archiveFilter,
            }).toString()}
            onImported={reload}
          />
          {!loading && hasContacts && canCreate ? (
            <Button variant="primary" onClick={openCreate}>
              <Plus size={15} /> Add contact
            </Button>
          ) : null}
        </>
      }
      toolbar={
        <PageToolbar className="table-toolbar" label="Search and filter contacts">
          <SearchInput
            className="table-toolbar-search"
            value={search}
            onChange={setSearch}
            placeholder="Search name, account, title, or email…"
            label="Search contacts"
          />
          <div className="table-toolbar-controls">
            <Select
              aria-label="Filter by relationship status"
              value={statusFilter}
              onValueChange={setStatusFilter}
            >
              <option value="">All statuses</option>
              {contactStatuses.map((status) => (
                <option key={status} value={status}>
                  {titleCase(status)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by consent"
              value={consentFilter}
              onValueChange={setConsentFilter}
            >
              <option value="">All consent</option>
              {consentStatuses.map((status) => (
                <option key={status} value={status}>
                  {titleCase(status)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter archived contacts"
              value={archiveFilter}
              onValueChange={(value) => setArchiveFilter(value as typeof archiveFilter)}
            >
              <option value="active">Active contacts</option>
              <option value="archived">Archived contacts</option>
              <option value="all">All contacts</option>
            </Select>
          </div>
        </PageToolbar>
      }
    >
      <Panel className="table-surface" flush>
        {loading ? (
          <div className="loading-page loading-section">
            <Spinner />
          </div>
        ) : error ? (
          <EmptyState
            icon={<UserCircle size={20} />}
            title="Unable to load contacts"
            description={error}
            action={<Button onClick={() => void reload()}>Try again</Button>}
          />
        ) : visibleContacts.length ? (
          <div className="data-table-wrap">
            <table
              className="data-table data-table-responsive contacts-table"
              aria-label="Contacts"
            >
              <colgroup>
                <col className="contacts-column-contact" />
                <col className="contacts-column-account" />
                <col className="contacts-column-owner" />
                <col className="contacts-column-status" />
                <col className="contacts-column-consent" />
                <col className="contacts-column-channel" />
              </colgroup>
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Account</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Consent</th>
                  <th>Preferred channel</th>
                </tr>
              </thead>
              <tbody>
                {visibleContacts.map((contact) => (
                  <tr key={contact.id}>
                    <td data-cell="primary">
                      <Button
                        className="table-identity table-identity-button"
                        variant="plain"
                        size="small"
                        onClick={() => selectContact(contact.id)}
                      >
                        <Avatar name={contactName(contact)} size="medium" />
                        <span className="table-identity-copy">
                          <span className="table-title">{contactName(contact)}</span>
                          <span className="table-secondary">
                            {contact.title || contact.email || "No title or email"}
                          </span>
                        </span>
                      </Button>
                    </td>
                    <td data-cell="wide" data-label="Account">
                      <div className="table-title">{contact.accountName}</div>
                      <div className="table-secondary">{contact.buyerRole || "Role not set"}</div>
                    </td>
                    <td className="table-muted-cell" data-label="Owner">
                      {contact.ownerName}
                    </td>
                    <td data-label="Status">
                      <Badge tone={statusTone(contact.status)}>{titleCase(contact.status)}</Badge>
                      {contact.archived ? <div className="table-secondary">Archived</div> : null}
                    </td>
                    <td data-label="Consent">
                      <Badge tone={consentTone(contact.consentStatus)}>
                        {titleCase(contact.consentStatus)}
                      </Badge>
                    </td>
                    <td className="table-muted-cell" data-label="Channel">
                      {contact.preferredChannel ? titleCase(contact.preferredChannel) : "Not set"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<UserCircle size={20} />}
            title={hasFilters ? "No matching contacts" : "No contacts yet"}
            description={
              hasFilters
                ? "Try another search or clear the current contact filters."
                : canCreate
                  ? "Add the first buyer or stakeholder and connect them to an account."
                  : "Create an account before adding its buyers and stakeholders."
            }
            action={
              hasFilters ? (
                <Button onClick={clearFilters}>Clear filters</Button>
              ) : canCreate ? (
                <Button variant="primary" onClick={openCreate}>
                  <Plus size={15} /> Add contact
                </Button>
              ) : (
                <Link to="/accounts">
                  <Button variant="primary">
                    <Building size={15} /> Create an account
                  </Button>
                </Link>
              )
            }
          />
        )}
      </Panel>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add contact"
        description="Connect this buyer or stakeholder to one accountable company owner."
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" form="create-contact" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save contact"}
            </Button>
          </>
        }
      >
        <form id="create-contact" className="form-grid" onSubmit={createContact}>
          <ContactFields
            form={form}
            setForm={setForm}
            accounts={accounts}
            members={members}
            ownerLocked={ownerLocked}
            autoFocus
          />
        </form>
      </Modal>

      {selectedContactId ? (
        <ContactDetailModal
          key={selectedContactId}
          contactId={selectedContactId}
          accounts={accounts}
          members={members}
          ownerLocked={ownerLocked}
          onClose={() => selectContact(null)}
          onChanged={reload}
        />
      ) : null}
    </AppShell>
  );
}
