import {
  FileIcon as FileText,
  BoltIcon as Lightbulb,
  PaperAirplaneIcon as Send,
  PlayIcon as Play,
  PlusIcon as Plus,
  VideoCameraIcon as FileVideo2,
} from "../components/icons";
import { useMemo, useState, type FormEvent } from "react";

import { AppShell } from "../components/shell";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageToolbar,
  Select,
  Spinner,
  Textarea,
  useToast,
} from "../components/ui";
import { api, relativeDate, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Asset = {
  id: string;
  type: string;
  title: string;
  owner_id: string;
  owner_name: string;
  campaign_name: string | null;
  status: string;
  use_case: string | null;
  channel: string | null;
  brief: string | null;
  body: string | null;
  due_at: string | null;
  external_url: string | null;
};
type Team = { members: Array<{ id: string; name: string }> };
type Campaigns = { campaigns: Array<{ id: string; name: string }> };

function assetTone(status: string): "neutral" | "blue" | "green" | "amber" | "red" | "purple" {
  if (["approved", "published"].includes(status)) return "green";
  if (status === "pending_approval") return "amber";
  if (status === "changes_requested") return "red";
  if (["production", "scheduled"].includes(status)) return "purple";
  if (["brief", "draft"].includes(status)) return "blue";
  return "neutral";
}

export function StudioPage() {
  const { user } = useAuth();
  const { data, loading, reload } = useData<{ assets: Asset[] }>("/assets");
  const { data: team } = useData<Team>("/team");
  const { data: campaigns } = useData<Campaigns>("/campaigns");
  const { notify } = useToast();
  const [tab, setTab] = useState("all");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    type: "video",
    ownerId: user?.id ?? "",
    campaignId: "",
    useCase: "",
    channel: "YouTube",
    brief: "",
    body: "",
    externalUrl: "",
    dueAt: "",
  });
  const assets = useMemo(
    () =>
      (data?.assets ?? []).filter(
        (asset) =>
          tab === "all" ||
          (tab === "video"
            ? ["video", "demo", "teardown"].includes(asset.type)
            : tab === "outreach"
              ? ["outreach_draft", "email_sequence"].includes(asset.type)
              : asset.type === "content"),
      ),
    [data, tab],
  );

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/assets", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          campaignId: form.campaignId || null,
          dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
        }),
      });
      notify("Asset added to the studio.");
      setOpen(false);
      setForm({ ...form, title: "", useCase: "", brief: "", body: "", externalUrl: "", dueAt: "" });
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create asset.", "error");
    } finally {
      setSaving(false);
    }
  }
  async function submit(id: string) {
    try {
      await api(`/assets/${id}/submit`, { method: "POST" });
      notify("Asset sent for senior review.");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to submit asset.", "error");
    }
  }

  return (
    <AppShell
      actions={
        !loading && data?.assets.length ? (
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={15} /> Add asset
          </Button>
        ) : null
      }
      toolbar={
        <PageToolbar label="Filter studio assets">
          {[
            ["all", "All"],
            ["content", "Content"],
            ["video", "Video & demos"],
            ["outreach", "Outreach"],
          ].map(([value, label]) => (
            <Button
              key={value}
              className={`root-filter ${tab === value ? "is-active" : ""}`}
              size="small"
              variant="plain"
              onClick={() => setTab(value)}
            >
              {label}
            </Button>
          ))}
        </PageToolbar>
      }
    >
      {loading ? (
        <div className="loading-page loading-section">
          <Spinner />
        </div>
      ) : assets.length ? (
        <div className="list index-list">
          {assets.map((asset) => (
            <div className="list-row" key={asset.id}>
              <span className="stat-icon">
                {asset.type === "content" ? (
                  <FileText size={15} />
                ) : asset.type === "video" ? (
                  <FileVideo2 size={15} />
                ) : (
                  <Play size={15} />
                )}
              </span>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{asset.title}</span>
                  <Badge>{titleCase(asset.type)}</Badge>
                  <Badge tone={assetTone(asset.status)}>{titleCase(asset.status)}</Badge>
                </div>
                <div className="list-row-meta">
                  <span>{asset.use_case || "Use case not set"}</span>
                  <span>{asset.campaign_name || asset.channel || "Independent"}</span>
                  <span>{relativeDate(asset.due_at)}</span>
                </div>
              </div>
              <div className="list-row-trailing">
                <Avatar name={asset.owner_name ?? "?"} size="small" />
                {["idea", "draft", "brief", "changes_requested"].includes(asset.status) ? (
                  <Button
                    variant="plain"
                    size="icon"
                    aria-label="Submit for approval"
                    onClick={() => void submit(asset.id)}
                  >
                    <Send size={15} />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Lightbulb size={20} />}
          title={data?.assets.length ? "No assets in this view" : "Studio backlog is empty"}
          description={
            data?.assets.length
              ? "Choose another asset type to continue."
              : "Start with a buyer problem and turn it into a brief for content, video, demo, or outreach."
          }
          action={
            data?.assets.length ? (
              <Button onClick={() => setTab("all")}>Show all assets</Button>
            ) : (
              <Button variant="primary" onClick={() => setOpen(true)}>
                <Plus size={15} /> Add asset
              </Button>
            )
          }
        />
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a studio asset"
        description="Connect the deliverable to a use case and an accountable owner."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button form="asset-form" type="submit" variant="primary" disabled={saving}>
              {saving ? "Adding…" : "Add to studio"}
            </Button>
          </>
        }
      >
        <form id="asset-form" className="form-grid" onSubmit={create}>
          <Field label="Title">
            <Input
              required
              autoFocus
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="How to close the onboarding feedback loop"
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.type}
              onValueChange={(type) =>
                setForm({
                  ...form,
                  type,
                  channel: type === "video" ? "YouTube" : form.channel,
                })
              }
            >
              {["content", "video", "demo", "teardown", "outreach_draft", "email_sequence"].map(
                (type) => (
                  <option key={type} value={type}>
                    {titleCase(type)}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <Field
            label="Owner"
            hint={user?.role === "ic" ? "Assets you create are assigned to you." : undefined}
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
          <Field label="Campaign">
            <Select
              value={form.campaignId}
              onValueChange={(campaignId) => setForm({ ...form, campaignId })}
            >
              <option value="">Independent asset</option>
              {campaigns?.campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Buyer use case">
            <Input
              value={form.useCase}
              onChange={(event) => setForm({ ...form, useCase: event.target.value })}
              placeholder="Growth PM consolidating onboarding tools"
            />
          </Field>
          <Field label="Channel">
            <Input
              value={form.channel}
              onChange={(event) => setForm({ ...form, channel: event.target.value })}
            />
          </Field>
          <Field label="Brief">
            <Textarea
              required
              value={form.brief}
              onChange={(event) => setForm({ ...form, brief: event.target.value })}
              placeholder="Audience, problem, promise, proof, structure, and CTA."
            />
          </Field>
          <Field label="Draft / script">
            <Textarea
              required
              value={form.body}
              onChange={(event) => setForm({ ...form, body: event.target.value })}
              placeholder="Write or link the first complete draft here."
            />
          </Field>
          <Field label="Working link">
            <Input
              value={form.externalUrl}
              onChange={(event) => setForm({ ...form, externalUrl: event.target.value })}
              placeholder="https://…"
            />
          </Field>
          <Field label="Due">
            <Input
              type="datetime-local"
              value={form.dueAt}
              onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
