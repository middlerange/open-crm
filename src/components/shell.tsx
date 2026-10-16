import {
  ActivityIcon as Activity,
  AnnouncementIcon as Megaphone,
  BuildingsIcon as BriefcaseBusiness,
  ChartIcon as BarChart3,
  BookWithBookmarkIcon as BookOpen,
  ChecklistIcon as ClipboardCheck,
  ChecklistIcon as ListTodo,
  CodeBlockIcon as Code,
  CloseIcon as X,
  HomeIcon as Home,
  LogOutIcon as LogOut,
  ProjectIcon as FolderKanban,
  SlidersIcon as Sliders,
  SidebarIcon as Menu,
  UserLinkIcon as UserRoundSearch,
  UserCircleIcon as Contact,
  UsersIcon as Users,
  VideoCameraIcon as FileVideo2,
  MailIcon as Mail,
} from "./icons";
import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";
import { roleLabel } from "../lib/api";
import { PRODUCT_NAME } from "./brand";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { CrmQuickSearch } from "./crm-search";
import { ThemeToggle } from "./theme-toggle";
import { Avatar, Button, cx } from "./ui";

const nav = [
  { to: "/", label: "Home", icon: Home },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/accounts", label: "Accounts", icon: BriefcaseBusiness },
  { to: "/contacts", label: "Contacts", icon: Contact },
  { to: "/pipeline", label: "Pipeline", icon: FolderKanban },
  { to: "/activities", label: "Activity", icon: Activity },
  { to: "/social-leads", label: "Social leads", icon: UserRoundSearch },
  { to: "/campaigns", label: "Campaigns", icon: Megaphone },
  { to: "/studio", label: "Content studio", icon: FileVideo2 },
  { to: "/content-research", label: "Content research", icon: BookOpen },
  { to: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { to: "/agent-setup", label: "Agent setup", icon: Code },
  { to: "/inbox", label: "Inbox", icon: Mail },
] as const;

const managementNav = [
  { to: "/reports", label: "Reports", icon: BarChart3 },
  { to: "/team", label: "Team", icon: Users },
  { to: "/crm-settings", label: "CRM settings", icon: Sliders },
] as const;

const titles = {
  "/": { title: "Home", icon: Home },
  "/home/tasks": { title: "Home", icon: Home },
  "/home/insights": { title: "Home", icon: Home },
  "/tasks": { title: "Tasks", icon: ListTodo },
  "/tasks/board": { title: "Tasks", icon: ListTodo },
  "/tasks/timeline": { title: "Tasks", icon: ListTodo },
  "/accounts": { title: "Accounts", icon: BriefcaseBusiness },
  "/contacts": { title: "Contacts", icon: Contact },
  "/pipeline": { title: "Pipeline", icon: FolderKanban },
  "/activities": { title: "Activity", icon: Activity },
  "/social-leads": { title: "Social leads", icon: UserRoundSearch },
  "/campaigns": { title: "Campaigns", icon: Megaphone },
  "/studio": { title: "Content studio", icon: FileVideo2 },
  "/content-research": { title: "Content research", icon: BookOpen },
  "/approvals": { title: "Approvals", icon: ClipboardCheck },
  "/agent-setup": { title: "Agent setup", icon: Code },
  "/inbox": { title: "Inbox", icon: Mail },
  "/reports": { title: "Reports", icon: BarChart3 },
  "/team": { title: "Team", icon: Users },
  "/crm-settings": { title: "CRM settings", icon: Sliders },
};

export function AppShell({
  children,
  actions,
  toolbar,
  contentWidth = "standard",
  title,
}: {
  children: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  contentWidth?: "standard" | "wide" | "full";
  title?: string;
}) {
  const { user, logout } = useAuth();
  const { data: publicConfig } = useData<{ features: { contentResearch: boolean } }>(
    "/public-config",
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const current =
    titles[location.pathname as keyof typeof titles] ??
    (location.pathname.startsWith("/accounts/")
      ? { title: "Account", icon: BriefcaseBusiness }
      : location.pathname.startsWith("/opportunities/")
        ? { title: "Opportunity", icon: FolderKanban }
        : { title: PRODUCT_NAME, icon: Home });
  const CurrentIcon = current.icon;
  if (!user) return null;
  const isManagement = user.role === "founder" || user.role === "manager";

  const sidebar = (
    <aside className={cx("sidebar", mobileOpen && "sidebar-open")}>
      <div className="sidebar-workspace">
        <WorkspaceSwitcher />
        <Button
          className="mobile-close"
          variant="plain"
          size="icon"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        >
          <X size={18} />
        </Button>
      </div>
      <nav className="sidebar-nav" aria-label="Primary">
        <span className="nav-section-label">Workspace</span>
        {nav
          .filter(
            ({ to }) =>
              to !== "/content-research" ||
              (isManagement && publicConfig?.features.contentResearch),
          )
          .map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                cx(
                  "nav-item",
                  (isActive || (to === "/" && location.pathname.startsWith("/home/"))) &&
                    "nav-item-active",
                )
              }
            >
              <Icon size={16} />
              <span>{label}</span>
            </NavLink>
          ))}
        {isManagement ? (
          <>
            <span className="nav-section-label">Management</span>
            {managementNav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) => cx("nav-item", isActive && "nav-item-active")}
              >
                <Icon size={16} />
                <span>{label}</span>
              </NavLink>
            ))}
          </>
        ) : null}
      </nav>
      <div className="sidebar-footer">
        <div className="user-row">
          <Avatar name={user.name} size="small" />
          <div>
            <strong>{user.name}</strong>
            <span>{roleLabel(user.role)}</span>
          </div>
          <Button variant="plain" size="icon" aria-label="Sign out" onClick={() => void logout()}>
            <LogOut size={15} />
          </Button>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="app-shell">
      {sidebar}
      {mobileOpen ? (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <main className="main-area" data-page={location.pathname}>
        <header className="titlebar">
          <Button
            className="mobile-menu"
            variant="plain"
            size="icon"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={19} />
          </Button>
          <div className="titlebar-copy">
            <CurrentIcon aria-hidden="true" size={16} />
            <h1>{title ?? current.title}</h1>
          </div>
          <div className="titlebar-actions">
            <CrmQuickSearch />
            <ThemeToggle />
            {actions}
          </div>
        </header>
        {toolbar ? <div className="shell-toolbar">{toolbar}</div> : null}
        <div className={cx("page-scroll", Boolean(toolbar) && "has-toolbar")}>
          <div className={cx("page-content", `page-content-${contentWidth}`)}>{children}</div>
        </div>
      </main>
      <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
        {[nav[0], nav[1], nav[2], nav[4], nav[6]].map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cx(
                "mobile-nav-item",
                (isActive || (to === "/" && location.pathname.startsWith("/home/"))) && "is-active",
              )
            }
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
