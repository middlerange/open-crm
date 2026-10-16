import {
  ArrowRightIcon as ArrowRight,
  ArrowUpRightIcon as ArrowUpRight,
  BuildingsIcon as BriefcaseBusiness,
  CalendarIcon as CalendarDays,
  ChatBubbleIcon as MessageSquareText,
  CheckCircleIcon as CheckCircle2,
  CheckIcon as Check,
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  ClockIcon as Clock3,
  PlusIcon as Plus,
  RecordIcon as CircleDot,
  SearchIcon as Search,
  SparklesIcon as Sparkles,
  WarningTriangleIcon as AlertTriangle,
} from "../components/icons";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { DailyCloseoutAction } from "../components/daily-closeout-action";
import { HomeViewTabs } from "../components/home-view-tabs";
import { AppShell } from "../components/shell";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Panel,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "../components/ui";
import { api, relativeDate, titleCase } from "../lib/api";
import { getWeekDays, localDateKey, tasksOnDate, toDateTimeLocal } from "../lib/calendar";
import { useData } from "../lib/use-data";

type Dashboard = {
  scope: "personal" | "team";
  summaries: {
    tasks: { open: number; overdue: number; dueToday: number; doneThisWeek: number };
    accounts: { total: number; pending: number; approved: number; active: number; tierA: number };
    activities: { today: number; thisWeek: number; planned: number };
    approvals: { pending: number };
  };
  pipeline: Array<{ key: string; name: string; count: number; value: string }>;
  attention: Array<{
    type: string;
    id: string;
    title: string;
    detail: string;
    dueAt: string | null;
    ownerName: string | null;
  }>;
  goals: Array<{
    id: string;
    metric: string;
    label: string;
    target: number;
    actual: number;
    ownerId: string;
    ownerName: string;
    periodEnd: string;
  }>;
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
};

type HomeView = "tasks" | "insights";

type CalendarLayout = {
  task: HomeTask;
  style: CSSProperties;
};

const CALENDAR_START_HOUR = 8;
const CALENDAR_END_HOUR = 20;
const calendarHours = Array.from(
  { length: CALENDAR_END_HOUR - CALENDAR_START_HOUR },
  (_, index) => CALENDAR_START_HOUR + index,
);
const dateRange = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayNumber = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const taskTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

const workstreams = ["outbound", "sales", "content", "video", "operations"] as const;
const priorities = ["urgent", "high", "medium", "low"] as const;

function taskIsOverdue(task: HomeTask, now = new Date()) {
  return Boolean(task.due_at && new Date(task.due_at) < now);
}

function formatEstimate(minutes: number | null) {
  if (!minutes) return "1h";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function defaultTaskForm() {
  const due = new Date();
  if (due.getHours() >= CALENDAR_END_HOUR - 1) {
    due.setDate(due.getDate() + 1);
    due.setHours(9, 0, 0, 0);
  } else {
    due.setHours(Math.max(9, due.getHours() + 1), 0, 0, 0);
  }
  return {
    title: "",
    description: "",
    workstream: "operations",
    kind: "execution",
    priority: "medium",
    dueAt: toDateTimeLocal(due.toISOString()),
    estimateMinutes: "60",
  };
}

function layoutCalendarTasks(tasks: HomeTask[]): CalendarLayout[] {
  const rawItems = tasks
    .filter((task) => task.due_at)
    .map((task) => {
      const date = new Date(task.due_at!);
      const rawEnd = date.getHours() * 60 + date.getMinutes();
      const end = Math.max(CALENDAR_START_HOUR * 60, Math.min(CALENDAR_END_HOUR * 60, rawEnd));
      const duration = Math.max(30, Math.min(180, task.estimate_minutes ?? 60));
      return { task, due: end, duration };
    })
    .sort((left, right) => left.due - right.due);

  const items = rawItems.flatMap((item, index, allItems) => {
    if (index > 0 && allItems[index - 1].due === item.due) return [];
    const sameDeadline = allItems.filter((candidate) => candidate.due === item.due);
    const totalDuration = sameDeadline.reduce((sum, candidate) => sum + candidate.duration, 0);
    let cursor = Math.max(CALENDAR_START_HOUR * 60, item.due - totalDuration);
    return sameDeadline.map((candidate) => {
      const start = cursor;
      cursor += candidate.duration;
      return { ...candidate, start, end: cursor };
    });
  });

  const groups: (typeof items)[] = [];
  let groupEnd = -1;
  for (const item of items) {
    if (!groups.length || item.start >= groupEnd) {
      groups.push([item]);
      groupEnd = item.end;
    } else {
      groups[groups.length - 1].push(item);
      groupEnd = Math.max(groupEnd, item.end);
    }
  }

  return groups.flatMap((group) =>
    group.map((item, index) => {
      const calendarMinutes = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 60;
      const top = ((item.start - CALENDAR_START_HOUR * 60) / calendarMinutes) * 100;
      const height = Math.max(4.2, (item.duration / calendarMinutes) * 100);
      const columnWidth = 100 / group.length;
      return {
        task: item.task,
        style: {
          "--task-top": `calc(${top}% + 3px)`,
          "--task-height": `calc(${height}% - 4px)`,
          "--task-left": `calc(${columnWidth * index}% + 4px)`,
          "--task-width": `calc(${columnWidth}% - 8px)`,
        } as CSSProperties,
      };
    }),
  );
}

function TaskCompleteButton({
  task,
  completing,
  onComplete,
}: {
  task: HomeTask;
  completing: boolean;
  onComplete: (task: HomeTask) => void;
}) {
  return (
    <button
      type="button"
      className="home-task-complete"
      aria-label={`Complete ${task.title}`}
      disabled={completing}
      onClick={() => onComplete(task)}
    >
      {completing ? <Spinner /> : <Check size={13} />}
    </button>
  );
}

function CalendarTask({ task, style }: CalendarLayout) {
  return (
    <article
      className={cx(
        "home-calendar-task",
        `home-task-${task.workstream}`,
        taskIsOverdue(task) && "home-calendar-task-overdue",
      )}
      style={style}
    >
      <Link to="/tasks" aria-label={`Open ${task.title}`}>
        <span className="home-calendar-task-stream">{titleCase(task.workstream)}</span>
        <strong>{task.title}</strong>
        <span className="home-calendar-task-detail">
          <Clock3 size={11} /> {formatEstimate(task.estimate_minutes)}
        </span>
      </Link>
    </article>
  );
}

function QueueTask({
  task,
  showOwner,
  completing,
  onComplete,
}: {
  task: HomeTask;
  showOwner: boolean;
  completing: boolean;
  onComplete: (task: HomeTask) => void;
}) {
  const overdue = taskIsOverdue(task);
  return (
    <article className="home-task-card">
      <div className="home-task-card-context">
        <span>{titleCase(task.kind)}</span>
        <ArrowUpRight size={12} />
      </div>
      <div className="home-task-card-title">
        <TaskCompleteButton task={task} completing={completing} onComplete={onComplete} />
        <Link to="/tasks">{task.title}</Link>
      </div>
      <div className="home-task-card-chips">
        <span className={cx("home-workstream-chip", `home-workstream-${task.workstream}`)}>
          <i /> {titleCase(task.workstream)}
        </span>
        <span className={overdue ? "home-due-chip overdue" : "home-due-chip"}>
          {relativeDate(task.due_at)}
        </span>
        <span>{formatEstimate(task.estimate_minutes)}</span>
        {showOwner && task.owner_name ? <span>{task.owner_name}</span> : null}
      </div>
    </article>
  );
}

export function HomeWorkspacePage({ view }: { view: HomeView }) {
  const { data, loading, error, reload } = useData<Dashboard>("/dashboard");
  const {
    data: taskData,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useData<{ tasks: HomeTask[] }>("/tasks");
  const { notify } = useToast();
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [taskSearchOpen, setTaskSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskForm, setTaskForm] = useState(defaultTaskForm);
  const [savingTask, setSavingTask] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const calendarScrollRef = useRef<HTMLDivElement>(null);

  const weekDays = useMemo(() => getWeekDays(weekAnchor), [weekAnchor]);
  const activeTasks = useMemo(
    () => (taskData?.tasks ?? []).filter((task) => !["done", "cancelled"].includes(task.status)),
    [taskData],
  );
  const queue = useMemo(
    () =>
      [...activeTasks].sort((left, right) => {
        const leftOverdue = taskIsOverdue(left) ? 0 : 1;
        const rightOverdue = taskIsOverdue(right) ? 0 : 1;
        if (leftOverdue !== rightOverdue) return leftOverdue - rightOverdue;
        if (left.status === "in_progress" && right.status !== "in_progress") return -1;
        if (right.status === "in_progress" && left.status !== "in_progress") return 1;
        return (left.due_at ?? "9999").localeCompare(right.due_at ?? "9999");
      }),
    [activeTasks],
  );
  const filteredQueue = queue.filter((task) =>
    `${task.title} ${task.workstream} ${task.owner_name ?? ""}`
      .toLowerCase()
      .includes(taskSearch.trim().toLowerCase()),
  );
  const tasksThisWeek = activeTasks.filter((task) =>
    weekDays.some(
      (day) => task.due_at && localDateKey(new Date(task.due_at)) === localDateKey(day),
    ),
  );
  const unscheduledTasks = activeTasks.filter((task) => !task.due_at);
  const overdueCount = activeTasks.filter((task) => taskIsOverdue(task)).length;
  const showOwner = data?.scope === "team";
  const todayKey = localDateKey(new Date());
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const showNowLine =
    weekDays.some((day) => localDateKey(day) === todayKey) &&
    nowMinutes >= CALENDAR_START_HOUR * 60 &&
    nowMinutes <= CALENDAR_END_HOUR * 60;
  const nowLineStyle = {
    "--now-top": `${
      ((nowMinutes - CALENDAR_START_HOUR * 60) / ((CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 60)) *
      100
    }%`,
  } as CSSProperties;

  useEffect(() => {
    const scroller = calendarScrollRef.current;
    const today = scroller?.querySelector<HTMLElement>(".home-calendar-day-head.is-today");
    if (!scroller || !today || scroller.scrollWidth <= scroller.clientWidth) return;
    scroller.scrollLeft = Math.max(0, today.offsetLeft - 52);
  }, [loading, tasksLoading, view, weekAnchor]);

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
          kind: taskForm.kind,
          priority: taskForm.priority,
          status: "ready",
          dueAt: taskForm.dueAt ? new Date(taskForm.dueAt).toISOString() : null,
          estimateMinutes: taskForm.estimateMinutes ? Number(taskForm.estimateMinutes) : null,
        }),
      });
      notify("Task added to the schedule.");
      setTaskModalOpen(false);
      await Promise.all([reloadTasks(), reload()]);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to add task.", "error");
    } finally {
      setSavingTask(false);
    }
  }

  async function completeTask(task: HomeTask) {
    setCompletingId(task.id);
    try {
      await api(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      });
      notify("Task completed.");
      await Promise.all([reloadTasks(), reload()]);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to complete task.", "error");
    } finally {
      setCompletingId(null);
    }
  }

  if (loading)
    return (
      <AppShell contentWidth="full" toolbar={<HomeViewTabs taskCount={activeTasks.length} />}>
        <div className="loading-page loading-section-tall">
          <Spinner />
        </div>
      </AppShell>
    );
  if (error || !data)
    return (
      <AppShell contentWidth="full" toolbar={<HomeViewTabs taskCount={activeTasks.length} />}>
        <EmptyState
          icon={<AlertTriangle size={19} />}
          title="Home unavailable"
          description={error ?? "Home could not be loaded."}
          action={<Button onClick={() => void reload()}>Try again</Button>}
        />
      </AppShell>
    );

  const openPipeline = data.pipeline
    .filter((stage) => !["won", "lost"].includes(stage.key))
    .reduce((sum, stage) => sum + stage.count, 0);
  const pipelineTotal = data.pipeline.reduce((sum, stage) => sum + stage.count, 0);
  const pipelineMax = Math.max(1, ...data.pipeline.map((stage) => stage.count));
  const statCards = [
    {
      label: "Open work",
      value: data.summaries.tasks.open,
      detail: `${data.summaries.tasks.dueToday} due today · ${data.summaries.tasks.doneThisWeek} done this week`,
      icon: CheckCircle2,
    },
    {
      label: "Active accounts",
      value: data.summaries.accounts.active + data.summaries.accounts.approved,
      detail: `${data.summaries.accounts.tierA} Tier A · ${data.summaries.accounts.pending} awaiting approval`,
      icon: BriefcaseBusiness,
    },
    {
      label: "Touches this week",
      value: data.summaries.activities.thisWeek,
      detail: `${data.summaries.activities.today} today · ${data.summaries.activities.planned} planned`,
      icon: MessageSquareText,
    },
    {
      label: "Open pipeline",
      value: openPipeline,
      detail: `${data.summaries.approvals.pending} pending approvals`,
      icon: Sparkles,
    },
  ];
  const groupedGoals = data.goals.reduce<Record<string, Dashboard["goals"]>>((groups, goal) => {
    const key = goal.ownerName || "Workspace";
    (groups[key] ??= []).push(goal);
    return groups;
  }, {});

  return (
    <AppShell
      contentWidth="full"
      actions={<DailyCloseoutAction />}
      toolbar={<HomeViewTabs taskCount={activeTasks.length} />}
    >
      {view === "tasks" ? (
        <div role="tabpanel" className="home-task-view">
          <div className="home-task-toolbar">
            <div className="home-week-control">
              <Button
                variant="secondary"
                size="icon"
                aria-label="Previous week"
                onClick={() =>
                  setWeekAnchor(
                    (current) =>
                      new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7),
                  )
                }
              >
                <ChevronLeft size={16} />
              </Button>
              <div className="home-week-label">
                <CalendarDays size={15} />
                <span>
                  <strong>
                    {dateRange.format(weekDays[0])} – {dateRange.format(weekDays[6])}
                  </strong>
                  <small>{tasksThisWeek.length} scheduled</small>
                </span>
              </div>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Next week"
                onClick={() =>
                  setWeekAnchor(
                    (current) =>
                      new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7),
                  )
                }
              >
                <ChevronRight size={16} />
              </Button>
              <Button variant="secondary" onClick={() => setWeekAnchor(new Date())}>
                Today
              </Button>
            </div>
            <div className="home-task-summary" aria-label="Task summary">
              <span className={overdueCount ? "home-summary-alert" : ""}>
                {overdueCount} overdue
              </span>
              <span>{unscheduledTasks.length} unscheduled</span>
            </div>
          </div>

          {tasksError ? (
            <EmptyState
              icon={<AlertTriangle size={19} />}
              title="Tasks unavailable"
              description={tasksError}
              action={<Button onClick={() => void reloadTasks()}>Try again</Button>}
            />
          ) : tasksLoading ? (
            <div className="loading-page home-loading">
              <Spinner />
            </div>
          ) : (
            <div className="home-scheduler">
              <section className="home-calendar-pane" aria-label="Weekly task calendar">
                <div className="home-calendar-scroll" ref={calendarScrollRef}>
                  <div className="home-calendar-frame">
                    <div className="home-calendar-head">
                      <div className="home-calendar-corner">
                        <Clock3 size={14} />
                      </div>
                      {weekDays.map((day) => {
                        const dayTasks = tasksOnDate(activeTasks, day);
                        const totalMinutes = dayTasks.reduce(
                          (sum, task) => sum + (task.estimate_minutes ?? 60),
                          0,
                        );
                        const isToday = localDateKey(day) === todayKey;
                        return (
                          <div
                            className={cx("home-calendar-day-head", isToday && "is-today")}
                            key={localDateKey(day)}
                          >
                            <div>
                              <strong>{dayNumber.format(day)}</strong>
                              <span>{dayName.format(day)}</span>
                            </div>
                            <small>{dayTasks.length ? formatEstimate(totalMinutes) : "—"}</small>
                          </div>
                        );
                      })}
                    </div>

                    {unscheduledTasks.length ? (
                      <div className="home-unscheduled-lane">
                        <span>Unscheduled</span>
                        <div>
                          {unscheduledTasks.map((task) => (
                            <Link
                              className={cx(
                                "home-unscheduled-task",
                                `home-task-${task.workstream}`,
                              )}
                              to="/tasks"
                              key={task.id}
                            >
                              {task.title}
                            </Link>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="home-calendar-body">
                      <div className="home-time-rail">
                        {calendarHours.map((hour) => (
                          <span key={hour}>{hourLabel.format(new Date(2020, 0, 1, hour))}</span>
                        ))}
                      </div>
                      {weekDays.map((day) => {
                        const layouts = layoutCalendarTasks(tasksOnDate(activeTasks, day));
                        return (
                          <div
                            className={cx(
                              "home-calendar-day",
                              localDateKey(day) === todayKey && "is-today",
                            )}
                            key={localDateKey(day)}
                          >
                            {layouts.map((layout) => (
                              <CalendarTask key={layout.task.id} {...layout} />
                            ))}
                          </div>
                        );
                      })}
                      {showNowLine ? (
                        <div className="home-now-line" style={nowLineStyle} aria-hidden="true">
                          <span>{taskTime.format(now)}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </section>

              <aside className="home-task-rail" aria-label="Tasks at hand">
                <div className="home-task-rail-header">
                  <div>
                    <h2>Tasks</h2>
                    <Badge tone={overdueCount ? "red" : "neutral"}>{queue.length}</Badge>
                  </div>
                  <div className="home-task-rail-actions">
                    <Button
                      variant="plain"
                      size="icon"
                      aria-label={taskSearchOpen ? "Close task search" : "Search tasks"}
                      aria-pressed={taskSearchOpen}
                      onClick={() => {
                        setTaskSearchOpen((current) => !current);
                        if (taskSearchOpen) setTaskSearch("");
                      }}
                    >
                      <Search size={17} />
                    </Button>
                    <Button variant="plain" className="home-rail-add" onClick={openTaskModal}>
                      <Plus size={17} /> Add task
                    </Button>
                  </div>
                </div>
                {taskSearchOpen ? (
                  <div className="home-task-search">
                    <Search size={15} />
                    <Input
                      autoFocus
                      aria-label="Search tasks"
                      value={taskSearch}
                      placeholder="Search tasks…"
                      onChange={(event) => setTaskSearch(event.target.value)}
                    />
                  </div>
                ) : null}
                <div className="home-task-card-list">
                  {filteredQueue.length ? (
                    filteredQueue.map((task) => (
                      <QueueTask
                        key={task.id}
                        task={task}
                        showOwner={showOwner}
                        completing={completingId === task.id}
                        onComplete={(item) => void completeTask(item)}
                      />
                    ))
                  ) : (
                    <EmptyState
                      icon={<CheckCircle2 size={19} />}
                      title={taskSearch ? "No matching tasks" : "All clear"}
                      description={
                        taskSearch
                          ? "Try a different task, owner, or workstream."
                          : "There is no open work in your queue."
                      }
                      action={
                        taskSearch ? (
                          <Button onClick={() => setTaskSearch("")}>Clear search</Button>
                        ) : (
                          <Button variant="primary" onClick={openTaskModal}>
                            <Plus size={15} /> Add task
                          </Button>
                        )
                      }
                    />
                  )}
                </div>
              </aside>
            </div>
          )}
        </div>
      ) : (
        <div role="tabpanel" className="home-insights-view">
          <section className="stat-grid" aria-label="Workspace summary">
            {statCards.map(({ label, value, detail, icon: Icon }) => (
              <article className="stat-card" key={label}>
                <div className="stat-label">
                  <span>{label}</span>
                  <span className="stat-icon">
                    <Icon size={15} />
                  </span>
                </div>
                <div className="stat-value">{value}</div>
                <div className="stat-detail">{detail}</div>
              </article>
            ))}
          </section>
          <div className="dashboard-grid">
            <div className="insights-main-column">
              <Panel flush className="insights-panel">
                <div className="panel-header">
                  <div>
                    <h2>Needs attention</h2>
                    <p>Overdue, blocked, or missing a next action.</p>
                  </div>
                </div>
                {data.attention.length ? (
                  <div className="list insights-list">
                    {data.attention.map((item) => (
                      <Link
                        className="list-row insights-attention-row"
                        key={`${item.type}-${item.id}`}
                        to={item.type === "account" ? `/accounts/${item.id}` : "/tasks"}
                      >
                        <span className="insights-row-icon">
                          <AlertTriangle size={14} />
                        </span>
                        <div className="list-row-main">
                          <div className="list-row-title">
                            <span>{item.title}</span>
                          </div>
                          <div className="list-row-meta">
                            <span>{item.detail}</span>
                            {item.ownerName ? <span>{item.ownerName}</span> : null}
                            <span
                              className={
                                item.dueAt && new Date(item.dueAt) < new Date() ? "overdue" : ""
                              }
                            >
                              {relativeDate(item.dueAt)}
                            </span>
                          </div>
                        </div>
                        <ArrowUpRight size={15} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="insights-empty">
                    <span className="insights-empty-icon">
                      <CircleDot size={18} />
                    </span>
                    <div>
                      <h3>Nothing is drifting</h3>
                      <p>Every active record has a clear owner and next action.</p>
                    </div>
                  </div>
                )}
              </Panel>
              <Panel flush className="insights-panel">
                <div className="panel-header">
                  <div>
                    <h2>30-day targets</h2>
                    <p>Execution and outcome goals stay visibly separate.</p>
                  </div>
                  <Clock3 size={16} />
                </div>
                {data.goals.length ? (
                  Object.entries(groupedGoals).map(([name, goals]) => (
                    <div key={name}>
                      <div className="goal-group-title">
                        {data.scope === "team" ? name : "Your progress"}
                      </div>
                      {goals.slice(0, data.scope === "team" ? 5 : goals.length).map((goal) => {
                        const percent = Math.min(
                          100,
                          goal.target ? (goal.actual / goal.target) * 100 : 0,
                        );
                        return (
                          <div className="goal-row" key={goal.id}>
                            <div className="goal-topline">
                              <strong>{goal.label}</strong>
                              <span>
                                {goal.actual} / {goal.target}
                              </span>
                            </div>
                            <progress className="progress-track" value={percent} max={100} />
                          </div>
                        );
                      })}
                    </div>
                  ))
                ) : (
                  <div className="insights-empty">
                    <span className="insights-empty-icon">
                      <Clock3 size={18} />
                    </span>
                    <div>
                      <h3>Targets start with the team</h3>
                      <p>
                        Invite the Lead and ICs to load their agreed 30-day activity and outcome
                        goals.
                      </p>
                    </div>
                  </div>
                )}
              </Panel>
            </div>
            <Panel flush className="insights-panel insights-pipeline-panel">
              <div className="panel-header">
                <div>
                  <h2>Pipeline pulse</h2>
                  <p>Current opportunities by accepted stage.</p>
                </div>
                <Link className="insights-panel-link" to="/pipeline">
                  View pipeline <ArrowRight size={13} />
                </Link>
              </div>
              {pipelineTotal ? (
                <div className="insights-pipeline-list">
                  {data.pipeline.map((stage) => (
                    <Link key={stage.key} to="/pipeline" className="insights-pipeline-row">
                      <div className="insights-pipeline-label">
                        <span>{stage.name}</span>
                        <strong>{stage.count}</strong>
                      </div>
                      <progress value={stage.count} max={pipelineMax} />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="insights-empty insights-empty-centered">
                  <span className="insights-empty-icon">
                    <Sparkles size={18} />
                  </span>
                  <div>
                    <h3>No pipeline yet</h3>
                    <p>Qualified opportunities will collect here as conversations progress.</p>
                  </div>
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}

      <Modal
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        title="Add task"
        description="Schedule accountable work directly on Home."
        footer={
          <>
            <Button onClick={() => setTaskModalOpen(false)}>Cancel</Button>
            <Button form="home-task-form" variant="primary" type="submit" disabled={savingTask}>
              {savingTask ? "Adding…" : "Add task"}
            </Button>
          </>
        }
      >
        <form id="home-task-form" className="form-grid" onSubmit={createTask}>
          <Field label="Task">
            <Input
              required
              autoFocus
              value={taskForm.title}
              placeholder="Prepare launch follow-up sequence"
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
          <Field label="Scheduled for">
            <Input
              required
              type="datetime-local"
              value={taskForm.dueAt}
              onChange={(event) => setTaskForm({ ...taskForm, dueAt: event.target.value })}
            />
          </Field>
          <Field label="Estimate">
            <Input
              required
              min="15"
              max="100000"
              step="15"
              type="number"
              value={taskForm.estimateMinutes}
              onChange={(event) =>
                setTaskForm({ ...taskForm, estimateMinutes: event.target.value })
              }
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
          <Field label="Type">
            <Input
              required
              value={taskForm.kind}
              onChange={(event) => setTaskForm({ ...taskForm, kind: event.target.value })}
            />
          </Field>
          <Field label="Definition of done" hint="Optional evidence or outcome expected.">
            <Textarea
              value={taskForm.description}
              placeholder="Approved sequence is ready in the campaign workspace."
              onChange={(event) => setTaskForm({ ...taskForm, description: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </AppShell>
  );
}
