export type CalendarTaskLike = {
  status: string;
  due_at: string | null;
};

export type CalendarOwnerTask = {
  owner_id: string | null;
  owner_name: string | null;
};

export type CalendarMember = {
  id: string;
  name: string;
};

export type CalendarTone =
  | "overdue"
  | "done"
  | "in_progress"
  | "blocked"
  | "review"
  | "ready"
  | "backlog"
  | "cancelled"
  | "neutral";

export function localDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, amount: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + amount);
}

export function getWeekDays(anchor: Date) {
  const date = startOfLocalDay(anchor);
  const daysFromMonday = (date.getDay() + 6) % 7;
  const monday = addDays(date, -daysFromMonday);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function getMonthDays(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = getWeekDays(first)[0];
  const finalWeek = getWeekDays(last);
  const end = finalWeek[6];
  const length = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return Array.from({ length }, (_, index) => addDays(start, index));
}

export function tasksOnDate<Task extends { due_at: string | null }>(tasks: Task[], date: Date) {
  const key = localDateKey(date);
  return tasks.filter((task) => task.due_at && localDateKey(new Date(task.due_at)) === key);
}

export function calendarStatus(task: CalendarTaskLike, now = new Date()): CalendarTone {
  if (task.status === "done") return "done";
  if (task.due_at && new Date(task.due_at).getTime() < now.getTime()) return "overdue";
  if (["in_progress", "blocked", "review", "ready", "backlog", "cancelled"].includes(task.status)) {
    return task.status as CalendarTone;
  }
  return "neutral";
}

export function groupCalendarTasksByOwner<Task extends CalendarOwnerTask>(
  tasks: Task[],
  members: CalendarMember[],
) {
  const knownIds = new Set(members.map((member) => member.id));
  const unknownOwners = tasks
    .filter((task) => task.owner_id && !knownIds.has(task.owner_id))
    .filter(
      (task, index, values) =>
        values.findIndex((candidate) => candidate.owner_id === task.owner_id) === index,
    )
    .map((task) => ({ id: task.owner_id!, name: task.owner_name ?? "Unknown owner" }));
  const hasUnassigned = tasks.some((task) => !task.owner_id);
  const owners = [
    ...members,
    ...unknownOwners,
    ...(hasUnassigned ? [{ id: "unassigned", name: "Unassigned" }] : []),
  ];

  return owners.map((owner) => ({
    ...owner,
    tasks: tasks.filter((task) =>
      owner.id === "unassigned" ? !task.owner_id : task.owner_id === owner.id,
    ),
  }));
}

export function moveDueDate(dueAt: string | null, targetDate: Date) {
  const source = dueAt ? new Date(dueAt) : null;
  const hours = source ? source.getHours() : 12;
  const minutes = source ? source.getMinutes() : 0;
  return new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate(),
    hours,
    minutes,
  ).toISOString();
}

export function toDateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}T${hours}:${minutes}`;
}

export function dateTimeForDay(date: Date, hours = 12) {
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, 0);
  return toDateTimeLocal(value.toISOString());
}
