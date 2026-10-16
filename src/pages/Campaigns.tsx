import {
  AnnouncementIcon as Megaphone,
  ChevronDownIcon as ChevronDown,
  ComponentIcon as FlaskConical,
  PaperAirplaneIcon as Send,
  PlusIcon as Plus,
} from "../components/icons";
import { useState, type FormEvent } from "react";

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
import { api, formatDate, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Campaign = {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  status: string;
  segment: string | null;
  hypothesis: string | null;
  value_proposition: string | null;
  channels: string[];
  success_metric: string | null;
  start_at: string | null;
  end_at: string | null;
  assets: number;
  assets_pending: number;
};
type Team = { members: Array<{ id: string; name: string }> };

function campaignTone(status: string): "neutral" | "blue" | "green" | "amber" | "red" {
  if (["approved", "active", "complete"].includes(status)) return "green";
  if (status === "pending_approval") return "amber";
  if (status === "paused") return "red";
  if (status === "draft") return "blue";
  return "neutral";
}

export function CampaignsPage() {
  const { user } = useAuth();
  const { data, loading, reload } = useData<{ campaigns: Campaign[] }>("/campaigns");
  const { data: team } = useData<Team>("/team");
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    ownerId: user?.id ?? "",
    segment: "",
    hypothesis: "",
    valueProposition: "",
    channels: ["email", "linkedin"],
    successMetric: "",
    startAt: "",
    endAt: "",
  });

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/campaigns", {
        method: "POST",
        body: JSON.stringify({ ...form, startAt: form.startAt || null, endAt: form.endAt || null }),
      });
      notify("Campaign experiment created.");
      setOpen(false);
      setForm({
        ...form,
        name: "",
        segment: "",
        hypothesis: "",
        valueProposition: "",
        successMetric: "",
      });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create campaign.", "error");
    } finally {
      setSaving(false);
    }
  }
  async function submit(id: string) {
    try {
      await api(`/campaigns/${id}/submit`, { method: "POST" });
      notify("Campaign sent for senior review.");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to submit campaign.", "error");
    }
  }

  function toggleCampaignBrief(id: string) {
    setExpandedCampaigns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <AppShell
      actions={
        !loading && data?.campaigns.length ? (
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={15} /> New campaign
          </Button>
        ) : null
      }
    >
      {loading ? (
        <div className="loading-page loading-section">
          <Spinner />
        </div>
      ) : data?.campaigns.length ? (
        <div className="campaign-list" role="list" aria-label="Campaigns">
          {data.campaigns.map((campaign) => {
            const briefOpen = expandedCampaigns.has(campaign.id);
            const briefId = `campaign-brief-${campaign.id}`;
            return (
              <article className="campaign-card" role="listitem" key={campaign.id}>
                <div className="campaign-card-summary">
                  <span className="campaign-card-icon" aria-hidden="true">
                    <FlaskConical size={15} />
                  </span>
                  <div className="campaign-card-main">
                    <div className="campaign-title-row">
                      <h2>{campaign.name}</h2>
                      <Badge tone={campaignTone(campaign.status)}>
                        {titleCase(campaign.status)}
                      </Badge>
                    </div>
                    <p className="campaign-segment">{campaign.segment || "Segment not set"}</p>
                    <div className="campaign-meta">
                      <span className="campaign-owner">
                        <Avatar name={campaign.owner_name ?? "Unassigned"} size="small" />
                        <span>{campaign.owner_name ?? "Unassigned"}</span>
                      </span>
                      <span className="campaign-channels" aria-label="Channels">
                        {campaign.channels.map((channel) => (
                          <Badge key={channel}>{titleCase(channel)}</Badge>
                        ))}
                      </span>
                      <span className="campaign-meta-copy numeric">
                        {campaign.assets} {campaign.assets === 1 ? "asset" : "assets"}
                      </span>
                      {campaign.assets_pending ? (
                        <Badge tone="amber">{campaign.assets_pending} pending</Badge>
                      ) : null}
                      {campaign.start_at || campaign.end_at ? (
                        <span className="campaign-meta-copy campaign-dates">
                          {formatDate(campaign.start_at)} → {formatDate(campaign.end_at)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="campaign-card-actions">
                    <Button
                      className="campaign-brief-toggle"
                      variant="plain"
                      aria-expanded={briefOpen}
                      aria-controls={briefId}
                      onClick={() => toggleCampaignBrief(campaign.id)}
                    >
                      Brief <ChevronDown size={14} />
                    </Button>
                    {campaign.status === "draft" ? (
                      <Button
                        className="campaign-submit-action"
                        size="small"
                        onClick={() => void submit(campaign.id)}
                      >
                        <Send size={14} /> Submit for approval
                      </Button>
                    ) : null}
                  </div>
                </div>
                {briefOpen ? (
                  <div className="campaign-brief" id={briefId}>
                    <div>
                      <div className="field-label">Hypothesis</div>
                      <p>{campaign.hypothesis || "Not documented"}</p>
                    </div>
                    <div>
                      <div className="field-label">Value proposition</div>
                      <p>{campaign.value_proposition || "Not documented"}</p>
                    </div>
                    <div>
                      <div className="field-label">Success metric</div>
                      <p>{campaign.success_metric || "Not documented"}</p>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Megaphone size={20} />}
          title="No experiments yet"
          description="Create the first campaign around one audience, message hypothesis, and measurable outcome."
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus size={15} /> New campaign
            </Button>
          }
        />
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Design a campaign experiment"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button form="campaign-form" type="submit" variant="primary" disabled={saving}>
              {saving ? "Creating…" : "Create draft"}
            </Button>
          </>
        }
      >
        <form id="campaign-form" className="form-grid" onSubmit={create}>
          <Field label="Campaign">
            <Input
              autoFocus
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Onboarding fragmentation · Tier A"
            />
          </Field>
          <Field
            label="Owner"
            hint={user?.role === "ic" ? "Campaigns you create are assigned to you." : undefined}
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
          <Field label="Segment">
            <Textarea
              required
              value={form.segment}
              onChange={(event) => setForm({ ...form, segment: event.target.value })}
              placeholder="20–100 employee B2B SaaS teams with a public help centre and a current growth hire."
            />
          </Field>
          <Field label="Hypothesis">
            <Textarea
              required
              value={form.hypothesis}
              onChange={(event) => setForm({ ...form, hypothesis: event.target.value })}
              placeholder="Teams showing X signal will respond to Y observation because…"
            />
          </Field>
          <Field label="Value proposition">
            <Textarea
              required
              value={form.valueProposition}
              onChange={(event) => setForm({ ...form, valueProposition: event.target.value })}
              placeholder="The narrow outcome we will lead with."
            />
          </Field>
          <Field label="Success metric">
            <Textarea
              required
              value={form.successMetric}
              onChange={(event) => setForm({ ...form, successMetric: event.target.value })}
              placeholder="Two substantive conversations from 30 approved Tier A accounts."
            />
          </Field>
          <Field label="Start">
            <Input
              type="date"
              value={form.startAt}
              onChange={(event) => setForm({ ...form, startAt: event.target.value })}
            />
          </Field>
          <Field label="End">
            <Input
              type="date"
              value={form.endAt}
              onChange={(event) => setForm({ ...form, endAt: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
