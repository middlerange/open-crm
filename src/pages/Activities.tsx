import {
  ActivityIcon as Activity,
  ChatBubbleIcon as MessageCircle,
  MailIcon as Mail,
  MicrophoneIcon as Phone,
  PlusIcon as Plus,
} from "../components/icons";
import { useMemo, useState, type FormEvent } from "react";

import { AppShell } from "../components/shell";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageToolbar,
  SearchInput,
  Select,
  Spinner,
  Textarea,
  useToast,
} from "../components/ui";
import { api, formatDate, titleCase } from "../lib/api";
import { useData } from "../lib/use-data";

type ActivityRecord = {
  id: string;
  account_id: string | null;
  account_name: string | null;
  contact_name: string | null;
  actor_name: string | null;
  type: string;
  status: string;
  outcome: string | null;
  details: string | null;
  occurred_at: string | null;
  due_at: string | null;
  created_at: string;
};
type Accounts = { accounts: Array<{ id: string; name: string }> };

function ActivityIcon({ type }: { type: string }) {
  if (type === "email") return <Mail size={14} />;
  if (type.startsWith("linkedin")) return <MessageCircle size={14} />;
  if (type === "call") return <Phone size={14} />;
  return <Activity size={14} />;
}

export function ActivitiesPage() {
  const { data, loading, reload } = useData<{ activities: ActivityRecord[] }>("/activities");
  const { data: accounts } = useData<Accounts>("/accounts");
  const { notify } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    accountId: "",
    type: "email",
    status: "completed",
    outcome: "",
    details: "",
    dueAt: "",
  });
  const activities = useMemo(
    () =>
      (data?.activities ?? []).filter(
        (item) =>
          (!search ||
            `${item.account_name ?? ""} ${item.details ?? ""} ${item.outcome ?? ""}`
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (!typeFilter || item.type === typeFilter),
      ),
    [data, search, typeFilter],
  );

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/activities", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          accountId: form.accountId || null,
          dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
        }),
      });
      notify(form.status === "planned" ? "Follow-up scheduled." : "Activity logged.");
      setModalOpen(false);
      setForm({ ...form, outcome: "", details: "", dueAt: "" });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to log activity.", "error");
    } finally {
      setSaving(false);
    }
  }

  const hasActivity = Boolean(data?.activities.length);
  const hasFilters = Boolean(search || typeFilter);

  return (
    <AppShell
      actions={
        !loading && hasActivity ? (
          <Button variant="primary" onClick={() => setModalOpen(true)}>
            <Plus size={15} /> Log activity
          </Button>
        ) : null
      }
      toolbar={
        <PageToolbar label="Search and filter activity">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search activities…"
            label="Search account, outcome, or note"
          />
          <Select
            aria-label="Filter by activity type"
            value={typeFilter}
            onValueChange={setTypeFilter}
          >
            <option value="">All activity</option>
            {[
              "email",
              "linkedin_request",
              "linkedin_message",
              "follow_up",
              "call",
              "meeting",
              "research",
              "demo",
              "teardown",
              "note",
            ].map((type) => (
              <option key={type} value={type}>
                {titleCase(type)}
              </option>
            ))}
          </Select>
        </PageToolbar>
      }
    >
      {loading ? (
        <div className="loading-page loading-section">
          <Spinner />
        </div>
      ) : activities.length ? (
        <div className="list index-list activity-index-list">
          {activities.map((item) => (
            <div className="list-row" key={item.id}>
              <span className="stat-icon">
                <ActivityIcon type={item.type} />
              </span>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{item.account_name ?? titleCase(item.type)}</span>
                  <Badge
                    tone={
                      item.status === "planned"
                        ? "amber"
                        : item.status === "completed"
                          ? "green"
                          : "neutral"
                    }
                  >
                    {titleCase(item.status)}
                  </Badge>
                </div>
                <div className="list-row-meta">
                  <span>{titleCase(item.type)}</span>
                  {item.contact_name ? <span>{item.contact_name}</span> : null}
                  <span>{item.details || item.outcome || "No details"}</span>
                </div>
              </div>
              <div className="list-row-trailing activity-trailing">
                <span className="activity-time">
                  {formatDate(item.occurred_at ?? item.due_at ?? item.created_at, true)}
                </span>
                <span className="activity-actor">{item.actor_name}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Activity size={20} />}
          title={hasFilters ? "No matching activity" : "No activity recorded"}
          description={
            hasFilters
              ? "Try another search or clear the current activity filter."
              : "Log completed research or outreach, or schedule the first follow-up."
          }
          action={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearch("");
                  setTypeFilter("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setModalOpen(true)}>
                <Plus size={15} /> Log activity
              </Button>
            )
          }
        />
      )}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Log or plan activity"
        description="Sending remains manual. This entry keeps the shared timeline accurate."
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" form="activity-form" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save activity"}
            </Button>
          </>
        }
      >
        <form id="activity-form" className="form-grid" onSubmit={save}>
          <Field label="Account">
            <Select
              value={form.accountId}
              onValueChange={(accountId) => setForm({ ...form, accountId })}
            >
              <option value="">No account</option>
              {accounts?.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Activity">
            <Select value={form.type} onValueChange={(type) => setForm({ ...form, type })}>
              {[
                "email",
                "linkedin_request",
                "linkedin_message",
                "follow_up",
                "call",
                "meeting",
                "research",
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
            <Select value={form.status} onValueChange={(status) => setForm({ ...form, status })}>
              <option value="completed">Completed</option>
              <option value="planned">Planned</option>
              <option value="skipped">Skipped</option>
            </Select>
          </Field>
          {form.status === "planned" ? (
            <Field label="Due">
              <Input
                type="datetime-local"
                required
                value={form.dueAt}
                onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
              />
            </Field>
          ) : (
            <Field label="Outcome">
              <Input
                value={form.outcome}
                onChange={(event) => setForm({ ...form, outcome: event.target.value })}
                placeholder="replied, substantive_conversation…"
              />
            </Field>
          )}
          <Field label="Details" hint="Capture context and a useful next action.">
            <Textarea
              required
              autoFocus
              value={form.details}
              onChange={(event) => setForm({ ...form, details: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
