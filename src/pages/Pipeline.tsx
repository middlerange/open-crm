import {
  CreditCardIcon as CircleDollarSign,
  PlusIcon as Plus,
  ProjectIcon as FolderKanban,
  WarningTriangleIcon as AlertTriangle,
} from "../components/icons";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AppShell } from "../components/shell";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  useToast,
} from "../components/ui";
import { api, relativeDate } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Stage = {
  id: string;
  key: string;
  name: string;
  position: number;
  probability: number;
  terminal: boolean;
  won: boolean;
};
type Opportunity = {
  id: string;
  account_id: string;
  account_name: string;
  owner_id: string;
  owner_name: string;
  stage_id: string;
  name: string;
  value_amount: string | null;
  currency: string;
  next_action: string;
  next_action_at: string;
};
type Pipeline = { stages: Stage[]; opportunities: Opportunity[] };
type Accounts = { accounts: Array<{ id: string; name: string; ownerId: string }> };
type Team = { members: Array<{ id: string; name: string }> };

export function PipelinePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, loading, error, reload } = useData<Pipeline>("/pipeline");
  const { data: accounts } = useData<Accounts>("/accounts?pageSize=250");
  const { data: team } = useData<Team>("/team");
  const { notify } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    accountId: "",
    ownerId: user?.id ?? "",
    stageId: "",
    valueAmount: "",
    currency: "USD",
    problemSummary: "",
    nextAction: "",
    nextActionAt: "",
  });

  async function createOpportunity(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/opportunities", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          valueAmount: form.valueAmount ? Number(form.valueAmount) : null,
          nextActionAt: new Date(form.nextActionAt).toISOString(),
        }),
      });
      notify("Opportunity added to pipeline.");
      setModalOpen(false);
      setForm({
        ...form,
        name: "",
        accountId: "",
        valueAmount: "",
        problemSummary: "",
        nextAction: "",
        nextActionAt: "",
      });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create opportunity.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function move(opportunity: Opportunity, stageId: string) {
    const target = data?.stages.find((stage) => stage.id === stageId);
    if (target?.terminal && !target.won) {
      notify("Open the opportunity to record a loss reason before closing it.");
      navigate(`/opportunities/${opportunity.id}`);
      return;
    }
    try {
      await api(`/opportunities/${opportunity.id}`, {
        method: "PATCH",
        body: JSON.stringify({ stageId }),
      });
      notify("Pipeline stage updated.");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to move opportunity.", "error");
    }
  }

  if (error && !data)
    return (
      <AppShell>
        <EmptyState
          icon={<AlertTriangle size={19} />}
          title="Pipeline unavailable"
          description={error}
          action={<Button onClick={() => void reload()}>Try again</Button>}
        />
      </AppShell>
    );
  if (loading || !data)
    return (
      <AppShell>
        <div className="loading-page loading-section-tall">
          <Spinner />
        </div>
      </AppShell>
    );
  const openStages = data.stages;
  const activeOpportunities = data.opportunities.filter(
    (item) => !data.stages.find((stage) => stage.id === item.stage_id)?.terminal,
  );
  const totalValue = activeOpportunities.reduce(
    (sum, item) => sum + Number(item.value_amount ?? 0),
    0,
  );

  const openCreate = () => {
    setForm((current) => ({
      ...current,
      stageId: current.stageId || data.stages[0]?.id || "",
    }));
    setModalOpen(true);
  };

  return (
    <AppShell
      contentWidth="wide"
      actions={
        data.opportunities.length ? (
          <Button variant="primary" onClick={openCreate}>
            <Plus size={15} /> Add opportunity
          </Button>
        ) : null
      }
    >
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">
            Open opportunities{" "}
            <span className="stat-icon">
              <FolderKanban size={15} />
            </span>
          </div>
          <div className="stat-value">{activeOpportunities.length}</div>
          <div className="stat-detail">Across every active stage</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Pipeline value{" "}
            <span className="stat-icon">
              <CircleDollarSign size={15} />
            </span>
          </div>
          <div className="stat-value">
            ${Intl.NumberFormat("en", { notation: "compact" }).format(totalValue)}
          </div>
          <div className="stat-detail">Unweighted total</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">SQLs</div>
          <div className="stat-value">
            {
              data.opportunities.filter(
                (item) =>
                  (data.stages.find((stage) => stage.id === item.stage_id)?.position ?? 0) >= 4,
              ).length
            }
          </div>
          <div className="stat-detail">Qualified or beyond</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Won</div>
          <div className="stat-value">
            {
              data.opportunities.filter(
                (item) => data.stages.find((stage) => stage.id === item.stage_id)?.won,
              ).length
            }
          </div>
          <div className="stat-detail">First payment received</div>
        </div>
      </div>
      {data.opportunities.length ? (
        <div className="pipeline-scroll">
          {openStages.map((stage) => {
            const opportunities = data.opportunities.filter((item) => item.stage_id === stage.id);
            return (
              <section className="pipeline-column" key={stage.id}>
                <header className="pipeline-column-header">
                  <h3>{stage.name}</h3>
                  <span className="pipeline-count">{opportunities.length}</span>
                  <Badge>{stage.probability}%</Badge>
                </header>
                {opportunities.map((opportunity) => (
                  <article className="pipeline-card" key={opportunity.id}>
                    <strong>{opportunity.account_name}</strong>
                    <Link to={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
                    {opportunity.value_amount ? (
                      <div className="pipeline-value">
                        {opportunity.currency}{" "}
                        {Intl.NumberFormat("en").format(Number(opportunity.value_amount))}
                      </div>
                    ) : null}
                    <div className="pipeline-next-action">{opportunity.next_action}</div>
                    <div className="pipeline-card-footer">
                      <span
                        className={
                          new Date(opportunity.next_action_at) < new Date() ? "overdue" : ""
                        }
                      >
                        {relativeDate(opportunity.next_action_at)}
                      </span>
                      <Avatar name={opportunity.owner_name ?? "?"} size="small" />
                    </div>
                    <Select
                      aria-label="Move stage"
                      value={stage.id}
                      onValueChange={(stageId) => void move(opportunity, stageId)}
                      className="pipeline-stage-select"
                    >
                      {data.stages.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </Select>
                  </article>
                ))}
                {opportunities.length === 0 ? (
                  <div className="pipeline-empty">Nothing here</div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<FolderKanban size={20} />}
          title="No opportunities yet"
          description="Add an opportunity after a real conversation and schedule its next action."
          action={
            <Button variant="primary" onClick={openCreate}>
              <Plus size={15} /> Add opportunity
            </Button>
          }
        />
      )}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add a real opportunity"
        description="A conversation, clear problem, and scheduled next action are required."
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" form="create-opportunity" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save opportunity"}
            </Button>
          </>
        }
      >
        <form id="create-opportunity" className="form-grid" onSubmit={createOpportunity}>
          <Field label="Opportunity">
            <Input
              required
              autoFocus
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Product experience consolidation"
            />
          </Field>
          <Field label="Account">
            <Select
              required
              value={form.accountId}
              onValueChange={(accountId) => setForm({ ...form, accountId })}
            >
              <option value="">Choose account</option>
              {accounts?.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Owner"
            hint={user?.role === "ic" ? "Opportunities you create are assigned to you." : undefined}
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
          <Field label="Stage">
            <Select
              required
              value={form.stageId}
              onValueChange={(stageId) => setForm({ ...form, stageId })}
            >
              {data.stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Value">
            <Input
              type="number"
              min="0"
              value={form.valueAmount}
              onChange={(event) => setForm({ ...form, valueAmount: event.target.value })}
              placeholder="12000"
            />
          </Field>
          <Field label="Currency">
            <Input
              maxLength={3}
              value={form.currency}
              onChange={(event) => setForm({ ...form, currency: event.target.value })}
            />
          </Field>
          <Field label="Problem">
            <Textarea
              value={form.problemSummary}
              onChange={(event) => setForm({ ...form, problemSummary: event.target.value })}
              placeholder="What workflow or commercial problem did the buyer acknowledge?"
            />
          </Field>
          <Field label="Next action">
            <Textarea
              required
              value={form.nextAction}
              onChange={(event) => setForm({ ...form, nextAction: event.target.value })}
              placeholder="Run workflow-specific demo with Head of Product"
            />
          </Field>
          <Field label="Next action due">
            <Input
              required
              type="datetime-local"
              value={form.nextActionAt}
              onChange={(event) => setForm({ ...form, nextActionAt: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
