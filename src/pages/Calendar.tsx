import {
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  PlusIcon as Plus,
  ReorderHandlesIcon as GripVertical,
} from "../components/icons";
import { useMemo, useState, type DragEvent, type FormEvent } from "react";

import "../calendar.css";
import { AppShell } from "../components/shell";
import { TaskStatusIcon, TaskStatusSelect, taskStatusLabel } from "../components/task-status";
import { TaskViewTabs } from "../components/task-view-tabs";
import {
  Avatar,
  Button,
  Field,
  Input,
  Modal,
  PageToolbar,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "../components/ui";
import { api, roleLabel, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  calendarStatus,
  dateTimeForDay,
  getWeekDays,
  groupCalendarTasksByOwner,
  localDateKey,
  moveDueDate,
  tasksOnDate,
  toDateTimeLocal,
} from "../lib/calendar";
import { useData } from "../lib/use-data";

type Workstream = "outbound" | "sales" | "content" | "video" | "operations";

type Task = {
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  workstream: Workstream;
  kind: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  estimate_minutes: number | null;
  blocked_reason: string | null;
};

type TeamMember = { id: string; name: string; role: string };
type Team = { members: TeamMember[] };
type TimelineScale = "week" | "day";

const projects: Array<{ value: Workstream; label: string }> = [
  { value: "outbound", label: "Outreach" },
  { value: "sales", label: "Sales" },
  { value: "content", label: "Content" },
  { value: "video", label: "Video" },
  { value: "operations", label: "Operations" },
];

const projectLabels = Object.fromEntries(
  projects.map((project) => [project.value, project.label]),
) as Record<Workstream, string>;

const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short" });
const monthYearLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const fullDayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const shortDayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const timeLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function emptyForm(ownerId: string, dueAt = "") {
  return {
    title: "",
    description: "",
    ownerId,
    workstream: "outbound" as Workstream,
    kind: "execution",
    priority: "medium",
    status: "ready",
    dueAt,
    blockedReason: "",
  };
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function isoWeekNumber(value: Date) {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function weekPeriodLabel(days: Date[]) {
  const first = days[0];
  const last = days.at(-1)!;
  if (first.getFullYear() !== last.getFullYear()) {
    return `${monthLabel.format(first)} ${first.getDate()}, ${first.getFullYear()} – ${monthLabel.format(last)} ${last.getDate()}, ${last.getFullYear()}`;
  }
  if (first.getMonth() !== last.getMonth()) {
    return `${monthLabel.format(first)} ${first.getDate()} – ${monthLabel.format(last)} ${last.getDate()}, ${last.getFullYear()}`;
  }
  return `${monthLabel.format(first)} ${first.getDate()} – ${last.getDate()}, ${last.getFullYear()}`;
}

function effortLabel(task: Task) {
  if (task.estimate_minutes) {
    if (task.estimate_minutes < 60) return `${task.estimate_minutes}m`;
    const hours = task.estimate_minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  return task.due_at ? timeLabel.format(new Date(task.due_at)) : "";
}

function TimelineTaskCard({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  const tone = calendarStatus(task);
  return (
    <button
      type="button"
      draggable
      data-status={task.status}
      title={`${projectLabels[task.workstream]} · ${taskStatusLabel(task.status)}`}
      className={cx("timeline-task", `timeline-task-${task.workstream}`)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/task-id", task.id);
        event.dataTransfer.setData("text/plain", task.id);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(task);
      }}
      aria-label={`${task.title}, ${projectLabels[task.workstream]}, ${tone === "overdue" ? "overdue" : taskStatusLabel(task.status)}`}
    >
      <TaskStatusIcon status={task.status} size={14} />
      <span className="timeline-task-title">{task.title}</span>
      <span className="timeline-task-effort">{effortLabel(task)}</span>
      <GripVertical className="timeline-task-grip" size={13} aria-hidden="true" />
    </button>
  );
}

export function CalendarPage() {
  const { user } = useAuth();
  const { data, loading, reload } = useData<{ tasks: Task[] }>("/tasks");
  const { data: team, loading: teamLoading } = useData<Team>("/team");
  const { notify } = useToast();
  const [scale, setScale] = useState<TimelineScale>(() =>
    typeof window !== "undefined" && window.innerWidth < 1024 ? "day" : "week",
  );
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => emptyForm(user?.id ?? ""));

  const members = team?.members ?? [];
  const canManageTeam = user?.role === "founder" || user?.role === "manager";
  const visibleMembers = canManageTeam
    ? members
    : members.filter((member) => member.id === user?.id);
  const tasks = data?.tasks ?? [];
  const days = useMemo(
    () => (scale === "week" ? getWeekDays(anchor) : [startOfDay(anchor)]),
    [anchor, scale],
  );
  const ownerLanes = groupCalendarTasksByOwner(tasks, visibleMembers);
  const todayKey = localDateKey(new Date());
  const periodTitle = scale === "week" ? weekPeriodLabel(days) : fullDayLabel.format(days[0]);
  const headerLabel =
    scale === "week"
      ? `W${String(isoWeekNumber(days[0])).padStart(2, "0")} · ${monthYearLabel.format(days[0])}`
      : monthYearLabel.format(days[0]);

  function openCreate(date: Date, ownerId = user?.id ?? "") {
    setEditingTask(null);
    const selectedOwner = !canManageTeam || ownerId === "unassigned" ? (user?.id ?? "") : ownerId;
    setForm(emptyForm(selectedOwner, dateTimeForDay(date)));
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
      blockedReason: task.blocked_reason ?? "",
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
      blockedReason: form.status === "blocked" ? form.blockedReason || null : null,
    };
    try {
      if (editingTask) {
        await api(`/tasks/${editingTask.id}`, { method: "PATCH", body: JSON.stringify(payload) });
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
        notify("Task scheduled.");
      }
      setModalOpen(false);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to save task.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function dropTask(event: DragEvent, date: Date, targetOwnerId: string) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("text/task-id") || event.dataTransfer.getData("text/plain");
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const nextOwnerId = targetOwnerId === "unassigned" ? null : targetOwnerId;
    const payload: { dueAt: string; ownerId?: string | null } = {
      dueAt: moveDueDate(task.due_at, date),
    };
    if (canManageTeam && nextOwnerId !== task.owner_id) payload.ownerId = nextOwnerId;
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      notify(
        payload.ownerId !== undefined ? "Task rescheduled and reassigned." : "Task rescheduled.",
      );
      setSelectedDate(date);
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to move task.", "error");
    }
  }

  function shiftPeriod(amount: number) {
    const next = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + amount * (scale === "week" ? 7 : 1),
    );
    setAnchor(next);
    setSelectedDate(next);
  }

  function goToday() {
    const today = new Date();
    setAnchor(today);
    setSelectedDate(today);
  }

  return (
    <AppShell
      contentWidth="full"
      actions={
        <Button variant="primary" onClick={() => openCreate(selectedDate)}>
          <Plus size={15} /> Add task
        </Button>
      }
      toolbar={
        <PageToolbar className="task-workspace-toolbar" label="Task views and timeline controls">
          <TaskViewTabs />
          <div className="task-workspace-controls timeline-view-controls">
            <div className="timeline-toolbar-left">
              <div className="timeline-arrow-group">
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Previous period"
                  onClick={() => shiftPeriod(-1)}
                >
                  <ChevronLeft size={16} />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Next period"
                  onClick={() => shiftPeriod(1)}
                >
                  <ChevronRight size={16} />
                </Button>
              </div>
              <Button variant="secondary" size="small" onClick={goToday}>
                Today
              </Button>
              <span className="timeline-period" aria-live="polite">
                {periodTitle}
              </span>
            </div>
            <Select
              className="timeline-scale-select"
              value={scale}
              onValueChange={(value) => setScale(value as TimelineScale)}
              aria-label="Timeline scale"
            >
              <option value="week">Week</option>
              <option value="day">Day</option>
            </Select>
          </div>
        </PageToolbar>
      }
    >
      <section className="timeline-page" aria-label="Team timeline">
        {loading || teamLoading ? (
          <div className="timeline-loading">
            <Spinner />
          </div>
        ) : (
          <div className="timeline-scroll">
            <div className={cx("timeline-grid", `timeline-grid-${scale}`, "timeline-board-header")}>
              <div className="timeline-people-header">
                <span>People · {ownerLanes.length}</span>
                <Button
                  variant="plain"
                  size="icon"
                  aria-label="Add task"
                  onClick={() => openCreate(selectedDate)}
                >
                  <Plus size={17} />
                </Button>
              </div>
              <div className="timeline-range-header">{headerLabel}</div>
              {days.map((day) => {
                const key = localDateKey(day);
                return (
                  <button
                    type="button"
                    key={key}
                    className={cx("timeline-day-heading", key === todayKey && "timeline-today")}
                    aria-pressed={key === localDateKey(selectedDate)}
                    onClick={() => {
                      setSelectedDate(day);
                      if (scale === "day") setAnchor(day);
                    }}
                  >
                    <span>{shortDayLabel.format(day)}</span>
                    <strong>{day.getDate()}</strong>
                  </button>
                );
              })}
            </div>

            {ownerLanes.map((lane) => (
              <div
                className={cx("timeline-grid", `timeline-grid-${scale}`, "timeline-member-row")}
                key={lane.id}
              >
                <div className="timeline-person">
                  <Avatar name={lane.name} size="small" />
                  <span>
                    <strong>{lane.name}</strong>
                    <small>{lane.tasks.filter((task) => task.due_at).length} scheduled tasks</small>
                  </span>
                </div>
                {days.map((day) => {
                  const key = localDateKey(day);
                  const dayTasks = tasksOnDate(lane.tasks, day);
                  return (
                    <div
                      key={key}
                      className={cx(
                        "timeline-day-cell",
                        key === todayKey && "timeline-today",
                        [0, 6].includes(day.getDay()) && "timeline-weekend",
                      )}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => void dropTask(event, day, lane.id)}
                    >
                      <button
                        type="button"
                        className="timeline-cell-add"
                        aria-label={`Add task for ${lane.name} on ${fullDayLabel.format(day)}`}
                        onClick={() => openCreate(day, lane.id)}
                      >
                        <Plus size={14} />
                      </button>
                      <div className="timeline-task-list">
                        {dayTasks.slice(0, 4).map((task) => (
                          <TimelineTaskCard key={task.id} task={task} onOpen={openEdit} />
                        ))}
                        {dayTasks.length > 4 ? (
                          <button
                            type="button"
                            className="timeline-more"
                            onClick={() => setSelectedDate(day)}
                          >
                            +{dayTasks.length - 4} more
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            {!ownerLanes.length ? (
              <div className="timeline-empty">No people are available for this timeline.</div>
            ) : null}
          </div>
        )}
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingTask ? "Manage task" : "Schedule task"}
        description={
          editingTask
            ? "Update its project, owner, due date, or status."
            : "Add work directly to the timeline."
        }
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button form="timeline-task-form" variant="primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : editingTask ? "Save changes" : "Schedule task"}
            </Button>
          </>
        }
      >
        <form id="timeline-task-form" className="form-grid" onSubmit={saveTask}>
          <Field label="Task">
            <Input
              required
              autoFocus
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Prepare launch follow-up sequence"
            />
          </Field>
          <Field label="Owner">
            <Select
              value={form.ownerId}
              disabled={!canManageTeam}
              onValueChange={(ownerId) => setForm({ ...form, ownerId })}
            >
              {canManageTeam && editingTask ? <option value="">Unassigned</option> : null}
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} · {roleLabel(member.role)}
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
          <Field label="Status">
            <TaskStatusSelect
              value={form.status}
              onValueChange={(status) => setForm({ ...form, status })}
            />
          </Field>
          <Field label="Project">
            <Select
              value={form.workstream}
              onValueChange={(workstream) =>
                setForm({ ...form, workstream: workstream as Workstream })
              }
            >
              {projects.map((project) => (
                <option key={project.value} value={project.value}>
                  {project.label}
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
          <Field label="Task type">
            <Input
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
              placeholder="execution"
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
          <Field label="Notes">
            <Textarea
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Context, acceptance criteria, or links"
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
