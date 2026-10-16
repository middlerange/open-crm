import {
  CalendarIcon as CalendarDays,
  CheckIcon as Check,
  ChevronRightIcon as ChevronRight,
  PlusIcon as Plus,
  WarningTriangleIcon as AlertTriangle,
} from "../components/icons";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { DailyCloseoutAction } from "../components/daily-closeout-action";
import { HomeViewTabs } from "../components/home-view-tabs";
import { AppShell } from "../components/shell";
import { TASK_STATUS_OPTIONS, TaskStatusIcon, taskStatusLabel } from "../components/task-status";
import {
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
import { api, titleCase } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toDateTimeLocal } from "../lib/calendar";
import { useData } from "../lib/use-data";

type Dashboard = {
  scope: "personal" | "team";
  summaries: {
    tasks: { open: number; overdue: number; dueToday: number; doneThisWeek: number };
    accounts: { total: number; pending: number; approved: number; active: number; tierA: number };
    activities: { today: number; thisWeek: number; planned: number };
    approvals: { pending: number };
  };
};

type HomeTask = {
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
  entity_name: string | null;
};

const workstreams = ["outbound", "sales", "content", "video", "operations"] as const;
const priorities = ["urgent", "high", "medium", "low"] as const;
const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const taskTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const taskDayTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function sameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function greetingFor(date: Date) {
  if (date.getHours() < 12) return "Good morning";
  if (date.getHours() < 18) return "Good afternoon";
  return "Good evening";
}

function dueLabel(task: HomeTask, today: Date) {
  if (!task.due_at) return "Any time";
  const due = new Date(task.due_at);
  return sameDay(due, today) ? taskTime.format(due) : taskDayTime.format(due);
}

function defaultTaskForm() {
  const due = new Date();
  due.setHours(due.getHours() + 1, 0, 0, 0);
  return {
    title: "",
    description: "",
    workstream: "operations",
    priority: "medium",
    dueAt: toDateTimeLocal(due.toISOString()),
  };
}

function taskOrder(left: HomeTask, right: HomeTask) {
  if (left.status === "in_progress" && right.status !== "in_progress") return -1;
  if (right.status === "in_progress" && left.status !== "in_progress") return 1;
  if (left.status === "blocked" && right.status !== "blocked") return -1;
  if (right.status === "blocked" && left.status !== "blocked") return 1;
  return (left.due_at ?? "9999").localeCompare(right.due_at ?? "9999");
}

function TaskStatusPicker({
  task,
  updating,
  onStatusChange,
}: {
  task: HomeTask;
  updating: boolean;
  onStatusChange: (task: HomeTask, status: string) => void;
}) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const currentStatus = TASK_STATUS_OPTIONS.find((status) => status.value === task.status);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 200;
    const popoverHeight = popoverRef.current?.offsetHeight ?? 260;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const roomBelow = window.innerHeight - rect.bottom;
    const top =
      roomBelow >= popoverHeight + 14 ? rect.bottom + 6 : Math.max(8, rect.top - popoverHeight - 6);
    setPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = requestAnimationFrame(() => {
      updatePosition();
      const selectedOption = popoverRef.current?.querySelector<HTMLElement>(
        '[role="option"][aria-selected="true"]',
      );
      const firstOption = popoverRef.current?.querySelector<HTMLElement>('[role="option"]');
      (selectedOption ?? firstOption)?.focus();
    });
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [close, open]);

  function moveOption(current: HTMLElement, direction: 1 | -1) {
    const options = [
      ...(popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
    ];
    const currentIndex = options.indexOf(current);
    options[(currentIndex + direction + options.length) % options.length]?.focus();
  }

  function choose(status: string) {
    close(true);
    if (status !== task.status) onStatusChange(task, status);
  }

  const popover = open ? (
    <div
      ref={popoverRef}
      className="focus-status-popover"
      style={{ left: position.left, top: position.top }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <div className="focus-status-options" id={listboxId} role="listbox" aria-label="Task status">
        {TASK_STATUS_OPTIONS.map((status) => (
          <button
            type="button"
            className={`focus-status-option is-${status.value}`}
            role="option"
            aria-selected={task.status === status.value}
            key={status.value}
            onClick={() => choose(status.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveOption(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                const options = [
                  ...(popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
                ];
                options[event.key === "Home" ? 0 : options.length - 1]?.focus();
              }
            }}
          >
            <TaskStatusIcon status={status.value} size={20} />
            <span>{status.label}</span>
            <Check className="focus-status-option-check" size={14} />
          </button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`focus-task-status is-${task.status}`}
        aria-label={`Change status for ${task.title}. Current status: ${currentStatus?.label ?? taskStatusLabel(task.status)}`}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`Change status · ${currentStatus?.label ?? taskStatusLabel(task.status)}`}
        disabled={updating}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {updating ? <Spinner /> : <TaskStatusIcon status={task.status} size={20} />}
      </button>
      {popover ? createPortal(popover, document.body) : null}
    </>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useData<Dashboard>("/dashboard");
  const {
    data: taskData,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useData<{ tasks: HomeTask[] }>("/tasks");
  const { notify } = useToast();
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskForm, setTaskForm] = useState(defaultTaskForm);
  const [savingTask, setSavingTask] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const now = new Date();
  const activeTasks = useMemo(
    () => (taskData?.tasks ?? []).filter((task) => !["done", "cancelled"].includes(task.status)),
    [taskData],
  );
  const focusTasks = useMemo(() => [...activeTasks].sort(taskOrder).slice(0, 3), [activeTasks]);
  const workstreamCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of activeTasks)
      counts.set(task.workstream, (counts.get(task.workstream) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [activeTasks]);

  function openTaskModal() {
    setTaskForm(defaultTaskForm());
    setTaskModalOpen(true);
  }

  async function createTask(event: FormEvent) {
    event.preventDefault();
    setSavingTask(true);
    try {
      await api("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: taskForm.title,
          description: taskForm.description,
          workstream: taskForm.workstream,
          kind: "execution",
          priority: taskForm.priority,
          status: "ready",
          dueAt: taskForm.dueAt ? new Date(taskForm.dueAt).toISOString() : null,
          estimateMinutes: 60,
        }),
      });
      notify("To-do added.");
      setTaskModalOpen(false);
      await Promise.all([reloadTasks(), reload()]);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to add the to-do.", "error");
    } finally {
      setSavingTask(false);
    }
  }

  async function updateTaskStatus(task: HomeTask, status: string) {
    setUpdatingId(task.id);
    try {
      await api(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      notify(`Status changed to ${taskStatusLabel(status)}.`);
      await Promise.all([reloadTasks(), reload()]);
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Unable to update the task status.",
        "error",
      );
    } finally {
      setUpdatingId(null);
    }
  }

  if (loading || tasksLoading) {
    return (
      <AppShell contentWidth="full" toolbar={<HomeViewTabs taskCount={activeTasks.length} />}>
        <div className="focus-home-state">
          <Spinner />
        </div>
      </AppShell>
    );
  }

  if (error || tasksError || !data) {
    return (
      <AppShell contentWidth="full" toolbar={<HomeViewTabs taskCount={activeTasks.length} />}>
        <div className="focus-home-state">
          <EmptyState
            icon={<AlertTriangle size={19} />}
            title="Home unavailable"
            description={error ?? tasksError ?? "Home could not be loaded."}
            action={
              <Button
                onClick={() => {
                  void Promise.all([reload(), reloadTasks()]);
                }}
              >
                Try again
              </Button>
            }
          />
        </div>
      </AppShell>
    );
  }

  const firstName = user?.name.trim().split(/\s+/)[0] || "there";
  const dueToday = data.summaries.tasks.dueToday;
  const overdue = data.summaries.tasks.overdue;
  const doneThisWeek = data.summaries.tasks.doneThisWeek;
  const pending = Math.max(0, activeTasks.length - dueToday);
  const totalTracked = activeTasks.length + doneThisWeek;
  const progress = totalTracked ? Math.round((doneThisWeek / totalTracked) * 100) : 0;
  const topWorkstreams = workstreamCounts.slice(0, 3);

  return (
    <AppShell
      contentWidth="full"
      actions={<DailyCloseoutAction />}
      toolbar={<HomeViewTabs taskCount={activeTasks.length} />}
    >
      <div className="home-insights-view crm-home">
        <header className="crm-home-hero">
          <div>
            <p className="crm-home-kicker">{fullDate.format(now)}</p>
            <h2>
              {greetingFor(now)}, {firstName}.
            </h2>
            <p className="crm-home-lede">
              Your tasks, workstreams, and account activity at a glance.
            </p>
          </div>
          <Button variant="primary" onClick={openTaskModal}>
            <Plus size={15} /> Add a to-do
          </Button>
        </header>

        <section className="stat-grid crm-home-stats" aria-label="Weekly task progress">
          <div className="stat-card">
            <p className="stat-label">Weekly progress</p>
            <p className="stat-value">{progress}%</p>
            <p className="stat-detail">
              {doneThisWeek} of {totalTracked} tracked tasks
            </p>
            <progress
              className="crm-home-progress"
              max={100}
              value={progress}
              aria-label="Weekly task progress"
            />
          </div>
          <div className="stat-card">
            <p className="stat-label">Pending</p>
            <p className="stat-value">{pending}</p>
            <p className="stat-detail">Open tasks outside today</p>
          </div>
          <div className="stat-card">
            <p className="stat-label">Due today</p>
            <p className="stat-value">{dueToday}</p>
            <p className="stat-detail">Tasks scheduled for today</p>
          </div>
          <div className="stat-card">
            <p className="stat-label">Completed</p>
            <p className="stat-value">{doneThisWeek}</p>
            <p className="stat-detail">Tasks done this week</p>
          </div>
        </section>

        <section className="insights-panel crm-home-focus" aria-labelledby="crm-home-focus-label">
          <div className="panel-header crm-home-section-head">
            <div>
              <h2 id="crm-home-focus-label">Focus now</h2>
              <p>
                {overdue
                  ? `${overdue} overdue ${plural(overdue, "task")} need attention first.`
                  : "No overdue tasks. You're up to date."}
              </p>
            </div>
            <Link className="crm-home-text-link" to="/tasks/timeline">
              <CalendarDays size={15} />
              Plan your week <ChevronRight size={14} />
            </Link>
          </div>
          {focusTasks.length ? (
            <div className="crm-home-task-list">
              {focusTasks.map((task) => {
                const due = task.due_at ? new Date(task.due_at) : null;
                const urgentDue = Boolean(due && (due < now || sameDay(due, now)));
                return (
                  <article className="crm-home-task" key={task.id}>
                    <TaskStatusPicker
                      task={task}
                      updating={updatingId === task.id}
                      onStatusChange={(item, status) => void updateTaskStatus(item, status)}
                    />
                    <div className="crm-home-task-copy">
                      <span>{task.entity_name ?? titleCase(task.workstream)}</span>
                      <Link to="/tasks">{task.title}</Link>
                    </div>
                    <time
                      className={urgentDue ? "is-urgent" : ""}
                      dateTime={task.due_at ?? undefined}
                    >
                      {dueLabel(task, now)}
                    </time>
                    <Link
                      className="crm-home-task-arrow"
                      to="/tasks"
                      aria-label={`Open ${task.title}`}
                    >
                      <ChevronRight size={16} />
                    </Link>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="crm-home-empty">No open tasks need your attention.</p>
          )}
        </section>
        <section className="crm-home-lower-grid">
          <div className="insights-panel">
            <div className="panel-header">
              <h2>Workstreams</h2>
            </div>
            <div className="crm-home-workstreams">
              {topWorkstreams.length ? (
                topWorkstreams.map(([name, count]) => (
                  <Link to="/tasks" key={name}>
                    <span>{titleCase(name)}</span>
                    <strong>{count}</strong>
                  </Link>
                ))
              ) : (
                <p className="crm-home-empty">Your workstreams will appear here.</p>
              )}
            </div>
          </div>
          <div className="insights-panel">
            <div className="panel-header crm-home-section-head">
              <div>
                <h2>Pipeline</h2>
              </div>
              <Link className="crm-home-text-link" to="/pipeline">
                Open pipeline <ChevronRight size={14} />
              </Link>
            </div>
            <div className="panel-body">
              <p className="crm-home-account-count">
                <strong>{data.summaries.accounts.active + data.summaries.accounts.approved}</strong>{" "}
                active accounts
              </p>
              <p className="crm-home-pipeline-note">
                {data.summaries.activities.thisWeek} touches this week ·{" "}
                {data.summaries.approvals.pending} pending approvals
              </p>
            </div>
          </div>
        </section>
      </div>

      <Modal
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        title="Add a to-do"
        description="Add the next concrete piece of work to your focus list."
        footer={
          <>
            <Button onClick={() => setTaskModalOpen(false)}>Cancel</Button>
            <Button form="focus-task-form" variant="primary" type="submit" disabled={savingTask}>
              {savingTask ? "Adding…" : "Add to-do"}
            </Button>
          </>
        }
      >
        <form id="focus-task-form" className="form-grid" onSubmit={createTask}>
          <Field label="To-do">
            <Input
              required
              autoFocus
              value={taskForm.title}
              placeholder="Prepare the next follow-up"
              onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })}
            />
          </Field>
          <Field label="Workstream">
            <Select
              value={taskForm.workstream}
              onValueChange={(workstream) => setTaskForm({ ...taskForm, workstream })}
            >
              {workstreams.map((workstream) => (
                <option value={workstream} key={workstream}>
                  {titleCase(workstream)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due">
            <Input
              type="datetime-local"
              value={taskForm.dueAt}
              onChange={(event) => setTaskForm({ ...taskForm, dueAt: event.target.value })}
            />
          </Field>
          <Field label="Priority">
            <Select
              value={taskForm.priority}
              onValueChange={(priority) => setTaskForm({ ...taskForm, priority })}
            >
              {priorities.map((priority) => (
                <option value={priority} key={priority}>
                  {titleCase(priority)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Definition of done" hint="Optional">
            <Textarea
              value={taskForm.description}
              placeholder="Describe the expected outcome."
              onChange={(event) => setTaskForm({ ...taskForm, description: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
