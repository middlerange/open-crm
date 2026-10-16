import {
  AlertIcon as MessageSquareWarning,
  CheckIcon as Check,
  ChecklistIcon as ClipboardCheck,
  CloseIcon as X,
} from "../components/icons";
import { useState } from "react";

import { AppShell } from "../components/shell";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  PageToolbar,
  Spinner,
  Textarea,
  useToast,
} from "../components/ui";
import { api, formatDate, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Approval = {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectTitle: string;
  gate: string;
  status: string;
  requestedAt: string;
  requesterName: string;
  reviewerName: string | null;
  requestNote: string | null;
  decisionNote: string | null;
};

export function ApprovalsPage() {
  const { user } = useAuth();
  const { data, loading, reload } = useData<{ approvals: Approval[] }>("/approvals");
  const { notify } = useToast();
  const [decision, setDecision] = useState<{
    approval: Approval;
    value: "approved" | "changes_requested" | "rejected";
  } | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"pending" | "history">("pending");
  const isManager = user?.role === "founder" || user?.role === "manager";

  async function submitDecision() {
    if (!decision) return;
    setSaving(true);
    try {
      await api(`/approvals/${decision.approval.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: decision.value, note }),
      });
      notify(
        `Approval ${decision.value === "approved" ? "accepted" : decision.value === "rejected" ? "rejected" : "returned for changes"}.`,
      );
      setDecision(null);
      setNote("");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to record decision.", "error");
    } finally {
      setSaving(false);
    }
  }

  const pending = (data?.approvals ?? []).filter((item) => item.status === "pending");
  const history = (data?.approvals ?? []).filter((item) => item.status !== "pending");

  return (
    <AppShell
      actions={<Badge tone={pending.length ? "amber" : "green"}>{pending.length} pending</Badge>}
      toolbar={
        <PageToolbar label="Approval views">
          <Button
            className={`root-filter ${view === "pending" ? "is-active" : ""}`}
            size="small"
            variant="plain"
            onClick={() => setView("pending")}
          >
            Pending <span className="filter-count">{pending.length}</span>
          </Button>
          <Button
            className={`root-filter ${view === "history" ? "is-active" : ""}`}
            size="small"
            variant="plain"
            onClick={() => setView("history")}
          >
            History <span className="filter-count">{history.length}</span>
          </Button>
        </PageToolbar>
      }
    >
      {view === "pending" ? (
        loading ? (
          <div className="loading-page loading-section-compact">
            <Spinner />
          </div>
        ) : pending.length ? (
          <div className="list">
            {pending.map((item) => (
              <div className="list-row" key={item.id}>
                <span className="stat-icon">
                  <ClipboardCheck size={15} />
                </span>
                <div className="list-row-main">
                  <div className="list-row-title">
                    <span>{item.subjectTitle}</span>
                    <Badge tone={item.gate === "lead" ? "blue" : "purple"}>
                      {item.gate === "lead" ? "Lead" : "Campaign asset"}
                    </Badge>
                  </div>
                  <div className="list-row-meta">
                    <span>{titleCase(item.subjectType)}</span>
                    <span>Requested by {item.requesterName}</span>
                    <span>{formatDate(item.requestedAt, true)}</span>
                  </div>
                </div>
                {isManager ? (
                  <div className="list-row-trailing">
                    <Button
                      variant="plain"
                      size="icon"
                      aria-label="Request changes"
                      onClick={() => setDecision({ approval: item, value: "changes_requested" })}
                    >
                      <MessageSquareWarning size={16} />
                    </Button>
                    <Button
                      variant="plain"
                      size="icon"
                      aria-label="Reject"
                      onClick={() => setDecision({ approval: item, value: "rejected" })}
                    >
                      <X size={16} />
                    </Button>
                    <Button
                      variant="primary"
                      size="small"
                      onClick={() => setDecision({ approval: item, value: "approved" })}
                    >
                      <Check size={14} /> Approve
                    </Button>
                  </div>
                ) : (
                  <Badge tone="amber">Waiting</Badge>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ClipboardCheck size={20} />}
            title="Review queue is clear"
            description={
              isManager
                ? "No leads, campaigns, or assets are waiting for a decision."
                : "You have no open approval requests."
            }
          />
        )
      ) : history.length ? (
        <div className="list">
          {history.map((item) => (
            <div className="list-row" key={item.id}>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{item.subjectTitle}</span>
                  <Badge
                    tone={
                      item.status === "approved"
                        ? "green"
                        : item.status === "changes_requested"
                          ? "amber"
                          : "red"
                    }
                  >
                    {titleCase(item.status)}
                  </Badge>
                </div>
                <div className="list-row-meta">
                  <span>
                    {item.reviewerName ? `Reviewed by ${item.reviewerName}` : "No reviewer"}
                  </span>
                  {item.decisionNote ? <span>{item.decisionNote}</span> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<ClipboardCheck size={20} />}
          title="No decisions yet"
          description="Completed reviews will appear here with their decision notes."
        />
      )}
      <Modal
        open={Boolean(decision)}
        onClose={() => setDecision(null)}
        title={
          decision?.value === "approved"
            ? "Approve this work?"
            : decision?.value === "rejected"
              ? "Reject this work?"
              : "Request changes"
        }
        description={decision?.approval.subjectTitle}
        footer={
          <>
            <Button onClick={() => setDecision(null)}>Cancel</Button>
            <Button
              variant={
                decision?.value === "approved"
                  ? "primary"
                  : decision?.value === "rejected"
                    ? "danger"
                    : "secondary"
              }
              onClick={() => void submitDecision()}
              disabled={saving}
            >
              {saving
                ? "Saving…"
                : decision?.value === "approved"
                  ? "Approve"
                  : decision?.value === "rejected"
                    ? "Reject"
                    : "Send feedback"}
            </Button>
          </>
        }
      >
        <Field
          label={
            decision?.value === "approved" ? "Decision note (optional)" : "What should change?"
          }
        >
          <Textarea
            required={decision?.value !== "approved"}
            autoFocus
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Be specific enough that the owner knows exactly what to revise."
          />
        </Field>
      </Modal>
    </AppShell>
  );
}
