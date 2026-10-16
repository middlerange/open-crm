import { BuildingsIcon as BriefcaseBusiness, PlusIcon as Plus } from "../components/icons";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { LocationFields } from "../components/location-fields";
import { TransferActions } from "../components/crm-transfer";
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
  SearchInput,
  Select,
  Spinner,
  Textarea,
  useToast,
} from "../components/ui";
import { api, relativeDate, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Account = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  tier: string;
  status: string;
  score: number;
  ownerId: string | null;
  ownerName: string | null;
  fitSummary: string | null;
  triggerSummary: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  contacts: number;
  pendingApproval: boolean;
  archivedAt: string | null;
};
type Team = { members: Array<{ id: string; name: string; role: string }> };

const blank = {
  name: "",
  domain: "",
  linkedinUrl: "",
  parentAccountId: "",
  ownerId: "",
  tier: "B",
  industry: "",
  country: "",
  state: "",
  city: "",
  employeeRange: "20–50",
  productMotion: "Self-serve / PLG",
  source: "",
  fitSummary: "",
  evidenceSummary: "",
  triggerSummary: "",
  sourceLinks: "",
  score: "70",
  nextAction: "",
  nextActionAt: "",
  contactCountry: "",
  contactState: "",
  contactCity: "",
  contactFirstName: "",
  contactLastName: "",
  contactTitle: "",
  contactEmail: "",
  contactLinkedin: "",
};

function statusTone(status: string): "neutral" | "blue" | "green" | "amber" | "red" {
  if (status === "active" || status === "approved") return "green";
  if (status === "pending_approval") return "amber";
  if (status === "disqualified") return "red";
  if (status === "nurture") return "blue";
  return "neutral";
}

export function AccountsPage() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [archived, setArchived] = useState<"active" | "archived" | "all">("active");
  const [sort, setSort] = useState("score");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOwnerId, setBulkOwnerId] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [viewOpen, setViewOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const query = new URLSearchParams({
    archived,
    sort,
    direction: sort === "name" ? "asc" : "desc",
    page: String(page),
    pageSize: "50",
  });
  if (search) query.set("search", search);
  if (status) query.set("status", status);
  const { data, loading, reload } = useData<{
    accounts: Account[];
    pagination: { page: number; pageSize: number; total: number; pages: number };
  }>(`/accounts?${query}`);
  const { data: parentOptions, reload: reloadParentOptions } = useData<{ accounts: Account[] }>(
    "/accounts?pageSize=250",
  );
  const { data: team } = useData<Team>("/team");
  const { data: savedViews, reload: reloadViews } = useData<{
    views: Array<{
      id: string;
      name: string;
      filters: Record<string, unknown>;
      sort: Record<string, unknown>;
    }>;
  }>("/crm/saved-views?entityType=account");
  const { notify } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...blank, ownerId: user?.id ?? "" });
  useEffect(() => {
    const state = location.state as { leadPrefill?: Partial<typeof blank> } | null;
    if (!state?.leadPrefill) return;
    setForm({ ...blank, ownerId: user?.id ?? "", ...state.leadPrefill });
    setModalOpen(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate, user?.id]);
  const accounts = data?.accounts ?? [];
  const hasAccounts = Boolean(data?.accounts.length);
  const hasFilters = Boolean(search || status || archived !== "active");

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const hasContact = form.contactFirstName.trim().length > 0;
    try {
      await api("/accounts", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          domain: form.domain,
          linkedinUrl: form.linkedinUrl,
          parentAccountId: form.parentAccountId || null,
          ownerId: form.ownerId || undefined,
          tier: form.tier,
          industry: form.industry,
          country: form.country,
          state: form.state,
          city: form.city,
          employeeRange: form.employeeRange,
          productMotion: form.productMotion,
          source: form.source,
          fitSummary: form.fitSummary,
          evidenceSummary: form.evidenceSummary,
          triggerSummary: form.triggerSummary,
          sourceLinks: form.sourceLinks
            .split(/\n|,/)
            .map((link) => link.trim())
            .filter(Boolean),
          score: Number(form.score),
          nextAction: form.nextAction,
          nextActionAt: form.nextActionAt ? new Date(form.nextActionAt).toISOString() : null,
          contact: hasContact
            ? {
                country: form.contactCountry,
                state: form.contactState,
                city: form.contactCity,
                firstName: form.contactFirstName,
                lastName: form.contactLastName,
                title: form.contactTitle,
                email: form.contactEmail,
                linkedinUrl: form.contactLinkedin,
              }
            : undefined,
        }),
      });
      notify("Account claimed and added to research.");
      setModalOpen(false);
      setForm({ ...blank, ownerId: user?.id ?? "" });
      await Promise.all([reload(), reloadParentOptions()]);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create account.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function runBulk(action: "assign" | "archive" | "restore" | "status") {
    if (!selected.size) return;
    if (action === "assign" && !bulkOwnerId) {
      notify("Choose an owner first.", "error");
      return;
    }
    if (action === "status" && !bulkStatus) {
      notify("Choose a lifecycle status first.", "error");
      return;
    }
    setSaving(true);
    try {
      await api("/crm/bulk", {
        method: "POST",
        body: JSON.stringify({
          entityType: "account",
          ids: [...selected],
          action,
          ownerId: action === "assign" ? bulkOwnerId : undefined,
          status: action === "status" ? bulkStatus : undefined,
        }),
      });
      notify(`${selected.size} account${selected.size === 1 ? "" : "s"} updated.`);
      setSelected(new Set());
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update accounts.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveView(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/crm/saved-views", {
        method: "POST",
        body: JSON.stringify({
          entityType: "account",
          name: viewName,
          filters: { search, status, archived },
          sort: { field: sort, direction: sort === "name" ? "asc" : "desc" },
          shared: false,
        }),
      });
      notify("Account view saved.");
      setViewOpen(false);
      setViewName("");
      await reloadViews();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to save view.", "error");
    } finally {
      setSaving(false);
    }
  }

  function applyView(id: string) {
    const view = savedViews?.views.find((item) => item.id === id);
    if (!view) return;
    setSearch(typeof view.filters.search === "string" ? view.filters.search : "");
    setStatus(typeof view.filters.status === "string" ? view.filters.status : "");
    setArchived(
      view.filters.archived === "archived" || view.filters.archived === "all"
        ? view.filters.archived
        : "active",
    );
    setSort(typeof view.sort.field === "string" ? view.sort.field : "score");
    setPage(1);
    setSelected(new Set());
  }

  return (
    <AppShell
      contentWidth="wide"
      actions={
        <>
          <TransferActions type="account" filters={query.toString()} onImported={reload} />
          {selected.size ? (
            <>
              <Badge tone="blue">{selected.size} selected</Badge>
              <Button
                disabled={saving}
                onClick={() => void runBulk(archived === "archived" ? "restore" : "archive")}
              >
                {archived === "archived" ? "Restore" : "Archive"}
              </Button>
            </>
          ) : !loading && hasAccounts ? (
            <Button variant="primary" onClick={() => setModalOpen(true)}>
              <Plus size={15} /> Scout account
            </Button>
          ) : null}
        </>
      }
      toolbar={
        <PageToolbar className="table-toolbar" label="Search and filter accounts">
          <SearchInput
            className="table-toolbar-search"
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search company, domain, or industry…"
          />
          <div className="table-toolbar-controls">
            {savedViews?.views.length ? (
              <Select aria-label="Apply a saved view" value="" onValueChange={applyView}>
                <option value="">Saved views</option>
                {savedViews.views.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Select
              aria-label="Filter by account state"
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
            >
              <option value="">All states</option>
              {[
                "research",
                "pending_approval",
                "approved",
                "active",
                "nurture",
                "disqualified",
              ].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter archived accounts"
              value={archived}
              onValueChange={(value) => {
                setArchived(value as typeof archived);
                setPage(1);
                setSelected(new Set());
              }}
            >
              <option value="active">Active accounts</option>
              <option value="archived">Archived accounts</option>
              <option value="all">All accounts</option>
            </Select>
            <Select
              aria-label="Sort accounts"
              value={sort}
              onValueChange={(value) => {
                setSort(value);
                setPage(1);
              }}
            >
              <option value="score">Fit score</option>
              <option value="name">Company name</option>
              <option value="updated">Recently updated</option>
              <option value="activity">Recent activity</option>
            </Select>
            <Button className="accounts-save-view" size="small" onClick={() => setViewOpen(true)}>
              Save view
            </Button>
            {selected.size && user?.role !== "ic" ? (
              <>
                <Select
                  aria-label="Bulk account owner"
                  value={bulkOwnerId}
                  onValueChange={setBulkOwnerId}
                >
                  <option value="">Choose owner</option>
                  {team?.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </Select>
                <Button
                  size="small"
                  disabled={!bulkOwnerId || saving}
                  onClick={() => void runBulk("assign")}
                >
                  Assign
                </Button>
                <Select
                  aria-label="Bulk lifecycle status"
                  value={bulkStatus}
                  onValueChange={setBulkStatus}
                >
                  <option value="">Choose lifecycle</option>
                  {[
                    "research",
                    "pending_approval",
                    "approved",
                    "active",
                    "nurture",
                    "disqualified",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {titleCase(value)}
                    </option>
                  ))}
                </Select>
                <Button
                  size="small"
                  disabled={!bulkStatus || saving}
                  onClick={() => void runBulk("status")}
                >
                  Update status
                </Button>
              </>
            ) : null}
          </div>
        </PageToolbar>
      }
    >
      <div className="accounts-index">
        <Panel className="table-surface" flush>
          {loading ? (
            <div className="loading-page loading-section">
              <Spinner />
            </div>
          ) : accounts.length ? (
            <div className="data-table-wrap accounts-table-wrap">
              <table className="data-table accounts-table" aria-label="Accounts">
                <colgroup>
                  <col className="accounts-column-select" />
                  <col className="accounts-column-company" />
                  <col className="accounts-column-industry" />
                  <col className="accounts-column-owner" />
                  <col className="accounts-column-tier" />
                  <col className="accounts-column-state" />
                  <col className="accounts-column-buyers" />
                  <col className="accounts-column-score" />
                  <col className="accounts-column-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th>
                      <label className="table-select-control">
                        <span className="sr-only">Select all visible accounts</span>
                        <input
                          type="checkbox"
                          aria-label="Select all visible accounts"
                          checked={
                            accounts.length > 0 &&
                            accounts.every((account) => selected.has(account.id))
                          }
                          onChange={(event) => {
                            const next = new Set(selected);
                            for (const account of accounts) {
                              if (event.target.checked) next.add(account.id);
                              else next.delete(account.id);
                            }
                            setSelected(next);
                          }}
                        />
                      </label>
                    </th>
                    <th>Company</th>
                    <th>Industry vertical</th>
                    <th>Owner</th>
                    <th>Tier</th>
                    <th>State</th>
                    <th className="numeric">Buyers</th>
                    <th className="numeric">Score</th>
                    <th>Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr
                      className={selected.has(account.id) ? "is-selected" : undefined}
                      key={account.id}
                    >
                      <td>
                        <label className="table-select-control">
                          <span className="sr-only">Select {account.name}</span>
                          <input
                            type="checkbox"
                            aria-label={`Select ${account.name}`}
                            checked={selected.has(account.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(account.id);
                              else next.delete(account.id);
                              setSelected(next);
                            }}
                          />
                        </label>
                      </td>
                      <td>
                        <Link className="table-identity" to={`/accounts/${account.id}`}>
                          <span className="table-identity-mark" aria-hidden="true">
                            {account.name.trim().charAt(0).toUpperCase() || "?"}
                          </span>
                          <span className="table-identity-copy">
                            <span className="table-title">{account.name}</span>
                            <span className="table-secondary">
                              {account.domain ?? account.triggerSummary ?? "No domain"}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td data-label="Industry vertical">{account.industry || "Not set"}</td>
                      <td className="account-owner" data-label="Owner">
                        {account.ownerName ?? "Unassigned"}
                      </td>
                      <td data-label="Tier">
                        <Badge
                          tone={
                            account.tier === "A"
                              ? "purple"
                              : account.tier === "B"
                                ? "blue"
                                : "neutral"
                          }
                        >
                          Tier {account.tier}
                        </Badge>
                      </td>
                      <td data-label="State">
                        <Badge tone={statusTone(account.status)}>
                          {account.pendingApproval ? "Pending approval" : titleCase(account.status)}
                        </Badge>
                        {account.archivedAt ? (
                          <div className="table-secondary">Archived</div>
                        ) : null}
                      </td>
                      <td className="numeric" data-label="Buyers">
                        {account.contacts}
                      </td>
                      <td className="numeric" data-label="Score">
                        {account.score}
                      </td>
                      <td className="account-next-cell">
                        <div className="account-next-action">
                          <span
                            className={
                              account.nextActionAt && new Date(account.nextActionAt) < new Date()
                                ? "overdue"
                                : undefined
                            }
                            title={account.nextAction || "Not set"}
                          >
                            {account.nextAction || "Not set"}
                          </span>
                          <span className="account-next-date">
                            {relativeDate(account.nextActionAt)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<BriefcaseBusiness size={20} />}
              title={hasFilters ? "No matching accounts" : "No accounts yet"}
              description={
                hasFilters
                  ? "Try another search or clear the current account filter."
                  : "Scout the first account with fit evidence, a live trigger, and an identifiable buyer."
              }
              action={
                hasFilters ? (
                  <Button
                    onClick={() => {
                      setSearch("");
                      setStatus("");
                      setArchived("active");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => setModalOpen(true)}>
                    <Plus size={15} /> Scout account
                  </Button>
                )
              }
            />
          )}
        </Panel>
        {data?.pagination && data.pagination.pages > 1 ? (
          <div className="pagination-row accounts-pagination">
            <Button
              size="small"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </Button>
            <span>
              Page {data.pagination.page} of {data.pagination.pages} · {data.pagination.total}{" "}
              accounts
            </span>
            <Button
              size="small"
              disabled={page >= data.pagination.pages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
      <Modal
        open={viewOpen}
        onClose={() => setViewOpen(false)}
        title="Save account view"
        description="Reuse the current search, lifecycle, archive, and sort settings."
        footer={
          <>
            <Button onClick={() => setViewOpen(false)}>Cancel</Button>
            <Button variant="primary" form="save-account-view" type="submit" disabled={saving}>
              Save view
            </Button>
          </>
        }
      >
        <form id="save-account-view" onSubmit={saveView}>
          <Field label="View name">
            <Input
              required
              autoFocus
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
            />
          </Field>
        </form>
      </Modal>
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Scout and claim an account"
        description="Claiming happens immediately; approval comes after the evidence is complete."
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" form="create-account" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save account"}
            </Button>
          </>
        }
      >
        <form id="create-account" className="form-grid" onSubmit={createAccount}>
          <Field label="Company">
            <Input
              required
              autoFocus
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Acme SaaS"
            />
          </Field>
          <Field label="Domain">
            <Input
              value={form.domain}
              onChange={(event) => setForm({ ...form, domain: event.target.value })}
              placeholder="acme.com"
            />
          </Field>
          <Field
            label="Owner"
            hint={
              user?.role === "ic"
                ? "Accounts you scout are assigned to you."
                : "One accountable owner per company."
            }
          >
            <Select
              value={form.ownerId}
              disabled={user?.role === "ic"}
              onValueChange={(ownerId) => setForm({ ...form, ownerId })}
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
              value={form.parentAccountId}
              onValueChange={(parentAccountId) => setForm({ ...form, parentAccountId })}
            >
              <option value="">No parent</option>
              {(parentOptions?.accounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tier">
            <Select value={form.tier} onValueChange={(tier) => setForm({ ...form, tier })}>
              <option value="A">Tier A · fit + live signal</option>
              <option value="B">Tier B · fit, weaker timing</option>
              <option value="C">Tier C · more research needed</option>
            </Select>
          </Field>
          <Field label="Industry vertical">
            <Input
              value={form.industry}
              maxLength={120}
              placeholder="e.g. HR technology, Healthcare, Fintech"
              onChange={(event) => setForm({ ...form, industry: event.target.value })}
            />
          </Field>
          <LocationFields
            company
            value={form}
            onChange={(location) => setForm({ ...form, ...location })}
          />
          <Field label="Employee range">
            <Input
              value={form.employeeRange}
              onChange={(event) => setForm({ ...form, employeeRange: event.target.value })}
            />
          </Field>
          <Field label="Product motion">
            <Input
              value={form.productMotion}
              onChange={(event) => setForm({ ...form, productMotion: event.target.value })}
            />
          </Field>
          <Field label="Company LinkedIn">
            <Input
              value={form.linkedinUrl}
              onChange={(event) => setForm({ ...form, linkedinUrl: event.target.value })}
              placeholder="linkedin.com/company/acme"
            />
          </Field>
          <Field label="Source">
            <Input
              value={form.source}
              onChange={(event) => setForm({ ...form, source: event.target.value })}
              placeholder="Product Hunt, job post, YC…"
            />
          </Field>
          <Field label="Why it fits">
            <Textarea
              value={form.fitSummary}
              onChange={(event) => setForm({ ...form, fitSummary: event.target.value })}
              placeholder="B2B SaaS, active web product, PLG motion, fragmented customer workflows…"
            />
          </Field>
          <Field label="Current trigger">
            <Textarea
              value={form.triggerSummary}
              onChange={(event) => setForm({ ...form, triggerSummary: event.target.value })}
              placeholder="Growth hire, funding, feature launch, new support tooling…"
            />
          </Field>
          <Field label="Evidence">
            <Textarea
              value={form.evidenceSummary}
              onChange={(event) => setForm({ ...form, evidenceSummary: event.target.value })}
              placeholder="Specific public observations that make this account worth contacting."
            />
          </Field>
          <Field label="Source links" hint="One URL per line.">
            <Textarea
              value={form.sourceLinks}
              onChange={(event) => setForm({ ...form, sourceLinks: event.target.value })}
              placeholder="https://…"
            />
          </Field>
          <Field label="Fit score">
            <Input
              type="number"
              min="0"
              max="100"
              value={form.score}
              onChange={(event) => setForm({ ...form, score: event.target.value })}
            />
          </Field>
          <Field label="Next action">
            <Input
              value={form.nextAction}
              onChange={(event) => setForm({ ...form, nextAction: event.target.value })}
              placeholder="Verify Head of Product"
            />
          </Field>
          <Field label="Next action due">
            <Input
              type="datetime-local"
              value={form.nextActionAt}
              onChange={(event) => setForm({ ...form, nextActionAt: event.target.value })}
            />
          </Field>
          <div />
          <div className="field-wide form-section-break">
            <div className="form-section-title">
              Initial buyer <span>optional now, required for approval</span>
            </div>
          </div>
          <Field label="First name">
            <Input
              value={form.contactFirstName}
              onChange={(event) => setForm({ ...form, contactFirstName: event.target.value })}
            />
          </Field>
          <Field label="Last name">
            <Input
              value={form.contactLastName}
              onChange={(event) => setForm({ ...form, contactLastName: event.target.value })}
            />
          </Field>
          <Field label="Title">
            <Input
              value={form.contactTitle}
              onChange={(event) => setForm({ ...form, contactTitle: event.target.value })}
              placeholder="Head of Product"
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.contactEmail}
              onChange={(event) => setForm({ ...form, contactEmail: event.target.value })}
            />
          </Field>
          <LocationFields
            value={{
              country: form.contactCountry,
              state: form.contactState,
              city: form.contactCity,
            }}
            onChange={(location) =>
              setForm({
                ...form,
                contactCountry: location.country,
                contactState: location.state,
                contactCity: location.city,
              })
            }
          />
          <Field label="LinkedIn">
            <Input
              value={form.contactLinkedin}
              onChange={(event) => setForm({ ...form, contactLinkedin: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
