import {
  AccessIcon as KeyRound,
  ClipboardIcon as Clipboard,
  PlusIcon as Plus,
  ShieldLockIcon as Shield,
  UsersIcon as Users,
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
  PageToolbar,
  Panel,
  Select,
  Spinner,
  useToast,
} from "../components/ui";
import { api, formatDate, roleLabel } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  openTasks: number;
  overdueTasks: number;
  accounts: number;
};
type Team = {
  members: Member[];
};
type Updates = {
  updates: Array<{
    id: string;
    userId: string;
    userName: string;
    updateDate: string;
    moved: string;
    stuck: string;
    learned: string;
    tomorrow: string;
  }>;
};

export function TeamPage() {
  const { user } = useAuth();
  const { data, loading, reload } = useData<Team>("/team");
  const { data: updates } = useData<Updates>("/updates");
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("ic");
  const [inviteUrl, setInviteUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"members" | "updates" | "integrations">("members");
  const [roleMember, setRoleMember] = useState<Member | null>(null);
  const [memberRole, setMemberRole] = useState("ic");
  const [removeMember, setRemoveMember] = useState<Member | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const canInvite = user?.role === "founder";
  const reassignOptions = data?.members.filter((member) => member.id !== removeMember?.id) ?? [];

  async function changeRole() {
    if (!roleMember) return;
    setSaving(true);
    try {
      await api(`/team/${roleMember.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role: memberRole }),
      });
      notify(`${roleMember.name}'s role was updated.`);
      setRoleMember(null);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to change role.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove() {
    if (!removeMember) return;
    setSaving(true);
    try {
      await api(`/team/${removeMember.id}/remove`, {
        method: "POST",
        body: JSON.stringify(reassignTo ? { reassignToUserId: reassignTo } : {}),
      });
      notify(`${removeMember.name} was removed from the workspace.`);
      setRemoveMember(null);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to remove member.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ inviteUrl: string }>("/auth/invites", {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      setInviteUrl(result.inviteUrl);
      notify("Invite created. Copy the private link.");
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create invitation.", "error");
    } finally {
      setSaving(false);
    }
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      notify("Invite link copied.");
    } catch {
      notify("Unable to copy the invite link.", "error");
    }
  }

  if (user?.role === "ic")
    return (
      <AppShell>
        <EmptyState
          icon={<Shield size={20} />}
          title="Team workspace"
          description="Team-wide visibility is available to Leads."
        />
      </AppShell>
    );

  return (
    <AppShell
      actions={
        canInvite ? (
          <Button
            variant="primary"
            onClick={() => {
              setInviteUrl("");
              setOpen(true);
            }}
          >
            <Plus size={15} /> Invite teammate
          </Button>
        ) : null
      }
      toolbar={
        <PageToolbar label="Team views">
          {[
            ["members", "Members"],
            ["updates", "Updates"],
            ["integrations", "Integrations"],
          ].map(([value, label]) => (
            <Button
              key={value}
              className={`root-filter ${view === value ? "is-active" : ""}`}
              size="small"
              variant="plain"
              onClick={() => setView(value as typeof view)}
            >
              {label}
            </Button>
          ))}
        </PageToolbar>
      }
    >
      {view === "members" ? (
        <Panel className="table-surface" flush>
          <div className="panel-header">
            <div>
              <h2>Members</h2>
              <p>Invite-only email and password access.</p>
            </div>
            <Badge tone="blue">
              {data?.members.length ?? 0} {(data?.members.length ?? 0) === 1 ? "person" : "people"}
            </Badge>
          </div>
          {loading ? (
            <div className="loading-page loading-section-compact">
              <Spinner />
            </div>
          ) : (
            <div className="data-table-wrap">
              <table
                className="data-table data-table-responsive team-table"
                aria-label="Team members"
              >
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Accounts</th>
                    <th>Open work</th>
                    <th>Overdue</th>
                    {canInvite ? <th aria-label="Actions" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {data?.members.map((member) => (
                    <tr key={member.id}>
                      <td data-cell="primary">
                        <div className="table-identity">
                          <Avatar name={member.name} size="medium" />
                          <span className="table-identity-copy">
                            <span className="table-title">{member.name}</span>
                            <span className="table-secondary">{member.email}</span>
                          </span>
                        </div>
                      </td>
                      <td data-label="Role">
                        <Badge
                          tone={
                            member.role === "manager"
                              ? "purple"
                              : member.role === "founder"
                                ? "blue"
                                : "neutral"
                          }
                        >
                          {roleLabel(member.role)}
                        </Badge>
                      </td>
                      <td className="numeric" data-label="Accounts">
                        {member.accounts}
                      </td>
                      <td className="numeric" data-label="Open work">
                        {member.openTasks}
                      </td>
                      <td
                        className={member.overdueTasks ? "numeric overdue" : "numeric"}
                        data-label="Overdue"
                      >
                        {member.overdueTasks}
                      </td>
                      {canInvite ? (
                        <td data-cell="actions">
                          {member.id !== user?.id ? (
                            <div className="table-actions">
                              <Button
                                size="small"
                                variant="plain"
                                onClick={() => {
                                  setMemberRole(member.role);
                                  setRoleMember(member);
                                }}
                              >
                                Change role
                              </Button>
                              <Button
                                size="small"
                                variant="plain"
                                onClick={() => {
                                  setReassignTo("");
                                  setRemoveMember(member);
                                }}
                              >
                                Remove
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : view === "updates" ? (
        <Panel flush>
          <div className="panel-header">
            <div>
              <h2>Daily closeouts</h2>
              <p>What moved, what was learned, and what changes tomorrow.</p>
            </div>
          </div>
          {updates?.updates.length ? (
            <div className="list">
              {updates.updates.map((update) => (
                <div className="list-row closeout-row" key={update.id}>
                  <Avatar name={update.userName} size="small" />
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span>{update.userName}</span>
                      <Badge>{formatDate(update.updateDate)}</Badge>
                    </div>
                    <div className="closeout-grid">
                      <div>
                        <span className="field-label">Moved</span>
                        <p className="closeout-copy">{update.moved}</p>
                      </div>
                      {update.learned ? (
                        <div>
                          <span className="field-label">Learned</span>
                          <p className="closeout-copy">{update.learned}</p>
                        </div>
                      ) : null}
                      <div>
                        <span className="field-label">Tomorrow</span>
                        <p className="closeout-copy">{update.tomorrow}</p>
                      </div>
                      {update.stuck ? (
                        <div>
                          <span className="field-label">Stuck</span>
                          <p className="overdue closeout-copy">{update.stuck}</p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Users size={20} />}
              title="No closeouts yet"
              description="Daily updates will appear here as the team begins execution."
            />
          )}
        </Panel>
      ) : (
        <Panel>
          <div className="inline-cluster-start">
            <span className="stat-icon">
              <KeyRound size={15} />
            </span>
            <div>
              <h3 className="compact-title">Hermes access is separate</h3>
              <p className="supporting-copy">
                The Discord or Telegram agent uses a scoped API token. It can read status, assign
                work, save drafts, and log activity, but cannot send email, perform LinkedIn
                actions, or publish content.
              </p>
            </div>
          </div>
        </Panel>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Invite a teammate"
        description="Invitation links expire after seven days and can only be used once."
        footer={
          inviteUrl ? (
            <Button variant="primary" onClick={() => void copyInvite()}>
              <Clipboard size={15} /> Copy invite link
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" form="invite-form" type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create invite"}
              </Button>
            </>
          )
        }
      >
        {inviteUrl ? (
          <div>
            <Field label="Private invitation link">
              <Input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
            </Field>
            <p className="modal-help">
              Send this link privately. Orbit does not need an email service in v1.
            </p>
          </div>
        ) : (
          <form id="invite-form" className="form-grid" onSubmit={invite}>
            <Field label="Work email">
              <Input
                type="email"
                autoFocus
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
              />
            </Field>
            <Field label="Role">
              <Select value={role} onValueChange={setRole}>
                <option value="ic">IC · personal execution</option>
                <option value="manager">Lead · team management</option>
              </Select>
            </Field>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(roleMember)}
        onClose={() => setRoleMember(null)}
        title={`Change ${roleMember?.name ?? "member"}'s role`}
        description="The new role applies on their next request."
        footer={
          <>
            <Button onClick={() => setRoleMember(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={saving || memberRole === roleMember?.role}
              onClick={() => void changeRole()}
            >
              {saving ? "Saving…" : "Change role"}
            </Button>
          </>
        }
      >
        <Field label="Role">
          <Select value={memberRole} onValueChange={setMemberRole}>
            <option value="founder">Founder · workspace administration</option>
            <option value="manager">Lead · team management</option>
            <option value="ic">IC · personal execution</option>
          </Select>
        </Field>
      </Modal>
      <Modal
        open={Boolean(removeMember)}
        onClose={() => setRemoveMember(null)}
        title={`Remove ${removeMember?.name ?? "member"}?`}
        description="Their workspace access, sessions, API keys, and extension tokens will be revoked."
        footer={
          <>
            <Button onClick={() => setRemoveMember(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={saving || (Boolean(removeMember?.accounts) && !reassignTo)}
              onClick={() => void confirmRemove()}
            >
              {saving ? "Removing…" : "Remove member"}
            </Button>
          </>
        }
      >
        {removeMember?.accounts || removeMember?.openTasks ? (
          <Field label="Reassign accounts and open work to">
            <Select
              value={reassignTo}
              onValueChange={setReassignTo}
              placeholder={removeMember.accounts ? "Choose a teammate" : "Leave unassigned"}
            >
              {reassignOptions.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="modal-help">This member owns no accounts or open work.</p>
        )}
      </Modal>
    </AppShell>
  );
}
