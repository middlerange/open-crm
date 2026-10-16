import {
  CodeBlockIcon as Code,
  CopyIcon as Copy,
  ShieldTickIcon as Shield,
} from "../components/icons";
import { useState } from "react";

import { AppShell } from "../components/shell";
import { Badge, Button, Modal, Panel, Spinner, useToast } from "../components/ui";
import { api, formatDate, roleLabel } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

const SKILL_REPOSITORY = "https://github.com/middlerange/orbit-gtm-skill";
const INSTALLER = `${SKILL_REPOSITORY.replace("github.com", "raw.githubusercontent.com")}/main/scripts/install.sh?v=2`;

type AgentKey = {
  id: string;
  name: string;
  tokenHint: string | null;
  scopes: string[];
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
};

function setupCommand(token: string) {
  return `curl -fsSL ${INSTALLER} | sh -s -- --api-url '${window.location.origin}' --api-key '${token}'`;
}

export function AgentSetupPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const { data, loading, reload } = useData<{ keys: AgentKey[] }>("/agent-keys");
  const [creating, setCreating] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [commandKeyId, setCommandKeyId] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<AgentKey | null>(null);

  async function createKey() {
    setCreating(true);
    try {
      const response = await api<{ key: AgentKey & { token: string } }>("/agent-keys", {
        method: "POST",
        body: JSON.stringify({ name: "Local agent" }),
      });
      setCommand(setupCommand(response.key.token));
      setCommandKeyId(response.key.id);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create an API key.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      notify("Setup command copied.");
    } catch {
      notify("Unable to copy the setup command.", "error");
    }
  }

  async function revokeKey(key: AgentKey) {
    try {
      await api(`/agent-keys/${key.id}`, { method: "DELETE" });
      if (commandKeyId === key.id) {
        setCommand(null);
        setCommandKeyId(null);
      }
      notify("API key revoked.");
      setPendingRevoke(null);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to revoke the API key.", "error");
    }
  }

  return (
    <AppShell contentWidth="wide">
      <div className="agent-setup-page">
        <section className="agent-setup-intro">
          <div>
            <Badge tone="purple">Personal agent access</Badge>
            <h2>Connect your local agent to Orbit</h2>
            <p>
              Generate a key, copy one command, and run it locally. The installed skill acts as
              {` ${user?.name ?? "you"}`} with your current {roleLabel(user?.role ?? "ic")}{" "}
              permissions.
            </p>
          </div>
          <Button onClick={() => void createKey()} disabled={creating}>
            {creating ? <Spinner /> : <Code size={16} />}
            Generate setup command
          </Button>
        </section>

        {command ? (
          <Panel className="agent-command-panel">
            <div className="agent-command-heading">
              <div>
                <strong>Run this command once</strong>
                <span>The API key is shown only in this command. Copy it before leaving.</span>
              </div>
              <Badge tone="amber">Copy once</Badge>
            </div>
            <div className="agent-command">
              <code>{command}</code>
              <Button size="small" onClick={() => void copyCommand()}>
                <Copy size={14} />
                Copy command
              </Button>
            </div>
            <p>
              The installer fetches the public <a href={SKILL_REPOSITORY}>Manage Orbit skill</a>,
              stores credentials in <code>~/.config/orbit/credentials</code> with private file
              permissions, and verifies your identity against Orbit.
            </p>
          </Panel>
        ) : null}

        <div className="agent-setup-grid">
          <Panel className="agent-permission-panel">
            <div className="agent-panel-title">
              <Shield size={18} />
              <div>
                <strong>Your permission boundary</strong>
                <span>Authorization is checked on every API request.</span>
              </div>
            </div>
            <dl>
              <div>
                <dt>Identity</dt>
                <dd>{user?.email}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{roleLabel(user?.role ?? "ic")}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>
                  {user?.role === "ic"
                    ? "Your assigned CRM records, tasks, campaigns, and approved shared assets"
                    : "Team-wide workspace data and the actions available to your role"}
                </dd>
              </div>
              <div>
                <dt>Hard limits</dt>
                <dd>Human approvals and manual email/LinkedIn execution remain enforced</dd>
              </div>
            </dl>
          </Panel>

          <Panel className="agent-keys-panel">
            <div className="agent-panel-title">
              <Code size={18} />
              <div>
                <strong>Your API keys</strong>
                <span>Revoke a machine without affecting your Orbit login.</span>
              </div>
            </div>
            {loading ? (
              <div className="agent-keys-loading">
                <Spinner />
              </div>
            ) : (data?.keys ?? []).length ? (
              <div className="agent-key-list">
                {data?.keys.map((key) => (
                  <div className="agent-key-row" key={key.id}>
                    <div>
                      <strong>{key.name}</strong>
                      <span>
                        {key.tokenHint ?? "Legacy key"} · Created {formatDate(key.createdAt, true)}
                        {key.lastUsedAt ? ` · Used ${formatDate(key.lastUsedAt, true)}` : ""}
                      </span>
                    </div>
                    {key.active ? (
                      <Button size="small" variant="plain" onClick={() => setPendingRevoke(key)}>
                        Revoke
                      </Button>
                    ) : (
                      <Badge>Revoked</Badge>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="agent-keys-empty">No API keys yet.</p>
            )}
          </Panel>
        </div>
      </div>
      <Modal
        open={Boolean(pendingRevoke)}
        onClose={() => setPendingRevoke(null)}
        title="Revoke API key"
        footer={
          <>
            <Button onClick={() => setPendingRevoke(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingRevoke) void revokeKey(pendingRevoke);
              }}
            >
              Revoke
            </Button>
          </>
        }
      >
        {pendingRevoke ? (
          <p>
            Agents using {pendingRevoke.name} ({pendingRevoke.tokenHint ?? "Legacy key"}) will lose
            access immediately.
          </p>
        ) : null}
      </Modal>
    </AppShell>
  );
}
