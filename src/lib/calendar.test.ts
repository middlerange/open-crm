import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarStatus,
  getMonthDays,
  getWeekDays,
  groupCalendarTasksByOwner,
  localDateKey,
  moveDueDate,
  tasksOnDate,
} from "./calendar";

test("calendar status gives completion precedence and marks late open work overdue", () => {
  const now = new Date(2026, 7, 7, 12, 0, 0);

  assert.equal(calendarStatus({ status: "done", due_at: "2026-08-01T09:00:00.000Z" }, now), "done");
  assert.equal(
    calendarStatus({ status: "in_progress", due_at: "2026-08-01T09:00:00.000Z" }, now),
    "overdue",
  );
  assert.equal(
    calendarStatus({ status: "in_progress", due_at: "2026-08-08T09:00:00.000Z" }, now),
    "in_progress",
  );
  assert.equal(calendarStatus({ status: "blocked", due_at: null }, now), "blocked");
  assert.equal(calendarStatus({ status: "review", due_at: null }, now), "review");
  assert.equal(calendarStatus({ status: "cancelled", due_at: null }, now), "cancelled");
});

test("week days begin on Monday and always expose seven local dates", () => {
  const days = getWeekDays(new Date(2026, 7, 7, 15, 30));

  assert.deepEqual(days.map(localDateKey), [
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
  ]);
  assert.ok(days.every((day) => day.getHours() === 0));
});

test("month grid includes complete Monday-through-Sunday weeks", () => {
  const days = getMonthDays(new Date(2026, 7, 15));

  assert.equal(days.length % 7, 0);
  assert.equal(localDateKey(days[0]), "2026-07-27");
  assert.equal(localDateKey(days.at(-1)!), "2026-09-06");
});

test("tasks are grouped by local calendar day instead of UTC date slicing", () => {
  const date = new Date(2026, 7, 7);
  const tasks = [
    { id: "today", due_at: new Date(2026, 7, 7, 0, 30).toISOString() },
    { id: "tomorrow", due_at: new Date(2026, 7, 8, 0, 30).toISOString() },
    { id: "undated", due_at: null },
  ];

  assert.deepEqual(
    tasksOnDate(tasks, date).map((task) => task.id),
    ["today"],
  );
});

test("owner lanes follow team order and retain unassigned or unknown owners", () => {
  const members = [
    { id: "alex", name: "Alex" },
    { id: "priya", name: "Priya" },
  ];
  const tasks = [
    { id: "p1", owner_id: "priya", owner_name: "Priya" },
    { id: "u1", owner_id: null, owner_name: null },
    { id: "x1", owner_id: "external", owner_name: "Morgan" },
  ];

  const lanes = groupCalendarTasksByOwner(tasks, members);

  assert.deepEqual(
    lanes.map((lane) => lane.id),
    ["alex", "priya", "external", "unassigned"],
  );
  assert.deepEqual(
    lanes.map((lane) => lane.name),
    ["Alex", "Priya", "Morgan", "Unassigned"],
  );
  assert.deepEqual(
    lanes.find((lane) => lane.id === "priya")?.tasks.map((task) => task.id),
    ["p1"],
  );
});

test("moving a task to another day preserves its local due time", () => {
  const original = new Date(2026, 7, 7, 14, 45).toISOString();
  const moved = new Date(moveDueDate(original, new Date(2026, 7, 12)));

  assert.equal(localDateKey(moved), "2026-08-12");
  assert.equal(moved.getHours(), 14);
  assert.equal(moved.getMinutes(), 45);
});

test("moving an undated task assigns a stable midday due time", () => {
  const moved = new Date(moveDueDate(null, new Date(2026, 7, 12)));

  assert.equal(localDateKey(moved), "2026-08-12");
  assert.equal(moved.getHours(), 12);
});
