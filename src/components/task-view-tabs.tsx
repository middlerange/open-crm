import { CalendarIcon as CalendarDays, GridIcon as Board, ListIcon as List } from "./icons";
import { NavLink } from "react-router-dom";

import { cx } from "./ui";

const taskViews = [
  { to: "/tasks/board", label: "Board", icon: Board, end: true },
  { to: "/tasks", label: "List", icon: List, end: true },
  { to: "/tasks/timeline", label: "Timeline", icon: CalendarDays, end: false },
] as const;

export function TaskViewTabs() {
  return (
    <nav className="task-view-tabs" aria-label="Task views">
      {taskViews.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => cx("task-view-tab", isActive && "is-active")}
        >
          <Icon size={15} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
