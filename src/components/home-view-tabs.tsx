import { CalendarIcon as CalendarDays, ChartIcon as Chart, HomeIcon as Home } from "./icons";
import { NavLink } from "react-router-dom";

import { cx, PageToolbar } from "./ui";

const homeViews = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/home/tasks", label: "Tasks", icon: CalendarDays, end: true },
  { to: "/home/insights", label: "Insights", icon: Chart, end: true },
] as const;

export function HomeViewTabs({ taskCount }: { taskCount?: number }) {
  return (
    <PageToolbar className="home-dashboard-toolbar" label="Home views">
      <nav className="task-view-tabs" aria-label="Home views">
        {homeViews.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => cx("task-view-tab", isActive && "is-active")}
          >
            <Icon size={15} />
            <span>{label}</span>
            {label === "Tasks" && taskCount !== undefined ? (
              <span className="filter-count">{taskCount}</span>
            ) : null}
          </NavLink>
        ))}
      </nav>
    </PageToolbar>
  );
}
