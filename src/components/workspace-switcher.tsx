import { useEffect, useState, type FormEvent } from "react";

import "../workspace-switcher.css";

import { api, roleLabel } from "../lib/api";
import { useAuth } from "../lib/auth";
import { BrandMark } from "./brand";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "./icons";
import { Badge, Button, Field, Input, Modal, Spinner } from "./ui";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  role: "founder" | "manager" | "ic";
  current: boolean;
};

export function WorkspaceSwitcher() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api<{ workspaces: Workspace[] }>("/auth/workspaces")
      .then((response) => setWorkspaces(response.workspaces))
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Unable to load teams."),
      )
      .finally(() => setLoading(false));
  }, [open]);

  if (!user) return null;

  async function switchWorkspace(workspace: Workspace) {
    if (workspace.current || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/auth/workspaces/${encodeURIComponent(workspace.id)}/switch`, { method: "POST" });
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to switch teams.");
      setSubmitting(false);
    }
  }

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api("/auth/workspaces", { method: "POST", body: JSON.stringify({ name }) });
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the team.");
      setSubmitting(false);
    }
  }

  function close() {
    if (submitting) return;
    setOpen(false);
    setCreating(false);
    setName("");
    setError(null);
  }

  return (
    <>
      <button className="workspace-switcher-trigger" type="button" onClick={() => setOpen(true)}>
        <BrandMark />
        <span className="workspace-copy">
          <strong>{user.workspaceName}</strong>
          <span>{roleLabel(user.role)}</span>
        </span>
        <ChevronDownIcon className="workspace-chevron" size={14} />
      </button>
      <Modal
        open={open}
        onClose={close}
        title={creating ? "Create a team" : "Switch team"}
        description={
          creating
            ? "Start a separate workspace with you as its lead."
            : "Choose where you want to work."
        }
        footer={
          creating ? (
            <>
              <Button type="button" onClick={() => setCreating(false)} disabled={submitting}>
                Back
              </Button>
              <Button
                type="submit"
                form="create-workspace-form"
                variant="primary"
                disabled={submitting || name.trim().length < 2}
              >
                {submitting ? (
                  <>
                    <Spinner /> Creating
                  </>
                ) : (
                  "Create team"
                )}
              </Button>
            </>
          ) : undefined
        }
      >
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        {creating ? (
          <form id="create-workspace-form" onSubmit={createWorkspace}>
            <Field label="Team name">
              <Input
                autoFocus
                required
                minLength={2}
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme sales"
              />
            </Field>
          </form>
        ) : loading ? (
          <div className="workspace-switcher-loading">
            <Spinner /> Loading teams
          </div>
        ) : (
          <div className="workspace-switcher-list">
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className="workspace-switcher-option"
                disabled={submitting}
                aria-current={workspace.current ? "true" : undefined}
                onClick={() => void switchWorkspace(workspace)}
              >
                <span>
                  <strong>{workspace.name}</strong>
                  <Badge
                    tone={
                      workspace.role === "manager"
                        ? "purple"
                        : workspace.role === "founder"
                          ? "green"
                          : "blue"
                    }
                  >
                    {roleLabel(workspace.role)}
                  </Badge>
                </span>
                {workspace.current ? <CheckIcon size={16} /> : null}
              </button>
            ))}
            <button
              className="workspace-switcher-create"
              type="button"
              onClick={() => setCreating(true)}
            >
              <PlusIcon size={16} />
              Create a new team
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
