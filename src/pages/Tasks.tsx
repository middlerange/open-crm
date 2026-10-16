import {
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  CheckIcon as Check,
  ChecklistIcon as ListTodo,
  PencilIcon as Pencil,
  PlayIcon as CirclePlay,
  PlusIcon as Plus,
} from "../components/icons";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { AppShell } from "../components/shell";
import {
  TASK_STATUS_OPTIONS,
  TaskStatusDisplay,
  TaskStatusIcon,
  TaskStatusSelect,
  type TaskStatus,
} from "../components/task-status";
import { TaskViewTabs } from "../components/task-view-tabs";
import {
  Badge,
  Avatar,
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
  cx,
  useToast,
} from "../components/ui";
import { api, relativeDate, roleLabel, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toDateTimeLocal } from "../lib/calendar";
import { useData } from "../lib/use-data";

type Task = {
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  workstream: string;
  kind: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  estimate_minutes: number | null;
  blocked_reason: string | null;
  entity_type: string | null;
  entity_id: string | null;
  entity_name: string | null;
};
type Team = { members: Array<{ id: string; name: string; role: string }> };
type RelatedRecord = { id: string; name: string };

const listStatuses: TaskStatus[] = [
  "in_progress",
  "ready",
  "blocked",
  "review",
  "backlog",
  "done",
  "cancelled",
];
function workstreamTone(workstream: string) {
  if (workstream === "outbound") return "blue" as const;
  if (workstream === "sales") return "green" as const;
  if (workstream === "content") return "purple" as const;
  if (workstream === "video") return "amber" as const;
  return "neutral" as const;
}

function taskIsOverdue(task: Task) {
  return Boolean(
    task.due_at &&
    new Date(task.due_at) < new Date() &&
    !["done", "cancelled"].includes(task.status),
  );
}

function emptyForm(ownerId: string) {
  return {
    title: "",
    description: "",
    ownerId,
    workstream: "outbound",
    kind: "execution",
    priority: "medium",
    status: "backlog",
    dueAt: "",
    estimateMinutes: "",
    blockedReason: "",
    entityType: "",
    entityId: "",
  };
}

export function TasksPage({ view = "list" }: { view?: "list" | "board" }) {
  const { user } = useAuth();
  const { data, loading, reload } = useData<{ tasks: Task[] }>("/tasks");
  const { data: team } = useData<Team>("/team");
  const { data: accountData } = useData<{ accounts: RelatedRecord[] }>("/accounts?pageSize=250");
  const { data: contactData } = useData<{
    contacts: Array<{ id: string; firstName: string; lastName: string }>;
  }>("/contacts?archived=active&limit=250");
  const { data: pipelineData } = useData<{ opportunities: RelatedRecord[] }>("/pipeline");
  const { notify } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [search, setSearch] = useState("");
  const [stream, setStream] = useState("");
  const [saving, setSaving] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [form, setForm] = useState(() => emptyForm(user?.id ?? ""));
  const canManageTeam = user?.role === "founder" || user?.role === "manager";
  const tasks = useMemo(
    () =>
      (data?.tasks ?? []).filter(
        (task) =>
          (!search ||
            `${task.title} ${task.description ?? ""}`
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (!stream || task.workstream === stream),
      ),
    [data, search, stream],
  );
  const hasFilters = Boolean(search || stream);
  const availableRelatedRecords: RelatedRecord[] =
    form.entityType === "account"
      ? (accountData?.accounts ?? [])
      : form.entityType === "contact"
        ? (contactData?.contacts ?? []).map((contact) => ({
            id: contact.id,
            name: `${contact.firstName} ${contact.lastName}`.trim(),
          }))
        : form.entityType === "opportunity"
          ? (pipelineData?.opportunities ?? [])
          : [];
  const relatedRecords =
    editingTask?.entity_id === form.entityId &&
    editingTask.entity_name &&
    !availableRelatedRecords.some((record) => record.id === editingTask.entity_id)
      ? [...availableRelatedRecords, { id: editingTask.entity_id, name: editingTask.entity_name }]
      : availableRelatedRecords;

  function openCreate(status: TaskStatus = "backlog") {
    setEditingTask(null);
    setForm({ ...emptyForm(user?.id ?? ""), status });
    setModalOpen(true);
  }

  function openEdit(task: Task) {
    setEditingTask(task);
    setForm({
      title: task.title,
      description: task.description ?? "",
      ownerId: task.owner_id ?? "",
      workstream: task.workstream,
      kind: task.kind,
      priority: task.priority,
      status: task.status,
      dueAt: toDateTimeLocal(task.due_at),
      estimateMinutes: task.estimate_minutes ? String(task.estimate_minutes) : "",
      blockedReason: task.blocked_reason ?? "",
      entityType: task.entity_type ?? "",
      entityId: task.entity_id ?? "",
    });
    setModalOpen(true);
  }

  async function saveTask(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const payload = {
      title: form.title,
      description: form.description,
      ownerId: canManageTeam ? form.ownerId || null : undefined,
      workstream: form.workstream,
      kind: form.kind,
      priority: form.priority,
      status: form.status,
      dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
      estimateMinutes: form.estimateMinutes ? Number(form.estimateMinutes) : null,
      entityType: form.entityType || null,
      entityId: form.entityId || null,
    };
    const blockedReason = form.status === "blocked" ? form.blockedReason || null : null;
    try {
      if (editingTask) {
        await api(`/tasks/${editingTask.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...payload, blockedReason }),
        });
        notify("Task updated.");
      } else {
        const created = await api<{ id: string }>("/tasks", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (form.status === "blocked" && form.blockedReason) {
          await api(`/tasks/${created.id}`, {
            method: "PATCH",
            body: JSON.stringify({ blockedReason: form.blockedReason }),
          });
        }
        notify("Work added to the queue.");
      }
      setModalOpen(false);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to save task.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function moveTask(task: Task, status: string) {
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      notify(status === "done" ? "Task completed." : "Task moved.");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update task.", "error");
    }
  }

  function dropTask(taskId: string, status: TaskStatus) {
    const task = tasks.find((item) => item.id === taskId);
    setDraggingTaskId(null);
    setDragOverStatus(null);
    if (task && task.status !== status) void moveTask(task, status);
  }

  return (
    <AppShell
      actions={
        <Button variant="primary" onClick={() => openCreate()}>
          <Plus size={15} /> Add task
        </Button>
      }
      contentWidth={view === "board" ? "full" : "standard"}
      toolbar={
        <PageToolbar
          className="table-toolbar tasks-toolbar task-workspace-toolbar"
          label="Task views, search, and filters"
        >
          <TaskViewTabs />
          <div className="task-workspace-controls tasks-view-controls">
            <SearchInput
              className="table-toolbar-search"
              value={search}
              onChange={setSearch}
              placeholder="Search tasks…"
            />
            <div className="table-toolbar-controls">
              <Select aria-label="Filter by workstream" value={stream} onValueChange={setStream}>
                <option value="">All workstreams</option>
                {["outbound", "sales", "content", "video", "operations"].map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </PageToolbar>
      }
    >
      {loading ? (
        <div className="loading-page loading-section">
          <Spinner />
        </div>
      ) : view === "board" ? (
        <div className="task-kanban" role="region" aria-label="Task board grouped by status">
          {TASK_STATUS_OPTIONS.map(({ value: status, label }) => {
            const items = tasks.filter((task) => task.status === status);
            return (
              <section
                className={cx(
                  "task-kanban-column",
                  `task-kanban-column-${status}`,
                  dragOverStatus === status && "is-drag-over",
                )}
                key={status}
                aria-labelledby={`task-kanban-${status}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverStatus(status);
                }}
                onDragLeave={(event) => {
                  const relatedTarget = event.relatedTarget;
                  if (
                    !(relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(relatedTarget)
                  ) {
                    setDragOverStatus(null);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dropTask(event.dataTransfer.getData("text/plain"), status);
                }}
              >
                <header className="task-kanban-column-header">
                  <div>
                    <TaskStatusIcon status={status} size={17} />
                    <h2 id={`task-kanban-${status}`}>{label}</h2>
                    <span
                      className="task-kanban-count"
                      aria-label={`${items.length} ${items.length === 1 ? "task" : "tasks"}`}
                    >
                      {items.length}
                    </span>
                  </div>
                </header>
                <div className="task-kanban-column-body">
                  {items.map((task) => {
                    const done = task.status === "done";
                    const cancelled = task.status === "cancelled";
                    const overdue = taskIsOverdue(task);
                    const PriorityIcon = task.priority === "low" ? ArrowDown : ArrowUp;
                    return (
                      <article
                        className={cx(
                          "task-kanban-card",
                          draggingTaskId === task.id && "is-dragging",
                          (done || cancelled) && "is-closed",
                        )}
                        key={task.id}
                        role="button"
                        tabIndex={0}
                        draggable
                        aria-label={`Edit ${task.title}`}
                        onClick={() => openEdit(task)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openEdit(task);
                          }
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", task.id);
                          setDraggingTaskId(task.id);
                        }}
                        onDragEnd={() => {
                          setDraggingTaskId(null);
                          setDragOverStatus(null);
                        }}
                      >
                        <div className="task-kanban-card-kicker">
                          <span className="task-kanban-kind">
                            <span className="task-kanban-kind-icon">
                              <ListTodo size={13} />
                            </span>
                            {titleCase(task.kind)}
                          </span>
                          {task.due_at || task.estimate_minutes ? (
                            <span className={cx("task-kanban-date", overdue && "overdue")}>
                              {task.due_at
                                ? relativeDate(task.due_at)
                                : `${task.estimate_minutes}m`}
                            </span>
                          ) : null}
                        </div>
                        <strong className="task-kanban-card-title">{task.title}</strong>
                        <div className="task-kanban-card-context">
                          <Badge tone={workstreamTone(task.workstream)}>
                            {titleCase(task.workstream)}
                          </Badge>
                          {task.entity_name ? <span>{task.entity_name}</span> : null}
                        </div>
                        {task.blocked_reason ? (
                          <p className="task-kanban-blocked-reason">{task.blocked_reason}</p>
                        ) : null}
                        <footer className="task-kanban-card-footer">
                          <Avatar name={task.owner_name ?? "Unassigned"} size="small" />
                          {done ? (
                            <span className="task-kanban-complete">
                              <TaskStatusIcon status="done" size={15} /> Done
                            </span>
                          ) : cancelled ? (
                            <span className="task-kanban-cancelled">
                              <TaskStatusIcon status="cancelled" size={15} /> Canceled
                            </span>
                          ) : (
                            <span
                              className={`task-kanban-priority task-kanban-priority-${task.priority}`}
                            >
                              <PriorityIcon size={14} /> {titleCase(task.priority)}
                            </span>
                          )}
                        </footer>
                      </article>
                    );
                  })}
                  <button
                    type="button"
                    className="task-kanban-add"
                    onClick={() => openCreate(status)}
                  >
                    <Plus size={16} /> Add task
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      ) : tasks.length ? (
        <div className="task-board" role="region" aria-label="Tasks grouped by status">
          {listStatuses.map((status) => {
            const items = tasks.filter((task) => task.status === status);
            if (!items.length) return null;
            return (
              <section className={`task-group task-group-${status}`} key={status}>
                <header className="task-group-header">
                  <h2>
                    <TaskStatusDisplay status={status} />
                  </h2>
                  <span
                    className="task-group-count"
                    aria-label={`${items.length} ${items.length === 1 ? "item" : "items"}`}
                  >
                    <Badge
                      tone={
                        status === "blocked"
                          ? "red"
                          : status === "in_progress"
                            ? "blue"
                            : status === "done"
                              ? "green"
                              : "neutral"
                      }
                    >
                      {items.length}
                    </Badge>
                  </span>
                </header>
                <div className="task-list">
                  {items.map((task) => (
                    <div
                      className="task-row task-row-editable"
                      key={task.id}
                      title={`Edit ${task.title}`}
                      onClick={() => openEdit(task)}
                    >
                      <span
                        className={`priority-dot priority-${task.priority}`}
                        role="img"
                        aria-label={`${titleCase(task.priority)} priority`}
                      />
                      <div className="task-row-main">
                        <div className="task-row-heading">
                          <strong className="task-row-title">{task.title}</strong>
                          <div className="task-row-badges">
                            <Badge>{titleCase(task.workstream)}</Badge>
                            {task.priority === "urgent" ? <Badge tone="red">Urgent</Badge> : null}
                          </div>
                        </div>
                        <div className="task-row-meta">
                          <span>{task.owner_name ?? "Unassigned"}</span>
                          <span>{titleCase(task.kind)}</span>
                          {task.entity_name ? (
                            <Link
                              to={
                                task.entity_type === "account"
                                  ? `/accounts/${task.entity_id}`
                                  : task.entity_type === "contact"
                                    ? `/contacts?contact=${task.entity_id}`
                                    : `/opportunities/${task.entity_id}`
                              }
                              onClick={(event) => event.stopPropagation()}
                            >
                              {task.entity_name}
                            </Link>
                          ) : null}
                          <span className={taskIsOverdue(task) ? "overdue" : ""}>
                            {relativeDate(task.due_at)}
                          </span>
                          {task.blocked_reason ? (
                            <span className="task-blocked-reason">{task.blocked_reason}</span>
                          ) : null}
                        </div>
                      </div>
                      <div
                        className="task-row-actions"
                        role="group"
                        aria-label={`Actions for ${task.title}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {!["done", "cancelled"].includes(task.status) ? (
                          <>
                            {task.status !== "in_progress" ? (
                              <Button
                                variant="plain"
                                size="icon"
                                aria-label={`Start ${task.title}`}
                                title="Start task"
                                onClick={() => void moveTask(task, "in_progress")}
                              >
                                <CirclePlay size={16} />
                              </Button>
                            ) : null}
                            <Button
                              variant="plain"
                              size="icon"
                              aria-label={`Complete ${task.title}`}
                              title="Complete task"
                              onClick={() => void moveTask(task, "done")}
                            >
                              <Check size={16} />
                            </Button>
                          </>
                        ) : task.status === "done" ? (
                          <Badge tone="green">
                            <TaskStatusDisplay status="done" iconSize={14} />
                          </Badge>
                        ) : (
                          <Badge>
                            <TaskStatusDisplay status="cancelled" iconSize={14} />
                          </Badge>
                        )}
                        <Button
                          variant="plain"
                          size="icon"
                          aria-label={`Edit ${task.title}`}
                          title="Edit task"
                          onClick={() => openEdit(task)}
                        >
                          <Pencil size={15} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<ListTodo size={19} />}
          title={hasFilters ? "No matching tasks" : "No tasks yet"}
          description={
            hasFilters
              ? "Try another search or clear the current workstream filter."
              : "Add the next accountable task with one owner and a clear due date."
          }
          action={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearch("");
                  setStream("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button variant="primary" onClick={() => openCreate()}>
                <Plus size={15} /> Add work
              </Button>
            )
          }
        />
      )}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingTask ? "Edit task" : "Add task"}
        description={
          editingTask
            ? "Update any task detail, including its status and completed work."
            : "Choose one owner and make the next action concrete."
        }
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button form="task-form" variant="primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : editingTask ? "Save changes" : "Add to queue"}
            </Button>
          </>
        }
      >
        <form id="task-form" className="form-grid" onSubmit={saveTask}>
          <Field label="Task">
            <Input
              required
              autoFocus
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Research 10 onboarding-led SaaS accounts"
            />
          </Field>
          <Field
            label="Owner"
            hint={user?.role === "ic" ? "Only a Lead can reassign this task." : undefined}
          >
            <Select
              value={form.ownerId}
              disabled={!canManageTeam}
              onValueChange={(ownerId) => setForm({ ...form, ownerId })}
            >
              {editingTask && canManageTeam ? <option value="">Unassigned</option> : null}
              {team?.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} · {roleLabel(member.role)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <TaskStatusSelect
              value={form.status}
              onValueChange={(status) => setForm({ ...form, status })}
            />
          </Field>
          <Field label="Workstream">
            <Select
              value={form.workstream}
              onValueChange={(workstream) => setForm({ ...form, workstream })}
            >
              {["outbound", "sales", "content", "video", "operations"].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select
              value={form.priority}
              onValueChange={(priority) => setForm({ ...form, priority })}
            >
              {["urgent", "high", "medium", "low"].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due">
            <Input
              type="datetime-local"
              value={form.dueAt}
              onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
            />
          </Field>
          <Field label="Kind">
            <Input
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
              placeholder="research"
            />
          </Field>
          <Field label="Estimate (minutes)">
            <Input
              type="number"
              min="1"
              step="5"
              value={form.estimateMinutes}
              onChange={(event) => setForm({ ...form, estimateMinutes: event.target.value })}
              placeholder="30"
            />
          </Field>
          {form.status === "blocked" ? (
            <Field label="Blocked reason">
              <Input
                value={form.blockedReason}
                onChange={(event) => setForm({ ...form, blockedReason: event.target.value })}
                placeholder="What is preventing progress?"
              />
            </Field>
          ) : null}
          <Field label="Related record type">
            <Select
              value={form.entityType}
              onValueChange={(entityType) => setForm({ ...form, entityType, entityId: "" })}
            >
              <option value="">No CRM link</option>
              <option value="account">Account</option>
              <option value="contact">Contact</option>
              <option value="opportunity">Opportunity</option>
            </Select>
          </Field>
          <Field label="Related record">
            <Select
              searchable
              disabled={!form.entityType}
              value={form.entityId}
              onValueChange={(entityId) => setForm({ ...form, entityId })}
            >
              <option value="">Select a record</option>
              {relatedRecords.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Definition of done" hint="Describe the deliverable or evidence expected.">
            <Textarea
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Ten companies with visible triggers, supporting links, and a relevant buyer each."
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
